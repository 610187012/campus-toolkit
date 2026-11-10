import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { verifySession } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  getAnnouncementSettings,
  invalidateAnnouncementsCache,
} from "@/lib/announcements";
import {
  ANNOUNCEMENTS_COLLECTION,
  audienceClassScoped,
  isAnnouncementReadable,
  readAnnouncementRecord,
  announcementCategoryName,
} from "@/types/announcements";

const noStore = { "Cache-Control": "no-store" };

function entryClassCode(entry: Record<string, unknown> | null | undefined): string {
  if (!entry) return "";
  return typeof entry.classCode === "string" ? entry.classCode : "";
}

type Params = { params: Promise<{ id: string }> };

/**
 * GET：讀取單則公告內容（顯示位置「跳出新頁」用）。
 * 權限與顯示位置一致：
 * - 公開公告（isPublic）：不需登入即可讀取；
 * - 一般身分：須登入且 audienceRoles 含該身分；
 * - 班級公告：另須名冊班級相符；
 * - 管理員：可讀取全部。
 */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "announcements-inbox",
      RATE.ANNOUNCEMENTS_INBOX.limit,
      RATE.ANNOUNCEMENTS_INBOX.windowMs
    );
    if (limited) return limited;

    const { id } = await params;
    if (!id || id.length > 64) {
      return NextResponse.json({ success: false, message: "查無此公告" }, { status: 404 });
    }

    const session = await verifySession();

    const snap = await getAdminDb().collection(ANNOUNCEMENTS_COLLECTION).doc(id).get();
    if (!snap.exists) {
      return NextResponse.json({ success: false, message: "查無此公告" }, { status: 404 });
    }
    const record = readAnnouncementRecord(id, snap.data());
    if (!record || !isAnnouncementReadable(record)) {
      return NextResponse.json({ success: false, message: "公告不存在或已無法閱讀" }, { status: 404 });
    }

    // 公開公告：任何人可讀
    if (record.isPublic) {
      const settings = await getAnnouncementSettings();
      return NextResponse.json(
        {
          success: true,
          announcement: {
            id: record.id,
            title: record.title,
            body: record.body,
            categoryId: record.categoryId,
            categoryName: announcementCategoryName(settings, record.categoryId),
            authorName: record.authorName,
            publishAt: record.publishAt,
            expireAt: record.expireAt,
            pinned: record.pinned === true,
            isPublic: true,
            classScoped: false,
          },
        },
        { headers: noStore }
      );
    }

    // 非公開公告：須登入
    if (!session) {
      return NextResponse.json({ success: false, message: "請登入後再查看此公告" }, { status: 401 });
    }

    // 管理員：可讀取全部
    if (session.role === "admin") {
      const settings = await getAnnouncementSettings();
      return NextResponse.json(
        {
          success: true,
          announcement: {
            id: record.id,
            title: record.title,
            body: record.body,
            categoryId: record.categoryId,
            categoryName: announcementCategoryName(settings, record.categoryId),
            authorName: record.authorName,
            publishAt: record.publishAt,
            expireAt: record.expireAt,
            pinned: record.pinned === true,
            isPublic: false,
            classScoped: audienceClassScoped(record.audience),
          },
        },
        { headers: noStore }
      );
    }

    // 一般身分：須受眾包含該身分
    if (!record.audience.roles.includes(session.role)) {
      return NextResponse.json({ success: false, message: "無權限閱讀此公告" }, { status: 403 });
    }

    // 班級公告：須名冊班級相符
    if (audienceClassScoped(record.audience)) {
      const classCode = entryClassCode(session.__entry);
      if (!classCode || !record.audience.classCodes.includes(classCode)) {
        return NextResponse.json({ success: false, message: "無權限閱讀此公告" }, { status: 403 });
      }
    }

    const settings = await getAnnouncementSettings();
    return NextResponse.json(
      {
        success: true,
        announcement: {
          id: record.id,
          title: record.title,
          body: record.body,
          categoryId: record.categoryId,
          categoryName: announcementCategoryName(settings, record.categoryId),
          authorName: record.authorName,
          publishAt: record.publishAt,
          expireAt: record.expireAt,
          pinned: record.pinned === true,
          isPublic: false,
          classScoped: audienceClassScoped(record.audience),
        },
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Get announcement detail error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

// 避免未使用的 import 告警（invalidateAnnouncementsCache 預留供後續快取失效）
void invalidateAnnouncementsCache;
