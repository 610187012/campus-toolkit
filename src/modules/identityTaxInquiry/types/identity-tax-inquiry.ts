/** 註冊身分與財稅查調（identityTaxInquiry）共用型別與驗證（用戶端／伺服器端皆可用） */

export const IDENTITY_TAX_INQUIRY_VALUE = "identityTaxInquiry";
export const SETTINGS_COLLECTION = "identityTaxInquirySettings";
export const RECORDS_COLLECTION = "identityTaxInquiryRecords";
export const SETTINGS_DOC_ID = "default";
export const PERSONAL_DATA_CONSENT_VERSION = "2026-11-02";

/** 進階選項型態：下拉單選／勾選（可多選）／文字 */
export type IdentityFieldType = "select" | "checkbox" | "text";

/** 進階選項的單一可選值：項目代碼＋項目名稱 */
export interface IdentityFieldOption {
  /** 項目代碼（可空） */
  code: string;
  /** 項目名稱（顯示用） */
  name: string;
}

/** 顯示文字：有代碼時為「代碼 名稱」 */
export function fieldOptionLabel(option: IdentityFieldOption): string {
  return [option.code.trim(), option.name.trim()].filter(Boolean).join(" ");
}

/** 學生端顯示文字：只顯示項目名稱（名稱空白時退回代碼） */
export function fieldOptionName(option: IdentityFieldOption): string {
  return option.name.trim() || option.code.trim();
}

export interface IdentityFieldDef {
  /** 穩定 id（改名不影響已存資料） */
  id: string;
  type: IdentityFieldType;
  /** 欄位標籤，例如「障礙程度」「住宿」「身障人士身分證字號」 */
  label: string;
  /** 送出確認時是否必填 */
  required: boolean;
  /** select＝選項清單；checkbox＝可勾選項目（僅 1 個即為單一勾選）；text＝不使用 */
  options: IdentityFieldOption[];
}

export interface IdentityOptionDef {
  /** 穩定 id（改名不影響已存資料） */
  id: string;
  label: string;
  /** 是否提供學生勾選 */
  enabled: boolean;
  /** 勾選後是否需財稅查調 */
  taxInquiry: boolean;
  /** 互斥群組代號（同群組僅能擇一；空字串＝不互斥） */
  exclusiveGroup: string;
  /** 優待方式：減免／補助（空＝未設定） */
  benefitType?: BenefitType | "";
  /** 優待金額（正整數；null＝未設定） */
  benefitAmount?: number | null;
  /** 項目說明（單行） */
  benefitNote?: string;
  /** 進階選項（依陣列順序顯示） */
  fields: IdentityFieldDef[];
}

/** 優待方式：減免或補助（二擇一） */
export type BenefitType = "reduction" | "subsidy";

export const BENEFIT_TYPE_LABELS: Record<BenefitType, string> = {
  reduction: "減免",
  subsidy: "補助",
};

/** 學生勾選結果（存 label 快照，改名後舊資料仍可讀） */
export interface IdentitySelection {
  optionId: string;
  label: string;
  /** fieldId → 選取值（text 為單一元素；checkbox 可多個） */
  values: Record<string, string[]>;
}

export const IDENTITY_LABEL_MAX = 40;
export const IDENTITY_OPTION_MAX = 40;
export const IDENTITY_FIELD_LABEL_MAX = 40;
export const IDENTITY_FIELD_OPTION_MAX = 30;
export const IDENTITY_FIELD_VALUE_MAX = 100;
export const NOTE_MAX = 500;

/** 預設「身心障礙」程度選項 */
const DEFAULT_DISABILITY_LEVELS: IdentityFieldOption[] = [
  { code: "", name: "極重度" },
  { code: "", name: "重度" },
  { code: "", name: "中度" },
  { code: "", name: "輕度" },
  { code: "", name: "持鑑定證明" },
];

