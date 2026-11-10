import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { unauthorized } from "@/lib/server-session";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { getAdminDb } from "@/lib/firebase-admin";
import { USER_COLLECTION } from "@/types/users";
import { THEME_COLOR_KEYS } from "@/types/theme";
import { readJsonBody } from "@/lib/http-body";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/** installedThemes 上限（與舊 GAS 名冊同步上限一致的精神：單一帳號、少量主題） */
const MAX_INSTALLED_ITEMS = 50;
const MAX_INSTALLED_JSON_BYTES = 32 * 1024;

const THEME_ID_PATTERN = /^(builtin|market|custom):[a-z0-9-]+$/;

interface InstalledThemeItem {
  id: string;
  name: string;
  version: string;
  source: string;
  installedAt: string;
  /** 自訂主題的色彩備援（方案 C：僅在編輯器「儲存」時寫入帳號，供跨裝置還原） */
  colors?: Record<string, string>;
}

/** 驗證色彩物件（白名單鍵＋值安全；方案 C 的帳號備援格式） */
function parseThemeColors(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const entries = Object.entries(source);
  if (entries.length === 0 || entries.length > THEME_COLOR_KEYS.length) return null;
  const colors: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!(THEME_COLOR_KEYS as readonly string[]).includes(key)) return null;
    if (typeof value !== "string" || !value.trim() || value.length > 160) return null;
    if (/[;{}]|url\(|expression\(/i.test(value)) return null;
    colors[key] = value.trim();
  }
  return colors;
}

function parseInstalledThemes(raw: unknown): InstalledThemeItem[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_INSTALLED_ITEMS) return null;
  const items: InstalledThemeItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const version = typeof record.version === "string" ? record.version.trim() : "";
    if (!id || !name || !version || !THEME_ID_PATTERN.test(id)) return null;
    const entry: InstalledThemeItem = {
      id,
      name: name.slice(0, 100),
      version: version.slice(0, 20),
      source: typeof record.source === "string" ? record.source.slice(0, 20) : "market",
      installedAt: typeof record.installedAt === "string" ? record.installedAt.slice(0, 40) : "",
    };
    if (record.colors !== undefined) {
      // 僅自訂主題允許附色彩備援（市集主題可從市集重抓，不佔帳號空間）
      if (!id.startsWith("custom:")) return null;
      const colors = parseThemeColors(record.colors);
      if (!colors) return null;
      entry.colors = colors;
    }
    items.push(entry);
  }
  return items;
}

function readUserThemeFields(user: Record<string, unknown> | null | undefined): {
  cssThemeId: string;
  installedThemes: InstalledThemeItem[];
} {
  const cssThemeId = user && typeof user.cssThemeId === "string" ? user.cssThemeId : "";
  const raw = user && typeof user.installedThemes === "string" ? user.installedThemes : "[]";
  let installed: InstalledThemeItem[] = [];
  try {
    installed = parseInstalledThemes(JSON.parse(raw)) ?? [];
  } catch {
    installed = [];
  }
  return { cssThemeId, installedThemes: installed };
}

/** GET：讀取本人主題偏好（themeId＋已安裝清單，Step 11 帳號同步） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "me-theme-get",
      RATE.ME_THEME_GET.limit,
      RATE.ME_THEME_GET.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    if (!session) return unauthorized();

    // 鐵律 5：優先復用 verifySession 已讀的 __user，沒有才補讀點查
    let user = session.__user as Record<string, unknown> | undefined;
    if (!user) {
      const doc = await getAdminDb().collection(USER_COLLECTION).doc(session.uid).get();
      user = doc.exists ? (doc.data() as Record<string, unknown>) : undefined;
    }
    const fields = readUserThemeFields(user);

    return NextResponse.json({ success: true, ...fields }, { headers: noStore });
  } catch (error) {
    console.error("Me theme GET error:", error);
    return NextResponse.json(
      { success: false, message: "讀取主題偏好失敗" },
      { status: 500, headers: noStore }
    );
  }
}

/** PUT：儲存本人主題偏好（部分更新，僅寫提供的欄位） */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "me-theme-put",
      RATE.ME_THEME_MUTATE.limit,
      RATE.ME_THEME_MUTATE.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    if (!session) return unauthorized();

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const hasThemeId = "themeId" in body;
    const hasInstalled = "installedThemes" in body;

    if (!hasThemeId && !hasInstalled) {
      return NextResponse.json(
        { success: false, message: "沒有提供任何要更新的欄位" },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};

    if (hasThemeId) {
      const themeId = typeof body.themeId === "string" ? body.themeId.trim() : "";
      if (themeId && !THEME_ID_PATTERN.test(themeId)) {
        return NextResponse.json(
          { success: false, message: "themeId 格式不合法（需為 builtin:/market:/custom: 前綴）" },
          { status: 400 }
        );
      }
      updateData.cssThemeId = themeId;
    }

    if (hasInstalled) {
      const items = parseInstalledThemes(body.installedThemes);
      if (!items) {
        return NextResponse.json(
          {
            success: false,
            message: `installedThemes 格式不合法（最多 ${MAX_INSTALLED_ITEMS} 筆，需含 id/name/version）`,
          },
          { status: 400 }
        );
      }
      const serialized = JSON.stringify(items);
      if (new TextEncoder().encode(serialized).length > MAX_INSTALLED_JSON_BYTES) {
        return NextResponse.json(
          { success: false, message: "installedThemes 過大（超過 32KB）" },
          { status: 413 }
        );
      }
      updateData.installedThemes = serialized;
    }

    await getAdminDb().collection(USER_COLLECTION).doc(session.uid).update(updateData);

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "theme_preferences_updated",
      ip: getClientIp(request),
      details: `更新個人主題偏好（${Object.keys(updateData).join("、")}）`,
    });

    return NextResponse.json(
      {
        success: true,
        cssThemeId: typeof updateData.cssThemeId === "string" ? updateData.cssThemeId : undefined,
        installedThemes:
          typeof updateData.installedThemes === "string"
            ? (JSON.parse(updateData.installedThemes) as InstalledThemeItem[])
            : undefined,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Me theme PUT error:", error);
    return NextResponse.json(
      { success: false, message: "儲存主題偏好失敗" },
      { status: 500, headers: noStore }
    );
  }
}
