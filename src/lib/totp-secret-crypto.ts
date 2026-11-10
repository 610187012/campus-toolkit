import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "crypto";

/**
 * TOTP 密鑰的靜態加密（P0-5）。
 *
 * 目的：Firestore 只存密文，資料庫外洩時無法直接拿去產生驗證碼。
 *
 * 金鑰來源（優先序）：
 * 1. `TOTP_ENCRYPTION_KEY`：32 bytes 的 base64／base64url。建議正式環境使用，
 *    可獨立輪替，不必動到 `SESSION_SECRET`。
 * 2. 未設定時，由 `SESSION_SECRET` 以 HKDF-SHA256 派生（info 固定）。
 *
 * 格式：`enc:v1:<iv>:<ciphertext>:<tag>`（皆為 base64url）。
 * 沒有 `enc:v1:` 前缀的值視為舊版明文，讀取時照常使用，成功驗證後再遷移。
 *
 * 注意：更換金鑰後舊密文無法解密；請在更換前先讓使用者重新產生 TOTP 密鑰，
 * 或保留舊金鑰（本版尚未實作多金鑰輪替）。
 */

const ENC_PREFIX = "enc:v1:";
const HKDF_SALT = Buffer.from("campus-toolkit/totp-secret", "utf8");
const HKDF_INFO = Buffer.from("totp-secret-aes-256-gcm-v1", "utf8");
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

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

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const explicit = process.env.TOTP_ENCRYPTION_KEY;
  if (explicit) {
    const key = decodeKey(explicit);
    if (!key) {
      throw new Error("TOTP_ENCRYPTION_KEY 必須是 32 bytes 的 base64／base64url");
    }
    cachedKey = key;
    return key;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET 未設定或長度不足 32 字元");
  }
  const derived = hkdfSync(
    "sha256",
    Buffer.from(sessionSecret, "utf8"),
    HKDF_SALT,
    HKDF_INFO,
    KEY_BYTES
  );
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

/** 是否為本版加密格式（供遷移判斷） */
export function isEncryptedTotpSecret(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/** 加密 TOTP 密鑰；空字串維持空字串。 */
export function encryptTotpSecret(plaintext: string): string {
  if (!plaintext) return "";
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString("base64url")}:${ciphertext.toString(
    "base64url"
  )}:${tag.toString("base64url")}`;
}

/**
 * 解密 TOTP 密鑰。
 *
 * - 空白／非字串 → 空字串
 * - 舊版明文（沒有前缀）→ 原樣回傳，讓既有使用者無痛遷移
 * - 密文解密失敗 → 空字串（記錄錯誤，不拋例外，避免登入流程 500）
 */
export function decryptTotpSecret(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (!value.startsWith(ENC_PREFIX)) return value;

  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) {
    console.error("[totp] TOTP 密鑰格式無效，無法解密");
    return "";
  }

  try {
    const [ivPart, cipherPart, tagPart] = parts;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getKey(),
      Buffer.from(ivPart, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(cipherPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return plaintext;
  } catch (error) {
    // 不記錄任何密文或金鑰內容
    console.error(
      "[totp] TOTP 密鑰解密失敗（金鑰可能已更換，需重新產生密鑰）",
      error instanceof Error ? error.message : ""
    );
    return "";
  }
}
