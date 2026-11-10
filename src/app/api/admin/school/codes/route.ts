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
import { CODES_DOC_ID, readSchoolCodes, validateSchoolCodes } from "@/types/school-codes";
import { readJsonBody } from "@/lib/http-body";

const CODES_DOC = { collection: SETTINGS_COLLECTION, id: CODES_DOC_ID };
const MAX_BODY = 400_000;
const noStore = { "Cache-Control": "no-store" };

/**
 * 各式代碼表（學校基本設定 schoolSettings 的子功能，系統的基礎資料庫）。
 * 守門用 requireAdminModule("schoolSettings")：adminModulesOf 對非超級一律剝除該模組，
 * 因此等同「僅超級管理員」，與頁面層的判斷保持同一把尺。
 *
 * 資料存 settings/schoolCodes（獨立文件），同一個 Firestore 的各分支共用；
 * 文件不存在時讀回內建的官方代碼表。
 */

/** GET：讀回各式代碼表（結構性資料，不按學期） */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "school-codes",
      RATE.SCHOOL_CODES_GET.limit,
      RATE.SCHOOL_CODES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("schoolSettings");
    if (denial) return toAuthResponse(denial);

    // 代碼表（系統基礎資料庫）：30 秒快取（setting-doc key），
    // PUT 成功後由 invalidateAdminListCache() 失效
    const snap = await cachedSettingDoc(CODES_DOC_ID, () =>
      getAdminDb().collection(CODES_DOC.collection).doc(CODES_DOC.id).get()
    );
    const setting = readSchoolCodes(snap.exists ? snap.data() : null);
    return NextResponse.json({ success: true, setting }, { headers: noStore });
  } catch (error) {
    console.error("School codes GET error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PUT：整份覆寫各式代碼表（驗證不過一律 400，不寫入） */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "school-codes",
      RATE.SCHOOL_CODES_MUTATE.limit,
      RATE.SCHOOL_CODES_MUTATE.windowMs
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
    const checked = validateSchoolCodes(body.setting);
    if (!checked.ok) {
      return NextResponse.json({ success: false, message: checked.message }, { status: 400 });
    }
    const setting = checked.value;

    await getAdminDb()
      .collection(CODES_DOC.collection)
      .doc(CODES_DOC.id)
      .set({
        schoolTypes: setting.schoolTypes.map((item) => ({ code: item.code, name: item.name })),
        groups: setting.groups.map((item) => ({ code: item.code, name: item.name })),
        departments: setting.departments.map((item) => ({ code: item.code, name: item.name })),
      });

    // 設定文件寫入後統一失效讀取快取（規範：寫後失效），避免同程序的快取讀到舊值
    await invalidateAdminListCache();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "school_codes_updated",
      ip: getClientIp(request),
      details: `各式代碼表已更新（類型 ${setting.schoolTypes.length} 筆、群別 ${setting.groups.length} 筆、科別 ${setting.departments.length} 筆）`,
    });

    return NextResponse.json({ success: true, message: "代碼表已儲存", setting });
  } catch (error) {
    console.error("School codes PUT error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