/** 預設身分別（管理端可增刪改、調順序、設互斥） */
export const DEFAULT_IDENTITY_OPTIONS: IdentityOptionDef[] = [
  {
    id: "low-income",
    label: "低收入戶子女",
    enabled: true,
    taxInquiry: true,
    exclusiveGroup: "lowIncome",
    fields: [],
  },
  {
    id: "mid-low-income",
    label: "中低收入戶子女",
    enabled: true,
    taxInquiry: true,
    exclusiveGroup: "lowIncome",
    fields: [],
  },
  {
    id: "disabled-student",
    label: "身心障礙學生",
    enabled: true,
    taxInquiry: false,
    exclusiveGroup: "",
    fields: [
      {
        id: "disability-level",
        type: "select",
        label: "障礙程度",
        required: true,
        options: [...DEFAULT_DISABILITY_LEVELS],
      },
    ],
  },
  {
    id: "disabled-parent",
    label: "身心障礙人士子女",
    enabled: true,
    taxInquiry: false,
    exclusiveGroup: "",
    fields: [
      {
        id: "parent-disability-level",
        type: "select",
        label: "障礙程度",
        required: true,
        options: [...DEFAULT_DISABILITY_LEVELS],
      },
      {
        id: "parent-disability-id",
        type: "text",
        label: "身障人士身分證字號",
        required: false,
        options: [],
      },
    ],
  },
  {
    id: "indigenous",
    label: "原住民",
    enabled: true,
    taxInquiry: false,
    exclusiveGroup: "",
    fields: [
      {
        id: "indigenous-boarding",
        type: "checkbox",
        label: "住宿",
        required: false,
        options: [{ code: "", name: "住宿生" }],
      },
    ],
  },
  {
    id: "special-family",
    label: "特殊境遇家庭",
    enabled: true,
    taxInquiry: false,
    exclusiveGroup: "",
    fields: [],
  },
  {
    id: "military-bereaved",
    label: "軍公教遺族",
    enabled: true,
    taxInquiry: false,
    exclusiveGroup: "",
    fields: [
      {
        id: "grant-type",
        type: "select",
        label: "公費別",
        required: false,
        options: [
          { code: "", name: "全公費" },
          { code: "", name: "半公費" },
        ],
      },
      {
        id: "grant-item",
        type: "select",
        label: "補助項目",
        required: false,
        options: [
          { code: "", name: "主食米-12公斤(公教)" },
          { code: "", name: "主食米-12公斤(私教)" },
          { code: "", name: "代金" },
        ],
      },
      {
        id: "grant-doc-no",
        type: "text",
        label: "發給公費核准文號",
        required: false,
        options: [],
      },
    ],
  },
  {
    id: "economically-disadvantaged",
    label: "經濟弱勢學生",
    enabled: true,
    taxInquiry: false,
    exclusiveGroup: "",
    fields: [],
  },
  {
    id: "active-military-child",
    label: "現役軍人子女",
    enabled: true,
    taxInquiry: false,
    exclusiveGroup: "",
    fields: [],
  },
];

/** 財稅查調對象：父母雙方／父母一方／本人（已婚）／監護人 */
export type TaxSubject = "both" | "one" | "self" | "guardian";

export const TAX_SUBJECT_LABELS: Record<TaxSubject, string> = {
  both: "父母（法定代理人）雙方",
  one: "父或母一方（離異或亡故）",
  self: "本人（已結婚）",
  guardian: "監護人（法定代理人無法行使親權）",
};

export const MAINTENANCE_TITLE = "此功能目前未啟用";
export const MAINTENANCE_HINT =
  "學校尚未開放「註冊身分與財稅查調」，請稍後再試或洽教務處。";

export type IdentityWindowState = "unset" | "upcoming" | "open" | "ended";
export type ConfirmationStatus = "draft" | "confirmed";
export type TaxInquiryStatus = "none" | "pending" | "done" | "exempt";

export const CONFIRMATION_STATUS_LABELS: Record<ConfirmationStatus, string> = {
  draft: "草稿",
  confirmed: "已確認",
};

export const TAX_INQUIRY_STATUS_LABELS: Record<TaxInquiryStatus, string> = {
  none: "尚不需要",
  pending: "待查調",
  done: "已查調",
  exempt: "免查調",
};

