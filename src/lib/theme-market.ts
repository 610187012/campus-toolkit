/**
 * 主題市集伺服器端共用工具（比照模組市集 install/route.ts 的安全檢查模式）。
 *
 * 職責（協議 docs/PROTOCOL.md §6）：
 * - 市集來源 URL 解析（https 唯一，dev 例外放行 localhost）
 * - downloadUrl 安全檢查（hostname 必須與市集來源一致，防 SSRF）
 * - theme.json manifest 驗證
 * - styles.css token 白名單與值安全驗證
 * - minHostVersion 比較（主程式版本取自 src/version.json）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { readSystemDoc } from "@/lib/settings-server";
import { THEME_COLOR_KEYS, REQUIRED_MARKET_THEME_KEYS } from "@/types/theme";
import { parseThemeMarketIndex, ThemeMarketIndex } from "@/types/theme-market";
import { defaultTheme } from "@/lib/themes";

export const SUPPORTED_CONTRACT_VERSION = 1;

/** theme.json 上限（bytes） */
export const MAX_THEME_JSON_BYTES = 32 * 1024;

/** styles.css 上限（bytes）：純變數覆寫，遠小於此限 */
export const MAX_CSS_BYTES = 64 * 1024;

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  themeId: string;
  minHostVersion: string;
  author: string;
  description: string;
  preview: string;
  category: string;
  tags: string[];
  contractVersion: number;
  cssFile: string;
}

/**
 * 內建預設市集來源：fork 的學校零設定即可使用主題市集。
 * 環境變數 THEME_MARKET_INDEX_URL / THEME_MARKET_URL 僅供「想指向自己市集」的部署覆寫。
 */
export const DEFAULT_THEME_MARKET_INDEX_URL =
  "https://raw.githubusercontent.com/takan003/campus-toolkit-theme-marketplace/main/index.json";

export const THEME_MARKET_INDEX_URL_FIELD = "themeMarketIndexUrl";

function normalizeThemeMarketUrl(candidate: string): string | null {
  const text = candidate.trim();
  if (!text) return null;

  try {
    const parsed = new URL(text);
    const isLocalhostDev =
      process.env.NODE_ENV === "development" &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");

    if (isLocalhostDev) {
      return parsed.toString();
    }

    if (parsed.protocol !== "https:") {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export async function resolveThemeMarketIndexUrl(): Promise<string | null> {
  const raw = await readSystemDoc();
  const fromSettings =
    typeof raw?.[THEME_MARKET_INDEX_URL_FIELD] === "string" ? raw[THEME_MARKET_INDEX_URL_FIELD] : "";
  const fromEnv = process.env.THEME_MARKET_INDEX_URL?.trim() || process.env.THEME_MARKET_URL?.trim() || "";

  return (
    normalizeThemeMarketUrl(fromSettings) ||
    normalizeThemeMarketUrl(fromEnv) ||
    normalizeThemeMarketUrl(DEFAULT_THEME_MARKET_INDEX_URL) ||
    null
  );
}

export async function resolveThemeMarketHost(): Promise<string | null> {
  const marketUrl = await resolveThemeMarketIndexUrl();
  if (!marketUrl) return null;
  try {
    return new URL(marketUrl).hostname;
  } catch {
    return null;
  }
}

/** downloadUrl 安全檢查：https 唯一（dev localhost 例外）＋主機必須＝市集來源主機 */
export async function assertSafeThemeDownloadUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("downloadUrl 不是合法 URL");
  }

  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const devLocalhostOk =
    process.env.NODE_ENV === "development" && url.protocol === "http:" && isLocalhost;
  if (!devLocalhostOk && url.protocol !== "https:") {
    throw new Error("downloadUrl 僅允許 https（本機開發可允 localhost http）");
  }

  const marketHost = await resolveThemeMarketHost();
  if (!marketHost) {
    throw new Error("尚未設定主題市集來源 URL——無法核對下載來源主機，拒絕安裝");
  }
  if (url.hostname !== marketHost) {
    throw new Error(`downloadUrl 主機「${url.hostname}」與市集來源「${marketHost}」不一致，拒絕安裝`);
  }
  return url;
}

export function readHostVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "src", "version.json"), "utf-8");
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

function versionParts(version: string): number[] {
  return version
    .split(".")
    .map((part) => {
      const digits = part.match(/^\d+/);
      return digits ? Number.parseInt(digits[0], 10) : 0;
    })
    .slice(0, 3);
}

