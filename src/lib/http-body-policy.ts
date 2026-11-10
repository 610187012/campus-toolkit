/**
 * API request body 大小限制的純政策（P0-4）。
 *
 * 零依賴，供 `http-body.ts`、模組 runtime 與測試共用。
 * 目的：在讀取（`request.json()`／`request.formData()`）之前先依
 * Content-Length／Content-Type 擋掉明顯過大的請求，避免整包內容被
 * 緩衝進記憶體造成 DoS。
 */

/** JSON 預設上限：1 MiB（一般表單／設定／批次選取都遠小於此）。 */
export const DEFAULT_JSON_BODY_BYTES = 1_048_576;

/** multipart／檔案上傳預設上限：25 MiB（模組 zip 另有自己的更嚴上限）。 */
export const DEFAULT_FORM_BODY_BYTES = 25 * 1024 * 1024;

/** 其他文字型內容預設上限：1 MiB。 */
export const DEFAULT_OTHER_BODY_BYTES = 1_048_576;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface BodyLimitInput {
  method: string;
  contentType: string | null;
  contentLength: string | null;
  transferEncoding: string | null;
  jsonMaxBytes?: number;
  formMaxBytes?: number;
  otherMaxBytes?: number;
}

export type BodyLimitDecision =
  | { ok: true; maxBytes: number }
  | { ok: false; reason: "too-large" | "unknown-length"; maxBytes: number };

/** 依 Content-Type 決定這個請求適用的上限。 */
export function maxBytesForContentType(
  contentType: string | null,
  overrides: Pick<BodyLimitInput, "jsonMaxBytes" | "formMaxBytes" | "otherMaxBytes"> = {}
): number {
  const jsonMax = overrides.jsonMaxBytes ?? DEFAULT_JSON_BODY_BYTES;
  const formMax = overrides.formMaxBytes ?? DEFAULT_FORM_BODY_BYTES;
  const otherMax = overrides.otherMaxBytes ?? DEFAULT_OTHER_BODY_BYTES;
  const mime = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

  if (mime === "multipart/form-data") return formMax;
  if (mime === "application/json" || mime.endsWith("+json")) return jsonMax;
  // 二進位或其他型別多半是檔案上傳；仍給一個硬上限，避免無上限緩衝。
  if (!mime) return jsonMax;
  if (mime.startsWith("text/") || mime === "application/x-www-form-urlencoded") {
    return otherMax;
  }
  return formMax;
}

/** 解析 Content-Length；格式不合法回 null（呼叫端應 fail-closed）。 */
export function parseContentLength(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * 判斷請求是否應在讀取前被拒絕。
 *
 * - 沒有 body 的方法 → 直接放行。
 * - 有 Content-Length → 超過上限即拒絕。
 * - 沒有 Content-Length 且使用 chunked → 拒絕（無法在讀取前確認大小，fail-closed）。
 * - 沒有 Content-Length 也沒有 chunked → 視為無 body 放行。
 */
export function evaluateBodyLimit(input: BodyLimitInput): BodyLimitDecision {
  const method = input.method.toUpperCase();
  const maxBytes = maxBytesForContentType(input.contentType, input);

  if (!BODY_METHODS.has(method)) return { ok: true, maxBytes };

  const declared = parseContentLength(input.contentLength);
  if (declared !== null) {
    return declared > maxBytes
      ? { ok: false, reason: "too-large", maxBytes }
      : { ok: true, maxBytes };
  }
  // Content-Length 有值但格式不合法（非數字／負數）→ fail-closed
  if (input.contentLength !== null) {
    return { ok: false, reason: "too-large", maxBytes };
  }

  const transferEncoding = (input.transferEncoding ?? "").toLowerCase();
  if (transferEncoding.includes("chunked")) {
    return { ok: false, reason: "unknown-length", maxBytes };
  }

  return { ok: true, maxBytes };
}
