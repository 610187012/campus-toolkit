/**
 * 「功能模組」＝產品層級的模組註冊表——回答「這套系統有哪些功能模組、
 * 哪些是內建、哪些是選用、現在做到哪裡」。
 *
 * 分層（兩張註冊表不可混用）：
 * - 本檔（feature-modules）＝產品層級的功能模組，入口頁 `/admin/modules`；
 *   內建模組＝隨主程式提供、一律啟用（沒有「主程式功能模組」這層大項目，
 *   帳號、身分與安全管理、使用者帳號管理、身分名冊管理…本身各是一張內建模組卡）。
 * - `types/modules.ts`（ADMIN_MODULES）＝管理端的「權限單位」，由名冊「指定功能模組」指派；
 *   內建的管理端模組卡（`ADMIN_FEATURE_MODULES`）直接由它派生，勿另抄一份清單。
 *
 * 啟用狀態（選用模組）存於 `settings/system` 的 `featureModulesEnabled` 欄位
 * （與身分開關 `roleEnabled` 同一文件、同一套覆寫保留策略），
 * 僅超級管理員可在功能模組管理頁切換；內建模組恒為啟用、不入此欄位。
 * 欄位不存在＝選用模組一律未啟用（fail-safe：未經允許不啟用）。
 *
 * **身分可用性分兩層**：
 * - **提供功能**（`provides`）：產品層級、**唯讀**——由模組作者在本註冊表決定
 *   「這模組有沒有做給該身分用」，管理頁只能檢視、不能改。
 *   **預設＝教職員與管理員提供**（學生／家長暫不提供；可由模組作者日後調整）。
 * - **顯示與否**：運維層級，存於 `settings/system.featureModuleRoles`
 *   （`Record<模組代碼, Record<身分, boolean>>`）——有提供但暫時不開放進入／顯示。
 *   規則：`provides[role] === false` → 顯示強制為否（「未提供」）；
 *   `provides === true` → 顯示開關生效，**缺省＝顯示**（欄位不存在＝啟用，fail-safe）。
 * - **管理員不受入口開關限制**（政策修改書 G1）：`role === "admin"` 一律可見
 *   （不看 provides.admin、顯示開關；`featureModuleRoles.admin` 鍵已退役）。
 * 本頁目前只維護設定資料，各身分端的實際攔截隨模組上線進度接上
 * （首頁卡片已依顯示與否過濾；API 維持權限守門，不因顯示關閉而額外阻擋）。
 * 變更歷史另記錄於稽核紀錄（`feature_module_updated`／`feature_module_role_updated`）。
 */

import { MODULES, type ModuleStatus } from "./modules";
import { GENERATED_MODULE_VALUES } from "./modules.generated";
import { GENERATED_FEATURE_MODULES } from "./feature-modules.generated";
import { ALL_ROLES, SUPER_ONLY_ADMIN_MODULES, type UserRole } from "./users";
import { CALENDAR_MANAGER_PERMISSIONS } from "./calendar";

/** 內建（隨主程式提供、一律啟用）／選用（由超級管理員決定是否啟用） */
export type FeatureModuleKind = "builtin" | "optional";

/** 實作狀態：已上線／開發中／規劃中（展示資訊；入口看 href，可否啟用由超級管理員總開關決定） */
export type FeatureModuleStatus = "live" | "building" | "planned";

export const FEATURE_MODULE_STATUS_LABELS: Record<FeatureModuleStatus, string> = {
  live: "已上線",
  building: "開發中",
  planned: "規劃中",
};

export const FEATURE_MODULE_KIND_LABELS: Record<FeatureModuleKind, string> = {
  builtin: "內建",
  optional: "選用",
};

/** 模組作者與版本資訊（產品層級靜態資料，隨主程式或模組提供） */
export interface FeatureModuleAuthor {
  author: string;
  /** 作者資訊連結（如 GitHub） */
  authorUrl: string;
  version: string;
  /** 版本（發布）日期，格式自由（如 `2026-10-10 08:00`） */
  releasedAt: string;
}

/** 目前全站模組共用的佔位作者資訊（日後各模組可各自覆寫） */
export const DEFAULT_MODULE_AUTHOR: FeatureModuleAuthor = {
  author: "張家誠",
  authorUrl: "https://github.com/takan003",
  version: "1.0",
  releasedAt: "2026-10-10 08:00",
};

