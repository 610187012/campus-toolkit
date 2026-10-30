import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireRole, toAuthResponse, type VerifiedSession } from "@/lib/dal";
import { managedModulesOf } from "@/lib/roster";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { getSettings, getWeekSlotSchedule } from "../../../lib/self-directed-learning";
import {
  applyReview,
  countSubmittedPlansForScope,
  listClassPlans,
  listSubmittedPlansForScope,
} from "../../../lib/self-directed-learning-plans";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  MAINTENANCE_TITLE,
  parseReviewInput,
  periodLabelOf,
  reviewerScopeOf,
  type ReviewScope,
  type SelfDirectedLearningSettings,
} from "../../../types/self-directed-learning";

const noStore = { "Cache-Control": "no-store" };

/** 主程式的 serverErrorMessage 等價小工具（模組不得依賴非公開面檔案） */
function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

interface StaffRoles {
  isReviewer: boolean;
  isTutor: boolean;
  classCode: string;
  /** 被指派的管理子權限（功能模組管理頁指派的管理者走此欄） */
  permissions: string[];
  /** 審核人員的審查對象範圍（未設定＝全校） */
  scope: ReviewScope;
}

/**
 * 審核資格＝審核人員名單，或被指派 review／viewPlans 子權限；
 * 導師＝名冊條目 attribute 為兼導師且有班級代碼。
 */
async function staffRolesOf(
  session: VerifiedSession,
  settings: SelfDirectedLearningSettings
): Promise<StaffRoles> {
  const reviewerEntry =
    settings.reviewers.find((reviewer) => reviewer.uid === session.uid) ?? null;
  const isReviewerList = reviewerEntry !== null;
  const grant = managedModulesOf(session.__entry).find(
    (item) => item.module === "selfDirectedLearning"
  );
  const permissions = grant?.permissions ?? [];
  const isReviewer = isReviewerList || permissions.includes("review");
  const entry = session.__entry;
  const attribute = entry && typeof entry.attribute === "string" ? entry.attribute.trim() : "";
  const classCode = entry && typeof entry.classCode === "string" ? entry.classCode.trim() : "";
  return {
    isReviewer,
    isTutor: attribute === "兼導師" && Boolean(classCode),
    classCode,
    permissions,
    // 被指派 review 但不在審核名單者沒有範圍設定＝全校
    scope: reviewerScopeOf(reviewerEntry),
  };
}

/** GET：`?mode=review`（審核佇列，需審核資格）／`?mode=class`（全班，需兼導師） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-staff",
      RATE.SELF_DIRECTED_LEARNING_STAFF.limit,
      RATE.SELF_DIRECTED_LEARNING_STAFF.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("staff");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
    if (gate) return gate;

    const settings = await getSettings();
    const roles = await staffRolesOf(session as VerifiedSession, settings);
    const modeParam = request.nextUrl.searchParams.get("mode");
    const mode: "review" | "class" | "count" =
      modeParam === "class" ? "class" : modeParam === "count" ? "count" : "review";
    const period = periodLabelOf(await getCurrentPeriod());
    // 審核期限：只提供起訖（供審核頁顯示與逾期提醒，不阻止審核）
    const reviewWindow = {
      startAt: settings.reviewStartAt,
      endAt: settings.reviewEndAt,
    };

    // 總開關關閉：非管理端只回維護旗標（計畫清單不回傳）
    if (!settings.enabled) {
      return NextResponse.json(
        { success: true, maintenance: true, mode, roles, period, reviewWindow, plans: [] },
        { headers: noStore }
      );
    }

    if (mode === "class") {
      if (roles.isReviewer) {
        return NextResponse.json(
          { success: false, message: "審核人員僅顯示送審中的計畫，不提供全班清單" },
          { status: 403, headers: noStore }
        );
      }
      if (!roles.isTutor) {
        return NextResponse.json(
          { success: false, message: "此功能僅提供給有班級代碼的兼導師。" },
          { status: 403, headers: noStore }
        );
      }
      const plans = await listClassPlans(period, roles.classCode);
      const weekSchedule = await getWeekSlotSchedule();
      return NextResponse.json(
        { success: true, mode, roles, period, reviewWindow, plans, weekSchedule },
        { headers: noStore }
      );
    }

    const canViewPlans =
      roles.isReviewer || roles.permissions.includes("viewPlans") || roles.permissions.includes("review");
    if (!canViewPlans) {
      return NextResponse.json(
        {
          success: false,
          message: "你不在本模組的審核人員名單內，也未被指派查看計畫的權限。",
          mode,
          roles,
          period,
          reviewWindow,
        },
        { status: 403, headers: noStore }
      );
    }

    // 省流模式：只回待審件數（count 聚合），不載入計畫內容
    if (mode === "count") {
      const count = await countSubmittedPlansForScope(period, roles.scope);
      return NextResponse.json(
        { success: true, mode, roles, period, reviewWindow, count },
        { headers: noStore }
      );
    }

    const plans = await listSubmittedPlansForScope(period, roles.scope);
    const weekSchedule = await getWeekSlotSchedule();
    return NextResponse.json(
      { success: true, mode, roles, period, reviewWindow, plans, weekSchedule },
      { headers: noStore }
    );
  } catch (error) {
    console.error("selfDirectedLearning staff GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "讀取資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/** POST：`{ action: "approve" | "return", planId, note }`（需審核資格） */
export async function POST(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-staff-mutate",
      RATE.SELF_DIRECTED_LEARNING_STAFF.limit,
      RATE.SELF_DIRECTED_LEARNING_STAFF.windowMs
    );
    if (limited) return limited;
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const { session, denial } = await requireRole("staff");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
    if (gate) return gate;

    const settings = await getSettings();
    if (!settings.enabled) {
      return NextResponse.json(
        { success: false, message: MAINTENANCE_TITLE },
        { status: 403, headers: noStore }
      );
    }

    const roles = await staffRolesOf(session as VerifiedSession, settings);
    if (!roles.isReviewer) {
      return NextResponse.json(
        { success: false, message: "你沒有審核權限（不在審核人員名單，也未被指派 review 子權限）。" },
        { status: 403, headers: noStore }
      );
    }

    const parsed = parseReviewInput(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, message: parsed.message },
        { status: 400, headers: noStore }
      );
    }

    const reviewerName = session.displayName || session.account;
    const result = await applyReview({
      planId: parsed.value.planId,
      action: parsed.value.action,
      note: parsed.value.note,
      weekNotes: parsed.value.weekNotes,
      reviewerUid: session.uid,
      reviewerName,
      scope: roles.scope,
    });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status, headers: noStore }
      );
    }

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "self_directed_learning_plan_reviewed",
      ip: getClientIp(request),
      details: `${parsed.value.action === "approve" ? "通過" : "退回"}自主學習計畫：${result.plan.topic}`,
    });

    return NextResponse.json({ success: true, plan: result.plan }, { headers: noStore });
  } catch (error) {
    console.error("selfDirectedLearning staff POST error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "審核處理失敗") },
      { status: 500, headers: noStore }
    );
  }
}
