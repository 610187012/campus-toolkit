import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireRole, toAuthResponse, type VerifiedSession } from "@/lib/dal";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { getFullWeeks, getRecordWindow, getSettings, getWeekSchedule } from "../../../lib/self-directed-learning";
import {
  getLatestReviews,
  getStudentPlans,
  promoteStudentPlan,
  purgeExpiredStudentTrash,
  purgeStudentPlan,
  savePlanRecords,
  saveStudentPlan,
  setStudentPlanDeleted,
  setStudentPlanParentVisibility,
  withdrawStudentPlan,
  type ExecutionRecordInput,
  type StudentIdentityLite,
} from "../../../lib/self-directed-learning-plans";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  MAINTENANCE_TITLE,
  openStateOf,
  parsePlanDraft,
  periodLabelOf,
} from "../../../types/self-directed-learning";

const noStore = { "Cache-Control": "no-store" };

/** 主程式的 serverErrorMessage 等價小工具（模組不得依賴非公開面檔案） */
function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

/** 由名冊條目（`session.__entry`）組出學生身分；缺班級資料＝非本校名冊學生 */
function studentIdentityOf(session: VerifiedSession): StudentIdentityLite | null {
  const entry = session.__entry;
  const grade = entry && typeof entry.grade === "string" ? entry.grade : "";
  if (!grade) return null;
  const classCode = entry && typeof entry.classCode === "string" ? entry.classCode : "";
  const name =
    entry && typeof entry.name === "string" && entry.name
      ? entry.name
      : session.displayName || session.account;
  const className = entry && typeof entry.className === "string" ? entry.className : "";
  return { uid: session.uid, name, grade, classCode, className };
}

