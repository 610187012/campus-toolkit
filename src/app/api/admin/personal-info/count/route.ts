import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { requireRole, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod } from "@/lib/settings-server";
import { countStudentPersonalInfoByTerm } from "@/lib/personal-info";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET：本期學生個人資料總數（省流模式用）——
 * 使用 count 聚合（每筆僅 1 次讀取、不載入文件內容），
 * 讓管理員在不載入整份清單的前提下掌握目前筆數。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_GET.limit,
      RATE.FEATURE_MODULES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireRole("admin");
    if (denial) return toAuthResponse(denial);

    const period = await getCurrentPeriod();
    const count = await countStudentPersonalInfoByTerm(period);
    return NextResponse.json({ success: true, count, period }, { headers: noStore });
  } catch (error) {
    console.error("Student personal info count error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "讀取個人資料總數失敗") },
      { status: 500, headers: noStore }
    );
  }
}
