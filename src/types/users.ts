import { MODULES, type ModuleValue } from "./modules";

export type UserRole = "student" | "parent" | "staff" | "admin";

/** 四種身分的固定順序（查找、顯示、選擇清單共用） */
export const ALL_ROLES: UserRole[] = ["student", "parent", "staff", "admin"];

/** 使用者帳號唯一集合（1 張表、無週期、永久） */
export const USER_COLLECTION = "users";

export const ROLE_HOME: Record<UserRole, string> = {
  student: "/student",
  parent: "/parent",
  staff: "/staff",
  admin: "/admin",
};

export const ROLE_LABELS: Record<UserRole, string> = {
  student: "學生",
  parent: "家長",
  staff: "教職員",
  admin: "管理員",
};

export function isUserRole(value: unknown): value is UserRole {
  return value === "student" || value === "parent" || value === "staff" || value === "admin";
}

/**
 * 兩階段驗證方式（存於使用者帳號 `twoFactor` 欄位）。
 * 選項文字與舊 GAS 站 account.html 一致：關閉 / 登入通知 / 電子郵件驗證碼 / 驗證碼APP。
 */
export const TWO_FACTOR_METHODS = [
  { value: "off", label: "關閉 - 高風險", short: "未啟用" },
  { value: "email_notify", label: "電子郵件發送登入通知 - 中風險", short: "登入通知" },
  { value: "email_otp", label: "電子郵件驗證碼 - 低風險", short: "驗證信" },
  { value: "totp", label: "驗證碼APP - 低風險", short: "驗證APP" },
] as const;

export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number]["value"];

export const DEFAULT_TWO_FACTOR: TwoFactorMethod = "off";

export function isTwoFactorMethod(value: unknown): value is TwoFactorMethod {
  return (
    typeof value === "string" &&
    TWO_FACTOR_METHODS.some((method) => method.value === value)
  );
}

/** 顯示用標籤；未知值一律視為「關閉」（fail-safe，不會誤觸驗證） */
export function twoFactorLabel(value: unknown): string {
  const method = isTwoFactorMethod(value) ? value : DEFAULT_TWO_FACTOR;
  return TWO_FACTOR_METHODS.find((item) => item.value === method)?.label || TWO_FACTOR_METHODS[0].label;
}

/** 清單用簡稱：未啟用／登入通知／驗證信／驗證APP */
export function twoFactorShortLabel(value: unknown): string {
  const method = isTwoFactorMethod(value) ? value : DEFAULT_TWO_FACTOR;
  return TWO_FACTOR_METHODS.find((item) => item.value === method)?.short || TWO_FACTOR_METHODS[0].short;
}

/** 需要第二階段驗證才建立 session 的方式（登入通知不阻擋登入） */
export function requiresSecondFactor(value: unknown): value is "email_otp" | "totp" {
  return value === "email_otp" || value === "totp";
}

/**
 * 狀態（帳號層＝是否可登入；名冊層＝該期該身分是否可用），兩層共用同一組值。
 * 有效＝正常；無效＝停用（不可用）。舊資料的「停權」已併入無效，讀取時自動轉換。
 */
export type AccountStatus = "有效" | "無效";

export const ACCOUNT_STATUSES: AccountStatus[] = ["有效", "無效"];

/** 可用的狀態 */
export const ACTIVE_STATUS: AccountStatus = "有效";

/** 顯示名稱：儲存值為「無效」，介面一律稱「停用」 */
export const STATUS_LABELS: Record<AccountStatus, string> = {
  有效: "有效",
  無效: "停用",
};

export function statusLabel(status: AccountStatus): string {
  return STATUS_LABELS[status];
}

export function isAccountStatus(value: unknown): value is AccountStatus {
  return value === "有效" || value === "無效";
}

/**
 * 讀取資料時的狀態正規化：舊「停權」視為無效（不可用，不會意外復活）；
 * 缺值或未知值維持原預設＝有效。
 */
export function normalizeAccountStatus(value: unknown): AccountStatus {
  return value === "無效" || value === "停權" ? "無效" : ACTIVE_STATUS;
}

