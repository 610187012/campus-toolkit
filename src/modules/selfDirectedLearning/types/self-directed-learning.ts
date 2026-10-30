/** 自主學習計畫：共用型別（client/server 皆可 import，不含伺服器端依賴） */

export const SELF_DIRECTED_LEARNING_SETTINGS_COLLECTION = "selfDirectedLearningSettings";
export const SELF_DIRECTED_LEARNING_SETTINGS_DOC_ID = "global";

export const WEEKDAY_LABELS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"] as const;

/** 單一審核人員可指派班級數的伺服器防濫用上限（＝主程式班級上限，實務上等同無限制） */
export const MAX_REVIEWER_CLASSES = 300;

/** 單一審核人員可指定個別學生數的伺服器防濫用上限 */
export const MAX_REVIEWER_STUDENTS = 500;

/** 指定審查的個別學生（denormalize 姓名與班級，省去顯示時的額外讀取） */
export interface ReviewerStudentRef {
  uid: string;
  name: string;
  classCode: string;
}

/** 審核人員（候選取自當期教職員名冊；uid 供 staff 端鑑權比對） */
export interface ReviewerEntry {
  uid: string;
  name: string;
  /** 指定審查班級（勾選後才顯示班級清單；未勾選且未指定個人＝全校） */
  classScoped?: boolean;
  /** classScoped＝true 時審查的班級代碼 */
  classCodes?: string[];
  /** 另指定個別學生（例外需求；勾選後才顯示學生選擇） */
  studentScoped?: boolean;
  /** studentScoped＝true 時審查的個別學生 */
  students?: ReviewerStudentRef[];
}

/** 審查範圍（供 staff 端查詢與審核權限檢查使用） */
export interface ReviewScope {
  /** true＝全校（不限制） */
  all: boolean;
  classCodes: string[];
  studentUids: string[];
}

/** 由審核人員設定解析出實際審查範圍（未勾選任何指定＝全校） */
export function reviewerScopeOf(reviewer: ReviewerEntry | null | undefined): ReviewScope {
  const classCodes = reviewer?.classScoped ? (reviewer.classCodes ?? []) : [];
  const studentUids = reviewer?.studentScoped
    ? (reviewer.students ?? []).map((student) => student.uid)
    : [];
  return {
    all: !reviewer?.classScoped && !reviewer?.studentScoped,
    classCodes: [...classCodes],
    studentUids,
  };
}

/** 名冊班級候選（審查對象「班級」與「個人」選擇用） */
export interface ClassOption {
  code: string;
  name: string;
  grade: string;
}

/** 名冊學生候選（審查對象「個人」選擇用；僅載入指定班級） */
export interface StudentOption {
  uid: string;
  name: string;
  classCode: string;
  className: string;
  grade: string;
}

/** 教職員名冊候選人（審核人員選擇用） */
export interface StaffCandidate {
  uid: string;
  name: string;
  /** 名冊屬性（如專任教師、兼導師）；候選不依此過濾 */
  attribute: string;
}

/** 彈性學習節次行程：週幾（1=週一…7=週日）＋該日節次文字（如「第 5 節」） */
export interface FlexibleSlot {
  day: number;
  periods: string[];
}

/** 逐週填寫無固定上限（週數受假期與定期考試影響）；
 *  全學期形式的週數由程式依學校行事曆（學期起訖）自動判斷，不開放人工設定；
 *  僅以防濫用為由保留伺服器硬上限 */
export const MAX_PLAN_WEEKS = 104;

/** 文件匣件數上限的預設值（管理端可自行調整；無硬上限） */
export const DEFAULT_MAX_DOCUMENT_PLANS = 20;

/** 草稿匣件數上限的預設值（管理端可自行調整；無硬上限） */
export const DEFAULT_MAX_DRAFT_PLANS = 20;

/** 就學期間（高中三年）學校審查通過最低份數的上限（管理端可設定 0–6 份；0＝不設定） */
export const MAX_MIN_APPROVED_PLANS = 6;

/** 垃圾桶保留天數：學生進入頁面時，超過此天數的廢棄計畫會永久刪除 */
export const TRASH_RETENTION_DAYS = 30;

/** 週數填寫形式：full＝全學期（空白週數都須填寫，週數自動判斷）；flexible＝彈性（至少下限週數） */
export type WeekMode = "full" | "flexible";

/** 節次候選（取自主程式課表作息；管理端節次行程選擇用） */
export interface PeriodOption {
  code: string;
  name: string;
  period: number;
  /** 開始 `HH:MM`（學生端逐週時段推算用） */
  start: string;
  /** 結束 `HH:MM` */
  end: string;
}

/** 場域候選（取自主程式樓層空間設定的葉子空間；管理端開放場域選擇用） */
export interface SpaceOption {
  name: string;
  floor: string;
}

/** 總開關關閉時，非管理端一律只見此說明（頁面標題與 API 錯誤訊息共用） */
export const MAINTENANCE_TITLE = "目前此功能關閉維護中";
export const MAINTENANCE_HINT =
  "本功能正在維護資料，期間暫停填報與檢視，開放時間將另行公告。";

