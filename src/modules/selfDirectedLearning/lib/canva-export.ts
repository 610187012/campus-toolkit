import "server-only";
import { EncryptJWT, jwtDecrypt, errors } from "jose";
import type { DocumentStyle } from "./document-export";
import { DocumentExportInputError, parseDocumentExport } from "./document-export-input";
import type { PrintPreviewPayload } from "../types/self-directed-learning";

export const CANVA_BASE_PATH = "/api/student/self-directed-learning/canva";
export const CANVA_SCOPE = "design:content:write";
export const CANVA_COOKIE = { state: "sdl_canva_state", token: "sdl_canva_token", job: "sdl_canva_job" };
export const CANVA_TTL = 600;
export const CANVA_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export class CanvaError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export function canvaConfig() {
  const clientId = process.env.CANVA_CLIENT_ID?.trim();
  const clientSecret = process.env.CANVA_CLIENT_SECRET?.trim();
  const redirect = process.env.CANVA_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirect) {
    throw new CanvaError("尚未完成 Canva 串接設定，請洽管理員。", 503);
  }
  const url = new URL(redirect);
  if (url.pathname !== `${CANVA_BASE_PATH}/callback` || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new CanvaError("Canva 回呼網址設定無效，請洽管理員。", 503);
  }
  return { clientId, clientSecret, redirect, origin: url.origin };
}

export function assertCanvaOrigin(request: Request) {
  const expected = new URL(canvaConfig().origin);
  // Next.js 可能將 loopback URL 正規化為 localhost；使用宿主 CSRF 同樣採用的代理標頭。
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
    || new URL(request.url).protocol.slice(0, -1);
  if (host !== expected.host || `${protocol}:` !== expected.protocol) {
    throw new CanvaError(`請使用 ${expected.origin} 開啟網站並重新登入，再匯出至 Canva。`);
  }
}

async function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new CanvaError("伺服器加密設定未完成，請洽管理員。", 503);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sdl-canva-v1:${secret}`)));
}

export async function sealCanva(value: Record<string, unknown>, purpose: string, ttl = CANVA_TTL) {
  const encrypted = await new EncryptJWT(value).setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer("selfDirectedLearning").setAudience(`canva:${purpose}`)
    .setIssuedAt().setExpirationTime(`${ttl}s`).encrypt(await key());
  if (encrypted.length > 3800) throw new CanvaError("Canva 授權資料超過瀏覽器限制，請洽管理員。", 502);
  return encrypted;
}

export async function unsealCanva(value: string | undefined, purpose: string, uid: string) {
  if (!value) throw new CanvaError("Canva 授權已失效，請重新操作。", 401);
  try {
    const { payload } = await jwtDecrypt(value, await key(), {
      issuer: "selfDirectedLearning", audience: `canva:${purpose}`,
      keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
    });
    if (payload.uid !== uid) throw new CanvaError("Canva 授權帳號不符，請重新操作。", 403);
    return payload;
  } catch (error) {
    if (error instanceof errors.JOSEError) throw new CanvaError("Canva 授權已失效，請重新操作。", 401);
    throw error;
  }
}

export function canvaCookieOptions(maxAge = CANVA_TTL) {
  return { httpOnly: true, secure: canvaConfig().origin.startsWith("https:"), sameSite: "lax" as const, path: CANVA_BASE_PATH, maxAge };
}

export async function canvaAuthorization() {
  const config = canvaConfig();
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const url = new URL("https://www.canva.com/api/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: config.clientId, response_type: "code", scope: CANVA_SCOPE,
    code_challenge: challenge, code_challenge_method: "s256", state, redirect_uri: config.redirect,
  }).toString();
  return { verifier, state, url: url.toString() };
}

export async function canvaRequest(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.canva.com/rest/v1/${path}`, {
      ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) {
      throw new CanvaError("無法確認 Canva 處理結果，請先查看 Canva 專案，避免重複匯入。", 502);
    }
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401) throw new CanvaError("Canva 授權已失效，請重新授權。", 401);
    if (response.status === 403) throw new CanvaError("Canva 拒絕存取，請確認應用程式權限與測試使用資格。", 403);
    if (response.status === 429) throw new CanvaError("Canva 使用量已達限制，請稍後再試。", 429);
    throw new CanvaError(`Canva 處理失敗（HTTP ${response.status}），請先查看 Canva 專案再決定是否重試。`, 502);
  }
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new CanvaError("Canva 回應異常，請先查看專案，避免重複匯入。", 502);
    throw error;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function canvaJob(value: unknown): { id: string; status: string; urls: string[] } {
  const job = object(object(value).job);
  if (typeof job.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(job.id) ||
    !["in_progress", "success", "failed"].includes(String(job.status))) {
    throw new CanvaError("Canva 未回傳有效匯入結果，請先查看專案，避免重複匯入。", 502);
  }
  if (job.status === "failed") {
    const code = object(job.error).code;
    if (code === "invalid_file") throw new CanvaError("Canva 無法轉換這份文件，請調整內容後再試。", 422);
    if (code === "duplicate_import") throw new CanvaError("Canva 判定為重複匯入，請先查看自己的專案。", 409);
    throw new CanvaError("Canva 匯入失敗，請稍後再試；重試前請先查看專案。", 502);
  }
  const designs = object(job.result).designs;
  const urls: string[] = [];
  if (job.status === "success") {
    if (!Array.isArray(designs) || !designs.length) throw new CanvaError("Canva 未回傳設計連結，請先查看自己的專案。", 502);
    for (const design of designs) {
      const link = object(object(design).urls).edit_url;
      if (typeof link !== "string") throw new CanvaError("Canva 設計連結無效，請先查看自己的專案。", 502);
      let url: URL;
      try { url = new URL(link); } catch { throw new CanvaError("Canva 設計連結無效，請先查看自己的專案。", 502); }
      if (url.protocol !== "https:" || url.hostname !== "www.canva.com" || url.username || url.password || url.port) {
        throw new CanvaError("Canva 設計連結無效，請先查看自己的專案。", 502);
      }
      urls.push(url.toString());
    }
  }
  return { id: job.id, status: String(job.status), urls };
}

export function parseCanvaExport(value: unknown): { payload: PrintPreviewPayload; style: DocumentStyle } {
  const input = object(value);
  if (input.agreed !== true) throw new CanvaError("請先同意將此次資料傳送至 Canva。");
  try { return parseDocumentExport(input); } catch (error) {
    if (error instanceof DocumentExportInputError) throw new CanvaError(error.message);
    throw error;
  }
}