export const IDENTITY_WINDOW_LABELS: Record<IdentityWindowState, string> = {
  unset: "學校尚未設定確認期間",
  upcoming: "尚未開放確認",
  open: "確認期間內",
  ended: "已超過確認期間",
};

export interface IdentityTaxInquirySettings {
  /** 功能總開關（模組層級；預設關閉，fail-safe） */
  enabled: boolean;
  /** 學生確認開放時間（epoch ms）；null＝未設定 */
  openAt: number | null;
  /** 學生確認截止時間（epoch ms）；null＝未設定 */
  closeAt: number | null;
  /** 實施說明（純文字） */
  instructions: string;
  /** 身分別選項（陣列順序＝顯示順序） */
  identityOptions: IdentityOptionDef[];
  updatedAt: number;
}

export interface ParentIdInfo {
  idNumber: string;
}

export interface PersonalDataConsent {
  version: string;
  agreedAt: number;
}

export interface TaxInquiryState {
  required: boolean;
  status: TaxInquiryStatus;
  note: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: number;
}

export interface IdentityTaxInquiryRecord {
  /** doc id＝`${period}_${studentUid}` */
  id: string;
  period: string;
  studentUid: string;
  studentName: string;
  grade: string;
  classCode: string;
  className: string;
  /** 身分別名稱快照（清單／CSV 顯示用） */
  identities: string[];
  /** 身分別勾選與進階選項 */
  identitySelections: IdentitySelection[];
  /** 財稅查調對象 */
  taxSubject: TaxSubject;
  father: ParentIdInfo;
  mother: ParentIdInfo;
  /** 已婚學生的本人資料（查調對象＝本人時使用） */
  self: ParentIdInfo;
  /** 監護人資料（查調對象＝監護人時使用） */
  guardian: ParentIdInfo;
  note: string;
  status: ConfirmationStatus;
  confirmedAt: number | null;
  personalDataConsent: PersonalDataConsent | null;
  taxInquiry: TaxInquiryState;
  updatedAt: number;
}

/** 名冊列（名冊學生＋確認紀錄合併） */
export interface InquiryRow {
  studentUid: string;
  studentName: string;
  studentId: string;
  seatNo: string;
  grade: string;
  classCode: string;
  className: string;
  status: ConfirmationStatus | "missing";
  identities: string[];
  identitySelections: IdentitySelection[];
  taxSubject: TaxSubject;
  taxInquiry: TaxInquiryState;
  father: ParentIdInfo;
  mother: ParentIdInfo;
  self: ParentIdInfo;
  guardian: ParentIdInfo;
  note: string;
  confirmedAt: number | null;
  updatedAt: number;
}

export const DEFAULT_IDENTITY_TAX_INQUIRY_SETTINGS: IdentityTaxInquirySettings = {
  enabled: false,
  openAt: null,
  closeAt: null,
  instructions: "",
  identityOptions: DEFAULT_IDENTITY_OPTIONS.map((option) => ({
    ...option,
    fields: option.fields.map((field) => ({ ...field, options: [...field.options] })),
  })),
  updatedAt: 0,
};

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanStringList(value: unknown, max: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of value) {
    const text = cleanString(item, max);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
    if (list.length >= limit) break;
  }
  return list;
}

/** 產生穩定 id（沿用既有、缺漏才新建） */
export function makeId(prefix: string, existing?: string): string {
  const text = cleanString(existing, 64).replace(/[^\w-]/g, "-");
  if (text) return text;
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeFieldOptions(value: unknown): IdentityFieldOption[] {
  if (!Array.isArray(value)) return [];
  const list: IdentityFieldOption[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const name = cleanString(item, IDENTITY_FIELD_VALUE_MAX);
      if (name) list.push({ code: "", name });
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const code = cleanString(record.code, 20);
      const name = cleanString(record.name, IDENTITY_FIELD_VALUE_MAX) || code;
      if (name || code) list.push({ code, name });
    }
    if (list.length >= IDENTITY_FIELD_OPTION_MAX) break;
  }
  return list;
}

