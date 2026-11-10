import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import {
  batchArchiveAnnouncements,
  batchDeleteAnnouncementsHard,
  getAnnouncementSettings,
  listAdminAnnouncements,
} from "@/lib/announcements";
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
 * POST：批次處理勾選的公告。
 * body：`{ action: "archive" | "delete", ids: string[] }`
 * - archive：批次封存（原則「下架公告真實刪除」開啟時連同個人提醒硬刪除）
 * - delete：無條件真實刪除（連同個人提醒，不可恢復）
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "announcements-admin",
      RATE.ANNOUNCEMENTS_ADMIN_MUTATE.limit,
      RATE.ANNOUNCEMENTS_ADMIN_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("announcements");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const action = body.action === "archive" ? "archive" : body.action === "delete" ? "delete" : null;
    const ids = parseIds(body.ids);
    if (!action || ids.length === 0) {
      return NextResponse.json({ success: false, message: "請求內容無效（缺少 action 或 ids）" }, { status: 400 });
    }

    let message: string;
    let auditDetails: string;
    if (action === "archive") {
      const result = await batchArchiveAnnouncements(ids);
      const total = result.archived + result.deleted;
      message =
        result.deleted > 0
          ? `已批次下架 ${total} 則（真實刪除）`
          : `已批次封存 ${result.archived} 則公告`;
      auditDetails = `批次封存 ${total} 則公告 id=${ids.join(",")}`;
    } else {
      const deleted = await batchDeleteAnnouncementsHard(ids);
      message = `已批次真實刪除 ${deleted} 則公告`;
      auditDetails = `批次真實刪除 ${deleted} 則公告 id=${ids.join(",")}`;
    }

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: action === "delete" ? "announcements_deleted" : "announcements_archived",
      ip: getClientIp(request),
      details: auditDetails,
    });

    const announcements = await listAdminAnnouncements({ includeArchived: true });
    const settings = await getAnnouncementSettings();
    return NextResponse.json(
      { success: true, message, announcements, settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Batch announcements error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
