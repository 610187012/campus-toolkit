import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { verifySession } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { listArchiveAnnouncements } from "@/lib/announcements";

const noStore = { "Cache-Control": "no-store" };

function entryClassCode(entry: Record<string, unknown> | null | undefined): string {
  if (!entry) return "";
  return typeof entry.classCode === "string" ? entry.classCode : "";
}

/**
 * GET：公告專頁（`/announcements`）的全部公告。
 *
 * 5 處顯示位置的「全部公告」入口共用此 API：未登入只回「無（公開）」的公告，
 * 登入者依 session 身分／班級過濾（管理員可見全部）。不需登入，故 session 可為 null。
 * 回傳上限 `ARCHIVE_LIMIT`（有界查詢），頁次切分由前端共用分頁元件負責。
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "announcements-inbox",
      RATE.ANNOUNCEMENTS_INBOX.limit,
      RATE.ANNOUNCEMENTS_INBOX.windowMs
    );
    if (limited) return limited;

    const session = await verifySession();
    const role = session?.role ?? null;
    const classCode = session ? entryClassCode(session.__entry) || null : null;
    const items = await listArchiveAnnouncements({ role, classCode });

    return NextResponse.json(
      { success: true, role, items, count: items.length },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Announcement archive error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
