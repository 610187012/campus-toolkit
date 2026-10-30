/**
 * 升學考試與模擬考校內報名：共用資料模型與純函式驗證。
 * 本檔 client/server 共用（頁面與 API 都會 import），禁止任何 server-only 匯入。
 *
 * 狀態機：draft → open ⇄ closed → archived（archived 不可逆）；
 * 登錄文件存在＝已登錄、取消＝刪除文件（對應 GAS 的「報名情形」欄，語意更單純）。
 */

export type ExamEventType = "draft" | "open" | "closed" | "archived";
export type ExamCategory = "mock" | "entrance" | "other";
export type UniversityArtsExamGroup = "music" | "art" | "sports";
/** 報名方式（單一制）：一般報名 */
export type ExamMode = "review";
/** 報名義務：必須報名（要嘛報、要嘛勾不報名+原因）／自由報名（不需動作即可） */
export type ExamRegistrationMode = "required" | "optional";
/** 繳費身分：1 一般生／2 低收入戶（免繳）／3 中低收入戶（減免） */
export type ExamFeeCode = "1" | "2" | "3";
/** 審核結果（僅 examMode=review 使用） */
export type ExamReviewStatus = "pending" | "admitted" | "waitlist" | "rejected";

export const EXAM_EVENT_STATUS_LABELS: Record<ExamEventType, string> = {
  draft: "草稿",
  open: "開放報名",
  closed: "已截止",
  archived: "已封存",
};

export const EXAM_CATEGORY_LABELS: Record<ExamCategory, string> = {
  mock: "模擬考",
  entrance: "升學考試",
  other: "其他",
};

export const EXAM_MODE_LABELS: Record<ExamMode, string> = {
  review: "一般報名",
};

export const EXAM_REGISTRATION_MODE_LABELS: Record<ExamRegistrationMode, string> = {
  required: "必須報名",
  optional: "自由報名",
};

/** 國內主要升學考試常見正式名稱與簡稱。 */
const OFFICIAL_ENTRANCE_EXAM_TITLE_PATTERNS = [
  /國中教育會考|教育會考|國中會考|會考/,
  /學科能力測驗|大學學測|學測/,
  /分科測驗|指定科目考試|指考/,
  /高中英語聽力測驗|英語聽力測驗|高中英聽|英聽/,
  /大學術科考試(?:音樂組|美術組|體育組)|大學術科考試|術科考試/,
  /四技二專統一入學測驗|統一入學測驗|四技二專統測|統測/,
  /國中基本學力測驗|國中基測|基測/,
];