/** GET：設定＋我的計畫＋最新審查意見＋期間狀態 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-list",
      RATE.SELF_DIRECTED_LEARNING_LIST.limit,
      RATE.SELF_DIRECTED_LEARNING_LIST.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
    if (gate) return gate;

    const student = studentIdentityOf(session as VerifiedSession);
    if (!student) {
      return NextResponse.json(
        { success: false, message: "查無名冊身分資料，無法使用本功能" },
        { status: 403, headers: noStore }
      );
    }

    const settings = await getSettings();
    const [fullWeeks, weekSchedule] = await Promise.all([
      getFullWeeks(),
      getWeekSchedule(student.grade, student.classCode),
    ]);
    // 執行成果紀錄／學習反思心得的開放時間（逐週，依節次結束時間推算）
    const recordWindow = await getRecordWindow(student.grade, student.classCode, weekSchedule);
    const currentPeriod = periodLabelOf(await getCurrentPeriod());
    // 總開關關閉：非管理端只回維護旗標（計畫與審查意見不回傳）
    if (!settings.enabled) {
      return NextResponse.json(
        {
          success: true,
          settings,
          fullWeeks,
          weekSchedule: [],
          recordWindow: { deadlineAt: null, weeks: [] },
          student: { name: student.name, className: student.className },
          maintenance: true,
          plans: [],
          reviews: {},
          currentPeriod,
          withinWindow: false,
        },
        { headers: noStore }
      );
    }
    // 學生進入頁面時，自動永久刪除垃圾桶中超過 30 天的計畫
    const purgedTrashCount = await purgeExpiredStudentTrash({ studentUid: student.uid });
    if (purgedTrashCount > 0) {
      await logActivity({
        userId: student.uid,
        role: session.role,
        action: "self_directed_learning_plan_purged",
        ip: getClientIp(request),
        details: `自動清除垃圾桶中超過 30 天的計畫 ${purgedTrashCount} 件`,
      });
    }
    const plans = await getStudentPlans(student.uid);
    // 只取需要顯示審查意見的計畫（草稿不需查）
    const reviews = await getLatestReviews(
      plans.filter((plan) => plan.status !== "draft").map((plan) => plan.id)
    );
    return NextResponse.json(
      {
        success: true,
        settings,
        fullWeeks,
        weekSchedule,
        recordWindow,
        student: { name: student.name, className: student.className },
        plans,
        reviews,
        currentPeriod,
        withinWindow: openStateOf(settings) === "open",
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("selfDirectedLearning student GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "讀取資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/** POST：`{ action: "save" | "submit", draft }` 儲存草稿或送出審核 */
export async function POST(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-student",
      RATE.SELF_DIRECTED_LEARNING_STUDENT.limit,
      RATE.SELF_DIRECTED_LEARNING_STUDENT.windowMs
    );
    if (limited) return limited;
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
    if (gate) return gate;

    const student = studentIdentityOf(session as VerifiedSession);
    if (!student) {
      return NextResponse.json(
        { success: false, message: "查無名冊身分資料，無法使用本功能" },
        { status: 403, headers: noStore }
      );
    }

    const body = (await request.json().catch(() => null)) as {
      action?: string;
      draft?: unknown;
      planId?: unknown;
      records?: unknown;
      reflection?: unknown;
      visible?: unknown;
    } | null;
    const action = body?.action === "submit" ? "submit" : "save";
    const requestedAction = body?.action;
    const planId = typeof body?.planId === "string" ? body.planId.trim().slice(0, 200) : "";

    const settings = await getSettings();
    if (!settings.enabled) {
      return NextResponse.json(
        { success: false, message: MAINTENANCE_TITLE },
        { status: 403, headers: noStore }
      );
    }

    // 執行成果紀錄／學習反思心得：只更新成果欄位，不動計畫內容與狀態
    if (requestedAction === "records") {
      if (!planId) {
        return NextResponse.json(
          { success: false, message: "缺少計畫識別" },
          { status: 400, headers: noStore }
        );
      }
      const records: ExecutionRecordInput[] = Array.isArray(body?.records)
        ? body.records
            .map((item): ExecutionRecordInput | null => {
              if (!item || typeof item !== "object") return null;
              const value = item as Record<string, unknown>;
              const week = typeof value.week === "number" ? value.week : NaN;
              if (!Number.isInteger(week) || week < 1) return null;
              return { week, note: typeof value.note === "string" ? value.note : "" };
            })
            .filter((item): item is ExecutionRecordInput => item !== null)
        : [];
      const reflection = typeof body?.reflection === "string" ? body.reflection : undefined;
      const result = await savePlanRecords({
        planId,
        studentUid: student.uid,
        records,
        reflection,
        settings,
      });
      if (!result.ok) {
        return NextResponse.json(
          { success: false, message: result.message },
          { status: result.status, headers: noStore }
        );
      }
      await logActivity({
        userId: student.uid,
        role: session.role,
        action: "self_directed_learning_plan_records_saved",
        ip: getClientIp(request),
        details: `填寫執行成果紀錄：${result.plan.topic}`,
      });
      return NextResponse.json(
        { success: true, plan: result.plan, message: "已儲存執行成果紀錄" },
        { headers: noStore }
      );
    }

    // 假性刪除／還原：只處理垃圾桶狀態，不需解析草稿內容
    if (requestedAction === "trash" || requestedAction === "restore") {
      if (!planId) {
        return NextResponse.json(
          { success: false, message: "缺少計畫識別" },
          { status: 400, headers: noStore }
        );
      }
      const deleted = requestedAction === "trash";
      const trashResult = await setStudentPlanDeleted({
        planId,
        studentUid: student.uid,
        deleted,
        maxDrafts: settings.maxDrafts,
        maxDocumentPlans: settings.maxDocumentPlans,
      });
      if (!trashResult.ok) {
        return NextResponse.json(
          { success: false, message: trashResult.message },
          { status: trashResult.status, headers: noStore }
        );
      }
      await logActivity({
        userId: student.uid,
        role: session.role,
        action: deleted
          ? "self_directed_learning_plan_trashed"
          : "self_directed_learning_plan_restored",
        ip: getClientIp(request),
        details: `${deleted ? "移至垃圾桶" : "還原"}：${trashResult.plan.topic}`,
      });
      return NextResponse.json(
        {
          success: true,
          plan: trashResult.plan,
          message: deleted ? "已移至垃圾桶" : "已還原",
        },
        { headers: noStore }
      );
    }

    // 永久刪除垃圾桶中的計畫（不可復原）：連同審查紀錄一併刪除
    if (requestedAction === "purge") {
      if (!planId) {
        return NextResponse.json(
          { success: false, message: "缺少計畫識別" },
          { status: 400, headers: noStore }
        );
      }
      const purgeResult = await purgeStudentPlan({ planId, studentUid: student.uid });
      if (!purgeResult.ok) {
        return NextResponse.json(
          { success: false, message: purgeResult.message },
          { status: purgeResult.status, headers: noStore }
        );
      }
      await logActivity({
        userId: student.uid,
        role: session.role,
        action: "self_directed_learning_plan_purged",
        ip: getClientIp(request),
        details: `永久刪除自主學習計畫：${purgeResult.plan.topic}`,
      });
      return NextResponse.json(
        { success: true, message: "已永久刪除" },
        { headers: noStore }
      );
    }

    // 學生設定某一份正式計畫是否讓家長檢視
    if (requestedAction === "parentVisibility") {
      if (!planId) {
        return NextResponse.json(
          { success: false, message: "缺少計畫識別" },
          { status: 400, headers: noStore }
        );
      }
      if (typeof body?.visible !== "boolean") {
        return NextResponse.json(
          { success: false, message: "缺少家長檢視設定" },
          { status: 400, headers: noStore }
        );
      }
      const visibilityResult = await setStudentPlanParentVisibility({
        planId,
        studentUid: student.uid,
        visible: body.visible,
      });
      if (!visibilityResult.ok) {
        return NextResponse.json(
          { success: false, message: visibilityResult.message },
          { status: visibilityResult.status, headers: noStore }
        );
      }
      await logActivity({
        userId: student.uid,
        role: session.role,
        action: "self_directed_learning_plan_parent_visibility_changed",
        ip: getClientIp(request),
        details: `${body.visible ? "開放家長檢視" : "取消家長檢視"}：${visibilityResult.plan.topic}`,
      });
      return NextResponse.json(
        {
          success: true,
          plan: visibilityResult.plan,
          message: body.visible ? "已開放家長檢視" : "已取消家長檢視",
        },
        { headers: noStore }
      );
    }

    // 學生自行提升為正式計畫（保留學校審核；退回不影響正式狀態）
    if (requestedAction === "promote") {
      if (!planId) {
        return NextResponse.json(
          { success: false, message: "缺少計畫識別" },
          { status: 400, headers: noStore }
        );
      }
      const promoteResult = await promoteStudentPlan({
        planId,
        studentUid: student.uid,
        maxDocumentPlans: settings.maxDocumentPlans,
      });
      if (!promoteResult.ok) {
        return NextResponse.json(
          { success: false, message: promoteResult.message },
          { status: promoteResult.status, headers: noStore }
        );
      }
      await logActivity({
        userId: student.uid,
        role: session.role,
        action: "self_directed_learning_plan_self_approved",
        ip: getClientIp(request),
        details: `學生提升為正式計畫：${promoteResult.plan.topic}`,
      });
      return NextResponse.json(
        {
          success: true,
          plan: promoteResult.plan,
          message: "已提升為正式計畫，可開始按時填寫成果",
        },
        { headers: noStore }
      );
    }

    // 抽回審核中的計畫（限送審期間）：回到草稿後可修改再送出
    if (requestedAction === "withdraw") {
      if (!planId) {
        return NextResponse.json(
          { success: false, message: "缺少計畫識別" },
          { status: 400, headers: noStore }
        );
      }
      const withdrawResult = await withdrawStudentPlan({
        planId,
        studentUid: student.uid,
        period: periodLabelOf(await getCurrentPeriod()),
        settings,
      });
      if (!withdrawResult.ok) {
        return NextResponse.json(
          { success: false, message: withdrawResult.message },
          { status: withdrawResult.status, headers: noStore }
        );
      }
      await logActivity({
        userId: student.uid,
        role: session.role,
        action: "self_directed_learning_plan_withdrawn",
        ip: getClientIp(request),
        details: `抽回自主學習計畫：${withdrawResult.plan.topic}`,
      });
      return NextResponse.json(
        {
          success: true,
          plan: withdrawResult.plan,
          message: "已抽回，可在草稿匣修改後重新送出",
        },
        { headers: noStore }
      );
    }

    const fullWeeks = await getFullWeeks();
    // 與學校活動衝堂的週次不提供撰寫（送審時不列入必填）
    const weekSchedule = await getWeekSchedule(student.grade, student.classCode);
    const blockedWeeks = weekSchedule.filter((week) => week.blocked).map((week) => week.week);
    const parsed = parsePlanDraft(
      body?.draft,
      {
        ...settings,
        fullWeeks,
        blockedWeeks,
        venueEditable: settings.venueEditable,
        venueOptions: settings.venues,
      },
      action
    );
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, message: parsed.message },
        { status: 400, headers: noStore }
      );
    }

    const result = await saveStudentPlan({
      student,
      draft: parsed.value,
      action,
      settings,
      planId: planId || null,
    });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status, headers: noStore }
      );
    }

    if (action === "submit") {
      await logActivity({
        userId: student.uid,
        role: session.role,
        action: "self_directed_learning_plan_submitted",
        ip: getClientIp(request),
        details: `送出自主學習計畫：${result.plan.topic}`,
      });
    }

    return NextResponse.json(
      { success: true, plan: result.plan },
      { headers: noStore }
    );
  } catch (error) {
    console.error("selfDirectedLearning student POST error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "儲存計畫失敗") },
      { status: 500, headers: noStore }
    );
  }
}
