import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod } from "@/lib/settings-server";
import { isActiveEntry, loadPeriodEntries, managedModulesOf } from "@/lib/roster";
import { resolveStaffAttribute } from "@/types/users";
import { featureModuleMeta } from "@/types/feature-modules";
import { ROSTER_ROLES, isRosterRole, rosterCollection, RosterRole } from "@/types/roster";
import { readJsonBody } from "@/lib/http-body";

/** 可被指派管理的功能模組：有 managerPermissions 宣告（不分內建／選用；未宣告＝僅管理員） */
function assignableModuleOrError(value: string) {
  const meta = value ? featureModuleMeta(value) : undefined;
  if (!meta) return { error: "請求內容無效" as const };
  if (!Array.isArray(meta.managerPermissions) || meta.managerPermissions.length === 0) {
    return { error: `「${meta.label}」未開放非管理員指派（模組未宣告子權限）` as const };
  }
  return { meta };
}

interface ManagerRow {
  uid: string;
  role: RosterRole;
  name: string;
  email: string;
  account: string;
  permissions: string[];
  /** 名冊輔助資訊（顯示候選名單用；缺漏為空字串） */
  attribute?: string;
  unit?: string;
  title?: string;
  grade?: string;
  classCode?: string;
  className?: string;
  studentId?: string;
  rollNo?: string;
  studentName?: string;
}

/** 讀一條名冊條目的展示欄位（不足處退回空字串；permissions 由呼叫端依模組填入） */
function personOf(data: Record<string, unknown>, role: RosterRole, uid: string): ManagerRow {
  const str = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : "");
  return {
    uid,
    role,
    name: str("name"),
    email: str("email"),
    account: str("account"),
    permissions: [],
    attribute:
      role === "staff" ? resolveStaffAttribute(str("attribute")) : str("attribute"),
    unit: str("unit"),
    title: str("title"),
    grade: str("grade"),
    classCode: str("classCode"),
    className: str("className"),
    studentId: str("studentId"),
    rollNo: str("rollNo"),
    studentName: str("studentName"),
  };
}