/** 是否為「有效」狀態（名冊條目、帳號文件共用） */
export function isActiveStatus(value: unknown): boolean {
  return value === ACTIVE_STATUS;
}

/**
 * 使用者帳號是否有效（可登入）。
 * 有 status 以 status 為準；無 status 的文件視為有效（僅剛建立尚未寫入的瞬間）。
 */
export function isAccountActive(
  data: Record<string, unknown> | null | undefined
): boolean {
  if (!data) return false;
  if (typeof data.status === "string") return data.status === ACTIVE_STATUS;
  return true;
}

/** 最後登入時間：由登入紀錄推導（登入紀錄依序累加，最後一筆即最新） */
export function lastLoginOf(data: Record<string, unknown> | null | undefined): number {
  const records = data && Array.isArray(data.loginRecords) ? data.loginRecords : [];
  const last = records[records.length - 1];
  return typeof last === "number" ? last : 0;
}

/**
 * 管理員可指定的功能模組（**指定機制已退役**，政策修改書決議二）：
 * 有當期管理員名冊條目＝全體模組全開；不再看 attribute／modules。
 * 模組決定：首頁卡片是否顯示、對應 API 是否放行（requireAdminModule）。
 * 清單由功能模組註冊表（`types/modules.ts` 的 `MODULES`）派生——
 * 新增／調整模組請改註冊表，此處只做投影，不要另立清單。
 * 注意：個人頁「帳號、身分與安全管理」不是模組——每個帳號都用得到，管理員首頁固定顯示。
 * 非管理員身分（教職員／家長／學生）的功能模組指派改存名冊條目 `managedModules`
 * （含子權限），由 requireModulePermission 判定。
 */
export type AdminModule = ModuleValue;

export const ADMIN_MODULES: { value: AdminModule; label: string }[] = MODULES.map((item) => ({
  value: item.value,
  label: item.label,
}));

export const ADMIN_MODULE_VALUES: AdminModule[] = ADMIN_MODULES.map((item) => item.value);

/**
 * 管理員的「基本模組」（註冊表 scope＝core）：不需指派、每位管理員（含一般屬性）一律具備，
 * 用途＝首頁固定顯示該入口（系統設定的讀寫另由超級管理員判定，見 hasSettingsManage）。
 * 「系統設定」是每個管理員都有的入口。
 */
export const BASE_ADMIN_MODULES: AdminModule[] = MODULES.filter(
  (item) => item.scope === "core"
).map((item) => item.value);

/**
 * 【已退役語意】scope＝superOnly 的模組代碼——屬性分級取消後（政策修改書決議二），
 * 全體管理員皆可用；本清單僅供文件與 UI 分組參考，adminModulesOf 不再剝除。
 */
export const SUPER_ONLY_ADMIN_MODULES: AdminModule[] = MODULES.filter(
  (item) => item.scope === "superOnly"
).map((item) => item.value);

export function isAdminModule(value: unknown): value is AdminModule {
  return typeof value === "string" && ADMIN_MODULE_VALUES.includes(value as AdminModule);
}

/**
 * 改版前的模組代碼／標籤 → 現行模組（僅舊資料與舊輸入相容）。
 * - `roles`（身分管理）已併入「身分名冊管理」，舊管理員的指派不會因此失權。
 * - 舊 `使用者帳號管理`（代碼 `roster`）改版後對應「身分名冊管理」；
 *   如該管理員也要用帳號工作表，請在名冊管理頁補勾「使用者帳號管理」。
 * - 舊 `account`（個人頁「帳號、身分與安全管理」）不再對應任何模組：
 *   個人頁不需權限，人人可見，故不授予管理工作。
 */
const LEGACY_ADMIN_MODULES: Record<string, AdminModule> = {
  roles: "roster",
  身分管理: "roster",
};

