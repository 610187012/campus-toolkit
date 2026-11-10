import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { unauthorized } from "@/lib/server-session";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { createThemePullRequest, prepareThemeSubmission, resolveMarketGithubConfig } from "@/lib/theme-market-github";
import { readJsonBody } from "@/lib/http-body";

export const dynamic = "force-dynamic";

/**
 * 使用者投稿（§21，契約 §11）：
 * 任何已登入使用者送出 token JSON → 服務帳號對市集 repo 開 draft PR → 管理員審核後 merge 上架。
 * 只收 token JSON，不收自由 CSS（契約 §11.1）。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "theme-market-submit",
      RATE.THEME_MARKET_SUBMIT.limit,
      RATE.THEME_MARKET_SUBMIT.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    if (!session) return unauthorized();

    if (!resolveMarketGithubConfig()) {
      return NextResponse.json(
        {
          success: false,
          message:
            "投稿功能尚未啟用（伺服器未設定 THEME_MARKET_GITHUB_TOKEN）——請聯絡管理者",
        },
        { status: 503 }
      );
    }

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const input = prepareThemeSubmission(body, {
      mode: "submit",
      defaultAuthor: session.displayName || session.email,
    });
    input.provenance = `${session.displayName || session.email}（uid: ${session.uid}, email: ${session.email}）`;

    const { prUrl, branch } = await createThemePullRequest(input);

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "theme_submitted",
      ip: getClientIp(request),
      details: `投稿主題「market:${input.id}」v${input.version}（PR: ${branch}）`,
    });

    return NextResponse.json({
      success: true,
      message: "投稿成功！已送出審核（草稿 PR），管理員通過後即會上架市集",
      prUrl,
      branch,
    });
  } catch (error) {
    console.error("Theme submit error:", error);
    const message = error instanceof Error ? error.message : "投稿失敗";
    const isInputError = /需為|最多|缺少|已存在|不可用/.test(message);
    return NextResponse.json(
      { success: false, message },
      { status: isInputError ? 400 : 500 }
    );
  }
}
