import "server-only";
import { getAdminDbRaw, FieldValue } from "@/lib/firebase-admin";
import {
  clampCacheTtlSeconds,
  defaultSettings,
  DEFAULT_SYSTEM_NAME,
  detectPeriod,
  SchoolPeriod,
} from "@/types/settings";

export const SETTINGS_COLLECTION = "settings";
export const SETTINGS_DOC_ID = "system";
const CACHE_TTL_MS = 30_000;

/**
 * `settings/system` 整份文件的 30 秒 in-process 快取——**全站唯一一份**。
 * 各設定欄位的讀取函式（本檔、`role-settings.ts`、`feature-modules.ts`、
 * `/api/settings` 的 GET）一律走 `readSystemDoc()`，同一文件同一時間只會讀一次
 * （修正過去「同一份文件掛 7 個獨立快取、冷程序各讀各的」的浪費，
 * 見 docs/資料庫讀取規範.md 鐵律 6）。任何設定寫入後由 invalidateSettingsCache() 失效。
 */
let systemDocCache: { data: Record<string, unknown> | null; at: number } | null = null;

/** 任何設定（含 roleEnabled、featureModules 欄位）寫入後呼叫，讓設定快取立即失效 */
export function invalidateSettingsCache(): void {
  systemDocCache = null;
}

/** 全域清單快取版本旗標的欄位名（見 docs/資料庫讀取規範.md 鐵律 6：跨實例失效） */
export const CACHE_EPOCH_FIELD = "cacheEpoch";

/**
 * 讀取 `settings/system.cacheEpoch`（全域清單快取的失效旗標）。
 * 讀同一份 readSystemDoc 快取（30 秒），因此**每請求驗證路徑已讀過時為 0 次額外讀取**；
 * 欄位缺漏或讀失敗回 0（未 bump 過的初始值）。
 */
export async function getCacheEpoch(): Promise<number> {
  const raw = await readSystemDoc();
  const epoch = Number(raw?.[CACHE_EPOCH_FIELD]);
  return Number.isFinite(epoch) && epoch >= 0 ? epoch : 0;
}

/**
 * 遞增 `settings/system.cacheEpoch`，讓**所有實例**的清單快取（key 綁 epoch）立即失效。
 * serverless 多實例間無法互通知程序內快取，改以這份跨實例共用的旗標傳達「有資料變更」；
 * 讀端以 readSystemDoc 快取吸收，延遲上限＝設定快取 TTL（30 秒）。
 * 使用 merge set＋FieldValue.increment：settings/system 尚未存在時也能安全建立。
 * 成功後同步清除本程序的設定快取（立即看到新 epoch）。
 */
export async function bumpCacheEpoch(): Promise<void> {
  await getAdminDbRaw()
    .collection(SETTINGS_COLLECTION)
    .doc(SETTINGS_DOC_ID)
    .set({ [CACHE_EPOCH_FIELD]: FieldValue.increment(1) }, { merge: true });
  invalidateSettingsCache();
}

/**
 * 讀取 `settings/system` 整份文件（30 秒 in-process 快取，全站共用）。
 * 讀失敗回退上次快取值；從未成功讀取過則回 null，由各讀取函式自行套用預設值
 * （維持各欄位原本 fail-safe／fail-closed 的預設行為）。
 */
export async function readSystemDoc(): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  if (systemDocCache && now - systemDocCache.at < CACHE_TTL_MS) return systemDocCache.data;

  try {
    const snap = await getAdminDbRaw()
      .collection(SETTINGS_COLLECTION)
      .doc(SETTINGS_DOC_ID)
      .get();
    const data = snap.exists
      ? ((snap.data() as Record<string, unknown> | undefined) ?? null)
      : null;
    systemDocCache = { data, at: now };
    return data;
  } catch (error) {
    console.error("System settings read error:", error);
    return systemDocCache ? systemDocCache.data : null;
  }
}

/**
 * 讀取 settings.systemEnabled（維護模式），供伺服器端強制執行。
 * 讀同一份 settings/system 快取；欄位缺漏時回預設啟用（fail-safe）。
 */
export async function isSystemEnabled(): Promise<boolean> {
  const raw = await readSystemDoc();
  return typeof raw?.systemEnabled === "boolean" ? raw.systemEnabled : defaultSettings.systemEnabled;
}

