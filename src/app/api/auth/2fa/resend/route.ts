import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { getPending2FAPayload } from "@/lib/server-session";
import { getClientIp, logActivity } from "@/lib/audit";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import {
  EMAIL_OTP_COOLDOWN_MS,
  sendEmailOtp,
} from "@/lib/two-factor";
import { USER_COLLECTION } from "@/types/users";
import { serverErrorMessage } from "@/lib/api-error";

/** POST：重寄 Email OTP（同用戶 120 秒節流，另受每 IP 限流） */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "2fa-resend",
      RATE.TWO_FA_RESEND.limit,
      RATE.TWO_FA_RESEND.windowMs
    );
    if (limited) return limited;

    const ip = getClientIp(request);
    const pending = await getPending2FAPayload();
    if (!pending) {
      return NextResponse.json(
        { success: false, message: "驗證階段已過期，請重新登入" },
        { status: 401 }
      );
    }

    if (pending.method !== "email_otp") {
      return NextResponse.json(
        { success: false, message: "目前的驗證方式無需重送驗證碼" },
        { status: 400 }
      );
    }

    const userRef = getAdminDb()
      .collection(USER_COLLECTION)
      .doc(pending.uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      return NextResponse.json(
        { success: false, message: "驗證階段已過期，請重新登入" },
        { status: 401 }
      );
    }
    const userData = snap.data()!;

    const result = await sendEmailOtp({
      ref: userRef,
      data: userData,
      email: userData.email,
      displayName: userData.name || userData.displayName || "",
      account: userData.account,
      role: pending.role,
    });

    if (result === "cooldown") {
      const sentAt = typeof userData.otpSentAt === "number" ? userData.otpSentAt : 0;
      const remainSec = Math.max(
        1,
        Math.ceil((sentAt + EMAIL_OTP_COOLDOWN_MS - Date.now()) / 1000)
      );
      return NextResponse.json(
        { success: false, message: `驗證碼剛已寄出，請 ${remainSec} 秒後再試` },
        { status: 429, headers: { "Retry-After": String(remainSec) } }
      );
    }

    if (result === "smtp") {
      return NextResponse.json(
        { success: false, message: "寄信功能尚未設定，請聯絡管理員" },
        { status: 503 }
      );
    }

    await logActivity({
      userId: pending.uid,
      role: pending.role,
      action: "email_otp_sent",
      ip,
      details: "重新寄送 Email OTP",
    });

    return NextResponse.json(
      {
        success: true,
        message: "驗證碼已寄出",
        resendAt: Date.now() + EMAIL_OTP_COOLDOWN_MS,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("2FA resend error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤，請稍後再試") },
      { status: 500 }
    );
  }
}
