import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import { getSession, SessionPayload } from "@/lib/server-session";
import { isJtiRevoked } from "@/lib/revocation";
import { getClientIp } from "@/lib/audit";
import { ensureReadScope } from "@/lib/read-stats";
import {
  getSessionTimeoutMinutes,
  getCurrentPeriod,
  getCacheEpoch,
  isSystemEnabled,
} from "@/lib/settings-server";
import { cachedAuthzDocs, AuthzDocs } from "@/lib/read-cache";
import {
  adminModulesOf,
  getRosterEntry,
  isActiveEntry,
  managedModulesOf,
} from "@/lib/roster";
import { isRoleEnabled } from "@/lib/role-settings";
import { AdminModule, isAccountActive, USER_COLLECTION, UserRole } from "@/types/users";
import { ManagedModuleGrant } from "@/types/roster";
import { matchesModuleInstallAdmin, parseModuleInstallAdmins } from "@/lib/module-install-policy";

/**
 * verifySession 回傳的 session 會掛上「同請求內已讀取」的資料：
 * `__user`＝使用者文件、`__entry`＝當期身分名冊條目。
 * 同請求後續的權限判定（hasAdminModule／isSuperAdmin）與端點（/api/auth/me 等）
 * 一律優先復用，避免重複讀取同一文件（見 docs/資料庫讀取規範.md 鐵律 5）。
 * 這兩個欄位只存在於伺服器記憶體：signSessionToken 只取固定欄位（不會進 JWT），
 * 且回傳給前端前必須一併剝除（含 passwordHash 等敏感欄位）。
 */
export type VerifiedSession = SessionPayload & {
  __user?: Record<string, unknown> | null;
  __entry?: Record<string, unknown> | null;
};

/**
 * 驗證基線的共用載入：使用者文件＋當期身分名冊條目各一次點查。
 * 走 cachedAuthzDocs 8 秒快取（key 綁 uid＋role＋tokenVersion＋cacheEpoch）；
 * 「文件不存在」也快取為 null，避免孤兒查詢每請求照打。
 * jti 撤銷與設定類檢查在呼叫前已於快取外完成，本函式只負責這兩份文件。
 */
async function loadAuthzDocs(session: SessionPayload): Promise<AuthzDocs> {
  const epoch = await getCacheEpoch();
  return cachedAuthzDocs(
    session.uid,
    session.role,
    session.tokenVersion,
    epoch,
    async () => {
      const snap = await getAdminDbRaw()
        .collection(USER_COLLECTION)
        .doc(session.uid)
        .get();
      const user = snap.exists ? (snap.data() ?? null) : null;
      const period = await getCurrentPeriod();
      const entry = await getRosterEntry(session.uid, session.role, period);
      return { user, entry };
    }
  );
}

/**
 * 取得該 session 當期的管理員名冊條目（僅限 `role === "admin"` 的呼叫者）：
 * 優先復用 verifySession 已讀的 `__entry`，沒有才走 authz 快取補讀並掛回 session。
 */
async function adminEntryOf(session: SessionPayload): Promise<Record<string, unknown> | null> {
  const verified = session as VerifiedSession;
  const cached = verified.__entry;
  if (cached !== undefined && session.role === "admin") return cached;
  const docs = await loadAuthzDocs(session);
  verified.__user = docs.user;
  verified.__entry = docs.entry;
  return docs.entry;
}

export async function verifySession(): Promise<VerifiedSession | null> {
  // 讀取統計範圍：頁面（RSC）請求多半先經本函式；API 路由若已由
  // enforceRateLimit 建立更精確的端點標籤，ensureReadScope 會沿用不覆蓋
  ensureReadScope("(頁面)");
  const session = await getSession();
  if (!session) return null;

  // fail-closed：缺 jti 的 token 無法查詢撤銷狀態，直接拒絕
  if (!session.jti) return null;
  if (await isJtiRevoked(session.jti)) return null;

  // 系統停用（維護模式）時僅保留管理員 session，以便管理員重新啟用
  if (session.role !== "admin" && !(await isSystemEnabled())) return null;

  // 伺服器端閒置逾時：以 JWT lastActivityAt 對照 settings.sessionTimeout
  const idleTimeoutMs = (await getSessionTimeoutMinutes()) * 60 * 1000;
  if (Date.now() - session.lastActivityAt > idleTimeoutMs) return null;

  try {
    // 使用者文件＋當期名冊條目：8 秒 authz 快取（Phase 5）。
    // 設定類（systemEnabled／sessionTimeout／roleEnabled）仍走 readSystemDoc，
    // 不在本快取內；檢查邏輯與直讀時完全一致，只是資料來源可命中快取。
    const docs = await loadAuthzDocs(session);
    const data = docs.user;
    if (!data) return null;

    // 停用（無效）帳號的既有 session 全數失效
    if (!isAccountActive(data)) return null;

    const tokenVersion = typeof data.tokenVersion === "number" ? data.tokenVersion : 1;
    if (session.tokenVersion !== tokenVersion) return null;

    // 當期身分名冊：該身分不存在、無效或已被移除時，session 失效
    const entry = docs.entry;
    if (!isActiveEntry(entry)) return null;

    // 身分開關停用該身分時，既有 session 同步失效
    if (!(await isRoleEnabled(session.role))) return null;

    // 鎖定與登入路由一致：僅當鎖定綁定的來源 IP（或未綁定）命中目前請求才失效
    const lockedUntil = typeof data.lockedUntil === "number" ? data.lockedUntil : 0;
    if (lockedUntil > Date.now()) {
      const lockIp = typeof data.lockIp === "string" ? data.lockIp : "";
      const currentIp = getClientIp({ headers: await headers() });
      if (!lockIp || !currentIp || lockIp === currentIp) return null;
    }

    // 掛上同請求已讀取的資料，供權限判定與端點復用（見 VerifiedSession 說明）
    const verified = session as VerifiedSession;
    verified.__user = data;
    verified.__entry = entry ?? null;
    return verified;
  } catch {
    return null;
  }
}