/**
 * GET：管理人員指派查詢（僅管理員）。
 * - `?module=X`：列出當期被指派管理 X 的所有非管理員身分帳號（掃三張名冊，
 *   以 managedModuleKeys array-contains 過濾，單次合計三筆查詢）。
 * - `?module=X&role=staff&q=keyword`：於該身分當期名冊精確搜尋（帳號或姓名），
 *   回傳可加入的候選人（含既有指派者，前端標示）。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_GET.limit,
      RATE.FEATURE_MODULES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("modules");
    if (denial) return toAuthResponse(denial);

    const moduleValue = request.nextUrl.searchParams.get("module") || "";
    const check = assignableModuleOrError(moduleValue);
    if ("error" in check) {
      return NextResponse.json({ success: false, message: check.error }, { status: 400 });
    }

    const period = await getCurrentPeriod();
    const db = getAdminDb();
    const delegatableRoles: RosterRole[] = ["student", "parent", "staff"];

    const toManagerRow = (data: Record<string, unknown>, role: RosterRole, uid: string) => {
      const row = personOf(data, role, uid);
      const grant = managedModulesOf(data).find((item) => item.module === moduleValue);
      return { ...row, permissions: grant ? grant.permissions : [] };
    };

    // 搜尋／候選模式：
    // - 教職員：列出當期名冊（可用 attribute 篩選屬性），不需輸入關鍵字。
    // - 學生：以次要欄位（班號／學號／姓名）精確比對。
    // - 家長：沿用帳號或姓名精確比對。
    const searchRoleParam = request.nextUrl.searchParams.get("role") || "";
    const q = (request.nextUrl.searchParams.get("q") || "").trim();
    if (searchRoleParam) {
      if (!isRosterRole(searchRoleParam) || searchRoleParam === "admin") {
        return NextResponse.json({ success: false, message: "身分無效" }, { status: 400 });
      }
      const searchRole = searchRoleParam;

      if (searchRole === "staff") {
        const attribute = (request.nextUrl.searchParams.get("attribute") || "").trim();
        // 省流模式：只回候選人數（count 聚合，不載入名冊內容）
        if (request.nextUrl.searchParams.get("summary") === "count") {
          let countQuery = db
            .collection(rosterCollection("staff"))
            .where("academicYear", "==", period.academicYear)
            .where("semester", "==", period.semester);
          if (attribute) countQuery = countQuery.where("attribute", "==", attribute);
          const counted = await countQuery.count().get();
          return NextResponse.json(
            { success: true, count: counted.data().count },
            { headers: { "Cache-Control": "no-store" } }
          );
        }
        const entries = await loadPeriodEntries(period, "staff");
        const people: ManagerRow[] = [];
        const keyword = q.toLowerCase();
        for (const [uid, data] of entries) {
          if (!isActiveEntry(data)) continue;
          const entryAttribute = resolveStaffAttribute(
            typeof data.attribute === "string" ? data.attribute : ""
          );
          if (attribute && entryAttribute !== attribute) continue;
          if (keyword) {
            const haystack = `${data.name ?? ""} ${data.account ?? ""}`.toLowerCase();
            if (!haystack.includes(keyword)) continue;
          }
          people.push(toManagerRow(data, "staff", uid));
        }
        people.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
        return NextResponse.json(
          { success: true, people },
          { headers: { "Cache-Control": "no-store" } }
        );
      }

      if (!q) {
        return NextResponse.json(
          { success: true, people: [] },
          { headers: { "Cache-Control": "no-store" } }
        );
      }

      if (searchRole === "student") {
        const fieldParam = request.nextUrl.searchParams.get("field");
        const field =
          fieldParam === "studentId" ? "studentId" : fieldParam === "rollNo" ? "rollNo" : "name";
        const snap = await db
          .collection(rosterCollection("student"))
          .where("academicYear", "==", period.academicYear)
          .where("semester", "==", period.semester)
          .where(field, "==", q)
          .limit(20)
          .get();
        const seen = new Set<string>();
        const people: ManagerRow[] = [];
        for (const doc of snap.docs) {
          const data = doc.data();
          const uid = typeof data.uid === "string" ? data.uid : "";
          if (!uid || seen.has(uid) || !isActiveEntry(data)) continue;
          seen.add(uid);
          people.push(toManagerRow(data, "student", uid));
        }
        people.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
        return NextResponse.json(
          { success: true, people },
          { headers: { "Cache-Control": "no-store" } }
        );
      }

      const col = db.collection(rosterCollection(searchRole));
      const [byAccount, byName] = await Promise.all([
        col
          .where("academicYear", "==", period.academicYear)
          .where("semester", "==", period.semester)
          .where("account", "==", q)
          .limit(10)
          .get(),
        col
          .where("academicYear", "==", period.academicYear)
          .where("semester", "==", period.semester)
          .where("name", "==", q)
          .limit(10)
          .get(),
      ]);
      const seen = new Set<string>();
      const people: ManagerRow[] = [];
      for (const snap of [...byAccount.docs, ...byName.docs]) {
        const data = snap.data();
        const uid = typeof data.uid === "string" ? data.uid : "";
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        people.push(toManagerRow(data, searchRole, uid));
      }
      return NextResponse.json(
        { success: true, people },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // 列表模式：三張名冊 array-contains 過濾（每張一筆查詢，合計三筆）
    const snaps = await Promise.all(
      delegatableRoles.map((role) =>
        db
          .collection(rosterCollection(role))
          .where("academicYear", "==", period.academicYear)
          .where("semester", "==", period.semester)
          .where("managedModuleKeys", "array-contains", moduleValue)
          .get()
      )
    );
    const managers: ManagerRow[] = [];
    for (let i = 0; i < delegatableRoles.length; i += 1) {
      const role = delegatableRoles[i];
      for (const doc of snaps[i].docs) {
        const data = doc.data();
        const uid = typeof data.uid === "string" ? data.uid : "";
        if (!uid) continue;
        const grants = managedModulesOf(data);
        const grant = grants.find((item) => item.module === moduleValue);
        managers.push({
          uid,
          role,
          name: typeof data.name === "string" ? data.name : "",
          email: typeof data.email === "string" ? data.email : "",
          account: typeof data.account === "string" ? data.account : "",
          permissions: grant ? grant.permissions : [],
        });
      }
    }
    return NextResponse.json(
      { success: true, managers, permissionDefs: check.meta.managerPermissions },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Module managers list error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/**
 * PUT：設定某帳號對某模組的管理指派（僅管理員）。
 * body：`{ module, uid, role, permissions }`——role 為被指定者之身分（非 admin）；
 * permissions 為子權限碼陣列（空陣列＝移除該模組指派）。
 * 寫入該身分名冊條目 `managedModules`／`managedModuleKeys`（同請求快取失效見 bumpCacheEpoch）。
 */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_MUTATE.limit,
      RATE.FEATURE_MODULES_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("modules");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const moduleValue = typeof body.module === "string" ? body.module : "";
    const uid = typeof body.uid === "string" ? body.uid : "";
    const role = isRosterRole(body.role) ? body.role : null;
    const check = assignableModuleOrError(moduleValue);
    if ("error" in check) {
      return NextResponse.json({ success: false, message: check.error }, { status: 400 });
    }
    if (!uid || !role || role === "admin") {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    const rawPerms = Array.isArray(body.permissions) ? body.permissions : null;
    if (!rawPerms) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }
    const allowedCodes = new Set(check.meta.managerPermissions!.map((perm) => perm.value));
    const permissions = rawPerms.filter(
      (item): item is string =>
        typeof item === "string" && allowedCodes.has(item)
    );

    const period = await getCurrentPeriod();
    const db = getAdminDb();
    const col = db.collection(rosterCollection(role));
    const entryId = `${uid}_${period.academicYear}_${period.semester}`;
    const ref = col.doc(entryId);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json(
        { success: false, message: "查無該身分的當期名冊條目，無法指派" },
        { status: 404 }
      );
    }
    const data = snap.data() ?? {};
    const current = managedModulesOf(data);
    const others = current.filter((item) => item.module !== moduleValue);
    const next = permissions.length > 0 ? [...others, { module: moduleValue, permissions }] : others;
    const keys = [...new Set(next.map((item) => item.module))];

    await ref.update({
      managedModules: next,
      managedModuleKeys: keys,
      updatedAt: Date.now(),
    });

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "feature_module_updated",
      ip: getClientIp(request),
      details:
        permissions.length > 0
          ? `指派「${check.meta.label}」管理人員（uid ${uid}／${role}），子權限：${permissions.join("、")}`
          : `移除「${check.meta.label}」管理人員（uid ${uid}／${role}）`,
    });

    return NextResponse.json({
      success: true,
      message: permissions.length > 0 ? "已更新管理人員指派" : "已移除管理人員指派",
    });
  } catch (error) {
    console.error("Module managers update error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/** DELETE：以 query 參數移除指派（?module=X&uid=...&role=staff）；語意同 PUT 空權限 */
export async function DELETE(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_MUTATE.limit,
      RATE.FEATURE_MODULES_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("modules");
    if (denial) return toAuthResponse(denial);

    const moduleValue = request.nextUrl.searchParams.get("module") || "";
    const uid = request.nextUrl.searchParams.get("uid") || "";
    const roleParam = request.nextUrl.searchParams.get("role") || "";
    const role = isRosterRole(roleParam) ? roleParam : null;
    const check = assignableModuleOrError(moduleValue);
    if ("error" in check) {
      return NextResponse.json({ success: false, message: check.error }, { status: 400 });
    }
    if (!uid || !role || role === "admin") {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    const period = await getCurrentPeriod();
    const db = getAdminDb();
    const ref = db.collection(rosterCollection(role)).doc(`${uid}_${period.academicYear}_${period.semester}`);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json(
        { success: false, message: "查無該身分的當期名冊條目" },
        { status: 404 }
      );
    }
    const data = snap.data() ?? {};
    const current = managedModulesOf(data);
    const next = current.filter((item) => item.module !== moduleValue);
    const keys = [...new Set(next.map((item) => item.module))];
    await ref.update({
      managedModules: next,
      managedModuleKeys: keys,
      updatedAt: Date.now(),
    });

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "feature_module_updated",
      ip: getClientIp(request),
      details: `移除「${check.meta.label}」管理人員（uid ${uid}／${role}）`,
    });

    return NextResponse.json({ success: true, message: "已移除管理人員指派" });
  } catch (error) {
    console.error("Module managers delete error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}
