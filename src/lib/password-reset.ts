import "server-only";
import { createHash, randomBytes } from "crypto";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import { UserRole } from "@/types/users";

/**
 * 密碼重設一次性連結。
 * - token：32 bytes 隨機（base64url），只在產生當下出現一次，資料庫僅存 sha256(token)
 * - 有效期：10 分鐘（PASSWORD_RESET_TTL_MS），逾時即失效
 * - 一次性：以 Firestore transaction 標記 usedAt，重複使用回「已使用過」
 * - 同一用戶重新申請時，舊連結立刻失效（只保留最新一封信）
 * 客戶端一律無法存取此 collection（firestore.rules 預設拒絕）。
 */

export const PASSWORD_RESET_TTL_MS = 10 * 60 * 1000;
export const PASSWORD_RESET_TTL_MINUTES = PASSWORD_RESET_TTL_MS / 60_000;

const COLLECTION = "passwordResetTokens";

export interface PasswordResetRequest {
  uid: string;
  role: UserRole;
  email: string;
  displayName?: string;
}

export interface CreatedPasswordResetToken extends PasswordResetRequest {
  token: string;
  expiresAt: number;
}

export type ResetTokenStatus = "ok" | "invalid" | "expired" | "used";

export interface ResetTokenRecord extends PasswordResetRequest {
  expiresAt: number;
  usedAt: number;
  createdAt: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  // base64url(32 bytes) = 43 字元；留餘裕並擋住超長輸入
  if (!trimmed || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * 產生並儲存重設 token。
 * 同時刪除：① 該用戶既有的舊連結 ② 已過期的文件（無 TTL policy 時的機械式清理）
 */
export async function createPasswordResetToken(
  request: PasswordResetRequest,
  requestIp = ""
): Promise<CreatedPasswordResetToken> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const now = Date.now();
  const expiresAt = now + PASSWORD_RESET_TTL_MS;

  const db = getAdminDbRaw();
  const col = db.collection(COLLECTION);
  const batch = db.batch();
  const touched = new Set<string>();

  const superseded = await col.where("uid", "==", request.uid).limit(20).get();
  for (const doc of superseded.docs) {
    if (touched.has(doc.id)) continue;
    touched.add(doc.id);
    batch.delete(doc.ref);
  }

  const expired = await col.where("expiresAt", "<", now).limit(20).get();
  for (const doc of expired.docs) {
    if (touched.has(doc.id)) continue;
    touched.add(doc.id);
    batch.delete(doc.ref);
  }

  batch.set(col.doc(tokenHash), {
    uid: request.uid,
    role: request.role,
    email: request.email,
    displayName: request.displayName || "",
    requestIp,
    createdAt: now,
    expiresAt,
    usedAt: 0,
  });

  await batch.commit();

  return { ...request, token, expiresAt };
}

/** 不消耗 token，僅供重設頁在使用者輸入密碼前先確認連結是否有效 */
export async function inspectPasswordResetToken(
  token: unknown
): Promise<{ status: ResetTokenStatus; record?: ResetTokenRecord }> {
  const normalized = normalizeToken(token);
  if (!normalized) return { status: "invalid" };

  const snap = await getAdminDbRaw()
    .collection(COLLECTION)
    .doc(sha256(normalized))
    .get();

  if (!snap.exists) return { status: "invalid" };
  const data = snap.data() as ResetTokenRecord | undefined;
  if (!data) return { status: "invalid" };
  if (data.usedAt > 0) return { status: "used", record: data };
  if (typeof data.expiresAt !== "number" || data.expiresAt <= Date.now()) {
    return { status: "expired", record: data };
  }
  return { status: "ok", record: data };
}

/**
 * 消耗 token（transaction 確保同一 token 只能成功一次）。
 * 成功時回傳 token 所屬用戶；否則回傳失敗狀態。
 */
export async function consumePasswordResetToken(
  token: unknown
): Promise<{ status: ResetTokenStatus; record?: ResetTokenRecord }> {
  const normalized = normalizeToken(token);
  if (!normalized) return { status: "invalid" };

  const db = getAdminDbRaw();
  const ref = db.collection(COLLECTION).doc(sha256(normalized));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { status: "invalid" as const };

    const data = snap.data() as ResetTokenRecord | undefined;
    if (!data) return { status: "invalid" as const };
    if (data.usedAt > 0) return { status: "used" as const, record: data };
    if (typeof data.expiresAt !== "number" || data.expiresAt <= Date.now()) {
      // 逾時：順手清除，避免過期文件堆積
      tx.delete(ref);
      return { status: "expired" as const, record: data };
    }

    tx.update(ref, { usedAt: Date.now() });
    return { status: "ok" as const, record: data };
  });
}
