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
import { ORG_DOC_ID, readOrgStructure } from "@/types/org";
import {
  SPACES_DOC_ID,
  SpaceOrgOption,
  readSpaceStructure,
  validateSpaceStructure,
} from "@/types/school-spaces";
import { readJsonBody } from "@/lib/http-body";

const SPACES_DOC = { collection: SETTINGS_COLLECTION, id: SPACES_DOC_ID };
const ORG_DOC = { collection: SETTINGS_COLLECTION, id: ORG_DOC_ID };
const MAX_BODY = 300_000;
const noStore = { "Cache-Control": "no-store" };

/**
 * 樓層空間設定（學校基本設定 schoolSettings 的子功能）。
 * 守門用 requireAdminModule("schoolSettings")：adminModulesOf 對非超級一律剝除該模組，
 * 因此等同「僅超級管理員」，與頁面層的判斷保持同一把尺。
 *
 * 「隸屬單位」引用單位層級設定（settings/school）的單位 code，故讀寫前都先取一次 org。
 */

/** 單位清單（供表單「隸屬單位」下拉樹狀縮排顯示）：取 code、名稱、層級與上級 */
function orgOptionsOf(raw: unknown): SpaceOrgOption[] {
  return readOrgStructure(raw).units.map((unit) => ({
    code: unit.code,
    name: unit.name,
    level: unit.level,
    parent: unit.parent,
  }));
}

/** 讀單位層級設定組成驗證上下文（隸屬單位是否存在）。
 * 僅供 PUT 驗證使用：改完單位要立刻看到新值，故不走快取（GET 另走 cachedSettingDoc）。 */
async function loadOrgCodes(): Promise<ReadonlySet<string>> {
  const snap = await getAdminDb().collection(ORG_DOC.collection).doc(ORG_DOC.id).get();
  return new Set(orgOptionsOf(snap.exists ? snap.data() : null).map((item) => item.code));
}

/** GET：讀回空間設定與單位選項（結構性資料，不按學期） */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "school-spaces",
      RATE.SCHOOL_SPACES_GET.limit,
      RATE.SCHOOL_SPACES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("schoolSettings");
    if (denial) return toAuthResponse(denial);

    // 兩份設定文件皆 30 秒快取（setting-doc key）；PUT 成功後 invalidateAdminListCache() 失效。
    // PUT 的驗證 context 不走快取（見 loadOrgCodes）
    const db = getAdminDb();
    const [snap, orgSnap] = await Promise.all([
      cachedSettingDoc(SPACES_DOC_ID, () =>
        db.collection(SPACES_DOC.collection).doc(SPACES_DOC.id).get()
      ),
      cachedSettingDoc(ORG_DOC_ID, () =>
        db.collection(ORG_DOC.collection).doc(ORG_DOC.id).get()
      ),
    ]);
    const setting = readSpaceStructure(snap.exists ? snap.data() : null);
    const orgUnits = orgOptionsOf(orgSnap.exists ? orgSnap.data() : null);
    return NextResponse.json({ success: true, setting, orgUnits }, { headers: noStore });
  } catch (error) {
    console.error("School spaces GET error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** PUT：整份覆寫空間設定（驗證不過一律 400，不寫入） */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "school-spaces",
      RATE.SCHOOL_SPACES_MUTATE.limit,
      RATE.SCHOOL_SPACES_MUTATE.windowMs
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
    const orgCodes = await loadOrgCodes();
    const checked = validateSpaceStructure(body.setting, { orgCodes });
    if (!checked.ok) {
      return NextResponse.json({ success: false, message: checked.message }, { status: 400 });
    }
    const setting = checked.value;

    await getAdminDb()
      .collection(SPACES_DOC.collection)
      .doc(SPACES_DOC.id)
      .set({
        levelCount: setting.levelCount,
        levelLabels: setting.levelLabels,
        units: setting.units,
      });

    // 設定文件寫入後統一失效讀取快取（規範：寫後失效），避免同程序的快取讀到舊值
    await invalidateAdminListCache();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "school_spaces_updated",
      ip: getClientIp(request),
      details: `樓層空間設定已更新（${setting.levelCount} 層、${setting.units.length} 個空間）`,
    });

    return NextResponse.json({ success: true, message: "樓層空間設定已儲存", setting });
  } catch (error) {
    console.error("School spaces PUT error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
