import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/audit";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import { getAnnouncementSettings } from "@/lib/announcements";
import { getCalendarSettings } from "@/lib/calendar";
import {
  ExamRegistrationError,
  buildOfficialExamXlsxForEvent,
  buildExamRegistrationCsvForEvent,
  buildExamRegistrationXlsxForEvent,
  createExamEvent,
  countAdminExamEvents,
  deleteExamEvent,
  deleteExamRegistration,
  getExamEventClassRoster,
  getExamEventClassTabs,
  getExamEventRoster,
  listAdminExamEvents,
  unarchiveExamRegistration,
  updateExamEvent,
} from "../../../lib/exam-registration";
import { isExamRegistrationNumberField, isExamRosterExportScope } from "../../../types/exam-registration";

const noStore = { "Cache-Control": "no-store" };

/**
 * 管理端守門（managerPermissions，政策修改書 §6）：
 * 管理員恆全權；非管理員看名冊條目 managedModules 子權限。
 * 子權限碼：viewRoster（檢視）／configure（場次維護）／approve（審核）／export（匯出）。
 */
async function requireExamPermission(permission?: string) {
  return requireModulePermission("examRegistration", permission);
}

/** 主程式的 serverErrorMessage 等價小工具（模組不得依賴非公開面檔案） */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ExamRegistrationError) return error.message;
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