/** selfDirectedLearningSettings/global 單文件設定 */
export interface SelfDirectedLearningSettings {
  /** 功能總開關（false＝關閉維護中：學生／教職員／家長只見維護說明，寫入 API 一律擋下） */
  enabled: boolean;
  /** 送審期間開始（epoch ms；null＝尚未設定；僅限制送出審核，草稿與正式建立不受限） */
  openAt: number | null;
  /** 送審期間截止（epoch ms；null＝尚未設定；僅限制送出審核） */
  closeAt: number | null;
  /** 審核期限開始（epoch ms；null＝未設定，僅供提示與督促，不阻止審核） */
  reviewStartAt: number | null;
  /** 審核期限截止（epoch ms；null＝未設定，僅供提示與督促，不阻止審核） */
  reviewEndAt: number | null;
  /** 計畫成果撰寫截止（epoch ms；null＝未設定，不限制填寫期限） */
  resultDeadlineAt: number | null;
  /** 週數填寫形式（full＝全學期皆須填寫，週數由行事曆自動判斷；flexible＝至少填到下限週數） */
  weekMode: WeekMode;
  /** 彈性形式的下限週數（建議至少 6 週；全學期形式不使用） */
  minWeeks: number;
  /** 每位學生草稿匣可保留的件數上限（含退回修改；僅限制新增，既有草稿仍可編輯） */
  maxDrafts: number;
  /** 每位學生文件匣可保留的件數上限（審核中＋已通過；僅限制送出審核） */
  maxDocumentPlans: number;
  /** 就學期間（高中三年）學校審查通過的最低份數（0＝不設定；0–6 份） */
  minApprovedPlans: number;
  /** 校內彈性學習節次行程 */
  slots: FlexibleSlot[];
  /** 開放場域 */
  venues: string[];
  /** 是否開放學生自行輸入場地名稱（false＝只能從 `venues` 清單選擇，送審會檢查） */
  venueEditable: boolean;
  /** 審核人員名單 */
  reviewers: ReviewerEntry[];
  /** 自主學習實施說明（給學生、家長的總說明） */
  instructions: string;
  /** 自主學習計畫撰寫說明（學生發想新計畫或編輯草稿時的撰寫說明） */
  writingInstructions: string;
  /** 儲存設定時是否同步發布（或更新）系統公告（由管理人員勾選，預設不自動發送） */
  publishAnnouncement: boolean;
  /** 儲存設定時是否同步發布（或更新）行事曆行程（由管理人員勾選，預設不自動發送） */
  publishCalendar: boolean;
  updatedAt: number;
}

export const DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS: SelfDirectedLearningSettings = {
  enabled: true,
  openAt: null,
  closeAt: null,
  reviewStartAt: null,
  reviewEndAt: null,
  resultDeadlineAt: null,
  weekMode: "full",
  minWeeks: 6,
  maxDrafts: DEFAULT_MAX_DRAFT_PLANS,
  maxDocumentPlans: DEFAULT_MAX_DOCUMENT_PLANS,
  minApprovedPlans: 0,
  slots: [],
  venues: [],
  venueEditable: true,
  reviewers: [],
  instructions: "",
  writingInstructions: "",
  publishAnnouncement: false,
  publishCalendar: false,
  updatedAt: 0,
};

function asStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}

function asEpoch(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 多行說明／審查意見等富文本欄位：先白名單淨化，再限制 HTML 長度 */
function normalizeRichHtmlField(value: unknown, maxHtml: number): string {
  if (typeof value !== "string" || !value) return "";
  return capRichHtmlLength(sanitizeRichHtml(value), maxHtml);
}

function asReviewerStudents(value: unknown): ReviewerStudentRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const students: ReviewerStudentRef[] = [];
  for (const item of value) {
    if (students.length >= MAX_REVIEWER_STUDENTS) break;
    if (!item || typeof item !== "object") continue;
    const student = item as Record<string, unknown>;
    const uid = typeof student.uid === "string" ? student.uid.trim() : "";
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    students.push({
      uid: uid.slice(0, 128),
      name: (typeof student.name === "string" ? student.name.trim() : "").slice(0, 128),
      classCode:
        typeof student.classCode === "string" ? student.classCode.trim().slice(0, 20) : "",
    });
  }
  return students;
}

/** 讀 Firestore 原始資料後正規化（防欄位缺漏／型別損毀） */
export function normalizeSettings(raw: unknown): SelfDirectedLearningSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const slots: FlexibleSlot[] = Array.isArray(source.slots)
    ? source.slots
        .map((item): FlexibleSlot | null => {
          if (!item || typeof item !== "object") return null;
          const slot = item as Record<string, unknown>;
          const day = typeof slot.day === "number" ? slot.day : NaN;
          if (!Number.isInteger(day) || day < 1 || day > 7) return null;
          return { day, periods: asStringArray(slot.periods, 20, 40) };
        })
        .filter((slot): slot is FlexibleSlot => slot !== null)
        .slice(0, 14)
    : [];
  const reviewers: ReviewerEntry[] = Array.isArray(source.reviewers)
    ? source.reviewers
        .map((item): ReviewerEntry | null => {
          if (!item || typeof item !== "object") return null;
          const reviewer = item as Record<string, unknown>;
          const uid = typeof reviewer.uid === "string" ? reviewer.uid.trim() : "";
          if (!uid) return null;
          const name = typeof reviewer.name === "string" ? reviewer.name.trim() : "";
          const classCodes = asStringArray(reviewer.classCodes, MAX_REVIEWER_CLASSES, 20);
          const students = asReviewerStudents(reviewer.students);
          // 相容 0.0.20 以前的單一 scope 欄位（classes／students／all）
          const classScoped =
            typeof reviewer.classScoped === "boolean"
              ? reviewer.classScoped
              : reviewer.scope === "classes";
          const studentScoped =
            typeof reviewer.studentScoped === "boolean"
              ? reviewer.studentScoped
              : reviewer.scope === "students";
          return {
            uid: uid.slice(0, 128),
            name: name.slice(0, 128),
            classScoped,
            classCodes,
            studentScoped,
            students,
          };
        })
        .filter((reviewer): reviewer is ReviewerEntry => reviewer !== null)
        .slice(0, 50)
    : [];
  const minWeeksRaw =
    typeof source.minWeeks === "number" && Number.isInteger(source.minWeeks)
      ? source.minWeeks
      : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.minWeeks;
  const maxDraftsRaw =
    typeof source.maxDrafts === "number" && Number.isInteger(source.maxDrafts)
      ? source.maxDrafts
      : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.maxDrafts;
  const maxDocumentPlansRaw =
    typeof source.maxDocumentPlans === "number" && Number.isInteger(source.maxDocumentPlans)
      ? source.maxDocumentPlans
      : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.maxDocumentPlans;
  const minApprovedPlansRaw =
    typeof source.minApprovedPlans === "number" && Number.isInteger(source.minApprovedPlans)
      ? source.minApprovedPlans
      : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.minApprovedPlans;
  return {
    enabled:
      typeof source.enabled === "boolean"
        ? source.enabled
        : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.enabled,
    openAt: asEpoch(source.openAt),
    closeAt: asEpoch(source.closeAt),
    reviewStartAt: asEpoch(source.reviewStartAt),
    reviewEndAt: asEpoch(source.reviewEndAt),
    resultDeadlineAt: asEpoch(source.resultDeadlineAt),
    weekMode: source.weekMode === "flexible" ? "flexible" : "full",
    minWeeks: Math.min(Math.max(minWeeksRaw, 1), MAX_PLAN_WEEKS),
    maxDrafts: Math.max(maxDraftsRaw, 1),
    maxDocumentPlans: Math.max(maxDocumentPlansRaw, 1),
    minApprovedPlans: Math.min(
      Math.max(minApprovedPlansRaw, 0),
      MAX_MIN_APPROVED_PLANS
    ),
    slots,
    venues: asStringArray(source.venues, 60, 80),
    venueEditable:
      typeof source.venueEditable === "boolean"
        ? source.venueEditable
        : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.venueEditable,
    reviewers,
    instructions: normalizeRichHtmlField(source.instructions, 20000),
    writingInstructions: normalizeRichHtmlField(source.writingInstructions, 20000),
    // 舊版單一開關（syncAnnouncementAndCalendar）一併視為兩者皆開啟，避免既有勾選失效
    publishAnnouncement:
      typeof source.publishAnnouncement === "boolean"
        ? source.publishAnnouncement
        : typeof source.syncAnnouncementAndCalendar === "boolean"
          ? source.syncAnnouncementAndCalendar
          : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.publishAnnouncement,
    publishCalendar:
      typeof source.publishCalendar === "boolean"
        ? source.publishCalendar
        : typeof source.syncAnnouncementAndCalendar === "boolean"
          ? source.syncAnnouncementAndCalendar
          : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.publishCalendar,
    updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : 0,
  };
}

