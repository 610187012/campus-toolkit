import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { toAuthResponse, verifySession } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getCalendarEvent, getCalendarSettings } from "@/lib/calendar";
import {
  calendarEventToItem,
  calendarCategoryName,
  canViewCalendarEvent,
  isCalendarEventActive,
  isCalendarEventPublicReadable,
} from "@/types/calendar";

const noStore = { "Cache-Control": "no-store" };

function entryClassCode(entry: Record<string, unknown> | null | undefined): string {
  if (!entry) return "";
  return typeof entry.classCode === "string" ? entry.classCode : "";
}

type Params = { params: Promise<{ id: string }> };

/**
 * GET：單則行程內容（顯示位置「跳出新頁」用）。
 * 權限與顯示位置一致：
 * - 閱讀權限「無」（`isPublic`）的公開行程：不需登入即可查閱；
 * - 其餘行程：須登入，且依身分／班級判定（管理員可讀全部）。
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "calendar-list",
      RATE.CALENDAR_LIST.limit,
      RATE.CALENDAR_LIST.windowMs
    );
    if (limited) return limited;

    const { id } = await params;
    if (!id || id.length > 64) {
      return NextResponse.json({ success: false, message: "查無此行程" }, { status: 404 });
    }

    const record = await getCalendarEvent(id);
    if (!record || !isCalendarEventActive(record)) {
      return NextResponse.json({ success: false, message: "查無此行程" }, { status: 404 });
    }

    const settings = await getCalendarSettings();
    const payload = calendarEventToItem(record, calendarCategoryName(settings, record.categoryId));

    // 公開行程（閱讀權限「無」）：任何人可讀
    if (isCalendarEventPublicReadable(record)) {
      return NextResponse.json({ success: true, event: payload }, { headers: noStore });
    }

    // 非公開行程：須登入
    const session = await verifySession();
    if (!session) {
      return toAuthResponse({ status: 401, message: "請登入後再查看此行程" });
    }

    // 一般身分：須受眾包含該身分＋班級相符（管理員可讀全部）
    const classCode = entryClassCode(session.__entry);
    if (
      session.role !== "admin" &&
      !canViewCalendarEvent(record.audience, session.role, classCode || null)
    ) {
      return NextResponse.json({ success: false, message: "無權限閱讀此行程" }, { status: 403 });
    }

    return NextResponse.json({ success: true, event: payload }, { headers: noStore });
  } catch (error) {
    console.error("Get calendar event error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