/** 場次名稱是否指向國內主要升學考試；模擬考名稱不標示為正式考試。 */
export function isOfficialEntranceExamTitle(title: string): boolean {
  const normalized = title.normalize("NFKC").replace(/[\s　，,、：:（）()【】［］\[\]「」『』]/g, "");
  if (/模擬|模考|練習/.test(normalized)) return false;
  return OFFICIAL_ENTRANCE_EXAM_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 高中英語聽力測驗第一、二次考試使用專屬官方報名資料格式。 */
export function isHighSchoolEnglishListeningExamTitle(title: string): boolean {
  const normalized = title.normalize("NFKC").replace(/[\s　，,、：:（）()【】［］\[\]「」『』]/g, "");
  if (/模擬|模考|練習/.test(normalized)) return false;
  return /高中英語聽力測驗第(?:一|二|1|2)次考試/.test(normalized);
}

/** 分科測驗（含舊稱指定科目考試／指考）使用專屬官方報名資料格式。 */
export function isSubjectAptitudeExamTitle(title: string): boolean {
  const normalized = title.normalize("NFKC").replace(/[\s　，,、：:（）()【】［］\[\]「」『』]/g, "");
  if (/模擬|模考|練習/.test(normalized)) return false;
  return /分科測驗|指定科目考試|指考/.test(normalized);
}

/** 學科能力測驗（學測）使用專屬官方報名資料格式。 */
export function isAcademicAbilityExamTitle(title: string): boolean {
  const normalized = title.normalize("NFKC").replace(/[\s　，,、：:（）()【】［］\[\]「」『』]/g, "");
  if (/模擬|模考|練習/.test(normalized)) return false;
  return /學科能力測驗|大學學測|學測/.test(normalized);
}

/** 取得大學術科考試的報考組別，三組共用同一份官方報名檔欄位。 */
export function getUniversityArtsExamGroup(title: string): UniversityArtsExamGroup | null {
  const normalized = title.normalize("NFKC").replace(/[\s　，,、：:（）()【】［］\[\]「」『』]/g, "");
  if (/模擬|模考|練習/.test(normalized)) return null;
  if (/大學術科考試音樂組|術科考試音樂組/.test(normalized)) return "music";
  if (/大學術科考試美術組|術科考試美術組/.test(normalized)) return "art";
  if (/大學術科考試體育組|術科考試體育組/.test(normalized)) return "sports";
  return null;
}

export const EXAM_FEE_CODE_LABELS: Record<ExamFeeCode, string> = {
  "1": "一般生",
  "2": "低收入戶",
  "3": "中低收入戶",
};

export const EXAM_REVIEW_STATUS_LABELS: Record<ExamReviewStatus, string> = {
  pending: "待審核",
  admitted: "錄取",
  waitlist: "備取",
  rejected: "不錄取",
};

export const EXAM_EVENT_LIMITS = {
  title: 80,
  location: 120,
  /** 地點選項代碼長度上限（唯一） */
  locationCode: 20,
  /** 地點選項名稱長度上限 */
  locationLabel: 40,
  /** 進階選項代碼長度上限（唯一） */
  advancedOptionCode: 20,
  /** 進階選項名稱長度上限 */
  advancedOptionLabel: 40,
  note: 500,
  subjectLabel: 40,
  subjectsMin: 1,
  subjectsMax: 15,
  gradesMax: 10,
  classesMax: 60,
  fee: 100000,
} as const;

export interface ExamSubject {
  key: string;
  label: string;
  /** 啟用進階選項（學生端可再選子項） */
  enableAdvancedOption?: boolean;
  /** 該科可選進階選項（啟用時至少一項） */
  advancedOptions?: ExamAdvancedOption[];
  /** 一般生應繳（元）；省略或 0＝免收 */
  feeStandard?: number;
  /** 中低收入戶應繳（元）；省略或 0＝免收 */
  feeReduced?: number;
}

export interface ExamEventTarget {
  /** 年級代碼（對應名冊 `grade`，如 "1"）；必填 */
  grades: string[];
  /** 班級代碼（對應名冊 `classCode`，如 "101"）；空陣列＝該年級全體 */
  classes: string[];
}

export interface ExamAnnouncementSync {
  enabled: boolean;
  categoryId: string;
  /** 空字串＝依場次資訊自動產生 */
  body: string;
}

export interface ExamCalendarSync {
  enabled: boolean;
  categoryId: string;
  publishUnit: string;
  /** 空字串＝沿用場次設定的考試地點 */
  location: string;
}

/** 考試地點選項（僅升學考試場次；對齊 GAS 管道「試場」欄：代碼＋名稱＋可設預設） */
export interface ExamLocationOption {
  /** 選項代碼（唯一，登錄存此碼） */
  code: string;
  /** 顯示名稱 */
  label: string;
  /** 預設選中（最多一項；缺省＝依清單順序第一項） */
  isDefault?: boolean;
}

/** 科目進階選項（代碼＋顯示名稱） */
export interface ExamAdvancedOption {
  code: string;
  label: string;
}

export interface ExamEvent {
  id: string;
  title: string;
  examType: ExamCategory;
  /** 考試日期（起，YYYY-MM-DD，日期僅日不涉時區） */
  examDate: string;
  /** 考試結束日（訖，YYYY-MM-DD）；空字串＝單日（對齊 GAS 考程起訖） */
  examEndDate: string;
  /** 舊版自由文字地點（向後相容；新事件一律走 locationOptions） */
  location: string;
  /** 考試地點選項（僅 entrance；空陣列＝試場由主辦單位分配，學生端不出下拉） */
  locationOptions: ExamLocationOption[];
  note: string;
  /** 報名截止（關閉時間，epoch ms）；過後唯讀，即使 status 仍是 open 也收斂為 closed */
  deadline: number;
  /** 報名開放時間（epoch ms）；0＝轉開放即可報；future 時學生端顯示 upcoming 未開放 */
  registrationOpenAt: number;
  subjects: ExamSubject[];
  target: ExamEventTarget;
  /** 基本費用（元）：standard＝一般生／reduced＝中低收入戶（低收入戶免繳＝0） */
  basicFee: { standard: number; reduced: number };
  /** 報名方式（單一一般報名；保留欄位供資料相容） */
  examMode: ExamMode;
  /** 報名義務：required＝要嘛報名要嘛勾不報名；optional＝自由（缺省） */
  registrationMode: ExamRegistrationMode;
  /** 是否允許學生自行封存報名資料；舊場次缺欄位時維持既有功能 */
  studentArchiveEnabled: boolean;
  /** 場次開放時同步發送系統公告；舊場次預設沿用既有自動發佈行為 */
  announcementSync: ExamAnnouncementSync;
  /** 場次開放時同步發布至行事曆；舊場次預設沿用既有自動發佈行為 */
  calendarSync: ExamCalendarSync;
  status: ExamEventType;
  createdBy: { uid: string; name: string };
  createdAt: number;
  updatedAt: number;
}

export interface ExamRegistration {
  id: string;
  eventId: string;
  studentUid: string;
  studentName: string;
  studentClass: string;
  studentGrade: string;
  /** 學號（名冊有才帶，CSV 造冊用） */
  studentId: string;
  /** 名冊班級名稱（向後相容：舊登錄可能沒有） */
  studentClassName?: string;
  /** 名冊班號（向後相容：舊登錄可能沒有） */
  studentRollNo?: string;
  /** 座號（名冊有才帶） */
  seatNo: string;
  subjectKeys: string[];
  /** 已選科目的進階選項代碼（key=subject.key, value=advancedOption.code） */
  subjectAdvancedOptionCodes: Record<string, string>;
  /** 不報名（required 場次的明確拒絕；true 時 subjectKeys 恆空、optOutReason 必填） */
  optOut: boolean;
  /** 不報名原因（optOut=true 時必填） */
  optOutReason: string;
  /** 所選考試地點代碼（場次有選項時必選；optOut 恆空） */
  locationCode: string;
  /** 勾選「非冷氣試場」（optOut 恆 false） */
  nonAirConditionedRoom: boolean;
  /** 特殊應考服務需求（optOut 恆空） */
  examServiceNote: string;
  /** 繳費身分（缺省 1 一般生） */
  feeCode: ExamFeeCode;
  /** 應繳費用（元，提交時由伺服端依科目組合試算快照；optOut 或低收＝0） */
  feeAmount: number;
  /** 資料封存：學生確認後凍結（唯讀）；承辦可解除 */
  archived: boolean;
  archivedAt: number | null;
  /** 保留欄位（歷史資料相容） */
  reviewStatus: ExamReviewStatus;
  createdAt: number;
  updatedAt: number;
}

/** 學生端場次視圖：status 已依報名期間收斂（upcoming 未開放／open 開放中／closed 已截止） */
export interface StudentExamEvent extends Omit<ExamEvent, "status" | "announcementSync" | "calendarSync"> {
  status: "upcoming" | "open" | "closed";
  mySubjectKeys: string[];
  /** 本人各科進階選項代碼（僅已選科目且有進階選項的科目） */
  mySubjectAdvancedOptionCodes: Record<string, string>;
  registeredAt: number | null;
  /** 本人登錄的保留審核欄位（未登錄為 null） */
  reviewStatus: ExamReviewStatus | null;
  /** 本人是否勾選不報名 */
  myOptOut: boolean;
  /** 本人不報名原因 */
  myOptOutReason: string;
  /** 本人所選考試地點代碼（未選為 ""） */
  myLocationCode: string;
  /** 本人是否勾選非冷氣試場 */
  myNonAirConditionedRoom: boolean;
  /** 本人特殊應考服務需求 */
  myExamServiceNote: string;
  /** 本人繳費身分（未登錄為 null） */
  myFeeCode: ExamFeeCode | null;
  /** 本人應繳費用（未登錄為 null） */
  myFeeAmount: number | null;
  /** 本人是否已封存（凍結唯讀） */
  myArchived: boolean;
}

export interface ExamRosterSummary {
  /** 應報名人數（符合場次目標對象的學生總數） */
  applicableCount: number;
  total: number;
  /** 已報名（有登錄且 optOut=false） */
  registeredCount: number;
  /** 不報名（optOut=true） */
  optOutCount: number;
  /** 已封存筆數 */
  archivedCount: number;
  bySubject: Record<string, { label: string; count: number }>;
  byClass: Record<string, number>;
}

/** 名冊列：並列顯示已報名與未報名學生（報名狀態 + 登錄資料合併） */
export interface ExamRosterStudent {
  studentUid: string;
  studentClass: string;
  studentGrade: string;
  studentName: string;
  seatNo: string;
  studentId: string;
  studentClassName: string;
  studentRollNo: string;
  /** 報名狀態：registered=完成報名 / opt_out=不報名 / pending=未完成報名 */
  status: "registered" | "opt_out" | "pending";
  /** 登錄資料（pending 時為 null） */
  registration: ExamRegistration | null;
}

/** 管理端場次名單＋統計（API 回應與頁面共用，不放在 server-only 的 lib） */
export interface ExamEventRoster {
  eventId: string;
  event: ExamEvent;
  registrations: ExamRegistration[];
  /** 全部應報名學生（含未報名，並列顯示） */
  students: ExamRosterStudent[];
  summary: ExamRosterSummary;
  epoch: number;
}

/** 延遲載入：班級分頁清單（初次載入，不含登錄明細） */
export interface ExamClassTabs {
  eventId: string;
  event: ExamEvent;
  classTabs: Array<{ key: string; label: string; count: number }>;
  applicableCount: number;
  epoch: number;
}

/** 延遲載入：單班名冊（點選班級分頁時載入） */
export interface ExamClassRoster {
  classCode: string;
  students: ExamRosterStudent[];
  classSummary: {
    total: number;
    registeredCount: number;
    optOutCount: number;
    archivedCount: number;
  };
  epoch: number;
}

export interface ExamEventDraft {
  title: string;
  examType: ExamCategory;
  examDate: string;
  /** 考試結束日；""＝單日 */
  examEndDate: string;
  /** 舊版文字地點（向後相容透傳） */
  location: string;
  /** 地點選項（僅 entrance；其他類型強制 []） */
  locationOptions: ExamLocationOption[];
  note: string;
  deadline: number;
  /** 報名開放時間；0＝轉開放即可報 */
  registrationOpenAt: number;
  subjects: ExamSubject[];
  target: ExamEventTarget;
  basicFee: { standard: number; reduced: number };
  examMode: ExamMode;
  registrationMode: ExamRegistrationMode;
  /** 是否允許學生自行封存報名資料 */
  studentArchiveEnabled: boolean;
  announcementSync: ExamAnnouncementSync;
  calendarSync: ExamCalendarSync;
  status: ExamEventType;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function isExamEventType(value: unknown): value is ExamEventType {
  return value === "draft" || value === "open" || value === "closed" || value === "archived";
}

export function isExamCategory(value: unknown): value is ExamCategory {
  return value === "mock" || value === "entrance" || value === "other";
}

export function isExamMode(value: unknown): value is ExamMode {
  return value === "review";
}

export function isExamRegistrationMode(value: unknown): value is ExamRegistrationMode {
  return value === "required" || value === "optional";
}

export function isExamFeeCode(value: unknown): value is ExamFeeCode {
  return value === "1" || value === "2" || value === "3";
}

export function isExamReviewStatus(value: unknown): value is ExamReviewStatus {
  return value === "pending" || value === "admitted" || value === "waitlist" || value === "rejected";
}

/**
 * 依報名期間收斂狀態（對齊 GAS `_checkTimeWindow` 三態）：
 * open 且已過截止 → closed；open 且未到開放時間 → upcoming（承辦未及時操作也不會誤放行）。
 */
export type ExamEffectiveStatus = "draft" | "upcoming" | "open" | "closed" | "archived";

export function effectiveExamStatus(
  event: Pick<ExamEvent, "status" | "deadline" | "registrationOpenAt">,
  now = Date.now()
): ExamEffectiveStatus {
  if (event.status === "open" && event.deadline <= now) return "closed";
  if (event.status === "open" && event.registrationOpenAt > 0 && event.registrationOpenAt > now) {
    return "upcoming";
  }
  return event.status;
}

export function isExamOpen(
  event: Pick<ExamEvent, "status" | "deadline" | "registrationOpenAt">,
  now = Date.now()
): boolean {
  return effectiveExamStatus(event, now) === "open";
}

/** 日期顯示固定為西元 `yyyy/mm/dd`；資料儲存與 API 仍使用 ISO `yyyy-mm-dd`。 */
export function formatExamDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : value;
}

/** 日期時間顯示固定為 `yyyy/mm/dd HH:mm`（24 小時制）。 */
export function formatExamDateTime(ms: number, emptyValue = "—"): string {
  if (!ms) return emptyValue;
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = String(date.getFullYear()).padStart(4, "0");
  return `${year}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 考試日期範圍顯示（單日原樣、多日 `起 ~ 訖`）。 */
export function formatExamDateRange(event: Pick<ExamEvent, "examDate" | "examEndDate">): string {
  const start = formatExamDate(event.examDate);
  const end = event.examEndDate ? formatExamDate(event.examEndDate) : "";
  return end ? `${start} ~ ${end}` : start;
}

/** 由選項清單反查顯示名稱（無對應回傳原代碼；無選項回傳 ""） */
export function resolveLocationLabel(
  options: ExamLocationOption[] | undefined,
  code: string
): string {
  if (!options?.length || !code) return "";
  return options.find((option) => option.code === code)?.label ?? code;
}

/** 狀態機：draft→open⇄closed→archived；open 可退回 draft（撤回），archived 不可逆 */
export function canTransitionExamStatus(from: ExamEventType, to: ExamEventType): boolean {
  if (from === to) return true;
  if (from === "archived") return false;
  if (from === "draft") return to === "open" || to === "archived";
  if (from === "open") return to === "closed" || to === "draft";
  return to === "open" || to === "archived";
}

/** 對象過濾（伺服端強制）：年級必中；班級有指定時須在名單內 */
export function isTargetMatch(
  target: ExamEventTarget,
  student: { grade: string; classCode: string }
): boolean {
  if (!target.grades.includes(student.grade)) return false;
  if (!target.classes.length) return true;
  return target.classes.includes(student.classCode);
}

export function parseSubjectKeys(raw: unknown): string[] {
  const source = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of source.slice(0, EXAM_EVENT_LIMITS.subjectsMax)) {
    if (typeof item !== "string") continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** 剔除已不存在的科目（科目被承辦刪除後，舊登錄鍵自動失效） */
export function pickValidSubjectKeys(keys: string[], subjects: ExamSubject[]): string[] {
  const valid = new Set(subjects.map((subject) => subject.key));
  return keys.filter((key) => valid.has(key));
}

export function makeSubjectKey(taken: Set<string>): string {
  let key = "";
  do {
    key = `s_${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(key));
  return key;
}

/**
 * 科目清單解析：逐項接受 `{key,label}` 或純字串（=新增）。
 * 既有 key 原樣保留（登錄鍵不因改名／排序而失效），重複或缺 key 才重產。
 */
export function parseExamSubjects(raw: unknown): ParseResult<ExamSubject[]> {
  if (!Array.isArray(raw)) return { ok: false, message: "科目清單格式無效" };
  const min = EXAM_EVENT_LIMITS.subjectsMin;
  const max = EXAM_EVENT_LIMITS.subjectsMax;
  if (raw.length < min || raw.length > max) {
    return { ok: false, message: `科目數量需 ${min}～${max} 項（目前 ${raw.length} 項）` };
  }
  const seenKeys = new Set<string>();
  const labels: string[] = [];
  const list: ExamSubject[] = [];
  for (const item of raw) {
    let label = "";
    let key = "";
    let enableAdvancedOption = false;
    let advancedOptions: ExamAdvancedOption[] = [];
    let feeStandard = 0;
    let feeReduced = 0;
    if (typeof item === "string") {
      label = item.trim();
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      label = typeof record.label === "string" ? record.label.trim() : "";
      key = typeof record.key === "string" ? record.key.trim() : "";
      const parsedAdvancedOptions = parseExamAdvancedOptions(record.advancedOptions);
      if (!parsedAdvancedOptions.ok) {
        return {
          ok: false,
          message: `科目「${label || "（未命名）"}」的進階選項${parsedAdvancedOptions.message}`,
        };
      }
      advancedOptions = parsedAdvancedOptions.value;
      enableAdvancedOption = record.enableAdvancedOption === true || advancedOptions.length > 0;
      if (enableAdvancedOption && !advancedOptions.length) {
        return {
          ok: false,
          message: `科目「${label || "（未命名）"}」啟用進階選項時，請至少新增一個進階選項`,
        };
      }
      const feeN = parseFeeField(record.feeStandard);
      const feeR = parseFeeField(record.feeReduced);
      if (!feeN.ok) return { ok: false, message: `科目「${label || "（未命名）"}」的一般生費用${feeN.message}` };
      if (!feeR.ok) return { ok: false, message: `科目「${label || "（未命名）"}」的減免費用${feeR.message}` };
      feeStandard = feeN.value;
      feeReduced = feeR.value;
    } else {
      return { ok: false, message: "科目格式無效" };
    }
    if (!label) return { ok: false, message: "科目名稱不可為空" };
    if (label.length > EXAM_EVENT_LIMITS.subjectLabel) {
      return { ok: false, message: `科目名稱過長（最多 ${EXAM_EVENT_LIMITS.subjectLabel} 字）：${label}` };
    }
    if (labels.includes(label)) return { ok: false, message: `科目名稱重複：${label}` };
    labels.push(label);
    if (!key || seenKeys.has(key)) key = makeSubjectKey(seenKeys);
    seenKeys.add(key);
    const entry: ExamSubject = { key, label };
    if (enableAdvancedOption) entry.enableAdvancedOption = true;
    if (enableAdvancedOption && advancedOptions.length) entry.advancedOptions = advancedOptions;
    if (feeStandard > 0) entry.feeStandard = feeStandard;
    if (feeReduced > 0) entry.feeReduced = feeReduced;
    list.push(entry);
  }
  return { ok: true, value: list };
}

export function parseExamAdvancedOptions(raw: unknown): ParseResult<ExamAdvancedOption[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "進階選項格式無效" };
  const seenCodes = new Set<string>();
  const list: ExamAdvancedOption[] = [];
  for (const item of raw) {
    const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const code = textOrEmpty(record.code);
    const label = textOrEmpty(record.label);
    if (!code && !label) continue;
    if (!code) return { ok: false, message: "進階選項代碼不可為空" };
    if (!label) return { ok: false, message: `進階選項「${code}」缺少名稱` };
    if (code.length > EXAM_EVENT_LIMITS.advancedOptionCode) {
      return {
        ok: false,
        message: `進階選項代碼過長（最多 ${EXAM_EVENT_LIMITS.advancedOptionCode} 字）：${code}`,
      };
    }
    if (label.length > EXAM_EVENT_LIMITS.advancedOptionLabel) {
      return {
        ok: false,
        message: `進階選項名稱過長（最多 ${EXAM_EVENT_LIMITS.advancedOptionLabel} 字）：${label}`,
      };
    }
    if (seenCodes.has(code)) return { ok: false, message: `進階選項代碼重複：${code}` };
    seenCodes.add(code);
    list.push({ code, label });
  }
  return { ok: true, value: list };
}

