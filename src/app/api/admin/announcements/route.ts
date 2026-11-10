import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  createAnnouncement,
  getAnnouncementSettings,
  listAdminAnnouncements,
  purgeDownAnnouncements,
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

/** GET：管理端公告清單（含設定摘要） */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "announcements-admin",
      RATE.ANNOUNCEMENTS_ADMIN_GET.limit,
      RATE.ANNOUNCEMENTS_ADMIN_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("announcements");
    if (denial) return toAuthResponse(denial);

    const settings = await getAnnouncementSettings();
    // 下架原則＝真實刪除：清單載入時掃描封存／到期公告並刪除（含個人提醒）
    if (settings.policies.hardDeleteExpired) {
      await purgeDownAnnouncements();
    }
    const announcements = await listAdminAnnouncements({ includeArchived: true });
    return NextResponse.json(
      { success: true, announcements, settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("List announcements error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** POST：建立公告 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
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
    if (!body) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }
    // 閱讀權限：「無」＝公開（isPublic，不需登入），與身分選項互斥
    const isPublic = body.isPublic === true;
    const audience = parseAudience(body.audience, isPublic);
    if (!audience) {
      return NextResponse.json(
        { success: false, message: "公告閱讀權限無效（請選擇「無」或至少一個身分）" },
        { status: 400 }
      );
    }

    const period = await getCurrentPeriod();
    const { id } = await createAnnouncement({
      sourceModule: "announcements",
      title: typeof body.title === "string" ? body.title : "",
      body: typeof body.body === "string" ? body.body : "",
      categoryId: typeof body.categoryId === "string" ? body.categoryId : undefined,
      audience,
      isPublic,
      authorUid: session.uid,
      authorName: session.displayName || session.account,
      authorRole: "admin",
      publishAt: typeof body.publishAt === "number" ? body.publishAt : undefined,
      expireAt: typeof body.expireAt === "number" ? body.expireAt : null,
      pinned: body.pinned === true,
    });
    // 學期戳記由 publishFromModule 內部 getCurrentPeriod 寫入

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "announcements_created",
      ip: getClientIp(request),
      details: `建立公告（id=${id}，閱讀權限=${isPublic ? "無（公開）" : audience.roles.join("、") || "—"}，學年 ${period.academicYear}-${period.semester}）`,
    });

    const announcements = await listAdminAnnouncements({ includeArchived: true });
    const settings = await getAnnouncementSettings();
    return NextResponse.json(
      { success: true, message: "公告已發佈", id, announcements, settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Create announcement error:", error);
    return NextResponse.json(
      {
        success: false,
        message: serverErrorMessage(error, "系統錯誤"),
      },
      { status: 500 }
    );
  }
}