export interface FeatureModuleMeta {
  /** 模組代碼（選用模組啟用狀態欄位 `featureModulesEnabled` 的鍵） */
  value: string;
  label: string;
  /** 市集卡片名稱（選填；未設定時與 label 相同） */
  marketName?: string;
  kind: FeatureModuleKind;
  status: FeatureModuleStatus;
  description: string;
  /** 模組入口路由（""＝尚未建頁） */
  href: string;
  /**
   * 被指派管理人員的專用管理頁（選填）：未指定時沿用 href。
   * 內建模組若提供獨立的非管理員管理頁，在此宣告。
   */
  managerHref?: string;
  /**
   * 各身分入口（掃描器由 routes 的 page 路徑自動映射，選用模組才有）：
   * 非管理員首頁（RoleHome）以它組選用模組卡；無該身分頁面者不出卡。
   */
  roleHrefs?: Partial<Record<UserRole, string>>;
  /** 作者與版本資訊（唯讀展示） */
  author: FeatureModuleAuthor;
  /**
   * 提供功能（**唯讀**，由模組作者決定）：
   * 該模組有沒有做給該身分用。false → 管理頁顯示「未提供」、顯示開關無效。
   */
  provides: Record<UserRole, boolean>;
  /**
    * 各身分「功能入口」預設值（選填，由模組作者在 manifest 宣告）：
   * 僅 applies於 provides＝true 的身分；欄位不存在＝該身分預設顯示（fail-safe 開啟）。
   * 明確存值於 settings 時仍以存值為準——此欄位只決定「尚未手動切換過」時的初始狀態。
   */
  defaultRoleEnabled?: Partial<Record<UserRole, boolean>>;
  /**
   * 非管理員管理者之子權限宣告（選填，manifest `managerPermissions`，政策修改書 §6）：
   * 未宣告＝該模組不開放非管理員指派（僅管理員可完整管理）。
   * 管理員不受子權限限制（恆全開）；子權限只約束被指定的教職員／家長／學生。
   */
  managerPermissions?: ModuleManagerPermission[];
  /** 結構化改版記錄（選填，最新條目在前；純揭露，不參與安裝判定） */
  changelog?: { version: string; releasedAt: string; notes: string[] }[];
}

/** 模組宣告的管理子權限項（value 為權限碼，供 requireModulePermission 比對） */
export interface ModuleManagerPermission {
  value: string;
  label: string;
}

/** 管理端權限單位的實作狀態 → 功能模組狀態（built＝已上線、apiOnly＝開發中） */
const PERMISSION_STATUS: Record<ModuleStatus, FeatureModuleStatus> = {
  built: "live",
  apiOnly: "building",
  planned: "planned",
};

/** 教職員＋管理員提供（學生／家長暫不提供，由模組作者決定） */
const PROVIDES_STAFF_ADMIN = {
  student: false,
  parent: false,
  staff: true,
  admin: true,
} as const satisfies Record<UserRole, boolean>;

/**
 * 超級專屬功能模組代碼（由 `types/modules.ts` 的 superOnly 派生）——
 * 屬性分級已退役（政策修改書決議二）：全體管理員皆可用。
 * 此清單僅供文件與管理頁說明引用。
 */
export const SUPER_ONLY_FEATURE_MODULE_VALUES: readonly string[] = SUPER_ONLY_ADMIN_MODULES;

/**
 * manifest 產生的權限單位（`src/modules/<value>/module.json`，屬選用模組）——
 * 不可再派生為內建功能卡；其產品層級卡由產生列（`GENERATED_FEATURE_MODULES`）提供。
 */
const GENERATED_MODULE_VALUES_SET: ReadonlySet<string> = new Set(GENERATED_MODULE_VALUES);

/**
 * 內建的管理端功能模組：個人卡片「帳號、身分與安全管理」
 * ＋管理端權限單位（types/modules.ts 的 MODULES，含尚未建頁的稽核紀錄）。
 * 新增管理端功能時會自動出現在這裡，不需要另外維護。
 * 提供功能預設＝教職員與管理員（學生／家長暫不提供）；
 * 例外：account 是個人頁、人人皆有，四身分皆提供（見該列 provides）。
 */
const ADMIN_FEATURE_MODULES: readonly FeatureModuleMeta[] = [
  {
    value: "account",
    label: "帳號、身分與安全管理",
    kind: "builtin",
    status: "live",
    description: "維護自己的個人資料、密碼與兩階段驗證等帳號安全設定。",
    href: "/admin/admins",
    author: DEFAULT_MODULE_AUTHOR,
    // 個人頁、人人皆有（學生／家長在各自身分首頁亦有入口卡）：
    // 不套「教職員與管理員提供」預設，四身分皆提供
    provides: {
      student: true,
      parent: true,
      staff: true,
      admin: true,
    },
  },
  ...MODULES.filter((item) => !GENERATED_MODULE_VALUES_SET.has(item.value)).map((item) => ({
    value: item.value as string,
    label: item.label,
    kind: "builtin" as const,
    status: PERMISSION_STATUS[item.status],
    description: item.description,
    href: item.href,
    author: DEFAULT_MODULE_AUTHOR,
    provides: PROVIDES_STAFF_ADMIN,
  })),
];

