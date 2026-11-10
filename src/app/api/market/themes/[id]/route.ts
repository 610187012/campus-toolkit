import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { unauthorized } from "@/lib/server-session";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import {
  downloadThemeZip,
  extractThemeZip,
  fetchThemeMarketIndex,
  findThemeManifestRoot,
  loadThemePackage,
} from "@/lib/theme-market";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 主題內容取回（已登入者）。
 *
 * 用途：帳號主題同步（Step 11）與跨裝置還原——當使用者的 themeId 指向
 * `market:{id}` 但本機沒有主題內容時，由本端點從市集下載並驗證後回傳，
 * 前端存入 localStorage。伺服器以記憶體快取（依 checksum）避免重複下載。
 */

interface CacheEntry {
  checksum: string;
  payload: unknown;
  at: number;
}

const CONTENT_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTENT_CACHE_MAX = 50;
const contentCache = new Map<string, CacheEntry>();

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "market-theme-get",
      RATE.MARKET_THEME_GET.limit,
      RATE.MARKET_THEME_GET.windowMs
    );
    if (limited) return limited;

    if (!(await verifySession())) return unauthorized();

    const { id } = await params;
    const themeId = id.trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(themeId)) {
      return NextResponse.json({ success: false, message: "主題 id 格式不合法" }, { status: 400 });
    }

    const index = await fetchThemeMarketIndex();
    const entry = index.themes.find((item) => item.id === themeId);
    if (!entry) {
      return NextResponse.json({ success: false, message: `市集中找不到主題「${themeId}」` }, { status: 404 });
    }
    if (!entry.downloadUrl || !entry.checksumSha256) {
      return NextResponse.json(
        { success: false, message: "該主題缺少可安裝來源（downloadUrl／checksumSha256）" },
        { status: 400 }
      );
    }

    const now = Date.now();
    const cached = contentCache.get(themeId);
    if (cached && cached.checksum === entry.checksumSha256 && now - cached.at < CONTENT_CACHE_TTL_MS) {
      return NextResponse.json(cached.payload, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    const downloaded = await downloadThemeZip(entry.downloadUrl, entry.checksumSha256);
    const extractedDir = extractThemeZip(downloaded.filePath);
    const workingDir = findThemeManifestRoot(extractedDir);
    const loaded = loadThemePackage(workingDir, themeId, { checksumSha256: downloaded.sha256 });

    const payload = {
      success: true,
      themeId: loaded.manifest.themeId,
      theme: loaded.manifest,
      colors: loaded.colors,
      preview: loaded.colors["--bg"] ?? "#ffffff",
    };

    contentCache.set(themeId, { checksum: entry.checksumSha256, payload, at: now });
    if (contentCache.size > CONTENT_CACHE_MAX) {
      const oldest = contentCache.keys().next().value;
      if (oldest) contentCache.delete(oldest);
    }

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Market theme get error:", error);
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : "主題內容取得失敗" },
      { status: 500 }
    );
  }
}