/** 解析一個模組代碼或標籤（含舊值），無法辨識回 undefined */
export function resolveAdminModule(token: string): AdminModule | undefined {
  if (isAdminModule(token)) return token;
  const byLabel = ADMIN_MODULES.find((item) => item.label === token)?.value;
  if (byLabel) return byLabel;
  return LEGACY_ADMIN_MODULES[token];
}

/**
 * 【已退役】管理員屬性：超級／一般——政策修改書決議二取消，全體管理員平等。
 * 型別保留一個版本週期供舊資料相容（isAdminAttribute 不再參與授予判定）。
 */
export type AdminAttribute = "超級" | "一般";
export const ADMIN_ATTRIBUTES: AdminAttribute[] = ["超級", "一般"];

export function isAdminAttribute(value: unknown): value is AdminAttribute {
  return value === "超級" || value === "一般";
}

/**
 * 教職員屬性（互斥，不疊加）：
 * 教師＝純教學；兼導師＝教師兼任導師；兼行政＝教師兼任行政（組長／主任等）或職員編制；
 * 職員＝專任行政人員。要分辨誰是教師兼行政，看「單位」與「職稱」欄。
 */
export type StaffAttribute = "教師" | "兼導師" | "兼行政" | "職員";
export const STAFF_ATTRIBUTES: StaffAttribute[] = ["教師", "兼導師", "兼行政", "職員"];

/** 改版前只有「行政」「教師」兩值，舊資料一律對應到新制 */
const LEGACY_STAFF_ATTRIBUTES: Record<string, StaffAttribute> = { 行政: "兼行政" };

export function isStaffAttribute(value: unknown): value is StaffAttribute {
  return (STAFF_ATTRIBUTES as string[]).includes(value as string);
}

/** 讀寫教職員屬性：舊值轉新制、去除前後空白，其餘原樣保留（未知值照原樣顯示） */
export function resolveStaffAttribute(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return LEGACY_STAFF_ATTRIBUTES[text] ?? text;
}

/**
 * 使用者帳號（`users` 集合文件）：1 張表、無週期、永久。
 * 回答「這個人能否登入、怎麼登入」；兩階段驗證設置於此層。
 * 班級、學號等名冊資料不在此，存於四張身分名冊（隨學年度、學期變動）。
 */
export interface AccountRecord {
  /** 電子郵件地址：選填、有值即全站唯一（登入識別＋2FA 收信）；與帳號至少填一個 */
  email: string;
  /** 帳號：選填、全站唯一（登入識別）；與電子郵件至少填一個 */
  account: string;
  /** 密碼雜湊（bcrypt）：密碼只在這一層，名冊不存密碼 */
  passwordHash: string;
  /** 姓名（帳號層預設值；顯示以當期名冊姓名為準） */
  name: string;
  /** 狀態：有效／無效（停用；決定能否登入，缺省＝有效） */
  status?: AccountStatus;
  /** 慣用身分：多身分時登入預設進入的身分；未設定＝登入時詢問 */
  preferredRole?: UserRole;
  /** 兩階段驗證方式，缺省視為 off */
  twoFactor?: TwoFactorMethod;
  /** TOTP Base32 密鑰（twoFactor=totp 時使用；靜態加密後存放，讀取時解密） */
  totpSecret?: string;
  /** Email OTP：只存 sha256(uid:code)，有效期限與寄送節流 */
  otpHash?: string;
  otpExpiresAt?: number;
  otpSentAt?: number;
  /** TOTP 防重放：90 秒內同一組驗證碼不可重複使用 */
  totpLastCode?: string;
  totpLastUsedAt?: number;
  /** 登入紀錄（epoch ms，依序累加，最多 50 筆；最後登入＝最後一筆） */
  loginRecords: number[];
  /** 最後一次登入方式（登入方式） */
  lastLoginMethod: string;
  /** 登入次數 */
  loginCount: number;
  /** CSS 主題 ID */
  cssThemeId: string;
  /** 已安裝主題清單（JSON 陣列字串） */
  installedThemes: string;
  /** 鎖定至（epoch ms），0 表示未鎖定 */
  lockedUntil: number;
  /** 觸發鎖定時的來源 IP（綁定鎖定，防跨 IP 鎖號 DoS；空字串＝全域鎖定） */
  lockIp?: string;
  /** 連續登入失敗次數 */
  failedAttempts: number;
  /** 每次重設密碼 +1，使舊 JWT 全數失效 */
  tokenVersion: number;
  /**
   * 需由本人修改密碼（管理員設定的預設密碼）：登入後全螢幕要求先改密碼才放行。
   * 建立帳號、管理員重設他人密碼時標記；本人改密或一次性連結重設時清除。
   * 缺省（舊帳號、Google 建立的帳號）＝false，不強制。
   */
  mustChangePassword?: boolean;
  createdAt: number;
}

