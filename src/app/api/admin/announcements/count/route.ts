import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { countAnnouncementsByStatus } from "@/lib/announcements";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET：公告狀態統計（省流模式用）——
 * 只回「發布中（未下架）／已封存」兩筆計數，使用 count 聚合（每筆僅 1 次讀取），
 * 讓管理員在不載入整份清單的前提下掌握目前數據。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "announcements-admin",
      RATE.ANNOUNCEMENTS_ADMIN_GET.limit,
      RATE.ANNOUNCEMENTS_ADMIN_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("announcements");
    if (denial) return toAuthResponse(denial);

    const counts = await countAnnouncementsByStatus();
    return NextResponse.json({ success: true, ...counts }, { headers: noStore });
  } catch (error) {
    console.error("Announcements count error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
