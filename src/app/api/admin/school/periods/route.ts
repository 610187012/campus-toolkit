import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { logActivity, getClientIp } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { SETTINGS_COLLECTION } from "@/lib/settings-server";
import { invalidateAdminListCache } from "@/lib/list-cache";
import { cachedSettingDoc } from "@/lib/read-cache";
import {
  PERIODS_DOC_ID,
  defaultSchoolPeriods,
  readSchoolPeriods,
  validateSchoolPeriods,
  type SchoolPeriodsSetting,
} from "@/types/school-periods";
import { readJsonBody } from "@/lib/http-body";

const PERIODS_DOC = { collection: SETTINGS_COLLECTION, id: PERIODS_DOC_ID };
const MAX_BODY = 400_000;
const noStore = { "Cache-Control": "no-store" };

/**
 * 課表作息時間（學校基本設定 schoolSettings 的子功能）。
 * 守門用 requireAdminModule("schoolSettings")：adminModulesOf 對非超級一律剝除該模組，
 * 因此等同「僅超級管理員」，與頁面層的判斷保持同一把尺。
 *
 * 資料存 settings/schoolPeriods（獨立文件），同一個 Firestore 的各分支共用；
 * 文件不存在時讀回內建預設（每日八節＋午休）。
 */

/** GET：讀回課表作息時間（結構性資料，不按學期） */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "school-periods",
      RATE.SCHOOL_PERIODS_GET.limit,
      RATE.SCHOOL_PERIODS_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("schoolSettings");
    if (denial) return toAuthResponse(denial);

    // 課表作息時間：30 秒快取（setting-doc key），
    // PUT 成功後由 invalidateAdminListCache() 失效
    const ref = getAdminDb().collection(PERIODS_DOC.collection).doc(PERIODS_DOC.id);
    const snap = await cachedSettingDoc(PERIODS_DOC_ID, () => ref.get());
    let setting: SchoolPeriodsSetting;
    if (snap.exists) {
      setting = readSchoolPeriods(snap.data());
    } else {
      // 首次使用：把畫面看到的內建預設（每日八節＋午休）實際寫入資料庫，
      // 避免「表單有資料、資料庫卻沒有」讓新學校誤以為已完成設定，
      // 也讓其他模組（如自主學習計畫）能讀到同一份作息。
      setting = defaultSchoolPeriods();
      await ref.set({
        schoolDays: setting.schoolDays,
        periods: setting.periods.map((row) => ({ ...row })),
      });
      await invalidateAdminListCache();
    }
    return NextResponse.json({ success: true, setting }, { headers: noStore });
  } catch (error) {
    console.error("School periods GET error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PUT：整份覆寫課表作息時間（驗證不過一律 400，不寫入） */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "school-periods",
      RATE.SCHOOL_PERIODS_MUTATE.limit,
      RATE.SCHOOL_PERIODS_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("schoolSettings");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const raw = parsed.data;
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ success: false, message: "無效的設定內容" }, { status: 400 });
    }
    if (JSON.stringify(raw).length > MAX_BODY) {
      return NextResponse.json({ success: false, message: "設定過大" }, { status: 413 });
    }

    const body = raw as Record<string, unknown>;
    const checked = validateSchoolPeriods(body.setting);
    if (!checked.ok) {
      return NextResponse.json({ success: false, message: checked.message }, { status: 400 });
    }
    const setting = checked.value;

    await getAdminDb()
      .collection(PERIODS_DOC.collection)
      .doc(PERIODS_DOC.id)
      .set({
        schoolDays: setting.schoolDays,
        periods: setting.periods.map((row) => ({
          code: row.code,
          period: row.period,
          name: row.name,
          start: row.start,
          end: row.end,
        })),
      });

    // 設定文件寫入後統一失效讀取快取（規範：寫後失效），避免同程序的快取讀到舊值
    await invalidateAdminListCache();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "school_periods_updated",
      ip: getClientIp(request),
      details: `課表作息時間已更新（${setting.periods.length} 筆節次）`,
    });

    return NextResponse.json({ success: true, message: "課表作息時間已儲存", setting });
  } catch (error) {
    console.error("School periods PUT error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