/** 費用欄位：留空/0＝免收；否則需 0～fee 上限的整數 */
function parseFeeField(raw: unknown): ParseResult<number> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: 0 };
  const fee = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(fee) || fee < 0 || fee > EXAM_EVENT_LIMITS.fee) {
    return { ok: false, message: "無效（需 0～" + EXAM_EVENT_LIMITS.fee + " 的整數，0 或留空＝免收）" };
  }
  return { ok: true, value: fee };
}

export function parseExamTarget(raw: unknown): ParseResult<ExamEventTarget> {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const grades = uniqueStrings(record.grades);
  const classes = uniqueStrings(record.classes);
  if (!grades.length) return { ok: false, message: "請至少指定一個年級" };
  if (grades.length > EXAM_EVENT_LIMITS.gradesMax) {
    return { ok: false, message: `年級數量過多（最多 ${EXAM_EVENT_LIMITS.gradesMax} 個）` };
  }
  if (classes.length > EXAM_EVENT_LIMITS.classesMax) {
    return { ok: false, message: `班級數量過多（最多 ${EXAM_EVENT_LIMITS.classesMax} 個）` };
  }
  return { ok: true, value: { grades, classes } };
}

/**
 * 考試地點選項解析（無數量上限；code 唯一、≤20 字，label ≤40 字）。
 * isDefault 最多一項——多標時保留第一個、其餘清除（對齊 GAS「,預設」語意）。
 */