/** current >= min（semver 數值比較，缺段補 0；比對不合法時回 false＝拒絕） */
export function versionAtLeast(current: string, min: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(current) || !/^\d+\.\d+\.\d+$/.test(min)) {
    return false;
  }
  const a = versionParts(current);
  const b = versionParts(min);
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** theme.json manifest 驗證（契約 theme.schema.json ＋ §6-8） */
export function validateThemeManifest(raw: unknown, expectedId: string): ThemeManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("theme.json 格式錯誤");
  }
  const manifest = raw as Record<string, unknown>;

  const id = readString(manifest.id);
  const name = readString(manifest.name);
  const version = readString(manifest.version);
  const themeId = readString(manifest.themeId);
  const minHostVersion = readString(manifest.minHostVersion);
  const author = readString(manifest.author);
  const description = readString(manifest.description) ?? "";
  const preview = readString(manifest.preview);
  const category = readString(manifest.category);
  const cssFile = readString(manifest.cssFile);

  if (!id || !name || !version || !themeId || !minHostVersion || !author || !preview || !cssFile) {
    throw new Error("theme.json 缺少必要欄位（id/name/version/themeId/minHostVersion/author/preview/cssFile）");
  }
  if (id !== expectedId) {
    throw new Error(`theme.json 的 id（${id}）與安裝請求（${expectedId}）不一致，拒絕安裝`);
  }
  if (themeId !== `market:${id}`) {
    throw new Error(`themeId 必須為 market:${id}（實際為 ${themeId}），拒絕安裝`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+\.\d+\.\d+$/.test(minHostVersion)) {
    throw new Error("version / minHostVersion 必須為 semver（x.y.z）");
  }
  if (category !== "theme") {
    throw new Error("category 必須為 theme");
  }
  if (!/^\d+$/.test(String(manifest.contractVersion))) {
    throw new Error("contractVersion 必須為整數");
  }
  const contractVersion = Number.parseInt(String(manifest.contractVersion), 10);
  if (contractVersion !== SUPPORTED_CONTRACT_VERSION) {
    throw new Error(`不支援的 contractVersion（${contractVersion}，本主程式支援 ${SUPPORTED_CONTRACT_VERSION}）`);
  }
  if (!/^[A-Za-z0-9._-]+\.css$/.test(cssFile)) {
    throw new Error(`cssFile 檔名不合法：${cssFile}`);
  }

  const tags = Array.isArray(manifest.tags)
    ? manifest.tags
        .map((tag) => readString(tag))
        .filter((tag): tag is string => tag !== null)
    : [];

  return {
    id,
    name,
    version,
    themeId,
    minHostVersion,
    author,
    description,
    preview,
    category,
    tags,
    contractVersion,
    cssFile,
  };
}

