import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { toAuthResponse, verifySession } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getCalendarSettings, listSurfaceCalendarEvents } from "@/lib/calendar";
import { isCalendarSurface } from "@/types/calendar";

const noStore = { "Cache-Control": "no-store" };

function entryClassCode(entry: Record<string, unknown> | null | undefined): string {
  if (!entry) return "";
  return typeof entry.classCode === "string" ? entry.classCode : "";
}

/**
 * GET：顯示位置的行程（系統首頁登入表單上方／四種身分功能首頁）。
 * ?surface=login｜student｜parent｜staff｜admin
 *
 * 回傳尚未結束（含今天）且開始時間最近的前 N 則行程
 * （N＝該位置「顯示筆數」設定，預設 5；前端以上下箭頭逐則翻頁）；
 * 無行程時回空陣列，「進入行事曆」入口由顯示元件固定呈現。
 * `surface=login`（未登入也可讀）只回閱讀權限「無」的公開行程；
 * 其餘位置須登入，依 session 身分過濾。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "calendar-surface",
      RATE.CALENDAR_SURFACE.limit,
      RATE.CALENDAR_SURFACE.windowMs
    );
    if (limited) return limited;

    const surface = request.nextUrl.searchParams.get("surface");
    if (!isCalendarSurface(surface)) {
      return NextResponse.json({ success: false, message: "未知的顯示位置" }, { status: 400 });
    }

    const session = await verifySession();
    if (!session && surface !== "login") {
      return toAuthResponse({ status: 401, message: "未登入或登入已失效" });
    }

    const settings = await getCalendarSettings();
    const setting = settings.surfaces[surface];
    if (!setting.enabled) {
      return NextResponse.json(
        { success: true, surface: setting, items: [] },
        { headers: noStore }
      );
    }

    const role = surface === "login" || !session ? null : session.role;
    const classCode = role && session ? entryClassCode(session.__entry) || null : null;
    const items = await listSurfaceCalendarEvents({ surface, role, classCode }, setting.limit);
    return NextResponse.json(
      { success: true, surface: setting, items },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Calendar surface error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
