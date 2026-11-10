import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getAdminDb } from "@/lib/firebase-admin";
import { hashPassword } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import {
  enforceRateLimitShared,
  checkRateLimitAsync,
  clientKey,
  RATE,
} from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { createSession } from "@/lib/server-session";
import { isStrongPassword, PASSWORD_REQUIREMENT_MESSAGE } from "@/lib/validation";
import {
  consumePasswordResetToken,
  inspectPasswordResetToken,
  PASSWORD_RESET_TTL_MINUTES,
} from "@/lib/password-reset";
import { USER_COLLECTION, isAccountActive, isUserRole, UserRole } from "@/types/users";
import { detectRoleCandidates } from "@/lib/login-candidate";
import { getRosterEntry, resolveDisplayName } from "@/lib/roster";
import { getCurrentPeriod } from "@/lib/settings-server";
import { invalidateReadCache, AUTHZ_CACHE_PREFIX } from "@/lib/read-cache";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  const tail = local.length > 1 ? local.slice(-1) : "";
  return `${head}***${tail}${domain}`;
}

const STATUS_MESSAGE: Record<string, string> = {
  invalid: "重設連結無效，請重新申請",
  expired: `重設連結已過期（有效期 ${PASSWORD_RESET_TTL_MINUTES} 分鐘），請重新申請`,
  used: "重設連結已使用過，請重新申請",
};

/**
 * 驗證失敗計數：擋 token 暴力亂試。
 * key 同時納入 IP 與 token 指紋：
 * ① 不依賴可能為空的 IP（IP 未知時所有請求共用同一桶，會被單一來源用錯誤 token 打滿）
 * ② 攻擊者亂試其他 token 不會耗掉合法用戶的額度
 */
function tokenFingerprint(token: unknown): string {
  return createHash("sha256")
    .update(typeof token === "string" ? token : "")
    .digest("hex")
    .slice(0, 16);
}

async function countVerifyFailure(
  request: NextRequest,
  token: unknown
): Promise<NextResponse | null> {
  const fail = await checkRateLimitAsync(
    `reset-password-fail:${clientKey(request)}:${tokenFingerprint(token)}`,
    RATE.RESET_PASSWORD_FAIL.limit,
    RATE.RESET_PASSWORD_FAIL.windowMs
  );
  if (fail.ok) return null;
  return NextResponse.json(
    { success: false, message: "驗證次數過多，請稍後再試" },
    {
      status: 429,
      headers: { "Retry-After": String(fail.retryAfterSec) },
    }
  );
}

