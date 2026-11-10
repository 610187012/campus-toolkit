import "server-only";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/session-token";

const REVOKED_COLLECTION = "revokedJTIs";
const PURGE_INTERVAL_MS = 60 * 60_000;
const PURGE_BATCH = 100;

let lastPurgeAt = 0;

/**
 * 清理已過期的撤銷紀錄（expiresAt = 撤銷時的 JWT 到期時間）。
 * Firestore TTL 政策需在主控台另行設定，此處為程式面的機會式清理。
 */
export async function purgeExpiredRevocations(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = now;
  try {
    const snap = await getAdminDbRaw()
      .collection(REVOKED_COLLECTION)
      .where("expiresAt", "<", now)
      .limit(PURGE_BATCH)
      .get();
    if (snap.empty) return;
    const batch = getAdminDbRaw().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  } catch (error) {
    console.error("Purge revoked JTIs error:", error);
  }
}

export async function revokeJti(jti: string): Promise<void> {
  if (!jti) return;
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  await getAdminDbRaw().collection(REVOKED_COLLECTION).doc(jti).set({
    jti,
    revokedAt: Date.now(),
    expiresAt,
  });
  // 機會式清理過期撤銷紀錄（不阻塞登出流程失敗）
  void purgeExpiredRevocations(true);
}

export async function isJtiRevoked(jti: string): Promise<boolean> {
  // fail-closed：無 jti 或查詢失敗一律視為已撤銷，避免失效 token 續用
  if (!jti) return true;
  void purgeExpiredRevocations();
  try {
    const snap = await getAdminDbRaw().collection(REVOKED_COLLECTION).doc(jti).get();
    if (!snap.exists) return false;
    const data = snap.data();
    const expiresAt = typeof data?.expiresAt === "number" ? data.expiresAt : 0;
    if (expiresAt && Date.now() > expiresAt) return false;
    return true;
  } catch (error) {
    console.error("JTI revocation check error:", error);
    return true;
  }
}