/**
 * 續期（keepalive）用的輕量驗證——鐵律 1「先自問真的需要讀嗎」：
 * 續期只要確認 ①token 簽章與絕對／閒置時限有效 ②jti 未被撤銷 ③系統未停用，
 * 三者都不必重讀使用者文件與名冊條目（合計 **0 次讀取**；jti 點查不存在＝0 讀、
 * 設定走 readSystemDoc 快取）。
 *
 * 帳號被停用、名冊條目被移除、tokenVersion 變更等**權限層變更，
 * 仍會由下一次完整 verifySession（任何實際請求）擋下**——續期不授予任何權限，
 * 只滑動更新 JWT 的 lastActivityAt，故省下的 2 讀不影響安全性。
 * 對應每次 keepalive 約省 2 讀（≈240 讀/小時/在線使用者）。
 */
export async function verifySessionForRenewal(): Promise<SessionPayload | null> {
  const session = await getSession();
  if (!session) return null;

  // fail-closed：缺 jti 的 token 無法查詢撤銷狀態，直接拒絕
  if (!session.jti) return null;
  if (await isJtiRevoked(session.jti)) return null;

  if (session.role !== "admin" && !(await isSystemEnabled())) return null;

  const idleTimeoutMs = (await getSessionTimeoutMinutes()) * 60 * 1000;
  if (Date.now() - session.lastActivityAt > idleTimeoutMs) return null;

  return session;
}

export async function verifyRole(role: UserRole): Promise<SessionPayload | null> {
  const session = await verifySession();
  if (!session || session.role !== role) return null;
  return session;
}

export type AuthDenial =
  | { status: 401; message: string }
  | { status: 403; message: string };

export function toAuthResponse(denial: AuthDenial): NextResponse {
  return NextResponse.json(
    { success: false, message: denial.message },
    { status: denial.status }
  );
}

export async function requireRole(role: UserRole): Promise<
  { session: SessionPayload; denial: null } | { session: null; denial: AuthDenial }
> {
  const session = await verifySession();
  if (!session) {
    return { session: null, denial: { status: 401, message: "未登入或登入已失效" } };
  }
  if (session.role !== role) {
    return { session: null, denial: { status: 403, message: "權限不足" } };
  }
  return { session, denial: null };
}

/**
 * 管理功能模組權限（政策修改書決議二）：
 * 有當期管理員名冊條目＝全體模組全開；無條目或非管理員＝無權限。
 */
export async function hasAdminModule(
  session: SessionPayload,
  module: AdminModule
): Promise<boolean> {
  if (session.role !== "admin") return false;
  try {
    const entry = await adminEntryOf(session);
    return adminModulesOf(entry).includes(module);
  } catch {
    // fail-closed：讀不到權限資訊一律視為無權限
    return false;
  }
}

export async function requireAdminModule(module: AdminModule): Promise<
  { session: SessionPayload; denial: null } | { session: null; denial: AuthDenial }
> {
  const result = await requireRole("admin");
  if (result.denial) return result;
  if (!(await hasAdminModule(result.session, module))) {
    return { session: null, denial: { status: 403, message: "此帳號未被指派該功能模組" } };
  }
  return result;
}

/**
 * 模組安裝／卸載的指定管理員清單（`MODULE_MARKET_INSTALL_ADMINS`，選填）。
 * 未設定＝所有具 `modules` 權限的管理員皆可（維持「全體管理員平等」政策）。
 */
export function moduleInstallAdminAllowlist(): string[] {
  return parseModuleInstallAdmins(process.env.MODULE_MARKET_INSTALL_ADMINS);
}

/**
 * 安裝／卸載模組的守門（P0-7）：
 * 先要求 `modules` 權限，再用選填的 allowlist 限縮高風險操作。
 * 未設定 allowlist 時與 requireAdminModule("modules") 相同。
 */
export async function requireModuleInstallAdmin(): Promise<
  { session: SessionPayload; denial: null } | { session: null; denial: AuthDenial }
> {
  const result = await requireAdminModule("modules");
  if (result.denial) return result;
  if (!matchesModuleInstallAdmin(result.session, moduleInstallAdminAllowlist())) {
    return {
      session: null,
      denial: {
        status: 403,
        message: "此帳號未被指派模組安裝／卸載權限，請洽系統管理員設定 MODULE_MARKET_INSTALL_ADMINS",
      },
    };
  }
  return result;
}