/**
 * 未去重的內建＋選用定義（**勿直接導出**）：
 * 由 `MODULES` 派生列先進，手刻列（如 announcements 的產品層級 provides）列在後，
 * manifest 產生列（選用模組，`src/modules/<value>/module.json`）最後——同代碼後者勝，
 * 故 manifest 可直接覆寫手刻的選用佔位列。
 */
const RAW_FEATURE_MODULES: readonly FeatureModuleMeta[] = [
  ...ADMIN_FEATURE_MODULES,
  {
    value: "announcements",
    label: "系統公告",
    kind: "builtin",
    status: "live",
    description: "發佈與管理校園公告，可依閱讀權限與班級設定可見範圍；其他模組可經接口掛勾發文。",
    href: "/admin/announcements",
    author: DEFAULT_MODULE_AUTHOR,
    // 公告對四身分皆提供（收件）；管理端另受「指定功能模組」把關
    provides: {
      student: true,
      parent: true,
      staff: true,
      admin: true,
    },
  },
  {
    value: "calendar",
    label: "行事曆",
    kind: "builtin",
    status: "live",
    description: "校務行事曆與各類日程的建立、發佈與檢視。",
    href: "/admin/calendar",
    managerHref: "/calendar/manage",
    author: DEFAULT_MODULE_AUTHOR,
    // 行事曆對四身分皆提供（檢視）；管理端另受「指定功能模組」把關
    provides: {
      student: true,
      parent: true,
      staff: true,
      admin: true,
    },
    // 行事曆可指定非管理員管理人員，子權限分開授權（管理行程／批次匯入／刪除／設定）
    managerPermissions: CALENDAR_MANAGER_PERMISSIONS,
  },
  {
    value: "personalInfo",
    label: "學生個人資料",
    kind: "builtin",
    status: "live",
    description: "學生檢視本學期的基本資料；以學生學籍資料為主，並提供家長、教職員與管理員依權限查閱與管理。",
    href: "/admin/personal-info",
    author: DEFAULT_MODULE_AUTHOR,
    provides: {
      student: true,
      parent: true,
      staff: true,
      admin: true,
    },
  },
  {
    value: "recreation",
    label: "休閒歡樂誠",
    kind: "builtin",
    status: "live",
    description: "課餘休閒小遊戲；四種身分功能首頁左上角城堡圖示與入口卡進入。",
    href: "/recreation",
    author: DEFAULT_MODULE_AUTHOR,
    provides: {
      student: true,
      parent: true,
      staff: true,
      admin: true,
    },
  },
  // manifest 產生列（scripts/build-module-registry.mjs；後者勝，可覆寫手刻列）
  ...GENERATED_FEATURE_MODULES,
];

/**
 * 新增功能模組時在 `RAW_FEATURE_MODULES` 加一列（內建排前面，選用排後面）；
 * **選用（外掛）模組改由 manifest 註冊**：放 `src/modules/<value>/module.json`
 * 即自動出現在產生列，勿另手刻（佔位列可日後移除）。
 * 同代碼以**列在後者**為準：由 `MODULES` 派生的內建列（provides 預設教職員＋管理員）
 * 會被後方手刻列覆寫（如 announcements 四身分皆提供），註冊表因此不會出現重複列。
 */
export const FEATURE_MODULES: readonly FeatureModuleMeta[] = (() => {
  const merged = new Map<string, FeatureModuleMeta>();
  for (const item of RAW_FEATURE_MODULES) merged.set(item.value, item);
  return [...merged.values()];
})();

/** `settings/system` 上存選用模組啟用狀態的欄位名 */
export const FEATURE_MODULES_FIELD = "featureModulesEnabled";

/** 選用模組的啟用狀態（內建模組不在其中，恒為啟用） */
export type FeatureModulesEnabledMap = Record<string, boolean>;

/** 依代碼查功能模組（未知代碼回 undefined） */
export function featureModuleMeta(value: string): FeatureModuleMeta | undefined {
  return FEATURE_MODULES.find((item) => item.value === value);
}

/** 某一種歸屬（內建／選用）的功能模組 */
export function featureModulesOfKind(kind: FeatureModuleKind): readonly FeatureModuleMeta[] {
  return FEATURE_MODULES.filter((item) => item.kind === kind);
}

