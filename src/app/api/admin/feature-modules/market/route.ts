import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getAdminDb } from "@/lib/firebase-admin";
import { isSuperAdmin, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { parseModuleMarketIndex } from "@/types/module-market";
import { invalidateSettingsCache, SETTINGS_COLLECTION, SETTINGS_DOC_ID } from "@/lib/settings-server";
import { MODULE_MARKET_INDEX_URL_FIELD, resolveModuleMarketIndexUrl } from "@/lib/module-market";
import { resolveModuleMarketGithubConfig } from "@/lib/module-market-github";
import { readJsonBody } from "@/lib/http-body";

export const dynamic = "force-dynamic";

const MAX_INDEX_BYTES = 512 * 1024;

function readInstalledModules(): Record<string, string> {
  const lockPath = path.join(process.cwd(), "module.lock.json");
  if (!fs.existsSync(lockPath)) return {};
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
      modules?: Array<{ value?: unknown; version?: unknown }>;
    };
    const modules = Array.isArray(lock.modules) ? lock.modules : [];
    const out: Record<string, string> = {};
    for (const item of modules) {
      if (!item || typeof item.value !== "string") continue;
      out[item.value] = typeof item.version === "string" ? item.version : "";
    }
    return out;
  } catch {
    return {};
  }
}

export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_GET.limit,
      RATE.FEATURE_MODULES_GET.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("modules");
    if (denial) return toAuthResponse(denial);

    if (!(await isSuperAdmin(session))) {
      return NextResponse.json(
        { success: false, message: "僅超級管理員可查看模組市集" },
        { status: 403 }
      );
    }

    const marketUrl = await resolveModuleMarketIndexUrl();
    if (!marketUrl) {
      return NextResponse.json(
        {
          success: false,
          message:
            "尚未設定模組市集來源，請先在「模組市集來源設定」輸入 index.json URL，或設定 MODULE_MARKET_INDEX_URL",
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

    const index = parseModuleMarketIndex(payload);
    if (!index) {
      return NextResponse.json(
        { success: false, message: "市集 index.json 缺少有效的 modules 清單" },
        { status: 400 }
      );
    }

    const canAutoInstall =
      process.env.NODE_ENV === "development" ||
      (process.env.NODE_ENV === "production" && !!resolveModuleMarketGithubConfig());

    return NextResponse.json({
      success: true,
      marketUrl,
      generatedAt: index.generatedAt,
      marketplaceVersion: index.marketplaceVersion,
      modules: index.modules,
      installedModules: readInstalledModules(),
      canUninstall: canAutoInstall,
      canAutoInstall,
    });
  } catch (error) {
    console.error("Market modules fetch error:", error);
    return NextResponse.json({
      success: false,
      message: error instanceof Error ? error.message : "讀取市集資訊失敗",
    });
  }
}

export async function PATCH(request: NextRequest) {
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

    const { session, denial } = await requireAdminModule("modules");
    if (denial) return toAuthResponse(denial);

    if (!(await isSuperAdmin(session))) {
      return NextResponse.json(
        { success: false, message: "僅超級管理員可設定模組市集來源" },
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
      .set({ [MODULE_MARKET_INDEX_URL_FIELD]: marketUrl }, { merge: true });
    invalidateSettingsCache();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "feature_module_updated",
      ip: getClientIp(request),
      details: marketUrl
        ? `設定模組市集來源：${marketUrl}`
        : "清除模組市集來源設定（回退環境變數）",
    });

    return NextResponse.json({
      success: true,
      message: marketUrl ? "模組市集來源已更新" : "模組市集來源已清除，將回退環境變數",
      marketUrl,
    });
  } catch (error) {
    console.error("Market modules config update error:", error);
    return NextResponse.json({
      success: false,
      message: error instanceof Error ? error.message : "更新模組市集設定失敗",
    });
  }
}
