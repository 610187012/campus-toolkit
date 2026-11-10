import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { toAuthResponse, verifySession } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import {
  getCalendarSettings,
  listMyCalendarReminderIds,
  listMyCalendarReminders,
  toggleCalendarReminder,
} from "@/lib/calendar";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

function entryClassCode(entry: Record<string, unknown> | null | undefined): string {
  if (!entry) return "";
  return typeof entry.classCode === "string" ? entry.classCode : "";
}

/** GET：我的行程提醒（仍有效者）＋已設定 id（供按鈕狀態） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "calendar-list",
      RATE.CALENDAR_LIST.limit,
      RATE.CALENDAR_LIST.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    if (!session) return toAuthResponse({ status: 401, message: "未登入或登入已失效" });

    const classCode = entryClassCode(session.__entry);
    const [items, reminderIds, settings] = await Promise.all([
      listMyCalendarReminders(session.uid, session.role, classCode || null),
      listMyCalendarReminderIds(session.uid),
      getCalendarSettings(),
    ]);
    return NextResponse.json(
      {
        success: true,
        items,
        reminderIds,
        remindersEnabled: settings.defaultRemindersEnabled,
        count: items.length,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("List calendar reminders error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** POST：切換個人提醒 { eventId }（非推播，開啟頁面才更新） */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "calendar-list",
      RATE.CALENDAR_LIST.limit,
      RATE.CALENDAR_LIST.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    if (!session) return toAuthResponse({ status: 401, message: "未登入或登入已失效" });

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
    if (!eventId) {
      return NextResponse.json({ success: false, message: "缺少行程識別" }, { status: 400 });
    }

    const result = await toggleCalendarReminder(session.uid, eventId);
    return NextResponse.json(
      {
        success: true,
        message: result.reminded ? "已加入提醒" : "已取消提醒",
        reminded: result.reminded,
        eventId,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Toggle calendar reminder error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