function normalizeField(raw: unknown, index: number): IdentityFieldDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const label = cleanString(data.label, IDENTITY_FIELD_LABEL_MAX);
  if (!label) return null;
  const type: IdentityFieldType =
    data.type === "checkbox" ? "checkbox" : data.type === "text" ? "text" : "select";
  return {
    id: makeId("field", typeof data.id === "string" ? data.id : `field-${index + 1}`),
    type,
    label,
    required: data.required === true,
    options: type === "text" ? [] : normalizeFieldOptions(data.options),
  };
}

/** 舊資料（字串陣列）→ 新結構 */
function normalizeLegacyOptions(
  labels: string[],
  taxInquiryIdentities: string[]
): IdentityOptionDef[] {
  return labels.map((label, index) => {
    const preset = DEFAULT_IDENTITY_OPTIONS.find((option) => option.label === label) ?? null;
    const isTax = taxInquiryIdentities.includes(label) || Boolean(preset?.taxInquiry);
    return {
      id: preset?.id ?? `option-${index + 1}`,
      label,
      enabled: true,
      taxInquiry: isTax,
      exclusiveGroup: preset?.exclusiveGroup ?? "",
      benefitType: "",
      benefitAmount: null,
      benefitNote: "",
      fields: (preset?.fields ?? []).map((field) => ({ ...field, options: [...field.options] })),
    };
  });
}

function normalizeOption(raw: unknown, index: number): IdentityOptionDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const label = cleanString(data.label, IDENTITY_LABEL_MAX);
  if (!label) return null;
  const fields = Array.isArray(data.fields)
    ? data.fields
        .map((field, fieldIndex) => normalizeField(field, fieldIndex))
        .filter((field): field is IdentityFieldDef => field !== null)
        .slice(0, 10)
    : [];
  const amountRaw = data.benefitAmount;
  const benefitAmount =
    typeof amountRaw === "number" && Number.isInteger(amountRaw) && amountRaw > 0
      ? amountRaw
      : null;
  return {
    id: makeId("option", typeof data.id === "string" ? data.id : `option-${index + 1}`),
    label,
    enabled: data.enabled !== false,
    taxInquiry: data.taxInquiry === true,
    exclusiveGroup: cleanString(data.exclusiveGroup, 40),
    benefitType:
      data.benefitType === "reduction" || data.benefitType === "subsidy"
        ? data.benefitType
        : "",
    benefitAmount,
    benefitNote: cleanString(data.benefitNote, 100),
    fields,
  };
}

/** 寬容讀取設定（缺欄位回預設，舊格式自動升級） */
export function normalizeSettings(raw: unknown): IdentityTaxInquirySettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_IDENTITY_TAX_INQUIRY_SETTINGS };
  }
  const data = raw as Record<string, unknown>;
  let identityOptions: IdentityOptionDef[] = [];
  if (Array.isArray(data.identityOptions)) {
    const legacyLabels = data.identityOptions.filter(
      (item): item is string => typeof item === "string"
    );
    if (legacyLabels.length > 0) {
      const legacyTax = Array.isArray(data.taxInquiryIdentities)
        ? data.taxInquiryIdentities.filter((item): item is string => typeof item === "string")
        : [];
      identityOptions = normalizeLegacyOptions(
        cleanStringList(legacyLabels, IDENTITY_LABEL_MAX, IDENTITY_OPTION_MAX),
        legacyTax
      );
    } else {
      identityOptions = data.identityOptions
        .map((item, index) => normalizeOption(item, index))
        .filter((option): option is IdentityOptionDef => option !== null)
        .slice(0, IDENTITY_OPTION_MAX);
    }
  }
  // id 去重（避免舊資料重複）
  const seenIds = new Set<string>();
  identityOptions = identityOptions.map((option) => {
    let id = option.id;
    let suffix = 2;
    while (seenIds.has(id)) id = `${option.id}-${suffix++}`;
    seenIds.add(id);
    return { ...option, id };
  });
  const openAt = isEpoch(data.openAt) ? data.openAt : null;
  const closeAt = isEpoch(data.closeAt) ? data.closeAt : null;
  return {
    enabled: data.enabled === true,
    openAt,
    closeAt,
    instructions: typeof data.instructions === "string" ? data.instructions.slice(0, 20000) : "",
    identityOptions:
      identityOptions.length > 0
        ? identityOptions
        : DEFAULT_IDENTITY_OPTIONS.map((option) => ({
            ...option,
            fields: option.fields.map((field) => ({ ...field, options: [...field.options] })),
          })),
    updatedAt: isEpoch(data.updatedAt) ? data.updatedAt : 0,
  };
}

