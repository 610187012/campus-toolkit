import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireRole, toAuthResponse } from "@/lib/dal";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getCurrentPeriod } from "@/lib/settings-server";
import { serverErrorMessage } from "@/lib/api-error";
import {
  getStudentPersonalInfoSettings,
  getStudentPersonalInfoTargetOptions,
  saveStudentPersonalInfoSettings,
} from "@/lib/personal-info";
import {
  normalizePersonalInfoDateTime,
  type StudentPersonalInfoTarget,
  type StudentPersonalInfoTargetMode,
} from "@/types/personal-info";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

/** 讀取目前學期學生個人資料填寫規則。 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_GET.limit,
      RATE.FEATURE_MODULES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireRole("admin");
    if (denial) return toAuthResponse(denial);

    const period = await getCurrentPeriod();
    const [settings, targetOptions] = await Promise.all([
      getStudentPersonalInfoSettings(period),
      getStudentPersonalInfoTargetOptions(),
    ]);
    return NextResponse.json({ success: true, settings, period, targetOptions }, { headers: noStore });
  } catch (error) {
    console.error("Get student personal info settings error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "讀取管理規則失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/** 儲存目前學期學生個人資料填寫規則。 */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_MUTATE.limit,
      RATE.FEATURE_MODULES_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("admin");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const raw = parsed.data;
    if (!raw || typeof raw.enabled !== "boolean") {
      return NextResponse.json(
        { success: false, message: "請提供有效的開放填寫狀態" },
        { status: 400, headers: noStore }
      );
    }

    const rawStartDate = typeof raw.startDate === "string" ? raw.startDate.trim() : "";
    const rawEndDate = typeof raw.endDate === "string" ? raw.endDate.trim() : "";
    const startDate = normalizePersonalInfoDateTime(rawStartDate, "start");
    const endDate = normalizePersonalInfoDateTime(rawEndDate, "end");
    if ((rawStartDate && !startDate) || (rawEndDate && !endDate)) {
      return NextResponse.json(
        { success: false, message: "起訖日期時間格式無效" },
        { status: 400, headers: noStore }
      );
    }
    if (raw.enabled && (!startDate || !endDate)) {
      return NextResponse.json(
        { success: false, message: "開放填寫前，請先設定起始日期時間與結束日期時間" },
        { status: 400, headers: noStore }
      );
    }
    if (startDate && endDate && endDate < startDate) {
      return NextResponse.json(
        { success: false, message: "結束日期時間不可早於起始日期時間" },
        { status: 400, headers: noStore }
      );
    }

    const targetInput = raw.target && typeof raw.target === "object"
      ? (raw.target as Record<string, unknown>)
      : {};
    if (!raw.target || typeof raw.target !== "object" || Array.isArray(raw.target)) {
      return NextResponse.json(
        { success: false, message: "缺少有效的開放對象設定，請重新載入管理規則" },
        { status: 400, headers: noStore }
      );
    }
    const targetModeValue = targetInput.mode ?? "all";
    if (targetModeValue !== "all" && targetModeValue !== "grades" && targetModeValue !== "classes") {
      return NextResponse.json(
        { success: false, message: "開放對象設定無效" },
        { status: 400, headers: noStore }
      );
    }
    const targetMode: StudentPersonalInfoTargetMode = targetModeValue;
    const readSelection = (value: unknown, limit: number): string[] | null => {
      if (!Array.isArray(value)) return null;
      const items = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length !== value.length || items.length > limit || new Set(items).size !== items.length) {
        return null;
      }
      return items;
    };

    let target: StudentPersonalInfoTarget = { mode: "all", grades: [], classes: [] };
    if (targetMode !== "all") {
      const targetOptions = await getStudentPersonalInfoTargetOptions();
      if (targetMode === "grades") {
        const grades = readSelection(targetInput.grades, 24);
        const availableGrades = new Set(targetOptions.grades.map((item) => item.value));
        if (
          !grades ||
          (raw.enabled && grades.length === 0) ||
          grades.some((grade) => !availableGrades.has(grade))
        ) {
          return NextResponse.json(
            { success: false, message: "請選擇有效的年級" },
            { status: 400, headers: noStore }
          );
        }
        target = { mode: "grades", grades, classes: [] };
      } else {
        const classes = readSelection(
          targetInput.classes,
          targetOptions.grades.reduce((count, grade) => count + grade.classes.length, 0)
        );
        const availableClasses = new Set(
          targetOptions.grades.flatMap((grade) => grade.classes.map((classRow) => classRow.value))
        );
        if (
          !classes ||
          (raw.enabled && classes.length === 0) ||
          classes.some((code) => !availableClasses.has(code))
        ) {
          return NextResponse.json(
            { success: false, message: "請選擇有效的班級" },
            { status: 400, headers: noStore }
          );
        }
        target = { mode: "classes", grades: [], classes };
      }
    }

    const period = await getCurrentPeriod();
    const settings = {
      enabled: raw.enabled,
      startDate,
      endDate,
      target,
      allowAdmissionPhotoReplacement: raw.allowAdmissionPhotoReplacement === true,
      allowGraduationPhotoUpload: raw.allowGraduationPhotoUpload === true,
    };
    await saveStudentPersonalInfoSettings(period, settings);
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "personal_info_settings_updated",
      ip: getClientIp(request),
      details: `更新 ${period.academicYear} 學年度第 ${period.semester} 學期個人資料填寫規則（${settings.enabled ? "開放" : "關閉"}，對象=${target.mode}，入學照=${settings.allowAdmissionPhotoReplacement ? "開" : "關"}，畢業照=${settings.allowGraduationPhotoUpload ? "開" : "關"}，${startDate || "未設定"} 至 ${endDate || "未設定"}）`,
    });

    return NextResponse.json(
      { success: true, message: "管理規則已儲存", settings, period },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Save student personal info settings error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "儲存管理規則失敗") },
      { status: 500, headers: noStore }
    );
  }
}