export function parseExamLocationOptions(raw: unknown): ParseResult<ExamLocationOption[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "地點選項格式無效" };
  const seenCodes = new Set<string>();
  const list: ExamLocationOption[] = [];
  let defaultSeen = false;
  for (const item of raw) {
    const record = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const code = textOrEmpty(record.code);
    const label = textOrEmpty(record.label);
    if (!code && !label) continue;
    if (!code) return { ok: false, message: "地點選項代碼不可為空" };
    if (!label) return { ok: false, message: `地點選項「${code}」缺少名稱` };
    if (code.length > EXAM_EVENT_LIMITS.locationCode) {
      return { ok: false, message: `地點代碼過長（最多 ${EXAM_EVENT_LIMITS.locationCode} 字）：${code}` };
    }
    if (label.length > EXAM_EVENT_LIMITS.locationLabel) {
      return { ok: false, message: `地點名稱過長（最多 ${EXAM_EVENT_LIMITS.locationLabel} 字）：${label}` };
    }
    if (seenCodes.has(code)) return { ok: false, message: `地點代碼重複：${code}` };
    seenCodes.add(code);
    const entry: ExamLocationOption = { code, label };
    if (record.isDefault === true && !defaultSeen) {
      defaultSeen = true;
      entry.isDefault = true;
    }
    list.push(entry);
  }
  return { ok: true, value: list };
}

