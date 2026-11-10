import "server-only";
import { createHash, randomBytes } from "crypto";
import type { DocumentReference, DocumentData } from "firebase-admin/firestore";
import { verifyTotpCode, generateTotpSecret } from "@/lib/totp";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  isEncryptedTotpSecret,
} from "@/lib/totp-secret-crypto";
import { isMailConfigured, sendLoginOtpEmail, sendLoginNotificationEmail } from "@/lib/mailer";
import { getMailIdentity } from "@/lib/settings-server";
import { normalizeEmail } from "@/lib/validation";
import { ROLE_LABELS, TwoFactorMethod, UserRole } from "@/types/users";

/**
 * 兩階段驗證服務層（與舊 GAS 站 auth.js 對齊）：
 * - Email OTP：6 位數、10 分鐘效期、同一用戶 120 秒節流、驗證碼只存 sha256
 * - TOTP：RFC 6238 T±1、90 秒防重放
 * - 以上驗證都必須完成後才建立 session（見 /api/auth/2fa）
 */

export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
export const EMAIL_OTP_TTL_MINUTES = EMAIL_OTP_TTL_MS / 60_000;
export const EMAIL_OTP_COOLDOWN_MS = 120 * 1000;
export const TOTP_REPLAY_MS = 90 * 1000;
/** 驗證碼長度（Gas：100000-999999） */
const OTP_LENGTH = 6;

/** 失敗次數門檻：達上限直接拒絕該用戶（與帳號鎖定分開計數） */
export const TWO_FACTOR_MAX_ATTEMPTS = 5;
export const TWO_FACTOR_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

interface AttemptBucket {
  count: number;
  resetAt: number;
}
const attempts = new Map<string, AttemptBucket>();

export function checkTwoFactorAttempt(key: string): boolean {
  const now = Date.now();
  const bucket = attempts.get(key);
  if (!bucket || bucket.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + TWO_FACTOR_ATTEMPT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= TWO_FACTOR_MAX_ATTEMPTS) return false;
  bucket.count += 1;
  return true;
}

export function resetTwoFactorAttempts(key: string): void {
  attempts.delete(key);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 遮蔽電子郵件（回第二階段驗證頁顯示「驗證碼寄到哪裡」，仍保留足夠辨識度） */
export function maskEmail(email: unknown): string {
  if (typeof email !== "string" || !email.includes("@")) return "";
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, Math.min(2, local.length));
  const hidden = "*".repeat(Math.max(1, local.length - head.length));
  return `${head}${hidden}@${domain}`;
}

/** 產生 6 位數 OTP（100000-999999，避免前導零造成使用者輸入困擾） */
export function generateOtp(): string {
  const code = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(100000 + (code % 900000));
}

export interface TwoFactorProfile {
  method: TwoFactorMethod;
  /** TOTP Base32 密鑰（已解密；method !== "totp" 時可能為空） */
  totpSecret: string;
}

export function readTwoFactorProfile(data: DocumentData | undefined): TwoFactorProfile {
  const raw = data?.twoFactor;
  const method: TwoFactorMethod =
    raw === "email_notify" || raw === "email_otp" || raw === "totp" ? raw : "off";
  const secret = decryptTotpSecret(data?.totpSecret);
  return { method, totpSecret: secret };
}

/** 讀取並產生 TOTP 密鑰（首次啟用驗證碼APP時呼叫，加密後寫回文件） */
export async function ensureTotpSecret(
  ref: DocumentReference,
  data: DocumentData
): Promise<string> {
  const stored = data?.totpSecret;
  const existing = decryptTotpSecret(stored);
  if (existing) {
    // 舊版明文：下次使用時順手遷移成密文
    if (typeof stored === "string" && !isEncryptedTotpSecret(stored)) {
      await ref.set({ totpSecret: encryptTotpSecret(existing) }, { merge: true });
    }
    return existing;
  }
  const secret = generateTotpSecret();
  await ref.set({ totpSecret: encryptTotpSecret(secret) }, { merge: true });
  return secret;
}

/** 重新產生 TOTP 密鑰（使用者手動觸發，舊密鑰立即失效） */
export async function rotateTotpSecret(ref: DocumentReference): Promise<string> {
  const secret = generateTotpSecret();
  await ref.set(
    {
      totpSecret: encryptTotpSecret(secret),
      totpLastCode: "",
      totpLastUsedAt: 0,
    },
    { merge: true }
  );
  return secret;
}

/** Email OTP：寫入一次性驗證碼（只存 hash） */
export async function writeEmailOtp(ref: DocumentReference): Promise<string> {
  const code = generateOtp();
  const uid = ref.id;
  await ref.set(
    {
      otpHash: sha256(`${uid}:${code}`),
      otpExpiresAt: Date.now() + EMAIL_OTP_TTL_MS,
      otpSentAt: Date.now(),
    },
    { merge: true }
  );
  return code;
}

