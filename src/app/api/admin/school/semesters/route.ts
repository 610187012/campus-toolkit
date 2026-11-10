import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { logActivity, getClientIp } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { invalidateReadCache, AUTHZ_CACHE_PREFIX } from "@/lib/read-cache";
import {
  bumpCacheEpoch,
  getCacheEpoch,
  invalidateSettingsCache,
  readSystemDoc,
  SETTINGS_COLLECTION,
  SETTINGS_DOC_ID,
} from "@/lib/settings-server";
import {
  SEMESTER_SETTINGS_FIELDS,
  readSemesterSettings,
  validateSemesterSettings,
} from "@/types/school-semesters";
import { readJsonBody } from "@/lib/http-body";

const MAX_BODY = 10_000;
const noStore = { "Cache-Control": "no-store" };

/**
 * 學期起訖設定（學校基本設定 schoolSettings 的子功能，危險區）。
 * 學年度／學期與起訖日期存於 `settings/system`，因此只做 **merge 部分更新**
 * （SEMESTER_SETTINGS_FIELDS 白名單），絕不整份覆寫系統設定文件。
 * 守門用 requireAdminModule("schoolSettings")：等同僅超級管理員。
 */

/** GET：讀回學期起訖設定（讀共用快取，不重打 Firestore） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "school-semesters",
      RATE.SCHOOL_SEMESTERS_GET.limit,
      RATE.SCHOOL_SEMESTERS_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("schoolSettings");
    if (denial) return toAuthResponse(denial);

    const data = (await readSystemDoc()) ?? {};
    const settings = readSemesterSettings(data);
    return NextResponse.json({ success: true, settings }, { headers: noStore });
  } catch (error) {
    console.error("School semesters GET error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PUT：merge 更新學期起訖白名單欄位（驗證不過一律 400，不寫入） */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "school-semesters",
      RATE.SCHOOL_SEMESTERS_MUTATE.limit,
      RATE.SCHOOL_SEMESTERS_MUTATE.windowMs
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
    const checked = validateSemesterSettings(body.settings);
    if (!checked.ok) {
      return NextResponse.json({ success: false, message: checked.message }, { status: 400 });
    }
    const settings = checked.value;

    // 只更新白名單欄位（merge）：其餘系統設定欄位（含 roleEnabled、cacheEpoch 等）不受影響
    const payload: Record<string, unknown> = {};
    for (const field of SEMESTER_SETTINGS_FIELDS) {
      payload[field] = settings[field];
    }
    await getAdminDb()
      .collection(SETTINGS_COLLECTION)
      .doc(SETTINGS_DOC_ID)
      .set(payload, { merge: true });

    // 學年度／學期變更會影響名冊等清單的期間基準：同 PUT /api/settings 的失效策略
    invalidateSettingsCache();
    invalidateReadCache(AUTHZ_CACHE_PREFIX);
    await bumpCacheEpoch();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "school_semesters_updated",
      ip: getClientIp(request),
      details: `學期起訖設定已更新（${settings.academicYear} 學年度 第${settings.semester}學期）`,
    });

    return NextResponse.json({
      success: true,
      message: "學期起訖設定已儲存",
      settings,
      cacheEpoch: await getCacheEpoch(),
    });
  } catch (error) {
    console.error("School semesters PUT error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