/** 建立／更新共用的整份草稿驗證（更新時由呼叫端先併入既有值） */
export function parseExamEventDraft(raw: unknown): ParseResult<ExamEventDraft> {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];

  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) errors.push("請輸入場次名稱");
  else if (title.length > EXAM_EVENT_LIMITS.title) {
    errors.push(`場次名稱過長（最多 ${EXAM_EVENT_LIMITS.title} 字）`);
  }

  const examType = isExamCategory(record.examType) ? record.examType : null;
  if (!examType) errors.push("請選擇考試類型");

  const examDate = typeof record.examDate === "string" ? record.examDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate) || Number.isNaN(Date.parse(examDate))) {
    errors.push("考試日期格式無效（需 YYYY-MM-DD）");
  }
  const examEndDate = typeof record.examEndDate === "string" ? record.examEndDate.trim() : "";
  if (examEndDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(examEndDate) || Number.isNaN(Date.parse(examEndDate))) {
      errors.push("考試結束日格式無效（需 YYYY-MM-DD）");
    } else if (examDate && examEndDate < examDate) {
      errors.push("考試結束日不可早於開始日");
    }
  }

  const deadline = typeof record.deadline === "number" ? record.deadline : 0;
  if (!Number.isFinite(deadline) || deadline <= 0) errors.push("請設定報名截止時間");
  const registrationOpenAt =
    typeof record.registrationOpenAt === "number" && Number.isFinite(record.registrationOpenAt) && record.registrationOpenAt > 0
      ? record.registrationOpenAt
      : 0;
  if (registrationOpenAt > 0 && deadline > 0 && registrationOpenAt >= deadline) {
    errors.push("報名開放時間必須早於截止時間");
  }

  const location = textOrEmpty(record.location);
  if (location.length > EXAM_EVENT_LIMITS.location) {
    errors.push(`考試地點過長（最多 ${EXAM_EVENT_LIMITS.location} 字）`);
  }
  // 地點選項僅升學考試（entrance）；其他類型強制清空（校內模擬考無試場選項）
  const locationOptions =
    examType === "entrance" ? parseExamLocationOptions(record.locationOptions) : { ok: true as const, value: [] as ExamLocationOption[] };
  if (!locationOptions.ok) errors.push(locationOptions.message);
  const note = textOrEmpty(record.note);
  if (note.length > EXAM_EVENT_LIMITS.note) {
    errors.push(`備註過長（最多 ${EXAM_EVENT_LIMITS.note} 字）`);
  }

  const fee = typeof record.fee === "number" && Number.isFinite(record.fee) ? record.fee : 0;
  if (fee < 0 || fee > EXAM_EVENT_LIMITS.fee) errors.push("費用數值無效");

  // 基本費用：{ standard, reduced }；缺省向後相容舊單一 fee 欄位（＝{ standard: fee, reduced: 0 }）
  const rawBasicFee = (record.basicFee && typeof record.basicFee === "object" ? record.basicFee : null) as
    | Record<string, unknown>
    | null;
  const standardFee = rawBasicFee
    ? parseFeeField(rawBasicFee.standard)
    : { ok: true as const, value: fee };
  const reducedFee = rawBasicFee
    ? parseFeeField(rawBasicFee.reduced)
    : { ok: true as const, value: 0 };
  if (!standardFee.ok) errors.push("基本費用（一般生）" + standardFee.message);
  if (!reducedFee.ok) errors.push("基本費用（減免）" + reducedFee.message);

  const status = isExamEventType(record.status) ? record.status : null;
  if (!status) errors.push("場次狀態無效");

  const examMode: ExamMode = "review";
  const registrationMode: ExamRegistrationMode = isExamRegistrationMode(record.registrationMode)
    ? record.registrationMode
    : "optional";
  const studentArchiveEnabled = record.studentArchiveEnabled === true;
  const announcementSyncRaw =
    record.announcementSync && typeof record.announcementSync === "object"
      ? (record.announcementSync as Record<string, unknown>)
      : {};
  const announcementSync: ExamAnnouncementSync = {
    enabled: typeof announcementSyncRaw.enabled === "boolean" ? announcementSyncRaw.enabled : true,
    categoryId: textOrEmpty(announcementSyncRaw.categoryId) || "other",
    body: typeof announcementSyncRaw.body === "string" ? announcementSyncRaw.body.trim() : "",
  };
  if (announcementSync.categoryId.length > 64) errors.push("公告分類代碼過長（最多 64 字）");
  if (announcementSync.body.length > 2000) errors.push("公告內容過長（最多 2000 字）");

  const calendarSyncRaw =
    record.calendarSync && typeof record.calendarSync === "object"
      ? (record.calendarSync as Record<string, unknown>)
      : {};
  const calendarSync: ExamCalendarSync = {
    enabled: typeof calendarSyncRaw.enabled === "boolean" ? calendarSyncRaw.enabled : true,
    categoryId: textOrEmpty(calendarSyncRaw.categoryId) || "other",
    publishUnit: textOrEmpty(calendarSyncRaw.publishUnit),
    location: textOrEmpty(calendarSyncRaw.location),
  };
  if (calendarSync.categoryId.length > 64) errors.push("行事曆類型代碼過長（最多 64 字）");
  if (calendarSync.publishUnit.length > 64) errors.push("行事曆發佈單位過長（最多 64 字）");
  if (calendarSync.location.length > EXAM_EVENT_LIMITS.location) {
    errors.push(`行事曆地點過長（最多 ${EXAM_EVENT_LIMITS.location} 字）`);
  }

  const subjects = parseExamSubjects(record.subjects);
  if (!subjects.ok) errors.push(subjects.message);

  const target = parseExamTarget(record.target);
  if (!target.ok) errors.push(target.message);

  if (errors.length) return { ok: false, message: errors.join("；") };
  return {
    ok: true,
    value: {
      title,
      examType: examType as ExamCategory,
      examDate,
      examEndDate,
      location,
      locationOptions: (locationOptions as { ok: true; value: ExamLocationOption[] }).value,
      note,
      deadline,
      registrationOpenAt,
      subjects: (subjects as { ok: true; value: ExamSubject[] }).value,
      target: (target as { ok: true; value: ExamEventTarget }).value,
      basicFee: {
        standard: (standardFee as { ok: true; value: number }).value,
        reduced: (reducedFee as { ok: true; value: number }).value,
      },
      examMode,
      registrationMode,
      studentArchiveEnabled,
      announcementSync,
      calendarSync,
      status: status as ExamEventType,
    },
  };
}