export type OtpSendResult = "sent" | "cooldown" | "smtp";

/**
 * 寄送 Email OTP。同一用戶 120 秒內只能請求一次（GAS eotp_req_ 節流）。
 * 回傳 cooldown 時不重新寄信，讓使用者等待既有驗證碼。
 */
export async function sendEmailOtp(options: {
  ref: DocumentReference;
  data: DocumentData;
  email: string;
  displayName: string;
  account: string;
  role: UserRole;
}): Promise<OtpSendResult> {
  const now = Date.now();
  const sentAt = typeof options.data?.otpSentAt === "number" ? options.data.otpSentAt : 0;
  if (sentAt && now - sentAt < EMAIL_OTP_COOLDOWN_MS) return "cooldown";

  // 寄信不可用時不寫入驗證碼：寫了也沒人收得到，只會把使用者卡死在驗證頁
  if (!isMailConfigured()) return "smtp";
  // 電子郵件地址留空／格式無效（帳號與安全頁允許清空）時沒有收件人：
  // 同樣 fail-open 略過驗證，避免把自己鎖在門外
  if (!normalizeEmail(options.email)) return "smtp";

  const code = await writeEmailOtp(options.ref);

  try {
    const { systemName, schoolFullName } = await getMailIdentity();
    await sendLoginOtpEmail({
      to: options.email,
      displayName: options.displayName || options.account,
      code,
      systemName,
      schoolName: schoolFullName,
      roleLabel: ROLE_LABELS[options.role],
      expiresInMinutes: EMAIL_OTP_TTL_MINUTES,
    });
    return "sent";
  } catch (error) {
    console.error("[2fa] Email OTP 寄送失敗:", error);
    // 寄信失敗就把剛寫入的驗證碼清掉（含節流時間），下次請求可立即重寄，
    // 避免使用者拿著一封沒寄到的信被 120 秒節流卡住
    await options.ref.set({ otpHash: "", otpExpiresAt: 0, otpSentAt: 0 }, { merge: true });
    return "smtp";
  }
}

/** 驗證 Email OTP（成功即清除一次性資料） */
export function verifyEmailOtp(
  data: DocumentData,
  uid: string,
  code: unknown
): boolean {
  if (typeof code !== "string") return false;
  const normalized = code.trim();
  if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(normalized)) return false;

  const hash = typeof data?.otpHash === "string" ? data.otpHash : "";
  const expiresAt = typeof data?.otpExpiresAt === "number" ? data.otpExpiresAt : 0;
  if (!hash || !expiresAt || expiresAt < Date.now()) return false;
  return hash === sha256(`${uid}:${normalized}`);
}

/** 驗證 TOTP（含 90 秒防重放）；成功即記錄已使用代碼 */
export async function verifyTotpWithReplay(
  ref: DocumentReference,
  data: DocumentData,
  code: unknown
): Promise<boolean> {
  const stored = data?.totpSecret;
  const secret = decryptTotpSecret(stored);
  if (!secret) return false;
  if (!verifyTotpCode(secret, code)) return false;

  const normalized = String(code).trim();
  const lastCode = typeof data?.totpLastCode === "string" ? data.totpLastCode : "";
  const lastUsedAt = typeof data?.totpLastUsedAt === "number" ? data.totpLastUsedAt : 0;
  const withinReplay = lastCode === normalized && Date.now() - lastUsedAt < TOTP_REPLAY_MS;
  if (withinReplay) return false;

  await ref.set(
    {
      // 舊版明文在成功驗證後遷移成密文
      ...(isEncryptedTotpSecret(stored)
        ? {}
        : { totpSecret: encryptTotpSecret(secret) }),
      totpLastCode: normalized,
      totpLastUsedAt: Date.now(),
    },
    { merge: true }
  );
  return true;
}

/** 驗證成功後清除 OTP 暫存資料（避免殘留可重用紀錄） */
export async function clearOtpState(ref: DocumentReference): Promise<void> {
  await ref.set(
    { otpHash: "", otpExpiresAt: 0 },
    { merge: true }
  );
}

/** 寄送登入通知信（best-effort，失敗不阻擋登入） */
export async function sendLoginNotification(options: {
  email: string;
  displayName: string;
  account: string;
  role: UserRole;
}): Promise<void> {
  if (!isMailConfigured()) return;
  try {
    const { systemName, schoolFullName } = await getMailIdentity();
    await sendLoginNotificationEmail({
      to: options.email,
      displayName: options.displayName || options.account,
      systemName,
      schoolName: schoolFullName,
      roleLabel: ROLE_LABELS[options.role],
      time: new Date(),
    });
  } catch (error) {
    console.error("[2fa] 登入通知信寄送失敗:", error);
  }
}
