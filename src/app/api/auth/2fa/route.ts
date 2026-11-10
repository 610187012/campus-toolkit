import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  clearPending2FACookie,
  createSession,
  getPending2FAPayload,
  setPendingRoleCookie,
} from "@/lib/server-session";
import { getClientIp, logActivity } from "@/lib/audit";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { getCurrentPeriod, isSystemEnabled } from "@/lib/settings-server";
import { ROLE_LABELS, isAccountActive, USER_COLLECTION, UserRole } from "@/types/users";
import {
  EMAIL_OTP_COOLDOWN_MS,
  checkTwoFactorAttempt,
  clearOtpState,
  maskEmail,
  resetTwoFactorAttempts,
  verifyEmailOtp,
  verifyTotpWithReplay,
} from "@/lib/two-factor";
import {
  AccountCandidate,
  AccountHit,
  detectRoleCandidates,
  orderRoles,
} from "@/lib/login-candidate";
import { getRosterEntry, resolveDisplayName } from "@/lib/roster";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

const EXPIRED_MESSAGE = "驗證階段已過期，請重新登入";

function expired() {
  return NextResponse.json(
    { success: false, message: EXPIRED_MESSAGE },
    { status: 401 }
  );
}

/** GET：驗證頁初始化（目前方式、遮蔽信箱、到期時間、可否重送） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "2fa-status",
      RATE.TWO_FA_STATUS.limit,
      RATE.TWO_FA_STATUS.windowMs
    );
    if (limited) return limited;

    const pending = await getPending2FAPayload();
    if (!pending) return expired();

    const snap = await getAdminDb()
      .collection(USER_COLLECTION)
      .doc(pending.uid)
      .get();
    if (!snap.exists) return expired();

    const data = snap.data();
    const sentAt = typeof data?.otpSentAt === "number" ? data.otpSentAt : 0;

    return NextResponse.json(
      {
        success: true,
        method: pending.method,
        roleLabel: ROLE_LABELS[pending.role],
        maskedEmail: maskEmail(pending.email),
        expiresAt: pending.expiresAt,
        resendAt: pending.method === "email_otp" && sentAt ? sentAt + EMAIL_OTP_COOLDOWN_MS : 0,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("2FA status error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** POST：驗證第二階段，成功才建立 session */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "2fa-verify",
      RATE.TWO_FA_VERIFY.limit,
      RATE.TWO_FA_VERIFY.windowMs
    );
    if (limited) return limited;

    const ip = getClientIp(request);
    const pending = await getPending2FAPayload();
    if (!pending) return expired();

    const systemEnabled = await isSystemEnabled();

    // 系統停用時僅管理員可完成登入（與密碼登入一致）
    if (pending.role !== "admin" && !systemEnabled) {
      await clearPending2FACookie();
      return NextResponse.json(
        { success: false, message: "系統目前暫停服務，請稍後再試" },
        { status: 503 }
      );
    }

    const parsed = await readJsonBody<{ code?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const attemptKey = `2fa:${pending.uid}`;
    if (!checkTwoFactorAttempt(attemptKey)) {
      return NextResponse.json(
        { success: false, message: "驗證失敗次數過多，請稍後再試或重新登入" },
        { status: 429, headers: { "Retry-After": "900" } }
      );
    }

    const userRef = getAdminDb().collection(USER_COLLECTION).doc(pending.uid);
    const snap = await userRef.get();
    if (!snap.exists) return expired();
    const userData = snap.data()!;

    const passed =
      pending.method === "email_otp"
        ? verifyEmailOtp(userData, pending.uid, body.code)
        : await verifyTotpWithReplay(userRef, userData, body.code);

    if (!passed) {
      await logActivity({
        userId: pending.uid,
        role: pending.role,
        action: "two_factor_failed",
        ip,
        details:
          pending.method === "email_otp"
            ? "Email OTP 驗證失敗（錯誤或已過期）"
            : "TOTP 驗證失敗（錯誤、已過期或重複使用）",
      });
      return NextResponse.json(
        {
          success: false,
          message:
            pending.method === "email_otp"
              ? "驗證碼錯誤或已過期"
              : "驗證碼錯誤，請確認驗證器 App 的最新代碼",
        },
        { status: 401 }
      );
    }

    // 帳號在等待第二階段期間被停用：驗證碼通過也不建立 session
    if (!isAccountActive(userData)) {
      await clearPending2FACookie();
      await logActivity({
        userId: pending.uid,
        role: pending.role,
        action: "login_failed",
        ip,
        details: "停用帳號完成第二階段驗證，拒絕登入",
      });
      return NextResponse.json(
        { success: false, message: "帳號已停用，無法登入" },
        { status: 401 }
      );
    }

    // 通過：清除 OTP 暫存與失敗計數（中途憑證依下方結果清除）
    await clearOtpState(userRef);
    resetTwoFactorAttempts(attemptKey);

    // 多身分偵測結果與帳密／Google 登入一致：
    // 重新以當期名冊計算有效身分，並限縮在登入時偵測到的候選內（過期中途憑證不可擴張）
    const hit: AccountHit = { id: snap.id, ref: snap.ref, data: userData };
    const fresh = await detectRoleCandidates(hit, { adminsOnly: !systemEnabled });
    const allowed = new Set(pending.candidates?.map((candidate) => candidate.role) ?? []);
    const candidates: AccountCandidate[] = fresh.filter(
      (candidate) => allowed.size === 0 || allowed.has(candidate.role)
    );
    if (candidates.length === 0) return expired();

    const preferred =
      pending.preferred &&
      candidates.some((candidate) => candidate.role === pending.preferred)
        ? pending.preferred
        : null;

    // 多身分且未設定慣用身分：兩階段驗證已完成，登入視為成功，
    // 改以選擇身分專頁決定要進入的身分（切換身分不再驗證第二階段）
    if (!preferred && candidates.length > 1) {
      await clearPending2FACookie();
      await setPendingRoleCookie({
        email: pending.email,
        account: pending.account,
        displayName: pending.displayName,
        via: `${pending.via}+${pending.method}`,
        candidates,
      });
      await logActivity({
        userId: pending.uid,
        role: pending.role,
        action: "two_factor_verified",
        ip,
        details:
          pending.method === "email_otp"
            ? "Email OTP 驗證成功，等待選擇登入身分"
            : "TOTP 驗證成功，等待選擇登入身分",
      });
      return NextResponse.json({
        success: false,
        requiresRoleChoice: orderRoles(candidates.map((candidate) => candidate.role)),
        message: "此帳號具備多個身分，請選擇要登入的身分",
      });
    }

    const role: UserRole = preferred ?? candidates[0].role;

    // 稱謂以「當期該身分名冊的姓名」為準，沒有才退回帳號姓名
    const entry = await getRosterEntry(snap.id, role, await getCurrentPeriod());
    const displayName = resolveDisplayName(userData, entry);

    // 通過：清除中途憑證
    await clearPending2FACookie();

    const now = Date.now();
    const loginRecords = [
      ...((Array.isArray(userData.loginRecords) ? userData.loginRecords : []) as number[]),
      now,
    ].slice(-50);

    await userRef.update({
      failedAttempts: 0,
      lockedUntil: 0,
      lockIp: "",
      lastLoginMethod: `${pending.via}+${pending.method}`,
      loginCount: (userData.loginCount || 0) + 1,
      loginRecords,
    });

    const user = {
      uid: snap.id,
      email: typeof userData.email === "string" ? userData.email : "",
      account: typeof userData.account === "string" ? userData.account : "",
      displayName,
      role,
      roles: candidates.map((candidate) => candidate.role),
      tokenVersion: typeof userData.tokenVersion === "number" ? userData.tokenVersion : 1,
    };

    await createSession({ ...user, candidates });

    await logActivity({
      userId: user.uid,
      role,
      action: "two_factor_verified",
      ip,
      details:
        pending.method === "email_otp"
          ? "Email OTP 驗證成功，登入完成"
          : "TOTP 驗證成功，登入完成",
    });
    await logActivity({
      userId: user.uid,
      role,
      action: "login",
      ip,
      details: `兩階段驗證登入成功（${ROLE_LABELS[role]}）`,
    });

    // 首次登入須先改密碼（管理員代設的預設密碼）：回應即帶出，遮罩不必等重取 session
    return NextResponse.json({
      success: true,
      user: { ...user, mustChangePassword: userData.mustChangePassword === true },
    });
  } catch (error) {
    console.error("2FA verify error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤，請稍後再試") },
      { status: 500 }
    );
  }
}
