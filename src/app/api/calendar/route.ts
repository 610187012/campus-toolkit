import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { toAuthResponse, verifySession } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  createCalendarEvent,
  getCalendarSettings,
  listCalendarEvents,
  listMyCalendarReminderIds,
} from "@/lib/calendar";
import { staffAudienceAllowed, type CalendarAudience } from "@/types/calendar";
import { ALL_ROLES, type UserRole } from "@/types/users";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

function entryClassCode(entry: Record<string, unknown> | null | undefined): string {
  if (!entry) return "";
  return typeof entry.classCode === "string" ? entry.classCode : "";
}

/** 當期名冊條目的「單位」（教職員專屬；建立行程時預帶、可改） */
function entryUnit(entry: Record<string, unknown> | null | undefined): string {
  if (!entry) return "";
  return typeof entry.unit === "string" ? entry.unit : "";
}

/**
 * GET：行程列表（全站統一行事曆頁資料源）。
 * 已登入：依 session 身分＋名冊班級過濾，附個人提醒與發佈單位預設值。
 * 未登入：回公開行程（閱讀權限「無」且不限班級），無提醒功能。
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

    const session = await verifySession();
    if (!session) {
      // 公開模式：未登入只回公開行程（統一行事曆頁免登入可浏览）
      const [items, settings] = await Promise.all([
        listCalendarEvents({ role: null }),
        getCalendarSettings(),
      ]);
      return NextResponse.json(
        {
          success: true,
          items,
          role: null,
          classCode: null,
          categories: settings.categories,
          remindersEnabled: false,
        },
        { headers: noStore }
      );
    }

    const classCode = entryClassCode(session.__entry);
    const [rawItems, settings, reminderIds] = await Promise.all([
      listCalendarEvents({ role: session.role, classCode: classCode || null }),
      getCalendarSettings(),
      listMyCalendarReminderIds(session.uid),
    ]);
    const items = rawItems.map((item) => ({
      ...item,
      reminded: reminderIds.includes(item.id),
    }));

    return NextResponse.json(
      {
        success: true,
        items,
        role: session.role,
        classCode: classCode || null,
        categories: settings.categories,
        remindersEnabled: settings.defaultRemindersEnabled,
        reminderIds,
        /** 發佈單位預設值（教職員名冊「單位」；管理員為空） */
        publishUnit: entryUnit(session.__entry),
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("List calendar events error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/**
 * POST：教職員（或管理員）建立行程。
 * 教職員：閱讀權限（身分）限 student/parent/staff；若限定班級必須包含自己導師班。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "calendar-staff-create",
      RATE.CALENDAR_STAFF_CREATE.limit,
      RATE.CALENDAR_STAFF_CREATE.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    if (!session) return toAuthResponse({ status: 401, message: "未登入或登入已失效" });
    if (session.role !== "staff" && session.role !== "admin") {
      return toAuthResponse({ status: 403, message: "僅教職員與管理員可建立行程" });
    }

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const rawRoles = Array.isArray(body.roles) ? body.roles : [];
    const allowedRoles: UserRole[] =
      session.role === "admin"
        ? ALL_ROLES.filter((role) => rawRoles.includes(role))
        : (["student", "parent", "staff"] as UserRole[]).filter((role) => rawRoles.includes(role));
    if (allowedRoles.length === 0) {
      return NextResponse.json(
        { success: false, message: "請至少選擇一個行程閱讀權限" },
        { status: 400 }
      );
    }

    const ownClass = entryClassCode(session.__entry);
    const rawCodes = Array.isArray(body.classCodes)
      ? (body.classCodes as unknown[])
          .filter((code): code is string => typeof code === "string" && code.trim() !== "")
          .map((code) => code.trim().slice(0, 32))
      : [];
    // 教職員未填班級＝全校；填了則必須含自己導師班
    let classCodes = rawCodes;
    if (session.role === "staff" && classCodes.length > 0 && (!ownClass || !classCodes.includes(ownClass))) {
      return NextResponse.json(
        { success: false, message: "教職員班級行程須包含自己的導師班" },
        { status: 400 }
      );
    }

    const audience: CalendarAudience =
      classCodes.length === 0
        ? { roles: allowedRoles, classCodes: ["*"] }
        : { roles: allowedRoles, classCodes };

    if (session.role === "staff" && !staffAudienceAllowed(audience, ownClass)) {
      return NextResponse.json({ success: false, message: "無權建立該班級行程" }, { status: 403 });
    }

    const period = await getCurrentPeriod();
    // 發佈單位：表單有值則覆寫，否則預帶名冊「單位」（管理員通常為空）
    const typedUnit = typeof body.publishUnit === "string" ? body.publishUnit.trim() : "";
    const publishUnit = typedUnit || entryUnit(session.__entry) || undefined;
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
      categoryId: typeof body.categoryId === "string" ? body.categoryId : undefined,
      publishUnit,
      audience,
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
      details: `建立行程 id=${id}（閱讀權限：${allowedRoles.join("、")}${
        classCodes.length > 0 ? `，班級 ${classCodes.join("、")}` : "，全校"
      }，學年 ${period.academicYear}-${period.semester}）`,
    });

    const [items, settings] = await Promise.all([
      listCalendarEvents({ role: session.role, classCode: ownClass || null }),
      getCalendarSettings(),
    ]);
    return NextResponse.json(
      {
        success: true,
        message: "行程已建立",
        id,
        items,
        categories: settings.categories,
      },
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
