/**
 * 沙箱網路政策（P1-9 Phase 2C）。
 *
 * 子程序不能直接連外網；`fetch` 會被 runner 覆寫成 host RPC，
 * 由宿主依 `MODULE_SANDBOX_ALLOWED_HOSTS` 檢查目的地。
 *
 * 純函式，供 host.ts 與測試共用。
 */

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /\.internal$/i,
  /\.local$/i,
];

/** 解析逗號／空白分隔的允許網域清單。 */
export function parseAllowedHosts(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const host = part.trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/** 是否為內網／本機位址（預設拒絕，避免 SSRF）。 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

/** 目的地是否在允許清單內（含子網域）；只接受 https，開發可另允許 localhost http。 */
export function isAllowedSandboxUrl(raw: string, allowedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (!localHttp) return false;
  }
  if (isPrivateHost(url.hostname) && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
  );
}