const UNSAFE_VALUE_PATTERN = /[;{}]|url\(|expression\(|@import|<|\\|\*\//i;

/** token 值安全驗證：僅允許安全的 CSS 宣告值（契約 §6-9） */
export function assertSafeThemeColorValue(key: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${key} 的值不得為空`);
  }
  if (trimmed.length > 160) {
    throw new Error(`${key} 的值過長（超過 160 字元）`);
  }
  if (UNSAFE_VALUE_PATTERN.test(trimmed)) {
    throw new Error(`${key} 的值含不允許的構造（分號／花括號／url()/expression() 等），拒絕安裝`);
  }
  if (!/^[\w\s(),.%/#'-]+$/.test(trimmed)) {
    throw new Error(`${key} 的值含不允許的字元，拒絕安裝`);
  }
  return trimmed;
}

/**
 * styles.css token 解析（契約 §5.2/§5.3）：
 * - 必須恰好含一個 html[data-theme="market:{id}"] 區塊，且檔案中不得有其他規則
 * - 鍵必須屬於 THEME_COLOR_KEYS 白名單
 * - 值必須通過 assertSafeThemeColorValue
 */
export function parseThemeCssVariables(css: string, themeId: string): Record<string, string> {
  const escaped = themeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(
    `html\\[data-theme=["']${escaped}["']\\]\\s*\\{([^}]*)\\}`,
    "i"
  );
  const match = blockPattern.exec(css);
  if (!match) {
    throw new Error(`styles.css 缺少 html[data-theme="${themeId}"] 變數區塊，拒絕安裝`);
  }

  const remainder = css.replace(blockPattern, "").trim();
  if (remainder.replace(/\/\*[\s\S]*?\*\//g, "").trim()) {
    throw new Error("styles.css 只允許單一 html[data-theme] 變數覆寫區塊（不得含元件規則），拒絕安裝");
  }

  const body = match[1] ?? "";
  const declarationPattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  const colors: Record<string, string> = {};
  let declared: RegExpExecArray | null;
  while ((declared = declarationPattern.exec(body)) !== null) {
    const key = declared[1]!.toLowerCase();
    if (!(THEME_COLOR_KEYS as readonly string[]).includes(key)) {
      throw new Error(`styles.css 含非白名單 token「${key}」，拒絕安裝（白名單見市集契約 §5.1）`);
    }
    colors[key] = assertSafeThemeColorValue(key, declared[2] ?? "");
  }

  for (const requiredKey of REQUIRED_MARKET_THEME_KEYS) {
    if (!(requiredKey in colors)) {
      throw new Error(`styles.css 缺少必填 token「${requiredKey}」，拒絕安裝`);
    }
  }

  return colors;
}

/* ------------------------------------------------------------------ */
/* 可重用流程：下載、解壓、解析、生成（安裝路由／內容端點／發佈共用）        */
/* ------------------------------------------------------------------ */

/** 主題套件下載上限（bytes，契約 §6-6 建議 5MB） */
export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;

/** 解壓後總大小／檔案數上限（zip slip 與解壓炸彈防護） */
const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 64;

/** token 物件驗證（投稿／發佈 payload 用）：白名單＋必填鍵＋值安全 */
export function validateColorTokens(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("colors 必須為物件（token → 值）");
  }
  const source = raw as Record<string, unknown>;
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase();
    if (!(THEME_COLOR_KEYS as readonly string[]).includes(normalized)) {
      throw new Error(`非白名單 token「${key}」（白名單見市集契約 §5.1）`);
    }
    if (typeof value !== "string") {
      throw new Error(`${key} 的值必須為字串`);
    }
    colors[normalized] = assertSafeThemeColorValue(normalized, value);
  }
  for (const requiredKey of REQUIRED_MARKET_THEME_KEYS) {
    if (!(requiredKey in colors)) {
      throw new Error(`缺少必填 token「${requiredKey}」`);
    }
  }
  return colors;
}

/** 由 token 物件生成 styles.css（契約 §5.2/§5.4，輸出格式固定） */
export function generateThemeCss(themeId: string, colors: Record<string, string>): string {
  const lines = THEME_COLOR_KEYS.filter((key) => colors[key]).map((key) => `  ${key}: ${colors[key]};`);
  return `html[data-theme="${themeId}"] {\n${lines.join("\n")}\n}\n`;
}

function assertInsideDir(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("壓縮檔含路徑穿越（zip slip），拒絕安裝");
  }
}

function walkExtracted(root: string): void {
  let totalBytes = 0;
  let fileCount = 0;

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      assertInsideDir(root, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        fileCount += 1;
        if (fileCount > MAX_EXTRACTED_FILES) {
          throw new Error(`主題包檔案數過多（超過 ${MAX_EXTRACTED_FILES} 個），拒絕安裝`);
        }
        totalBytes += fs.statSync(full).size;
        if (totalBytes > MAX_EXTRACTED_BYTES) {
          throw new Error(`主題包解壓後過大（超過 ${MAX_EXTRACTED_BYTES / 1024 / 1024}MB），拒絕安裝`);
        }
      }
    }
  }

  walk(root);
}

/** 下載主題 zip 並驗證 sha256（含 URL 安全檢查與大小上限） */
export async function downloadThemeZip(
  downloadUrl: string,
  expectedSha256: string
): Promise<{ filePath: string; sha256: string }> {
  const url = await assertSafeThemeDownloadUrl(downloadUrl);
  if (!url.pathname.toLowerCase().endsWith(".zip")) {
    throw new Error("主題下載檔必須為 .zip");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "campus-theme-market-"));
  const filePath = path.join(tempDir, "theme.zip");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal: controller.signal, redirect: "error" });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`下載失敗（HTTP ${response.status}）`);
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`主題套件過大（超過 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB 上限）`);
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`主題套件過大（超過 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB 上限）`);
  }
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(filePath, buffer);

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== expectedSha256.toLowerCase()) {
    throw new Error("套件完整性校驗失敗（sha256 不符）——拒絕安裝");
  }
  return { filePath, sha256 };
}

