import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { isSuperAdmin, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { resolveThemeMarketIndexUrl, THEME_MARKET_INDEX_URL_FIELD } from "@/lib/theme-market";
import { parseThemeMarketIndex } from "@/types/theme-market";
import { invalidateSettingsCache, SETTINGS_COLLECTION, SETTINGS_DOC_ID } from "@/lib/settings-server";
import { readJsonBody } from "@/lib/http-body";

export const dynamic = "force-dynamic";

const MAX_INDEX_BYTES = 512 * 1024;

/**
 * 主題市集索引讀取（Step 7，協議 §4.1）：
 * 比照模組市集 GET /api/admin/feature-modules/market——
 * 即時抓遠端 index.json、大小上限、JSON 解析、契約解析後回前端。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "theme-market",
      RATE.THEME_MARKET_GET.limit,
      RATE.THEME_MARKET_GET.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("themeMarket");
    if (denial) return toAuthResponse(denial);

    if (!(await isSuperAdmin(session))) {
      return NextResponse.json(
        { success: false, message: "僅超級管理員可查看主題市集" },
        { status: 403 }
      );
    }

    const marketUrl = await resolveThemeMarketIndexUrl();
    if (!marketUrl) {
      return NextResponse.json(
        {
          success: false,
          message:
            "尚未設定主題市集來源，請先在「主題市集來源設定」輸入 index.json URL，或設定 THEME_MARKET_INDEX_URL",
        },
        { status: 503 }
      );
    }

    const response = await fetch(marketUrl, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { success: false, message: `市集來源回應失敗（HTTP ${response.status}）` },
        { status: 502 }
      );
    }

    const text = await response.text();
    const contentBytes = new TextEncoder().encode(text).length;
    if (contentBytes > MAX_INDEX_BYTES) {
      return NextResponse.json(
        { success: false, message: "市集資料過大，超過 512KB 限制" },
        { status: 413 }
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { success: false, message: "市集 index.json 格式錯誤，無法解析 JSON" },
        { status: 400 }
      );
    }

    const index = parseThemeMarketIndex(payload);
    if (!index) {
      return NextResponse.json(
        { success: false, message: "市集 index.json 缺少有效的 modules 清單" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      marketUrl,
      generatedAt: index.generatedAt,
      marketplaceVersion: index.marketplaceVersion,
      themes: index.themes,
    });
  } catch (error) {
    console.error("Theme market fetch error:", error);
    return NextResponse.json({
      success: false,
      message: error instanceof Error ? error.message : "讀取主題市集失敗",
    });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "theme-market",
      RATE.THEME_MARKET_MUTATE.limit,
      RATE.THEME_MARKET_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("themeMarket");
    if (denial) return toAuthResponse(denial);

    if (!(await isSuperAdmin(session))) {
      return NextResponse.json(
        { success: false, message: "僅超級管理員可設定主題市集來源" },
        { status: 403 }
      );
    }

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const marketUrl = typeof body.marketUrl === "string" ? body.marketUrl.trim() : "";
    if (marketUrl) {
      let parsed: URL;
      try {
        parsed = new URL(marketUrl);
      } catch {
        return NextResponse.json({ success: false, message: "marketUrl 不是合法 URL" }, { status: 400 });
      }

      const isLocalhostDev =
        process.env.NODE_ENV === "development" &&
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
      if (!isLocalhostDev && parsed.protocol !== "https:") {
        return NextResponse.json(
          { success: false, message: "marketUrl 僅允許 https（開發環境可允 localhost http）" },
          { status: 400 }
        );
      }
    }

    await getAdminDb()
      .collection(SETTINGS_COLLECTION)
      .doc(SETTINGS_DOC_ID)
      .set({ [THEME_MARKET_INDEX_URL_FIELD]: marketUrl }, { merge: true });
    invalidateSettingsCache();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "theme_market_published",
      ip: getClientIp(request),
      details: marketUrl
        ? `設定主題市集來源：${marketUrl}`
        : "清除主題市集來源設定（回退環境變數）",
    });

    return NextResponse.json({
      success: true,
      message: marketUrl ? "主題市集來源已更新" : "主題市集來源已清除，將回退環境變數",
      marketUrl,
    });
  } catch (error) {
    console.error("Theme market config update error:", error);
    return NextResponse.json({
      success: false,
      message: error instanceof Error ? error.message : "更新主題市集設定失敗",
    });
  }
}