export type ParseResult = { ok: true; value: SelfDirectedLearningSettings } | { ok: false; message: string };

/** API 輸入驗證（POST body） */
export function parseSettingsInput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, message: "請求內容格式錯誤" };
  const body = raw as Record<string, unknown>;
  const openAt = asEpoch(body.openAt);
  const closeAt = asEpoch(body.closeAt);
  const reviewStartAt = asEpoch(body.reviewStartAt);
  const reviewEndAt = asEpoch(body.reviewEndAt);
  if (body.openAt !== null && openAt === null) return { ok: false, message: "送審開始時間格式錯誤" };
  if (body.closeAt !== null && closeAt === null) return { ok: false, message: "送審截止時間格式錯誤" };
  if (body.reviewStartAt !== null && reviewStartAt === null) {
    return { ok: false, message: "審核開始時間格式錯誤" };
  }
  if (body.reviewEndAt !== null && reviewEndAt === null) {
    return { ok: false, message: "審核截止時間格式錯誤" };
  }
  const resultDeadlineAt = asEpoch(body.resultDeadlineAt);
  if ("resultDeadlineAt" in body && body.resultDeadlineAt !== null && resultDeadlineAt === null) {
    return { ok: false, message: "計畫成果撰寫截止日格式錯誤" };
  }
  if (openAt !== null && closeAt !== null && closeAt <= openAt) {
    return { ok: false, message: "送審截止時間必須晚於開始時間" };
  }
  if (reviewStartAt !== null && reviewEndAt !== null && reviewEndAt <= reviewStartAt) {
    return { ok: false, message: "審核截止時間必須晚於審核開始時間" };
  }
  const value = normalizeSettings(body);
  const instructionsPlain = stripHtmlToText(value.instructions).trim();
  if (instructionsPlain.length > 4000) {
    return { ok: false, message: "自主學習實施說明超過 4000 字上限" };
  }
  const writingPlain = stripHtmlToText(value.writingInstructions).trim();
  if (writingPlain.length > 4000) {
    return { ok: false, message: "自主學習計畫撰寫說明超過 4000 字上限" };
  }
  if ("enabled" in body && typeof body.enabled !== "boolean") {
    return { ok: false, message: "功能總開關格式錯誤" };
  }
  if ("weekMode" in body && body.weekMode !== "full" && body.weekMode !== "flexible") {
    return { ok: false, message: "週數填寫形式不合法" };
  }
  if ("minWeeks" in body && typeof body.minWeeks === "number" && !Number.isInteger(body.minWeeks)) {
    return { ok: false, message: "下限週數必須是整數" };
  }
  if ("maxDrafts" in body) {
    const value = body.maxDrafts;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return { ok: false, message: "草稿匣件數上限必須是正整數" };
    }
  }
  if ("maxDocumentPlans" in body) {
    const value = body.maxDocumentPlans;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return { ok: false, message: "文件匣件數上限必須是正整數" };
    }
  }
  if ("minApprovedPlans" in body) {
    const value = body.minApprovedPlans;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > MAX_MIN_APPROVED_PLANS
    ) {
      return {
        ok: false,
        message: `就學期間學校審查通過最低份數必須是 0–${MAX_MIN_APPROVED_PLANS} 的整數`,
      };
    }
  }
  if ("publishAnnouncement" in body && typeof body.publishAnnouncement !== "boolean") {
    return { ok: false, message: "系統公告同步設定格式錯誤" };
  }
  if ("publishCalendar" in body && typeof body.publishCalendar !== "boolean") {
    return { ok: false, message: "行事曆同步設定格式錯誤" };
  }
  if ("venueEditable" in body && typeof body.venueEditable !== "boolean") {
    return { ok: false, message: "場地輸入設定格式錯誤" };
  }
  return { ok: true, value };
}

/** 開放狀態：closed（未設定或未開始）／open（開放中）／ended（已截止） */
export function openStateOf(
  settings: SelfDirectedLearningSettings,
  now: number = Date.now()
): "unset" | "closed" | "open" | "ended" {
  if (settings.openAt === null || settings.closeAt === null) return "unset";
  if (now < settings.openAt) return "closed";
  if (now > settings.closeAt) return "ended";
  return "open";
}

/** 審核期限狀態：unset（未設定）／closed（未開始）／open（進行中）／ended（已截止） */
export function reviewStateOf(
  settings: Pick<SelfDirectedLearningSettings, "reviewStartAt" | "reviewEndAt">,
  now: number = Date.now()
): "unset" | "closed" | "open" | "ended" {
  if (settings.reviewStartAt === null || settings.reviewEndAt === null) return "unset";
  if (now < settings.reviewStartAt) return "closed";
  if (now > settings.reviewEndAt) return "ended";
  return "open";
}

