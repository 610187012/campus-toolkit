import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { hashPassword } from "@/lib/auth";
import { verifySession } from "@/lib/dal";
import { createSession, getSession, unauthorized } from "@/lib/server-session";
import { revokeJti } from "@/lib/revocation";
import { logActivity, getClientIp } from "@/lib/audit";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { invalidateReadCache, AUTHZ_CACHE_PREFIX } from "@/lib/read-cache";
import { isStrongPassword, PASSWORD_REQUIREMENT_MESSAGE } from "@/lib/validation";
import { USER_COLLECTION } from "@/types/users";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const ip = getClientIp(request);
    const limited = await enforceRateLimitShared(
      request,
      "change-password",
      RATE.CHANGE_PASSWORD.limit,
      RATE.CHANGE_PASSWORD.windowMs
    );
    if (limited) return limited;

    // 不要求目前密碼：自身識別完全依賴 session（同源檢查＋閒置逾時＋改密後撤銷舊 session 把關）
    const parsed = await readJsonBody<{ newPassword?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const { newPassword } = parsed.data;

    if (!newPassword) {
      return NextResponse.json(
        { success: false, message: "請填寫完整資訊" },
        { status: 400 }
      );
    }

    const session = await verifySession();
    if (!session) return unauthorized();

    if (!isStrongPassword(newPassword)) {
      return NextResponse.json(
        { success: false, message: PASSWORD_REQUIREMENT_MESSAGE },
        { status: 400 }
      );
    }

    // 一律以 session.uid 直取自身文件，避免用 body 查詢命中他人文件（IDOR）
    const userDoc = await getAdminDb().collection(USER_COLLECTION).doc(session.uid).get();
    if (!userDoc.exists) {
      return NextResponse.json({ success: false, message: "帳號不存在" }, { status: 404 });
    }

    const userData = userDoc.data()!;

    const passwordHash = await hashPassword(newPassword, 12);
    const newTokenVersion = (userData.tokenVersion || 1) + 1;
    await userDoc.ref.update({
      passwordHash,
      tokenVersion: newTokenVersion,
      failedAttempts: 0,
      lockedUntil: 0,
      lockIp: "",
      // 本人已設定新密碼：解除「首次登入須先改密碼」的全螢幕要求
      mustChangePassword: false,
    });
    // tokenVersion 變更會影響驗證基線比對：本機 authz 快取立即清除
    // （舊 session 另有 jti 撤銷在快取外先把關；跨實例靠 authz TTL 8 秒）
    invalidateReadCache(AUTHZ_CACHE_PREFIX);

    const priorSession = await getSession();
    if (priorSession?.jti) {
      await revokeJti(priorSession.jti);
    }

    await createSession({
      uid: session.uid,
      email: session.email,
      account: session.account,
      displayName: session.displayName,
      role: session.role,
      candidates: session.candidates?.length
        ? session.candidates
        : [{ role: session.role, id: session.uid }],
      tokenVersion: newTokenVersion,
    });

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "password_changed",
      ip,
      details: "密碼已更新，舊 token 已撤銷",
    });

    return NextResponse.json({ success: true, message: "密碼已更新" });
  } catch (error) {
    console.error("Change password error:", error);
    return NextResponse.json({
      success: false,
      message: serverErrorMessage(error, "系統錯誤，請稍後再試"),
    }, { status: 500 });
  }
}
