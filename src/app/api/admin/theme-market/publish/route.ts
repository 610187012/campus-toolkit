import { NextRequest, NextResponse } from "next/server";
import { isSuperAdmin, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { createThemePullRequest, prepareThemeSubmission, resolveMarketGithubConfig } from "@/lib/theme-market-github";
import { readJsonBody } from "@/lib/http-body";

export const dynamic = "force-dynamic";

/**
 * 管理員發佈（M2.5，契約 §11）：
 * 超級管理員於後台表單發佈 → 服務帳號對市集 repo 開正式 PR → CI 驗證 → merge 即上架。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "theme-market-publish",
      RATE.THEME_MARKET_PUBLISH.limit,
      RATE.THEME_MARKET_PUBLISH.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("themeMarket");
    if (denial) return toAuthResponse(denial);

    if (!(await isSuperAdmin(session))) {
      return NextResponse.json(
        { success: false, message: "僅超級管理員可發佈主題" },
        { status: 403 }
      );
    }

    if (!resolveMarketGithubConfig()) {
      return NextResponse.json(
        {
          success: false,
          message:
            "尚未設定 THEME_MARKET_GITHUB_TOKEN（服務帳號 token，僅需市集 repo 的 contents 與 pull requests 權限）——發佈功能不可用",
        },
        { status: 503 }
      );
    }

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const input = prepareThemeSubmission(body, {
      mode: "publish",
      defaultAuthor: session.displayName || session.email,
    });
    input.provenance = `管理員 ${session.displayName || session.email}（uid: ${session.uid}）`;

    const { prUrl, branch } = await createThemePullRequest(input);

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "theme_market_published",
      ip: getClientIp(request),
      details: `發佈主題「market:${input.id}」v${input.version}（PR: ${branch}）`,
    });

    return NextResponse.json({
      success: true,
      message: `已建立發佈 PR，待 CI 驗證與 merge 後即上架市集`,
      prUrl,
      branch,
    });
  } catch (error) {
    console.error("Theme publish error:", error);
    const message = error instanceof Error ? error.message : "發佈失敗";
    const isInputError = /需為|最多|缺少|已存在|不可用/.test(message);
    return NextResponse.json(
      { success: false, message },
      { status: isInputError ? 400 : 500 }
    );
  }
}
