import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { verifySession } from "@/lib/dal";
import { unauthorized } from "@/lib/server-session";
import { getClientIp, logActivity } from "@/lib/audit";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { getTotpIssuer } from "@/lib/settings-server";
import { invalidateAdminListCache } from "@/lib/list-cache";
import { isMailConfigured } from "@/lib/mailer";
import { buildOtpauthUrl } from "@/lib/totp";
import {
  ensureTotpSecret,
  readTwoFactorProfile,
  rotateTotpSecret,
} from "@/lib/two-factor";
import { TWO_FACTOR_METHODS, isTwoFactorMethod, USER_COLLECTION } from "@/types/users";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

function twoFactorInfo(secret: string, account: string, issuer: string) {
  return {
    totpSecret: secret,
    otpauthUrl: secret ? buildOtpauthUrl({ secret, account, issuer }) : "",
  };
}

/**
 * POST：設定兩階段驗證方式 / 重新產生 TOTP 密鑰。
 * body: { method } 或 { action: "regenerate" }
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "two-factor-set",
      RATE.TWO_FACTOR_SET.limit,
      RATE.TWO_FACTOR_SET.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    if (!session) return unauthorized();

    const parsed = await readJsonBody<{ method?: unknown; action?: unknown }>(
      request
    );
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const userRef = getAdminDb()
      .collection(USER_COLLECTION)
      .doc(session.uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      return NextResponse.json({ success: false, message: "帳號不存在" }, { status: 404 });
    }
    const userData = snap.data()!;
    const issuer = await getTotpIssuer();

    // 重新產生 TOTP 密鑰：舊密鑰立即失效，驗證器 App 需重新掃描
    if (body.action === "regenerate") {
      const current = readTwoFactorProfile(userData);
      if (current.method !== "totp") {
        return NextResponse.json(
          { success: false, message: "請先啟用「驗證碼APP」再重新產生密鑰" },
          { status: 400 }
        );
      }
      const secret = await rotateTotpSecret(userRef);
      await logActivity({
        userId: session.uid,
        role: session.role,
        action: "two_factor_changed",
        ip: getClientIp(request),
        details: "重新產生 TOTP 密鑰",
      });
      return NextResponse.json({
        success: true,
        message: "已產生新的 TOTP 密鑰，請重新掃描 QR Code",
        twoFactor: current.method,
        ...twoFactorInfo(secret, session.account, issuer),
      });
    }

    if (!isTwoFactorMethod(body.method)) {
      return NextResponse.json(
        {
          success: false,
          message: `驗證方式無效（可選：${TWO_FACTOR_METHODS.map((m) => m.label).join("、")}）`,
        },
        { status: 400 }
      );
    }
    const method = body.method;

    // 寄信不可用時不允許啟用「電子郵件驗證碼」，否則下次登入會被卡住
    if (method === "email_otp" && !isMailConfigured()) {
      return NextResponse.json(
        { success: false, message: "寄信功能尚未設定，暫時無法啟用電子郵件驗證碼" },
        { status: 400 }
      );
    }

    // 需收信的方式要求帳號有電子郵件（信箱可留空的帳號改用驗證碼APP）
    const hasEmail = typeof userData.email === "string" && Boolean(userData.email);
    if ((method === "email_otp" || method === "email_notify") && !hasEmail) {
      return NextResponse.json(
        {
          success: false,
          message: "此帳號尚無電子郵件地址，請先到「帳號與安全」填寫信箱，或改用驗證碼APP",
        },
        { status: 400 }
      );
    }

    const secret =
      method === "totp" ? await ensureTotpSecret(userRef, userData) : readTwoFactorProfile(userData).totpSecret;

    await userRef.update({ twoFactor: method });
    // 兩階段驗證方式顯示於「使用者帳號管理」清單：與管理端變更同一套失效
    await invalidateAdminListCache();

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "two_factor_changed",
      ip: getClientIp(request),
      details: `兩階段驗證方式改為「${TWO_FACTOR_METHODS.find((m) => m.value === method)?.label || method}」`,
    });

    return NextResponse.json({
      success: true,
      message: "設定已儲存",
      twoFactor: method,
      ...twoFactorInfo(secret, session.account, issuer),
    });
  } catch (error) {
    console.error("Two-factor update error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤，請稍後再試") },
      { status: 500 }
    );
  }
}
