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
import { ORG_DOC_ID, readOrgStructure, validateOrgStructure } from "@/types/org";
import { readJsonBody } from "@/lib/http-body";

const ORG_DOC = { collection: SETTINGS_COLLECTION, id: ORG_DOC_ID };
const MAX_BODY = 100_000;
const noStore = { "Cache-Control": "no-store" };

/**
 * 單位層級設定（學校基本設定 schoolSettings 的子功能）。
 * 守門用 requireAdminModule("schoolSettings")：adminModulesOf 對非超級一律剝除該模組，
 * 因此等同「僅超級管理員」，與頁面層的判斷保持同一把尺。
 */

/** GET：讀回單位層級設定（結構性資料，不按學期） */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "school-org",
      RATE.SCHOOL_ORG_GET.limit,
      RATE.SCHOOL_ORG_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("schoolSettings");
    if (denial) return toAuthResponse(denial);

    // 結構性資料：30 秒快取（setting-doc key），PUT 成功後 invalidateAdminListCache() 失效
    const snap = await cachedSettingDoc(ORG_DOC_ID, () =>
      getAdminDb().collection(ORG_DOC.collection).doc(ORG_DOC.id).get()
    );
    const org = readOrgStructure(snap.exists ? snap.data() : null);
    return NextResponse.json({ success: true, org }, { headers: noStore });
  } catch (error) {
    console.error("School org GET error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PUT：整份覆寫單位層級設定（驗證不過一律 400，不寫入） */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "school-org",
      RATE.SCHOOL_ORG_MUTATE.limit,
      RATE.SCHOOL_ORG_MUTATE.windowMs
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
    const checked = validateOrgStructure(body.org);
    if (!checked.ok) {
      return NextResponse.json({ success: false, message: checked.message }, { status: 400 });
    }
    const org = checked.value;

    await getAdminDb()
      .collection(ORG_DOC.collection)
      .doc(ORG_DOC.id)
      .set({
        levelCount: org.levelCount,
        levelLabels: org.levelLabels,
        units: org.units,
      });

    // 設定文件寫入後統一失效讀取快取（規範：寫後失效），避免同程序的快取讀到舊值
    await invalidateAdminListCache();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "school_org_updated",
      ip: getClientIp(request),
      details: `單位層級設定已更新（${org.levelCount} 層、${org.units.length} 個單位）`,
    });

    return NextResponse.json({ success: true, message: "單位層級設定已儲存", org });
  } catch (error) {
    console.error("School org PUT error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
