import { NextRequest, NextResponse } from "next/server";
import { verifySessionForRenewal } from "@/lib/dal";
import { refreshSessionActivity } from "@/lib/server-session";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { serverErrorMessage } from "@/lib/api-error";

/**
 * 閒置續期（keepalive）：使用者有活動時由前端節流呼叫，
 * 檢查 token 未撤銷且未逾閒置／絕對時限後滑動更新 JWT lastActivityAt。
 * 採輕量驗證（dal.verifySessionForRenewal）：**0 次 Firestore 讀取**——
 * 帳號停用、名冊移除等權限變更仍由下一次實際請求的完整 verifySession 擋下。
 * 回 401 代表 token 已失效或已逾閒置時限，前端應導回登入頁。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "session-keepalive",
      RATE.KEEPALIVE.limit,
      RATE.KEEPALIVE.windowMs
    );
    if (limited) return limited;

    const session = await verifySessionForRenewal();
    if (!session) {
      return NextResponse.json({ success: false, message: "未登入或登入已失效" }, { status: 401 });
    }

    await refreshSessionActivity(session);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Session keepalive error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