/** 由既有場次攤回草稿（更新時只併入改動欄位） */
export function examEventToDraft(event: ExamEvent): ExamEventDraft {
  return {
    title: event.title,
    examType: event.examType,
    examDate: event.examDate,
    examEndDate: event.examEndDate,
    location: event.location,
    locationOptions: event.locationOptions.map((option) => ({ ...option })),
    note: event.note,
    deadline: event.deadline,
    registrationOpenAt: event.registrationOpenAt,
    subjects: event.subjects.map((subject) => ({ ...subject })),
    target: { grades: [...event.target.grades], classes: [...event.target.classes] },
    basicFee: { ...event.basicFee },
    examMode: event.examMode,
    registrationMode: event.registrationMode,
    studentArchiveEnabled: event.studentArchiveEnabled,
    announcementSync: { ...event.announcementSync },
    calendarSync: { ...event.calendarSync },
    status: event.status,
  };
}

/**
 * 應繳費用試算（純計算，與原 GAS `saveExamRegistration` 費用校正同邏輯）：
 * 低收入戶（feeCode=2）免繳＝0；一般生取 standard 欄、中低收入戶取 reduced 欄；
 * 基本費用＋各勾選科目費用加總。optOut 時由呼叫端直接給 0。
 */
export function calcExamFee(
  event: Pick<ExamEvent, "basicFee" | "subjects">,
  subjectKeys: string[],
  feeCode: ExamFeeCode
): number {
  if (feeCode === "2") return 0;
  const base = feeCode === "1" ? event.basicFee.standard : event.basicFee.reduced;
  let total = Number.isFinite(base) ? base : 0;
  const validKeys = new Set(pickValidSubjectKeys(subjectKeys, event.subjects));
  for (const subject of event.subjects) {
    if (!validKeys.has(subject.key)) continue;
    const fee = feeCode === "1" ? (subject.feeStandard ?? 0) : (subject.feeReduced ?? 0);
    total += Number.isFinite(fee) ? fee : 0;
  }
  return total;
}

/** 不報名原因上限 */
export const OPT_OUT_REASON_MAX = 200;
/** 特殊應考服務需求上限 */
export const EXAM_SERVICE_NOTE_MAX = 200;

function uniqueStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of raw.slice(0, EXAM_EVENT_LIMITS.classesMax + EXAM_EVENT_LIMITS.gradesMax)) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    list.push(value);
  }
  return list;
}

