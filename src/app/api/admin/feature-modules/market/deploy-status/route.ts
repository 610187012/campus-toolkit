import { NextRequest, NextResponse } from "next/server";
import { isSuperAdmin, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getBranchDeployStatus } from "@/lib/module-market-github";

export const dynamic = "force-dynamic";

/**
 * GET：查詢指定分支的最新部署狀態（GitHub combined status）。
 * 參數：?branch=<分支名>（預設 main）。僅超級管理員。
 * 【E13/5b】安裝/更新後管理頁輪詢用——回 pending/success/failure/unknown。
 */
export async function GET(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_GET.limit,
      RATE.FEATURE_MODULES_GET.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("modules");
    if (denial) return toAuthResponse(denial);
    if (!(await isSuperAdmin(session))) {
      return NextResponse.json({ success: false, message: "僅超級管理員可查詢部署狀態" }, { status: 403 });
    }

    const branch = request.nextUrl.searchParams.get("branch")?.trim() || "main";
    const status = await getBranchDeployStatus(branch);
    return NextResponse.json({ success: true, branch, ...status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Deploy status error:", error);
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : "查詢部署狀態失敗" },
      { status: 500 }
    );
  }
}