/**
 * 可否切換啟用狀態：選用模組一律可由超級管理員切換（安裝即可用）；
 * `status` 為作者宣告的展示資訊，不再把關。預設未啟用的 fail-safe 見 readFeatureModulesEnabled。
 * 伺服器端同步把關（api/admin/feature-modules PATCH）。
 */
export function isTogglableFeatureModule(meta: FeatureModuleMeta): boolean {
  return meta.kind === "optional";
}

/**
 * 讀回選用模組的啟用狀態：僅承認布林值；
 * 欄位不存在或值毀損＝該模組視為未啟用（fail-safe：未經允許不啟用）。
 */
export function readFeatureModulesEnabled(raw: unknown): FeatureModulesEnabledMap {
  const out: FeatureModulesEnabledMap = {};
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  for (const item of FEATURE_MODULES) {
    if (item.kind !== "optional") continue;
    out[item.value] = data ? data[item.value] === true : false;
  }
  return out;
}

/** `settings/system` 上存「模組 × 身分」顯示開關的欄位名（語意＝顯示與否，非提供功能） */
export const FEATURE_MODULE_ROLES_FIELD = "featureModuleRoles";

/** 單一模組對四種身分的顯示開關（僅 applies於 provides＝true 的身分） */
export type FeatureModuleRoleSwitches = Record<UserRole, boolean>;

/** 全部功能模組 × 四種身分的顯示開關（鍵＝模組代碼） */
export type FeatureModuleRolesMap = Record<string, FeatureModuleRoleSwitches>;

/**
 * 讀回「模組 × 身分」顯示開關：以註冊表為準逐模組、逐身分解析。
 * - `provides[role] === false` → 強制 false（未提供，顯示開關無效）；
 * - `provides === true` → 明確存著 `false` 才視為關閉；明確存著 `true` 視為開啟；
 *   欄位不存在、該模組未存或值毀損＝採用註冊表 `defaultRoleEnabled[role]`
 *   （缺省＝顯示，fail-safe：預設開啟；模組可宣告預設關閉）。
 */
export function readFeatureModuleRoles(raw: unknown): FeatureModuleRolesMap {
  const out: FeatureModuleRolesMap = {};
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  for (const item of FEATURE_MODULES) {
    const row = data ? data[item.value] : undefined;
    const rowData = row && typeof row === "object" ? (row as Record<string, unknown>) : null;
    const switches = {} as FeatureModuleRoleSwitches;
    for (const role of ALL_ROLES) {
      if (!item.provides[role]) {
        switches[role] = false;
        continue;
      }
      if (rowData && typeof rowData[role] === "boolean") {
        switches[role] = rowData[role];
        continue;
      }
      switches[role] = item.defaultRoleEnabled?.[role] ?? true;
    }
    out[item.value] = switches;
  }
  return out;
}

/** 該模組是否有提供給該身分（唯讀，產品層級） */
export function isFeatureModuleProvided(value: string, role: UserRole): boolean {
  const meta = featureModuleMeta(value);
  return meta ? meta.provides[role] === true : false;
}

/**
 * 該模組對該身分是否可見。
 * - **超級管理員（role=admin 且 isSuper）完全不受限制**：一律 true（不看 provides、顯示開關、啟用狀態）；
 * - 其他：選用模組須總開關啟用（options.enabled，fail-safe 未啟用即隱藏【0.393】）
 *   → provides＝false → false；provides＝true → 顯示開關 !== false（缺省＝可見）。
 */
export function isFeatureModuleVisible(
  value: string,
  role: UserRole,
  display: FeatureModuleRoleSwitches | undefined,
  options?: { isSuper?: boolean; enabled?: FeatureModulesEnabledMap }
): boolean {
  if (options?.isSuper === true && role === "admin") return true;
  const meta = featureModuleMeta(value);
  if (!meta || !meta.provides[role]) return false;
  if (meta.kind === "optional" && options?.enabled && options.enabled[value] !== true) return false;
  return display?.[role] !== false;
}

/** 某身分可見的功能模組代碼清單（供首頁卡片過濾）；選用模組以總開關為前提【0.393】 */
export function visibleFeatureModuleValues(
  role: UserRole,
  rolesMap: FeatureModuleRolesMap,
  options?: { isSuper?: boolean; enabled?: FeatureModulesEnabledMap }
): string[] {
  return FEATURE_MODULES.filter((item) =>
    isFeatureModuleVisible(item.value, role, rolesMap[item.value], options)
  ).map((item) => item.value);
}