/** 確認期間狀態（未設定起訖＝unset；只設起＝無截止） */
export function windowStateOf(
  settings: Pick<IdentityTaxInquirySettings, "openAt" | "closeAt">,
  now = Date.now()
): IdentityWindowState {
  if (settings.openAt === null) return "unset";
  if (now < settings.openAt) return "upcoming";
  if (settings.closeAt !== null && now > settings.closeAt) return "ended";
  return "open";
}

/** 需要提供給學生勾選的身分別 */
export function enabledIdentityOptions(
  settings: Pick<IdentityTaxInquirySettings, "identityOptions">
): IdentityOptionDef[] {
  return settings.identityOptions.filter((option) => option.enabled);
}

/** 以 optionId／label 找設定中的身分別（相容改名前的舊資料） */
export function findIdentityOption(
  settings: Pick<IdentityTaxInquirySettings, "identityOptions">,
  selection: Pick<IdentitySelection, "optionId" | "label">
): IdentityOptionDef | null {
  return (
    settings.identityOptions.find((option) => option.id === selection.optionId) ??
    settings.identityOptions.find((option) => option.label === selection.label) ??
    null
  );
}

/** 是否為需要財稅查調的身分別組合 */
export function needsTaxInquiry(
  selections: Pick<IdentitySelection, "optionId" | "label">[],
  settings: Pick<IdentityTaxInquirySettings, "identityOptions">
): boolean {
  return selections.some((selection) => findIdentityOption(settings, selection)?.taxInquiry ?? false);
}

/** 依 label 清單回推 selections（舊紀錄沒有 identitySelections 時使用） */
export function selectionsFromLabels(
  labels: string[],
  settings: Pick<IdentityTaxInquirySettings, "identityOptions">
): IdentitySelection[] {
  return labels.map((label) => {
    const def =
      settings.identityOptions.find((option) => option.label === label) ??
      settings.identityOptions.find((option) => option.id === label) ??
      null;
    return { optionId: def?.id ?? label, label: def?.label ?? label, values: {} };
  });
}

/** 身分別摘要（含進階選項），供名冊／家長端顯示 */
export function summarizeSelections(selections: IdentitySelection[]): string {
  return selections
    .map((selection) => {
      const extras = Object.values(selection.values)
        .flat()
        .filter((value) => value.trim() !== "");
      return extras.length > 0 ? `${selection.label}（${extras.join("／")}）` : selection.label;
    })
    .join("、");
}

/** 中華民國身分證字號格式（1 英文字母＋1 或 2＋8 碼數字） */
export function isValidIdNumber(value: string): boolean {
  return /^[A-Z][12]\d{8}$/.test(value.trim().toUpperCase());
}

/** 顯示用遮蔽：保留首字母與末 3 碼 */
export function maskIdNumber(value: string): string {
  const text = value.trim().toUpperCase();
  if (text.length < 5) return text ? "＊".repeat(text.length) : "";
  return `${text.slice(0, 1)}${"＊".repeat(text.length - 4)}${text.slice(-3)}`;
}

export function periodLabelOf(period: { academicYear: number; semester: number }): string {
  return `${period.academicYear}-${period.semester}`;
}

