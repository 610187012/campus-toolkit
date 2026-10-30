import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import type { UserRole } from "@/types/users";
import { publishFromModule, updateFromModule } from "@/lib/announcements";
import { publishScheduleFromModule } from "@/lib/calendar";
import { getCurrentPeriod } from "@/lib/settings-server";
import { schoolWideAudience } from "@/types/announcements";
import { getAvailableWeeks, getClassOptions, getFullWeeks, getSchoolScheduleOptions, getSettings, getSpaceOptions, getStaffCandidates, saveSettings } from "../../../lib/self-directed-learning";
import { parseSettingsInput, stripHtmlToText } from "../../../types/self-directed-learning";

const noStore = { "Cache-Control": "no-store" };

const MODULE_VALUE = "selfDirectedLearning";
const ANNOUNCE_SOURCE_REF = "open-window";
const CALENDAR_SOURCE_REF = "open-window";

/** 主程式的 serverErrorMessage 等價小工具（模組不得依賴非公開面檔案 `@/lib/api-error`） */
function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

function formatDateTime(epoch: number): string {
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 掛勾同步（§6 總則）：送審時間 → 公告（update→publish，固定 sourceRef 不重複發文）
 * ＋行事曆（publishScheduleFromModule 同 sourceRef 覆寫更新）。
 * 兩者由管理人員分別勾選；未勾選的項目完全不做動。
 * 掛勾失敗不阻擋設定儲存——回 hookWarning 供頁面提示。
 */
async function syncWindowHooks(
  settings: Awaited<ReturnType<typeof getSettings>>,
  actor: { uid: string; name: string; role: UserRole },
  options: { announcement: boolean; calendar: boolean }
): Promise<string | null> {
  const { openAt, closeAt } = settings;
  if (!options.announcement && !options.calendar) return null;
  try {
    const period = await getCurrentPeriod();
    // 發送對象：學生、家長、教職員
    const audience = schoolWideAudience(["student", "parent", "staff"]);
    const calendarAudience = {
      roles: ["student", "parent", "staff"] as UserRole[],
      classCodes: [] as string[],
    };

    if (openAt !== null && closeAt !== null) {
      const title = "自主學習計畫送審期間";
      const window = `送審時間：${formatDateTime(openAt)} ～ ${formatDateTime(closeAt)}。`;
      // 說明可能含富文本格式：公告／行事曆內容一律轉為純文字
      const instructionsText = stripHtmlToText(settings.instructions).trim();
      const body = instructionsText ? `${window}\n${instructionsText}` : window;

      if (options.announcement) {
        const updated = await updateFromModule({
          sourceModule: MODULE_VALUE,
          sourceRef: ANNOUNCE_SOURCE_REF,
          title,
          body,
          audience,
          publishAt: openAt,
          expireAt: closeAt,
          status: "published",
        });
        if (updated.updated === 0) {
          await publishFromModule({
            sourceModule: MODULE_VALUE,
            sourceRef: ANNOUNCE_SOURCE_REF,
            title,
            body,
            authorUid: actor.uid,
            authorName: actor.name,
            authorRole: actor.role,
            audience,
            publishAt: openAt,
            expireAt: closeAt,
          });
        }
      }

      if (options.calendar) {
        await publishScheduleFromModule({
          sourceModule: MODULE_VALUE,
          sourceRef: CALENDAR_SOURCE_REF,
          title,
          description: body,
          startAt: openAt,
          endAt: closeAt,
          audience: calendarAudience,
          createdBy: { uid: actor.uid, name: actor.name, role: actor.role },
          academicYear: period.academicYear,
          semester: period.semester === 2 ? 2 : 1,
        });
      }
    } else {
      // 時間被清空：只處理管理人員有勾選同步的項目
      if (options.announcement) {
        await updateFromModule({
          sourceModule: MODULE_VALUE,
          sourceRef: ANNOUNCE_SOURCE_REF,
          status: "archived",
        });
      }
      if (options.calendar) {
        await publishScheduleFromModule({
          sourceModule: MODULE_VALUE,
          sourceRef: CALENDAR_SOURCE_REF,
          status: "cancelled",
        }).catch(() => undefined);
      }
    }
    return null;
  } catch (error) {
    console.warn("selfDirectedLearning hook sync failed:", error);
    return "設定已儲存，但公告／行事曆同步失敗——請重新儲存或至公告與行事曆頁手動確認";
  }
}

/** GET：回傳設定（含 lazy init 預設值） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-admin",
      RATE.SELF_DIRECTED_LEARNING_ADMIN.limit,
      RATE.SELF_DIRECTED_LEARNING_ADMIN.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireModulePermission("selfDirectedLearning", "configure");
    if (denial) return toAuthResponse(denial);

    const settings = await getSettings();
    const [fullWeeks, availableWeeks, scheduleOptions, spaceOptions, staffCandidates, classOptions] =
      await Promise.all([
        getFullWeeks(),
        getAvailableWeeks(settings.slots),
        getSchoolScheduleOptions(),
        getSpaceOptions(),
        getStaffCandidates(),
        getClassOptions(),
      ]);
    return NextResponse.json(
      {
        success: true,
        settings,
        fullWeeks,
        availableWeeks,
        periodOptions: scheduleOptions.periods,
        schoolDays: scheduleOptions.schoolDays,
        spaceOptions,
        staffCandidates,
        classOptions,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("selfDirectedLearning settings GET error:", error);
    return NextResponse.json({ success: false, message: errorMessage(error, "讀取設定失敗") }, { status: 500, headers: noStore });
  }
}

/** POST：儲存設定（限流＋CSRF＋權限＋稽核） */
export async function POST(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-admin-mutate",
      RATE.SELF_DIRECTED_LEARNING_ADMIN.limit,
      RATE.SELF_DIRECTED_LEARNING_ADMIN.windowMs
    );
    if (limited) return limited;
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const { context, denial } = await requireModulePermission("selfDirectedLearning", "configure");
    if (denial || !context) return toAuthResponse(denial!);
    const session = context.session;

    const parsed = parseSettingsInput(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ success: false, message: parsed.message }, { status: 400, headers: noStore });
    }

    // 下限週數不可超過實際可寫週數（全校層級活動；班級個別活動由學生端即時檢核）
    const available = await getAvailableWeeks(parsed.value.slots);
    if (
      parsed.value.weekMode === "flexible" &&
      available &&
      parsed.value.minWeeks > available.available
    ) {
      return NextResponse.json(
        {
          success: false,
          message: `可寫週數只有 ${available.available} 週（總週數 ${available.total} 週），下限 ${parsed.value.minWeeks} 週會使學生無法填滿；請降低下限或調整節次行程／學校活動。`,
        },
        { status: 400, headers: noStore }
      );
    }

    const settings = await saveSettings(parsed.value);
    // 公告與行事曆只由管理人員分別勾選後才同步；未勾選一律不自動發送
    const hookWarning =
      settings.publishAnnouncement || settings.publishCalendar
        ? await syncWindowHooks(
            settings,
            {
              uid: session.uid,
              name: session.displayName || session.account,
              role: session.role === "admin" ? "admin" : "staff",
            },
            { announcement: settings.publishAnnouncement, calendar: settings.publishCalendar }
          )
        : null;
    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "self_directed_learning_settings_updated",
      ip: getClientIp(request),
      details: `更新管理規則（總開關、送審時間、週數形式與審核設定；同步公告：${
        settings.publishAnnouncement ? "是" : "否"
      }、同步行事曆：${settings.publishCalendar ? "是" : "否"}）`,
    });
    return NextResponse.json(
      { success: true, settings, availableWeeks: available, ...(hookWarning ? { hookWarning } : {}) },
      { headers: noStore }
    );
  } catch (error) {
    console.error("selfDirectedLearning settings POST error:", error);
    return NextResponse.json({ success: false, message: errorMessage(error, "儲存設定失敗") }, { status: 500, headers: noStore });
  }
}
