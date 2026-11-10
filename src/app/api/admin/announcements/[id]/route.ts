import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import {
  archiveAnnouncement,
  deleteAnnouncementHard,
  getAnnouncement,
  getAnnouncementSettings,
  listAdminAnnouncements,
  updateAnnouncement,
} from "@/lib/announcements";
import { ALL_ROLES } from "@/types/users";
import type { AnnouncementAudience } from "@/types/announcements";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

function parseAudience(raw: unknown, allowEmptyRoles = false): AnnouncementAudience | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const rawRoles = Array.isArray(data.roles) ? data.roles : [];
  const roles = ALL_ROLES.filter((role) => rawRoles.includes(role));
  if (roles.length === 0 && !allowEmptyRoles) return null;
  const classCodes = Array.isArray(data.classCodes)
    ? (data.classCodes as unknown[])
        .filter((code): code is string => typeof code === "string" && code.trim() !== "")
        .map((code) => code.trim().slice(0, 32))
        .slice(0, 50)
    : [];
  return { roles, classCodes };
}

type Params = { params: Promise<{ id: string }> };

/** GET：讀取單則公告 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const limited = enforceRateLimit(
      request,
      "announcements-admin",
      RATE.ANNOUNCEMENTS_ADMIN_GET.limit,
      RATE.ANNOUNCEMENTS_ADMIN_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("announcements");
    if (denial) return toAuthResponse(denial);

    const { id } = await params;
    const announcement = await getAnnouncement(id);
    if (!announcement) {
      return NextResponse.json({ success: false, message: "查無此公告" }, { status: 404 });
    }
    return NextResponse.json({ success: true, announcement }, { headers: noStore });
  } catch (error) {
    console.error("Get announcement error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PATCH：更新公告（含封存 status=archived） */
export async function PATCH(request: NextRequest, { params }: Params) {
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

    const { id } = await params;
    const existing = await getAnnouncement(id);
    if (!existing) {
      return NextResponse.json({ success: false, message: "查無此公告" }, { status: 404 });
    }

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    // 閱讀權限：「無」＝公開（isPublic）；未帶此欄位時沿用現值判斷
    const isPublic = typeof body.isPublic === "boolean" ? body.isPublic : undefined;
    const effectivePublic = isPublic ?? existing.isPublic;
    const audience =
      body.audience !== undefined ? parseAudience(body.audience, effectivePublic) : undefined;
    if (body.audience !== undefined && !audience) {
      return NextResponse.json(
        { success: false, message: "公告閱讀權限無效（請選擇「無」或至少一個身分）" },
        { status: 400 }
      );
    }

    const status =
      body.status === "archived"
        ? ("archived" as const)
        : body.status === "published"
          ? ("published" as const)
          : undefined;

    const { deleted } = await updateAnnouncement(id, {
      title: typeof body.title === "string" ? body.title : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
      categoryId: typeof body.categoryId === "string" ? body.categoryId : undefined,
      audience: audience ?? undefined,
      isPublic,
      publishAt: typeof body.publishAt === "number" ? body.publishAt : undefined,
      expireAt:
        body.expireAt === null
          ? null
          : typeof body.expireAt === "number"
            ? body.expireAt
            : undefined,
      pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
      status,
    });

    const isArchive = status === "archived" || deleted;
    const action = isArchive ? "announcements_archived" : "announcements_updated";
    await logActivity({
      userId: session.uid,
      role: "admin",
      action,
      ip: getClientIp(request),
      details: `${deleted ? "封存（真實刪除）" : isArchive ? "封存" : "更新"}公告 id=${id}`,
    });

    const announcements = await listAdminAnnouncements({ includeArchived: true });
    const settings = await getAnnouncementSettings();
    return NextResponse.json(
      {
        success: true,
        message: deleted ? "公告已真實刪除" : "公告已更新",
        announcements,
        settings,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Update announcement error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** POST：封存（快捷） */
export async function POST(request: NextRequest, { params }: Params) {
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

    const { id } = await params;
    const { deleted } = await archiveAnnouncement(id);
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "announcements_archived",
      ip: getClientIp(request),
      details: `${deleted ? "封存（真實刪除）" : "封存"}公告 id=${id}`,
    });
    const announcements = await listAdminAnnouncements({ includeArchived: true });
    const settings = await getAnnouncementSettings();
    return NextResponse.json(
      { success: true, message: deleted ? "公告已真實刪除" : "公告已封存", announcements, settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Archive announcement error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/**
 * DELETE：真實刪除公告（快捷）。
 * 無條件硬刪除——連同該公告的所有個人提醒文件一併從資料庫刪除，不可恢復
 * （不受「下架公告真實刪除」原則影響；該原則只管封存／到期時是否自動刪除）。
 */
export async function DELETE(request: NextRequest, { params }: Params) {
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

    const { id } = await params;
    const existing = await getAnnouncement(id);
    if (!existing) {
      return NextResponse.json({ success: false, message: "查無此公告" }, { status: 404 });
    }

    await deleteAnnouncementHard(id);
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "announcements_deleted",
      ip: getClientIp(request),
      details: `真實刪除公告 id=${id}（${existing.title}）`,
    });
    const announcements = await listAdminAnnouncements({ includeArchived: true });
    const settings = await getAnnouncementSettings();
    return NextResponse.json(
      { success: true, message: "公告已真實刪除", announcements, settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Delete announcement error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
