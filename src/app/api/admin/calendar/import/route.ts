import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import {
  createCalendarEvent,
  getCalendarSettings,
  getSchoolClassOptions,
  getSchoolPeriods,
  listAdminCalendarEvents,
} from "@/lib/calendar";
import {
  ALL_ROLES,
  isUserRole,
  type UserRole,
} from "@/types/users";
import {
  emptySchoolActivity,
  parseCalendarAudience,
  schoolActivityText,
  validateCalendarInput,
  type CalendarCategory,
  type CalendarEventInput,
  type CalendarGradeOption,
  type CalendarSchoolActivity,
} from "@/types/calendar";
import type { SchoolPeriodRow } from "@/types/school-periods";
import { assertBodySize, DEFAULT_FORM_BODY_BYTES } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };
export const maxDuration = 300;

const MAX_FILE_BYTES = 2_000_000;
const MAX_ROWS = 200;

/** 欄位標題別名（正規化後比對：去空白、全形轉半形可簡化——此處以精簡包含比對） */
const HEADER_ALIASES: Record<string, string[]> = {
  title: ["標題", "行程標題"],
  category: ["行事曆類型", "類型"],
  allDay: ["全天"],
  start: ["開始", "開始時間"],
  end: ["結束", "結束時間"],
  startPeriod: ["開始節次", "起始節次", "startperiod", "start period"],
  endPeriod: ["結束節次", "endperiod", "end period"],
  period: ["節次", "period"],
  location: ["地點"],
  publishUnit: ["發佈單位", "單位"],
  description: ["說明", "描述"],
  important: ["重要", "星號"],
  schoolActivity: ["學校活動層級", "活動層級", "學校活動"],
  schoolActivityClasses: ["學校活動班級", "活動層級班級", "活動班級"],
  roles: ["閱讀權限", "身分", "權限"],
  classCodes: ["班級代碼", "班級"],
  isPublic: ["公開", "無需登入"],
};

const YES_VALUES = new Set(["是", "y", "yes", "true", "1", "✓", "√"]);

/** 身分別名：中文標籤與英文代碼皆可 */
const ROLE_ALIASES: Record<string, UserRole> = {
  學生: "student",
  家長: "parent",
  教職員: "staff",
  教師: "staff",
  老師: "staff",
  管理員: "admin",
  student: "student",
  parent: "parent",
  staff: "staff",
  admin: "admin",
};

interface ParsedRow {
  row: number;
  title: string;
  timeText: string;
  action: "create" | "skip";
  reason?: string;
  input?: CalendarEventInput;
  categoryName?: string;
  /** 學校活動層級顯示文字（未指定＝省略） */
  schoolActivity?: string;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function mapHeaders(row: Record<string, unknown>): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(row)) {
    const key = normalizeHeader(rawKey);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some((alias) => key === normalizeHeader(alias))) {
        mapped[field] = String(value ?? "").trim();
        break;
      }
    }
  }
  return mapped;
}

function isYes(value: string): boolean {
  return YES_VALUES.has(value.trim().toLowerCase());
}

/**
 * 解析日期儲存格：`2026/10/25`、`2026-10-25`（僅日期）或附帶 `08:00`／`08:00:00`。
 * 回傳 dateOnly 標記與當地時區 epoch ms；無法解析回 null。
 */
function parseCellDate(value: string): { dateOnly: boolean; ms: number } | null {
  const s = value.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hasTime = Boolean(m[4]);
  const hour = hasTime ? Number(m[4]) : 0;
  const minute = hasTime ? Number(m[5]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute);
  // 日期進位驗證（如 2/30 → 3/1，視為無效）
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return { dateOnly: !hasTime, ms: date.getTime() };
}