function textOrEmpty(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

// —— CSV 造冊（純計算；BOM 讓 Excel 直開中文不亂碼）——

export type ExamRosterExportScope = "all" | "registered" | "pending";

export type ExamRegistrationNumberField =
  | "rollNo"
  | "studentId"
  | "grade"
  | "classCode"
  | "className"
  | "seatNo";

export const EXAM_REGISTRATION_NUMBER_FIELDS: readonly {
  key: ExamRegistrationNumberField;
  label: string;
}[] = [
  { key: "rollNo", label: "班號" },
  { key: "studentId", label: "學號" },
  { key: "grade", label: "年級" },
  { key: "classCode", label: "班級代碼" },
  { key: "className", label: "班級名稱" },
  { key: "seatNo", label: "座號" },
];

export const ACADEMIC_ABILITY_EXAM_SUBJECT_COLUMNS = ["國文", "英文", "數學A", "數學B", "社會", "自然"] as const;
export const ACADEMIC_ABILITY_EXAM_OFFICIAL_HEADERS = [
  "報名序號",
  "身分證",
  "考試地區",
  ...ACADEMIC_ABILITY_EXAM_SUBJECT_COLUMNS,
  "特殊應考需求",
] as const;
export const HIGH_SCHOOL_ENGLISH_LISTENING_EXAM_OFFICIAL_HEADERS = [
  "報名序號",
  "身分證",
  "考試地區",
  "特殊應考需求",
] as const;
/** 分科測驗官方科目欄（114 學年度起不含國文、英文；順序對齊集報系統報考資料檔規格）。 */
export const SUBJECT_APTITUDE_EXAM_SUBJECT_COLUMNS = [
  "物理",
  "化學",
  "數學甲",
  "生物",
  "歷史",
  "地理",
  "數學乙",
  "公民",
] as const;
export const SUBJECT_APTITUDE_EXAM_OFFICIAL_HEADERS = [
  "報名序號",
  "身分證",
  "考試地區",
  ...SUBJECT_APTITUDE_EXAM_SUBJECT_COLUMNS,
  "特殊應考需求",
] as const;
export const UNIVERSITY_ARTS_EXAM_OFFICIAL_HEADERS = [
  "報名序號",
  "身分證",
  "音樂組",
  "美術組",
  "體育組",
  "音樂主修樂器編號",
  "音樂副修樂器編號",
  "樂理",
  "聽寫",
  "視唱",
  "素描",
  "彩繪技法",
  "創意表現",
  "水墨書畫",
  "美術鑑賞",
  "美術組考區",
  "特殊應考需求",
] as const;

const OFFICIAL_MUSIC_INSTRUMENT_CODES: readonly (readonly [string, string])[] = [
  ["單簧管（豎笛）", "0608"],
  ["單簧管(豎笛)", "0608"],
  ["單簧管", "0608"],
  ["豎笛", "0608"],
  ["古典吉他", "0502"],
  ["低音提琴", "0404"],
  ["上低音號", "0604"],
  ["薩克斯管", "0606"],
  ["法國號", "0603"],
  ["大提琴", "0403"],
  ["中提琴", "0402"],
  ["小提琴", "0401"],
  ["豎琴", "0501"],
  ["長笛", "0607"],
  ["長號", "0601"],
  ["小號", "0602"],
  ["低音號", "0605"],
  ["雙簧管", "0609"],
  ["低音管", "0610"],
  ["直笛", "0611"],
  ["理論與作曲", "0801"],
  ["理論作曲", "0801"],
  ["揚琴", "0906"],
  ["鋼琴", "0101"],
  ["聲樂", "0301"],
  ["擊樂", "0701"],
  ["南胡", "0901"],
  ["琵琶", "0902"],
  ["箏", "0903"],
  ["笙", "0904"],
  ["笛", "0905"],
];

/** 大學術科官方檔中，身分證後、特殊應考需求前的 14 欄。 */
export function universityArtsExamOfficialFields(
  group: UniversityArtsExamGroup,
  subjects: ExamSubject[],
  selectedKeys: string[],
  advancedOptionCodes: Record<string, string>,
  locationCode: string,
  locationOptions: ExamLocationOption[] = []
): string[] {
  const selected = new Set(selectedKeys);
  const selectedSubjects = subjects.filter((subject) => selected.has(subject.key));
  const normalize = (value: string) => value.normalize("NFKC").replace(/[\s　，,、：:（）()【】［］\[\]「」『』]/g, "");
  const hasSubject = (label: string) =>
    selectedSubjects.some((subject) => normalize(subject.label).includes(normalize(label)));
  const instrumentCode = (kind: "主修" | "副修"): string => {
    const subject = selectedSubjects.find((item) => {
      const label = normalize(item.label);
      return label.includes(kind) && (kind === "主修" || !label.includes("主修"));
    });
    if (!subject) return "0000";

    const selectedCode = advancedOptionCodes[subject.key]?.trim() ?? "";
    const selectedOption = subject.advancedOptions?.find((option) => option.code === selectedCode);
    const optionOrSubjectLabel = selectedOption?.label ?? subject.label;
    const bracketedInstrument = /[（(]([^）)]+)[）)]/.exec(optionOrSubjectLabel)?.[1] ?? optionOrSubjectLabel;
    const normalizeInstrument = (value: string) => normalize(value).replace(/主修|副修/g, "");
    const instrumentName = normalizeInstrument(bracketedInstrument);
    const mappedCode = OFFICIAL_MUSIC_INSTRUMENT_CODES.find(([name]) =>
      instrumentName.includes(normalize(name))
    )?.[1];

    if (selectedCode && selectedCode !== "__selected__") {
      if (/^\d{1,4}$/.test(selectedCode)) return selectedCode.padStart(4, "0");
      return mappedCode ?? selectedCode;
    }
    return mappedCode ?? "0000";
  };

  const artRegion = (() => {
    if (group !== "art") return "0";
    const code = locationCode.trim();
    if (["1", "2", "3"].includes(code)) return code;
    const label = normalize(locationOptions.find((option) => option.code === code)?.label ?? code);
    if (/北區|北部|臺北|台北/.test(label)) return "1";
    if (/中區|中部|臺中|台中/.test(label)) return "2";
    if (/南區|南部|臺南|台南|高雄/.test(label)) return "3";
    return "0";
  })();

  return [
    group === "music" ? "1" : "0",
    group === "art" ? "1" : "0",
    group === "sports" ? "1" : "0",
    instrumentCode("主修"),
    instrumentCode("副修"),
    group === "music" && hasSubject("樂理") ? "1" : "0",
    group === "music" && hasSubject("聽寫") ? "1" : "0",
    group === "music" && hasSubject("視唱") ? "1" : "0",
    group === "art" && hasSubject("素描") ? "1" : "0",
    group === "art" && hasSubject("彩繪技法") ? "1" : "0",
    group === "art" && hasSubject("創意表現") ? "1" : "0",
    group === "art" && hasSubject("水墨書畫") ? "1" : "0",
    group === "art" && hasSubject("美術鑑賞") ? "1" : "0",
    artRegion,
  ];
}

