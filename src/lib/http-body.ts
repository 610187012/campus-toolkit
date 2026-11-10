import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_JSON_BODY_BYTES,
  evaluateBodyLimit,
  maxBytesForContentType,
  parseContentLength,
} from "@/lib/http-body-policy";

export {
  DEFAULT_FORM_BODY_BYTES,
  DEFAULT_OTHER_BODY_BYTES,
} from "@/lib/http-body-policy";

/**
 * API request body 大小限制（P0-4）。
 *
 * 用法：
 * ```ts
 * const parsed = await readJsonBody<{ id?: unknown }>(request);
 * if (!parsed.ok) return parsed.response;
 * const body = parsed.data;
 * ```
 *
 * `readJsonBody` 會在串流讀取時計數，即使沒有 Content-Length（chunked）
 * 也不會把超過上限的內容整包緩衝進記憶體。
 */

export function bodyTooLargeResponse(): NextResponse {
  return NextResponse.json(
    { success: false, message: "請求內容過大" },
    { status: 413 }
  );
}

function invalidJsonResponse(): NextResponse {
  return NextResponse.json(
    { success: false, message: "請求內容無效" },
    { status: 400 }
  );
}

/**
 * 在讀取 body 前先依 Content-Length／Content-Type 擋掉過大的請求。
 * 適合 `request.formData()` 這類無法自行串流計數的呼叫。
 *
 * @returns 需要拒絕時回傳 413 回應；否則回 null。
 */
export function assertBodySize(
  request: NextRequest,
  maxBytes?: number
): NextResponse | null {
  const limit =
    maxBytes ??
    maxBytesForContentType(request.headers.get("content-type"));
  const declared = parseContentLength(request.headers.get("content-length"));

  // Content-Length 不合法（非數字、負數）時 fail-closed。
  if (request.headers.get("content-length") !== null && declared === null) {
    return bodyTooLargeResponse();
  }
  if (declared !== null) {
    return declared > limit ? bodyTooLargeResponse() : null;
  }

  const decision = evaluateBodyLimit({
    method: request.method,
    contentType: request.headers.get("content-type"),
    contentLength: null,
    transferEncoding: request.headers.get("transfer-encoding"),
    jsonMaxBytes: limit,
  });
  return decision.ok ? null : bodyTooLargeResponse();
}

export type JsonBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/** 串流讀取文字，超過上限回 null（並中止讀取）。 */
async function readLimitedText(
  request: NextRequest,
  maxBytes: number
): Promise<string | null> {
  const stream = request.body;
  if (!stream) return "";

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader 已因取消而釋放
    }
  }
}

/**
 * 讀取 JSON body，並套用大小上限。
 *
 * - 超過上限 → `{ ok: false, response: 413 }`
 * - JSON 格式錯誤 → `{ ok: false, response: 400 }`
 */
export async function readJsonBody<T = unknown>(
  request: NextRequest,
  maxBytes: number = DEFAULT_JSON_BODY_BYTES
): Promise<JsonBodyResult<T>> {
  const limit =
    maxBytes ??
    maxBytesForContentType(request.headers.get("content-type"));

  const declared = parseContentLength(request.headers.get("content-length"));
  if (request.headers.get("content-length") !== null && declared === null) {
    return { ok: false, response: bodyTooLargeResponse() };
  }
  if (declared !== null && declared > limit) {
    return { ok: false, response: bodyTooLargeResponse() };
  }

  const text = await readLimitedText(request, limit);
  if (text === null) {
    return { ok: false, response: bodyTooLargeResponse() };
  }
  if (text.trim() === "") {
    return { ok: false, response: invalidJsonResponse() };
  }

  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, response: invalidJsonResponse() };
  }
}