function formatDateOnly(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function endOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** 以指定日期（保留年月日）加上課表節次的 HH:MM */
function combineDateAndTime(dateMs: number, time: string): number | null {
  const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const d = new Date(dateMs);
  d.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return d.getTime();
}

/** 解析節次：接受節次代碼（P1）、名稱（第一節）或編號（1） */
function resolveSchoolPeriod(value: string, periods: SchoolPeriodRow[]): SchoolPeriodRow | null {
  const key = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!key) return null;
  return (
    periods.find(
      (period) =>
        period.code.trim().toLowerCase() === key ||
        period.name.trim().toLowerCase().replace(/\s+/g, "") === key ||
        String(period.period) === key
    ) ?? null
  );
}

function parseRolesCell(value: string): UserRole[] | null {
  if (!value.trim()) return [...ALL_ROLES];
  const parts = value.split(/[,、;；\s]+/).map((p) => p.trim()).filter(Boolean);
  const roles: UserRole[] = [];
  for (const part of parts) {
    const role = ROLE_ALIASES[part] ?? ROLE_ALIASES[part.toLowerCase()];
    if (!role || !isUserRole(role)) return null;
    if (!roles.includes(role)) roles.push(role);
  }
  return roles.length > 0 ? roles : null;
}

function resolveCategoryByName(
  name: string,
  categories: CalendarCategory[]
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const hit = categories.find((c) => c.name.trim() === trimmed);
  return hit?.id;
}

/** 「全校」在「學校活動層級」欄的可接受寫法 */
const WHOLE_SCHOOL_VALUES = new Set(["全校", "全校活動", "school", "all"]);

/**
 * 解析學校活動層級（兩欄）：
 * - 「學校活動層級」：全校 或 年級名稱（多個以逗號／頓號／分號分隔）；留空＝無。
 * - 「學校活動班級」：單一年級直接填班級代碼（多個以逗號／頓號分隔，留空＝全年級）；
 *   多個年級要分別指定班級時填「年級:班級,班級;年級:班級」，未列出的年級＝全年級。
 * 年級與班級皆須存在於學校設定的年段班級，避免錯字使衝堂比對失真。
 */