/**
 * GET：場次清單；`?eventId=` 回班級分頁；`?eventId=&classCode=` 回單班名冊；
 * `?eventId=&stats=1` 回完整名單統計；`?summary=count` 僅回傳總筆數。
 * 檢視類需 viewRoster；匯出（format=csv／xlsx／official-xlsx）另需 export；
 * hookOptions（編輯表單掛勾選項）需 configure。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "exam-registration-admin",
      RATE.EXAM_REGISTRATION_ADMIN.limit,
      RATE.EXAM_REGISTRATION_ADMIN.windowMs
    );
    if (limited) return limited;

    const isExport =
      request.nextUrl.searchParams.get("format") === "csv" ||
      request.nextUrl.searchParams.get("format") === "xlsx" ||
      request.nextUrl.searchParams.get("format") === "official-xlsx";
    const permission = isExport ? "export" : "viewRoster";
    const { denial } = await requireExamPermission(permission);
    if (denial) return toAuthResponse(denial);

    if (request.nextUrl.searchParams.get("hookOptions") === "1") {
      const hookDenied = await requireExamPermission("configure");
      if (hookDenied.denial) return toAuthResponse(hookDenied.denial);
      const scope = request.nextUrl.searchParams.get("scope");
      const [announcementSettings, calendarSettings] = await Promise.all([
        scope === "calendar" ? Promise.resolve(null) : getAnnouncementSettings(),
        scope === "announcement" ? Promise.resolve(null) : getCalendarSettings(),
      ]);
      return NextResponse.json(
        {
          success: true,
          ...(announcementSettings
            ? {
                announcementCategories: announcementSettings.categories
                  .filter((category) => category.enabled)
                  .map(({ id, name }) => ({ id, name })),
              }
            : {}),
          ...(calendarSettings
            ? {
                calendarCategories: calendarSettings.categories
                  .filter((category) => category.enabled)
                  .map(({ id, name }) => ({ id, name })),
              }
            : {}),
        },
        { headers: noStore }
      );
    }

    const eventId = request.nextUrl.searchParams.get("eventId");
    if (eventId) {
      if (request.nextUrl.searchParams.get("format") === "csv") {
        const classCodeRaw = request.nextUrl.searchParams.get("classCode");
        const classCode = classCodeRaw ? classCodeRaw.trim() : "";
        const csv = await buildExamRegistrationCsvForEvent(eventId, classCode || undefined);
        if (!csv) {
          return NextResponse.json({ success: false, message: "找不到報名場次" }, { status: 404, headers: noStore });
        }
        return new NextResponse(csv.content, {
          headers: {
            ...noStore,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(csv.filename)}`,
          },
        });
      }
      if (request.nextUrl.searchParams.get("format") === "official-xlsx") {
        const schoolExamCode = request.nextUrl.searchParams.get("schoolExamCode")?.trim() ?? "";
        const registrationNumberFieldRaw = request.nextUrl.searchParams.get("registrationNumberField") ?? "rollNo";
        if (!schoolExamCode) {
          return NextResponse.json(
            { success: false, message: "請輸入學校升學代碼" },
            { status: 400, headers: noStore }
          );
        }
        if (!isExamRegistrationNumberField(registrationNumberFieldRaw)) {
          return NextResponse.json(
            { success: false, message: "報名序號欄位無效" },
            { status: 400, headers: noStore }
          );
        }
        const file = await buildOfficialExamXlsxForEvent(eventId, {
          from: request.nextUrl.searchParams.get("from")?.trim() ?? "",
          to: request.nextUrl.searchParams.get("to")?.trim() ?? "",
          schoolExamCode,
          registrationNumberField: registrationNumberFieldRaw,
          ignoreNationalId: request.nextUrl.searchParams.get("ignoreNationalId") === "1",
        });
        if (!file) {
          return NextResponse.json({ success: false, message: "找不到報名場次" }, { status: 404, headers: noStore });
        }
        return new NextResponse(new Uint8Array(file.buffer), {
          headers: {
            ...noStore,
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          },
        });
      }
      if (request.nextUrl.searchParams.get("format") === "xlsx") {
        const scopeRaw = request.nextUrl.searchParams.get("scope") ?? "";
        if (!isExamRosterExportScope(scopeRaw)) {
          return NextResponse.json(
            { success: false, message: "缺少或無效的名單類型" },
            { status: 400, headers: noStore }
          );
        }
        const from = request.nextUrl.searchParams.get("from")?.trim() ?? "";
        const to = request.nextUrl.searchParams.get("to")?.trim() ?? "";
        const schoolExamCode = request.nextUrl.searchParams.get("schoolExamCode")?.trim() ?? "";
        const registrationNumberFieldRaw = request.nextUrl.searchParams.get("registrationNumberField") ?? "rollNo";
        if (!isExamRegistrationNumberField(registrationNumberFieldRaw)) {
          return NextResponse.json(
            { success: false, message: "報名序號欄位無效" },
            { status: 400, headers: noStore }
          );
        }
        const file = await buildExamRegistrationXlsxForEvent(eventId, {
          scope: scopeRaw,
          from,
          to,
          schoolExamCode,
          registrationNumberField: registrationNumberFieldRaw,
        });
        if (!file) {
          return NextResponse.json({ success: false, message: "找不到報名場次" }, { status: 404, headers: noStore });
        }
        return new NextResponse(new Uint8Array(file.buffer), {
          headers: {
            ...noStore,
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          },
        });
      }
      // 延遲載入：`?eventId=&classCode=` 回傳單班名冊
      const classCode = request.nextUrl.searchParams.get("classCode");
      if (classCode !== null) {
        const classRoster = await getExamEventClassRoster(eventId, classCode);
        if (!classRoster) {
          return NextResponse.json({ success: false, message: "找不到報名場次" }, { status: 404, headers: noStore });
        }
        return NextResponse.json({ success: true, ...classRoster }, { headers: noStore });
      }
      // 場次清單「統計」面板：`?eventId=&stats=1` 回傳完整名單與統計（含登錄明細）
      if (request.nextUrl.searchParams.get("stats") === "1") {
        const roster = await getExamEventRoster(eventId);
        if (!roster) {
          return NextResponse.json({ success: false, message: "找不到報名場次" }, { status: 404, headers: noStore });
        }
        return NextResponse.json({ success: true, roster }, { headers: noStore });
      }
      // 延遲載入：`?eventId=` 回傳班級分頁（不含登錄明細）
      const tabs = await getExamEventClassTabs(eventId);
      if (!tabs) {
        return NextResponse.json({ success: false, message: "找不到報名場次" }, { status: 404, headers: noStore });
      }
      return NextResponse.json({ success: true, ...tabs }, { headers: noStore });
    }

    if (request.nextUrl.searchParams.get("summary") === "count") {
      const total = await countAdminExamEvents();
      return NextResponse.json({ success: true, total }, { headers: noStore });
    }

    const { events, epoch } = await listAdminExamEvents();
    return NextResponse.json({ success: true, events, epoch, total: events.length }, { headers: noStore });
  } catch (error) {
    console.error("Admin exam registration GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "系統錯誤") },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}

/** POST：建立場次（需 configure） */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "exam-registration-admin",
      RATE.EXAM_REGISTRATION_ADMIN.limit,
      RATE.EXAM_REGISTRATION_ADMIN.windowMs
    );
    if (limited) return limited;

    const { context, denial } = await requireExamPermission("configure");
    if (denial) return toAuthResponse(denial);
    const session = context.session;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400, headers: noStore });
    }

    const actor = {
      uid: session.uid,
      name: session.displayName || session.account,
      role: session.role,
    };
    const { events, epoch } = await createExamEvent(body, actor, getClientIp(request));
    return NextResponse.json(
      { success: true, message: "場次已建立", events, epoch },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Admin exam registration POST error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "系統錯誤") },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}

