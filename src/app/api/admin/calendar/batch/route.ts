import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import {
  batchCancelCalendarEvents,
  batchDeleteCalendarEventsHard,
  getCalendarSettings,
  listAdminCalendarEvents,
} from "@/lib/calendar";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

/** 單次批次請求的 id 上限（與 lib BATCH_IDS_MAX 一致） */
const BATCH_IDS_MAX = 200;

function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim())
    ),
  ].slice(0, BATCH_IDS_MAX);
}

/**
 * POST：批次處理勾選的行程。
 * body：`{ action: "cancel" | "delete", ids: string[] }`
 * - cancel：批次取消（原則「下架行程真實刪除」開啟時連同個人提醒硬刪除）
 * - delete：無條件真實刪除（連同個人提醒，不可恢復）
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "calendar-admin",
      RATE.CALENDAR_ADMIN_MUTATE.limit,
      RATE.CALENDAR_ADMIN_MUTATE.windowMs
    );
    if (limited) return limited;

    const { context, denial } = await requireModulePermission("calendar");
    if (denial) return toAuthResponse(denial);
    const session = context.session;

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const action = body.action === "cancel" ? "cancel" : body.action === "delete" ? "delete" : null;
    const ids = parseIds(body.ids);
    if (!action || ids.length === 0) {
      return NextResponse.json(
        { success: false, message: "請求內容無效（缺少 action 或 ids）" },
        { status: 400 }
      );
    }
    // 子權限分開授權：批次刪除需 delete、批次取消需 manage（管理員恆全權）
    const needed = action === "delete" ? "delete" : "manage";
    if (context.kind === "delegated" && !context.permissions.includes(needed)) {
      return NextResponse.json(
        { success: false, message: "此帳號未被指派該項操作權限" },
        { status: 403 }
      );
    }

    let message: string;
    let auditDetails: string;
    if (action === "cancel") {
      const allowHardDelete =
        context.kind === "admin" || context.permissions.includes("delete");
      const result = await batchCancelCalendarEvents(ids, { allowHardDelete });
      const total = result.cancelled + result.deleted;
      message =
        result.deleted > 0
          ? `已批次下架 ${total} 筆（真實刪除）`
          : `已批次取消 ${result.cancelled} 筆行程`;
      auditDetails = `批次取消 ${total} 筆行程 id=${ids.join(",")}`;
    } else {
      const deleted = await batchDeleteCalendarEventsHard(ids);
      message = `已批次真實刪除 ${deleted} 筆行程`;
      auditDetails = `批次真實刪除 ${deleted} 筆行程 id=${ids.join(",")}`;
    }

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: action === "delete" ? "calendar_deleted" : "calendar_cancelled",
      ip: getClientIp(request),
      details: auditDetails,
    });

    const [events, settings] = await Promise.all([
      listAdminCalendarEvents(),
      getCalendarSettings(),
    ]);
    return NextResponse.json(
      { success: true, message, events, settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Batch calendar events error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
