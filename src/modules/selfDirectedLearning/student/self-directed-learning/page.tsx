"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import AdSense from "@/components/AdSense";
import Copyright from "@/components/Copyright";
import Toast, { type ToastMessage } from "@/components/Toast";
import DisclosureArrow from "@/components/DisclosureArrow";
import { RichTextContent, RichTextEditor } from "../../components/rich-text-editor";
import { fetchSettings } from "@/lib/settings-client";
import { logout } from "@/lib/session";
import { Settings, defaultSettings } from "@/types/settings";
import {
  DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS,
  MAINTENANCE_HINT,
  MAINTENANCE_TITLE,
  PLAN_STATUS_LABELS,
  PLAN_TIMING_LABELS,
  PRINT_PREVIEW_DATA,
  PRINT_PREVIEW_READY,
  STUDY_GROUPS,
  TRASH_RETENTION_DAYS,
  WEEKDAY_LABELS,
  openStateOf,
  stripHtmlToText,
  type PlanStatus,
  type PlanTiming,
  type PlanWeek,
  type PlanReview,
  type PrintLayout,
  type PrintPreviewPayload,
  type RecordWindow,
  type SelfDirectedLearningPlan,
  type SelfDirectedLearningSettings,
  type WeekSchedule,
  isFormalPlan,
} from "../../types/self-directed-learning";

interface StudentInfo {
  name: string;
  className: string;
}

type PlanTab = "documents" | "drafts" | "trash";

interface Draft {
  topic: string;
  studyGroup: string;
  advisor: string;
  learningGoals: string;
  weeks: PlanWeek[];
}

const EMPTY_DRAFT: Draft = {
  topic: "",
  studyGroup: "",
  advisor: "",
  learningGoals: "",
  weeks: [],
};

function emptyWeeks(count: number): PlanWeek[] {
  return Array.from({ length: count }, (_, index) => ({
    week: index + 1,
    content: "",
    venue: "",
    timing: "flexible" as PlanTiming,
  }));
}

const WINDOW_LABEL: Record<string, string> = {
  unset: "學校尚未設定送審期間",
  closed: "尚未到送審期間",
  open: "送審期間內",
  ended: "已超過送審期間",
};

/** 表格內的時段短標籤（與教職員審核頁一致，避免窄欄位逐字換行） */
const TIMING_SHORT_LABELS: Record<string, string> = {
  flexible: "彈性學習",
  afterSchool: "課餘",
};

function formatDateTime(epoch: number | null): string {
  if (!epoch) return "—";
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 逐週表格的短日期（`YYYY-MM-DD` → `M/D`） */
function monthDayText(date: string): string {
  const [, month, day] = date.split("-");
  if (!month || !day) return date;
  return `${Number(month)}/${Number(day)}`;
}

/** 短日期時間（`M/D HH:mm`；成果紀錄開放時間顯示用） */
function formatShortDateTime(epoch: number): string {
  if (!epoch) return "—";
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 短日期（`YYYY/M/D`；成果撰寫截止日顯示用） */
function formatShortDate(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 學期識別（如 115-1）轉為易讀文字 */
function periodText(period: string): string {
  const [year, semester] = period.split("-");
  if (!year || !semester) return period || "—";
  return `${year} 學年度第 ${semester} 學期`;
}

function statusClass(status: PlanStatus): string {
  if (status === "approved") return "text-success";
  if (status === "returned") return "text-danger";
  if (status === "submitted") return "text-warning";
  return "text-t3";
}

/**
 * 依設定補齊草稿週數：
 * 全學期形式＝補到程式判斷的學期總週數；彈性形式＝夾在下限與總週數上限之間。
 */
function fitWeeks(
  weeks: PlanWeek[],
  settings: SelfDirectedLearningSettings,
  fullWeeks: number | null
): PlanWeek[] {
  const target =
    settings.weekMode === "full" && fullWeeks !== null
      ? fullWeeks
      : fullWeeks !== null
        ? Math.min(Math.max(weeks.length, settings.minWeeks), fullWeeks)
        : Math.max(weeks.length, settings.minWeeks);
  const next = weeks.slice(0, target);
  while (next.length < target) {
    next.push({ week: next.length + 1, content: "", venue: "", timing: "flexible" });
  }
  return next.map((week, index) => ({ ...week, week: index + 1 }));
}

/** 依指定週次建立（或沿用）逐週安排；用於彈性形式的起迄週次區間 */
function weeksForNumbers(numbers: number[], existing: PlanWeek[]): PlanWeek[] {
  return numbers.map((weekNo) => {
    const previous = existing.find((week) => week.week === weekNo);
    return previous ?? { week: weekNo, content: "", venue: "", timing: "flexible" };
  });
}

function FolderTabIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" />
    </svg>
  );
}

function DraftTabIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8M8 17h5" />
    </svg>
  );
}

function TrashTabIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export default function StudentSelfDirectedLearningPage() {
  const router = useRouter();
  const [systemSettings, setSystemSettings] = useState<Settings>(defaultSettings);
  const [settings, setSettings] = useState<SelfDirectedLearningSettings>(
    DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS
  );
  /** 目前為止的所有計畫（正式＝approved；其餘皆歸草稿） */
  const [plans, setPlans] = useState<SelfDirectedLearningPlan[]>([]);
  /** 各計畫的最新審查意見（key＝plan id） */
  const [reviews, setReviews] = useState<Record<string, PlanReview>>({});
  const [currentPeriod, setCurrentPeriod] = useState("");
  const [withinWindow, setWithinWindow] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"save" | "submit" | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  /** 總開關關閉：只顯示維護說明 */
  const [maintenance, setMaintenance] = useState(false);
  /** 全學期形式的須填週數（由學期起訖自動判斷；null＝學校尚未設定起訖） */
  const [fullWeeks, setFullWeeks] = useState<number | null>(null);
  /** 逐週彈性學習時間（日期／節次）與學校活動衝堂 */
  const [weekSchedule, setWeekSchedule] = useState<WeekSchedule[]>([]);
  /** 執行成果紀錄／學習反思心得開放資訊（逐週開放時間與截止日） */
  const [recordWindow, setRecordWindow] = useState<RecordWindow>({
    deadlineAt: null,
    weeks: [],
  });
  /** 執行成果紀錄草稿（key＝plan id → 週次 → 富文本） */
  const [recordDrafts, setRecordDrafts] = useState<Record<string, Record<number, string>>>({});
  /** 學習反思心得草稿（key＝plan id） */
  const [reflectionDrafts, setReflectionDrafts] = useState<Record<string, string>>({});
  /** 正在儲存成果紀錄的計畫 id */
  const [recordsBusy, setRecordsBusy] = useState<string | null>(null);
  /** 是否展開所有「執行成果紀錄」編輯區（預設收合，避免版面過長） */
  const [recordsExpanded, setRecordsExpanded] = useState(false);
  /** 列印預覽成果紀錄呈現方式（分開式／融入式） */
  const [printLayout, setPrintLayout] = useState<PrintLayout>("separate");
  /** 已展開「查看計畫與撰寫成果」的計畫（同一時間只會有一份；浮動按鈕只在展開時出現） */
  const [openDetailPlans, setOpenDetailPlans] = useState<Record<string, boolean>>({});
  /** 自主學習實施說明是否展開（開啟撰寫表單時自動收合） */
  const [instructionsOpen, setInstructionsOpen] = useState(true);
  /** 學生姓名／班級（列印預覽表頭用） */
  const [studentInfo, setStudentInfo] = useState<StudentInfo | null>(null);
  /** 撰寫計畫區塊是否展開（預設隱藏；發想新計畫或編輯草稿才顯示） */
  const [formOpen, setFormOpen] = useState(false);
  /** 正在編輯的草稿 id；null＝新計畫 */
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  /** 學群是否為「其他（自行填寫）」 */
  const [customStudyGroup, setCustomStudyGroup] = useState(false);
  /** 各週場地是否為「其他（自行填寫）」 */
  const [customVenueWeeks, setCustomVenueWeeks] = useState<Set<number>>(new Set());
  /** 我的計畫分頁：文件匣／草稿匣／垃圾桶 */
  const [planTab, setPlanTab] = useState<PlanTab>("documents");
  /** 彈性形式的週次區間（可寫週次；full 模式不使用） */
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  /** 週次顛倒時等待使用者確認調換 */
  const [rangeSwap, setRangeSwap] = useState<{ start: number; end: number } | null>(null);
  /** 正在假性刪除／還原的計畫 id */
  const [planBusy, setPlanBusy] = useState<string | null>(null);
  /** 準備抽回（取消送審）的計畫 */
  const [withdrawTarget, setWithdrawTarget] = useState<SelfDirectedLearningPlan | null>(null);
  /** 準備永久刪除的垃圾桶計畫 */
  const [purgeTarget, setPurgeTarget] = useState<SelfDirectedLearningPlan | null>(null);
  /** 準備提升為正式計畫的草稿／審核中計畫 */
  const [promoteTarget, setPromoteTarget] = useState<SelfDirectedLearningPlan | null>(null);
  /** 提升前檢核未通過：列出未填寫欄位並阻止提升 */
  const [promoteBlocked, setPromoteBlocked] = useState<{
    planId: string | null;
    planName: string;
    issues: string[];
  } | null>(null);
  /** 表單內「提升為正式」進行中 */
  const [formPromoting, setFormPromoting] = useState(false);
  const formSectionRef = useRef<HTMLElement | null>(null);

  const editingPlan = editingPlanId
    ? plans.find((plan) => plan.id === editingPlanId) ?? null
    : null;
  const locked = editingPlan?.status === "submitted" || editingPlan?.status === "approved";
  /** 場地是否開放學生輸入（舊資料沒有此欄位時視為開放，避免誤鎖） */
  const venueEditable = settings.venueEditable !== false;
  const activePlans = plans.filter((plan) => !plan.deletedAt);
  const trashedPlans = plans.filter((plan) => Boolean(plan.deletedAt));
  const approvedPlans = activePlans.filter((plan) => plan.status === "approved");
  const submittedPlans = activePlans.filter((plan) => plan.status === "submitted");
  const selfPromotedPlans = activePlans.filter(
    (plan) =>
      isFormalPlan(plan) && plan.status !== "approved" && plan.status !== "submitted"
  );
  const draftPlans = activePlans.filter(
    (plan) => plan.status === "draft" && !isFormalPlan(plan)
  );
  const returnedPlans = activePlans.filter(
    (plan) => plan.status === "returned" && !isFormalPlan(plan)
  );
  const documentCount =
    approvedPlans.length + submittedPlans.length + selfPromotedPlans.length;
  const draftCount = draftPlans.length + returnedPlans.length;
  const formalPlans = activePlans.filter(isFormalPlan);
  /** 學校審核通過的正式計畫（每學期僅一份；自行提升的正式不在此限） */
  const otherApprovedPlan =
    activePlans.find(
      (plan) =>
        plan.status === "approved" &&
        plan.period === currentPeriod &&
        plan.id !== editingPlanId
    ) ?? null;
  /** 送出審核一律歸為本學期的計畫，因此以目前學期檢核「僅一件審核中」 */
  const otherSubmittedPlan =
    submittedPlans.find((plan) => plan.period === currentPeriod) ?? null;
  /** 本學期已送審過的其他計畫（含退回、抽回）：一學期僅能送審 1 份 */
  const otherEverSubmittedPlan =
    activePlans.find(
      (plan) =>
        plan.period === currentPeriod &&
        plan.id !== editingPlanId &&
        (plan.firstSubmittedAt ?? plan.submittedAt) !== null
    ) ?? null;
  /** 目前學期已正式（學校通過或學生自行提升）的計畫（執行成果紀錄的對象） */
  /** 目前展開「查看計畫與撰寫成果」的正式計畫（浮動按鈕只作用在這一份） */
  const recordPlan =
    formalPlans.find((plan) => plan.period === currentPeriod && openDetailPlans[plan.id]) ?? null;
  /** 可寫週次（有設定節次時：該週至少一個時段未衝堂；未設定節次時：全部視為可寫） */
  const availableWeekNumbers = useMemo(() => {
    if (weekSchedule.length > 0) {
      return weekSchedule.filter((week) => week.writable !== false).map((week) => week.week);
    }
    const total = fullWeeks ?? Math.max(settings.minWeeks, 1);
    return Array.from({ length: total }, (_, index) => index + 1);
  }, [weekSchedule, fullWeeks, settings.minWeeks]);
  /** 目前選取區間內的可寫週次與數量 */
  const rangeWeekNumbers =
    rangeStart !== null && rangeEnd !== null
      ? availableWeekNumbers.filter((week) => week >= rangeStart && week <= rangeEnd)
      : [];
  const rangeCount = rangeWeekNumbers.length;
  /** 可選的開始週次：扣掉「從這裡開始不足下限」的週次（總數本身不足時全列，並顯示警示） */
  const startOptionNumbers = useMemo(() => {
    const enough = availableWeekNumbers.filter(
      (week, index) => availableWeekNumbers.length - index >= settings.minWeeks
    );
    return enough.length > 0 ? enough : availableWeekNumbers;
  }, [availableWeekNumbers, settings.minWeeks]);
  const rangeValid =
    settings.weekMode !== "flexible" ||
    (rangeStart !== null &&
      rangeEnd !== null &&
      rangeStart <= rangeEnd &&
      rangeCount >= settings.minWeeks);
  const rangeSwapCount = rangeSwap
    ? availableWeekNumbers.filter(
        (week) => week >= rangeSwap.start && week <= rangeSwap.end
      ).length
    : 0;
  /** 週次 → 該週彈性學習時間與衝堂資訊 */
  const weekScheduleByNo = useMemo(
    () => new Map(weekSchedule.map((row) => [row.week, row])),
    [weekSchedule]
  );
  /** 提升為正式前的必填檢核：列出尚未填寫的欄位（空陣列＝可提升） */
  const promoteIssuesOf = (
    plan: Pick<SelfDirectedLearningPlan, "topic" | "studyGroup" | "learningGoals" | "weeks">
  ): string[] => {
    const issues: string[] = [];
    if (!plan.topic.trim()) issues.push("主題");
    if (!plan.studyGroup.trim()) issues.push("學群");
    if (!stripHtmlToText(plan.learningGoals).trim()) issues.push("學習目標");
    if (plan.weeks.length === 0) {
      issues.push("逐週課程安排");
    } else {
      if (settings.weekMode === "flexible" && plan.weeks.length < settings.minWeeks) {
        issues.push(
          `逐週課程安排（至少 ${settings.minWeeks} 週，目前 ${plan.weeks.length} 週）`
        );
      }
      if (settings.weekMode === "full" && fullWeeks !== null && plan.weeks.length !== fullWeeks) {
        issues.push(`逐週課程安排（須填滿 ${fullWeeks} 週，目前 ${plan.weeks.length} 週）`);
      }
      const writableWeeks = plan.weeks.filter(
        (week) => weekScheduleByNo.get(week.week)?.writable !== false
      );
      const missingContent = writableWeeks
        .filter((week) => !stripHtmlToText(week.content).trim())
        .map((week) => week.week);
      if (missingContent.length > 0) {
        issues.push(`第 ${missingContent.join("、")} 週的學習內容`);
      }
      const missingVenue = writableWeeks
        .filter((week) => !week.venue.trim())
        .map((week) => week.week);
      if (missingVenue.length > 0) {
        issues.push(`第 ${missingVenue.join("、")} 週的場地`);
      }
    }
    return issues;
  };
  /** 列印預覽分頁與最近一次送出的預覽內容 */
  const previewWindowRef = useRef<Window | null>(null);
  const printPayloadRef = useRef<PrintPreviewPayload | null>(null);

  /** 套用彈性形式的起迄週次（只保留區間內可寫的週次） */
  const applyWeekRange = (start: number, end: number) => {
    if (start > end) return;
    const numbers = availableWeekNumbers.filter((week) => week >= start && week <= end);
    setRangeStart(start);
    setRangeEnd(end);
    setDraft((prev) => ({
      ...prev,
      weeks: weeksForNumbers(numbers, prev.weeks),
    }));
  };

  /** 新計畫的預設區間：從第一個可寫週次開始，取到滿足下限週數為止 */
  const defaultRange = (): { start: number; end: number; numbers: number[] } | null => {
    if (availableWeekNumbers.length === 0) return null;
    const start = availableWeekNumbers[0];
    const count = Math.min(Math.max(settings.minWeeks, 1), availableWeekNumbers.length);
    const end = availableWeekNumbers[count - 1];
    return {
      start,
      end,
      numbers: availableWeekNumbers.filter((week) => week >= start && week <= end),
    };
  };

  /** 起迄週次變更：順序顛倒時先跳出確認，確認後才調換 */
  const requestRangeChange = (source: "start" | "end", value: number) => {
    const start = source === "start" ? value : rangeStart;
    const end = source === "end" ? value : rangeEnd;
    if (start === null || end === null) return;
    if (start > end) {
      setRangeSwap({ start: Math.min(start, end), end: Math.max(start, end) });
      return;
    }
    applyWeekRange(start, end);
  };

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/student/self-directed-learning", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "讀取資料失敗" });
        return;
      }
      const nextSettings = data.settings as SelfDirectedLearningSettings;
      const nextFullWeeks = typeof data.fullWeeks === "number" ? data.fullWeeks : null;
      setSettings(nextSettings);
      setFullWeeks(nextFullWeeks);
      setWeekSchedule(Array.isArray(data.weekSchedule) ? (data.weekSchedule as WeekSchedule[]) : []);
      setRecordWindow(
        data.recordWindow && typeof data.recordWindow === "object"
          ? {
              deadlineAt:
                typeof (data.recordWindow as RecordWindow).deadlineAt === "number"
                  ? (data.recordWindow as RecordWindow).deadlineAt
                  : null,
              weeks: Array.isArray((data.recordWindow as RecordWindow).weeks)
                ? (data.recordWindow as RecordWindow).weeks
                : [],
            }
          : { deadlineAt: null, weeks: [] }
      );
      setStudentInfo(
        data.student && typeof data.student === "object"
          ? {
              name:
                typeof (data.student as StudentInfo).name === "string"
                  ? (data.student as StudentInfo).name
                  : "",
              className:
                typeof (data.student as StudentInfo).className === "string"
                  ? (data.student as StudentInfo).className
                  : "",
            }
          : null
      );
      setMaintenance(Boolean(data.maintenance));
      setWithinWindow(Boolean(data.withinWindow));
      setCurrentPeriod(typeof data.currentPeriod === "string" ? data.currentPeriod : "");
      setPlans(Array.isArray(data.plans) ? (data.plans as SelfDirectedLearningPlan[]) : []);
      setReviews(
        data.reviews && typeof data.reviews === "object"
          ? (data.reviews as Record<string, PlanReview>)
          : {}
      );
    } catch {
      setToast({ kind: "error", text: "讀取資料失敗" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 列印預覽分頁載入後會送出 ready，這裡回傳目前編輯中的草稿（含未儲存變更）
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const target = previewWindowRef.current;
      if (!target || event.source !== target) return;
      if (!event.data || event.data.type !== PRINT_PREVIEW_READY) return;
      const payload = printPayloadRef.current;
      if (!payload) return;
      try {
        target.postMessage({ type: PRINT_PREVIEW_DATA, payload }, window.location.origin);
      } catch {
        // 分頁已關閉或瀏覽器限制時忽略
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchSettings();
        if (!cancelled && data?.success && data.settings) {
          setSystemSettings({ ...defaultSettings, ...data.settings });
        }
      } catch {
        // 設定讀取失敗時沿用預設值顯示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patchDraft = (partial: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...partial }));

  const patchWeek = (weekNo: number, partial: Partial<PlanWeek>) => {
    setDraft((prev) => ({
      ...prev,
      weeks: prev.weeks.map((week) => (week.week === weekNo ? { ...week, ...partial } : week)),
    }));
  };

  /** 把本週的學習安排與場地完整複製到下一週 */
  const copyWeekToNext = (index: number) => {
    const source = draft.weeks[index];
    const target = draft.weeks[index + 1];
    if (!source || !target) return;
    setDraft((prev) => ({
      ...prev,
      weeks: prev.weeks.map((week, weekIndex) =>
        weekIndex === index + 1
          ? { ...week, content: source.content, venue: source.venue }
          : week
      ),
    }));
    setCustomVenueWeeks((prev) => {
      const next = new Set(prev);
      if (customVenueWeeks.has(source.week)) next.add(target.week);
      else next.delete(target.week);
      return next;
    });
    setToast({ kind: "success", text: "已複製本週場地與學習安排到下一週" });
  };

  const revealForm = () => {
    requestAnimationFrame(() => {
      formSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  /** 開啟撰寫表單時，收合上方所有已展開的區塊（實施說明、計畫詳情與成果編輯區），讓表單成為唯一焦點 */
  const collapseSectionsAboveForm = () => {
    setInstructionsOpen(false);
    setOpenDetailPlans({});
    setRecordsExpanded(false);
  };

  const startNewPlan = () => {
    collapseSectionsAboveForm();
    setEditingPlanId(null);
    setCustomStudyGroup(false);
    setCustomVenueWeeks(new Set());
    if (settings.weekMode === "flexible") {
      const range = defaultRange();
      if (range) {
        setRangeStart(range.start);
        setRangeEnd(range.end);
        setDraft({ ...EMPTY_DRAFT, weeks: weeksForNumbers(range.numbers, []) });
      } else {
        setRangeStart(null);
        setRangeEnd(null);
        setDraft({ ...EMPTY_DRAFT, weeks: [] });
      }
    } else {
      setRangeStart(null);
      setRangeEnd(null);
      setDraft({ ...EMPTY_DRAFT, weeks: fitWeeks(emptyWeeks(1), settings, fullWeeks) });
    }
    setFormOpen(true);
    revealForm();
  };

  const startEditPlan = (plan: SelfDirectedLearningPlan) => {
    if (plan.status !== "draft" && plan.status !== "returned") return;
    collapseSectionsAboveForm();
    setEditingPlanId(plan.id);
    setCustomStudyGroup(
      plan.studyGroup !== "" && !(STUDY_GROUPS as readonly string[]).includes(plan.studyGroup)
    );
    setCustomVenueWeeks(
      venueEditable
        ? new Set(
            plan.weeks
              .filter((week) => week.venue && !settings.venues.includes(week.venue))
              .map((week) => week.week)
          )
        : new Set()
    );
    if (settings.weekMode === "flexible") {
      const stored = plan.weeks;
      if (stored.length === 0) {
        const range = defaultRange();
        setRangeStart(range?.start ?? null);
        setRangeEnd(range?.end ?? null);
        setDraft({
          topic: plan.topic,
          studyGroup: plan.studyGroup,
          advisor: plan.advisor,
          learningGoals: plan.learningGoals,
          weeks: range ? weeksForNumbers(range.numbers, []) : [],
        });
      } else {
        const spanStart = Math.min(...stored.map((week) => week.week));
        const spanEnd = Math.max(...stored.map((week) => week.week));
        const numbers = availableWeekNumbers.filter(
          (week) => week >= spanStart && week <= spanEnd
        );
        if (numbers.length > 0) {
          setRangeStart(numbers[0]);
          setRangeEnd(numbers[numbers.length - 1]);
          setDraft({
            topic: plan.topic,
            studyGroup: plan.studyGroup,
            advisor: plan.advisor,
            learningGoals: plan.learningGoals,
            weeks: weeksForNumbers(numbers, stored),
          });
        } else {
          // 既有資料的週次都不在目前可寫清單（例如後續新增了學校活動）：保留原內容，讓使用者自行調整
          setRangeStart(spanStart);
          setRangeEnd(spanEnd);
          setDraft({
            topic: plan.topic,
            studyGroup: plan.studyGroup,
            advisor: plan.advisor,
            learningGoals: plan.learningGoals,
            weeks: stored,
          });
        }
      }
    } else {
      setRangeStart(null);
      setRangeEnd(null);
      const weeks = plan.weeks.length ? plan.weeks : emptyWeeks(1);
      setDraft({
        topic: plan.topic,
        studyGroup: plan.studyGroup,
        advisor: plan.advisor,
        learningGoals: plan.learningGoals,
        weeks: fitWeeks(weeks, settings, fullWeeks),
      });
    }
    setFormOpen(true);
    revealForm();
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingPlanId(null);
  };

  /**
   * 開新分頁列印預覽：
   * - 不帶參數＝目前撰寫中的草稿（含尚未儲存的變更）
   * - 帶入計畫＝已通過的計畫內容＋執行成果紀錄＋學習反思心得
   */
  const openPrintPreview = (plan?: SelfDirectedLearningPlan) => {
    const weeks = plan ? plan.weeks : draft.weeks;
    const payload: PrintPreviewPayload = {
      period: plan?.period || currentPeriod,
      studentName: plan?.studentName || studentInfo?.name || editingPlan?.studentName || "",
      className: plan?.className || studentInfo?.className || editingPlan?.className || "",
      topic: plan ? plan.topic : draft.topic,
      studyGroup: plan ? plan.studyGroup : draft.studyGroup,
      advisor: plan ? plan.advisor : draft.advisor,
      learningGoals: plan ? plan.learningGoals : draft.learningGoals,
      reflection: plan?.reflection ?? "",
      source: plan ? "approved" : "draft",
      formalByStudent: Boolean(plan?.selfApprovedAt && plan.status !== "approved"),
      layout: printLayout,
      generatedAt: Date.now(),
      weeks: weeks.map((week) => {
        const scheduleRow = weekScheduleByNo.get(week.week);
        const slots = scheduleRow?.slots ?? [];
        return {
          week: week.week,
          timing: week.timing,
          content: week.content,
          venue: week.venue,
          slots: slots.map((slot) => ({
            date: slot.date,
            day: slot.day,
            periods: [...slot.periods],
            blockedBy: slot.blockedBy,
          })),
          blocked: scheduleRow?.blocked ?? false,
          record:
            plan?.executionRecords.find((item) => item.week === week.week)?.note ?? "",
        };
      }),
    };
    printPayloadRef.current = payload;
    const preview = window.open("/student/self-directed-learning/print", "_blank");
    if (!preview) {
      setToast({ kind: "error", text: "瀏覽器封鎖了新分頁，請允許彈出視窗後再試" });
      return;
    }
    previewWindowRef.current = preview;
    preview.focus();
  };

  const submit = async (action: "save" | "submit") => {
    setSaving(action);
    try {
      const response = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, draft, planId: editingPlanId ?? undefined }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "儲存失敗" });
        return;
      }
      const saved = data.plan as SelfDirectedLearningPlan;
      setEditingPlanId(saved.id);
      setToast({ kind: "success", text: action === "submit" ? "已送出審核" : "草稿已儲存" });
      if (action === "submit") {
        setFormOpen(false);
        setEditingPlanId(null);
        setPlanTab("documents");
      }
      await load();
    } catch {
      setToast({ kind: "error", text: "儲存失敗" });
    } finally {
      setSaving(null);
    }
  };

  /** 表單內「提升為正式」：先檢核目前填寫內容，通過後儲存再提升 */
  const promoteFromForm = async () => {
    if (!editingPlan || saving !== null || formPromoting || planBusy !== null) return;
    const issues = promoteIssuesOf(draft);
    if (issues.length > 0) {
      setPromoteBlocked({
        planId: editingPlan.id,
        planName: draft.topic.trim() || "（未命名計畫）",
        issues,
      });
      return;
    }
    setFormPromoting(true);
    setSaving("save");
    try {
      const saveResponse = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", draft, planId: editingPlanId ?? undefined }),
      });
      const saveData = await saveResponse.json();
      const saved = saveData.plan as SelfDirectedLearningPlan | undefined;
      if (!saveResponse.ok || !saveData.success || !saved) {
        setToast({ kind: "error", text: saveData.message || "儲存失敗，無法提升" });
        return;
      }
      const promoteResponse = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote", planId: saved.id }),
      });
      const promoteData = await promoteResponse.json();
      if (!promoteResponse.ok || !promoteData.success) {
        setToast({ kind: "error", text: promoteData.message || "提升失敗" });
        return;
      }
      setFormOpen(false);
      setEditingPlanId(null);
      setPlanTab("documents");
      setToast({
        kind: "success",
        text: promoteData.message || "已提升為正式計畫，可開始按時填寫成果",
      });
      await load();
    } catch {
      setToast({ kind: "error", text: "提升失敗" });
    } finally {
      setSaving(null);
      setFormPromoting(false);
    }
  };

  /** 假性刪除／還原：只影響草稿與退回修改，正式與審核中的計畫由伺服器擋下 */
  const changePlanDeleted = async (plan: SelfDirectedLearningPlan, deleted: boolean) => {
    if (planBusy) return;
    setPlanBusy(plan.id);
    try {
      const response = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: deleted ? "trash" : "restore",
          planId: plan.id,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "操作失敗" });
        return;
      }
      if (deleted && editingPlanId === plan.id) {
        setFormOpen(false);
        setEditingPlanId(null);
      }
      if (!deleted) setPlanTab("drafts");
      setToast({
        kind: "success",
        text: data.message || (deleted ? "已移至垃圾桶" : "已還原"),
      });
      await load();
    } catch {
      setToast({ kind: "error", text: "操作失敗" });
    } finally {
      setPlanBusy(null);
    }
  };

  /** 設定某一份正式計畫是否讓家長檢視 */
  const setParentVisibility = async (plan: SelfDirectedLearningPlan, visible: boolean) => {
    if (planBusy) return;
    setPlanBusy(plan.id);
    try {
      const response = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "parentVisibility", planId: plan.id, visible }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "設定失敗" });
        return;
      }
      setToast({
        kind: "success",
        text: data.message || (visible ? "已開放家長檢視" : "已取消家長檢視"),
      });
      await load();
    } catch {
      setToast({ kind: "error", text: "設定失敗" });
    } finally {
      setPlanBusy(null);
    }
  };

  /** 永久刪除垃圾桶中的計畫（不可復原；連同審查紀錄） */
  const purgePlan = async (plan: SelfDirectedLearningPlan) => {
    if (planBusy) return;
    setPlanBusy(plan.id);
    try {
      const response = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "purge", planId: plan.id }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "永久刪除失敗" });
        return;
      }
      setPurgeTarget(null);
      setToast({ kind: "success", text: data.message || "已永久刪除" });
      await load();
    } catch {
      setToast({ kind: "error", text: "永久刪除失敗" });
    } finally {
      setPlanBusy(null);
    }
  };

  /** 學生自行提升為正式計畫（保留學校審核；退回不影響正式） */
  const promotePlan = async (plan: SelfDirectedLearningPlan) => {
    if (planBusy) return;
    setPlanBusy(plan.id);
    try {
      const response = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote", planId: plan.id }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "提升失敗" });
        return;
      }
      setPromoteTarget(null);
      setToast({
        kind: "success",
        text: data.message || "已提升為正式計畫，可開始按時填寫成果",
      });
      await load();
    } catch {
      setToast({ kind: "error", text: "提升失敗" });
    } finally {
      setPlanBusy(null);
    }
  };

  /** 抽回審核中的計畫：回到草稿匣，送審期間內可修改後重新送出 */
  const withdrawPlan = async (plan: SelfDirectedLearningPlan) => {
    if (planBusy) return;
    setPlanBusy(plan.id);
    try {
      const response = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "withdraw", planId: plan.id }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "抽回失敗" });
        return;
      }
      setWithdrawTarget(null);
      setPlanTab("drafts");
      setToast({
        kind: "success",
        text: data.message || "已抽回，可在草稿匣修改後重新送出",
      });
      await load();
    } catch {
      setToast({ kind: "error", text: "抽回失敗" });
    } finally {
      setPlanBusy(null);
    }
  };

  const windowState = openStateOf(settings);
  /** 送審狀態的提示色（主題變數） */
  const windowTone =
    windowState === "open"
      ? "var(--success)"
      : windowState === "ended"
        ? "var(--warning)"
        : "var(--t3)";
  /** 草稿匣（含退回修改）是否已達管理端設定上限 */
  const draftLimitReached = draftCount >= settings.maxDrafts;
  /** 文件匣（審核中＋已通過＋自行提升）是否已達管理端設定上限；編輯中的計畫已占位時不重複計算 */
  const editingDocumentCount =
    editingPlan && (isFormalPlan(editingPlan) || editingPlan.status === "submitted") ? 1 : 0;
  const documentLimitReached =
    documentCount - editingDocumentCount >= settings.maxDocumentPlans;
  /** 提升檢核未通過時對應的計畫（供「前往編輯」使用） */
  const promoteBlockedPlan = promoteBlocked?.planId
    ? plans.find((plan) => plan.id === promoteBlocked.planId) ?? null
    : null;
  const canSubmit =
    withinWindow &&
    !locked &&
    saving === null &&
    rangeValid &&
    !otherSubmittedPlan &&
    !otherEverSubmittedPlan &&
    !otherApprovedPlan &&
    !documentLimitReached;
  const canStartNew = !formOpen && !loading;

  const formActionButtons = (
    <>
      <button
        type="button"
        className="btn-theme px-6 py-3 text-base"
        disabled={locked || saving !== null || loading}
        onClick={() => void submit("save")}
      >
        {saving === "save" ? "儲存中…" : "儲存草稿"}
      </button>
      {editingPlan &&
        (editingPlan.status === "draft" || editingPlan.status === "returned") &&
        !isFormalPlan(editingPlan) &&
        editingPlan.period === currentPeriod && (
          <button
            type="button"
            className="btn-theme px-6 py-3 text-base"
            style={{ color: "var(--primary)", borderColor: "var(--primary)" }}
            disabled={locked || saving !== null || loading || documentLimitReached}
            onClick={() => void promoteFromForm()}
            title={
              documentLimitReached
                ? `文件匣已達上限（${settings.maxDocumentPlans} 件，含審核中與已通過）`
                : "檢核必填欄位後，儲存並提升為正式計畫"
            }
          >
            {formPromoting ? "提升中…" : "提升為正式"}
          </button>
        )}
      <button
        type="button"
        className="btn-primary px-6 py-3 text-base"
        disabled={!canSubmit || loading}
        onClick={() => void submit("submit")}
        title={
          otherApprovedPlan
            ? "本學期已有通過審核的正式計畫，無法再送出其他計畫"
            : otherSubmittedPlan
              ? "本學期已有計畫在審核中，請等待審查結果或先抽回後再送出"
              : otherEverSubmittedPlan
                ? "本學期只能送審 1 份計畫，請改為編輯已送審的計畫"
                : documentLimitReached
                  ? `文件匣已達上限（${settings.maxDocumentPlans} 件，含審核中與已通過）`
                  : withinWindow
                    ? ""
                    : WINDOW_LABEL[windowState]
        }
      >
        {saving === "submit" ? "送出中…" : "送出審核"}
      </button>
    </>
  );

  const actionButtons = (
    <>
      <button
        type="button"
        onClick={() => router.push("/student")}
        className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer"
      >
        返回功能首頁
      </button>
      <button
        type="button"
        onClick={() => {
          void logout();
          router.push("/");
        }}
        className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer"
      >
        登出
      </button>
    </>
  );

  /** 頁面外殼：與「升學考試與模擬考校內報名」學生頁一致（內容顯示區由 inner 帶入） */
  const renderShell = (inner: ReactNode) => (
    <div className="min-h-screen flex flex-col items-center bg-page px-4 pt-[20px]">
      <Toast message={toast} onClose={() => setToast(null)} />

      <div className="text-center mb-2">
        <h1 className="text-4xl font-bold mb-2">
          {systemSettings.systemName || "數位校園工具箱"}
        </h1>
        <p className="text-xl text-t2">{systemSettings.schoolFullName || "學校名稱"}</p>
        <p className="text-lg text-t3">
          {systemSettings.academicYear} 學年度 第{systemSettings.semester}學期
        </p>
      </div>

      <div className="content-width mt-4 mb-2 text-center">
        <h2 className="text-2xl font-bold text-t1">自主學習計畫</h2>
      </div>

      <div className="content-width flex justify-end gap-2 mb-4">{actionButtons}</div>
      <hr className="content-width border-themed mb-4" />

      <main className="content-width mb-6 space-y-4">{inner}</main>

      <hr className="content-width border-themed mb-4" />
      <div className="content-width flex justify-start gap-2 mb-4">{actionButtons}</div>

      {systemSettings.sponsorAdEnabled && (
        <div className="content-width mt-8">
          <AdSense />
        </div>
      )}

      <div className="content-width mt-auto">
        <Copyright mode={systemSettings.copyrightNotice ? "啟用" : "關閉"} />
      </div>
    </div>
  );

  /**
   * 該計畫的「執行成果紀錄」開放狀態：
   * 逐週需等該週規劃時間（最後一個節次結束）過了才開放；學習反思心得等最後一週過了才開放；
   * 兩者都受管理端設定的成果撰寫截止日限制（含當日）。
   */
  const recordInfoOf = (plan: SelfDirectedLearningPlan) => {
    const openByWeek = new Map(recordWindow.weeks.map((row) => [row.week, row.openAt]));
    const endByWeek = new Map(recordWindow.weeks.map((row) => [row.week, row.endAt]));
    const openAtOf = (week: number) => openByWeek.get(week) ?? 0;
    const reflectionOpenAt = plan.weeks.reduce(
      (max, week) => Math.max(max, endByWeek.get(week.week) ?? 0),
      0
    );
    // 成果撰寫截止時間只適用「學校審核通過」的計畫；自行提升的正式計畫不受限制
    const deadlineAt = plan.status === "approved" ? recordWindow.deadlineAt : null;
    const now = Date.now();
    return {
      openAtOf,
      reflectionOpenAt,
      deadlineAt,
      weekOpen: (week: number) => openAtOf(week) > 0 && now >= openAtOf(week),
      reflectionOpen: reflectionOpenAt > 0 && now >= reflectionOpenAt,
      /** 未設定截止時間＝不限制（只要該週時間到即可填寫） */
      withinDeadline: deadlineAt === null || now <= deadlineAt,
    };
  };

  /** 已通過計畫的成果編輯狀態（左側浮動按鈕用） */
  const canSaveRecordsOf = (plan: SelfDirectedLearningPlan) => {
    const info = recordInfoOf(plan);
    return (
      info.withinDeadline &&
      (plan.weeks.some((week) => info.weekOpen(week.week)) || info.reflectionOpen)
    );
  };
  const recordCanSave = recordPlan ? canSaveRecordsOf(recordPlan) : false;

  /** 已填寫或草稿中的某一週執行成果 */
  const recordValueOf = (plan: SelfDirectedLearningPlan, week: number): string =>
    recordDrafts[plan.id]?.[week] ??
    plan.executionRecords.find((record) => record.week === week)?.note ??
    "";

  const setRecordValue = (plan: SelfDirectedLearningPlan, week: number, value: string) => {
    setRecordDrafts((prev) => {
      const base =
        prev[plan.id] ??
        Object.fromEntries(plan.executionRecords.map((record) => [record.week, record.note]));
      return { ...prev, [plan.id]: { ...base, [week]: value } };
    });
  };

  const reflectionValueOf = (plan: SelfDirectedLearningPlan): string =>
    reflectionDrafts[plan.id] ?? plan.reflection ?? "";

  const setReflectionValue = (plan: SelfDirectedLearningPlan, value: string) => {
    setReflectionDrafts((prev) => ({ ...prev, [plan.id]: value }));
  };

  /** 儲存執行成果紀錄與學習反思心得（只送已開放的週次與反思） */
  const saveRecords = async (plan: SelfDirectedLearningPlan) => {
    if (recordsBusy) return;
    const info = recordInfoOf(plan);
    const records = plan.weeks
      .filter((week) => info.weekOpen(week.week))
      .map((week) => ({ week: week.week, note: recordValueOf(plan, week.week) }));
    setRecordsBusy(plan.id);
    try {
      const response = await fetch("/api/student/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "records",
          planId: plan.id,
          records,
          ...(info.reflectionOpen ? { reflection: reflectionValueOf(plan) } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "儲存失敗" });
        return;
      }
      setToast({ kind: "success", text: data.message || "已儲存執行成果紀錄" });
      setRecordDrafts((prev) => {
        const next = { ...prev };
        delete next[plan.id];
        return next;
      });
      setReflectionDrafts((prev) => {
        const next = { ...prev };
        delete next[plan.id];
        return next;
      });
      await load();
    } catch {
      setToast({ kind: "error", text: "儲存失敗" });
    } finally {
      setRecordsBusy(null);
    }
  };

  const renderPlanCard = (
    plan: SelfDirectedLearningPlan,
    options: {
      editable?: boolean;
      trashable?: boolean;
      restorable?: boolean;
      withdrawable?: boolean;
      promotable?: boolean;
    } = {}
  ) => {
    const review = reviews[plan.id];
    const busy = planBusy === plan.id;
    /** 學生自行提升為正式：流程狀態仍是草稿／退回，但畫面不再標示「草稿」，避免與正式標籤互相矛盾 */
    const selfPromoted = isFormalPlan(plan) && plan.status !== "approved";
    const showStatusBadge = !(selfPromoted && plan.status !== "submitted");
    /** 已通過且為本學期的計畫：在「查看計畫與撰寫成果」上下提供成果操作按鈕 */
    const showRecordActions = isFormalPlan(plan) && plan.period === currentPeriod;
    const recordActionButtons = (target: SelfDirectedLearningPlan) => (
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn-theme rounded px-4 py-2 text-xs"
          onClick={() => openPrintPreview(target)}
        >
          預覽列印（計畫與成果）
        </button>
        <div
          role="group"
          aria-label="列印成果紀錄呈現方式"
          className="border border-themed bg-card text-t1 flex flex-wrap items-center gap-3 rounded px-3 py-2 text-xs"
        >
          <span className="text-t3">列印方式</span>
          <label
            className="flex cursor-pointer items-center gap-1"
            title="執行成果紀錄另列於表格下方"
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={printLayout === "separate"}
              onChange={() => setPrintLayout("separate")}
            />
            分開式
          </label>
          <label
            className="flex cursor-pointer items-center gap-1"
            title="執行成果紀錄融入當週學習安排"
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={printLayout === "integrated"}
              onChange={() => setPrintLayout("integrated")}
            />
            融入式
          </label>
        </div>
        <button
          type="button"
          className="btn-theme rounded px-4 py-2 text-xs"
          onClick={() => setRecordsExpanded((prev) => !prev)}
        >
          {recordsExpanded ? "收合全部成果編輯區" : "展開全部成果編輯區"}
        </button>
        <button
          type="button"
          className="btn-primary rounded px-4 py-2 text-xs disabled:opacity-50"
          disabled={recordsBusy === target.id || !canSaveRecordsOf(target)}
          onClick={() => void saveRecords(target)}
        >
          {recordsBusy === target.id ? "儲存中…" : "儲存執行成果紀錄"}
        </button>
      </div>
    );
    return (
      <article key={plan.id} className="border border-themed bg-surface space-y-3 rounded-lg p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-t1 text-base font-semibold break-words">
                {plan.topic || "（未命名草稿）"}
              </h4>
              {showStatusBadge && (
                <span
                  className={`border-themed bg-card rounded-full border px-2 py-0.5 text-xs ${statusClass(
                    plan.status
                  )}`}
                >
                  {PLAN_STATUS_LABELS[plan.status]}
                </span>
              )}
              {isFormalPlan(plan) && plan.status !== "approved" && (
                <span
                  className="border-themed bg-card text-success rounded-full border px-2 py-0.5 text-xs"
                  title="學生自行提升為正式；學校審核仍會保留，退回不影響正式狀態"
                >
                  正式（自行提升）
                </span>
              )}
              {isFormalPlan(plan) && plan.parentVisible === false && (
                <span
                  className="border-themed bg-card text-t3 rounded-full border px-2 py-0.5 text-xs"
                  title="家長端不會顯示這份計畫"
                >
                  家長不可見
                </span>
              )}
            </div>
            <p className="text-t3 text-xs">
              {periodText(plan.period)}・{plan.studyGroup || "未填學群"}・指導老師：
              {plan.advisor || "未指定"}
            </p>
            <p className="text-t3 text-xs">更新：{formatDateTime(plan.updatedAt)}</p>
            {plan.deletedAt && (
              <p className="text-t3 text-xs">移至垃圾桶：{formatDateTime(plan.deletedAt)}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {options.withdrawable &&
              plan.status === "submitted" &&
              plan.period === currentPeriod && (
                <button
                  type="button"
                  className="btn-theme rounded px-3 py-1.5 text-xs"
                  style={{ color: "var(--warning)", borderColor: "var(--warning)" }}
                  disabled={busy}
                  title="抽回後回到草稿匣，可修改後重新送出"
                  onClick={() => setWithdrawTarget(plan)}
                >
                  {busy ? "處理中…" : "抽回修改"}
                </button>
              )}
            {options.promotable &&
              plan.period === currentPeriod &&
              !isFormalPlan(plan) &&
              (plan.status === "submitted" ||
                ((plan.status === "draft" || plan.status === "returned") &&
                  !documentLimitReached)) && (
                <button
                  type="button"
                  className="btn-theme rounded px-3 py-1.5 text-xs"
                  style={{ color: "var(--primary)", borderColor: "var(--primary)" }}
                  disabled={busy}
                  title="提升後可立即按時填寫成果；學校審核仍會保留"
                  onClick={() => {
                    const issues = promoteIssuesOf(plan);
                    if (issues.length > 0) {
                      setPromoteBlocked({
                        planId: plan.id,
                        planName: plan.topic || "（未命名計畫）",
                        issues,
                      });
                      return;
                    }
                    setPromoteTarget(plan);
                  }}
                >
                  提升為正式
                </button>
              )}
            {isFormalPlan(plan) && (
              <button
                type="button"
                className="btn-theme rounded px-3 py-1.5 text-xs"
                style={
                  plan.parentVisible === false
                    ? { color: "var(--primary)", borderColor: "var(--primary)" }
                    : undefined
                }
                disabled={busy}
                title={
                  plan.parentVisible === false
                    ? "目前家長看不到這份計畫，點此開放檢視"
                    : "目前家長看得到這份計畫，點此隱藏"
                }
                onClick={() => void setParentVisibility(plan, plan.parentVisible === false)}
              >
                {busy
                  ? "處理中…"
                  : plan.parentVisible === false
                    ? "開放家長檢視"
                    : "隱藏家長檢視"}
              </button>
            )}
            {options.editable && (plan.status === "draft" || plan.status === "returned") && (
              <button
                type="button"
                className="btn-theme rounded px-3 py-1.5 text-xs"
                disabled={busy}
                onClick={() => startEditPlan(plan)}
              >
                編輯
              </button>
            )}
            {options.trashable && (plan.status === "draft" || plan.status === "returned") && (
              <button
                type="button"
                className="btn-theme text-danger rounded px-3 py-1.5 text-xs"
                disabled={busy}
                onClick={() => void changePlanDeleted(plan, true)}
              >
                {busy ? "處理中…" : "移至垃圾桶"}
              </button>
            )}
            {options.restorable && (
              <>
                <button
                  type="button"
                  className="btn-theme text-primary rounded px-3 py-1.5 text-xs"
                  disabled={busy}
                  onClick={() => void changePlanDeleted(plan, false)}
                >
                  {busy ? "處理中…" : "還原"}
                </button>
                <button
                  type="button"
                  className="btn-danger rounded px-3 py-1.5 text-xs"
                  disabled={busy}
                  onClick={() => setPurgeTarget(plan)}
                >
                  永久刪除
                </button>
              </>
            )}
          </div>
        </div>

        {review && (
          <div className="border-l-4 border-l-primary border-themed bg-card rounded-md border p-3">
            <p className="text-t1 text-xs font-medium">學校審查意見回饋</p>
            <RichTextContent
              html={review.note}
              emptyText="（無文字意見）"
              className="text-t2 mt-1 text-xs"
            />
          </div>
        )}

        <details
          className="border-themed border-t pt-2"
          open={!formOpen && Boolean(openDetailPlans[plan.id])}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setOpenDetailPlans((prev) => {
              // 同一時間只允許一份計畫展開：開啟時清掉其他計畫的展開狀態
              if (open) return { [plan.id]: true };
              if (!prev[plan.id]) return prev;
              return { ...prev, [plan.id]: false };
            });
          }}
        >
          <summary className="text-t2 flex cursor-pointer items-center gap-1 text-xs">
            <DisclosureArrow />
            查看計畫與撰寫成果（{plan.weeks.length} 週）
          </summary>
          {showRecordActions && recordActionButtons(plan)}
          {plan.learningGoals && (
            <div className="mt-2 space-y-1">
              <p className="text-t1 text-xs font-medium">學習目標</p>
              <div className="border border-themed bg-card rounded-md p-3">
                <RichTextContent html={plan.learningGoals} className="text-t2 text-xs" />
              </div>
            </div>
          )}
          {/* 逐週內容以表格呈現（與教職員審核頁一致：週次／學習安排／場地） */}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="border border-themed bg-surface text-t1 px-2 py-2 text-xs"
                    style={{ width: "14%", textAlign: "center" }}
                  >
                    週次
                  </th>
                  <th
                    scope="col"
                    className="border border-themed bg-surface text-t1 px-2 py-2 text-xs"
                    style={{ textAlign: "center" }}
                  >
                    學習安排
                  </th>
                  <th
                    scope="col"
                    className="border border-themed bg-surface text-t1 px-2 py-2 text-xs"
                    style={{ width: "16%", textAlign: "center" }}
                  >
                    場地
                  </th>
                </tr>
              </thead>
              {plan.weeks.map((week) => {
                const weekReview = review?.weekNotes?.find((item) => item.week === week.week);
                // 日期／節次由目前學期的節次行程推算，僅適用於本學期的計畫
                const showSchedule = plan.period === currentPeriod;
                const slots = showSchedule ? weekScheduleByNo.get(week.week)?.slots ?? [] : [];
                const dateText = slots
                  .map((slot) => `${monthDayText(slot.date)} ${WEEKDAY_LABELS[slot.day - 1]}`)
                  .join("、");
                const periodText = slots.flatMap((slot) => slot.periods).join("、");
                // 執行成果紀錄：計畫通過後，該週規劃時間過了才開放，並受成果撰寫截止時間限制
                const info = recordInfoOf(plan);
                const weekOpen = info.weekOpen(week.week);
                const canEditRecord =
                  isFormalPlan(plan) &&
                  plan.period === currentPeriod &&
                  weekOpen &&
                  info.withinDeadline;
                const savedRecord =
                  plan.executionRecords.find((item) => item.week === week.week)?.note ?? "";
                return (
                  <tbody key={week.week}>
                    <tr>
                      <td className="border border-themed px-2 py-2 align-middle text-xs">
                        <div className="text-t1 font-medium whitespace-nowrap">
                          第 {week.week} 週
                        </div>
                        <div className="text-t3 whitespace-nowrap">
                          {TIMING_SHORT_LABELS[week.timing] ?? PLAN_TIMING_LABELS[week.timing]}
                        </div>
                        {showSchedule && (
                          <>
                            <div className="text-t2 whitespace-nowrap">{dateText || "—"}</div>
                            <div className="text-t2 whitespace-nowrap">{periodText || "—"}</div>
                          </>
                        )}
                      </td>
                      <td className="border border-themed px-2 py-2 align-top">
                        <RichTextContent html={week.content} />
                      </td>
                      <td className="border border-themed text-t2 px-2 py-2 align-top text-xs">
                        {week.venue || "—"}
                      </td>
                    </tr>
                    {isFormalPlan(plan) && plan.period === currentPeriod && (
                      <tr>
                        <td colSpan={3} className="border border-themed bg-surface px-2 py-2">
                          <details open={recordsExpanded}>
                            <summary className="border-themed bg-card text-t1 flex cursor-pointer flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold">
                              {/* 狀態圖示：未開放＝時鐘、已截止＝驚嘆號、已填寫＝勾選圈、未填寫＝鉛筆 */}
                              {!weekOpen ? (
                                <svg className="text-t3 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <circle cx="12" cy="12" r="8.25" />
                                  <path d="M12 7.5V12l2.75 1.75" />
                                </svg>
                              ) : !info.withinDeadline ? (
                                <svg className="text-danger h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <circle cx="12" cy="12" r="8.25" />
                                  <path d="M12 7.75v4.5" />
                                  <path d="M12 15.75h.01" />
                                </svg>
                              ) : savedRecord ? (
                                <svg className="text-success h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                                </svg>
                              ) : (
                                <svg className="text-warning h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="m16.86 4.49 2.65 2.65a1.5 1.5 0 0 1 0 2.12L9.4 19.37a2.25 2.25 0 0 1-1.06.58l-3.2.69a.75.75 0 0 1-.9-.9l.69-3.2c.08-.4.28-.77.58-1.06L15.68 4.49a1.5 1.5 0 0 1 2.12 0Z" />
                                  <path d="m14.25 6.75 3 3" />
                                </svg>
                              )}
                              <span>第 {week.week} 週執行成果紀錄</span>
                              {!weekOpen && (
                                <span className="text-t3 text-xs font-normal">
                                  {info.openAtOf(week.week) > 0
                                    ? `${formatShortDateTime(info.openAtOf(week.week))} 後開放`
                                    : "尚未開放"}
                                </span>
                              )}
                              {weekOpen && !info.withinDeadline && (
                                <span className="text-danger text-xs font-normal">
                                  已超過撰寫截止時間
                                </span>
                              )}
                              {weekOpen && info.withinDeadline && (
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-xs font-normal ${
                                    savedRecord ? "border-success text-success" : "border-warning text-warning"
                                  }`}
                                >
                                  {savedRecord ? "已填寫" : "未填寫"}
                                </span>
                              )}
                              <span className="text-t3 ml-auto flex items-center gap-1 text-xs font-normal">
                                {canEditRecord && !savedRecord ? "點此填寫" : ""}
                                <DisclosureArrow />
                              </span>
                            </summary>
                            <div className="mt-2">
                              {canEditRecord ? (
                                <RichTextEditor
                                  value={recordValueOf(plan, week.week)}
                                  onChange={(value) => setRecordValue(plan, week.week, value)}
                                  maxLength={2000}
                                  placeholder="寫下這一週實際執行的成果（學習內容、遇到的狀況、收穫…）"
                                  ariaLabel={`第 ${week.week} 週執行成果紀錄`}
                                />
                              ) : weekOpen ? (
                                <RichTextContent
                                  html={savedRecord}
                                  emptyText="（未填寫）"
                                  className="text-t2 text-xs"
                                />
                              ) : (
                                <p className="text-t3 text-xs">
                                  這一週的規劃時間還沒到，時間過了之後才能填寫執行成果紀錄。
                                </p>
                              )}
                            </div>
                          </details>
                        </td>
                      </tr>
                    )}
                    {weekReview && (
                      <tr>
                        <td colSpan={3} className="border border-themed bg-surface px-2 py-2">
                          <p className="text-t1 text-xs font-medium">
                            第 {week.week} 週審查意見
                          </p>
                          <RichTextContent
                            html={weekReview.note}
                            className="text-t2 mt-1 text-xs"
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
            </table>
          </div>

          {isFormalPlan(plan) && plan.period === currentPeriod && (
            <p className="text-t3 mt-2 text-xs">
              {plan.status !== "approved"
                ? "自行提升的正式計畫不受成果撰寫截止時間限制；每一週仍需等該週規劃時間過了才能填寫。"
                : recordInfoOf(plan).deadlineAt !== null
                  ? `執行成果紀錄撰寫截止：${formatDateTime(recordInfoOf(plan).deadlineAt as number)}；每一週需等該週規劃時間過了才能填寫。`
                  : "學校尚未設定成果撰寫截止時間：目前不限制填寫期限（每一週仍需等該週規劃時間過了才能填寫）。"}
            </p>
          )}

          {isFormalPlan(plan) && plan.period === currentPeriod && plan.weeks.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-t1 text-xs font-medium">學習反思心得</p>
              <div className="border border-themed bg-card rounded-md p-3">
                {recordInfoOf(plan).reflectionOpen && recordInfoOf(plan).withinDeadline ? (
                  <RichTextEditor
                    value={reflectionValueOf(plan)}
                    onChange={(value) => setReflectionValue(plan, value)}
                    maxLength={2000}
                    placeholder="寫下這學期自主學習的收穫與反思…"
                    ariaLabel="學習反思心得"
                  />
                ) : recordInfoOf(plan).reflectionOpen ? (
                  <RichTextContent
                    html={plan.reflection}
                    emptyText="（未填寫）"
                    className="text-t2 text-xs"
                  />
                ) : (
                  <p className="text-t3 text-xs">
                    {recordInfoOf(plan).reflectionOpenAt > 0
                      ? `${formatShortDate(recordInfoOf(plan).reflectionOpenAt + 1)} 起開放（最後一週結束後）`
                      : "尚未開放"}
                  </p>
                )}
              </div>
            </div>
          )}

          {showRecordActions && recordActionButtons(plan)}
        </details>
      </article>
    );
  };

  const renderEmptyState = (text: string, hint?: string) => (
    <div className="border border-themed bg-surface rounded-lg px-4 py-6 text-center">
      <p className="text-t3 text-sm">{text}</p>
      {hint && <p className="text-t3 mt-1 text-xs">{hint}</p>}
    </div>
  );

  const renderPlanGroup = (
    title: string,
    items: SelfDirectedLearningPlan[],
    options: {
      editable?: boolean;
      trashable?: boolean;
      restorable?: boolean;
      withdrawable?: boolean;
      promotable?: boolean;
    },
    emptyText: string
  ) => (
    <div className="space-y-2">
      <h3 className="text-t2 text-sm font-medium">
        {title}（{items.length}）
      </h3>
      {items.length === 0
        ? renderEmptyState(emptyText)
        : items.map((plan) => renderPlanCard(plan, options))}
    </div>
  );

  // 總開關關閉：只見維護說明（資料不呈現、表單不開放）
  if (!loading && maintenance) {
    return renderShell(
      <div className="border-themed bg-card space-y-2 rounded-lg p-6 text-center">
        <p className="text-t1 text-lg font-medium">{MAINTENANCE_TITLE}</p>
        <p className="text-t2 text-sm">{MAINTENANCE_HINT}</p>
      </div>
    );
  }

  return renderShell(
    <>
      {stripHtmlToText(settings.instructions).trim() && (
        <div className="overflow-hidden rounded-lg border border-themed bg-card shadow-sm">
          <div className="bg-primary" style={{ height: "0.25rem" }} />
          <details
            open={instructionsOpen && !formOpen}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setInstructionsOpen(open);
            }}
          >
            <summary className="text-t1 border-themed bg-surface flex cursor-pointer items-start justify-between gap-3 border-b px-5 py-4">
              <span className="flex items-start gap-3">
                <span className="text-primary mt-0.5">
                  <InfoIcon />
                </span>
                <span>
                  <span className="block text-base font-semibold">自主學習實施說明</span>
                  <span className="text-t3 mt-0.5 block text-xs">撰寫前請先閱讀（點擊可收合）</span>
                </span>
              </span>
              <DisclosureArrow />
            </summary>
            <div className="px-5 py-4">
              <RichTextContent html={settings.instructions} className="text-t2 text-sm" />
            </div>
          </details>
        </div>
      )}

      <section
        className="overflow-hidden rounded-lg border border-themed bg-card shadow-sm"
        aria-label="我的計畫"
      >
        <div className="bg-primary" style={{ height: "0.25rem" }} />
        <div className="border-themed bg-surface border-b">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="border-themed bg-card text-primary flex h-10 w-10 items-center justify-center rounded-lg border">
                <FolderTabIcon />
              </span>
              <div>
                <h2 className="text-t1 text-lg font-semibold">我的計畫</h2>
                <p className="text-t3 mt-0.5 text-xs">文件匣、草稿匣與垃圾桶</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canStartNew && (
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-2 rounded px-4 py-2.5 text-sm font-medium shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={startNewPlan}
                  disabled={draftLimitReached}
                  title={
                    draftLimitReached
                      ? `草稿匣已達上限（${settings.maxDrafts} 件，含退回修改）`
                      : "建立新的自主學習計畫草稿"
                  }
                >
                  <svg
                    className="h-4 w-4 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  發想新計畫
                </button>
              )}
            </div>
          </div>
          <div
            className="border-themed flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3"
            style={
              windowState === "open"
                ? {
                    backgroundColor: "color-mix(in srgb, var(--success) 10%, var(--card))",
                    borderColor: "color-mix(in srgb, var(--success) 35%, var(--bd))",
                  }
                : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: windowTone }}
                aria-hidden="true"
              />
              <span
                className={`text-sm font-semibold ${
                  windowState === "open"
                    ? "text-success"
                    : windowState === "ended"
                      ? "text-warning"
                      : "text-t2"
                }`}
              >
                {WINDOW_LABEL[windowState]}
              </span>
              <span className="text-t3 text-xs">
                {settings.openAt !== null || settings.closeAt !== null
                  ? `送審期間：${formatDateTime(settings.openAt)} ～ ${formatDateTime(settings.closeAt)}`
                  : "送審期間尚未設定"}
              </span>
              {(settings.reviewStartAt !== null || settings.reviewEndAt !== null) && (
                <span className="text-t3 text-xs">
                  審核期間：{formatDateTime(settings.reviewStartAt)} ～{" "}
                  {formatDateTime(settings.reviewEndAt)}
                </span>
              )}
            </div>
            <ul className="text-t3 list-disc space-y-0.5 pl-4 text-xs">
              <li>
                草稿可慢慢寫，完成後再轉為「正式計畫」；學校審核通過的正式計畫，每學期僅 1 份。
              </li>
              <li>
                正式計畫須等該週結束後才能寫「執行成果紀錄」，全部週次結束後才能寫「學習反思心得」。
              </li>
              <li>
                每學期僅能送審 1 份，送出後只能重送同一份
                {settings.minApprovedPlans > 0
                  ? `；就學期間至少需 ${settings.minApprovedPlans} 份經學校審查通過`
                  : ""}
                ；送審須在公告期間內。
              </li>
              {draftLimitReached && (
                <li className="text-danger">
                  草稿匣已滿（{settings.maxDrafts} 件），請先刪除不需要的草稿。
                </li>
              )}
            </ul>
          </div>
        </div>

        <div className="space-y-4 p-5">
          <div
            role="tablist"
            aria-label="我的計畫分類"
            className="border-themed flex flex-wrap gap-1 border-b"
          >
            {[
              { key: "documents" as const, label: "文件匣", icon: <FolderTabIcon /> },
              { key: "drafts" as const, label: "草稿匣", icon: <DraftTabIcon /> },
              { key: "trash" as const, label: "垃圾桶", icon: <TrashTabIcon /> },
            ].map((tab) => {
              const active = planTab === tab.key;
              const count =
                tab.key === "documents"
                  ? documentCount
                  : tab.key === "drafts"
                    ? draftCount
                    : trashedPlans.length;
              const hint =
                tab.key === "documents"
                  ? `文件匣：正式與審核中的計畫，上限 ${settings.maxDocumentPlans} 份（學校設定）`
                  : tab.key === "drafts"
                    ? `草稿匣：草稿與退回修改，上限 ${settings.maxDrafts} 份（學校設定）`
                    : `垃圾桶：最多保留 ${TRASH_RETENTION_DAYS} 天，逾期自動刪除`;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm ${
                    active
                      ? "border-primary text-t1 font-medium"
                      : "text-t2 border-transparent hover:text-t1"
                  }`}
                  style={active ? { borderBottomColor: "var(--primary)" } : undefined}
                  title={hint}
                  onClick={() => setPlanTab(tab.key)}
                >
                  <span className={active ? "text-primary" : "text-t3"}>{tab.icon}</span>
                  {tab.label}
                  <span className="text-t3 text-xs">{count}</span>
                </button>
              );
            })}
          </div>
          <p className="text-t3 text-xs">
            文件匣、草稿匣的可保存份數為 文件匣 {settings.maxDocumentPlans} 份、草稿匣{" "}
            {settings.maxDrafts} 份；垃圾桶最多保留 {TRASH_RETENTION_DAYS} 天，逾期自動刪除。
          </p>

          {planTab === "documents" &&
            (documentCount === 0 ? (
              renderEmptyState("文件匣目前是空的。", "送出審核或提升為正式後，計畫會出現在這裡。")
            ) : (
              <div className="space-y-5">
                {approvedPlans.length > 0 &&
                  renderPlanGroup("正式計畫（學校通過）", approvedPlans, {}, "")}
                {selfPromotedPlans.length > 0 &&
                  renderPlanGroup(
                    "正式計畫（自行提升）",
                    selfPromotedPlans,
                    { editable: !formOpen, trashable: !formOpen },
                    ""
                  )}
                {submittedPlans.length > 0 &&
                  renderPlanGroup("審核中", submittedPlans, { withdrawable: withinWindow, promotable: !formOpen }, "")}
              </div>
            ))}

          {planTab === "drafts" &&
            (draftCount === 0 ? (
              renderEmptyState("草稿匣目前是空的。", "按「發想新計畫」開始撰寫。")
            ) : (
              <div className="space-y-5">
                {draftPlans.length > 0 &&
                  renderPlanGroup("草稿", draftPlans, { editable: !formOpen, trashable: !formOpen, promotable: !formOpen }, "")}
                {returnedPlans.length > 0 &&
                  renderPlanGroup(
                    "退回修改",
                    returnedPlans,
                    { editable: !formOpen, trashable: !formOpen, promotable: !formOpen },
                    ""
                  )}
              </div>
            ))}

          {planTab === "trash" &&
            (trashedPlans.length === 0
              ? renderEmptyState(
                  "垃圾桶是空的。",
                  "移至垃圾桶的草稿會保留在這裡，可隨時還原。"
                )
              : renderPlanGroup("已移至垃圾桶", trashedPlans, { restorable: true }, ""))}
        </div>
      </section>

      {formOpen && (
        <section
          ref={formSectionRef}
          className="overflow-hidden rounded-lg border border-themed bg-card shadow-sm"
          aria-label="撰寫計畫"
        >
          <div className="bg-primary" style={{ height: "0.25rem" }} />
          <div className="border-themed bg-surface border-b px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="border-themed bg-card text-primary flex h-10 w-10 items-center justify-center rounded-lg border">
                  <PencilIcon />
                </span>
                <div>
                  <h2 className="text-t1 text-lg font-semibold">撰寫計畫</h2>
                  <p className="text-t3 mt-0.5 text-xs">
                    {editingPlanId ? "編輯草稿" : "新計畫"}
                    {editingPlan ? `・${periodText(editingPlan.period)}` : ""}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="btn-theme rounded-lg px-4 py-2.5 text-sm"
                onClick={closeForm}
              >
                取消
              </button>
            </div>
          </div>

          <div className="border-themed bg-card border-b px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p
                className={
                  otherApprovedPlan || otherSubmittedPlan || otherEverSubmittedPlan
                    ? "text-danger text-xs"
                    : "text-t3 text-xs"
                }
              >
                {otherApprovedPlan
                  ? "本學期已有通過審核的正式計畫，無法再送出其他計畫（仍可儲存草稿）。"
                  : otherSubmittedPlan
                    ? "本學期已有計畫在審核中：請等待審查結果，或先抽回該計畫後再送出（仍可儲存草稿）。"
                    : otherEverSubmittedPlan
                      ? "本學期只能送審 1 份計畫：請改為編輯已送審的計畫後重新送出（仍可儲存草稿）。"
                      : "表單較長，可隨時儲存草稿或送出審核。"}
              </p>
              <div className="flex w-full flex-wrap justify-end gap-3 sm:w-auto">
                {formActionButtons}
              </div>
            </div>
          </div>

          <div className="space-y-6 p-5">
            {stripHtmlToText(settings.writingInstructions).trim() && (
              <div className="border-themed bg-surface border-l-4 border-l-primary space-y-1 rounded-md border p-4">
                <p className="text-t1 text-sm font-semibold">自主學習計畫撰寫說明</p>
                <RichTextContent html={settings.writingInstructions} className="text-t2 text-sm" />
              </div>
            )}

            <div className="space-y-4">
              <div className="border-themed flex items-center gap-2 border-b pb-2">
                <span className="bg-primary" style={{ width: "0.25rem", height: "1rem" }} />
                <h3 className="text-t1 text-sm font-semibold">計畫內容</h3>
              </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-t2 block space-y-1 text-sm">
                <span>主題 *</span>
                <input
                  type="text"
                  className="input-theme w-full rounded px-3 py-2 text-sm"
                  value={draft.topic}
                  maxLength={100}
                  disabled={locked}
                  onChange={(event) => patchDraft({ topic: event.target.value })}
                  placeholder="如：城市影像的光與構圖"
                />
              </label>
              <div className="space-y-2">
                <label className="text-t2 block space-y-1 text-sm">
                  <span>學群 *</span>
                  <select
                    className="input-theme w-full rounded px-3 py-2 text-sm"
                    value={
                      customStudyGroup
                        ? "__custom__"
                        : (STUDY_GROUPS as readonly string[]).includes(draft.studyGroup)
                          ? draft.studyGroup
                          : ""
                    }
                    disabled={locked}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "__custom__") {
                        setCustomStudyGroup(true);
                        patchDraft({ studyGroup: "" });
                        return;
                      }
                      setCustomStudyGroup(false);
                      patchDraft({ studyGroup: value });
                    }}
                  >
                    <option value="">請選擇學群</option>
                    {STUDY_GROUPS.map((group) => (
                      <option key={group} value={group}>
                        {group}
                      </option>
                    ))}
                    <option value="__custom__">其他（自行填寫）</option>
                  </select>
                </label>
                {customStudyGroup && (
                  <label className="text-t2 block space-y-1 text-sm">
                    <span>學群說明（自行填寫）</span>
                    <input
                      type="text"
                      className="input-theme w-full rounded px-3 py-2 text-sm"
                      value={draft.studyGroup}
                      maxLength={100}
                      disabled={locked}
                      onChange={(event) => patchDraft({ studyGroup: event.target.value })}
                      placeholder="例如：藝術與人文－攝影、跨域專題"
                    />
                  </label>
                )}
                <p className="text-t3 text-xs">
                  可從教育部 18 學群選擇；若主題跨域或沒有適合分類，請選「其他（自行填寫）」。
                </p>
              </div>
            </div>
            <label className="text-t2 block space-y-1 text-sm">
              <span>指導老師（非必填）</span>
              <input
                type="text"
                className="input-theme w-full rounded px-3 py-2 text-sm sm:max-w-md"
                value={draft.advisor}
                maxLength={100}
                disabled={locked}
                onChange={(event) => patchDraft({ advisor: event.target.value })}
                placeholder="如：王老師（校內）／校外相關領域人士"
              />
            </label>

            <div className="space-y-1">
              <span className="text-t2 block text-sm">學習目標 *</span>
              <RichTextEditor
                value={draft.learningGoals}
                onChange={(value) => patchDraft({ learningGoals: value })}
                disabled={locked}
                maxLength={600}
                placeholder="請填寫學習目標…"
                ariaLabel="學習目標"
              />
              <p className="text-t3 text-xs">簡單扼要描述，建議採用條列陳述。</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="border-themed flex flex-wrap items-center justify-between gap-3 border-b pb-2">
              <div className="flex items-center gap-2">
                <span className="bg-primary" style={{ width: "0.25rem", height: "1rem" }} />
                <h3 className="text-t1 text-sm font-semibold">逐週課程安排</h3>
              </div>
              {settings.weekMode === "flexible" ? (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-t2 block space-y-1 text-xs">
                    <span>開始週次</span>
                    <select
                      className="input-theme rounded px-3 py-2 text-sm"
                      value={rangeStart ?? ""}
                      disabled={locked || availableWeekNumbers.length === 0}
                      onChange={(event) => requestRangeChange("start", Number(event.target.value))}
                    >
                      {startOptionNumbers.map((week) => (
                        <option key={week} value={week}>
                          第 {week} 週
                        </option>
                      ))}
                      {rangeStart !== null && !startOptionNumbers.includes(rangeStart) && (
                        <option value={rangeStart}>第 {rangeStart} 週（原填寫）</option>
                      )}
                    </select>
                  </label>
                  <span className="text-t3 pb-2 text-sm">～</span>
                  <label className="text-t2 block space-y-1 text-xs">
                    <span>結束週次</span>
                    <select
                      className="input-theme rounded px-3 py-2 text-sm"
                      value={rangeEnd ?? ""}
                      disabled={locked || availableWeekNumbers.length === 0}
                      onChange={(event) => requestRangeChange("end", Number(event.target.value))}
                    >
                      {availableWeekNumbers
                        .filter((week) => rangeStart === null || week >= rangeStart)
                        .map((week) => (
                          <option key={week} value={week}>
                            第 {week} 週
                          </option>
                        ))}
                      {rangeEnd !== null &&
                        !(
                          availableWeekNumbers.includes(rangeEnd) &&
                          (rangeStart === null || rangeEnd >= rangeStart)
                        ) && (
                          <option value={rangeEnd}>第 {rangeEnd} 週（原填寫）</option>
                        )}
                    </select>
                  </label>
                  <p
                    className={`pb-2 text-xs ${
                      rangeCount < settings.minWeeks ? "text-danger" : "text-t3"
                    }`}
                  >
                    可寫 {rangeCount} 週（下限 {settings.minWeeks} 週）
                  </p>
                </div>
              ) : (
                <p className="text-t2 text-sm">
                  {fullWeeks !== null
                    ? `全學期 ${fullWeeks} 週（空白週數都須填寫；學校活動衝堂週次不列入）`
                    : "全學期形式：學校尚未設定上課日／學期起訖，暫無法判斷週數"}
                </p>
              )}
            </div>

            {settings.weekMode === "flexible" &&
              (availableWeekNumbers.length === 0 ? (
                <p className="text-danger text-xs">
                  目前沒有可寫週次，請確認彈性學習節次與學校活動設定。
                </p>
              ) : rangeCount < settings.minWeeks ? (
                <p className="text-danger text-xs">
                  此區間只有 {rangeCount} 個可寫週次，未達下限 {settings.minWeeks} 週；請調整開始／結束週次（剩餘週次不足的地方不能當開始週次）。
                </p>
              ) : (
                <p className="text-t3 text-xs">
                  已選 {rangeCount} 個可寫週次；送出審核前仍需填寫每一週的學習安排與場地。
                </p>
              ))}

            <ol className="text-t3 list-decimal space-y-1 pl-5 text-xs">
              <li>週次日期依學校學期起訖與彈性學習節次推算。</li>
              <li>與學校活動衝堂的週次會標示活動名稱，不提供撰寫，也不列入必填。</li>
              <li>
                課餘時間另行處理；場地
                {venueEditable
                  ? "可從學校開放的場域清單選擇，或選「其他」自行輸入。"
                  : settings.venues.length > 0
                    ? "請從學校開放的場域清單選擇。"
                    : "尚未設定開放場域，請聯繫管理人員。"}
              </li>
            </ol>

            <div className="border border-themed overflow-x-auto">
              <table
                className="w-full text-left text-sm"
                style={{ minWidth: "40rem" }}
              >
                <thead className="text-t2 bg-surface">
                  <tr className="border-themed border-b">
                    <th
                      scope="col"
                      className="align-top px-2 py-2 font-medium"
                      style={{ width: "7rem" }}
                    >
                      <span className="block">週次</span>
                      <span className="block">日期／節次</span>
                    </th>
                    <th scope="col" className="align-top px-2 py-2 font-medium">
                      學習安排與場地
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {draft.weeks.length === 0 && (
                    <tr>
                      <td colSpan={2} className="text-t3 px-3 py-6 text-center text-sm">
                        目前沒有可寫週次，請調整開始／結束週次。
                      </td>
                    </tr>
                  )}
                  {draft.weeks.map((week, index) => {
                    const scheduleRow = weekScheduleByNo.get(week.week);
                    const slots = scheduleRow?.slots ?? [];
                    const blocked = scheduleRow?.blocked ?? false;
                    const nextWeek = draft.weeks[index + 1];
                    const nextBlocked = nextWeek
                      ? weekScheduleByNo.get(nextWeek.week)?.blocked ?? false
                      : false;
                    const canCopyDown = Boolean(nextWeek) && !blocked && !nextBlocked;
                    const conflictNames = [
                      ...new Set(
                        slots
                          .map((slot) => slot.blockedBy)
                          .filter((name): name is string => Boolean(name))
                      ),
                    ];
                    return (
                      <tr key={week.week} className="border-themed border-b last:border-0 align-top">
                        <td
                          className="align-top px-2 py-3 whitespace-nowrap"
                          style={{ width: "7rem", position: "relative" }}
                        >
                          <div className="text-t1 font-medium">第 {week.week} 週</div>
                          {slots.length === 0 ? (
                            <div className="text-t3 mt-1 text-xs">—</div>
                          ) : (
                            slots.map((slot) => (
                              <div
                                key={`${slot.date}-${slot.day}`}
                                className="text-t2 mt-1 text-xs"
                              >
                                <div>
                                  {monthDayText(slot.date)} {WEEKDAY_LABELS[slot.day - 1]}
                                </div>
                                <div className={slot.blockedBy ? "text-danger" : ""}>
                                  {slot.periods.length > 0 ? (
                                    slot.periods.map((period) => (
                                      <div key={period}>{period}</div>
                                    ))
                                  ) : (
                                    <div>—</div>
                                  )}
                                  {slot.blockedBy && (
                                    <span className="text-danger block">{slot.blockedBy}</span>
                                  )}
                                </div>
                              </div>
                            ))
                          )}
                          {canCopyDown && (
                            <button
                              type="button"
                              onClick={() => copyWeekToNext(index)}
                              title="複製本週場地與學習安排到下一週"
                              aria-label="複製本週場地與學習安排到下一週"
                              className="border-themed bg-surface text-t1 hover:bg-card absolute flex items-center justify-center border"
                              style={{
                                bottom: "0.25rem",
                                left: "0.25rem",
                                width: "2.25rem",
                                height: "2.25rem",
                                borderRadius: 0,
                              }}
                            >
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M12 4v14" />
                                <path d="m6 12 6 6 6-6" />
                              </svg>
                            </button>
                          )}
                        </td>
                        {blocked ? (
                          <td className="align-top px-2 py-3">
                            <p className="text-danger text-sm font-medium">
                              {conflictNames.join("、") || "學校活動"}
                            </p>
                            <p className="text-t3 mt-1 text-xs">
                              本週彈性學習時間為學校活動，不提供撰寫（不列入必填）。
                            </p>
                            {week.content && (
                              <div className="text-t3 mt-1 text-xs">
                                <p>原內容：</p>
                                <RichTextContent html={week.content} className="text-t3 text-xs" />
                              </div>
                            )}
                          </td>
                        ) : (
                          <td className="align-top px-2 py-3" style={{ minWidth: "28rem" }}>
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-t3 text-xs">場地</span>
                                <select
                                  className="input-theme w-auto max-w-full rounded px-3 py-2 text-sm"
                                  style={{ width: "auto", minWidth: "10em", maxWidth: "100%" }}
                                  value={
                                    customVenueWeeks.has(week.week)
                                      ? "__custom__"
                                      : week.venue || ""
                                  }
                                  disabled={locked}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    if (value === "__custom__") {
                                      setCustomVenueWeeks((prev) => new Set(prev).add(week.week));
                                      patchWeek(week.week, { venue: "" });
                                      return;
                                    }
                                    setCustomVenueWeeks((prev) => {
                                      const next = new Set(prev);
                                      next.delete(week.week);
                                      return next;
                                    });
                                    patchWeek(week.week, { venue: value });
                                  }}
                                  aria-label={`第 ${week.week} 週場地`}
                                >
                                  <option value="">請選擇場地</option>
                                  {settings.venues.map((venue) => (
                                    <option key={venue} value={venue}>
                                      {venue}
                                    </option>
                                  ))}
                                  {week.venue &&
                                    !settings.venues.includes(week.venue) &&
                                    !customVenueWeeks.has(week.week) && (
                                      <option value={week.venue}>
                                        {week.venue}（不在開放清單，請重新選擇）
                                      </option>
                                    )}
                                  {venueEditable && (
                                    <option value="__custom__">其他（自行填寫）</option>
                                  )}
                                </select>
                                {venueEditable && customVenueWeeks.has(week.week) && (
                                  <>
                                    <input
                                      type="text"
                                      className="input-theme max-w-full rounded px-3 py-2 text-sm"
                                      style={{
                                        width: `${Math.min(
                                          Math.max((week.venue || "自行輸入場地名稱").length + 4, 12),
                                          32
                                        )}em`,
                                        maxWidth: "100%",
                                      }}
                                      value={week.venue}
                                      maxLength={120}
                                      disabled={locked}
                                      onChange={(event) =>
                                        patchWeek(week.week, { venue: event.target.value })
                                      }
                                      placeholder="請輸入場地名稱"
                                      aria-label={`第 ${week.week} 週自訂場地`}
                                    />
                                    {week.venue === "" && (
                                      <span className="text-t3 text-xs">請填寫場地名稱</span>
                                    )}
                                  </>
                                )}
                              </div>
                              <RichTextEditor
                                value={week.content}
                                onChange={(content) => patchWeek(week.week, { content })}
                                disabled={locked}
                                maxLength={600}
                                placeholder="本週預計學習的內容、進度與方式"
                                ariaLabel={`第 ${week.week} 週學習安排`}
                              />
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

            <div className="border-themed flex flex-wrap justify-end gap-3 border-t pt-4">
              {formActionButtons}
            </div>
          </div>
        </section>
      )}

      {rangeSwap && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg) 75%, transparent)" }}
          role="alertdialog"
          aria-modal="true"
          aria-label="週次順序確認"
        >
          <div className="border-themed bg-card w-full max-w-md rounded-lg border p-5 shadow-lg">
            <p className="text-t1 text-base font-semibold">開始與結束週次相反</p>
            <p className="text-t2 mt-2 text-sm">
              開始週次晚於結束週次。是否自動調換為「第 {rangeSwap.start} 週 ～ 第 {rangeSwap.end} 週」？
            </p>
            <p
              className={`mt-1 text-xs ${
                rangeSwapCount < settings.minWeeks ? "text-danger" : "text-t3"
              }`}
            >
              調換後可寫 {rangeSwapCount} 週（下限 {settings.minWeeks} 週）
              {rangeSwapCount < settings.minWeeks ? "，仍不足下限，送出審核會先被擋下。" : "。"}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-theme px-4 py-2 text-sm"
                onClick={() => setRangeSwap(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                onClick={() => {
                  applyWeekRange(rangeSwap.start, rangeSwap.end);
                  setRangeSwap(null);
                }}
              >
                確認調換
              </button>
            </div>
          </div>
        </div>
      )}

      {withdrawTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg) 75%, transparent)" }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sdl-withdraw-title"
        >
          <div className="border-themed bg-card w-full max-w-md rounded-lg border p-5 shadow-lg">
            <p id="sdl-withdraw-title" className="text-t1 text-base font-semibold">
              抽回這份計畫？
            </p>
            <p className="text-t2 mt-2 text-sm">
              《{withdrawTarget.topic || "（未命名計畫）"}》會從審核佇列抽回並回到草稿匣；
              你可以在送審期間內修改後重新送出。
            </p>
            <p className="text-t3 mt-1 text-xs">
              抽回後審核人員將看不到這份計畫，直到你重新送出審核。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-theme px-4 py-2 text-sm"
                disabled={planBusy !== null}
                onClick={() => setWithdrawTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-theme px-4 py-2 text-sm font-medium"
                style={{
                  backgroundColor: "var(--warning)",
                  borderColor: "var(--warning)",
                  color: "var(--t1)",
                }}
                disabled={planBusy !== null}
                onClick={() => void withdrawPlan(withdrawTarget)}
              >
                {planBusy === withdrawTarget.id ? "抽回中…" : "抽回修改"}
              </button>
            </div>
          </div>
        </div>
      )}

      {promoteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg) 75%, transparent)" }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sdl-promote-title"
        >
          <div className="border-themed bg-card w-full max-w-md rounded-lg border p-5 shadow-lg">
            <p id="sdl-promote-title" className="text-t1 text-base font-semibold">
              提升為正式計畫？
            </p>
            <p className="text-t2 mt-2 text-sm">
              《{promoteTarget.topic || "（未命名計畫）"}》提升後會立即成為正式計畫，
              可以開始按時填寫執行成果紀錄，不必等待學校審核通過。
            </p>
            <p className="text-t3 mt-1 text-xs">
              學校審核仍會保留；之後被退回也不影響已提升的正式狀態。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-theme px-4 py-2 text-sm"
                disabled={planBusy !== null}
                onClick={() => setPromoteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={planBusy !== null}
                onClick={() => void promotePlan(promoteTarget)}
              >
                {planBusy === promoteTarget.id ? "提升中…" : "提升為正式"}
              </button>
            </div>
          </div>
        </div>
      )}

      {promoteBlocked && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg) 75%, transparent)" }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sdl-promote-blocked-title"
        >
          <div className="border-themed bg-card w-full max-w-md rounded-lg border p-5 shadow-lg">
            <p id="sdl-promote-blocked-title" className="text-danger text-base font-semibold">
              尚未填寫完成，無法提升為正式計畫
            </p>
            <p className="text-t2 mt-2 text-sm">
              《{promoteBlocked.planName}》還有下列欄位未填寫：
            </p>
            <ul className="text-t2 mt-2 list-disc space-y-1 pl-5 text-sm">
              {promoteBlocked.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            <p className="text-t3 mt-2 text-xs">請先補齊並儲存後，再提升為正式計畫。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-theme px-4 py-2 text-sm"
                onClick={() => setPromoteBlocked(null)}
              >
                知道了
              </button>
              {promoteBlockedPlan && promoteBlockedPlan.id !== editingPlanId && (
                <button
                  type="button"
                  className="btn-primary px-4 py-2 text-sm"
                  onClick={() => {
                    const plan = promoteBlockedPlan;
                    setPromoteBlocked(null);
                    startEditPlan(plan);
                  }}
                >
                  前往編輯
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {purgeTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg) 75%, transparent)" }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sdl-purge-title"
        >
          <div className="border-themed bg-card w-full max-w-md rounded-lg border p-5 shadow-lg">
            <p id="sdl-purge-title" className="text-t1 text-base font-semibold">
              永久刪除這份計畫？
            </p>
            <p className="text-t2 mt-2 text-sm">
              《{purgeTarget.topic || "（未命名計畫）"}》將從垃圾桶永久刪除，
              包含計畫內容與相關審查紀錄，<strong>無法復原</strong>。
            </p>
            <p className="text-danger mt-1 text-xs">確定要永久刪除嗎？</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-theme px-4 py-2 text-sm"
                disabled={planBusy !== null}
                onClick={() => setPurgeTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-danger rounded px-4 py-2 text-sm"
                disabled={planBusy !== null}
                onClick={() => void purgePlan(purgeTarget)}
              >
                {planBusy === purgeTarget.id ? "刪除中…" : "永久刪除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {recordPlan && !maintenance && openDetailPlans[recordPlan.id] && (
        <div
          className="flex flex-col gap-2 print:hidden"
          style={{
            position: "fixed",
            left: 0,
            top: formOpen ? "calc(50% + 6.5rem)" : "50%",
            transform: "translateY(-50%)",
            zIndex: 40,
          }}
        >
          <button
            type="button"
            onClick={() => void saveRecords(recordPlan)}
            title="儲存執行成果紀錄"
            aria-label="儲存執行成果紀錄"
            disabled={!recordCanSave || recordsBusy === recordPlan.id}
            className="border-themed bg-surface text-t1 hover:bg-card flex items-center justify-center border shadow-md disabled:cursor-not-allowed disabled:opacity-50"
            style={{ width: "2.125rem", height: "2.125rem", borderLeftWidth: 0 }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setRecordsExpanded((prev) => !prev)}
            title={recordsExpanded ? "收合執行成果編輯區" : "展開執行成果編輯區"}
            aria-label={recordsExpanded ? "收合執行成果編輯區" : "展開執行成果編輯區"}
            aria-pressed={recordsExpanded}
            className="border-themed bg-surface text-t1 hover:bg-card flex items-center justify-center border shadow-md"
            style={{ width: "2.125rem", height: "2.125rem", borderLeftWidth: 0 }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m7 15 5 5 5-5" />
              <path d="m7 9 5-5 5 5" />
            </svg>
          </button>
        </div>
      )}

      {formOpen && (
        <div
          className="flex flex-col gap-2"
          style={{
            position: "fixed",
            left: 0,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 40,
          }}
        >
          <button
            type="button"
            onClick={() => void submit("save")}
            title="儲存草稿"
            aria-label="儲存草稿"
            disabled={locked || saving !== null || loading}
            className="border-themed bg-surface text-t1 hover:bg-card flex items-center justify-center border shadow-md disabled:cursor-not-allowed disabled:opacity-50"
            style={{ width: "2.125rem", height: "2.125rem", borderLeftWidth: 0 }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
              <path d="M17 21v-8H7v8M7 3v5h8" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => openPrintPreview()}
            title="列印預覽（新分頁）"
            aria-label="在新分頁預覽列印"
            className="border-themed bg-surface text-t1 hover:bg-card flex items-center justify-center border shadow-md"
            style={{ width: "2.125rem", height: "2.125rem", borderLeftWidth: 0 }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9V3h12v6" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" rx="1" />
              <path d="M18 12h.01" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}