/* ——— 學生計畫（selfDirectedLearningPlans） ——— */

export const SELF_DIRECTED_LEARNING_PLANS_COLLECTION = "selfDirectedLearningPlans";
export const SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION = "selfDirectedLearningReviews";
/** 學生＋學期的送審鎖定文件（序列化同時送審／同時通過，杜絕競態） */
export const SELF_DIRECTED_LEARNING_LOCKS_COLLECTION = "selfDirectedLearningLocks";

/** 安排時段：學校彈性學習時間／課餘時間（課綱） */
export type PlanTiming = "flexible" | "afterSchool";

/** draft 草稿 → submitted 審核中 → approved 通過／returned 退回修改 */
export type PlanStatus = "draft" | "submitted" | "approved" | "returned";

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "草稿",
  submitted: "審核中",
  approved: "已通過",
  returned: "退回修改",
};

export const PLAN_TIMING_LABELS: Record<PlanTiming, string> = {
  flexible: "學校彈性學習時間",
  afterSchool: "課餘時間",
};

/** 教育部 18 學群（大學招生分類；學生可從中選擇，或自行填寫說明） */
export const STUDY_GROUPS = [
  "資訊學群",
  "工程學群",
  "數理化學群",
  "醫藥衛生學群",
  "生命科學學群",
  "生物資源學群",
  "地球與環境學群",
  "建築與設計學群",
  "藝術學群",
  "社會與心理學群",
  "大眾傳播學群",
  "外語學群",
  "文史哲學群",
  "教育學群",
  "法政學群",
  "管理學群",
  "財經學群",
  "遊憩與運動學群",
] as const;

/** 每週課程安排 */
export interface PlanWeek {
  week: number;
  content: string;
  venue: string;
  timing: PlanTiming;
}

/** 單週執行成果紀錄（富文本；只存有填寫的週次） */
export interface PlanExecutionRecord {
  week: number;
  note: string;
}

/** 單週「執行成果紀錄」的開放時間（該週最後一個規劃時段的結束） */
export interface RecordWeekWindow {
  week: number;
  /** 開放填寫時間（epoch ms）；0＝無法推算（學期起訖或節次行程尚未設定） */
  openAt: number;
  /** 該週結束時間（週六 23:59:59.999；學習反思心得要等最後一週結束才開放） */
  endAt: number;
}

/** 執行成果紀錄／學習反思心得的開放資訊 */
export interface RecordWindow {
  /** 管理端設定的計畫成果撰寫截止日（epoch ms）；null＝未設定，不開放填寫 */
  deadlineAt: number | null;
  weeks: RecordWeekWindow[];
}

/* ——— 列印預覽（學生端新分頁；以 postMessage 傳遞目前編輯內容） ——— */

/** 預覽頁載入完成 → 撰寫頁回傳目前草稿 */
export const PRINT_PREVIEW_READY = "selfDirectedLearning:print-ready";
/** 撰寫頁 → 預覽頁的資料訊息 */
export const PRINT_PREVIEW_DATA = "selfDirectedLearning:print-data";

export interface PrintPreviewSlot {
  /** 實際日期 `YYYY-MM-DD` */
  date: string;
  /** 1=週一…7=週日 */
  day: number;
  periods: string[];
  /** 衝堂的學校活動名稱；null＝無 */
  blockedBy: string | null;
}

export interface PrintPreviewWeek {
  week: number;
  /** 安排時段（與計畫表週次欄一致，列印時顯示短標籤） */
  timing: PlanTiming;
  content: string;
  venue: string;
  slots: PrintPreviewSlot[];
  blocked: boolean;
  /** 該週執行成果紀錄（富文本；未填寫＝空字串） */
  record: string;
}

/** 列印預覽成果紀錄呈現方式：separate＝表格下方另列、integrated＝融入當週學習安排 */
export type PrintLayout = "separate" | "integrated";

/** 列印預覽內容（目前編輯中的草稿；不必先儲存） */
export interface PrintPreviewPayload {
  period: string;
  studentName: string;
  className: string;
  topic: string;
  studyGroup: string;
  advisor: string;
  /** 學習目標（富文本） */
  learningGoals: string;
  /** 學習反思心得（富文本；不含＝空字串） */
  reflection: string;
  /** 來源：draft＝撰寫中的草稿、approved＝已通過的計畫與執行成果紀錄 */
  source: "draft" | "approved";
  /** 是否由學生自行提升為正式（頁尾文案用） */
  formalByStudent?: boolean;
  /** 執行成果紀錄呈現方式（分開式／融入式） */
  layout: PrintLayout;
  generatedAt: number;
  weeks: PrintPreviewWeek[];
}

export interface SelfDirectedLearningPlan {
  /** doc id＝`${period}_${studentUid}` */
  id: string;
  /** 學期識別（如 `115-1`） */
  period: string;
  studentUid: string;
  studentName: string;
  grade: string;
  classCode: string;
  className: string;
  /** 主題 */
  topic: string;
  /** 學群 */
  studyGroup: string;
  /** 指導老師（非必填） */
  advisor: string;
  /** 學習目標（富文本；送出審核時必填） */
  learningGoals: string;
  weeks: PlanWeek[];
  /** 執行成果紀錄（逐週；只存有填寫的週次；計畫通過且該週時間過了才能寫） */
  executionRecords: PlanExecutionRecord[];
  /** 學習反思心得（富文本；最後一週時間過了才能寫） */
  reflection: string;
  status: PlanStatus;
  /** 移至垃圾桶的時間（epoch ms）；null＝不在垃圾桶 */
  deletedAt: number | null;
  /** 送出審核的時間（目前審核中的計畫才有值；抽回後清空） */
  submittedAt: number | null;
  /** 第一次送出審核的時間（一旦送出就不再清除；用於「每學期僅能送審 1 份」） */
  firstSubmittedAt: number | null;
  /** 學生自行提升為正式計畫的時間（epoch ms）；null＝尚未自行提升 */
  selfApprovedAt: number | null;
  /** 是否開放家長檢視（預設 true；舊資料沒有此欄位時視為開放） */
  parentVisible: boolean;
  updatedAt: number;
}