/**
 * PATCH：編輯場次與狀態轉換（`{ id, ...patch }`，需 configure）；
 * 解除封存（`{ id, registrationId, unarchive: true }`，需 approve）。
 */
export async function PATCH(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "exam-registration-admin",
      RATE.EXAM_REGISTRATION_ADMIN.limit,
      RATE.EXAM_REGISTRATION_ADMIN.windowMs
    );
    if (limited) return limited;

    const peek = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const isUnarchive = Boolean(
      peek && typeof peek.registrationId === "string" && peek.registrationId && peek.unarchive === true
    );
    const { context, denial } = await requireExamPermission(isUnarchive ? "approve" : "configure");
    if (denial) return toAuthResponse(denial);
    const session = context.session;

    const body = peek;
    const id = body && typeof body.id === "string" ? body.id : "";
    if (!id) {
      return NextResponse.json({ success: false, message: "缺少場次 id" }, { status: 400, headers: noStore });
    }

    const actor = {
      uid: session.uid,
      name: session.displayName || session.account,
      role: session.role,
    };
    // 解除封存分支：`{ id, registrationId, unarchive: true }`（學生可重新修改）
    const registrationId = body && typeof body.registrationId === "string" ? body.registrationId : "";
    if (registrationId && body?.unarchive === true) {
      const { registration } = await unarchiveExamRegistration({
        eventId: id,
        registrationId,
        actor,
        ip: getClientIp(request),
      });
      return NextResponse.json(
        { success: true, message: "已解除封存，學生可重新修改", registration },
        { headers: noStore }
      );
    }
    if (registrationId) {
      return NextResponse.json(
        { success: false, message: "此操作已停用" },
        { status: 400, headers: noStore }
      );
    }
    const { events, epoch } = await updateExamEvent(id, body, actor, getClientIp(request));
    return NextResponse.json(
      { success: true, message: "場次已更新", events, epoch },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Admin exam registration PATCH error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "系統錯誤") },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}

/**
 * DELETE：硬刪除場次（`?id=`，需 configure；連同該場次全部登錄名單一併刪除）
 * 或單筆登錄（`?id=&registrationId=`，需 approve）。
 */
export async function DELETE(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "exam-registration-admin",
      RATE.EXAM_REGISTRATION_ADMIN.limit,
      RATE.EXAM_REGISTRATION_ADMIN.windowMs
    );
    if (limited) return limited;

    const registrationIdPeek = request.nextUrl.searchParams.get("registrationId");
    const { context, denial } = await requireExamPermission(
      registrationIdPeek ? "approve" : "configure"
    );
    if (denial) return toAuthResponse(denial);
    const session = context.session;

    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, message: "缺少場次 id" }, { status: 400, headers: noStore });
    }

    const actor = {
      uid: session.uid,
      name: session.displayName || session.account,
      role: session.role,
    };

    // 單筆登錄硬刪除：`?id=&registrationId=`
    const registrationId = registrationIdPeek;
    if (registrationId) {
      const { studentName } = await deleteExamRegistration({
        eventId: id,
        registrationId,
        actor,
        ip: getClientIp(request),
      });
      return NextResponse.json(
        { success: true, message: `已刪除 ${studentName} 的報名登錄` },
        { headers: noStore }
      );
    }

    const { events, epoch } = await deleteExamEvent(id, actor, getClientIp(request));
    return NextResponse.json(
      { success: true, message: "場次已刪除", events, epoch },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Admin exam registration DELETE error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "系統錯誤") },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}
