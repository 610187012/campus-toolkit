"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AdSense from "@/components/AdSense";
import Copyright from "@/components/Copyright";
import { fetchSettings } from "@/lib/settings-client";
import { logout } from "@/lib/session";
import { Settings, defaultSettings } from "@/types/settings";
import { ConfirmModal } from "../../components/exam-feedback";
import Toast, { type ToastMessage } from "../../components/toast";
import OfficialExamLabel from "../../components/official-exam-label";
import ExamManagerPanel from "../../components/manager-panel";
import {
  EXAM_SERVICE_NOTE_MAX,
  EXAM_CATEGORY_LABELS,
  EXAM_FEE_CODE_LABELS,
  calcExamFee,
  formatExamDate,
  formatExamDateTime,
  formatExamDateRange,
  resolveLocationLabel,
} from "../../types/exam-registration";
import type { ExamFeeCode, StudentExamEvent } from "../../types/exam-registration";

interface ListResponse {
  success?: boolean;
  message?: string;
  events?: StudentExamEvent[];
}

interface MutationResponse {
  success?: boolean;
  message?: string;
}

type SortOrder = "deadline-desc" | "deadline-asc";
const SUBJECT_SELECTED_VALUE = "__selected__";

function formatDeadline(ms: number): string {
  return formatExamDateTime(ms);
}

function formatDateTime(ms: number): string {
  return formatExamDateTime(ms);
}

/**
 * 升學考試與模擬考校內報名（學生端）。
 * M3：必須報名（不報名+原因）、繳費身分＋費用試算、資料封存＋列印報名表。
 */
