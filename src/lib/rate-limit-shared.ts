import { createHash } from "crypto";

/**
 * Upstash REST 固定視窗限流的純邏輯（P0-3）。
 *
 * 與 `rate-limit.ts` 分開，方便用假 `fetch` 做單元測試。
 * 這裡不讀 `process.env`，設定由呼叫端傳入。
 */

export interface SharedRateLimitConfig {
  url: string;
  token: string;
}

export interface SharedRateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** 解析 Upstash 設定；缺少任一項回 null（代表不啟用跨實例）。 */
export function parseSharedRateLimitConfig(
  url: string | undefined,
  token: string | undefined
): SharedRateLimitConfig | null {
  const normalizedUrl = url?.trim().replace(/\/+$/, "");
  const normalizedToken = token?.trim();
  if (!normalizedUrl || !normalizedToken) return null;
  return { url: normalizedUrl, token: normalizedToken };
}

/** Redis key 只放雜湊，避免 IP／信箱等識別資料原樣送到外部服務。 */
export function hashRateLimitKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** 固定視窗 key：同一視窗共用一個計數桶。 */
export function buildSharedRateLimitKey(
  now: number,
  windowMs: number,
  key: string
): string {
  return `rl:${Math.floor(now / windowMs)}:${hashRateLimitKey(key)}`;
}

/** 解析 Upstash pipeline 回應的第一個 INCR 結果。 */
export function parsePipelineCount(payload: unknown): number | null {
  if (!Array.isArray(payload)) return null;
  const first = payload[0];
  if (!first || typeof first !== "object") return null;
  const count = Number((first as { result?: unknown }).result);
  if (!Number.isFinite(count) || count < 0) return null;
  return count;
}

/** 依計數產生限流結果；超限時計算到下一個視窗的秒數。 */
export function decideSharedRateLimit(
  count: number,
  limit: number,
  now: number,
  windowMs: number
): SharedRateLimitResult {
  const ok = count <= limit;
  return {
    ok,
    remaining: Math.max(0, limit - count),
    retryAfterSec: ok
      ? 0
      : Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000)),
  };
}

/**
 * 呼叫 Upstash REST pipeline（INCR＋PEXPIRE）。
 *
 * 回傳 null 代表呼叫失敗或回應格式不符；呼叫端應退回進程內結果。
 * 固定視窗的副作用是視窗交界可能允許短暫兩倍流量，對本專案的防護足夠。
 */
export async function checkSharedRateLimit(options: {
  key: string;
  limit: number;
  windowMs: number;
  config: SharedRateLimitConfig;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<SharedRateLimitResult | null> {
  const { key, limit, windowMs, config } = options;
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const redisKey = buildSharedRateLimitKey(now, windowMs, key);
  const ttlMs = Math.max(windowMs * 2, 60_000);

  try {
    const response = await fetchImpl(`${config.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", redisKey],
        ["PEXPIRE", redisKey, String(ttlMs)],
      ]),
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;

    const payload = await response.json();
    const count = parsePipelineCount(payload);
    if (count === null) return null;
    return decideSharedRateLimit(count, limit, now, windowMs);
  } catch {
    // 外部服務失敗不阻擋全站；呼叫端會退回進程內計數
    return null;
  }
}
