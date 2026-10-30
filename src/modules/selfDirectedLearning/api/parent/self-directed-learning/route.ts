import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { requireRole, toAuthResponse, type VerifiedSession } from "@/lib/dal";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { getSettings } from "../../../lib/self-directed-learning";
import {
  getLatestReview,
  getStudentPlans,
  linkedChildForParent,
} from "../../../lib/self-directed-learning-plans";
import { getCurrentPeriod } from "@/lib/settings-server";
import { openStateOf, periodLabelOf } from "../../../types/self-directed-learning";

const noStore = { "Cache-Control": "no-store" };

/** 主程式的 serverErrorMessage 等價小工具（模組不得依賴非公開面檔案） */
function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

/** GET：家長唯讀檢視子女的自主學習計畫與最新審查意見 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-list",
      RATE.SELF_DIRECTED_LEARNING_LIST.limit,
      RATE.SELF_DIRECTED_LEARNING_LIST.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("parent");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
    if (gate) return gate;

    // 總開關關閉：非管理端只回維護旗標（子女與計畫資料不回傳）
    const settings = await getSettings();
    if (!settings.enabled) {
      return NextResponse.json(
        { success: true, maintenance: true, child: null, plan: null, latestReview: null, instructions: "", withinWindow: false, hiddenByStudent: false },
        { headers: noStore }
      );
    }

    const entry = (session as VerifiedSession).__entry;
    if (!entry) {
      return NextResponse.json(
        { success: false, message: "查無家長名冊資料，無法使用本功能" },
        { status: 403, headers: noStore }
      );
    }

    const child = await linkedChildForParent(entry);
    if (!child) {
      return NextResponse.json(
        {
          success: false,
          message: "本帳號未綁定可檢視的子女（名冊未設定學號或查無唯一子女）。",
        },
        { status: 403, headers: noStore }
      );
    }

    // 同一學生可能有多筆計畫：只取學生開放家長檢視的；優先本學期正式計畫，其次最新通過，最後最新一筆
    const allPlans = (await getStudentPlans(child.uid)).filter((item) => !item.deletedAt);
    const plans = allPlans.filter((item) => item.parentVisible !== false);
    const currentPeriod = periodLabelOf(await getCurrentPeriod());
    const plan =
      plans.find((item) => item.period === currentPeriod && item.status === "approved") ??
      plans.find((item) => item.status === "approved") ??
      plans[0] ??
      null;
    const latestReview = plan ? await getLatestReview(plan.id) : null;
    return NextResponse.json(
      {
        success: true,
        child,
        plan,
        latestReview,
        instructions: settings.instructions,
        withinWindow: openStateOf(settings) === "open",
        /** 子女有計畫，但全部被學生設為不開放家長檢視 */
        hiddenByStudent: allPlans.length > 0 && !plan,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("selfDirectedLearning parent GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "讀取資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}