export default function ExamRegistrationStudentPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [events, setEvents] = useState<StudentExamEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [subjectOptionCodes, setSubjectOptionCodes] = useState<Record<string, Record<string, string>>>({});
  const [optOuts, setOptOuts] = useState<Record<string, boolean>>({});
  const [optOutReasons, setOptOutReasons] = useState<Record<string, string>>({});
  const [feeCodes, setFeeCodes] = useState<Record<string, ExamFeeCode>>({});
  const [nonAirConditionedRooms, setNonAirConditionedRooms] = useState<Record<string, boolean>>({});
  const [examServiceNotes, setExamServiceNotes] = useState<Record<string, string>>({});
  /** 各場次所選考試地點代碼（有選項時） */
  const [locationCodes, setLocationCodes] = useState<Record<string, string>>({});
  /** 列印目標（非 null 時渲染列印版面並觸發 window.print） */
  const [printId, setPrintId] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>("deadline-asc");
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  /** 主題化確認框（取代 window.confirm） */
  const [confirm, setConfirm] = useState<{
    text: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);

  const selectedSubjectKeysByOptionCodes = useCallback((item: StudentExamEvent): string[] => {
    const selectedMap = subjectOptionCodes[item.id] ?? {};
    return item.subjects
      .filter((subject) => {
        const value = selectedMap[subject.key] ?? "";
        return value !== "";
      })
      .map((subject) => subject.key);
  }, [subjectOptionCodes]);

  useEffect(() => {
    if (!printId) return;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => setPrintId(null);
    const timer = setTimeout(() => {
      // 行動裝置（iOS/Android）的列印為非同步：print() 立即返回、頁面快照稍後才取，
      // 若此時卸下列印版面會印成空白——改以 afterprint 事件再卸載。
      window.addEventListener("afterprint", clear, { once: true });
      window.print();
      // 兜底：部分瀏覽器可能不觸發 afterprint，2 分鐘後自動卸載
      fallbackTimer = setTimeout(clear, 120000);
    }, 300);
    return () => {
      clearTimeout(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      window.removeEventListener("afterprint", clear);
    };
  }, [printId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchSettings();
        if (!cancelled && data?.success && data.settings) {
          setSettings({ ...defaultSettings, ...data.settings });
        }
      } catch {
        // 設定讀取失敗時沿用預設值，避免阻斷報名流程
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/exam-registration", { cache: "no-store" });
      const data: ListResponse | null = await res.json().catch(() => null);
      if (data?.success) {
        const list = data.events ?? [];
        setEvents(list);
        setCollapsedMap((prev) =>
          Object.fromEntries(list.map((item) => [item.id, prev[item.id] ?? true]))
        );
        setSubjectOptionCodes(
          Object.fromEntries(
            list.map((item) => [
              item.id,
              Object.fromEntries(
                item.subjects.map((subject) => {
                  const selected = item.mySubjectKeys.includes(subject.key);
                  if (!selected) return [subject.key, ""];
                  const hasAdvancedOptions =
                    subject.enableAdvancedOption === true && (subject.advancedOptions?.length ?? 0) > 0;
                  if (!hasAdvancedOptions) return [subject.key, SUBJECT_SELECTED_VALUE];
                  const code = item.mySubjectAdvancedOptionCodes?.[subject.key] ?? "";
                  return [subject.key, code];
                })
              ) as Record<string, string>,
            ])
          )
        );
        setOptOuts(Object.fromEntries(list.map((item) => [item.id, item.myOptOut])));
        setOptOutReasons(Object.fromEntries(list.map((item) => [item.id, item.myOptOutReason])));
        setFeeCodes(
          Object.fromEntries(list.map((item) => [item.id, item.myFeeCode ?? ("1" as ExamFeeCode)]))
        );
        setNonAirConditionedRooms(
          Object.fromEntries(list.map((item) => [item.id, item.myNonAirConditionedRoom === true]))
        );
        setExamServiceNotes(
          Object.fromEntries(list.map((item) => [item.id, item.myExamServiceNote ?? ""]))
        );
        setLocationCodes(
          Object.fromEntries(
            list.map((item) => [
              item.id,
              item.myLocationCode ||
                item.locationOptions.find((option) => option.isDefault)?.code ||
                item.locationOptions[0]?.code ||
                "",
            ])
          )
        );
      } else {
        setToast({ kind: "error", text: data?.message || "載入失敗" });
      }
    } catch {
      setToast({ kind: "error", text: "載入失敗" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(item: StudentExamEvent) {
    if (savingId) return;
    const optOut = optOuts[item.id] === true;
    const reason = (optOutReasons[item.id] ?? "").trim();
    const examServiceNote = (examServiceNotes[item.id] ?? "").trim();
    if (optOut && item.registrationMode === "required" && !reason) {
      setToast({ kind: "error", text: "勾選不報名時，請說明原因" });
      return;
    }
    if (!optOut && examServiceNote.length > EXAM_SERVICE_NOTE_MAX) {
      setToast({ kind: "error", text: `特殊應考服務需求過長（最多 ${EXAM_SERVICE_NOTE_MAX} 字）` });
      return;
    }
    const keys = selectedSubjectKeysByOptionCodes(item);
    const selectedMap = subjectOptionCodes[item.id] ?? {};
    const subjectAdvancedOptionCodes: Record<string, string> = {};
    for (const subject of item.subjects) {
      const hasAdvancedOptions =
        subject.enableAdvancedOption === true && (subject.advancedOptions?.length ?? 0) > 0;
      if (!hasAdvancedOptions) continue;
      const code = selectedMap[subject.key] ?? "";
      if (!code || code === SUBJECT_SELECTED_VALUE) continue;
      subjectAdvancedOptionCodes[subject.key] = code;
    }
    if (!optOut && !keys.length) {
      setToast({ kind: "error", text: "請至少選擇一個科目" });
      return;
    }
    setSavingId(item.id);
    try {
      const res = await fetch("/api/exam-registration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: item.id,
          subjectKeys: optOut ? [] : keys,
          subjectAdvancedOptionCodes: optOut ? {} : subjectAdvancedOptionCodes,
          optOut,
          optOutReason: reason,
          locationCode: item.locationOptions.length ? (locationCodes[item.id] ?? "") : undefined,
          nonAirConditionedRoom: nonAirConditionedRooms[item.id] === true,
          examServiceNote,
          feeCode: feeCodes[item.id] ?? "1",
        }),
      });
      const data: MutationResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "儲存失敗");
      setToast({ kind: "success", text: data.message || "已儲存" });
      await load();
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "儲存失敗" });
    } finally {
      setSavingId(null);
    }
  }

  function withdraw(item: StudentExamEvent) {
    if (savingId) return;
    setConfirm({
      text: `確定要取消「${item.title}」的報名？\n（可重新登錄）`,
      onConfirm: () => void runWithdraw(item),
    });
  }

  async function runWithdraw(item: StudentExamEvent) {
    setSavingId(item.id);
    try {
      const res = await fetch("/api/exam-registration", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: item.id }),
      });
      const data: MutationResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "取消失敗");
      setToast({ kind: "success", text: data.message || "已取消" });
      await load();
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "取消失敗" });
    } finally {
      setSavingId(null);
    }
  }

  function archive(item: StudentExamEvent) {
    if (savingId) return;
    setConfirm({
      text: `確定要封存「${item.title}」的報名資料？\n封存後不可再修改或取消；如需變更，須請承辦師長解除封存。`,
      confirmLabel: "封存",
      onConfirm: () => void runArchive(item),
    });
  }

  async function runArchive(item: StudentExamEvent) {
    setSavingId(item.id);
    try {
      const res = await fetch("/api/exam-registration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: item.id }),
      });
      const data: MutationResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "封存失敗");
      setToast({ kind: "success", text: data.message || "已封存" });
      await load();
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "封存失敗" });
    } finally {
      setSavingId(null);
    }
  }

  function printForm(item: StudentExamEvent) {
    // 僅在學生「可自行封存」且尚未封存時才提醒——承辦關閉自行封存時
    // 學生無封存鈕可按，跳此訊息只會造成困擾，直接列印。
    if (!item.myArchived && item.studentArchiveEnabled) {
      setConfirm({
        text: "資料尚未封存，下載內容將以目前資料為準。\n建議先行封存後再下載保存。",
        confirmLabel: "仍要下載",
        onConfirm: () => setPrintId(item.id),
      });
      return;
    }
    setPrintId(item.id);
  }

  const printItem = printId ? events.find((item) => item.id === printId) ?? null : null;
  const sortedEvents = useMemo(() => {
    const list = [...events];
    list.sort((a, b) =>
      sortOrder === "deadline-asc" ? a.deadline - b.deadline : b.deadline - a.deadline
    );
    return list;
  }, [events, sortOrder]);
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

  return (
    <div className="min-h-screen flex flex-col items-center bg-page px-4 pt-[20px]">
      <Toast message={toast} onClose={() => setToast(null)} />
      {confirm && (
        <ConfirmModal
          text={confirm.text}
          confirmLabel={confirm.confirmLabel ?? "確定"}
          onConfirm={() => {
            const action = confirm.onConfirm;
            setConfirm(null);
            action();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      <div className="text-center mb-2 print:hidden">
        <h1 className="text-4xl font-bold mb-2">{settings.systemName || "數位校園工具箱"}</h1>
        <p className="text-xl text-t2">{settings.schoolFullName || "學校名稱"}</p>
        <p className="text-lg text-t3">
          {settings.academicYear} 學年度 第{settings.semester}學期
        </p>
      </div>

      <div className="content-width mt-4 mb-2 text-center print:hidden">
        <h2 className="text-2xl font-bold text-t1">升學考試與模擬考校內報名</h2>
      </div>

      <div className="content-width flex justify-end gap-2 mb-4 print:hidden">{actionButtons}</div>
      <hr className="content-width border-themed mb-4 print:hidden" />

      {/* 被指派管理者：同一頁內提供被授權的管理功能（未被指派者不顯示）；此身分的基本功能置於其下方 */}
      <ExamManagerPanel pageHref="/student/exam-registration" />

      <main className="content-width mb-6 space-y-4">
        <div
          role="note"
          className="border border-danger rounded-lg bg-card p-4 text-sm text-danger space-y-1 print:hidden"
        >
          <p className="font-bold">下載報名表說明（已修正）</p>
          <p className="flex gap-1">
            <span className="shrink-0">1.</span>
            <span>手機版下載空白：已修正，手機、電腦皆可正常下載。</span>
          </p>
          <p className="flex gap-1">
            <span className="shrink-0">2.</span>
            <span>封存提醒：僅開放自行封存且未封存時出現，其餘直接下載。</span>
          </p>
        </div>
        <div className="print:hidden">
          {loading ? (
            <p className="p-6 text-center text-t3">場次載入中...</p>
          ) : sortedEvents.length === 0 ? (
            <div className="border border-themed rounded-lg bg-card p-6 text-center text-t3 text-sm">
              目前沒有符合對象的報名場次
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-t2">
                提醒：升學考試報名前，務必先確認基本資料與個人證件照的正確性。
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm text-t2">排序</span>
                <button
                  type="button"
                  onClick={() => setSortOrder("deadline-asc")}
                  className={`rounded px-2.5 py-1 text-xs cursor-pointer ${
                    sortOrder === "deadline-asc" ? "btn-theme" : "btn-soft"
                  }`}
                >
                  時間舊到新
                </button>
                <button
                  type="button"
                  onClick={() => setSortOrder("deadline-desc")}
                  className={`rounded px-2.5 py-1 text-xs cursor-pointer ${
                    sortOrder === "deadline-desc" ? "btn-theme" : "btn-soft"
                  }`}
                >
                  時間新到舊
                </button>
              </div>
              {sortedEvents.map((item) => (
                <ExamEventCard
                  key={item.id}
                  item={item}
                  selected={selectedSubjectKeysByOptionCodes(item)}
                  selectedOptionCodes={subjectOptionCodes[item.id] ?? {}}
                  optOut={optOuts[item.id] === true}
                  optOutReason={optOutReasons[item.id] ?? ""}
                  feeCode={feeCodes[item.id] ?? "1"}
                  locationCode={locationCodes[item.id] ?? ""}
                  nonAirConditionedRoom={nonAirConditionedRooms[item.id] === true}
                  examServiceNote={examServiceNotes[item.id] ?? ""}
                  collapsed={collapsedMap[item.id] ?? true}
                  saving={savingId === item.id}
                  onToggleCollapsed={() =>
                    setCollapsedMap((prev) => ({ ...prev, [item.id]: !(prev[item.id] ?? true) }))
                  }
                  onOptOutChange={(value) => setOptOuts((prev) => ({ ...prev, [item.id]: value }))}
                  onOptOutReasonChange={(value) =>
                    setOptOutReasons((prev) => ({ ...prev, [item.id]: value }))
                  }
                  onFeeCodeChange={(value) => setFeeCodes((prev) => ({ ...prev, [item.id]: value }))}
                  onNonAirConditionedRoomChange={(value) =>
                    setNonAirConditionedRooms((prev) => ({ ...prev, [item.id]: value }))
                  }
                  onExamServiceNoteChange={(value) =>
                    setExamServiceNotes((prev) => ({ ...prev, [item.id]: value }))
                  }
                  onLocationCodeChange={(value) =>
                    setLocationCodes((prev) => ({ ...prev, [item.id]: value }))
                  }
                  onSubjectOptionCodeChange={(subjectKey, value) =>
                    setSubjectOptionCodes((prev) => ({
                      ...prev,
                      [item.id]: {
                        ...(prev[item.id] ?? {}),
                        [subjectKey]: value,
                      },
                    }))
                  }
                  onSave={() => void save(item)}
                  onWithdraw={() => void withdraw(item)}
                  onArchive={() => archive(item)}
                  onPrint={() => printForm(item)}
                />
              ))}
            </div>
          )}
        </div>

        {/* 列印版面（僅 @media print 顯示；瀏覽器另存 PDF） */}
        {printItem && <RegistrationPrintSheet item={printItem} />}
      </main>

      <hr className="content-width border-themed mb-4 print:hidden" />
      <div className="content-width flex justify-start gap-2 mb-4 print:hidden">{actionButtons}</div>

      {settings.sponsorAdEnabled && (
        <div className="content-width mt-8 print:hidden">
          <AdSense />
        </div>
      )}

      <div className="content-width mt-auto print:hidden">
        <Copyright mode={settings.copyrightNotice ? "啟用" : "關閉"} />
      </div>
    </div>
  );
}

function ExamEventCard({
  item,
  selected,
  selectedOptionCodes,
  optOut,
  optOutReason,
  feeCode,
  nonAirConditionedRoom,
  examServiceNote,
  collapsed,
  locationCode,
  saving,
  onToggleCollapsed,
  onOptOutChange,
  onOptOutReasonChange,
  onFeeCodeChange,
  onNonAirConditionedRoomChange,
  onExamServiceNoteChange,
  onLocationCodeChange,
  onSubjectOptionCodeChange,
  onSave,
  onWithdraw,
  onArchive,
  onPrint,
}: {
  item: StudentExamEvent;
  selected: string[];
  selectedOptionCodes: Record<string, string>;
  optOut: boolean;
  optOutReason: string;
  feeCode: ExamFeeCode;
  nonAirConditionedRoom: boolean;
  examServiceNote: string;
  collapsed: boolean;
  locationCode: string;
  saving: boolean;
  onToggleCollapsed: () => void;
  onOptOutChange: (value: boolean) => void;
  onOptOutReasonChange: (value: string) => void;
  onFeeCodeChange: (value: ExamFeeCode) => void;
  onNonAirConditionedRoomChange: (value: boolean) => void;
  onExamServiceNoteChange: (value: string) => void;
  onLocationCodeChange: (value: string) => void;
  onSubjectOptionCodeChange: (subjectKey: string, value: string) => void;
  onSave: () => void;
  onWithdraw: () => void;
  onArchive: () => void;
  onPrint: () => void;
}) {
  const closed = item.status === "closed";
  /** 未到報名開放時間（upcoming）：唯讀、不可送出 */
  const upcoming = item.status === "upcoming";
  const readOnly = closed || upcoming;
  const hasRegistration = item.registeredAt !== null;
  const isRequired = item.registrationMode === "required";
  const archived = item.myArchived;
  const locked = archived;
  const registrationModeText = isRequired ? "必須報名" : "自由報名";
  const registrationStateText = archived
    ? "封存資料"
    : item.myOptOut
      ? "不報名"
      : hasRegistration
        ? "完成報名"
        : "未報名";

  const feeAmount = useMemo(() => {
    if (optOut) return 0;
    return calcExamFee(item, selected, feeCode);
  }, [item, selected, feeCode, optOut]);

  const hasAnyFee =
    item.basicFee.standard > 0 ||
    item.basicFee.reduced > 0 ||
    item.subjects.some((subject) => (subject.feeStandard ?? 0) > 0 || (subject.feeReduced ?? 0) > 0);

  return (
    <section className="border border-themed rounded-lg bg-card p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-t1">
              {item.title}
              <OfficialExamLabel title={item.title} />
            </h2>
            <span
              className={`text-[11px] px-2 py-0.5 rounded border ${
                isRequired ? "border-danger text-danger" : "border-themed text-t2"
              }`}
            >
              {registrationModeText}
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded border border-themed text-t2">
              {registrationStateText}
            </span>
          </div>
          <p className="text-xs text-t3 mt-0.5">
            報名期間：
            {item.registrationOpenAt
              ? `${formatDateTime(item.registrationOpenAt)} ~ ${formatDeadline(item.deadline)}`
              : `至 ${formatDeadline(item.deadline)}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            className="btn-soft rounded px-2 py-0.5 text-xs cursor-pointer"
            onClick={onToggleCollapsed}
          >
            {collapsed ? "展開" : "收合"}
          </button>
          {upcoming ? (
            <span className="text-xs shrink-0 text-t2">
              {item.registrationOpenAt
                ? `${formatDateTime(item.registrationOpenAt)} 開放`
                : "尚未開放"}
            </span>
          ) : (
            <span className={`text-xs shrink-0 ${closed ? "text-t3" : "text-success"}`}>
              {closed ? "已截止（唯讀）" : "開放報名中"}
            </span>
          )}
          {archived && <span className="text-xs shrink-0 text-t2">已封存（唯讀）</span>}
        </div>
      </div>
      {collapsed ? null : (
        <>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-t3 shrink-0">考試日期</dt>
          <dd className="text-t1">
            {item.examEndDate && item.examEndDate !== item.examDate ? (
              <span className="inline-flex flex-col">
                <span>{formatExamDate(item.examDate)}</span>
                <span>{formatExamDate(item.examEndDate)}</span>
              </span>
            ) : (
              formatExamDateRange(item)
            )}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-t3 shrink-0">報名期間</dt>
          <dd className="text-t1">
            {item.registrationOpenAt ? (
              <span className="inline-flex flex-col">
                <span>{formatDateTime(item.registrationOpenAt)}</span>
                <span>{formatDeadline(item.deadline)}</span>
              </span>
            ) : (
              `至 ${formatDeadline(item.deadline)}`
            )}
          </dd>
        </div>
        {hasAnyFee && (
          <div className="flex gap-2 sm:col-span-2">
            <dt className="text-t3 shrink-0">基本費用</dt>
            <dd className="text-t1">
              一般生 {item.basicFee.standard} 元／中低收入戶 {item.basicFee.reduced} 元（低收入戶免繳）
            </dd>
          </div>
        )}

      </dl>

      {item.note && <p className="text-sm text-t2 whitespace-pre-line">{item.note}</p>}

      {isRequired && !hasRegistration && !readOnly && (
        <p className="text-sm rounded border px-3 py-2" style={{ borderColor: "var(--warning)", color: "var(--warning)" }}>
          本場次為「必須報名」——請完成科目登錄，或勾選不報名並說明原因。
        </p>
      )}

      {archived ? (
        <div className="rounded border border-themed bg-themed px-3 py-2 text-sm text-t1">
          資料已封存（{item.myOptOut ? "不報名" : `已登錄 ${item.mySubjectKeys.length} 項科目`}）
          {!item.myOptOut && item.locationOptions.length > 0 && item.myLocationCode
            ? `・${resolveLocationLabel(item.locationOptions, item.myLocationCode)}`
            : ""}
          {item.registeredAt ? `・封存於 ${formatDateTime(item.registeredAt)}` : ""}
          ——不可再修改；如需變更請聯繫承辦師長解除封存。
        </div>
      ) : (
        <>
          {/* 考試地點（僅升學考試；左右兩欄） */}
          {item.examType === "entrance" && (
            <div className={`flex flex-col sm:flex-row sm:items-start gap-2 ${optOut ? "opacity-40 pointer-events-none" : ""}`}>
              <p className="text-sm text-t2 sm:w-20 shrink-0">考試地點</p>
              <div className="flex-1">
                {item.locationOptions.length > 0 ? (
                  <select
                    className="input-theme rounded px-3 py-2 text-sm w-full sm:w-72"
                    value={locationCode}
                    disabled={readOnly || optOut || saving}
                    onChange={(e) => onLocationCodeChange(e.target.value)}
                  >
                    {item.locationOptions.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-sm text-t3 py-1">試場由主辦單位分配</p>
                )}
              </div>
            </div>
          )}

          {/* 繳費身分（有設定費用時才顯示；左右兩欄） */}
          {hasAnyFee && (
            <div className="flex flex-col sm:flex-row sm:items-start gap-2">
              <p className="text-sm text-t2 sm:w-20 shrink-0">繳費身分</p>
              <div className="flex-1 flex flex-wrap gap-x-4 gap-y-1">
                {(Object.keys(EXAM_FEE_CODE_LABELS) as ExamFeeCode[]).map((code) => (
                  <label key={code} className="inline-flex items-center gap-1.5 text-sm text-t1 cursor-pointer">
                    <input
                      type="radio"
                      name={`fee-${item.id}`}
                      checked={feeCode === code}
                      disabled={readOnly || saving}
                      onChange={() => onFeeCodeChange(code)}
                    />
                    {EXAM_FEE_CODE_LABELS[code]}
                    {code === "2" && <span className="text-xs text-t3">（免繳）</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className={`flex flex-col sm:flex-row sm:items-start gap-2 ${optOut ? "opacity-40 pointer-events-none" : ""}`}>
            <p className="text-sm text-t2 sm:w-20 shrink-0">科目名稱</p>
            <div className="flex-1 space-y-2">
              {item.subjects.map((subject) => {
                const mine = selected.includes(subject.key);
                const subjFee = feeCode === "1" ? subject.feeStandard ?? 0 : feeCode === "3" ? subject.feeReduced ?? 0 : 0;
                const lockedSubj = readOnly || saving;
                const hasAdvancedOptions =
                  subject.enableAdvancedOption === true && (subject.advancedOptions?.length ?? 0) > 0;
                const selectedValue = selectedOptionCodes[subject.key] ?? "";
                return (
                  <div
                    key={subject.key}
                    className={`flex flex-col sm:flex-row sm:items-center gap-2 ${
                      lockedSubj ? "text-t3" : "text-t1"
                    }`}
                  >
                    <div className="text-sm sm:w-48">
                      <span>{subject.label}</span>
                      {subjFee > 0 && <span className="text-xs text-t3">（{subjFee} 元）</span>}
                    </div>
                    {hasAdvancedOptions ? (
                      <select
                        className="input-theme rounded px-3 py-2 text-sm w-full sm:w-72"
                        value={selectedValue}
                        disabled={lockedSubj}
                        onChange={(e) => onSubjectOptionCodeChange(subject.key, e.target.value)}
                      >
                        <option value="">不報考</option>
                        {(subject.advancedOptions ?? []).map((option) => (
                          <option key={option.code} value={option.code}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <label
                        className={`inline-flex items-center gap-1.5 text-sm ${
                          lockedSubj ? "text-t3 cursor-not-allowed" : "text-t1 cursor-pointer"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={mine}
                          disabled={lockedSubj}
                          onChange={(e) =>
                            onSubjectOptionCodeChange(
                              subject.key,
                              e.target.checked ? SUBJECT_SELECTED_VALUE : ""
                            )
                          }
                        />
                        報考
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`flex flex-col sm:flex-row sm:items-start gap-2 ${optOut ? "opacity-40 pointer-events-none" : ""}`}>
            <p className="text-sm text-t2 sm:w-20 shrink-0">應考服務</p>
            <div className="flex-1 space-y-1.5">
              <label className="inline-flex items-center gap-1.5 text-sm text-t1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={nonAirConditionedRoom}
                  disabled={readOnly || saving || optOut}
                  onChange={(e) => onNonAirConditionedRoomChange(e.target.checked)}
                />
                非冷氣試場
              </label>
              <input
                className="w-full input-theme rounded px-3 py-2 text-sm"
                value={examServiceNote}
                maxLength={EXAM_SERVICE_NOTE_MAX}
                disabled={readOnly || saving || optOut}
                onChange={(e) => onExamServiceNoteChange(e.target.value)}
                placeholder="有特殊應考服務需求時，填寫後請親洽承辦師長"
              />
            </div>
          </div>

          {/* 不報名（僅必須報名場次） */}
          {isRequired && (
            <div className="space-y-1.5 border-t border-themed pt-2">
              <label className="inline-flex items-center gap-1.5 text-sm text-t1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={optOut}
                  disabled={readOnly || saving}
                  onChange={(e) => onOptOutChange(e.target.checked)}
                />
                不報名
              </label>
              {optOut && (
                <input
                  className="w-full input-theme rounded px-3 py-2 text-sm"
                  placeholder="請說明不報名的原因"
                  value={optOutReason}
                  maxLength={200}
                  disabled={readOnly || saving}
                  onChange={(e) => onOptOutReasonChange(e.target.value)}
                />
              )}
            </div>
          )}

          {/* 應繳費用 */}
          {hasAnyFee && (
            <p className="text-sm text-t2">
              應繳費用：
              <span className="text-base font-bold text-t1 ml-1">{feeAmount} 元</span>
              {optOut && <span className="text-xs text-t3">（不報名免繳）</span>}
              {feeCode === "2" && !optOut && <span className="text-xs text-t3">（低收入戶免繳）</span>}
            </p>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {!readOnly && !archived && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
          >
            {saving ? "儲存中..." : optOut ? "送出不報名" : hasRegistration ? "更新報名資料" : "送出登錄"}
          </button>
        )}
        {hasRegistration && !readOnly && !archived && (
          <button
            type="button"
            onClick={onWithdraw}
            disabled={saving}
            className="btn-soft rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
          >
            取消報名
          </button>
        )}
        {hasRegistration && item.studentArchiveEnabled && !archived && (
          <button
            type="button"
            onClick={onArchive}
            disabled={saving}
            className="btn-soft rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
          >
            自行封存資料
          </button>
        )}
        {hasRegistration && (
          <button
            type="button"
            onClick={onPrint}
            className="btn-soft rounded-lg px-4 py-2 text-sm cursor-pointer"
          >
            下載為PDF
          </button>
        )}
        <span className="text-xs text-t3">
          {item.myOptOut
            ? `已勾選不報名${item.myOptOutReason ? `（${item.myOptOutReason}）` : ""}`
            : hasRegistration
              ? `完成報名（${item.mySubjectKeys.length} 項科目）${item.locationOptions.length > 0 && item.myLocationCode ? `・${resolveLocationLabel(item.locationOptions, item.myLocationCode)}` : ""}`
              : closed
                ? "本場次已截止"
                : upcoming
                  ? "本場次尚未開放"
                  : "尚未登錄"}
        </span>
      </div>
        </>
      )}
    </section>
  );
}

/** 列印專用報名表（@media print 才顯示；瀏覽器列印／另存 PDF） */
function RegistrationPrintSheet({ item }: { item: StudentExamEvent }) {
  const subjectLabels = item.subjects
    .filter((subject) => item.mySubjectKeys.includes(subject.key))
    .map((subject) => {
      const code = item.mySubjectAdvancedOptionCodes[subject.key] ?? "";
      const optionLabel = (subject.advancedOptions ?? []).find((option) => option.code === code)?.label ?? "";
      return optionLabel ? `${subject.label}（${optionLabel}）` : subject.label;
    });
  const locationLabel =
    resolveLocationLabel(item.locationOptions, item.myLocationCode) || item.location;
  return (
    <div className="hidden print:block border border-t1 rounded-lg p-8 text-t1 text-sm leading-relaxed">
      <h2 className="text-xl font-bold text-center mb-1">升學考試與模擬考報名表</h2>
      <p className="text-center text-t2 mb-6">
        {item.title}
        <OfficialExamLabel title={item.title} />
      </p>
      <table className="w-full mb-4">
        <tbody>
          <tr className="border-b border-themed">
            <td className="py-2 pr-4 text-t2 w-28">考試類型</td>
            <td className="py-2">{EXAM_CATEGORY_LABELS[item.examType]}</td>
          </tr>
          <tr className="border-b border-themed">
            <td className="py-2 pr-4 text-t2">考試日期</td>
            <td className="py-2">{formatExamDateRange(item)}</td>
          </tr>
          {locationLabel && (
            <tr className="border-b border-themed">
              <td className="py-2 pr-4 text-t2">考試地點</td>
              <td className="py-2">{locationLabel}</td>
            </tr>
          )}
          {(item.myNonAirConditionedRoom || item.myExamServiceNote) && (
            <tr className="border-b border-themed">
              <td className="py-2 pr-4 text-t2">應考服務</td>
              <td className="py-2">
                {item.myNonAirConditionedRoom ? "非冷氣試場" : ""}
                {item.myNonAirConditionedRoom && item.myExamServiceNote ? "；" : ""}
                {item.myExamServiceNote || ""}
              </td>
            </tr>
          )}
          <tr className="border-b border-themed">
            <td className="py-2 pr-4 text-t2">報名情形</td>
            <td className="py-2">{item.myOptOut ? "不報名" : "完成報名"}</td>
          </tr>
          {!item.myOptOut && (
            <>
              <tr className="border-b border-themed">
                <td className="py-2 pr-4 text-t2">選考科目</td>
                <td className="py-2">{subjectLabels.join("、") || "—"}</td>
              </tr>
              <tr className="border-b border-themed">
                <td className="py-2 pr-4 text-t2">繳費身分</td>
                <td className="py-2">{item.myFeeCode ? EXAM_FEE_CODE_LABELS[item.myFeeCode] : "—"}</td>
              </tr>
              <tr className="border-b border-themed">
                <td className="py-2 pr-4 text-t2">應繳費用</td>
                <td className="py-2">{item.myFeeAmount ?? 0} 元</td>
              </tr>
            </>
          )}
          {item.myOptOut && item.myOptOutReason && (
            <tr className="border-b border-themed">
              <td className="py-2 pr-4 text-t2">不報名原因</td>
              <td className="py-2">{item.myOptOutReason}</td>
            </tr>
          )}
          <tr className="border-b border-themed">
            <td className="py-2 pr-4 text-t2">更新時間</td>
            <td className="py-2">{item.registeredAt ? formatDateTime(item.registeredAt) : "—"}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-xs text-t3 mt-8">
        本表由校務系統產出；{item.myArchived ? "資料已封存。" : "資料尚未封存，內容以系統最新紀錄為準。"}
      </p>
    </div>
  );
}