/**
 * 「使用者帳號管理」工作表的一列（API 回傳格式，不含密碼）。
 * 具備身分＝該帳號於「當期」四張身分名冊中存在條目（不論條目狀態）。
 */
export interface AccountSummary {
  uid: string;
  email: string;
  account: string;
  name: string;
  status: AccountStatus;
  /** 慣用身分（未設定＝登入時詢問） */
  preferredRole?: UserRole;
  /** 兩階段驗證方式原值（顯示請用 twoFactorLabel） */
  twoFactor?: TwoFactorMethod;
  lastLogin?: number;
  loginCount?: number;
  /** 具備身分（當期名冊有條目者，順序 ALL_ROLES） */
  roles: UserRole[];
}

/** 「使用者帳號管理」批次作業的三種模式（上傳試算表） */
export type AccountBatchMode = "create" | "update" | "delete";

export const ACCOUNT_BATCH_MODES: { value: AccountBatchMode; label: string }[] = [
  { value: "create", label: "新增" },
  { value: "update", label: "修改" },
  { value: "delete", label: "刪除" },
];

export const ACCOUNT_BATCH_MODE_LABELS: Record<AccountBatchMode, string> = {
  create: "新增",
  update: "修改",
  delete: "刪除",
};

/** 預覽中單一欄位的變更內容（顯示用） */
export interface AccountBatchChange {
  label: string;
  from: string;
  to: string;
}

export interface AccountBatchRow {
  /** 工作表實際列號（第 1 列為標題） */
  row: number;
  /** 該列的辨識鍵（電子郵件地址或帳號） */
  key: string;
  action: "create" | "update" | "delete" | "skip";
  /** 僅 skip 有值 */
  reason?: string;
  /** 僅 update 有值 */
  changes?: AccountBatchChange[];
  /** 附加說明（新增列同時建立當期身分時） */
  note?: string;
}

export interface AccountBatchPreview {
  mode: AccountBatchMode;
  total: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  /** 新增列中同時建立當期身分名冊條目的筆數 */
  rostered?: number;
  rows: AccountBatchRow[];
}

export interface AccountBatchResult {
  created: number;
  updated: number;
  deleted: number;
  /** 同時建立當期身分名冊條目的筆數 */
  rostered?: number;
  /** 自動銜接的孤兒名冊條目筆數（重建同辨識鍵帳號時） */
  linked?: number;
  skipped: { row: number; reason: string }[];
}

/** 批次執行的分批進度：伺服器每次只處理一批，前端依 done 決定是否繼續送下一批 */
export interface AccountBatchProgress {
  /** 本批的起始列索引（0 起，相對資料列） */
  offset: number;
  /** 本批實際處理的列數 */
  processed: number;
  /** 檔案資料列總數 */
  total: number;
  /** 是否已處理完所有列 */
  done: boolean;
}

/** 刪除帳號時的名冊條目處理範圍（單筆與批次刪除皆可選，預設 all） */
export type RosterDeleteScope = "all" | "current" | "none";

/** 各處理範圍的完整說明（用於成功訊息與稽核紀錄） */
export const ROSTER_DELETE_SCOPE_LABELS: Record<RosterDeleteScope, string> = {
  all: "刪除所有學期的名冊條目",
  current: "只刪除本學期的名冊條目",
  none: "保留所有名冊條目",
};
