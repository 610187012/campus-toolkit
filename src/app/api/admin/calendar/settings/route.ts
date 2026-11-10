import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getAdminDb } from "@/lib/firebase-admin";
import { cachedSettingDoc } from "@/lib/read-cache";
import { SETTINGS_COLLECTION } from "@/lib/settings-server";
import { getCalendarSettings, getSchoolClassOptions, getSchoolPeriods, saveCalendarSettings } from "@/lib/calendar";
import { ORG_DOC_ID, readOrgStructure } from "@/types/org";
import { SPACES_DOC_ID, readSpaceStructure } from "@/types/school-spaces";
import type { CalendarCategory, CalendarPolicies, CalendarSurfaces } from "@/types/calendar";
import {
  CALENDAR_SURFACES,
  CALENDAR_SURFACE_LIMIT_DEFAULT,
  DEFAULT_CALENDAR_POLICIES,
  calendarAccessOf,
  normalizePublicPastMonths,
} from "@/types/calendar";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };

/** GET：讀取行事曆模組設定（含單位層級、樓層空間選項，供「發佈單位」「地點」下拉） */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "calendar-admin",
      RATE.CALENDAR_ADMIN_GET.limit,
      RATE.CALENDAR_ADMIN_GET.windowMs
    );
    if (limited) return limited;

    const { context, denial } = await requireModulePermission("calendar");
    if (denial) return toAuthResponse(denial);
    const access = calendarAccessOf(context.kind === "admin" ? null : context.permissions);

    const [settings, schoolPeriods, classGrades, orgSnap, spacesSnap] = await Promise.all([
      getCalendarSettings(),
      // 課表作息：表單「套用課表時間」與批次匯入的節次來源
      getSchoolPeriods(),
      // 年段班級：學校活動層級（年級／班級勾選）
      getSchoolClassOptions(),
      // 單位層級／樓層空間設定 30 秒快取（setting-doc key，同源失效）
      cachedSettingDoc(ORG_DOC_ID, () =>
        getAdminDb().collection(SETTINGS_COLLECTION).doc(ORG_DOC_ID).get()
      ),
      cachedSettingDoc(SPACES_DOC_ID, () =>
        getAdminDb().collection(SETTINGS_COLLECTION).doc(SPACES_DOC_ID).get()
      ),
    ]);
    const orgUnits = readOrgStructure(orgSnap.exists ? orgSnap.data() : null).units.map(
      ({ code, name, level, parent }) => ({ code, name, level, parent })
    );
    const spaceOptions = readSpaceStructure(spacesSnap.exists ? spacesSnap.data() : null).units.map(
      ({ code, name, parent }) => ({ code, name, parent })
    );
    return NextResponse.json(
      { success: true, settings, schoolPeriods, classGrades, orgUnits, spaceOptions, access },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Get calendar settings error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PUT：儲存行事曆模組設定（行程類型、顯示位置、行程原則、個人提醒開關） */
export async function PUT(request: NextRequest) {
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

    const { context, denial } = await requireModulePermission("calendar", "settings");
    if (denial) return toAuthResponse(denial);
    const session = context.session;

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
          } satisfies CalendarCategory;
        })
      : undefined;

    // 5 個顯示位置：僅接受已知 key，欄位毀損時由 saveCalendarSettings 退回預設
    let surfaces: Partial<CalendarSurfaces> | undefined;
    if (body.surfaces && typeof body.surfaces === "object") {
      const raw = body.surfaces as Record<string, unknown>;
      surfaces = {};
      for (const key of CALENDAR_SURFACES) {
        const row = raw[key];
        if (!row || typeof row !== "object") continue;
        const item = row as Record<string, unknown>;
        surfaces[key] = {
          enabled: item.enabled !== false,
          limit:
            typeof item.limit === "number" && Number.isFinite(item.limit)
              ? item.limit
              : CALENDAR_SURFACE_LIMIT_DEFAULT,
        };
      }
      if (Object.keys(surfaces).length === 0) surfaces = undefined;
    }

    // 行程原則：僅接受布林值，未提供／毀損的欄位退回預設
    let policies: Partial<CalendarPolicies> | undefined;
    if (body.policies && typeof body.policies === "object") {
      const raw = body.policies as Record<string, unknown>;
      policies = {
        hardDeleteCancelled:
          typeof raw.hardDeleteCancelled === "boolean"
            ? raw.hardDeleteCancelled
            : DEFAULT_CALENDAR_POLICIES.hardDeleteCancelled,
        publicPastMonths:
          typeof raw.publicPastMonths === "number"
            ? normalizePublicPastMonths(raw.publicPastMonths)
            : DEFAULT_CALENDAR_POLICIES.publicPastMonths,
      };
    }

    const settings = await saveCalendarSettings({
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
      role: session.role,
      action: "calendar_settings_updated",
      ip: getClientIp(request),
      details: `更新行事曆模組設定（分類 ${settings.categories.length} 筆，顯示位置啟用 ${
        CALENDAR_SURFACES.filter((key) => settings.surfaces[key].enabled).length
      }/5 處，原則：下架真實刪除=${
        settings.policies.hardDeleteCancelled ? "開" : "關"
      }，個人提醒 ${settings.defaultRemindersEnabled ? "啟用" : "停用"}）`,
    });

    return NextResponse.json(
      { success: true, message: "行程類型設定已儲存", settings },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Save calendar settings error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
