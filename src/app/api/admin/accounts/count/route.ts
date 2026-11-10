import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod } from "@/lib/settings-server";
import { USER_COLLECTION } from "@/types/users";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET：帳號總數（省流模式用）——
 * 使用 count 聚合（每筆僅 1 次讀取、不載入文件內容），
 * 讓管理員在不載入整份帳號工作表的前提下掌握目前筆數。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "accounts-list",
      RATE.ACCOUNTS_LIST.limit,
      RATE.ACCOUNTS_LIST.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("users");
    if (denial) return toAuthResponse(denial);

    const snapshot = await getAdminDb().collection(USER_COLLECTION).count().get();
    const count = snapshot.data().count;
    return NextResponse.json({ success: true, count }, { headers: noStore });
  } catch (error) {
    console.error("Accounts count error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "讀取帳號總數失敗") },
      { status: 500, headers: noStore }
    );
  }
}
