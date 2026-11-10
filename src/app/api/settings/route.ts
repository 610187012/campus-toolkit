import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  hasSettingsManage,
  isSuperAdmin,
  requireSettingsManage,
  toAuthResponse,
  verifySession,
} from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import {
  Settings,
  clampCacheTtlSeconds,
  defaultSettings,
  DEFAULT_STUDENT_PERSONAL_PHOTO_STORAGE,
  isStudentPersonalPhotoStorage,
} from "@/types/settings";
import { serverErrorMessage } from "@/lib/api-error";
import { invalidateSettingsCache, readSystemDoc, getCacheEpoch, bumpCacheEpoch, CACHE_EPOCH_FIELD } from "@/lib/settings-server";
import { invalidateReadCache, AUTHZ_CACHE_PREFIX } from "@/lib/read-cache";
import { getVisibleFeatureModuleValues } from "@/lib/feature-modules";
import { ROLE_ENABLED_FIELD } from "@/types/role-settings";
import {
  FEATURE_MODULES,
  FEATURE_MODULES_FIELD,
  FEATURE_MODULE_ROLES_FIELD,
} from "@/types/feature-modules";
import { readJsonBody } from "@/lib/http-body";

const SETTINGS_DOC = { collection: "settings", id: "system" };
const MAX_SETTINGS = 200_000;

// 公開 GET 只回傳展示用白名單欄位；
// contactPerson／contactEmail 等僅 admin 完整可見
const PUBLIC_SETTINGS_KEYS: (keyof Settings)[] = [
  "systemEnabled",
  "systemName",
  "schoolFullName",
  "schoolShortName",
  "schoolOtherNames",
  "academicYear",
  "semester",
  "cssThemeId",
  "copyrightNotice",
  "sponsorAdEnabled",
  "sessionTimeout",
  // 「帳號、身分與安全管理」頁需顯示「是否開放變更電子郵件」提示
  "emailChangeAllowed",
  // 未登入的首頁需依此決定是否顯示 Google 登入入口
  "oauthEnabled",
  // 列表頁（帳號／名冊／班級總覽）需依此決定是否改為按鈕手動顯示列表
  "dataSaverEnabled",
];

function pickPublicSettings(settings: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_SETTINGS_KEYS) {
    out[key] = settings[key];
  }
  return out as Partial<Settings>;
}

function pickSettings(raw: Record<string, unknown>): Settings {
  const out: Record<string, unknown> = { ...defaultSettings };
  const keys = Object.keys(defaultSettings) as (keyof Settings)[];
  for (const key of keys) {
    if (!(key in raw)) continue;
    const def = defaultSettings[key] as unknown;
    const val = raw[key];
    if (typeof def === "boolean") {
      out[key] = Boolean(val);
    } else if (typeof def === "number") {
      const n = Number(val);
      out[key] = Number.isFinite(n) ? n : def;
    } else {
      out[key] = typeof val === "string" ? val.slice(0, 500) : def;
    }
  }
  return out as unknown as Settings;
}

