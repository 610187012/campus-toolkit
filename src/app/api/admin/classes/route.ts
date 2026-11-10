import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { serverErrorMessage } from "@/lib/api-error";
import { SETTINGS_COLLECTION, getCurrentPeriod, getCacheEpoch } from "@/lib/settings-server";
import { isActiveEntry, loadPeriodEntries } from "@/lib/roster";
import { rosterCollection } from "@/types/roster";
import { cachedSettingDoc } from "@/lib/read-cache";
import { cachedListRead } from "@/lib/list-cache";
import { CLASSES_DOC_ID, readSchoolClasses } from "@/types/school-classes";
import { PROFILE_DOC_ID, readSchoolProfile } from "@/types/school-profile";

const noStore = { "Cache-Control": "no-store" };

/** 名冊條目的字串欄位（缺值或非字串一律視為空字串） */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 班級學生名單排序：座號（數字升冪、空白排最後）→ 姓名 → 學號 */
function compareStudents(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const seatA = str(a.seatNo).trim();
  const seatB = str(b.seatNo).trim();
  if (seatA !== seatB) {
    if (!seatA) return 1;
    if (!seatB) return -1;
    const numA = Number(seatA);
    const numB = Number(seatB);
    if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) return numA - numB;
    return seatA.localeCompare(seatB, "zh-Hant", { numeric: true });
  }
  return (
    str(a.name).localeCompare(str(b.name), "zh-Hant") ||
    str(a.studentId).localeCompare(str(b.studentId), "zh-Hant", { numeric: true })
  );
}

/**
 * 班級管理（classes 模組）總覽：當期各年級的班級清單＋每班學生人數（唯讀）。
 * 班級結構存 `settings/schoolClasses`（維護入口在學校基本設定 → 年段班級設定），
 * 學生人數＝當期 `rosterStudents` 有效條目依 `classCode` 分組計數。
 * 另帶 `?classCode=…` 時回單一班級資料與該班當期有效學生名單（班級學生名單子頁用）。
 *
 * 讀取策略（見 docs/資料庫讀取規範.md）：
 * - 單班模式：`where(classCode)` 過濾下推，只讀該班名冊（鐵律 2），不整份撈回再篩。
 * - 總覽模式：整份當期名冊僅為計算人數，結果以 cacheEpoch 綁定快取（鐵律 6）；
 *   名冊／班級資料變更路由呼叫 invalidateAdminListCache() 跨實例失效，
 *   TTL 10 分鐘僅為硬上限。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "classes",
      RATE.CLASSES_GET.limit,
      RATE.CLASSES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("classes");
    if (denial) return toAuthResponse(denial);

    const db = getAdminDb();
    const period = await getCurrentPeriod();
    const classCodeParam = request.nextUrl.searchParams.get("classCode");

    // 班級結構與校務資料：兩份設定文件（各 1 讀；30 秒快取，
    // 班級／校務資料更新後由 invalidateAdminListCache() 失效；
    // 與 api/admin/school/* 共用同一 setting-doc key）
    const [classesSnap, profileSnap] = await Promise.all([
      cachedSettingDoc(CLASSES_DOC_ID, () =>
        db.collection(SETTINGS_COLLECTION).doc(CLASSES_DOC_ID).get()
      ),
      cachedSettingDoc(PROFILE_DOC_ID, () =>
        db.collection(SETTINGS_COLLECTION).doc(PROFILE_DOC_ID).get()
      ),
    ]);

    const profile = readSchoolProfile(profileSnap.exists ? profileSnap.data() : null);
    const context = {
      stages: profile.stages.map((item) => ({ stage: item.stage, years: item.years })),
    };
    const setting = readSchoolClasses(classesSnap.exists ? classesSnap.data() : null, context);

    // 單一班級模式（?classCode=…）：回該班資料＋當期有效學生名單，不需組總覽
    if (classCodeParam !== null) {
      const code = classCodeParam.trim();
      const grade = code
        ? setting.grades.find((row) => row.classes.some((item) => item.code === code))
        : undefined;
      const item = grade?.classes.find((row) => row.code === code) ?? null;
      if (!grade || !item) {
        return NextResponse.json(
          { success: false, message: "查無此班級" },
          { status: 404, headers: noStore }
        );
      }

      // 過濾下推：只查該班（當期＋該班級代碼），回傳筆數≈該班人數而非全校人數
      const snapshot = await db
        .collection(rosterCollection("student"))
        .where("academicYear", "==", period.academicYear)
        .where("semester", "==", period.semester)
        .where("classCode", "==", code)
        .get();
      const list = snapshot.docs
        .map((doc) => doc.data())
        .filter((entry) => isActiveEntry(entry))
        .sort(compareStudents);

      return NextResponse.json(
        {
          success: true,
          period,
          cacheEpoch: await getCacheEpoch(),
          classInfo: {
            code: item.code,
            name: item.name,
            grade: grade.grade,
            gradeName: grade.name,
            group: item.group,
            department: item.department,
            studentCount: list.length,
          },
          students: list.map((entry) => ({
            uid: str(entry.uid),
            name: str(entry.name),
            studentId: str(entry.studentId),
            seatNo: str(entry.seatNo),
            rollNo: str(entry.rollNo),
            email: str(entry.email),
            account: str(entry.account),
          })),
        },
        { headers: noStore }
      );
    }

    // 總覽：整份當期名冊只在 epoch 變動（有資料寫入）後重讀一次，
    // 期間重複進出頁面＝ 0 讀取（TTL 10 分鐘僅為防呆硬上限）
    const { data: overview, epoch } = await cachedListRead(
      `admin:classes-overview:${period.academicYear}:${period.semester}`,
      async () => {
        const students = await loadPeriodEntries(period, "student");

        // 班級代碼全集＋依代碼累加學生人數（僅計有效名冊條目）
        const classCodes = new Set<string>();
        for (const grade of setting.grades) {
          for (const item of grade.classes) classCodes.add(item.code);
        }
        const counts = new Map<string, number>();
        let studentCount = 0;
        let unassignedCount = 0;
        for (const entry of students.values()) {
          if (!isActiveEntry(entry)) continue;
          studentCount += 1;
          const code = typeof entry.classCode === "string" ? entry.classCode : "";
          if (code && classCodes.has(code)) {
            counts.set(code, (counts.get(code) ?? 0) + 1);
          } else {
            unassignedCount += 1;
          }
        }

        const grades = setting.grades.map((grade) => ({
          grade: grade.grade,
          code: grade.code,
          name: grade.name,
          classes: grade.classes.map((item) => ({
            code: item.code,
            name: item.name,
            group: item.group,
            department: item.department,
            studentCount: counts.get(item.code) ?? 0,
          })),
        }));

        return {
          grades,
          summary: {
            gradeCount: setting.grades.length,
            classCount: classCodes.size,
            studentCount,
            unassignedCount,
          },
        };
      }
    );

    return NextResponse.json(
      { success: true, period, ...overview, cacheEpoch: epoch },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Class management GET error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
