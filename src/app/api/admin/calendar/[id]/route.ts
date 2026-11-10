import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import {
  cancelCalendarEvent,
  deleteCalendarEventHard,
  getCalendarEvent,
  getCalendarSettings,
  listAdminCalendarEvents,
  updateCalendarEvent,
} from "@/lib/calendar";
import { parseCalendarAudience, type CalendarSchoolActivity } from "@/types/calendar";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

type Params = { params: Promise<{ id: string }> };

/** GET：讀取單則行程（編輯用） */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const limited = enforceRateLimit(
      request,
      "calendar-admin",
      RATE.CALENDAR_ADMIN_GET.limit,
      RATE.CALENDAR_ADMIN_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireModulePermission("calendar");
    if (denial) return toAuthResponse(denial);

    const { id } = await params;
    const event = await getCalendarEvent(id);
    if (!event) {
      return NextResponse.json({ success: false, message: "查無此行程" }, { status: 404 });
    }
    return NextResponse.json({ success: true, event }, { headers: noStore });
  } catch (error) {
    console.error("Get calendar event error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PATCH：更新行程（含 status=cancelled 取消；「下架行程真實刪除」開啟時改為真實刪除） */
export async function PATCH(request: NextRequest, { params }: Params) {
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
    // 只有同時具備 delete 子權限（或管理員）才能因「下架即刪除」原則永久刪除
    const allowHardDelete =
      context.kind === "admin" || context.permissions.includes("delete");

    const { id } = await params;
    const existing = await getCalendarEvent(id);
    if (!existing) {
      return NextResponse.json({ success: false, message: "查無此行程" }, { status: 404 });
    }

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    // 閱讀權限：「無」＝公開（isPublic）；未帶欄位時沿用現值（與身分選項互斥）
    const isPublic = typeof body.isPublic === "boolean" ? body.isPublic : undefined;
    const effectivePublic = isPublic ?? existing.isPublic;
    const audience =
      body.audience !== undefined
        ? parseCalendarAudience(body.audience, effectivePublic)
        : undefined;
    if (body.audience !== undefined && !audience) {
      return NextResponse.json(
        { success: false, message: "閱讀權限無效（請至少選擇一個身分，或勾選「無」）" },
        { status: 400 }
      );
    }
    const status =
      body.status === "cancelled"
        ? ("cancelled" as const)
        : body.status === "active"
          ? ("active" as const)
          : undefined;

    const { deleted } = await updateCalendarEvent(id, {
      sourceModule: existing.sourceModule,
      sourceRef: existing.sourceRef,
      title: typeof body.title === "string" ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      location: typeof body.location === "string" ? body.location : undefined,
      startAt: typeof body.startAt === "number" ? body.startAt : undefined,
      endAt:
        body.endAt === null ? null : typeof body.endAt === "number" ? body.endAt : undefined,
      allDay: typeof body.allDay === "boolean" ? body.allDay : undefined,
      allDayDate: typeof body.allDayDate === "string" ? body.allDayDate : undefined,
      important: typeof body.important === "boolean" ? body.important : undefined,
      schoolActivity: body.schoolActivity as CalendarSchoolActivity | undefined,
      categoryId: typeof body.categoryId === "string" ? body.categoryId : undefined,
      publishUnit:
        typeof body.publishUnit === "string" ? body.publishUnit : undefined,
      audience: audience ?? undefined,
      isPublic,
      status,
    }, { allowHardDelete });

    const cancelled = status === "cancelled";
    await logActivity({
      userId: session.uid,
      role: session.role,
      action: cancelled ? "calendar_cancelled" : "calendar_updated",
      ip: getClientIp(request),
      details: `${cancelled ? (deleted ? "下架（真實刪除）" : "取消") : "更新"}行程 id=${id}`,
    });

    const [events, settings] = await Promise.all([
      listAdminCalendarEvents(),
      getCalendarSettings(),
    ]);
    return NextResponse.json(
      {
        success: true,
        message: cancelled
          ? deleted
            ? "行程已真實刪除"
            : "行程已取消"
          : "行程已更新",
        events,
        settings,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Update calendar event error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** POST：取消行程（快捷；「下架行程真實刪除」開啟時改為真實刪除） */
export async function POST(request: NextRequest, { params }: Params) {
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
    const allowHardDelete =
      context.kind === "admin" || context.permissions.includes("delete");

    const { id } = await params;
    const existing = await getCalendarEvent(id);
    if (!existing) {
      return NextResponse.json({ success: false, message: "查無此行程" }, { status: 404 });
    }
    const { deleted } = await cancelCalendarEvent(id, { allowHardDelete });

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "calendar_cancelled",
      ip: getClientIp(request),
      details: `${deleted ? "下架（真實刪除）" : "取消"}行程 id=${id}`,
    });

    const [events, settings] = await Promise.all([
      listAdminCalendarEvents(),
      getCalendarSettings(),
    ]);
    return NextResponse.json(
      {
        success: true,
        message: deleted ? "行程已真實刪除" : "行程已取消",
        events,
        settings,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Cancel calendar event error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/**
 * DELETE：真實刪除行程（快捷）。
 * 無條件硬刪除——連同該行程的所有個人提醒文件一併從資料庫刪除，不可恢復
 * （不受「下架行程真實刪除」原則影響；該原則只管取消時是否自動刪除）。
 */
export async function DELETE(request: NextRequest, { params }: Params) {
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

    const { context, denial } = await requireModulePermission("calendar", "delete");
    if (denial) return toAuthResponse(denial);
    const session = context.session;

    const { id } = await params;
    const existing = await getCalendarEvent(id);
    if (!existing) {
      return NextResponse.json({ success: false, message: "查無此行程" }, { status: 404 });
    }

    await deleteCalendarEventHard(id);
    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "calendar_deleted",
      ip: getClientIp(request),
      details: `真實刪除行程 id=${id}（${existing.title}）`,
    });

    const [events, settings] = await Promise.all([
      listAdminCalendarEvents(),
      getCalendarSettings(),
    ]);
    return NextResponse.json(
      { success: true, message: "行程已真實刪除", events, settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Delete calendar event error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