/** 將三個獨立組別的登錄欄位合併成一位考生的一列官方資料。 */
export function combineUniversityArtsExamOfficialFields(
  fieldsByGroup: Partial<Record<UniversityArtsExamGroup, string[]>>
): string[] {
  const empty = ["0", "0", "0", "0000", "0000", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
  const music = fieldsByGroup.music ?? empty;
  const art = fieldsByGroup.art ?? empty;
  const sports = fieldsByGroup.sports ?? empty;
  return [
    music[0],
    art[1],
    sports[2],
    music[3],
    music[4],
    ...music.slice(5, 8),
    ...art.slice(8, 13),
    art[13],
  ];
}

export function academicAbilityExamSubjectFlags(
  subjects: ExamSubject[],
  selectedKeys: string[],
  advancedOptionCodes: Record<string, string>
): number[] {
  const selected = new Set(selectedKeys);
  let chinese = 0;
  let english = 0;
  let mathA = 0;
  let mathB = 0;
  let social = 0;
  let natural = 0;

  const normalize = (value: string) => value.normalize("NFKC").toUpperCase().replace(/[\s_\-（）()【】]/g, "");
  for (const subject of subjects) {
    if (!selected.has(subject.key)) continue;
    const label = normalize(subject.label);
    if (label.includes("國文") || label.includes("國語文")) chinese = 1;
    if (label.includes("英文") || label.includes("英語")) english = 1;
    if (label.includes("社會")) social = 1;
    if (label.includes("自然")) natural = 1;

    if (label.includes("數學A") || label.includes("數甲")) mathA = 1;
    if (label.includes("數學B") || label.includes("數乙")) mathB = 1;
    if (label.includes("數學") && !label.includes("數學A") && !label.includes("數學B")) {
      const code = advancedOptionCodes[subject.key] ?? "";
      const option = (subject.advancedOptions ?? []).find((candidate) => candidate.code === code);
      if (option) {
        const optionLabel = normalize(option.label);
        const optionCode = option.code.toUpperCase();
        if (
          optionLabel.includes("數學A") ||
          optionLabel.includes("數甲") ||
          optionLabel === "A" ||
          optionCode === "A" ||
          /(?:^|[_-])A$/i.test(option.code)
        ) {
          mathA = 1;
        }
        if (
          optionLabel.includes("數學B") ||
          optionLabel.includes("數乙") ||
          optionLabel === "B" ||
          optionCode === "B" ||
          /(?:^|[_-])B$/i.test(option.code)
        ) {
          mathB = 1;
        }
      }
    }
  }

  return [chinese, english, mathA, mathB, social, natural];
}

/** 分科測驗各科選考旗標（依欄位順序：物理、化學、數學甲、生物、歷史、地理、數學乙、公民）。 */
export function subjectAptitudeExamSubjectFlags(
  subjects: ExamSubject[],
  selectedKeys: string[],
  advancedOptionCodes: Record<string, string>
): number[] {
  const selected = new Set(selectedKeys);
  const flags = {
    physics: 0,
    chemistry: 0,
    mathA: 0,
    biology: 0,
    history: 0,
    geography: 0,
    mathB: 0,
    civics: 0,
  };

  const normalize = (value: string) => value.normalize("NFKC").toUpperCase().replace(/[\s_\-（）()【】]/g, "");
  for (const subject of subjects) {
    if (!selected.has(subject.key)) continue;
    const label = normalize(subject.label);
    if (label.includes("物理")) flags.physics = 1;
    if (label.includes("化學")) flags.chemistry = 1;
    if (label.includes("生物")) flags.biology = 1;
    if (label.includes("歷史")) flags.history = 1;
    if (label.includes("地理")) flags.geography = 1;
    if (label.includes("公民")) flags.civics = 1;

    if (label.includes("數學甲") || label.includes("數甲")) flags.mathA = 1;
    if (label.includes("數學乙") || label.includes("數乙")) flags.mathB = 1;
    if (label.includes("數學") && !label.includes("數學甲") && !label.includes("數學乙")) {
      const code = advancedOptionCodes[subject.key] ?? "";
      const option = (subject.advancedOptions ?? []).find((candidate) => candidate.code === code);
      if (option) {
        const optionLabel = normalize(option.label);
        const optionCode = option.code.toUpperCase();
        if (
          optionLabel.includes("數學甲") ||
          optionLabel.includes("數甲") ||
          optionLabel === "甲" ||
          optionCode === "A" ||
          optionCode === "甲" ||
          /(?:^|[_-])(?:A|甲)$/i.test(option.code)
        ) {
          flags.mathA = 1;
        }
        if (
          optionLabel.includes("數學乙") ||
          optionLabel.includes("數乙") ||
          optionLabel === "乙" ||
          optionCode === "B" ||
          optionCode === "乙" ||
          /(?:^|[_-])(?:B|乙)$/i.test(option.code)
        ) {
          flags.mathB = 1;
        }
      }
    }
  }

  return [flags.physics, flags.chemistry, flags.mathA, flags.biology, flags.history, flags.geography, flags.mathB, flags.civics];
}

/** 通用預設官方欄位標題：報名序號、身分證、考試地區＋場次各科目名稱＋特殊應考需求。 */
export function genericOfficialExamHeaders(subjects: ExamSubject[]): string[] {
  return ["報名序號", "身分證", "考試地區", ...subjects.map((subject) => subject.label), "特殊應考需求"];
}

/** 通用預設欄位值：已選科目輸出 1 或進階選項代碼，未選輸出 0。 */
export function genericOfficialExamSubjectValues(
  subjects: ExamSubject[],
  selectedKeys: string[],
  advancedOptionCodes: Record<string, string>
): (string | number)[] {
  const selected = new Set(selectedKeys);
  return subjects.map((subject) => {
    if (!selected.has(subject.key)) return "0";
    const code = advancedOptionCodes[subject.key]?.trim() ?? "";
    return code && code !== "__selected__" ? code : "1";
  });
}

export function isExamRegistrationNumberField(value: string): value is ExamRegistrationNumberField {
  return EXAM_REGISTRATION_NUMBER_FIELDS.some((field) => field.key === value);
}

export function composeExamRegistrationNumber(schoolExamCode: string, fieldValue: string): string {
  const prefix = schoolExamCode.trim();
  const suffix = fieldValue.trim();
  return prefix && suffix ? `${prefix}${suffix}` : "";
}

export const EXAM_ROSTER_EXPORT_SCOPE_LABELS: Record<ExamRosterExportScope, string> = {
  all: "全部情形名單",
  registered: "完成報名名單",
  pending: "未完成報名名單",
};

export function isExamRosterExportScope(value: string): value is ExamRosterExportScope {
  return value === "all" || value === "registered" || value === "pending";
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatExamRosterDateTime(ms: number): string {
  return formatExamDateTime(ms, "");
}

/**
 * 名冊 CSV：欄位＝班級、學號、座號、姓名、報名情形、選考科目、不報名原因、
 * 繳費身分、應繳費用、考試地點、資料封存、登錄時間（對齊原系統管道工作表造冊欄位）。
 * 依班級→座號→姓名排序；選考科目與考試地點輸出名稱（非 key/代碼）；已失效科目鍵自動略過。
 */
export function buildExamRegistrationCsv(
  rows: ExamRegistration[],
  subjects: ExamSubject[],
  locationOptions: ExamLocationOption[] = []
): string {
  const labelOf = new Map(subjects.map((subject) => [subject.key, subject.label]));
  const sorted = [...rows].sort(
    (a, b) =>
      a.studentClass.localeCompare(b.studentClass, "zh-Hant") ||
      a.seatNo.localeCompare(b.seatNo) ||
      a.studentName.localeCompare(b.studentName, "zh-Hant")
  );
  const lines = ["班級,學號,座號,姓名,報名情形,選考科目,不報名原因,繳費身分,應繳費用,考試地點,資料封存,登錄時間"];
  for (const row of sorted) {
    const labels = pickValidSubjectKeys(row.subjectKeys, subjects)
      .map((key) => labelOf.get(key) ?? key)
      .join("、");
    lines.push(
      [
        csvEscape(row.studentClass),
        csvEscape(row.studentId),
        csvEscape(row.seatNo),
        csvEscape(row.studentName),
        csvEscape(row.optOut ? "不報名" : "完成報名"),
        csvEscape(labels),
        csvEscape(row.optOutReason),
        csvEscape(EXAM_FEE_CODE_LABELS[row.feeCode] ?? row.feeCode),
        csvEscape(row.optOut ? "0" : String(row.feeAmount)),
        csvEscape(row.optOut ? "" : resolveLocationLabel(locationOptions, row.locationCode)),
        csvEscape(row.archived ? "已封存" : ""),
        csvEscape(formatExamRosterDateTime(row.updatedAt)),
      ].join(",")
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