/** 解壓 zip（含 zip slip／解壓炸彈防護），回傳解壓根目錄 */
export function extractThemeZip(filePath: string): string {
  const dir = path.join(path.dirname(filePath), "extracted");
  fs.mkdirSync(dir, { recursive: true });

  try {
    const zip = new AdmZip(filePath);
    let declaredBytes = 0;
    for (const entry of zip.getEntries()) {
      const name = String(entry.entryName)
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, "");
      if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
        throw new Error(`主題包含非法絕對路徑：${entry.entryName}`);
      }
      if (name.split("/").some((segment) => segment === ".." || segment === "")) {
        throw new Error(`主題包含路徑穿越（zip slip）：${entry.entryName}`);
      }
      const size = Number((entry.header as { size?: unknown } | undefined)?.size ?? 0);
      if (Number.isFinite(size) && size > 0) declaredBytes += size;
      if (declaredBytes > MAX_EXTRACTED_BYTES) {
        throw new Error(`主題包解壓後過大（超過 ${MAX_EXTRACTED_BYTES / 1024 / 1024}MB），拒絕安裝`);
      }
    }
    zip.extractAllTo(dir, true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`ZIP 解壓失敗（adm-zip）：${detail}`);
  }

  walkExtracted(dir);
  return dir;
}

export function findThemeManifestRoot(sourceDir: string): string {
  if (fs.existsSync(path.join(sourceDir, "theme.json"))) return sourceDir;

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(sourceDir, entry.name, "theme.json"))) {
      return path.join(sourceDir, entry.name);
    }
  }

  throw new Error("主題包中未找到 theme.json");
}

export interface LoadedThemePackage {
  manifest: ThemeManifest;
  colors: import("@/types/theme").ThemeColors;
  checksumSha256?: string;
}

/** 讀取並驗證解壓目錄中的主題包（theme.json → manifest、styles.css → colors 以預設補底） */
export function loadThemePackage(
  workingDir: string,
  expectedId: string,
  options: { expectedVersion?: string; checksumSha256?: string } = {}
): LoadedThemePackage {
  const manifestPath = path.join(workingDir, "theme.json");
  const manifestRaw = fs.readFileSync(manifestPath);
  if (manifestRaw.byteLength > MAX_THEME_JSON_BYTES) {
    throw new Error("theme.json 過大（超過 32KB），拒絕安裝");
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw.toString("utf-8").replace(/^﻿/, ""));
  } catch {
    throw new Error("theme.json 無法解析為 JSON");
  }
  const manifest = validateThemeManifest(manifestJson, expectedId);

  if (options.expectedVersion && manifest.version !== options.expectedVersion) {
    throw new Error(
      `主題版本不一致（索引為 ${options.expectedVersion}、套件為 ${manifest.version}）——拒絕安裝`
    );
  }

  const hostVersion = readHostVersion();
  if (!versionAtLeast(hostVersion, manifest.minHostVersion)) {
    throw new Error(
      `主程式版本 ${hostVersion} 低於主題最低需求 ${manifest.minHostVersion}——拒絕安裝`
    );
  }

  const cssPath = path.join(workingDir, manifest.cssFile);
  if (!fs.existsSync(cssPath)) {
    throw new Error(`主題包缺少樣式檔 ${manifest.cssFile}`);
  }
  const cssRaw = fs.readFileSync(cssPath);
  if (cssRaw.byteLength > MAX_CSS_BYTES) {
    throw new Error("styles.css 過大（超過 64KB），拒絕安裝");
  }
  const parsedColors = parseThemeCssVariables(cssRaw.toString("utf-8"), manifest.themeId);

  return {
    manifest,
    colors: { ...defaultTheme.colors, ...parsedColors } as unknown as import("@/types/theme").ThemeColors,
    checksumSha256: options.checksumSha256,
  };
}

/* ------------------------------------------------------------------ */
/* 市集索引快取（內容端點與發佈檢查共用，避免每次請求重抓）                */
/* ------------------------------------------------------------------ */

const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;
let indexCache: { at: number; url: string; index: ThemeMarketIndex } | null = null;

/** 抓取市集索引（5 分鐘記憶體快取；來源不可用時若持有過期快取則降級使用） */
export async function fetchThemeMarketIndex(): Promise<ThemeMarketIndex> {
  const marketUrl = await resolveThemeMarketIndexUrl();
  if (!marketUrl) {
    throw new Error("尚未設定主題市集來源 URL");
  }

  const now = Date.now();
  if (indexCache && indexCache.url === marketUrl && now - indexCache.at < INDEX_CACHE_TTL_MS) {
    return indexCache.index;
  }

  try {
    const response = await fetch(marketUrl, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`市集來源回應失敗（HTTP ${response.status}）`);
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 512 * 1024) {
      throw new Error("市集資料過大");
    }
    const parsed = parseThemeMarketIndex(JSON.parse(text));
    if (!parsed) {
      throw new Error("市集 index.json 缺少有效的 modules 清單");
    }
    indexCache = { at: now, url: marketUrl, index: parsed };
    return parsed;
  } catch (error) {
    if (indexCache && indexCache.url === marketUrl) {
      return indexCache.index;
    }
    throw error;
  }
}
