import "server-only";
import { hkdfSync } from "crypto";

/**
 * 模組專屬密鑰（P1-9 第二階段基礎）。
 *
 * 目的：模組不應該直接讀 `SESSION_SECRET`。宿主用 HKDF 為每個
 * 「模組 × 用途」派生獨立密鑰；即使某個模組的密鑰外洩，也無法偽造
 * session 或解開其他模組的資料。
 *
 * 根金鑰優先序：
 * 1. `MODULE_SECRET_ROOT`（32 bytes base64／base64url）——建議正式環境設定
 * 2. 未設定時由 `SESSION_SECRET` 派生
 *
 * 回傳值是 base64url 字串，可直接當 HMAC／AES 金鑰材料使用。
 */

const SALT = Buffer.from("campus-toolkit/module-secret", "utf8");
const KEY_BYTES = 32;
const INFO_PREFIX = "module-secret-v1:";
const MODULE_VALUE_RE = /^[a-z][A-Za-z0-9]*$/;

let cachedRoot: Buffer | null = null;

function decodeKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (!value) return null;
  for (const encoding of ["base64", "base64url"] as const) {
    try {
      const key = Buffer.from(value, encoding);
      if (key.length === KEY_BYTES) return key;
    } catch {
      // 嘗試下一種編碼
    }
  }
  return null;
}

function rootKey(): Buffer {
  if (cachedRoot) return cachedRoot;

  const explicit = process.env.MODULE_SECRET_ROOT;
  if (explicit) {
    const key = decodeKey(explicit);
    if (!key) {
      throw new Error("MODULE_SECRET_ROOT 必須是 32 bytes 的 base64／base64url");
    }
    cachedRoot = key;
    return cachedRoot;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET 未設定或長度不足 32 字元");
  }
  cachedRoot = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(sessionSecret, "utf8"),
      SALT,
      Buffer.from("root", "utf8"),
      KEY_BYTES
    )
  );
  return cachedRoot;
}

/**
 * 取得模組專屬密鑰。
 *
 * @param moduleValue 模組代碼（camelCase，與 module.json value 相同）
 * @param name 用途名稱（例如 "canva"、"webhook"）；同一模組不同用途會得到不同密鑰
 */
export function moduleSecret(moduleValue: string, name = "default"): string {
  if (!MODULE_VALUE_RE.test(moduleValue)) {
    throw new Error(`模組代碼格式錯誤：${moduleValue || "（空）"}`);
  }
  const purpose = name.trim() || "default";
  const derived = hkdfSync(
    "sha256",
    rootKey(),
    SALT,
    Buffer.from(`${INFO_PREFIX}${moduleValue}:${purpose}`, "utf8"),
    KEY_BYTES
  );
  return Buffer.from(derived).toString("base64url");
}