/** 正式計畫：學校審核通過，或學生自行提升為正式 */
export function isFormalPlan(
  plan: Pick<SelfDirectedLearningPlan, "status" | "selfApprovedAt">
): boolean {
  return (
    plan.status === "approved" ||
    (typeof plan.selfApprovedAt === "number" && plan.selfApprovedAt > 0)
  );
}

/** 單週審查意見（富文本；只存有填寫的週次） */
export interface PlanWeekReview {
  week: number;
  note: string;
}

/** 審查意見（staff 端寫入；學生端讀最新一筆） */
export interface PlanReview {
  id: string;
  planId: string;
  reviewerUid: string;
  reviewerName: string;
  /** "approved" | "returned" */
  decision: "approved" | "returned";
  /** 整體審查意見（富文本） */
  note: string;
  /** 逐週審查意見（富文本；沒有填寫的週次不會出現） */
  weekNotes: PlanWeekReview[];
  reviewedAt: number;
}

export function periodLabelOf(period: { academicYear: number; semester: number }): string {
  return `${period.academicYear}-${period.semester}`;
}

export function planDocIdOf(period: string, studentUid: string): string {
  return `${period}_${studentUid}`;
}

function isTiming(value: unknown): value is PlanTiming {
  return value === "flexible" || value === "afterSchool";
}

/**
 * 由起訖日期（YYYY-MM-DD）推算週數；不可用時回 null。
 * 台灣公家機關週計算：每週第一日為星期日、最後一日為星期六；
 * 第一週或最後一週未滿七日仍以一週計（先對齊到所在週的週日／週六再算整週）。
 */
export function countWeeksBetween(start: string, end: string): number | null {
  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) return null;
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate < startDate) {
    return null;
  }
  // getDay()：0=週日…6=週六。起日回退到該週週日、訖日進位到該週週六
  const alignedStart = new Date(startDate);
  alignedStart.setDate(startDate.getDate() - startDate.getDay());
  const alignedEnd = new Date(endDate);
  alignedEnd.setDate(endDate.getDate() + (6 - endDate.getDay()));
  const days =
    Math.round((alignedEnd.getTime() - alignedStart.getTime()) / 86_400_000) + 1;
  return Math.round(days / 7);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/* ——— 逐週彈性學習時間（日期／節次）與學校活動衝堂 ——— */

/** 節次的起訖時鐘（取自主程式課表作息） */
export interface PeriodClock {
  /** 節次名稱（管理端節次行程勾選的就是這個名稱） */
  name: string;
  /** 開始 `HH:MM` */
  start: string;
  /** 結束 `HH:MM` */
  end: string;
}

/** 衝堂比對用的行事曆學校活動（只取必要欄位，避免相依主程式型別） */
export interface SchoolActivityOccurrence {
  title: string;
  startAt: number;
  endAt: number | null;
  /** true＝全校 */
  school: boolean;
  /** 適用年級與班級（classCodes 空＝該年級全年級） */
  grades: { grade: string; classCodes: string[] }[];
}

/** 某一週的單一彈性學習時段（日期＋節次） */
export interface WeekSlotSchedule {
  /** 1=週一…7=週日 */
  day: number;
  /** 實際日期 `YYYY-MM-DD` */
  date: string;
  /** 節次名稱（管理端勾選的顯示文字；可能為空） */
  periods: string[];
  /** 衝堂的學校活動名稱；null＝可用 */
  blockedBy: string | null;
}

/** 某一週的彈性學習時間；日期由學期起訖與節次行程推算 */
export interface WeekSchedule {
  week: number;
  /** 該週週日／週六 `YYYY-MM-DD`（與 `countWeeksBetween` 的週計算一致） */
  startDate: string;
  endDate: string;
  slots: WeekSlotSchedule[];
  /** 該週所有彈性學習時段皆與學校活動衝堂（整週不提供撰寫、不列入必填） */
  blocked: boolean;
  /** 該週是否有可撰寫的彈性學習時段（未設定節次行程時全部視為可寫） */
  writable: boolean;
}