export function formatDateTime(epoch: number | null): string {
  if (!epoch) return "—";
  const date = new Date(epoch);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** 本地時間 → `datetime-local` 值 */
export function toDateTimeLocal(epoch: number | null): string {
  if (!epoch) return "";
  const date = new Date(epoch);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** `datetime-local` 值 → epoch ms；空字串回 null */
export function fromDateTimeLocal(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export interface RecordInput {
  identities: string[];
  identitySelections: IdentitySelection[];
  taxSubject: TaxSubject;
  father: ParentIdInfo;
  mother: ParentIdInfo;
  self: ParentIdInfo;
  guardian: ParentIdInfo;
  note: string;
  personalDataConsentVersion: string | null;
}

export type ParseRecordResult =
  | { ok: true; value: RecordInput }
  | { ok: false; message: string };

function readParentInfo(value: unknown): ParentIdInfo {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    idNumber: cleanString(record.idNumber, 10).toUpperCase(),
  };
}

function isCompleteParent(parent: ParentIdInfo): boolean {
  return isValidIdNumber(parent.idNumber);
}

/** 解析單一身分別的進階選項；confirm 時檢查必填與選項合法性 */
function parseSelectionFields(
  def: IdentityOptionDef,
  rawValues: unknown,
  mode: "draft" | "confirm"
): { ok: true; values: Record<string, string[]> } | { ok: false; message: string } {
  const source =
    rawValues && typeof rawValues === "object" && !Array.isArray(rawValues)
      ? (rawValues as Record<string, unknown>)
      : {};
  const values: Record<string, string[]> = {};
  for (const field of def.fields) {
    const raw = source[field.id];
    const picked = cleanStringList(
      raw,
      IDENTITY_FIELD_VALUE_MAX,
      field.type === "select" ? 1 : IDENTITY_FIELD_OPTION_MAX
    );
    if (field.type === "text") {
      const text = picked[0] ?? "";
      if (mode === "confirm" && field.required && !text) {
        return { ok: false, message: `「${def.label}」請填寫${field.label}` };
      }
      if (field.label.includes("身分證") && text && !isValidIdNumber(text)) {
        return { ok: false, message: `「${def.label}」${field.label}格式不正確（例：A123456789）` };
      }
      values[field.id] = text ? [text] : [];
      continue;
    }
    if (field.options.length === 0) {
      values[field.id] = [];
      continue;
    }
    const allowed = field.options.map((option) => fieldOptionName(option));
    const invalid = picked.find((value) => !allowed.includes(value));
    if (invalid) {
      return { ok: false, message: `「${def.label}」的${field.label}選項不正確，請重新選擇` };
    }
    if (mode === "confirm" && field.required && picked.length === 0) {
      return { ok: false, message: `「${def.label}」請選擇${field.label}` };
    }
    values[field.id] = picked;
  }
  return { ok: true, values };
}

/**
 * 解析學生送出的確認內容。
 * - `mode: "confirm"`：須同意目前版本的個資授權、至少一個身分別、互斥群組僅能擇一、
 *   必填進階選項須填寫；需要查調時依查調對象檢查證號。
 * - `mode: "draft"`：允許不完整，但已填的內容仍須合法。
 */
export function parseRecordInput(
  raw: unknown,
  settings: Pick<IdentityTaxInquirySettings, "identityOptions">,
  mode: "draft" | "confirm"
): ParseRecordResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "缺少確認內容" };
  }
  const data = raw as Record<string, unknown>;
  if (
    mode === "confirm" &&
    (data.personalDataConsent !== true ||
      data.personalDataConsentVersion !== PERSONAL_DATA_CONSENT_VERSION)
  ) {
    return { ok: false, message: "請閱讀並同意本次個人資料授權後再送出確認" };
  }
  const rawSelections = Array.isArray(data.identitySelections) ? data.identitySelections : [];

  const selections: IdentitySelection[] = [];
  const seenOptions = new Set<string>();
  for (const item of rawSelections) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const optionId = cleanString(entry.optionId, 64);
    const label = cleanString(entry.label, IDENTITY_LABEL_MAX);
    const def =
      settings.identityOptions.find((option) => option.id === optionId) ??
      settings.identityOptions.find((option) => option.label === label) ??
      null;
    if (!def) return { ok: false, message: "包含未開放的身分別，請重新選擇" };
    if (!def.enabled) return { ok: false, message: `「${def.label}」目前未開放勾選` };
    if (seenOptions.has(def.id)) continue;
    seenOptions.add(def.id);
    const parsedFields = parseSelectionFields(def, entry.values, mode);
    if (!parsedFields.ok) return { ok: false, message: parsedFields.message };
    selections.push({ optionId: def.id, label: def.label, values: parsedFields.values });
    if (selections.length >= IDENTITY_OPTION_MAX) break;
  }

  // 互斥群組：同一群組僅能勾選一個
  const groups = new Map<string, string>();
  for (const selection of selections) {
    const def = settings.identityOptions.find((option) => option.id === selection.optionId);
    const group = def?.exclusiveGroup ?? "";
    if (!group) continue;
    const existing = groups.get(group);
    if (existing && existing !== selection.label) {
      return {
        ok: false,
        message: `「${existing}」與「${selection.label}」只能擇一勾選`,
      };
    }
    groups.set(group, selection.label);
  }

  const father = readParentInfo(data.father);
  const mother = readParentInfo(data.mother);
  const self = readParentInfo(data.self);
  const guardian = readParentInfo(data.guardian);
  for (const parent of [father, mother, self, guardian]) {
    if (parent.idNumber && !isValidIdNumber(parent.idNumber)) {
      return { ok: false, message: "身分證字號格式不正確（例：A123456789）" };
    }
  }

  const taxSubject: TaxSubject =
    data.taxSubject === "one"
      ? "one"
      : data.taxSubject === "self"
        ? "self"
        : data.taxSubject === "guardian"
          ? "guardian"
          : "both";
  const note = cleanString(data.note, NOTE_MAX);

  if (mode === "confirm") {
    if (selections.length === 0) return { ok: false, message: "請至少選擇一個註冊身分別" };
    if (needsTaxInquiry(selections, settings)) {
      if (taxSubject === "both" && !(isCompleteParent(father) && isCompleteParent(mother))) {
        return {
          ok: false,
          message: "此身分別需要財稅查調，請填寫父、母雙方的身分證字號",
        };
      }
      if (taxSubject === "one" && !(isCompleteParent(father) || isCompleteParent(mother))) {
        return {
          ok: false,
          message: "父母離異或一方亡故時，請填寫具有撫養權或存續一方的身分證字號",
        };
      }
      if (taxSubject === "self" && !isCompleteParent(self)) {
        return { ok: false, message: "已結婚者請填寫本人的身分證字號" };
      }
      if (taxSubject === "guardian" && !isCompleteParent(guardian)) {
        return { ok: false, message: "請填寫監護人的身分證字號" };
      }
    }
  }

  return {
    ok: true,
    value: {
      identities: selections.map((selection) => selection.label),
      identitySelections: selections,
      taxSubject,
      father,
      mother,
      self,
      guardian,
      note,
      personalDataConsentVersion: mode === "confirm" ? PERSONAL_DATA_CONSENT_VERSION : null,
    },
  };
}

export interface StudentPagePayload {
  success: boolean;
  maintenance?: boolean;
  message?: string;
  settings: IdentityTaxInquirySettings;
  record: IdentityTaxInquiryRecord | null;
  period: string;
  windowState: IdentityWindowState;
  student: { name: string; className: string };
}

export interface StaffRoles {
  isTutor: boolean;
  classCode: string;
  permissions: string[];
}

export interface InquiryStats {
  total: number;
  confirmed: number;
  draft: number;
  missing: number;
  taxPending: number;
  taxDone: number;
  taxExempt: number;
}

export function buildStats(rows: InquiryRow[]): InquiryStats {
  const stats: InquiryStats = {
    total: rows.length,
    confirmed: 0,
    draft: 0,
    missing: 0,
    taxPending: 0,
    taxDone: 0,
    taxExempt: 0,
  };
  for (const row of rows) {
    if (row.status === "confirmed") stats.confirmed += 1;
    else if (row.status === "draft") stats.draft += 1;
    else stats.missing += 1;
    if (row.taxInquiry.status === "pending") stats.taxPending += 1;
    else if (row.taxInquiry.status === "done") stats.taxDone += 1;
    else if (row.taxInquiry.status === "exempt") stats.taxExempt += 1;
  }
  return stats;
}
