import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { verifySession } from "@/lib/dal";
import { unauthorized } from "@/lib/server-session";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { normalizeAccount, normalizeEmail } from "@/lib/validation";
import { USER_COLLECTION } from "@/types/users";
import { serverErrorMessage } from "@/lib/api-error";

/**
 * GET：帳號與安全卡的即時查重（帳號與電子郵件全站唯一，排除自己）。
 * 參數可只給其中一項，未給或格式無效的欄位一律回 taken=false，
 * 格式錯誤由前端先擋，不在這裡回錯，避免輸入途中不斷收到 4xx。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "account-check",
      RATE.ACCOUNT_CHECK.limit,
      RATE.ACCOUNT_CHECK.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    if (!session) return unauthorized();

    const params = request.nextUrl.searchParams;
    const rawEmail = params.get("email");
    const rawAccount = params.get("account");

    const collection = getAdminDb().collection(USER_COLLECTION);

    let emailTaken = false;
    const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : null;
    if (email) {
      const dup = await collection.where("email", "==", email).limit(1).get();
      emailTaken = !dup.empty && dup.docs[0].id !== session.uid;
    }

    let accountTaken = false;
    const account =
      typeof rawAccount === "string" ? normalizeAccount(rawAccount) : null;
    if (account) {
      const dup = await collection.where("account", "==", account).limit(1).get();
      accountTaken = !dup.empty && dup.docs[0].id !== session.uid;
    }

    return NextResponse.json(
      { success: true, emailTaken, accountTaken },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Account check error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