const MS_PER_DAY = 86_400_000;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function dateOnlyMs(value: string): number | null {
  if (!DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function formatDateOnly(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clockMs(date: string, clock: string): number | null {
  if (!CLOCK_PATTERN.test(clock)) return null;
  const base = dateOnlyMs(date);
  if (base === null) return null;
  const date_ = new Date(base);
  const [hour, minute] = clock.split(":").map(Number);
  date_.setHours(hour, minute, 0, 0);
  return date_.getTime();
}

/** 學校活動是否涵蓋該學生（全校，或該年級／該班級） */
function coversStudent(
  event: SchoolActivityOccurrence,
  grade: string,
  classCode: string
): boolean {
  if (event.school) return true;
  return event.grades.some((entry) => {
    if (entry.grade !== grade) return false;
    if (entry.classCodes.length === 0) return true;
    return Boolean(classCode) && entry.classCodes.includes(classCode);
  });
}

/**
 * 推算逐週的彈性學習時間（日期＋節次），並比對行事曆的學校活動衝堂。
 *
 * - 週次與 `countWeeksBetween` 一致：每週以週日～週六為一週，第一週回退到所在週的週日。
 * - 節次行程以「週幾＋節次名稱」設定；名稱對應課表作息後換算成實際起訖時間。
 * - 只比對有學校活動層級且涵蓋該學生（全校／年級／班級）的行事曆行程；
 *   該週所有時段皆衝堂時 `blocked=true`（該週不提供撰寫）。
 * - 學期起訖未設定或格式錯誤時回空陣列（前端顯示為無法推算）。
 */
export function buildWeekSchedule(input: {
  semesterStart: string;
  semesterEnd: string;
  weeks: number;
  slots: FlexibleSlot[];
  periods: PeriodClock[];
  events: SchoolActivityOccurrence[];
  grade: string;
  classCode: string;
}): WeekSchedule[] {
  const startMs = dateOnlyMs(input.semesterStart);
  const endMs = dateOnlyMs(input.semesterEnd);
  if (startMs === null || endMs === null || endMs < startMs) return [];
  const totalWeeks = Math.min(Math.max(Math.round(input.weeks) || 0, 0), MAX_PLAN_WEEKS);
  if (totalWeeks === 0) return [];

  const weekOneSunday = startMs - new Date(startMs).getDay() * MS_PER_DAY;
  const applicable = input.events.filter((event) =>
    coversStudent(event, input.grade, input.classCode)
  );
  const clockByName = new Map(input.periods.map((period) => [period.name, period]));
  const orderedSlots = [...input.slots].sort((a, b) => a.day - b.day);
  const hasSlots = input.slots.length > 0;

  const rows: WeekSchedule[] = [];
  for (let index = 0; index < totalWeeks; index += 1) {
    const sundayMs = weekOneSunday + index * 7 * MS_PER_DAY;
    const slots: WeekSlotSchedule[] = [];
    for (const slot of orderedSlots) {
      // day：1=週一…7=週日；該週由週日起算，故週日（7）偏移 0、週一偏移 1
      const dateMs = sundayMs + (slot.day % 7) * MS_PER_DAY;
      if (dateMs < startMs || dateMs > endMs) continue;
      const date = formatDateOnly(dateMs);
      let blockedBy: string | null = null;
      for (const periodName of slot.periods) {
        const clock = clockByName.get(periodName);
        if (!clock) continue;
        const slotStart = clockMs(date, clock.start);
        const slotEnd = clockMs(date, clock.end);
        if (slotStart === null || slotEnd === null) continue;
        for (const event of applicable) {
          const eventEnd = Math.max(event.endAt ?? event.startAt, event.startAt + 60_000);
          if (slotStart < eventEnd && event.startAt < slotEnd) {
            blockedBy = event.title;
            break;
          }
        }
        if (blockedBy) break;
      }
      slots.push({ day: slot.day, date, periods: [...slot.periods], blockedBy });
    }
    const blocked = slots.length > 0 && slots.every((slot) => slot.blockedBy !== null);
    rows.push({
      week: index + 1,
      startDate: formatDateOnly(sundayMs),
      endDate: formatDateOnly(sundayMs + 6 * MS_PER_DAY),
      slots,
      blocked,
      writable: hasSlots ? slots.length > 0 && !blocked : true,
    });
  }
  return rows;
}

/* ——— 學習安排富文本：純 TypeScript 白名單淨化（前端與伺服器共用） ——— */

/** 允許的富文本標籤；其他標籤一律丟棄外殼、保留文字內容 */
const RICH_TEXT_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "span",
  "font",
  "p",
  "div",
  "br",
  "ul",
  "ol",
  "li",
  "blockquote",
]);

/** 需連同內容整段移除的危險元素（含未閉合標籤） */
const RICH_TEXT_DROP_ELEMENTS =
  "script|style|iframe|object|embed|svg|math|template|noscript|title|textarea|select|option|form|link|meta|audio|video|source|picture|canvas";

/** 允許保留的 CSS 屬性（其餘一律丟棄） */
const RICH_TEXT_STYLE_PROPS = new Set([
  "color",
  "background-color",
  "font-family",
  "font-size",
  "text-align",
  "margin-left",
  "padding-left",
]);

const RICH_TEXT_SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.%,\s]+\)|[a-z]{3,20})$/i;
const RICH_TEXT_SAFE_FONT_SIZE =
  /^(\d+(\.\d+)?(px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large)$/i;
const RICH_TEXT_SAFE_FONT_FAMILY = /^[\p{L}\p{N}\s,"'_.-]+$/u;
const RICH_TEXT_SAFE_SPACING = /^-?\d+(\.\d+)?(px|pt|em|rem|%)$/i;
const RICH_TEXT_SAFE_ALIGN = /^(left|right|center|justify)$/i;

/** 是否為允許的 CSS 值（避免 url()、expression 等危險構造） */
function isSafeRichStyleValue(property: string, value: string): boolean {
  switch (property) {
    case "color":
    case "background-color":
      return RICH_TEXT_SAFE_COLOR.test(value);
    case "font-size":
      return RICH_TEXT_SAFE_FONT_SIZE.test(value);
    case "font-family":
      return value.length <= 120 && RICH_TEXT_SAFE_FONT_FAMILY.test(value);
    case "text-align":
      return RICH_TEXT_SAFE_ALIGN.test(value);
    case "margin-left":
    case "padding-left":
      return RICH_TEXT_SAFE_SPACING.test(value);
    default:
      return false;
  }
}

/** 過濾單一 style 屬性的宣告，只留白名單內且值安全的樣式 */
function sanitizeRichStyle(raw: string): string | null {
  const declarations: string[] = [];
  for (const part of raw.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (!property || !value || !RICH_TEXT_STYLE_PROPS.has(property)) continue;
    if (/url\s*\(|expression|javascript:|@import|[<>\\]/i.test(value)) continue;
    if (!isSafeRichStyleValue(property, value)) continue;
    declarations.push(`${property}:${value}`);
  }
  return declarations.length > 0 ? declarations.join(";") : null;
}

/** 保留合法實體（如 &nbsp;、&amp;），其餘 < > & 一律跳脫，避免純文字被當成標籤 */
function escapeRichText(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const amp = text.indexOf("&", index);
    if (amp < 0) {
      output += text.slice(index).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      break;
    }
    output += text.slice(index, amp).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const rest = text.slice(amp);
    const entity = rest.match(/^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/);
    if (entity) {
      output += entity[0];
      index = amp + entity[0].length;
    } else {
      output += "&amp;";
      index = amp + 1;
    }
  }
  return output;
}

/** 解析並重建標籤屬性：只留白名單屬性，事件屬性與危險樣式一律丟棄 */
function sanitizeRichAttributes(tag: string, raw: string): string {
  const attributes: string[] = [];
  const pattern =
    /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name.startsWith("on")) continue;
    if (name === "style") {
      const style = sanitizeRichStyle(value);
      if (style) {
        attributes.push(`style="${style.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
      }
      continue;
    }
    if (
      (tag === "p" || tag === "div" || tag === "blockquote" || tag === "li") &&
      name === "align" &&
      RICH_TEXT_SAFE_ALIGN.test(value)
    ) {
      attributes.push(`align="${value.toLowerCase()}"`);
      continue;
    }
    if (tag !== "font") continue;
    if (name === "size" && /^[1-7]$/.test(value)) {
      attributes.push(`size="${value}"`);
    } else if (name === "color" && RICH_TEXT_SAFE_COLOR.test(value)) {
      attributes.push(`color="${value}"`);
    } else if (name === "bgcolor" && RICH_TEXT_SAFE_COLOR.test(value)) {
      attributes.push(`bgcolor="${value}"`);
    } else if (name === "face" && value.length <= 120 && RICH_TEXT_SAFE_FONT_FAMILY.test(value)) {
      attributes.push(`face="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
    }
  }
  return attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
}

/**
 * 富文本白名單淨化：只留安全標籤（粗體、斜體、底線、刪除線、顏色／底色／字級、
 * 段落、清單、引用等）與安全屬性；移除 script／iframe／事件屬性／javascript:／url()。
 * 純文字輸入會被跳脫，因此可安全地以 `dangerouslySetInnerHTML` 呈現。
 */
export function sanitizeRichHtml(input: string): string {
  if (typeof input !== "string" || !input) return "";
  let html = input.replace(/<!--[\s\S]*?-->/g, "").replace(/<![^>]*>/g, "");
  // 先整段移除危險元素（含內容），再移除殘留的未閉合標籤
  html = html.replace(
    new RegExp(`<(${RICH_TEXT_DROP_ELEMENTS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"),
    ""
  );
  html = html.replace(new RegExp(`<\\/?(?:${RICH_TEXT_DROP_ELEMENTS})\\b[^>]*>`, "gi"), "");

  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>/g;
  let output = "";
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    output += escapeRichText(html.slice(index, match.index));
    index = pattern.lastIndex;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (!RICH_TEXT_TAGS.has(tag)) continue;
    if (tag === "br") {
      if (!closing) output += "<br>";
      continue;
    }
    if (closing) {
      output += `</${tag}>`;
      continue;
    }
    output += `<${tag}${sanitizeRichAttributes(tag, match[3] ?? "")}>`;
  }
  output += escapeRichText(html.slice(index));
  return output;
}

function decodeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** 依長度上限截斷富文本：切在最後一個完整標籤邊界，避免留下破損標籤 */
export function capRichHtmlLength(html: string, maxLength: number): string {
  if (html.length <= maxLength) return html;
  const sliced = html.slice(0, maxLength);
  const boundary = sliced.lastIndexOf(">");
  if (boundary < 0) return "";
  return sanitizeRichHtml(sliced.slice(0, boundary + 1));
}

/**
 * 取得富文本的可見純文字：`<br>`、`</p>`、`</div>`、`</li>` 視為換行，
 * 其餘標籤剝除，並還原常見實體（`&nbsp;`、`&amp;`、`&lt;`、`&gt;`）。
 * 用於必填判空、字數計算與舊版純文字內容顯示。
 */
export function stripHtmlToText(input: string): string {
  if (typeof input !== "string" || !input) return "";
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, code: string) => decodeCodePoint(Number(code), match))
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16), match)
    )
    .replace(/&amp;/gi, "&")
    .replace(/\r\n?/g, "\n");
}

export type PlanParseResult =
  | { ok: true; value: Omit<SelfDirectedLearningPlan, "id" | "period" | "studentUid" | "studentName" | "grade" | "classCode" | "className" | "status" | "deletedAt" | "submittedAt" | "firstSubmittedAt" | "selfApprovedAt" | "updatedAt"> }
  | { ok: false; message: string };

/** 學生計畫草稿輸入驗證（送審與草稿共用；草稿寬鬆、送審才套週數形式與每週必填） */
export function parsePlanDraft(
  raw: unknown,
  rules: Pick<SelfDirectedLearningSettings, "weekMode" | "minWeeks"> & {
    /** 程式判斷的學期總週數（兩種形式的填寫上限；null＝學校尚未設定起訖） */
    fullWeeks: number | null;
    /** 與學校活動衝堂、不提供撰寫的週次（送審時不列入必填） */
    blockedWeeks?: number[];
    /** 是否開放學生自行輸入場地名稱（預設 true；false＝只能從 `venueOptions` 選擇） */
    venueEditable?: boolean;
    /** 學校開放的固定場域清單（`venueEditable` 為 false 時送審據此驗證） */
    venueOptions?: string[];
  },
  action: "save" | "submit"
): PlanParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, message: "請求內容格式錯誤" };
  const body = raw as Record<string, unknown>;
  const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 100) : "";
  const studyGroup = typeof body.studyGroup === "string" ? body.studyGroup.trim().slice(0, 100) : "";
  const advisor = typeof body.advisor === "string" ? body.advisor.trim().slice(0, 100) : "";
  if (!topic) return { ok: false, message: "請填寫主題" };
  if (!studyGroup) return { ok: false, message: "請填寫學群" };

  // 學習目標（富文本）：送出審核時必填，草稿可先留白
  const goalsHtml = sanitizeRichHtml(
    typeof body.learningGoals === "string" ? body.learningGoals : ""
  );
  const goalsPlain = stripHtmlToText(goalsHtml).trim();
  if (action === "submit" && !goalsPlain) {
    return { ok: false, message: "請填寫學習目標" };
  }
  if (goalsPlain.length > 600) {
    return {
      ok: false,
      message: `學習目標超過 600 字上限（目前 ${goalsPlain.length} 字）`,
    };
  }
  const learningGoals = goalsPlain ? capRichHtmlLength(goalsHtml, 6000) : "";

  if (!Array.isArray(body.weeks) || body.weeks.length < 1) {
    return { ok: false, message: "請至少填寫一週的課程安排" };
  }
  if (body.weeks.length > MAX_PLAN_WEEKS) {
    return { ok: false, message: `週數不得超過 ${MAX_PLAN_WEEKS} 週` };
  }
  // 兩種形式的填寫上限皆為程式判斷的學期總週數
  if (action === "submit" && rules.fullWeeks !== null && body.weeks.length > rules.fullWeeks) {
    return {
      ok: false,
      message: `週數不得超過程式判斷的學期總週數 ${rules.fullWeeks} 週（目前 ${body.weeks.length} 週）`,
    };
  }
  if (action === "submit" && rules.weekMode === "full") {
    if (rules.fullWeeks === null) {
      return {
        ok: false,
        message: "學校尚未設定上課日／學期起訖，暫無法判斷全學期週數——請改用彈性形式，或請學校至「學校基本設定 → 學期起訖設定」填寫上課日起訖",
      };
    }
    if (body.weeks.length !== rules.fullWeeks) {
      return {
        ok: false,
        message: `全學期形式須填寫全部 ${rules.fullWeeks} 週（目前 ${body.weeks.length} 週）`,
      };
    }
  }
  if (action === "submit" && rules.weekMode === "flexible" && body.weeks.length < rules.minWeeks) {
    return {
      ok: false,
      message: `彈性形式至少須填寫 ${rules.minWeeks} 週的學校下限（目前 ${body.weeks.length} 週）`,
    };
  }
  const weeks: PlanWeek[] = [];
  const seen = new Set<number>();
  const blockedWeeks = new Set(rules.blockedWeeks ?? []);
  const venueEditable = rules.venueEditable !== false;
  const venueOptions = new Set(rules.venueOptions ?? []);
  for (const item of body.weeks) {
    if (!item || typeof item !== "object") return { ok: false, message: "每週安排格式錯誤" };
    const week = item as Record<string, unknown>;
    const weekNo = typeof week.week === "number" ? week.week : NaN;
    if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > MAX_PLAN_WEEKS) {
      return { ok: false, message: "週次編號不合法" };
    }
    if (seen.has(weekNo)) return { ok: false, message: `第 ${weekNo} 週重複` };
    seen.add(weekNo);
    const rawContent = typeof week.content === "string" ? week.content : "";
    // 富文本存檔前先淨化；純文字長度以「實際可見文字」計算
    const sanitizedContent = sanitizeRichHtml(rawContent);
    const plainContent = stripHtmlToText(sanitizedContent).trim();
    const content = plainContent ? capRichHtmlLength(sanitizedContent, 6000) : "";
    const venue = typeof week.venue === "string" ? week.venue.trim().slice(0, 120) : "";
    // 與學校活動衝堂的週次不提供撰寫，送審時也不列入必填
    const blocked = blockedWeeks.has(weekNo);
    // 草稿可留白（進度可分次完成）；送審時每一週的學習安排與場地都必填
    if (action === "submit" && !blocked && !plainContent) {
      return { ok: false, message: `第 ${weekNo} 週未填寫學習安排` };
    }
    if (!blocked && plainContent.length > 600) {
      return {
        ok: false,
        message: `第 ${weekNo} 週學習安排超過 600 字上限（目前 ${plainContent.length} 字）`,
      };
    }
    if (action === "submit" && !blocked && !venue) {
      return { ok: false, message: `第 ${weekNo} 週未填寫場地` };
    }
    // 未開放自行輸入時，場地必須是學校開放的固定場域之一
    if (action === "submit" && !blocked && !venueEditable && !venueOptions.has(venue)) {
      return {
        ok: false,
        message: `第 ${weekNo} 週場地「${venue}」不在學校開放的場域清單，請重新選擇`,
      };
    }
    const timing: PlanTiming = isTiming(week.timing) ? week.timing : "flexible";
    weeks.push({ week: weekNo, content, venue, timing });
  }
  weeks.sort((a, b) => a.week - b.week);
  // 成果紀錄與學習反思心得不在草稿表單內（由「查看內容」於計畫通過後、時間到才填寫）
  return {
    ok: true,
    value: {
      topic,
      studyGroup,
      advisor,
      learningGoals,
      weeks,
      executionRecords: [],
      reflection: "",
      parentVisible: true,
    },
  };
}

/* ——— 教職員審核 ——— */

export type ReviewAction = "approve" | "return";

/** 逐週審查意見正規化：白名單淨化、限制週次、同日重複以第一筆為準、依週次排序 */
export function normalizeWeekNotes(raw: unknown): PlanWeekReview[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const items: PlanWeekReview[] = [];
  for (const item of raw) {
    if (items.length >= MAX_PLAN_WEEKS) break;
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const week = typeof source.week === "number" ? source.week : NaN;
    if (!Number.isInteger(week) || week < 1 || week > MAX_PLAN_WEEKS) continue;
    if (seen.has(week)) continue;
    const note = normalizeRichHtmlField(source.note, 5000);
    if (!stripHtmlToText(note).trim()) continue;
    seen.add(week);
    items.push({ week, note });
  }
  return items.sort((a, b) => a.week - b.week);
}

export type ReviewParseResult =
  | {
      ok: true;
      value: {
        planId: string;
        action: ReviewAction;
        note: string;
        weekNotes: PlanWeekReview[];
      };
    }
  | { ok: false; message: string };

/** 審核輸入驗證（退回必填審查意見；逐週意見可留空） */
export function parseReviewInput(raw: unknown): ReviewParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, message: "請求內容格式錯誤" };
  const body = raw as Record<string, unknown>;
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  // Firestore 文件 id 不可含 "/"；提早以友善訊息擋掉，避免底層路徑錯誤直接回前端
  if (!planId || planId.includes("/")) return { ok: false, message: "缺少計畫識別" };
  const isApprove = body.action === "approve";
  const isReturn = body.action === "return";
  if (!isApprove && !isReturn) return { ok: false, message: "審核動作不合法" };
  const action: ReviewAction = isApprove ? "approve" : "return";
  // 審查意見改為富文本（所見即所得）；先淨化再檢查可見文字長度
  const note = normalizeRichHtmlField(body.note, 20000);
  const notePlain = stripHtmlToText(note).trim();
  if (notePlain.length > 1000) {
    return { ok: false, message: "審查意見超過 1000 字上限" };
  }
  if (action === "return" && !notePlain) {
    return { ok: false, message: "退回時必須填寫審查意見" };
  }
  const weekNotes = normalizeWeekNotes(body.weekNotes);
  const tooLongWeek = weekNotes.find(
    (item) => stripHtmlToText(item.note).trim().length > 1000
  );
  if (tooLongWeek) {
    return { ok: false, message: `第 ${tooLongWeek.week} 週審查意見超過 1000 字上限` };
  }
  return { ok: true, value: { planId, action, note, weekNotes } };
}