/**
 * 「完整管理員」判定（政策修改書決議二）：屬性已退役，全體管理員平等。
 * 有當期管理員名冊條目即為 true。保留函式名稱相容既有呼叫點。
 */
export async function isSuperAdmin(session: SessionPayload): Promise<boolean> {
  if (session.role !== "admin") return false;
  try {
    const entry = await adminEntryOf(session);
    return entry !== null && isActiveEntry(entry);
  } catch {
    // fail-closed：讀不到條目一律視為非管理員
    return false;
  }
}

/** 【語意已變更】全體管理員皆可執行（屬性已退役）；保留名稱相容既有呼叫點 */
export async function requireSuperAdmin(
  _message = "僅管理員可執行此操作"
): Promise<
  { session: SessionPayload; denial: null } | { session: null; denial: AuthDenial }
> {
  return requireRole("admin");
}

/**
 * 「系統設定」的可設定判定（政策修改書決議二）：全體管理員皆可
 * （屬性已退役；「系統設定」原為每位管理員的基本入口，現讀寫一併開放）。
 */
export async function hasSettingsManage(session: SessionPayload): Promise<boolean> {
  return isSuperAdmin(session);
}

/**
 * 【已退役】管理員名冊的屬性寫入守門——屬性已取消，固定放行。
 * 「最後一位管理員不可停用」由 accountStatusGuard 守門。
 */
export async function checkAdminAttribute(
  _session: SessionPayload,
  _nextAttribute: string | null,
  _currentAttribute: string | null
): Promise<AuthDenial | null> {
  return null;
}

export async function requireSettingsManage(): Promise<
  { session: SessionPayload; denial: null } | { session: null; denial: AuthDenial }
> {
  const result = await requireRole("admin");
  if (result.denial) return result;
  if (!(await hasSettingsManage(result.session))) {
    return { session: null, denial: { status: 403, message: "僅管理員可修改系統設定" } };
  }
  return result;
}

/** requireModulePermission 回傳的權限上下文 */
export type ModulePermissionContext =
  | { kind: "admin"; session: SessionPayload }
  | { kind: "delegated"; session: SessionPayload; permissions: string[] };

/**
 * 取得「當前非管理員身分」對模組的指派清單（管理員恆全權、不看此欄）。
 * 優先復用 verifySession 已讀的 `__entry`；無條目回空陣列。
 */
async function delegatedModulesOf(session: SessionPayload): Promise<ManagedModuleGrant[]> {
  const verified = session as VerifiedSession;
  const cached = verified.__entry;
  if (cached !== undefined && cached !== null) return managedModulesOf(cached);
  if (cached === null) return [];
  try {
    const docs = await loadAuthzDocs(session);
    verified.__user = docs.user;
    verified.__entry = docs.entry;
    return managedModulesOf(docs.entry);
  } catch {
    // fail-closed：讀不到指派資訊一律視為未被指定
    return [];
  }
}

/**
 * 模組管理權守門（政策修改書決議一／G3）：
 * 1. `role === "admin"` → 管理員恆全權（kind: "admin"）；
 * 2. 否則查當期身分名冊條目 `managedModules`：
 *    - 指定 `permission` 時需含該子權限碼；
 *    - 未指定任何模組或子權限不符 → 403。
 * 模組端 API 以本函式取代 requireAdminModule（可帶子權限逐動作把關）。
 */
export async function requireModulePermission(
  module: string,
  permission?: string
): Promise<
  { context: ModulePermissionContext; denial: null } | { context: null; denial: AuthDenial }
> {
  const session = await verifySession();
  if (!session) {
    return { context: null, denial: { status: 401, message: "未登入或登入已失效" } };
  }
  if (session.role === "admin") {
    const entry = await adminEntryOf(session);
    if (!entry || !isActiveEntry(entry)) {
      return { context: null, denial: { status: 403, message: "權限不足" } };
    }
    return { context: { kind: "admin", session }, denial: null };
  }
  try {
    const grants = await delegatedModulesOf(session);
    const grant = grants.find((item) => item.module === module);
    if (!grant) {
      return {
        context: null,
        denial: { status: 403, message: "此帳號未被指派管理該功能模組" },
      };
    }
    if (permission !== undefined && !grant.permissions.includes(permission)) {
      return {
        context: null,
        denial: { status: 403, message: "此帳號未被指派該項操作權限" },
      };
    }
    return {
      context: { kind: "delegated", session, permissions: grant.permissions },
      denial: null,
    };
  } catch {
    return { context: null, denial: { status: 403, message: "權限不足" } };
  }
}

/**
 * 非管理員身分的被指派模組清單（session 顯示用；管理員回空陣列——管理員恆全權，
 * 首頁卡片走 adminModules）。優先復用 `__entry`，不另發讀取。
 */
export async function delegatedModuleGrants(session: SessionPayload): Promise<ManagedModuleGrant[]> {
  if (session.role === "admin") return [];
  return delegatedModulesOf(session);
}
