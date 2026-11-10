import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { serverErrorMessage } from "@/lib/api-error";
import { verifySession } from "@/lib/dal";
import { getCalendarSettings, listPublicCalendarEventsInRange } from "@/lib/calendar";
import { computePublicCalendarEarliestFrom } from "@/types/calendar";

export const dynamic = "force-dynamic";

const MAX_SPAN_MS = 320 * 86_400_000; // 區間上限約 10 個月（防濫用）

/**
 * GET：公開行事曆專頁資料（未登入可讀）。
 * ?from=<epoch ms>&to=<epoch ms>——預設僅回閱讀權限「無」的公開行程（lib 層過濾）；
 * 管理員登入時放行全部行程（比照管理端視角，檢視頁也看得到僅限管理員的行程）。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "calendar-list",
      RATE.CALENDAR_LIST.limit,
      RATE.CALENDAR_LIST.windowMs
    );
    if (limited) return limited;

    const from = Number(request.nextUrl.searchParams.get("from"));
    const to = Number(request.nextUrl.searchParams.get("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return NextResponse.json({ success: false, message: "from/to 參數無效" }, { status: 400 });
    }
    if (to - from > MAX_SPAN_MS) {
      return NextResponse.json({ success: false, message: "查詢區間過大" }, { status: 400 });
    }

    const session = await verifySession();
    const viewerIsAdmin = session?.role === "admin";
    const items = await listPublicCalendarEventsInRange(from, to, 200, viewerIsAdmin);
    const settings = await getCalendarSettings();
    const earliestFrom = computePublicCalendarEarliestFrom(settings.policies.publicPastMonths ?? 1);
    return NextResponse.json(
      { success: true, items, earliestFrom },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Public calendar error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