export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "settings-get",
      RATE.SETTINGS_GET.limit,
      RATE.SETTINGS_GET.windowMs
    );
    if (limited) return limited;

    const noStore = { "Cache-Control": "no-store" };
    const session = await verifySession();
    // 完整設定（含聯絡人等欄位）對全體管理員可讀（屬性分級已退役，政策修改書決議二）；
    // manageable 供「系統設定」頁判斷是否顯示設定表單
    const manageable = session ? await hasSettingsManage(session) : false;

    // 讀全站共用的 settings/system 快取（同文件已由 verifySession 的設定檢查等讀過，
    // 不再重複打 Firestore）；寫入後同程序會 invalidateSettingsCache，維持正確性
    const data = (await readSystemDoc()) ?? {};
    const settings = pickSettings(data);
    // 目前身分可見的功能模組：首頁卡片過濾用
    // 管理員恆全權（isSuperAdmin＝有管理員條目即 true），回傳註冊表全部代碼
    const visibleModules = session
      ? session.role === "admin" && (await isSuperAdmin(session))
        ? FEATURE_MODULES.map((item) => item.value)
        : await getVisibleFeatureModuleValues(session.role)
      : [];
    return NextResponse.json(
      {
        success: true,
        settings: manageable ? settings : pickPublicSettings(settings),
        manageable,
        visibleModules,
        // 清單快取的跨實例失效旗標：前端 list-store 以此判斷已持有的清單是否需重抓
        cacheEpoch: await getCacheEpoch(),
      },
      { headers: noStore }
    );
  } catch {
    return NextResponse.json(
      {
        success: true,
        settings: pickPublicSettings(defaultSettings),
        manageable: false,
        // 故意不回 visibleModules：前端視為「尚未載入」、不過濾卡片，
        // 避免設定讀取失敗時管理員首頁全空
        cacheEpoch: await getCacheEpoch().catch(() => 0),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "settings-put",
      30,
      60_000
    );
    if (limited) return limited;

    // 系統設定的寫入僅超級管理員（頁面對一般管理員不顯示設定表單）
    const { session, denial } = await requireSettingsManage();
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const raw = parsed.data;
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ success: false, message: "無效的設定內容" }, { status: 400 });
    }
    const body = raw as Record<string, unknown>;
    if (JSON.stringify(body).length > MAX_SETTINGS) {
      return NextResponse.json({ success: false, message: "設定過大" }, { status: 413 });
    }

    const settings = pickSettings(body);
    if (settings.sessionTimeout < 1) settings.sessionTimeout = 1;
    settings.cacheTtlSeconds = clampCacheTtlSeconds(settings.cacheTtlSeconds);
    if (!isStudentPersonalPhotoStorage(settings.studentPersonalPhotoStorage)) {
      settings.studentPersonalPhotoStorage = DEFAULT_STUDENT_PERSONAL_PHOTO_STORAGE;
    }

    // 不使用 merge：整份覆寫，讓已廢棄欄位（例如 oauthClientId）
    // 在下次儲存設定時自動從 Firestore settings/system 清除。
    // 身分開關（roleEnabled）、功能模組啟用狀態（featureModulesEnabled）與
    // 模組身分開關（featureModuleRoles）不屬於本表單欄位，覆寫時保留，
    // 避免儲存系統設定把它們重置。
    const ref = getAdminDb().collection(SETTINGS_DOC.collection).doc(SETTINGS_DOC.id);
    const existing = await ref.get();
    const preserved: Record<string, unknown> = {};
    if (existing.exists) {
      const raw = existing.data() as Record<string, unknown>;
      // cacheEpoch 必須保留並遞增：整份覆寫若抹掉它，epoch 會倒退，
      // 可能撞上程序內仍存活的舊清單 key（10 分鐘硬上限內）而復活舊 payload
      for (const field of [
        ROLE_ENABLED_FIELD,
        FEATURE_MODULES_FIELD,
        FEATURE_MODULE_ROLES_FIELD,
        CACHE_EPOCH_FIELD,
      ]) {
        if (raw[field] !== undefined) preserved[field] = raw[field];
      }
    }
    await ref.set({ ...settings, ...preserved });
    invalidateSettingsCache();
    // 設定變更（學年度／學期等）會影響名冊清單內容與驗證基線的期間判定：
    // 跨實例失效旗標一併遞增（epoch 在 authz key 內），本機 authz 快取同步清除
    invalidateReadCache(AUTHZ_CACHE_PREFIX);
    await bumpCacheEpoch();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "settings_change",
      ip: getClientIp(request),
      details: "系統設定已更新",
    });

    return NextResponse.json({
      success: true,
      settings,
      message: "設定已儲存",
      // 讓剛儲存的前端立即採用新 epoch（清單快取同步失效）
      cacheEpoch: await getCacheEpoch(),
    });
  } catch (error) {
    console.error("Settings PUT error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
