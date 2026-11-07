import "server-only";
import crypto from "node:crypto";

/**
 * 模組套件簽章的信任根（P0-6）。
 *
 * - 公鑰來源：環境變數 `MODULE_MARKET_TRUSTED_KEYS`（JSON：moduleId -> base64 SPKI 公鑰或公鑰陣列）。
 * - `publicKey` 由安裝請求／市集提供時，必須先比對釘選清單；不是信任清單內的 key 一律拒絕。
 * - 未提供簽章時：預設放行（v1 相容）；`MODULE_MARKET_REQUIRE_SIGNATURE=1` 時拒絕。
 * - 簽章格式：ed25519，對 zip 的 sha256（hex 解碼後 bytes）簽章，與 `scripts/module-sign.mjs` 一致。
 */

export interface ModuleSignatureInput {
  moduleId: string;
  /** 套件 sha256（64 碼小寫 hex） */
  sha256: string;
  signature?: string;
  publicKey?: string;
}

export interface ModuleSignatureResult {
  ok: boolean;
  signed: boolean;
  reason?: string;
}

/**
 * 官方 E／F／G 的簽章公鑰（takan003 官方 key）。
 * 公鑰不是秘密；內建可讓學校零設定驗證官方模組。
 * 換鑰／撤銷需隨主程式版本更新；其他作者仍走 MODULE_MARKET_TRUSTED_KEYS。
 */
const OFFICIAL_MODULE_PUBLIC_KEY =
  "MCowBQYDK2VwAyEA/bIHYBb7hUie/fguMoXJ2vltikMkN+CPIyVZ5UbCwHE=";
const BUILTIN_TRUSTED_KEYS: Record<string, string[]> = {
  examRegistration: [OFFICIAL_MODULE_PUBLIC_KEY],
  selfDirectedLearning: [OFFICIAL_MODULE_PUBLIC_KEY],
  identityTaxInquiry: [OFFICIAL_MODULE_PUBLIC_KEY],
};

/** 是否要求所有套件都必須有簽章（預設 false，兼容既有未簽章套件） */
export function isModuleSignatureRequired(): boolean {
  const raw = process.env.MODULE_MARKET_REQUIRE_SIGNATURE?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** 讀取釘選公鑰：moduleId -> base64 SPKI 公鑰清單 */
export function readTrustedModuleKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const [moduleId, list] of Object.entries(BUILTIN_TRUSTED_KEYS)) {
    keys.set(moduleId, [...list]);
  }
  const raw = process.env.MODULE_MARKET_TRUSTED_KEYS?.trim();
  if (!raw) return keys;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error("MODULE_MARKET_TRUSTED_KEYS 解析失敗，視為沒有信任金鑰：", error);
    return keys;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return keys;

  for (const [moduleId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(moduleId)) continue;
    const list = (Array.isArray(value) ? value : [value]).filter(
      (item): item is string => typeof item === "string" && item.trim() !== ""
    );
    if (list.length > 0) {
      keys.set(moduleId, [...(keys.get(moduleId) ?? []), ...list.map((item) => item.trim())]);
    }
  }
  return keys;
}

function fail(reason: string, signed = true): ModuleSignatureResult {
  return { ok: false, signed, reason };
}

/** 驗證套件簽章；publicKey 必須是釘選清單內的 key */
export function verifyModuleArchiveSignature(input: ModuleSignatureInput): ModuleSignatureResult {
  const signature = input.signature?.trim() ?? "";
  const publicKey = input.publicKey?.trim() ?? "";

  if (!signature && !publicKey) {
    if (isModuleSignatureRequired()) {
      return fail("此部署要求套件簽章，但市集未提供 signature／publicKey", false);
    }
    return { ok: true, signed: false };
  }
  if (!signature || !publicKey) {
    return fail("signature 與 publicKey 必須同時提供");
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    return fail("套件 sha256 格式錯誤");
  }

  const trusted = readTrustedModuleKeys().get(input.moduleId) ?? [];
  if (trusted.length === 0) {
    return fail(`模組「${input.moduleId}」沒有釘選公鑰，拒絕簽章套件`);
  }

  let providedDer: Buffer;
  try {
    providedDer = Buffer.from(publicKey, "base64");
  } catch {
    return fail("publicKey 不是合法 base64");
  }
  if (providedDer.length === 0) return fail("publicKey 不是合法 base64");

  const pinned = trusted.some((item) => {
    const der = Buffer.from(item, "base64");
    return der.length > 0 && der.equals(providedDer);
  });
  if (!pinned) return fail("publicKey 不在釘選信任清單");

  try {
    const key = crypto.createPublicKey({ key: providedDer, format: "der", type: "spki" });
    const valid = crypto.verify(
      null,
      Buffer.from(input.sha256, "hex"),
      key,
      Buffer.from(signature, "base64")
    );
    if (!valid) return fail("套件簽章驗證失敗（來源不符）");
  } catch {
    return fail("套件簽章驗證失敗（金鑰或簽章格式錯誤）");
  }

  return { ok: true, signed: true };
}
