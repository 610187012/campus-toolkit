import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { logActivity, getClientIp } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { invalidateAdminListCache } from "@/lib/list-cache";
import { cachedSettingDoc } from "@/lib/read-cache";
import { SETTINGS_COLLECTION } from "@/lib/settings-server";
import {
  PROFILE_DOC_ID,
  readSchoolProfile,
  validateSchoolProfile,
} from "@/types/school-profile";
import { readJsonBody } from "@/lib/http-body";

const PROFILE_DOC = { collection: SETTINGS_COLLECTION, id: PROFILE_DOC_ID };
const MAX_BODY = 100_000;
const noStore = { "Cache-Control": "no-store" };

/**
 * 校務基本資料（學校基本設定 schoolSettings 的子功能）。
 * 守門用 requireAdminModule("schoolSettings")：adminModulesOf 對非超級一律剝除該模組，
 * 因此等同「僅超級管理員」，與頁面層的判斷保持同一把尺。
 */

/** GET：讀回校務基本資料（結構性資料，不按學期） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "school-profile",
      RATE.SCHOOL_PROFILE_GET.limit,
      RATE.SCHOOL_PROFILE_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("schoolSettings");
    if (denial) return toAuthResponse(denial);

    // 結構性資料：30 秒快取（key 與 api/admin/classes 同源），
    // PUT 成功後由 invalidateAdminListCache() 失效（同實例立即、跨實例 ≤30 秒）
    const snap = await cachedSettingDoc(PROFILE_DOC_ID, () =>
      getAdminDb().collection(PROFILE_DOC.collection).doc(PROFILE_DOC.id).get()
    );
    const profile = readSchoolProfile(snap.exists ? snap.data() : null);
    return NextResponse.json({ success: true, profile }, { headers: noStore });
  } catch (error) {
    console.error("School profile GET error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PUT：整份覆寫校務基本資料（驗證不過一律 400，不寫入） */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "school-profile",
      RATE.SCHOOL_PROFILE_MUTATE.limit,
      RATE.SCHOOL_PROFILE_MUTATE.windowMs
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
    const checked = validateSchoolProfile(body.profile);
    if (!checked.ok) {
      return NextResponse.json({ success: false, message: checked.message }, { status: 400 });
    }
    const profile = checked.value;

    await getAdminDb()
      .collection(PROFILE_DOC.collection)
      .doc(PROFILE_DOC.id)
      .set({
        schoolCode: profile.schoolCode,
        stages: profile.stages,
        seniorHighTypes: profile.seniorHighTypes,
        principal: profile.principal,
        vicePrincipals: profile.vicePrincipals,
        campuses: profile.campuses,
        website: profile.website,
      });

    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "school_profile_updated",
      ip: getClientIp(request),
      details: `校務基本資料已更新（${profile.stages.length} 個教育階段、${profile.campuses.length} 個校區）`,
    });

    return NextResponse.json({ success: true, message: "校務基本資料已儲存", profile });
  } catch (error) {
    console.error("School profile PUT error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