/**
 * GET：讓重設頁在使用者輸入密碼前先確認連結是否有效（不消耗 token）。
 * token 只會經 query string 傳遞一次；proxy 已加 Referrer-Policy: no-referrer。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "reset-password-verify",
      RATE.RESET_PASSWORD.limit,
      RATE.RESET_PASSWORD.windowMs
    );
    if (limited) return limited;

    const token = request.nextUrl.searchParams.get("token");
    const { status, record } = await inspectPasswordResetToken(token);

    if (status !== "ok") {
      const tooMany = await countVerifyFailure(request, token);
      if (tooMany) return tooMany;
      return NextResponse.json(
        {
          success: false,
          valid: false,
          status,
          message: STATUS_MESSAGE[status] || STATUS_MESSAGE.invalid,
        },
        { status: status === "invalid" ? 400 : 410 }
      );
    }

    const expiresAt = record?.expiresAt || 0;
    return NextResponse.json({
      success: true,
      valid: true,
      status: "ok",
      expiresAt,
      remainingSeconds: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
      expiresMinutes: PASSWORD_RESET_TTL_MINUTES,
      emailMasked: maskEmail(record?.email || ""),
      displayName: record?.displayName || "",
    });
  } catch (error) {
    console.error("Reset password verify error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤，請稍後再試") },
      { status: 500 }
    );
  }
}

/** POST：消耗一次性 token 並寫入新密碼；成功即自動登入 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const ip = getClientIp(request);
    const limited = await enforceRateLimitShared(
      request,
      "reset-password",
      RATE.RESET_PASSWORD.limit,
      RATE.RESET_PASSWORD.windowMs
    );
    if (limited) return limited;

    const parsed = await readJsonBody<{ token?: unknown; newPassword?: unknown }>(
      request
    );
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    if (!isStrongPassword(body.newPassword)) {
      return NextResponse.json(
        { success: false, message: PASSWORD_REQUIREMENT_MESSAGE },
        { status: 400 }
      );
    }

    const { status, record } = await consumePasswordResetToken(body.token);
    if (status !== "ok" || !record) {
      const tooMany = await countVerifyFailure(request, body.token);
      if (tooMany) return tooMany;
      await logActivity({
        action: "password_reset_failed",
        ip,
        details: `重設密碼失敗：${status}`,
      });
      return NextResponse.json(
        {
          success: false,
          status,
          message: STATUS_MESSAGE[status] || STATUS_MESSAGE.invalid,
        },
        { status: status === "invalid" ? 400 : 410 }
      );
    }

    const db = getAdminDb();
    const userRef = db.collection(USER_COLLECTION).doc(record.uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return NextResponse.json(
        { success: false, message: "帳號不存在" },
        { status: 404 }
      );
    }

    const userData = userDoc.data() || {};
    // 停用（無效）帳號：完成重設也不建立 session，直接擋下避免繞道登入
    if (!isAccountActive(userData)) {
      await logActivity({
        userId: record.uid,
        role: record.role,
        action: "login_failed",
        ip,
        details: "停用帳號嘗試密碼重設並登入",
      });
      return NextResponse.json(
        { success: false, message: "帳號已停用，無法登入" },
        { status: 403 }
      );
    }

    const passwordHash = await hashPassword(body.newPassword, 12);
    const newTokenVersion =
      (typeof userData.tokenVersion === "number" ? userData.tokenVersion : 1) + 1;

    // tokenVersion +1 使所有舊 session 失效（dal.verifySession 逐一比對），
    // 同時清除登入鎖定與失敗計數，讓被鎖住的用戶可重新登入
    await userRef.update({
      passwordHash,
      tokenVersion: newTokenVersion,
      failedAttempts: 0,
      lockedUntil: 0,
      lockIp: "",
      // 本人已透過一次性連結設定新密碼：解除「須先改密碼」要求
      mustChangePassword: false,
    });
    // 一次性連結重設不會撤銷舊 jti（使用者可能無在線 session），
    // 依賴 tokenVersion 比對擋舊 session：必須清本機 authz 快取，
    // 否則 8 秒內舊 session 可能命中改密前的成功快取
    invalidateReadCache(AUTHZ_CACHE_PREFIX);

    // 自動登入：以「當期名冊有效身分」決定要進入的身分（token 記錄的 role 只是提示）
    const candidates = await detectRoleCandidates({
      id: userDoc.id,
      ref: userDoc.ref,
      data: userData,
    });
    const role: UserRole | null =
      isUserRole(record.role) && candidates.some((candidate) => candidate.role === record.role)
        ? record.role
        : candidates.length > 0
          ? candidates[0].role
          : null;

    // 重設成功但當期沒有可用身分（名冊尚未建立）：不建立 session，請使用者登入時再處理
    if (!role) {
      await logActivity({
        userId: record.uid,
        action: "password_reset_completed",
        ip,
        details: "透過一次性連結重設密碼（當期無可用身分，未自動登入）",
      });
      return NextResponse.json({
        success: true,
        message: "密碼已重設，請重新登入",
        requiresLogin: true,
      });
    }

    const entry = await getRosterEntry(record.uid, role, await getCurrentPeriod());
    const user = {
      uid: record.uid,
      email: typeof userData.email === "string" ? userData.email : record.email,
      account: typeof userData.account === "string" ? userData.account : "",
      displayName: resolveDisplayName(userData, entry),
      role,
      roles: candidates.map((candidate) => candidate.role),
      tokenVersion: newTokenVersion,
    };

    await createSession({
      uid: user.uid,
      email: user.email,
      account: user.account,
      displayName: user.displayName,
      role,
      candidates,
      tokenVersion: newTokenVersion,
    });

    await logActivity({
      userId: record.uid,
      role: record.role,
      action: "password_reset_completed",
      ip,
      details: "透過一次性連結重設密碼，舊 token 已失效",
    });

    return NextResponse.json({ success: true, message: "密碼已重設", user });
  } catch (error) {
    console.error("Reset password error:", error);
    return NextResponse.json(
      {
        success: false,
        message: serverErrorMessage(error, "系統錯誤，請稍後再試"),
      },
      { status: 500 }
    );
  }
}
