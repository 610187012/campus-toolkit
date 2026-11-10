import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { toAuthResponse, verifySession } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getAnnouncementSettings, listSurfaceAnnouncements } from "@/lib/announcements";
import { isAnnouncementSurface } from "@/types/announcements";

const noStore = { "Cache-Control": "no-store" };

function entryClassCode(entry: Record<string, unknown> | null | undefined): string {
  if (!entry) return "";
  return typeof entry.classCode === "string" ? entry.classCode : "";
}

/**
 * GET：顯示位置的公告（系統首頁登入表單上方／四種身分功能首頁）。
 * ?surface=login｜student｜parent｜staff｜admin
 *
 * 閱讀權限：`surface=login`（未登入也可讀）只回「無（公開）」的公告；
 * 其餘位置須登入，依 session 身分過濾——管理員功能首頁可見全部公告。
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

    const surface = request.nextUrl.searchParams.get("surface");
    if (!isAnnouncementSurface(surface)) {
      return NextResponse.json({ success: false, message: "未知的顯示位置" }, { status: 400 });
    }

    const session = await verifySession();
    if (!session && surface !== "login") {
      return toAuthResponse({ status: 401, message: "未登入或登入已失效" });
    }

    const settings = await getAnnouncementSettings();
    const setting = settings.surfaces[surface];
    if (!setting.enabled) {
      return NextResponse.json(
        { success: true, surface: setting, enablePinned: settings.policies.enablePinned, items: [] },
        { headers: noStore }
      );
    }

    // 登入頁對所有人顯示同一份內容：一律只取公開公告
    const role = surface === "login" || !session ? null : session.role;
    const classCode = session ? entryClassCode(session.__entry) || null : null;
    const items = await listSurfaceAnnouncements(
      { surface, role, classCode },
      setting.limit
    );
    return NextResponse.json(
      { success: true, surface: setting, enablePinned: settings.policies.enablePinned, items },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Announcement surface error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
