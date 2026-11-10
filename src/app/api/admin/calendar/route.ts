import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  createCalendarEvent,
  getCalendarSettings,
  listAdminCalendarEvents,
  purgeDownCalendarEvents,
} from "@/lib/calendar";
import { calendarAccessOf, parseCalendarAudience, type CalendarSchoolActivity } from "@/types/calendar";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

/** GET：管理端行程清單（含已取消）＋模組設定 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "calendar-admin",
      RATE.CALENDAR_ADMIN_GET.limit,
      RATE.CALENDAR_ADMIN_GET.windowMs
    );
    if (limited) return limited;

    const { context, denial } = await requireModulePermission("calendar");
    if (denial) return toAuthResponse(denial);
    const access = calendarAccessOf(context.kind === "admin" ? null : context.permissions);

    const settings = await getCalendarSettings();
    // 下架原則＝真實刪除：清單載入時掃描已取消行程並刪除（含個人提醒）
    if (settings.policies.hardDeleteCancelled) {
      await purgeDownCalendarEvents();
    }
    const events = await listAdminCalendarEvents();
    return NextResponse.json({ success: true, events, settings, access }, { headers: noStore });
  } catch (error) {
    console.error("List calendar events error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** POST：建立行程 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "calendar-admin",
      RATE.CALENDAR_ADMIN_MUTATE.limit,
      RATE.CALENDAR_ADMIN_MUTATE.windowMs
    );
    if (limited) return limited;

    const { context, denial } = await requireModulePermission("calendar", "manage");
    if (denial) return toAuthResponse(denial);
    const session = context.session;

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (!body) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }
    // 閱讀權限：「無」＝公開（isPublic，不需登入），與身分選項互斥
    const isPublic = body.isPublic === true;
    const audience = parseCalendarAudience(body.audience, isPublic);
    if (!audience) {
      return NextResponse.json(
        { success: false, message: "閱讀權限無效（請至少選擇一個身分，或勾選「無」）" },
        { status: 400 }
      );
    }

    const period = await getCurrentPeriod();
    const { id } = await createCalendarEvent({
      sourceModule: "calendar",
      title: typeof body.title === "string" ? body.title : "",
      description: typeof body.description === "string" ? body.description : undefined,
      location: typeof body.location === "string" ? body.location : undefined,
      startAt: typeof body.startAt === "number" ? body.startAt : undefined,
      endAt: typeof body.endAt === "number" ? body.endAt : null,
      allDay: body.allDay === true,
      allDayDate: typeof body.allDayDate === "string" ? body.allDayDate : undefined,
      important: body.important === true,
      schoolActivity: body.schoolActivity as CalendarSchoolActivity | undefined,
      categoryId: typeof body.categoryId === "string" ? body.categoryId : undefined,
      publishUnit: typeof body.publishUnit === "string" ? body.publishUnit : undefined,
      audience,
      isPublic,
      status: "active",
      createdBy: {
        uid: session.uid,
        name: session.displayName || session.account,
        role: session.role,
      },
    });

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "calendar_created",
      ip: getClientIp(request),
      details: `建立行程（id=${id}，閱讀權限=${
        isPublic ? "無（公開）" : audience.roles.join("、") || "—"
      }，學年 ${period.academicYear}-${period.semester}）`,
    });

    const [events, settings] = await Promise.all([
      listAdminCalendarEvents(),
      getCalendarSettings(),
    ]);
    return NextResponse.json(
      { success: true, message: "行程已建立", id, events, settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Create calendar event error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
