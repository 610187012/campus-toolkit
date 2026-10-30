"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import AdSense from "@/components/AdSense";
import Copyright from "@/components/Copyright";
import Toast, { type ToastMessage } from "@/components/Toast";
import DisclosureArrow from "@/components/DisclosureArrow";
import RevealListCard from "@/components/RevealListCard";
import { useDataSaver } from "@/lib/data-saver";
import { RichTextContent, RichTextEditor } from "../../components/rich-text-editor";
import { fetchSettings } from "@/lib/settings-client";
import { logout } from "@/lib/session";
import { Settings, defaultSettings } from "@/types/settings";
import {
  MAINTENANCE_HINT,
  MAINTENANCE_TITLE,
  PLAN_STATUS_LABELS,
  PLAN_TIMING_LABELS,
  WEEKDAY_LABELS,
  reviewStateOf,
  stripHtmlToText,
  type SelfDirectedLearningPlan,
  type WeekSchedule,
} from "../../types/self-directed-learning";
import SelfDirectedLearningManagerPanel from "../../components/manager-panel";

interface StaffRoles {
  isReviewer: boolean;
  isTutor: boolean;
  classCode: string;
  permissions: string[];
}

type Tab = "review" | "class";

interface PendingReview {
  planId: string;
  action: "approve" | "return";
  topic: string;
}

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

const STATUS_CLASS: Record<string, string> = {
  approved: "text-success",
  returned: "text-danger",
};

const REVIEW_STATE_LABEL: Record<string, string> = {
  unset: "尚未設定審核期限",
  closed: "尚未開始審核",
  open: "審核進行中",
  ended: "已超過審核期限",
};

/** 表格內的時段短標籤（避免窄欄位逐字換行） */
const TIMING_SHORT_LABELS: Record<string, string> = {
  flexible: "彈性學習",
  afterSchool: "課餘",
};

/** 逐週意見的常用罐頭語（5 種；點選後附加到該週意見） */
const WEEK_NOTE_PHRASES = [
  "本週學習安排請再具體一點。",
  "本週場地請依學校開放場域選擇。",
  "本週內容與主題的關聯性不足，請補充。",
  "本週進度請補上可檢核的成果。",
  "本週安排與學校活動衝堂，請調整。",
] as const;

/** 整體意見的常用罐頭語（5 種） */
const OVERALL_NOTE_PHRASES = [
  "請補齊各週的學習安排與場地。",
  "學習目標請具體且可檢核。",
  "請說明預期的學習成果與評量方式。",
  "請確認指導老師與學群是否正確。",
  "請依撰寫說明調整內容格式。",
] as const;

/** 把罐頭語附加到富文本意見（保留原有內容與格式） */
function appendPhrase(current: string, phrase: string): string {
  const base = (current || "").trim();
  if (!base) return `<p>${phrase}</p>`;
  return /<\/?[a-z][^>]*>/i.test(base) ? `${base}<p>${phrase}</p>` : `${base}<br>${phrase}`;
}

/** 常用語下拉：選取後回呼並自動回到提示選項 */
function CannedPhraseSelect({
  phrases,
  onPick,
  label,
}: {
  phrases: readonly string[];
  onPick: (phrase: string) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      title={label}
      className="input-theme text-t2 cursor-pointer rounded px-2 py-1 text-xs"
      defaultValue=""
      onChange={(event) => {
        const value = event.target.value;
        if (!value) return;
        onPick(value);
        event.target.value = "";
      }}
    >
      <option value="">常用語…</option>
      {phrases.map((phrase) => (
        <option key={phrase} value={phrase}>
          {phrase}
        </option>
      ))}
    </select>
  );
}

/** 純前端切片：分頁不增加任何資料庫讀取 */
function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const size = Math.max(1, pageSize);
  const start = (Math.max(1, page) - 1) * size;
  return items.slice(start, start + size);
}

/** 依總筆數與每頁筆數算總頁數（至少 1 頁） */
function totalPagesOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