/**
 * 讀取 settings.oauthEnabled（是否啟用 Google OAuth 登入）。
 * 啟用時首頁才顯示 Google 登入入口，且 Google 登入免兩階段驗證（由 Google 把關）；
 * 帳密登入不受此開關影響，仍照常檢查使用者設定的兩階段驗證。
 * 欄位缺漏＝停用（fail-closed）。
 */
export async function isGoogleOAuthEnabled(): Promise<boolean> {
  const raw = await readSystemDoc();
  return typeof raw?.oauthEnabled === "boolean" ? raw.oauthEnabled : defaultSettings.oauthEnabled;
}

/**
 * 讀取 settings.sessionTimeout（分鐘），供伺服器端閒置逾時檢查使用。
 * 讀同一份 settings/system 快取；欄位缺漏或值無效時回預設值。
 */
export async function getSessionTimeoutMinutes(): Promise<number> {
  const raw = await readSystemDoc();
  const minutes = Number(raw?.sessionTimeout);
  return Number.isFinite(minutes) && minutes >= 1 ? minutes : defaultSettings.sessionTimeout;
}

/**
 * 讀取 settings.cacheTtlSeconds（清單類快取壽命，秒）。
 * 主程式與所有功能模組統一使用：`cachedListRead` 預設 TTL 與模組名單快取皆由此取得。
 * 讀同一份 settings/system 快取；欄位缺漏、非有限數或超出 30–300 範圍時自動夾到合法值。
 */
export async function getCacheTtlSeconds(): Promise<number> {
  const raw = await readSystemDoc();
  return clampCacheTtlSeconds(raw?.cacheTtlSeconds ?? defaultSettings.cacheTtlSeconds);
}

/**
 * 讀取 settings.emailChangeAllowed（是否開放使用者自行變更電子郵件地址）。
 * 讀同一份 settings/system 快取；欄位缺漏＝預設開放。
 */
export async function isEmailChangeAllowed(): Promise<boolean> {
  const raw = await readSystemDoc();
  return typeof raw?.emailChangeAllowed === "boolean"
    ? raw.emailChangeAllowed
    : defaultSettings.emailChangeAllowed;
}

/**
 * 讀取識別名稱用的三個欄位：系統（程式）自命名、學校全稱、學校簡稱。
 * 讀同一份 settings/system 快取；欄位缺漏時回空字串。
 */
async function readIdentity(): Promise<{
  systemName: string;
  schoolFullName: string;
  schoolShortName: string;
}> {
  const raw = await readSystemDoc();
  const schoolFullName = typeof raw?.schoolFullName === "string" ? raw.schoolFullName.trim() : "";
  const schoolShortName = typeof raw?.schoolShortName === "string" ? raw.schoolShortName.trim() : "";
  const systemName = typeof raw?.systemName === "string" ? raw.systemName.trim() : "";
  return { systemName, schoolFullName, schoolShortName };
}

/**
 * 目前學年度與學期（settings.system 的 academicYear／semester）。
 * 身分名冊（roster 集合）寫入與讀取都以這個期間為準，讀同一份 settings/system 快取；
 * 欄位缺漏或讀失敗時回退依日期推算的值。
 */
export async function getCurrentPeriod(): Promise<SchoolPeriod> {
  const raw = await readSystemDoc();
  const fallback = detectPeriod();
  const academicYear = Number(raw?.academicYear);
  const semester = Number(raw?.semester);
  return {
    academicYear:
      Number.isFinite(academicYear) && academicYear > 0 ? academicYear : fallback.academicYear,
    semester: semester === 1 || semester === 2 ? semester : fallback.semester,
  };
}

/**
 * 驗證碼APP（TOTP）的發行者名稱，顯示為「系統名稱-學校簡稱：帳號」。
 * 學校簡稱未填時退用學校全稱，兩者都沒填時只顯示系統名稱。
 */
export async function getTotpIssuer(): Promise<string> {
  const { systemName, schoolFullName, schoolShortName } = await readIdentity();
  const system = systemName || DEFAULT_SYSTEM_NAME;
  const school = schoolShortName || schoolFullName;
  return school ? `${system}-${school}` : system;
}

/**
 * 取得信件抬頭用的識別名稱：
 * systemName 一律有值（未自命名時用預設系統名稱），schoolFullName 可為空。
 * 信件以「系統名稱｜學校名稱」併列，讓收件人知道信件來自哪一個程式系統。
 */
export async function getMailIdentity(): Promise<{
  systemName: string;
  schoolFullName: string;
}> {
  const { systemName, schoolFullName } = await readIdentity();
  return { systemName: systemName || DEFAULT_SYSTEM_NAME, schoolFullName };
}
