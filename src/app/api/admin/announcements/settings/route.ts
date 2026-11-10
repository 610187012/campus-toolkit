import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getAnnouncementSettings, saveAnnouncementSettings } from "@/lib/announcements";
import type {
  AnnouncementCategory,
  AnnouncementPolicies,
  AnnouncementSurfaces,
} from "@/types/announcements";
import { ANNOUNCEMENT_SURFACES, DEFAULT_ANNOUNCEMENT_POLICIES, normalizeSurfaceMethod } from "@/types/announcements";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

/** GET：讀取公告模組設定 */
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
    return NextResponse.json({ success: true, settings }, { headers: noStore });
  } catch (error) {
    console.error("Get announcement settings error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PUT：儲存公告模組設定（分類、顯示方式） */
export async function PUT(request: NextRequest) {
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

    const categories = Array.isArray(body.categories)
      ? (body.categories as unknown[]).map((item) => {
          const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          return {
            id: typeof row.id === "string" ? row.id : "",
            name: typeof row.name === "string" ? row.name : "",
            sortOrder: typeof row.sortOrder === "number" ? row.sortOrder : 0,
            enabled: row.enabled !== false,
          } satisfies AnnouncementCategory;
        })
      : undefined;

    // 5 個顯示位置：僅接受已知 key，欄位毀損時由 saveAnnouncementSettings 退回預設
    let surfaces: Partial<AnnouncementSurfaces> | undefined;
    if (body.surfaces && typeof body.surfaces === "object") {
      const raw = body.surfaces as Record<string, unknown>;
      surfaces = {};
      for (const key of ANNOUNCEMENT_SURFACES) {
        const row = raw[key];
        if (!row || typeof row !== "object") continue;
        const item = row as Record<string, unknown>;
        surfaces[key] = {
          enabled: item.enabled !== false,
          method: normalizeSurfaceMethod(item.method),
          limit: typeof item.limit === "number" && Number.isFinite(item.limit) ? item.limit : 5,
        };
      }
      if (Object.keys(surfaces).length === 0) surfaces = undefined;
    }

    // 公告原則：僅接受布林值，未提供／毀損的欄位退回預設
    let policies: AnnouncementPolicies | undefined;
    if (body.policies && typeof body.policies === "object") {
      const raw = body.policies as Record<string, unknown>;
      const pick = (key: keyof AnnouncementPolicies): boolean =>
        typeof raw[key] === "boolean" ? (raw[key] as boolean) : DEFAULT_ANNOUNCEMENT_POLICIES[key];
      policies = {
        enablePinned: pick("enablePinned"),
        forceExpire: pick("forceExpire"),
        hardDeleteExpired: pick("hardDeleteExpired"),
      };
    }

    const settings = await saveAnnouncementSettings({
      categories,
      surfaces,
      policies,
      defaultRemindersEnabled:
        typeof body.defaultRemindersEnabled === "boolean"
          ? body.defaultRemindersEnabled
          : undefined,
    });

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "announcements_settings_updated",
      ip: getClientIp(request),
      details: `更新公告模組設定（分類 ${settings.categories.length} 筆，顯示位置啟用 ${
        ANNOUNCEMENT_SURFACES.filter((key) => settings.surfaces[key].enabled).length
      }/5 處，原則：置頂=${settings.policies.enablePinned ? "開" : "關"}、強制到期=${
        settings.policies.forceExpire ? "開" : "關"
      }、真實刪除=${settings.policies.hardDeleteExpired ? "開" : "關"}、個人提醒=${
        settings.defaultRemindersEnabled ? "開" : "關"
      }）`,
    });

    return NextResponse.json(
      { success: true, message: "公告設定已儲存", settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Save announcement settings error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