export default function StaffSelfDirectedLearningPage() {
  const router = useRouter();
  const [systemSettings, setSystemSettings] = useState<Settings>(defaultSettings);
  const [roles, setRoles] = useState<StaffRoles | null>(null);
  const [plans, setPlans] = useState<SelfDirectedLearningPlan[]>([]);
  /** 逐週日期／節次（依學期起訖與節次行程推算；審核表格第一欄顯示用） */
  const [weekSchedule, setWeekSchedule] = useState<WeekSchedule[]>([]);
  const [tab, setTab] = useState<Tab>("review");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** 逐週審查意見（key＝plan id → 週次 → 富文本） */
  const [weekNotes, setWeekNotes] = useState<Record<string, Record<number, string>>>({});
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  /** 總開關關閉：只顯示維護說明 */
  const [maintenance, setMaintenance] = useState(false);
  /** 審核期限（管理員設定；null＝未設定，僅供提示與督促） */
  const [reviewWindow, setReviewWindow] = useState<{
    startAt: number | null;
    endAt: number | null;
  }>({ startAt: null, endAt: null });
  /** 省流開關（啟用時審核佇列預設不載入，先以 count 取得待審件數） */
  const { ready: saverReady, saverOn } = useDataSaver();
  /** 本次停留是否已按下「顯示審核列表」（省流閘門） */
  const [revealed, setRevealed] = useState(false);
  /** 省流閘門的待審件數（count 聚合） */
  const [reviewCount, setReviewCount] = useState(0);
  /** 清單分頁（純前端切片，不增加讀取） */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  /** 週次 → 該週日期／節次（審核表格第一欄顯示用） */
  const weekScheduleByNo = useMemo(
    () => new Map(weekSchedule.map((row) => [row.week, row])),
    [weekSchedule]
  );

  /** 兩種模式共用的頁面資訊（角色、維護旗標、審核期限） */
  const applySharedMeta = useCallback((data: Record<string, unknown>) => {
    setRoles((data.roles as StaffRoles) ?? null);
    setMaintenance(Boolean(data.maintenance));
    const window = data.reviewWindow as { startAt?: unknown; endAt?: unknown } | undefined;
    setReviewWindow({
      startAt: typeof window?.startAt === "number" ? window.startAt : null,
      endAt: typeof window?.endAt === "number" ? window.endAt : null,
    });
  }, []);

  const load = useCallback(
    async (mode: Tab) => {
      try {
        const response = await fetch(
          `/api/staff/self-directed-learning?mode=${mode}`,
          { cache: "no-store" }
        );
        const data = await response.json();
        if (!response.ok || !data.success) {
          const nextRoles = data.roles as StaffRoles | undefined;
          if (nextRoles) applySharedMeta(data as Record<string, unknown>);
          if (nextRoles && !nextRoles.isReviewer && nextRoles.isTutor) {
            // 兼導師但無審核權限：不視為錯誤，改載入「我的班級」
            setTab("class");
            setLoading(true);
            setPage(1);
          } else {
            setToast({ kind: "error", text: data.message || "讀取資料失敗" });
          }
          setPlans([]);
          return;
        }
        applySharedMeta(data as Record<string, unknown>);
        setPlans((data.plans as SelfDirectedLearningPlan[]) || []);
        setWeekSchedule(Array.isArray(data.weekSchedule) ? (data.weekSchedule as WeekSchedule[]) : []);
      } catch {
        setToast({ kind: "error", text: "讀取資料失敗" });
      } finally {
        setLoading(false);
      }
    },
    [applySharedMeta]
  );

  /** 省流模式：只取待審件數（count 聚合，不載入計畫內容） */
  const loadCount = useCallback(async () => {
    try {
      const response = await fetch("/api/staff/self-directed-learning?mode=count", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        const nextRoles = data.roles as StaffRoles | undefined;
        if (nextRoles) applySharedMeta(data as Record<string, unknown>);
        if (nextRoles && !nextRoles.isReviewer && nextRoles.isTutor) {
          setTab("class");
          setLoading(true);
          setPage(1);
        } else {
          setToast({ kind: "error", text: data.message || "讀取資料失敗" });
        }
        setPlans([]);
        return;
      }
      applySharedMeta(data as Record<string, unknown>);
      setReviewCount(typeof data.count === "number" ? data.count : 0);
      setPlans([]);
    } catch {
      setToast({ kind: "error", text: "讀取資料失敗" });
    } finally {
      setLoading(false);
    }
  }, [applySharedMeta]);

  useEffect(() => {
    // 省流開關判定完成前不載入，避免省流模式下白打一發列表請求
    if (!saverReady) return;
    if (tab === "review" && saverOn && !revealed) {
      void loadCount();
      return;
    }
    void load(tab);
  }, [tab, saverReady, saverOn, revealed, load, loadCount]);

  /** 按下「顯示審核列表」：解除省流閘門後才載入計畫內容 */
  const revealList = () => {
    setRevealed(true);
    setLoading(true);
    setPage(1);
  };

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

  const confirmReview = async () => {
    if (!pending) return;
    const reviewedPlanId = pending.planId;
    const planWeekNotes = weekNotes[reviewedPlanId] ?? {};
    setBusy(true);
    try {
      const response = await fetch("/api/staff/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: pending.planId,
          action: pending.action,
          note: notes[pending.planId] || "",
          weekNotes: Object.entries(planWeekNotes).map(([week, note]) => ({
            week: Number(week),
            note,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "審核處理失敗" });
        return;
      }
      setToast({
        kind: "success",
        text: pending.action === "approve" ? "已通過審核" : "已退回並送出意見",
      });
      setPending(null);
      setNotes((prev) => ({ ...prev, [reviewedPlanId]: "" }));
      setWeekNotes((prev) => ({ ...prev, [reviewedPlanId]: {} }));
      await load(tab);
    } catch {
      setToast({ kind: "error", text: "審核處理失敗" });
    } finally {
      setBusy(false);
    }
  };

  const hasAnyRole = Boolean(
    roles?.isReviewer || roles?.isTutor || (roles?.permissions?.length ?? 0) > 0
  );

  /** 審查意見的可見文字（富文本）：退回必填檢查用 */
  const notePlainOf = (planId: string) => stripHtmlToText(notes[planId] || "").trim();
  /** 逐週意見讀寫 */
  const weekNoteOf = (planId: string, week: number) => weekNotes[planId]?.[week] ?? "";
  const setWeekNote = (planId: string, week: number, value: string) => {
    setWeekNotes((prev) => ({
      ...prev,
      [planId]: { ...(prev[planId] ?? {}), [week]: value },
    }));
  };

  const roleSummary = [
    roles?.isReviewer ? "你具有審核資格。" : "",
    roles?.isTutor ? `兼導師班級：${roles.classCode}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  /** 審核期限狀態與剩餘／逾期天數（管理員未設定時不顯示期限壓力） */
  const reviewState = reviewStateOf({
    reviewStartAt: reviewWindow.startAt,
    reviewEndAt: reviewWindow.endAt,
  });
  const reviewRemainingDays =
    reviewWindow.endAt !== null
      ? Math.ceil((reviewWindow.endAt - Date.now()) / 86_400_000)
      : null;
  const reviewOverdueDays =
    reviewWindow.endAt !== null
      ? Math.floor((Date.now() - reviewWindow.endAt) / 86_400_000)
      : null;
  /** 待審件數：省流閘門未解除時用 count 聚合的總數，解除後用目前清單 */
  const pendingCount =
    tab === "review"
      ? saverOn && !revealed
        ? reviewCount
        : plans.length
      : plans.filter((plan) => plan.status === "submitted").length;
  const reviewWindowText =
    reviewWindow.startAt !== null || reviewWindow.endAt !== null
      ? `${formatDateTime(reviewWindow.startAt)} ～ ${formatDateTime(reviewWindow.endAt)}`
      : "管理員尚未設定審核期限";
  const reviewTone =
    reviewState === "ended" && pendingCount > 0
      ? "text-danger"
      : reviewState === "open"
        ? "text-warning"
        : "text-t3";
  /** 清單分頁（純前端切片）：頁碼超出範圍時自動夾回有效頁 */
  const totalPages = totalPagesOf(plans.length, pageSize);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pagedPlans = paginate(plans, safePage, pageSize);

  const actionButtons = (
    <>
      <button
        type="button"
        onClick={() => router.push("/staff")}
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

  /** 頁面外殼：與「升學考試與模擬考校內報名」教職員頁一致（內容顯示區由 inner 帶入） */
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

      <div className="content-width mt-4 mb-6 text-center">
        <h2 className="text-2xl font-bold text-t1">自主學習計畫－審核與檢視</h2>
        {roleSummary && <p className="text-sm text-t2 mt-2">{roleSummary}</p>}
      </div>

      <div className="content-width flex justify-end gap-3 mb-4">{actionButtons}</div>
      <hr className="content-width border-themed mb-4" />

      {/* 被指派管理者：同一頁內提供被授權的管理功能（未被指派者不顯示） */}
      <SelfDirectedLearningManagerPanel />

      <div className="content-width space-y-4 mb-8">{inner}</div>

      <hr className="content-width border-themed mb-4" />
      <div className="content-width flex justify-start gap-3 mb-8">{actionButtons}</div>

      {systemSettings.sponsorAdEnabled && (
        <div className="content-width">
          <AdSense />
        </div>
      )}

      <div className="content-width mt-auto">
        <Copyright mode={systemSettings.copyrightNotice ? "啟用" : "關閉"} />
      </div>
    </div>
  );

  // 總開關關閉：只見維護說明（計畫清單不呈現、審核不開放）
  if (!loading && maintenance) {
    return renderShell(
      <div className="border-themed bg-card space-y-2 rounded-lg p-6 text-center">
        <p className="text-t1 text-lg font-medium">{MAINTENANCE_TITLE}</p>
        <p className="text-t2 text-sm">{MAINTENANCE_HINT}</p>
      </div>
    );
  }

  if (!loading && !hasAnyRole) {
    return renderShell(
      <div className="border-themed bg-card text-t2 rounded-lg p-4 text-sm">
        你的帳號不在本模組的審核人員名單內，也未具兼導師身分。
        若需審核權限，請洽管理員在「管理規則」中加入審核人員名單。
      </div>
    );
  }

  return renderShell(
    <>
      {tab === "review" && !loading && (
        <div
          className="border-themed bg-card space-y-1 rounded-lg border p-4 text-sm"
          style={
            reviewState === "ended" && pendingCount > 0
              ? { borderColor: "color-mix(in srgb, var(--danger) 45%, var(--bd))" }
              : reviewState === "open"
                ? { borderColor: "color-mix(in srgb, var(--warning) 45%, var(--bd))" }
                : undefined
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-t1 font-medium">審核期限</span>
            <span className={`text-xs font-semibold ${reviewTone}`}>
              {REVIEW_STATE_LABEL[reviewState]}
            </span>
            <span className="text-t3 text-xs">{reviewWindowText}</span>
          </div>
          <p className="text-t2 text-xs">
            目前待審 {pendingCount} 件
            {reviewState === "open" && reviewRemainingDays !== null
              ? `；距離審核截止還有 ${Math.max(reviewRemainingDays, 0)} 天，請於期限內完成。`
              : reviewState === "ended"
                ? `；已逾期 ${Math.max(reviewOverdueDays ?? 0, 0)} 天${
                    pendingCount > 0 ? "，請儘速完成審核。" : "，目前已無待審計畫。"
                  }`
                : reviewState === "closed"
                  ? "；審核期限尚未開始。"
                  : "。"}
          </p>
        </div>
      )}

      {loading ? (
        <div className="border border-themed bg-card text-t2 rounded-lg p-4 text-sm">載入中…</div>
      ) : tab === "review" && saverOn && !revealed && reviewCount > 0 ? (
        <div className="border-themed bg-card overflow-hidden rounded-lg border">
          <RevealListCard
            label="審核"
            summary={`目前待審 ${reviewCount} 件`}
            onReveal={revealList}
          />
        </div>
      ) : plans.length === 0 ? (
        <div className="border border-themed bg-card text-t2 rounded-lg p-4 text-sm">
          {tab === "review" ? "目前沒有待審核的計畫。" : "本班目前沒有自主學習計畫資料。"}
        </div>
      ) : (
        <div className="space-y-3">
          {pagedPlans.map((plan) => (
            <article key={plan.id} className="border border-themed bg-card overflow-hidden rounded-lg">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-start justify-between gap-2 p-4">
                  <span className="flex min-w-0 items-start gap-2">
                    <span className="text-t3 mt-0.5 shrink-0">
                      <DisclosureArrow />
                    </span>
                    <span className="min-w-0 space-y-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-t1 font-medium">
                          {plan.classCode || plan.className || "—"} {plan.studentName}
                        </span>
                      </span>
                      <span className="text-t2 block text-sm">
                        {plan.topic} ｜ {plan.studyGroup}
                        {plan.advisor ? ` ｜ 指導老師：${plan.advisor}` : ""}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    <span className={`block ${STATUS_CLASS[plan.status] || "text-t2"}`}>
                      {PLAN_STATUS_LABELS[plan.status]}
                    </span>
                    {plan.selfApprovedAt !== null && plan.status !== "approved" && (
                      <span className="text-success block text-xs">已由學生提升為正式</span>
                    )}
                    <span
                      className={`block ${
                        reviewState === "ended" && plan.status === "submitted"
                          ? "text-danger"
                          : "text-t3"
                      }`}
                    >
                      送出：{formatDateTime(plan.submittedAt)}
                    </span>
                    {plan.status === "submitted" && plan.submittedAt && (
                      <span
                        className={`block ${
                          reviewState === "ended" ? "text-danger" : "text-t3"
                        }`}
                      >
                        已等待{" "}
                        {Math.max(
                          Math.floor((Date.now() - plan.submittedAt) / 86_400_000),
                          0
                        )}{" "}
                        天
                      </span>
                    )}
                  </span>
                </summary>

                <div className="border-themed space-y-3 border-t p-4">
                  <div className="space-y-1">
                    <p className="text-t1 text-xs font-medium">學習目標</p>
                    <div className="border border-themed bg-surface rounded-md p-3">
                      <RichTextContent
                        html={plan.learningGoals}
                        emptyText="（未填寫）"
                        className="text-t2 text-sm"
                      />
                    </div>
                  </div>

                  {/* 主程式 globals.css 的 th 規則未包 @layer，會蓋過 Tailwind 的 text-center，故標題以行內樣式水平置中 */}
                  <div className="overflow-x-auto">
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
                        const scheduleRow = weekScheduleByNo.get(week.week);
                        const slots = scheduleRow?.slots ?? [];
                        const dateText = slots
                          .map((slot) => `${monthDayText(slot.date)} ${WEEKDAY_LABELS[slot.day - 1]}`)
                          .join("、");
                        const periodText = slots.flatMap((slot) => slot.periods).join("、");
                        return (
                          <tbody key={week.week}>
                            <tr>
                              <td className="border border-themed px-2 py-2 align-middle text-xs">
                                <div className="text-t1 font-medium whitespace-nowrap">
                                  第 {week.week} 週
                                </div>
                                <div className="text-t3 whitespace-nowrap">
                                  {TIMING_SHORT_LABELS[week.timing] ??
                                    PLAN_TIMING_LABELS[week.timing]}
                                </div>
                                <div className="text-t2 whitespace-nowrap">{dateText || "—"}</div>
                                <div className="text-t2 whitespace-nowrap">{periodText || "—"}</div>
                              </td>
                              <td className="border border-themed px-2 py-2 align-top">
                                <RichTextContent html={week.content} />
                              </td>
                              <td className="border border-themed text-t2 px-2 py-2 align-top text-xs">
                                {week.venue || "—"}
                              </td>
                            </tr>
                            {roles?.isReviewer && plan.status === "submitted" && (
                              <tr>
                                <td
                                  colSpan={3}
                                  className="border border-themed bg-surface px-2 py-2"
                                >
                                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-t2 text-xs font-medium">
                                      第 {week.week} 週審查意見
                                    </span>
                                    <CannedPhraseSelect
                                      phrases={WEEK_NOTE_PHRASES}
                                      label={`第 ${week.week} 週常用語`}
                                      onPick={(phrase) =>
                                        setWeekNote(
                                          plan.id,
                                          week.week,
                                          appendPhrase(weekNoteOf(plan.id, week.week), phrase)
                                        )
                                      }
                                    />
                                  </div>
                                  <RichTextEditor
                                    compact
                                    value={weekNoteOf(plan.id, week.week)}
                                    onChange={(value) => setWeekNote(plan.id, week.week, value)}
                                    maxLength={1000}
                                    placeholder="本週審查意見…"
                                    ariaLabel={`第 ${week.week} 週審查意見`}
                                  />
                                </td>
                              </tr>
                            )}
                          </tbody>
                        );
                      })}
                    </table>
                  </div>

                  {roles?.isReviewer && plan.status === "submitted" && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-t2 block text-sm">整體審查意見（退回時必填）</span>
                        <CannedPhraseSelect
                          phrases={OVERALL_NOTE_PHRASES}
                          label="整體意見常用語"
                          onPick={(phrase) =>
                            setNotes((prev) => ({
                              ...prev,
                              [plan.id]: appendPhrase(prev[plan.id] || "", phrase),
                            }))
                          }
                        />
                      </div>
                      <RichTextEditor
                        value={notes[plan.id] || ""}
                        onChange={(value) =>
                          setNotes((prev) => ({ ...prev, [plan.id]: value }))
                        }
                        maxLength={1000}
                        placeholder="給學生的整體審查意見…"
                        ariaLabel={`${plan.studentName} 的整體審查意見`}
                      />
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          className="btn-danger h-9 px-4 text-sm"
                          onClick={() =>
                            setPending({ planId: plan.id, action: "return", topic: plan.topic })
                          }
                        >
                          退回修改
                        </button>
                        <button
                          type="button"
                          className="btn-primary h-9 px-4 text-sm"
                          onClick={() =>
                            setPending({ planId: plan.id, action: "approve", topic: plan.topic })
                          }
                        >
                          通過審核
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </details>
            </article>
          ))}

          <div className="text-t2 flex w-full flex-wrap items-center justify-between gap-3 pt-1 text-sm">
            <div className="flex items-center gap-2">
              <label htmlFor="sdl-staff-page-size">每頁</label>
              <select
                id="sdl-staff-page-size"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                className="input-theme cursor-pointer rounded px-2 py-1"
              >
                {[10, 20, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              <span>筆，共 {plans.length} 筆</span>
            </div>
            {totalPages > 1 && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage(1)}
                  disabled={safePage <= 1}
                  className="btn-theme cursor-pointer rounded px-3 py-1 text-xs disabled:opacity-50"
                >
                  第一頁
                </button>
                <button
                  type="button"
                  onClick={() => setPage(safePage - 1)}
                  disabled={safePage <= 1}
                  className="btn-theme cursor-pointer rounded px-3 py-1 text-xs disabled:opacity-50"
                >
                  上一頁
                </button>
                <span>
                  第 {safePage} / {totalPages} 頁
                </span>
                <button
                  type="button"
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= totalPages}
                  className="btn-theme cursor-pointer rounded px-3 py-1 text-xs disabled:opacity-50"
                >
                  下一頁
                </button>
                <button
                  type="button"
                  onClick={() => setPage(totalPages)}
                  disabled={safePage >= totalPages}
                  className="btn-theme cursor-pointer rounded px-3 py-1 text-xs disabled:opacity-50"
                >
                  最後一頁
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.4)] p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sdl-review-confirm-title"
        >
          <div className="border-themed bg-card w-full max-w-md rounded-xl p-5 shadow-lg">
            <h2 id="sdl-review-confirm-title" className="text-t1 mb-2 font-semibold">
              {pending.action === "approve" ? "確認通過審核？" : "確認退回這份計畫？"}
            </h2>
            <p className="text-t2 mb-4 text-sm">
              《{pending.topic}》
              {pending.action === "return" && !notePlainOf(pending.planId)
                ? "　退回必填審查意見，請先於卡片填寫。"
                : ""}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-theme h-9 px-4 text-sm"
                onClick={() => setPending(null)}
              >
                取消
              </button>
              <button
                type="button"
                className={`btn-theme h-9 px-4 text-sm ${
                  pending.action === "approve" ? "btn-primary" : "btn-danger"
                }`}
                disabled={
                  busy ||
                  (pending.action === "return" && !notePlainOf(pending.planId))
                }
                onClick={() => void confirmReview()}
              >
                {busy ? "處理中…" : "確定"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