function parseSchoolActivityCell(
  levelCell: string,
  classCell: string,
  classGrades: CalendarGradeOption[]
): { ok: true; value: CalendarSchoolActivity } | { ok: false; reason: string } {
  const levelText = levelCell.trim();
  const classText = classCell.trim();
  if (!levelText) {
    if (classText) {
      return { ok: false, reason: "填了「學校活動班級」但沒有填「學校活動層級」" };
    }
    return { ok: true, value: emptySchoolActivity() };
  }

  const tokens = levelText
    .split(/[,，、;；\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.some((token) => WHOLE_SCHOOL_VALUES.has(token.toLowerCase()))) {
    if (tokens.length > 1) {
      return { ok: false, reason: "「全校」不可與年級併填" };
    }
    if (classText) {
      return { ok: false, reason: "學校活動層級為「全校」時不可再指定班級" };
    }
    return { ok: true, value: { school: true, grades: [] } };
  }

  if (classGrades.length === 0) {
    return {
      ok: false,
      reason: "學校尚未設定年段班級，無法指定年級（可改填「全校」或留空）",
    };
  }

  const gradeNames: string[] = [];
  for (const token of tokens) {
    if (!gradeNames.includes(token)) gradeNames.push(token);
  }
  const availableGrades = classGrades.map((option) => option.grade);
  const unknownGrades = gradeNames.filter((name) => !availableGrades.includes(name));
  if (unknownGrades.length > 0) {
    return {
      ok: false,
      reason: `找不到年級「${unknownGrades.join("、")}」（可用：${availableGrades.join("、")}）`,
    };
  }

  if (classText) {
    // 多個年級要分別指定班級時，班級欄以「年級:班級,班級;年級:班級」表示
    if (/[:：]/.test(classText)) {
      const groups = new Map<string, string[]>();
      const segments = classText
        .split(/[;；]+/)
        .map((segment) => segment.trim())
        .filter(Boolean);
      for (const segment of segments) {
        const match = segment.match(/^([^:：]+)[:：](.*)$/);
        if (!match) {
          return {
            ok: false,
            reason: `「${segment}」格式錯誤（多個年級請用「年級:班級」，例：一年級:101,102;二年級:201）`,
          };
        }
        const gradeName = match[1].trim();
        if (!gradeNames.includes(gradeName)) {
          return {
            ok: false,
            reason: `班級欄的年級「${gradeName}」未列在「學校活動層級」`,
          };
        }
        const gradeOption = classGrades.find((option) => option.grade === gradeName);
        if (!gradeOption) {
          return { ok: false, reason: `找不到年級「${gradeName}」` };
        }
        const codes = match[2]
          .split(/[,，、\s]+/)
          .map((code) => code.trim())
          .filter(Boolean);
        const knownCodes = new Set(gradeOption.classes.map((cls) => cls.code));
        const unknownCodes = codes.filter((code) => !knownCodes.has(code));
        if (unknownCodes.length > 0) {
          return {
            ok: false,
            reason: `年級「${gradeName}」找不到班級「${unknownCodes.join("、")}」`,
          };
        }
        const current = groups.get(gradeName) ?? [];
        for (const code of codes) {
          if (!current.includes(code)) current.push(code);
        }
        groups.set(gradeName, current);
      }
      return {
        ok: true,
        value: {
          school: false,
          grades: gradeNames.map((grade) => ({
            grade,
            classCodes: groups.get(grade) ?? [],
          })),
        },
      };
    }

    if (gradeNames.length > 1) {
      return {
        ok: false,
        reason:
          "多個年級若要指定班級，請用「年級:班級」格式（例：一年級:101,102;二年級:201）；不指定班級請留空",
      };
    }
    const gradeOption = classGrades.find((option) => option.grade === gradeNames[0]);
    if (!gradeOption) {
      return { ok: false, reason: `找不到年級「${gradeNames[0]}」` };
    }
    const classCodes = [
      ...new Set(
        classText
          .split(/[,，、;；\s]+/)
          .map((code) => code.trim())
          .filter(Boolean)
      ),
    ];
    const knownCodes = new Set(gradeOption.classes.map((cls) => cls.code));
    const unknownCodes = classCodes.filter((code) => !knownCodes.has(code));
    if (unknownCodes.length > 0) {
      return {
        ok: false,
        reason: `年級「${gradeOption.grade}」找不到班級「${unknownCodes.join("、")}」`,
      };
    }
    return {
      ok: true,
      value: { school: false, grades: [{ grade: gradeOption.grade, classCodes }] },
    };
  }

  return {
    ok: true,
    value: {
      school: false,
      grades: gradeNames.map((grade) => ({ grade, classCodes: [] })),
    },
  };
}

function timeTextOf(input: CalendarEventInput): string {
  if (input.allDay && input.allDayDate) {
    return `全天（${input.allDayDate}）`;
  }
  if (typeof input.startAt !== "number") return "—";
  const fmt = (ms: number) =>
    new Date(ms).toLocaleString("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  if (typeof input.endAt === "number" && input.endAt > input.startAt) {
    return `${fmt(input.startAt)} ~ ${fmt(input.endAt)}`;
  }
  return fmt(input.startAt);
}

/** 一行儲存格 → CalendarEventInput（先正規化再交給 validateCalendarInput 把關） */
function buildRowInput(
  rowNumber: number,
  cells: Record<string, string>,
  categories: CalendarCategory[],
  periods: SchoolPeriodRow[],
  classGrades: CalendarGradeOption[]
): ParsedRow {
  const title = cells.title?.trim() ?? "";
  const draft: ParsedRow = {
    row: rowNumber,
    title,
    timeText: "—",
    action: "skip",
  };
  if (!title) {
    draft.reason = "缺標題";
    return draft;
  }

  const allDay = isYes(cells.allDay ?? "");
  const important = isYes(cells.important ?? "");
  const isPublic = isYes(cells.isPublic ?? "");

  const start = parseCellDate(cells.start ?? "");
  if (!start) {
    draft.reason = "開始欄位無法解析（格式如 2026/10/10 或 2026/10/10 08:00）";
    return draft;
  }
  const endRaw = (cells.end ?? "").trim();
  const end = endRaw ? parseCellDate(endRaw) : null;
  if (endRaw && !end) {
    draft.reason = "結束欄位無法解析（格式如 2026/10/12 或 2026/10/12 12:00）";
    return draft;
  }

  // 課表節次（選填）：開始節次可單獨使用（結束同開始）；也可指定開始／結束節次範圍
  const startPeriodText = (cells.startPeriod ?? cells.period ?? "").trim();
  const endPeriodText = (cells.endPeriod ?? "").trim() || startPeriodText;
  let startPeriod: SchoolPeriodRow | null = null;
  let endPeriod: SchoolPeriodRow | null = null;
  if (startPeriodText) {
    startPeriod = resolveSchoolPeriod(startPeriodText, periods);
    if (!startPeriod) {
      draft.reason = `找不到開始節次「${startPeriodText}」（可用節次代碼、名稱或編號）`;
      return draft;
    }
    endPeriod = resolveSchoolPeriod(endPeriodText, periods);
    if (!endPeriod) {
      draft.reason = `找不到結束節次「${endPeriodText}」（可用節次代碼、名稱或編號）`;
      return draft;
    }
    if (endPeriod.start < startPeriod.start) {
      draft.reason = "結束節次不得早於開始節次";
      return draft;
    }
  } else if (endPeriodText) {
    draft.reason = "填了結束節次但沒有開始節次";
    return draft;
  }

  // 學校活動層級（選填）：全校／年級；班級僅限單一年級
  const schoolActivity = parseSchoolActivityCell(
    cells.schoolActivity ?? "",
    cells.schoolActivityClasses ?? "",
    classGrades
  );
  if (!schoolActivity.ok) {
    draft.reason = schoolActivity.reason;
    return draft;
  }

  let input: CalendarEventInput;
  if (allDay) {
    if (end && formatDateOnly(end.ms) !== formatDateOnly(start.ms)) {
      draft.reason = "全天行程僅支援單日（結束請留空或與開始同日）";
      return draft;
    }
    input = {
      title,
      description: cells.description || undefined,
      location: cells.location || undefined,
      allDay: true,
      allDayDate: formatDateOnly(start.ms),
      important,
      schoolActivity: schoolActivity.value,
      categoryId: resolveCategoryByName(cells.category ?? "", categories),
      publishUnit: cells.publishUnit || undefined,
      audience: { roles: [...ALL_ROLES], classCodes: [] },
      isPublic,
    };
  } else {
    let startAt: number;
    let endAt: number | undefined;
    if (startPeriod && endPeriod) {
      const startMs = combineDateAndTime(start.ms, startPeriod.start);
      const endMs = combineDateAndTime(start.ms, endPeriod.end);
      if (startMs === null || endMs === null) {
        draft.reason = "課表節次時間格式錯誤";
        return draft;
      }
      startAt = startMs;
      endAt = endMs;
    } else {
      startAt = start.ms;
      if (end) {
        // 結束僅日期（無時間）＝補到當日 23:59；結束含時間＝原值
        endAt = end.dateOnly ? endOfDay(end.ms) : end.ms;
        if (endAt < startAt) {
          draft.reason = "結束不得早於開始";
          return draft;
        }
      }
    }
    const roles = parseRolesCell(cells.roles ?? "");
    if (!roles) {
      draft.reason = "閱讀權限無法解析（如：學生,家長 或留空＝全部）";
      return draft;
    }
    const classCodes = (cells.classCodes ?? "")
      .split(/[,、;；\s]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    const audience = parseCalendarAudience({ roles, classCodes }, isPublic);
    if (!audience) {
      draft.reason = "閱讀權限無效";
      return draft;
    }
    input = {
      title,
      description: cells.description || undefined,
      location: cells.location || undefined,
      startAt,
      endAt: endAt ?? null,
      allDay: false,
      important,
      schoolActivity: schoolActivity.value,
      categoryId: resolveCategoryByName(cells.category ?? "", categories),
      publishUnit: cells.publishUnit || undefined,
      audience,
      isPublic,
    };
  }

  const validation = validateCalendarInput(input);
  if (!validation.ok) {
    draft.reason = validation.message;
    return draft;
  }

  draft.action = "create";
  draft.input = input;
  draft.timeText = timeTextOf(input);
  draft.categoryName =
    categories.find((c) => c.id === (input.categoryId ?? "other"))?.name ?? "其他";
  const activityText = schoolActivityText(validation.value.schoolActivity);
  if (activityText) draft.schoolActivity = activityText;
  return draft;
}

function parseWorkbook(buffer: Buffer): Record<string, unknown>[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("檔案沒有工作表");
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
}

/** GET：下載範例檔（含 5 種時間格式與學校活動層級範例列；上傳前請刪除【範例】列） */
export async function GET(request: NextRequest) {
  try {
    const { denial } = await requireModulePermission("calendar", "import");
    if (denial) return toAuthResponse(denial);

    const sampleRows = [
      {
        標題: "【範例】校慶運動會（全天）",
        行事曆類型: "活動",
        全天: "是",
        開始: "2026/10/25",
        結束: "",
        開始節次: "",
        結束節次: "",
        地點: "運動場",
        發佈單位: "學務處",
        說明: "全天行程：僅填開始日期，全天欄填「是」；學校活動層級填「全校」。",
        重要: "",
        學校活動層級: "全校",
        學校活動班級: "",
        閱讀權限: "",
        班級代碼: "",
        公開: "",
      },
      {
        標題: "【範例】朝會（單日時段）",
        行事曆類型: "學期初",
        全天: "",
        開始: "2026/10/10 08:00",
        結束: "2026/10/10 10:00",
        開始節次: "",
        結束節次: "",
        地點: "禮堂",
        發佈單位: "",
        說明: "同一天的時間段：開始與結束同日、帶時間；學校活動層級填年級與班級代碼。",
        重要: "",
        學校活動層級: "一年級",
        學校活動班級: "101,102",
        閱讀權限: "學生,教職員",
        班級代碼: "",
        公開: "",
      },
      {
        標題: "【範例】期中考週（跨日日期）",
        行事曆類型: "期中",
        全天: "",
        開始: "2026/10/10",
        結束: "2026/10/12",
        開始節次: "",
        結束節次: "",
        地點: "",
        發佈單位: "教務處",
        說明: "跨日日期：開始與結束皆不帶時間，自動涵蓋至結束當日結束；學校活動層級可填多個年級。",
        重要: "是",
        學校活動層級: "一年級,二年級",
        學校活動班級: "",
        閱讀權限: "",
        班級代碼: "",
        公開: "",
      },
      {
        標題: "【範例】家長說明會（跨日日期時間）",
        行事曆類型: "活動",
        全天: "",
        開始: "2026/10/10 08:00",
        結束: "2026/10/12 12:00",
        開始節次: "",
        結束節次: "",
        地點: "會議室",
        發佈單位: "",
        說明: "跨日日期時間：開始與結束皆帶日期與時間；未指定學校活動層級時兩欄留空。",
        重要: "",
        學校活動層級: "",
        學校活動班級: "",
        閱讀權限: "家長,教職員",
        班級代碼: "101,102",
        公開: "",
      },
      {
        標題: "【範例】課表節次（第一節至第三節）",
        行事曆類型: "學期初",
        全天: "",
        開始: "2026/10/10",
        結束: "",
        開始節次: "1",
        結束節次: "3",
        地點: "禮堂",
        發佈單位: "",
        說明: "課表節次：開始填日期（時間可留空），以開始／結束節次帶入課表作息的起訖時間；只填開始節次＝單一節次；學校活動層級填年級＝全年級。",
        重要: "",
        學校活動層級: "一年級",
        學校活動班級: "",
        閱讀權限: "學生,教職員",
        班級代碼: "",
        公開: "",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(sampleRows);
    worksheet["!cols"] = [
      { wch: 32 },
      { wch: 10 },
      { wch: 6 },
      { wch: 18 },
      { wch: 18 },
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
      { wch: 40 },
      { wch: 6 },
      { wch: 16 },
      { wch: 16 },
      { wch: 16 },
      { wch: 12 },
      { wch: 6 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "行程批次新增");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        ...noStore,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("行事曆批次新增範例.xlsx")}`,
      },
    });
  } catch (error) {
    console.error("Calendar import sample error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "產生範例檔失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/**
 * POST：批次新增行程。
 * `dryRun=true`＝只解析並回預覽（不寫入）；否則逐列建立。
 * 欄位定義見 GET 範例檔；全天＝僅單日；跨日以日期／日期時間區間表示。
 * 學校活動層級＝「全校」或年級名稱（年級可多選），班級僅限單一年級且須存在於學校設定。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "calendar-batch",
      RATE.CALENDAR_BATCH.limit,
      RATE.CALENDAR_BATCH.windowMs
    );
    if (limited) return limited;

    const { context, denial } = await requireModulePermission("calendar", "import");
    if (denial) return toAuthResponse(denial);
    const session = context.session;

    const bodyTooLarge = assertBodySize(request, DEFAULT_FORM_BODY_BYTES);
    if (bodyTooLarge) return bodyTooLarge;

    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }
    const dryRun = formData.get("dryRun") === "true";
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, message: "請選擇試算表檔案" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ success: false, message: "檔案過大（上限 2MB）" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sheetRows = parseWorkbook(buffer);
    if (sheetRows.length === 0) {
      return NextResponse.json({ success: false, message: "檔案沒有資料列" }, { status: 400 });
    }
    if (sheetRows.length > MAX_ROWS) {
      return NextResponse.json(
        { success: false, message: `單次最多匯入 ${MAX_ROWS} 筆（檔案有 ${sheetRows.length} 筆）` },
        { status: 400 }
      );
    }

    const [settings, schoolPeriods, classGrades] = await Promise.all([
      getCalendarSettings(),
      getSchoolPeriods(),
      getSchoolClassOptions(),
    ]);
    const enabledCategories = settings.categories.filter((c) => c.enabled);

    const parsed: ParsedRow[] = sheetRows.map((row, index) =>
      buildRowInput(index + 2, mapHeaders(row), enabledCategories, schoolPeriods, classGrades)
    );
    const creatable = parsed.filter((r) => r.action === "create" && r.input);

    if (dryRun) {
      return NextResponse.json(
        {
          success: true,
          dryRun: true,
          total: parsed.length,
          creatable: creatable.length,
          skipped: parsed.length - creatable.length,
          rows: parsed.map(({ input: _input, ...rest }) => rest),
        },
        { headers: noStore }
      );
    }

    if (creatable.length === 0) {
      return NextResponse.json(
        { success: false, message: "沒有可新增的列（請先修正預覽中的錯誤）" },
        { status: 400 }
      );
    }

    const createdBy = {
      uid: session.uid,
      name: session.displayName || session.account,
      role: session.role,
    };
    let created = 0;
    const skipped: Array<{ row: number; reason: string }> = [];
    for (const item of creatable) {
      try {
        await createCalendarEvent({
          sourceModule: "calendar",
          ...item.input!,
          createdBy,
          status: "active",
        });
        created += 1;
      } catch (error) {
        skipped.push({
          row: item.row,
          reason: error instanceof Error ? error.message : "建立失敗",
        });
      }
    }

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "calendar_created",
      ip: getClientIp(request),
      details: `批次新增行程（成功 ${created} 筆、略過 ${skipped.length} 筆，檔名=${file.name}）`,
    });

    const [events, freshSettings] = await Promise.all([
      listAdminCalendarEvents(),
      getCalendarSettings(),
    ]);
    return NextResponse.json(
      {
        success: created > 0,
        dryRun: false,
        message:
          skipped.length > 0
            ? `已新增 ${created} 筆，${skipped.length} 筆失敗`
            : `已新增 ${created} 筆行程`,
        created,
        skipped,
        events,
        settings: freshSettings,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Calendar import error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "批次新增失敗") },
      { status: 500, headers: noStore }
    );
  }
}
