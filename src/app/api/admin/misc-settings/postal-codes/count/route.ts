import { NextRequest, NextResponse } from "next/server";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { serverErrorMessage } from "@/lib/api-error";
import { getPostalCodeOptions } from "@/lib/postal-codes";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET：郵遞區號選項總數（省流模式用）——
 * 選項存於單一設定文件，走既有 setting-doc 快取（30 秒）取 length，
 * 讓管理員在不展開整份清單的前提下掌握目前筆數。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "school-codes",
      RATE.SCHOOL_CODES_GET.limit,
      RATE.SCHOOL_CODES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("miscSettings");
    if (denial) return toAuthResponse(denial);

    const options = await getPostalCodeOptions();
    return NextResponse.json({ success: true, count: options.length }, { headers: noStore });
  } catch (error) {
    console.error("Postal codes count error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "讀取郵遞區號總數失敗") },
      { status: 500, headers: noStore }
    );
  }
}
