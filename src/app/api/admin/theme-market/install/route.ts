import { NextRequest, NextResponse } from "next/server";
import { isSuperAdmin, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import {
  downloadThemeZip,
  extractThemeZip,
  findThemeManifestRoot,
  loadThemePackage,
} from "@/lib/theme-market";
import { readJsonBody } from "@/lib/http-body";

export const dynamic = "force-dynamic";

/**
 * 主題安裝（Step 8，協議 §6 全套安全檢查）。
 *
 * 與模組安裝的關鍵差異：主題是純資料（JSON＋CSS），不寫入 repo 的 src/ 目錄，
 * 只寫伺服器暫存目錄並回傳驗證後的主題內容——因此 production（Vercel 檔案系統唯讀）
 * 也能安裝；主題內容由前端存入 localStorage，帳號層 themeId 由 /api/me/theme 同步。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
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
        { success: false, message: "僅超級管理員可安裝主題" },
        { status: 403 }
      );
    }

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const themeId = typeof body.id === "string" ? body.id.trim() : "";
    const downloadUrl = typeof body.downloadUrl === "string" ? body.downloadUrl.trim() : "";
    const expectedSha256 =
      typeof body.checksumSha256 === "string" ? body.checksumSha256.trim().toLowerCase() : "";
    const expectedVersion = typeof body.version === "string" ? body.version.trim() : "";

    if (!themeId) {
      return NextResponse.json({ success: false, message: "缺少主題 id" }, { status: 400 });
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(themeId)) {
      return NextResponse.json({ success: false, message: "主題 id 格式不合法" }, { status: 400 });
    }
    if (!downloadUrl) {
      return NextResponse.json(
        { success: false, message: "缺少 downloadUrl（主題安裝只接受市集下載）" },
        { status: 400 }
      );
    }
    if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      return NextResponse.json(
        { success: false, message: "checksumSha256 需為 64 碼小寫十六進位（契約 §6-4）" },
        { status: 400 }
      );
    }

    const downloaded = await downloadThemeZip(downloadUrl, expectedSha256);
    const extractedDir = extractThemeZip(downloaded.filePath);
    const workingDir = findThemeManifestRoot(extractedDir);
    const loaded = loadThemePackage(workingDir, themeId, {
      expectedVersion: expectedVersion || undefined,
      checksumSha256: downloaded.sha256,
    });

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "theme_market_installed",
      ip: getClientIp(request),
      details: `主題市集安裝「${loaded.manifest.themeId}」v${loaded.manifest.version}`,
    });

    return NextResponse.json({
      success: true,
      message: `主題「${loaded.manifest.name}」v${loaded.manifest.version} 安裝完成，可在右上角主題選單中啟用`,
      package: {
        theme: loaded.manifest,
        themeId: loaded.manifest.themeId,
        colors: loaded.colors,
        preview: loaded.colors["--bg"] ?? "#ffffff",
        checksumSha256: downloaded.sha256,
        installedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Theme market install error:", error);
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "主題安裝失敗",
      },
      { status: 500 }
    );
  }
}
