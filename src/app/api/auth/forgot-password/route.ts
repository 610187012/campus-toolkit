import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import {
  enforceRateLimit,
  enforceAccountRateLimit,
  RATE,
} from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { normalizeEmail } from "@/lib/validation";
import {
  createPasswordResetToken,
  PASSWORD_RESET_TTL_MINUTES,
} from "@/lib/password-reset";
import { isMailConfigured, sendPasswordResetEmail } from "@/lib/mailer";
import { getMailIdentity } from "@/lib/settings-server";
import { ROLE_LABELS, UserRole } from "@/types/users";
import {
  detectRoleCandidates,
  findAccountBy,
  preferredRoleAmong,
} from "@/lib/login-candidate";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

/**
 * 統一回覆：不論信箱是否存在、寄信成功與否都回同一段文字，
 * 避免攻擊者藉回覆差異枚舉哪些信箱已註冊。
 */
const GENERIC_MESSAGE = `若該電子郵件已註冊，我們已寄出密碼重設信件，請在 ${PASSWORD_RESET_TTL_MINUTES} 分鐘內依信件指示重設密碼。`;

/**
 * 組出信件中的重設連結。
 * 優先採用 APP_BASE_URL：正式環境若未設定而改用請求來源，
 * Host 標頭遭偽造時信件連結可能指向攻擊者網域（token 洩漏）。
 */
function buildResetUrl(token: string, request: NextRequest): string {
  const path = `/reset-password?token=${encodeURIComponent(token)}`;
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    try {
      return new URL(path, configured).toString();
    } catch {
      console.error("[forgot-password] APP_BASE_URL 無效，改用請求來源:", configured);
    }
  }
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[forgot-password] 未設定 APP_BASE_URL，信件連結以請求來源組出；請設定以免 Host 偽造導致 token 洩漏"
    );
  }
  return new URL(path, request.url).toString();
}

async function findUserByEmail(
  email: string
): Promise<{
  uid: string;
  role: UserRole;
  displayName: string;
} | null> {
  // 使用者帳號唯一；重設信需要一個「當期有效身分」來標示收件人
  const hit = await findAccountBy("email", email);
  if (!hit) return null;
  const candidates = await detectRoleCandidates(hit);
  if (candidates.length === 0) return null;

  // 慣用身分優先，否則固定依 ALL_ROLES 順序；token 記錄實際使用的 role（僅供信件顯示與重設後自動登入）
  const preferred = preferredRoleAmong(candidates);
  const role = preferred ?? candidates[0].role;
  const name = typeof hit.data.name === "string" ? hit.data.name : "";
  return { uid: hit.id, role, displayName: name };
}

export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const ip = getClientIp(request);
    const limited = enforceRateLimit(
      request,
      "forgot-password",
      RATE.FORGOT_PASSWORD.limit,
      RATE.FORGOT_PASSWORD.windowMs
    );
    if (limited) return limited;

    const parsed = await readJsonBody<{ email?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const email = normalizeEmail(body.email);
    if (!email) {
      return NextResponse.json(
        { success: false, message: "請輸入有效的電子郵件地址" },
        { status: 400 }
      );
    }

    // 同一信箱的節流：查詢使用者前執行，讓「存在／不存在」兩條路徑的
    // 限流行為完全一致，不因回覆快慢洩漏帳號是否存在
    const emailLimited = enforceAccountRateLimit(
      "forgot-password",
      "email",
      email,
      RATE.FORGOT_PASSWORD_EMAIL.limit,
      RATE.FORGOT_PASSWORD_EMAIL.windowMs
    );
    if (emailLimited) return emailLimited;

    // 寄信功能未設定時一律回 503（與帳號是否存在無關，不構成枚舉管道）
    if (!isMailConfigured()) {
      console.error("[forgot-password] SMTP 未設定，無法寄出重設密碼信件");
      return NextResponse.json(
        { success: false, message: "系統尚未設定寄信功能，請聯絡管理員" },
        { status: 503 }
      );
    }

    const { systemName, schoolFullName } = await getMailIdentity();
    // 身分不再由使用者選擇：同一信箱存在於多個身分時，依帳號設定的慣用身分、
    // 否則固定順序命中（對外回覆一律相同，不構成枚舉管道）
    const user = await findUserByEmail(email);

    if (user) {
      const { token, expiresAt } = await createPasswordResetToken(
        {
          uid: user.uid,
          role: user.role,
          email,
          displayName: user.displayName,
        },
        ip
      );

      try {
        await sendPasswordResetEmail({
          to: email,
          displayName: user.displayName,
          roleLabel: ROLE_LABELS[user.role],
          resetUrl: buildResetUrl(token, request),
          expiresMinutes: PASSWORD_RESET_TTL_MINUTES,
          systemName,
          schoolName: schoolFullName,
        });
        await logActivity({
          userId: user.uid,
          role: user.role,
          action: "password_reset_requested",
          ip,
          details: `已寄出密碼重設信件（${ROLE_LABELS[user.role]}），有效期 ${PASSWORD_RESET_TTL_MINUTES} 分鐘`,
        });
      } catch (error) {
        // 細節只留伺服器 log；對外仍回統一訊息，避免寄信失敗差異成為枚舉管道
        console.error("Password reset mail error:", error);
        await logActivity({
          userId: user.uid,
          role: user.role,
          action: "password_reset_requested",
          ip,
          details: "寄出密碼重設信件失敗（SMTP 錯誤）",
        });
      }
    } else {
      await logActivity({
        action: "password_reset_requested",
        ip,
        details: `未找到符合的電子郵件：${email}`,
      });
    }

    // expiresAt 供前端顯示倒數（僅為 UX，真正的驗證在伺服器）
    return NextResponse.json({
      success: true,
      message: GENERIC_MESSAGE,
      expiresMinutes: PASSWORD_RESET_TTL_MINUTES,
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    return NextResponse.json(
      {
        success: false,
        message: serverErrorMessage(error, "系統錯誤，請稍後再試"),
      },
      { status: 500 }
    );
  }
}
