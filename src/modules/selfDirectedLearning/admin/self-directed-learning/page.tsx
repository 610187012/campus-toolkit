"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Toast, { type ToastMessage } from "@/components/Toast";
import DisclosureArrow from "@/components/DisclosureArrow";
import { RichTextEditor } from "../../components/rich-text-editor";
import {
  DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS,
  DOCUMENT_EXPORT_LABELS,
  MAX_MIN_APPROVED_PLANS,
  WEEKDAY_LABELS,
  openStateOf,
  reviewStateOf,
  type ClassOption,
  type DocumentExportPlatform,
  type FlexibleSlot,
  type PeriodOption,
  type ReviewerEntry,
  type ReviewerStudentRef,
  type SelfDirectedLearningSettings,
  type SpaceOption,
  type StaffCandidate,
  type StudentOption,
} from "../../types/self-directed-learning";

function toDateTimeLocal(epoch: number | null): string {
  if (!epoch) return "";
  const shifted = new Date(epoch - new Date().getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value: string): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function formatDateTime(epoch: number | null): string {
  if (!epoch) return "未設定";
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATE_LABEL: Record<string, string> = {
  unset: "尚未設定送審期間",
  closed: "尚未到送審期間",
  open: "送審期間內",
  ended: "已超過送審期間",
};

const REVIEW_STATE_LABEL: Record<string, string> = {
  unset: "尚未設定審核期限",
  closed: "尚未開始審核",
  open: "審核進行中",
  ended: "已超過審核期限",
};

/** 撰寫說明範例（富文本；以編號清單呈現，插入後可再修改） */
const INSTRUCTIONS_TEMPLATE =
  "<ol><li>請於送審期間內送出審核；草稿與正式計畫可隨時建立、編輯。</li><li>逐週學習安排與場地皆須填寫完整。</li><li>送出後請等待審核；退回時可依意見修改後再送。</li></ol>";

/** 實施說明範例（給學生、家長的總說明；富文本） */
const IMPLEMENTATION_TEMPLATE =
  "<ol><li>自主學習計畫請於學校設定的送審期間內送出審核。</li><li>學習活動請於學校規定的時間與場地實施。</li><li>計畫經審核通過後，始得依計畫內容實施。</li></ol>";

/** 依行自動標號的功能已移除：說明改為富文本編輯器，編號清單由工具列處理 */

/** 對象名單圖示 */
function TargetListIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12M8.25 17.25h12M3.75 6.75h.007v.008H3.75V6.75zm0 5.25h.007v.008H3.75V12zm0 5.25h.007v.008H3.75v-.008z" />
    </svg>
  );
}

/** 設定對象圖示 */
function TargetSettingsIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

/** 移除圖示 */
function RemoveIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  );
}

export default function SelfDirectedLearningSettingsPage({
  fill = false,
  delegated = false,
}: {
  /** 嵌入教職員頁管理面板時為 true：縮小外框、不出頁首返回列 */
  fill?: boolean;
  /** 由被指派的教職員檢視時為 true：不顯示給（超級）管理員的提示 */
  delegated?: boolean;
}) {
  const [settings, setSettings] = useState<SelfDirectedLearningSettings>(DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS);
  /** 全學期形式的須填週數（由學期起訖自動判斷；null＝學校尚未設定起訖） */
  const [fullWeeks, setFullWeeks] = useState<number | null>(null);
  /** 實際可寫週數（全校層級活動；供下限週數檢核） */
  const [availableWeeks, setAvailableWeeks] = useState<{
    total: number;
    available: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const [venueInput, setVenueInput] = useState("");
  /** 選擇中的教職員候選 uid（審核人員） */
  const [selectedStaffUid, setSelectedStaffUid] = useState("");
  /** 當期教職員名冊候選人 */
  const [staffCandidates, setStaffCandidates] = useState<StaffCandidate[]>([]);
  /** 屬性過濾（""＝全部）與姓名搜尋 */
  const [staffAttribute, setStaffAttribute] = useState("");
  const [staffNameQuery, setStaffNameQuery] = useState("");
  /** 節次候選（主程式課表作息） */
  const [periodOptions, setPeriodOptions] = useState<PeriodOption[]>([]);
  /** 上課日星期（主程式課表作息；1=週一…7=週日） */
  const [schoolDays, setSchoolDays] = useState<number[]>([1, 2, 3, 4, 5]);
  /** 場域候選（主程式樓層空間設定的葉子空間） */
  const [spaceOptions, setSpaceOptions] = useState<SpaceOption[]>([]);
  /** 下限週數輸入框的暫存字串：允許清空後重打，失焦時回復現值 */
  const [minWeeksInput, setMinWeeksInput] = useState<string | null>(null);
  const [maxDraftsInput, setMaxDraftsInput] = useState<string | null>(null);
  const [maxDocumentPlansInput, setMaxDocumentPlansInput] = useState<string | null>(null);
  const [minApprovedPlansInput, setMinApprovedPlansInput] = useState<string | null>(null);

  /** 班級候選（主程式年段班級設定） */
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  /** 正在設定審查對象的審核人員 uid（一次只展開一位） */
  const [scopeEditorUid, setScopeEditorUid] = useState<string | null>(null);
  /** 正在檢視對象名單的審核人員 uid（彈出視窗） */
  const [targetViewerUid, setTargetViewerUid] = useState<string | null>(null);
  /** 等待確認移除的審核人員 */
  const [confirmRemoveReviewer, setConfirmRemoveReviewer] = useState<ReviewerEntry | null>(
    null
  );
  /** 個人模式目前選取載入的班級 */
  const [targetClassCode, setTargetClassCode] = useState("");
  /** 已載入的班級學生（按班級快取，避免重複讀取） */
  const [classStudents, setClassStudents] = useState<Record<string, StudentOption[]>>({});
  const [studentLoading, setStudentLoading] = useState(false);
  const [studentError, setStudentError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/self-directed-learning", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "讀取設定失敗" });
        return;
      }
      setSettings(data.settings as SelfDirectedLearningSettings);
      setFullWeeks(typeof data.fullWeeks === "number" ? data.fullWeeks : null);
      setAvailableWeeks(
        data.availableWeeks &&
          typeof data.availableWeeks === "object" &&
          typeof data.availableWeeks.total === "number" &&
          typeof data.availableWeeks.available === "number"
          ? {
              total: data.availableWeeks.total,
              available: data.availableWeeks.available,
            }
          : null
      );
      setPeriodOptions(Array.isArray(data.periodOptions) ? (data.periodOptions as PeriodOption[]) : []);
      setSchoolDays(
        Array.isArray(data.schoolDays) && data.schoolDays.length
          ? (data.schoolDays as number[]).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
          : [1, 2, 3, 4, 5]
      );
      setSpaceOptions(Array.isArray(data.spaceOptions) ? (data.spaceOptions as SpaceOption[]) : []);
      setClassOptions(Array.isArray(data.classOptions) ? (data.classOptions as ClassOption[]) : []);
      setStaffCandidates(
        Array.isArray(data.staffCandidates) ? (data.staffCandidates as StaffCandidate[]) : []
      );
    } catch {
      setToast({ kind: "error", text: "讀取設定失敗" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (partial: Partial<SelfDirectedLearningSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  };

  /** 屬性選項（名冊中出現過的，去重保序） */
  const staffAttributeOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const candidate of staffCandidates) {
      if (!candidate.attribute || seen.has(candidate.attribute)) continue;
      seen.add(candidate.attribute);
      options.push(candidate.attribute);
    }
    return options;
  }, [staffCandidates]);

  /** 依屬性與姓名過濾後的候選（已加入者除外） */
  const filteredStaffCandidates = useMemo(() => {
    const query = staffNameQuery.trim().toLowerCase();
    return staffCandidates.filter((candidate) => {
      if (settings.reviewers.some((reviewer) => reviewer.uid === candidate.uid)) return false;
      if (staffAttribute && candidate.attribute !== staffAttribute) return false;
      if (query && !candidate.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [staffCandidates, settings.reviewers, staffAttribute, staffNameQuery]);

  /** 班級依年級分組（維持主程式年段順序）；避免每個班級都重複顯示年級名稱 */
  const classGroups = useMemo(() => {
    const groups = new Map<string, ClassOption[]>();
    for (const option of classOptions) {
      const key = option.grade || "其他";
      const list = groups.get(key) ?? [];
      list.push(option);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([grade, classes]) => ({ grade, classes }));
  }, [classOptions]);

  /** 格狀表格勾選：day=星期代碼、periodName=節次名稱，即時寫入 slots */
  const toggleScheduleCell = (day: number, periodName: string, checked: boolean) => {
    const existing = settings.slots.find((slot) => slot.day === day);
    const current = existing ? existing.periods : [];
    const merged = checked
      ? [...current, periodName]
      : current.filter((name) => name !== periodName);
    // 依作息表順序排列該日節次
    const ordered = periodOptions
      .filter((option) => merged.includes(option.name))
      .map((option) => option.name);
    const rest = settings.slots.filter((slot) => slot.day !== day);
    const next: FlexibleSlot[] = ordered.length
      ? [...rest, { day, periods: ordered }].sort((a, b) => a.day - b.day)
      : rest;
    patch({ slots: next });
  };

  const removeSlot = (day: number) => {
    patch({ slots: settings.slots.filter((slot) => slot.day !== day) });
  };

  const addVenue = () => {
    const venue = venueInput.trim();
    if (!venue) return;
    if (settings.venues.includes(venue)) {
      setToast({ kind: "error", text: "該場域已存在" });
      return;
    }
    patch({ venues: [...settings.venues, venue] });
    setVenueInput("");
  };

  const removeVenue = (venue: string) => {
    patch({ venues: settings.venues.filter((item) => item !== venue) });
  };

  const addReviewer = () => {
    const candidate = staffCandidates.find((item) => item.uid === selectedStaffUid);
    if (!candidate) {
      setToast({ kind: "error", text: "請先選擇教職員" });
      return;
    }
    if (settings.reviewers.some((reviewer) => reviewer.uid === candidate.uid)) {
      setToast({ kind: "error", text: "此人已在名單中" });
      return;
    }
    const entry: ReviewerEntry = {
      uid: candidate.uid,
      name: candidate.name || candidate.uid,
      classScoped: false,
      classCodes: [],
      studentScoped: false,
      students: [],
    };
    patch({ reviewers: [...settings.reviewers, entry] });
    setSelectedStaffUid("");
  };

  const removeReviewer = (uid: string) => {
    patch({ reviewers: settings.reviewers.filter((reviewer) => reviewer.uid !== uid) });
    if (scopeEditorUid === uid) setScopeEditorUid(null);
    if (targetViewerUid === uid) setTargetViewerUid(null);
  };

  const patchReviewer = (uid: string, partial: Partial<ReviewerEntry>) => {
    patch({
      reviewers: settings.reviewers.map((reviewer) =>
        reviewer.uid === uid ? { ...reviewer, ...partial } : reviewer
      ),
    });
  };

  /** 展開／收合某位審核人員的對象設定（一次只展開一位，避免多筆誤按） */
  const toggleScopeEditor = (uid: string) => {
    setScopeEditorUid((current) => (current === uid ? null : uid));
    setTargetClassCode("");
    setStudentError("");
  };

  const toggleReviewerClassScope = (reviewer: ReviewerEntry) => {
    patchReviewer(reviewer.uid, { classScoped: !reviewer.classScoped });
  };

  const toggleReviewerStudentScope = (reviewer: ReviewerEntry) => {
    patchReviewer(reviewer.uid, { studentScoped: !reviewer.studentScoped });
    setStudentError("");
  };

  const toggleReviewerClass = (reviewer: ReviewerEntry, classCode: string) => {
    const current = reviewer.classCodes ?? [];
    patchReviewer(reviewer.uid, {
      classCodes: current.includes(classCode)
        ? current.filter((code) => code !== classCode)
        : [...current, classCode],
    });
  };

  /** 整年級全選／取消（受指派上限限制） */
  const toggleReviewerGrade = (reviewer: ReviewerEntry, classes: ClassOption[]) => {
    const current = new Set(reviewer.classCodes ?? []);
    const allSelected = classes.every((option) => current.has(option.code));
    if (allSelected) {
      for (const option of classes) current.delete(option.code);
    } else {
      for (const option of classes) current.add(option.code);
    }
    patchReviewer(reviewer.uid, { classCodes: [...current] });
  };

  const toggleReviewerStudent = (reviewer: ReviewerEntry, student: StudentOption) => {
    const current = reviewer.students ?? [];
    const exists = current.some((item) => item.uid === student.uid);
    patchReviewer(reviewer.uid, {
      students: exists
        ? current.filter((item) => item.uid !== student.uid)
        : [
            ...current,
            {
              uid: student.uid,
              name: student.name || student.uid,
              classCode: student.classCode,
            } satisfies ReviewerStudentRef,
          ].slice(0, 100),
    });
  };

  const removeReviewerStudent = (reviewer: ReviewerEntry, uid: string) => {
    patchReviewer(reviewer.uid, {
      students: (reviewer.students ?? []).filter((student) => student.uid !== uid),
    });
  };

  /** 個人模式：只在選班級時載入該班學生（同一班只讀一次，存在記憶體） */
  const loadClassStudents = async (classCode: string) => {
    setTargetClassCode(classCode);
    setStudentError("");
    if (!classCode || classStudents[classCode]) return;
    setStudentLoading(true);
    try {
      const response = await fetch(
        `/api/admin/self-directed-learning/students?classCode=${encodeURIComponent(classCode)}`,
        { cache: "no-store" }
      );
      const data = await response.json();
      if (!response.ok || !data.success) {
        setStudentError(data.message || "讀取學生名單失敗");
        return;
      }
      setClassStudents((prev) => ({
        ...prev,
        [classCode]: Array.isArray(data.students) ? (data.students as StudentOption[]) : [],
      }));
    } catch {
      setStudentError("讀取學生名單失敗");
    } finally {
      setStudentLoading(false);
    }
  };

  const setInstructions = (value: string) => {
    patch({ instructions: value });
  };

  const setWritingInstructions = (value: string) => {
    patch({ writingInstructions: value });
  };

  const save = async () => {
    const emptyScopeReviewer = settings.reviewers.find(
      (reviewer) =>
        (reviewer.classScoped && (reviewer.classCodes ?? []).length === 0) ||
        (reviewer.studentScoped && (reviewer.students ?? []).length === 0)
    );
    if (emptyScopeReviewer) {
      setToast({
        kind: "error",
        text: `${emptyScopeReviewer.name} 已選擇指定對象，但尚未勾選任何班級或學生`,
      });
      return;
    }
    const openAt = fromDateTimeLocal(toDateTimeLocal(settings.openAt));
    const closeAt = fromDateTimeLocal(toDateTimeLocal(settings.closeAt));
    const reviewStartAt = fromDateTimeLocal(toDateTimeLocal(settings.reviewStartAt));
    const reviewEndAt = fromDateTimeLocal(toDateTimeLocal(settings.reviewEndAt));
    const payload = {
      ...settings,
      openAt,
      closeAt,
      reviewStartAt,
      reviewEndAt,
    };
    if (payload.openAt !== null && payload.closeAt !== null && payload.closeAt <= payload.openAt) {
      setToast({ kind: "error", text: "送審截止時間必須晚於開始時間" });
      return;
    }
    if (
      payload.reviewStartAt !== null &&
      payload.reviewEndAt !== null &&
      payload.reviewEndAt <= payload.reviewStartAt
    ) {
      setToast({ kind: "error", text: "審核截止時間必須晚於審核開始時間" });
      return;
    }
    if (
      settings.weekMode === "flexible" &&
      availableWeeks &&
      settings.minWeeks > availableWeeks.available
    ) {
      setToast({
        kind: "error",
        text: `可寫週數只有 ${availableWeeks.available} 週，下限 ${settings.minWeeks} 週會使學生無法填滿；請降低下限或調整節次行程／學校活動。`,
      });
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/admin/self-directed-learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "儲存失敗" });
        return;
      }
      setSettings(data.settings as SelfDirectedLearningSettings);
      if (
        data.availableWeeks &&
        typeof data.availableWeeks === "object" &&
        typeof data.availableWeeks.total === "number" &&
        typeof data.availableWeeks.available === "number"
      ) {
        setAvailableWeeks({
          total: data.availableWeeks.total,
          available: data.availableWeeks.available,
        });
      }
      if (data.hookWarning) {
        setToast({ kind: "error", text: String(data.hookWarning) });
      } else {
        setToast({ kind: "success", text: "已儲存" });
      }
    } catch {
      setToast({ kind: "error", text: "儲存失敗" });
    } finally {
      setSaving(false);
    }
  };

  const state = openStateOf(settings);
  const reviewState = reviewStateOf(settings);
  const reviewRemainingDays =
    settings.reviewEndAt !== null
      ? Math.ceil((settings.reviewEndAt - Date.now()) / 86_400_000)
      : null;
  const reviewOverdueDays =
    settings.reviewEndAt !== null
      ? Math.floor((Date.now() - settings.reviewEndAt) / 86_400_000)
      : null;
  /** 彈性形式的下限週數是否超過實際可寫週數 */
  const minWeeksInvalid =
    settings.weekMode === "flexible" &&
    availableWeeks !== null &&
    settings.minWeeks > availableWeeks.available;
  /** 草稿匣上限輸入是否不合法（正整數） */
  const maxDraftsInvalid =
    maxDraftsInput !== null &&
    (maxDraftsInput.trim() === "" ||
      !Number.isInteger(Number(maxDraftsInput)) ||
      Number(maxDraftsInput) < 1);
  /** 文件匣上限輸入是否不合法（正整數） */
  const maxDocumentPlansInvalid =
    maxDocumentPlansInput !== null &&
    (maxDocumentPlansInput.trim() === "" ||
      !Number.isInteger(Number(maxDocumentPlansInput)) ||
      Number(maxDocumentPlansInput) < 1);
  /** 就學期間學校審查通過最低份數是否不合法（0–6 的整數） */
  const minApprovedPlansInvalid =
    minApprovedPlansInput !== null &&
    (minApprovedPlansInput.trim() === "" ||
      !Number.isInteger(Number(minApprovedPlansInput)) ||
      Number(minApprovedPlansInput) < 0 ||
      Number(minApprovedPlansInput) > MAX_MIN_APPROVED_PLANS);

  /** 重新讀取／儲存設定：標題列（上）與頁尾（下）共用同一組按鈕 */
  const actionButtons = (
    <div className="flex flex-wrap justify-end gap-3">
      <button
        type="button"
        className="btn-theme h-10 px-6 text-sm cursor-pointer disabled:opacity-50"
        onClick={() => void load()}
        disabled={loading || saving}
      >
        重新讀取
      </button>
      <button
        type="button"
        className="btn-primary h-10 px-6 text-sm cursor-pointer disabled:opacity-50"
        onClick={() => void save()}
        disabled={
          loading ||
          saving ||
          minWeeksInvalid ||
          maxDraftsInvalid ||
          maxDocumentPlansInvalid ||
          minApprovedPlansInvalid
        }
        title={
          minWeeksInvalid
            ? "下限週數超過可寫週數，請先調整"
            : maxDraftsInvalid
              ? "草稿匣件數上限必須是正整數"
              : maxDocumentPlansInvalid
                ? "文件匣件數上限必須是正整數"
                : minApprovedPlansInvalid
                  ? `就學期間學校審查通過最低份數必須是 0–${MAX_MIN_APPROVED_PLANS} 的整數`
                  : ""
        }
      >
        {saving ? "儲存中…" : "儲存設定"}
      </button>
    </div>
  );

  const targetViewer = targetViewerUid
    ? settings.reviewers.find((reviewer) => reviewer.uid === targetViewerUid) ?? null
    : null;
  const knownClassCodes = new Set(classOptions.map((option) => option.code));
  const unknownTargetClassCodes = targetViewer?.classScoped
    ? (targetViewer.classCodes ?? []).filter((code) => !knownClassCodes.has(code))
    : [];

  return (
    <section className={fill ? "space-y-4" : "mx-auto content-width space-y-4 p-4 sm:p-6"}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl text-t1">管理規則</h1>
          <p className="text-t2 text-sm">
            狀態：
            <span
              className={
                !settings.enabled
                  ? "text-danger"
                  : state === "open"
                    ? "text-success"
                    : "text-t2"
              }
            >
              {!settings.enabled ? "功能已關閉（維護中）" : STATE_LABEL[state]}
            </span>
            {settings.updatedAt > 0 ? ` ｜ 最後更新 ${formatDateTime(settings.updatedAt)}` : ""}
          </p>
        </div>
        {actionButtons}
      </header>

      {!delegated && (
        <div
          role="note"
          className="border border-warning/60 bg-warning/10 text-warning space-y-1 rounded-lg p-3 text-sm"
        >
          <p className="font-medium">
            管理員僅負責功能的規則設定，計畫審核、管理等請授權給指定的管理人員。
          </p>
        </div>
      )}

      <section className="border-themed bg-card space-y-3 rounded-lg border p-4">
        <h2 className="text-t1 font-semibold">文件下載／匯出服務</h2>
        <p className="text-t2 text-sm">各服務獨立開放，預設全部關閉。調整後請按「儲存設定」；啟用不代表平台憑證已設定完成。原列印功能不受影響。</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(DOCUMENT_EXPORT_LABELS) as DocumentExportPlatform[]).map((platform) => (
            <label key={platform} className="border-themed flex items-start gap-3 rounded border p-3">
              <input
                type="checkbox"
                role="switch"
                aria-label={`提供 ${DOCUMENT_EXPORT_LABELS[platform]} 匯出`}
                checked={settings.documentExports[platform]}
                disabled={loading || saving}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSettings((current) => ({
                    ...current, documentExports: { ...current.documentExports, [platform]: checked },
                  }));
                }}
              />
              <span className="text-t1 text-sm">
                {DOCUMENT_EXPORT_LABELS[platform]}
                <span className="text-t3 mt-1 block text-xs">
                  {settings.documentExports[platform] ? (platform === "word" ? "開放 .docx 下載，不需外部授權" : "開放學生匯出") : "不提供學生匯出"}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <details className="border-themed bg-card rounded-lg">
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          Google Docs／Canva 匯出：啟用準備與設定
        </summary>
        <div className="text-t2 space-y-4 break-words px-4 pb-4 text-sm">
          <p>
            以下供學校管理人員與部署維護者查閱，不是憑證輸入表單，也不會自動啟用外部服務。
            設定須在各平台後台與網站部署環境完成；請勿把 secret、token 填入學生說明欄位或分享截圖。
          </p>
          <details className="border-themed bg-surface rounded-md border">
            <summary className="text-t1 flex cursor-pointer items-center gap-2 p-3 font-medium">
              <DisclosureArrow />
              Google Docs：Google Cloud 與網站設定
            </summary>
            <ol className="list-decimal space-y-2 pb-3 pl-9 pr-3">
              <li>
                開啟 <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="underline">Google Cloud 憑證管理</a>，
                選擇學校登入用的 Firebase／OAuth 所屬專案，建立或沿用「網頁應用程式」OAuth 用戶端。
                取得結尾為 .apps.googleusercontent.com 的 Client ID；這不是 client secret。
              </li>
              <li>
                在同一專案啟用 <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer" className="underline">Google Drive API</a>。
                本功能使用 Drive 將 HTML 轉為 Google 文件，不必另外啟用 Google Docs API；
                原本可以 Google 登入，不代表 Drive API 已啟用。
              </li>
              <li>
                OAuth 用戶端的「已授權的 JavaScript 來源」加入實際網站 origin（協定、主機及連接埠），
                不加頁面路徑。例如本機 http://localhost:3000；若從 http://127.0.0.1:3000
                測試也須依 Google 規定設定該來源，兩者不視為相同來源。正式環境加入學校 HTTPS 網址。
                此流程不需另外設定 Google callback route。
              </li>
              <li>
                OAuth 同意畫面設定權限 <code className="break-all">https://www.googleapis.com/auth/drive.file</code>，
                依 Google 規定設定受眾、發布狀態、測試使用者與必要驗證。
                學校 Workspace 若封鎖第三方應用程式，須由管理員允許此用戶端及權限。
              </li>
              <li>
                在本機環境檔或正式部署平台設定 <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code>，
                值為上述 Client ID。不需 Google client secret，也不儲存 refresh token。
                本機修改後重啟 dev server；正式環境設定後重新建置部署，公開變數才會更新到瀏覽器程式。
              </li>
              <li>
                用學生帳號匯出一份合成測試計畫，確認授權後可開啟可編輯文件。
                若提示 API 未啟用，檢查是否啟用在正確專案，並等待數分鐘生效；
                權限不足需重新授權，空間不足需清理 Drive，學校限制則洽 Workspace 管理員。
              </li>
            </ol>
          </details>
          <details className="border-themed bg-surface rounded-md border">
            <summary className="text-t1 flex cursor-pointer items-center gap-2 p-3 font-medium">
              <DisclosureArrow />
              Canva：開發者應用程式與回呼設定
            </summary>
            <ol className="list-decimal space-y-2 pb-3 pl-9 pr-3">
              <li>
                在 <a href="https://www.canva.com/developers/" target="_blank" rel="noopener noreferrer" className="underline">Canva Developer Portal</a> 建立應用程式，
                於 Outside Canva 啟用 Canva REST APIs（不是 Canva MCP）。
                若要供學生各自授權使用，採 Public 並依 Canva 規定完成測試人員設定、審核與發布；
                Private 模式有 Enterprise 團隊限制，不等同一般校內網站。
              </li>
              <li>
                在 Credentials 取得 Client ID 並產生 Client secret，Scopes 只選
                <code className="break-all"> design:content:write</code>（design:content 的 Write）。
                secret 只供後端使用，不可貼到聊天、網頁表單、前端程式或提交到版本庫。
              </li>
              <li>
                Redirect URLs 加入下列本機回呼網址，須與環境變數完全一致：
                <code className="mt-1 block break-all">http://127.0.0.1:3000/api/student/self-directed-learning/canva/callback</code>
                請從 http://127.0.0.1:3000 開啟網站並重新登入，不要從 localhost
                開始後回到 127.0.0.1，兩者登入 cookie 不共用。
              </li>
              <li>
                在網站後端環境設定 <code>CANVA_CLIENT_ID</code>、<code>CANVA_CLIENT_SECRET</code>、
                <code>CANVA_REDIRECT_URI</code>。三者都不可加 NEXT_PUBLIC_ 前綴。
                宿主 <code>SESSION_SECRET</code> 須至少 32 字元，供短效授權 cookie 加密；
                不需為本功能更換既有有效金鑰。修改後重啟本機或重新部署。
              </li>
              <li>
                正式環境將回呼改為學校 HTTPS 網址加上
                <code className="break-all"> /api/student/self-directed-learning/canva/callback</code>，
                同步更新 Canva 後台與 CANVA_REDIRECT_URI。授權起點與回呼必須同 origin；
                Google 登入與 Google Docs 的來源允許設定須另外處理。
              </li>
              <li>
                用具備應用程式測試資格的 Canva 帳號操作合成計畫：學生同意後授權，
                回到原視窗等待 DOCX 匯入，再開啟 Canva 設計。
                若視窗被擋請允許彈出視窗；拒絕存取時確認 scope、測試資格、發布狀態與帳號限制。
                字型、表格及分頁由 Canva 轉換，請實際檢查可編輯內容與版面。
              </li>
            </ol>
          </details>
        </div>
      </details>

      <details className="border-themed bg-card rounded-lg" open>
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          送審時間與計畫容量
        </summary>
        <div className="space-y-4 px-4 pb-4">
          {/* 功能總開關：關閉即全站維護中（管理端不受影響） */}
          <label className="border-themed bg-surface flex flex-wrap items-start gap-3 rounded-md p-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 cursor-pointer"
              checked={settings.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            <span className="min-w-56 flex-1">
              <span className="text-t1 block text-sm font-medium">
                功能總開關（{settings.enabled ? "開啟中" : "關閉維護中"}）
              </span>
              <span className="text-t3 block text-xs">
                關閉後，學生／教職員／家長頁面一律只顯示「目前此功能關閉維護中」，
                並暫停填報與審核；管理端不受影響，可隨時改回開啟。
              </span>
            </span>
          </label>

          {/* 就學期間學校審查通過最低份數：放在總開關下方，使用主題危險色套色 */}
          <div
            className="border-themed bg-surface space-y-2 rounded-md border border-l-4 p-3"
            style={{
              borderLeftColor: "var(--danger)",
              backgroundColor: "color-mix(in srgb, var(--danger) 6%, var(--bg2))",
            }}
          >
            <span className="text-danger block text-sm font-medium">
              就學期間，學校審查通過最低份數
            </span>
            <label className="text-t2 block space-y-1 text-sm">
              <span>
                每位學生就學期間至少審查通過的計畫份數（0–{MAX_MIN_APPROVED_PLANS}{" "}
                份；0＝不設定）
              </span>
              <input
                type="number"
                min={0}
                max={MAX_MIN_APPROVED_PLANS}
                className="input-theme w-32 rounded px-3 py-2 text-sm"
                value={minApprovedPlansInput ?? String(settings.minApprovedPlans)}
                onChange={(event) => {
                  const text = event.target.value;
                  setMinApprovedPlansInput(text);
                  const parsed = Number(text);
                  if (
                    text.trim() !== "" &&
                    Number.isInteger(parsed) &&
                    parsed >= 0 &&
                    parsed <= MAX_MIN_APPROVED_PLANS
                  ) {
                    patch({ minApprovedPlans: parsed });
                  }
                }}
                onBlur={() => setMinApprovedPlansInput(null)}
              />
            </label>
            <ul className="text-t3 list-disc space-y-0.5 pl-4 text-xs">
              <li>依高級中等學校總綱規定，每位學生須完成至少 18 小時的自主學習。</li>
              <li>學校可以強制至少審查份數，以確保學生「做完」最低規範。</li>
            </ul>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-t2 block space-y-1 text-sm">
              <span>送審開始時間</span>
              <input
                type="datetime-local"
                className="input-theme w-full rounded px-3 py-2 text-sm"
                value={toDateTimeLocal(settings.openAt)}
                onChange={(event) => patch({ openAt: fromDateTimeLocal(event.target.value) })}
              />
            </label>
            <label className="text-t2 block space-y-1 text-sm">
              <span>送審截止時間</span>
              <input
                type="datetime-local"
                className="input-theme w-full rounded px-3 py-2 text-sm"
                value={toDateTimeLocal(settings.closeAt)}
                onChange={(event) => patch({ closeAt: fromDateTimeLocal(event.target.value) })}
              />
            </label>
          </div>
          <p className="text-t3 text-sm">
            目前設定：{formatDateTime(settings.openAt)} ～ {formatDateTime(settings.closeAt)}
          </p>
          <p className="text-t3 text-xs">
            送審期間只用來限制「送出審核」；草稿與正式計畫在學期中可隨時建立、編輯。
          </p>

          {/* 計畫成果撰寫截止時間：執行成果紀錄與學習反思心得開放到此時間為止 */}
          <label className="text-t2 block max-w-xs space-y-1 text-sm">
            <span>計畫成果撰寫截止時間</span>
            <input
              type="datetime-local"
              className="input-theme w-full rounded px-3 py-2 text-sm"
              value={toDateTimeLocal(settings.resultDeadlineAt)}
              onChange={(event) =>
                patch({ resultDeadlineAt: fromDateTimeLocal(event.target.value) })
              }
            />
            <span className="text-t3 block text-xs">
              只適用「學校審核通過」的計畫；自行提升的正式計畫不受此截止時間限制。
              每一週的成果紀錄仍需等該週規劃時間過了才會開放；未設定＝不限制審核通過計畫的填寫期限。
            </span>
          </label>
          {settings.resultDeadlineAt !== null && (
            <p className="text-t3 text-sm">
              目前設定：{formatDateTime(settings.resultDeadlineAt)} 截止
            </p>
          )}

          {/* 週數填寫形式：全學期全填（週數自動判斷）vs 彈性下限 */}
          <div className="space-y-2">
            <span className="text-t1 block text-sm font-medium">週數填寫形式</span>
            <label className="text-t2 flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="weekMode"
                className="mt-1 h-4 w-4 cursor-pointer"
                checked={settings.weekMode === "full"}
                onChange={() => patch({ weekMode: "full" })}
              />
              <span>
                全學期空白週數都須填寫
                <span className="text-t3 block text-xs">
                  {fullWeeks !== null
                    ? `根據學期設定，由程式自動判斷，本學期共 ${fullWeeks} 週。`
                    : "根據學期設定，由程式自動判斷（學校尚未設定上課日／學期起訖）。"}
                  扣除國定假日與學校重要行程後，依實際週數為總週數。
                </span>
              </span>
            </label>
            <label className="text-t2 flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="weekMode"
                className="mt-1 h-4 w-4 cursor-pointer"
                checked={settings.weekMode === "flexible"}
                onChange={() => patch({ weekMode: "flexible" })}
              />
              <span>
                全學期採彈性週數填寫
                <span className="text-t3 block text-xs">
                  學生只要填寫學校規定的下限週數即可
                  {fullWeeks !== null ? `，上限為程式判斷的總週數（${fullWeeks} 週）` : "，上限由程式判斷"}
                  。扣除國定假日與學校重要行程後，依實際週數為總週數。
                </span>
              </span>
            </label>
            {settings.weekMode === "flexible" && (
              <div className="space-y-2">
                <label className="text-t2 block space-y-1 text-sm">
                  <span>下限週數（學生至少須填寫；建議至少 6 週）</span>
                  <input
                    type="number"
                    min={1}
                    className="input-theme w-32 rounded px-3 py-2 text-sm"
                    value={minWeeksInput ?? String(settings.minWeeks)}
                    onChange={(event) => {
                      const text = event.target.value;
                      setMinWeeksInput(text);
                      const parsed = Number(text);
                      if (text.trim() !== "" && Number.isInteger(parsed)) {
                        patch({ minWeeks: parsed });
                      }
                    }}
                    onBlur={() => setMinWeeksInput(null)}
                  />
                </label>
                <p className={`text-xs ${minWeeksInvalid ? "text-danger" : "text-t3"}`}>
                  {availableWeeks
                    ? `目前可寫週數：${availableWeeks.available} 週（總週數 ${availableWeeks.total} 週；依目前儲存的節次行程與學校活動計算）。下限不可超過可寫週數；班級個別活動造成的衝堂會由學生端即時檢核。`
                    : "學校尚未設定學期起訖，暫無法檢核可寫週數。"}
                </p>
                {minWeeksInvalid && (
                  <p className="text-danger text-xs">
                    下限 {settings.minWeeks} 週超過可寫週數 {availableWeeks?.available} 週——另外的週次要寫在哪裡？
                    請降低下限，或調整節次行程／學校活動。
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 文件匣與草稿匣件數上限 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <span className="text-t1 block text-sm font-medium">文件匣件數上限</span>
              <label className="text-t2 block space-y-1 text-sm">
                <span>每位學生最多可保留的審核中＋已通過計畫（正整數）</span>
                <input
                  type="number"
                  min={1}
                  className="input-theme w-32 rounded px-3 py-2 text-sm"
                  value={maxDocumentPlansInput ?? String(settings.maxDocumentPlans)}
                  onChange={(event) => {
                    const text = event.target.value;
                    setMaxDocumentPlansInput(text);
                    const parsed = Number(text);
                    if (text.trim() !== "" && Number.isInteger(parsed) && parsed >= 1) {
                      patch({ maxDocumentPlans: parsed });
                    }
                  }}
                  onBlur={() => setMaxDocumentPlansInput(null)}
                />
              </label>
              <p className="text-t3 text-xs">
                僅限制送出審核；自行提升的正式計畫不占文件匣。已達上限時請調整上限，或等既有計畫審查結束。
              </p>
            </div>

            <div className="space-y-2">
              <span className="text-t1 block text-sm font-medium">草稿匣件數上限</span>
              <label className="text-t2 block space-y-1 text-sm">
                <span>每位學生最多可保留的草稿（含退回修改；正整數）</span>
                <input
                  type="number"
                  min={1}
                  className="input-theme w-32 rounded px-3 py-2 text-sm"
                  value={maxDraftsInput ?? String(settings.maxDrafts)}
                  onChange={(event) => {
                    const text = event.target.value;
                    setMaxDraftsInput(text);
                    const parsed = Number(text);
                    if (text.trim() !== "" && Number.isInteger(parsed) && parsed >= 1) {
                      patch({ maxDrafts: parsed });
                    }
                  }}
                  onBlur={() => setMaxDraftsInput(null)}
                />
              </label>
              <p className="text-t3 text-xs">
                僅限制新增草稿；已達上限時仍可編輯既有草稿或刪除後再新增。退回修改的計畫也計入件數。
              </p>
            </div>
          </div>
        </div>
      </details>

      <details className="border-themed bg-card rounded-lg" open>
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          公告與行事曆
        </summary>
        <div className="space-y-3 px-4 pb-4">
          <label className="border-themed bg-surface flex flex-wrap items-start gap-3 rounded-md p-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 cursor-pointer"
              checked={settings.publishAnnouncement}
              onChange={(event) => patch({ publishAnnouncement: event.target.checked })}
            />
            <span className="min-w-56 flex-1">
              <span className="text-t1 block text-sm font-medium">
                儲存設定時同步發布系統公告（{settings.publishAnnouncement ? "開啟" : "關閉"}）
              </span>
              <span className="text-t3 block text-xs">
                勾選後，儲存設定時會建立或更新系統公告（對象：學生、家長、教職員），
                同一筆公告不會重複發送；未勾選時不會自動發送，也不會更動既有公告。
              </span>
            </span>
          </label>
          <label className="border-themed bg-surface flex flex-wrap items-start gap-3 rounded-md p-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 cursor-pointer"
              checked={settings.publishCalendar}
              onChange={(event) => patch({ publishCalendar: event.target.checked })}
            />
            <span className="min-w-56 flex-1">
              <span className="text-t1 block text-sm font-medium">
                儲存設定時同步發布行事曆行程（{settings.publishCalendar ? "開啟" : "關閉"}）
              </span>
              <span className="text-t3 block text-xs">
                勾選後，儲存設定時會建立或更新行事曆行程（對象：學生、家長、教職員），
                同一筆行程會覆寫更新；未勾選時不會自動發送，也不會更動既有行程。
              </span>
            </span>
          </label>
          <p className="text-t3 text-sm">
            公告標題「自主學習計畫送審期間」，時間為上方設定的開始～截止時間；
            若時間清空，有勾選的項目會撤回公告或取消行程。
          </p>
        </div>
      </details>

      <details className="border-themed bg-card rounded-lg" open>
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          校內彈性學習節次行程
        </summary>
        <div className="space-y-4 px-4 pb-4">
          {periodOptions.length === 0 ? (
            <p className="text-t3 text-sm">
              尚無作息資料，請先至「學校基本設定 → 課表作息時間」建立節次。
            </p>
          ) : (
            <>
              <p className="text-t3 text-sm">勾選，表示該日該節為校內彈性學習時間。</p>
              <div className="border-themed bg-surface overflow-x-auto rounded-md">
                <table className="w-full text-sm text-left">
                  <thead className="border-b border-themed">
                    <tr>
                      <th className="px-3 py-2 font-medium whitespace-nowrap text-t2">節次 ＼ 星期</th>
                      {schoolDays.map((day) => (
                        <th key={day} className="px-3 py-2 font-medium whitespace-nowrap text-t1 text-center">
                          {WEEKDAY_LABELS[day - 1]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {periodOptions.map((period) => (
                      <tr key={period.code} className="border-b border-themed last:border-0">
                        <td className="px-3 py-2 whitespace-nowrap text-t1">{period.name}</td>
                        {schoolDays.map((day) => {
                          const slot = settings.slots.find((item) => item.day === day);
                          const checked = slot ? slot.periods.includes(period.name) : false;
                          return (
                            <td key={day} className="px-3 py-2 text-center">
                              <input
                                type="checkbox"
                                className="h-4 w-4 cursor-pointer"
                                checked={checked}
                                aria-label={`${WEEKDAY_LABELS[day - 1]} ${period.name}`}
                                onChange={(event) =>
                                  toggleScheduleCell(day, period.name, event.target.checked)
                                }
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {settings.slots.length > 0 && (
            <ul className="space-y-2">
              {settings.slots.map((slot) => (
                <li
                  key={slot.day}
                  className="border-themed bg-surface flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2"
                >
                  <span className="text-t1 text-sm">
                    {WEEKDAY_LABELS[slot.day - 1]}：{slot.periods.join("、")}
                  </span>
                  <button
                    type="button"
                    className="btn-danger h-8 px-3 text-sm"
                    onClick={() => removeSlot(slot.day)}
                  >
                    清除該日
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <details className="border-themed bg-card rounded-lg" open>
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          開放場域
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <label className="border-themed bg-surface flex flex-wrap items-start gap-3 rounded-md p-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 cursor-pointer"
              checked={settings.venueEditable}
              onChange={(event) => patch({ venueEditable: event.target.checked })}
            />
            <span className="min-w-56 flex-1">
              <span className="text-t1 block text-sm font-medium">
                開放學生自行輸入場地（{settings.venueEditable ? "開啟" : "關閉"}）
              </span>
              <span className="text-t3 block text-xs">
                勾選後學生除下方開放的固定場域外，也可自行輸入其他場地名稱；
                取消勾選時學生只能從下方開放的固定場域清單選擇（送出審核會檢查）。
              </span>
            </span>
          </label>
          {!settings.venueEditable && settings.venues.length === 0 && (
            <p className="text-danger text-sm">
              已關閉自行輸入，但目前沒有任何開放場域，學生將無法選擇場地——請先新增至少一個場域。
            </p>
          )}
          <p className="text-t3 text-sm">
            以下為學生可選擇的固定場域清單；關閉自行輸入時，學生只能從中選擇。
          </p>
          {settings.venues.length === 0 ? (
            <p className="text-t3 text-sm">尚未設定開放場域。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {settings.venues.map((venue) => (
                <span
                  key={venue}
                  className="border-themed bg-surface text-t1 inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm"
                >
                  {venue}
                  <button
                    type="button"
                    aria-label={`移除 ${venue}`}
                    className="text-t3 hover:text-danger"
                    onClick={() => removeVenue(venue)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-t2 block min-w-48 flex-1 space-y-1 text-sm">
              <span>新增場域（可點選樓層空間建議，或自行輸入名稱）</span>
              <input
                type="text"
                className="input-theme w-full rounded px-3 py-2 text-sm"
                value={venueInput}
                list="sdl-admin-space-options"
                onChange={(event) => setVenueInput(event.target.value)}
                placeholder="如：圖書館自習室、電腦教室"
              />
              <datalist id="sdl-admin-space-options">
                {spaceOptions.map((option) => (
                  <option
                    key={`${option.name}-${option.floor}`}
                    value={option.name}
                  >
                    {option.floor ? `${option.name}（${option.floor}）` : option.name}
                  </option>
                ))}
              </datalist>
            </label>
            <button type="button" className="btn-theme h-10 px-4 text-sm" onClick={addVenue}>
              加入
            </button>
          </div>
        </div>
      </details>

      <details className="border-themed bg-card rounded-lg" open>
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          審核期限
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <p className="text-t3 text-xs">
            設定審核起訖後，審核人員的頁面會顯示期限、剩餘天數與逾期提醒，以督促於期限內完成審核。
            期限僅供提示，逾期仍可審核；留空表示不設期限。
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-t2 block space-y-1 text-sm">
              <span>審核開始時間</span>
              <input
                type="datetime-local"
                className="input-theme w-full rounded px-3 py-2 text-sm"
                value={toDateTimeLocal(settings.reviewStartAt)}
                onChange={(event) =>
                  patch({ reviewStartAt: fromDateTimeLocal(event.target.value) })
                }
              />
            </label>
            <label className="text-t2 block space-y-1 text-sm">
              <span>審核截止時間</span>
              <input
                type="datetime-local"
                className="input-theme w-full rounded px-3 py-2 text-sm"
                value={toDateTimeLocal(settings.reviewEndAt)}
                onChange={(event) => patch({ reviewEndAt: fromDateTimeLocal(event.target.value) })}
              />
            </label>
          </div>
          <p className="text-t3 text-sm">
            目前設定：{formatDateTime(settings.reviewStartAt)} ～{" "}
            {formatDateTime(settings.reviewEndAt)}（{REVIEW_STATE_LABEL[reviewState]}
            {reviewState === "open" && reviewRemainingDays !== null
              ? `，剩餘 ${Math.max(reviewRemainingDays, 0)} 天`
              : ""}
            {reviewState === "ended" && reviewOverdueDays !== null
              ? `，已逾期 ${Math.max(reviewOverdueDays, 0)} 天`
              : ""}
            ）
          </p>
          {settings.reviewStartAt !== null &&
            settings.closeAt !== null &&
            settings.reviewStartAt < settings.closeAt && (
              <p className="text-warning text-xs">
                審核開始時間早於送審截止時間：審核人員可能在學生仍可送出或抽回時就開始審核。
              </p>
            )}
        </div>
      </details>

      <details className="border-themed bg-card rounded-lg" open>
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          審核人員
        </summary>
        <div className="space-y-4 px-4 pb-4">
          {/* 搜尋與加入（置於名單上方） */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-t2 block space-y-1 text-sm">
              <span>屬性</span>
              <select
                className="input-theme w-40 rounded px-3 py-2 text-sm"
                value={staffAttribute}
                onChange={(event) => {
                  setStaffAttribute(event.target.value);
                  setSelectedStaffUid("");
                }}
              >
                <option value="">全部</option>
                {staffAttributeOptions.map((attribute) => (
                  <option key={attribute} value={attribute}>
                    {attribute}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-t2 block space-y-1 text-sm">
              <span>搜尋姓名</span>
              <input
                type="search"
                className="input-theme w-40 rounded px-3 py-2 text-sm"
                value={staffNameQuery}
                onChange={(event) => {
                  setStaffNameQuery(event.target.value);
                  setSelectedStaffUid("");
                }}
                placeholder="姓名關鍵字"
              />
            </label>
            <label className="text-t2 block space-y-1 text-sm">
              <span>選擇教職員</span>
              <select
                className="input-theme w-64 rounded px-3 py-2 text-sm"
                value={selectedStaffUid}
                onChange={(event) => setSelectedStaffUid(event.target.value)}
              >
                <option value="">
                  {filteredStaffCandidates.length ? "請選擇…" : "（無符合的教職員）"}
                </option>
                {filteredStaffCandidates.map((candidate) => (
                  <option key={candidate.uid} value={candidate.uid}>
                    {candidate.name || candidate.uid}
                    {candidate.attribute ? `（${candidate.attribute}）` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn-theme h-10 px-4 text-sm" onClick={addReviewer}>
              加入
            </button>
          </div>

          <p className="text-t3 text-xs">
            加入後可於下方設定審查對象（班級或個人）；未設定者為全校。個人模式僅在選擇班級後載入該班學生，避免一次讀取全校名冊。
          </p>

          {settings.reviewers.length === 0 ? (
            <p className="text-t3 text-sm">尚未指定審核人員（管理員恆可審核）。</p>
          ) : (
            <ul className="space-y-2">
              {settings.reviewers.map((reviewer) => (
                <li key={reviewer.uid} className="border-themed bg-surface space-y-2 rounded-md px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-t1 min-w-0 flex-1 truncate text-sm">
                      {reviewer.name}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        title="對象名單"
                        aria-label={`查看 ${reviewer.name} 的對象名單`}
                        onClick={() => setTargetViewerUid(reviewer.uid)}
                        className="cursor-pointer rounded p-1 text-t3 transition hover:bg-hover hover:text-t2"
                      >
                        <TargetListIcon />
                      </button>
                      <button
                        type="button"
                        title="設定對象"
                        aria-label={`設定 ${reviewer.name} 的審查對象`}
                        aria-pressed={scopeEditorUid === reviewer.uid}
                        onClick={() => toggleScopeEditor(reviewer.uid)}
                        className={`cursor-pointer rounded p-1 transition hover:bg-hover ${
                          scopeEditorUid === reviewer.uid
                            ? "text-primary"
                            : "text-t3 hover:text-t2"
                        }`}
                      >
                        <TargetSettingsIcon />
                      </button>
                      <button
                        type="button"
                        title="移除"
                        aria-label={`移除 ${reviewer.name}`}
                        onClick={() => setConfirmRemoveReviewer(reviewer)}
                        className="cursor-pointer rounded p-1 text-t3 transition hover:bg-hover hover:text-danger"
                      >
                        <RemoveIcon />
                      </button>
                    </div>
                  </div>

                  {scopeEditorUid === reviewer.uid && (
                    <div className="border border-themed space-y-3 rounded-md p-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-4">
                          <label className="text-t2 flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer"
                              checked={reviewer.classScoped === true}
                              onChange={() => toggleReviewerClassScope(reviewer)}
                            />
                            指定審查班級
                          </label>
                          <label className="text-t2 flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer"
                              checked={reviewer.studentScoped === true}
                              onChange={() => toggleReviewerStudentScope(reviewer)}
                            />
                            另指定個別學生（例外需求）
                          </label>
                        </div>
                        <p className="text-t3 text-xs">
                          未勾選以上項目＝全校。原則上以班級指派；個別學生僅供特殊需求使用。
                        </p>
                      </div>

                      {reviewer.classScoped && (
                        <div className="space-y-2">
                          {classOptions.length === 0 ? (
                            <p className="text-t3 text-sm">
                              尚無班級資料，請先至「學校基本設定 → 年段班級設定」建立班級。
                            </p>
                          ) : (
                            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                              {classGroups.map(({ grade, classes }) => {
                                const selectedCount = classes.filter((option) =>
                                  (reviewer.classCodes ?? []).includes(option.code)
                                ).length;
                                const allSelected = selectedCount === classes.length;
                                return (
                                  <div key={grade} className="border border-themed rounded-md p-3">
                                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                      <span className="text-t1 text-sm font-medium">
                                        {grade}
                                        <span className="text-t3 ml-1 text-xs">
                                          （{classes.length} 班，已選 {selectedCount}）
                                        </span>
                                      </span>
                                      <label className="text-t2 flex cursor-pointer items-center gap-2 text-xs">
                                        <input
                                          type="checkbox"
                                          className="h-4 w-4 cursor-pointer"
                                          checked={allSelected}
                                          onChange={() => toggleReviewerGrade(reviewer, classes)}
                                        />
                                        全選
                                      </label>
                                    </div>
                                    <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                                      {classes.map((option) => (
                                        <label
                                          key={option.code}
                                          className="text-t2 flex items-center gap-2 text-sm"
                                        >
                                          <input
                                            type="checkbox"
                                            className="h-4 w-4 cursor-pointer"
                                            checked={(reviewer.classCodes ?? []).includes(option.code)}
                                            onChange={() => toggleReviewerClass(reviewer, option.code)}
                                          />
                                          <span className="min-w-0 truncate">
                                            {option.name || option.code}
                                            <span className="text-t3 text-xs">（{option.code}）</span>
                                          </span>
                                        </label>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <p className="text-t3 text-xs">
                            已選 {(reviewer.classCodes ?? []).length} 班。若為全校，可直接不勾選「指定審查班級」，以單一查詢載入。
                          </p>
                        </div>
                      )}

                      {reviewer.studentScoped && (
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="text-t2 block space-y-1 text-sm">
                              <span>載入班級</span>
                              <select
                                className="input-theme w-56 rounded px-3 py-2 text-sm"
                                value={targetClassCode}
                                onChange={(event) => void loadClassStudents(event.target.value)}
                              >
                                <option value="">請選擇班級…</option>
                                {classGroups.map(({ grade, classes }) => (
                                  <optgroup key={grade} label={grade}>
                                    {classes.map((option) => (
                                      <option key={option.code} value={option.code}>
                                        {option.name || option.code}（{option.code}）
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </label>
                            {studentLoading && <p className="text-t3 text-sm">學生載入中…</p>}
                            {studentError && <p className="text-danger text-sm">{studentError}</p>}
                          </div>

                          {(reviewer.students ?? []).length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {(reviewer.students ?? []).map((student) => (
                                <span
                                  key={student.uid}
                                  className="border border-themed text-t2 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
                                >
                                  {student.name || student.uid}
                                  <button
                                    type="button"
                                    onClick={() => removeReviewerStudent(reviewer, student.uid)}
                                    aria-label={`移除 ${student.name || student.uid}`}
                                    className="text-t3 hover:text-danger cursor-pointer"
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}

                          {targetClassCode && classStudents[targetClassCode] && (
                            <div className="border border-themed grid max-h-56 gap-1 overflow-y-auto rounded-md p-2 sm:grid-cols-2 lg:grid-cols-3">
                              {classStudents[targetClassCode].map((student) => (
                                <label
                                  key={student.uid}
                                  className="text-t2 flex items-center gap-2 text-sm"
                                >
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 cursor-pointer"
                                    checked={(reviewer.students ?? []).some(
                                      (item) => item.uid === student.uid
                                    )}
                                    onChange={() => toggleReviewerStudent(reviewer, student)}
                                  />
                                  <span className="min-w-0 truncate">
                                    {student.name || student.uid}
                                    {student.className ? `（${student.className}）` : ""}
                                  </span>
                                </label>
                              ))}
                              {classStudents[targetClassCode].length === 0 && (
                                <p className="text-t3 text-sm">此班目前沒有有效學生。</p>
                              )}
                            </div>
                          )}
                          <p className="text-t3 text-xs">
                            已選 {(reviewer.students ?? []).length} 人。切換班級才會載入該班學生，不會一次讀取全校。
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <details className="border-themed bg-card rounded-lg" open>
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          自主學習實施說明
        </summary>
        <div className="space-y-2 px-4 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-t3 text-xs">
              給學生、家長的總說明；可使用工具列格式化、字型、顏色與編號清單。
            </p>
            <button
              type="button"
              className="btn-theme h-8 px-3 text-sm"
              onClick={() => setInstructions(IMPLEMENTATION_TEMPLATE)}
            >
              插入範本
            </button>
          </div>
          <RichTextEditor
            value={settings.instructions}
            onChange={setInstructions}
            maxLength={4000}
            placeholder="輸入自主學習實施說明…"
            ariaLabel="自主學習實施說明"
          />
        </div>
      </details>

      <details className="border-themed bg-card rounded-lg" open>
        <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
          <DisclosureArrow />
          自主學習計畫撰寫說明
        </summary>
        <div className="space-y-2 px-4 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-t3 text-xs">
              給學生發想新計畫、編輯草稿時的撰寫說明；可使用工具列格式化與編號清單。
            </p>
            <button
              type="button"
              className="btn-theme h-8 px-3 text-sm"
              onClick={() => setWritingInstructions(INSTRUCTIONS_TEMPLATE)}
            >
              插入範本
            </button>
          </div>
          <RichTextEditor
            value={settings.writingInstructions}
            onChange={setWritingInstructions}
            maxLength={4000}
            placeholder="輸入自主學習計畫撰寫說明…"
            ariaLabel="自主學習計畫撰寫說明"
          />
        </div>
      </details>

      {actionButtons}

      {targetViewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.4)] p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reviewer-target-title"
        >
          <div className="border border-themed bg-card w-full max-w-md rounded-xl p-5 shadow-lg">
            <h2 id="reviewer-target-title" className="text-t1 mb-3 font-semibold">
              {targetViewer.name} 的審查對象
            </h2>
            <div className="text-t2 max-h-[60vh] space-y-3 overflow-y-auto text-sm">
              {!targetViewer.classScoped && !targetViewer.studentScoped ? (
                <p>全校</p>
              ) : (
                <>
                  {targetViewer.classScoped && (
                    <div className="space-y-1">
                      <p className="text-t1 font-medium">班級</p>
                      {(targetViewer.classCodes ?? []).length === 0 ? (
                        <p className="text-t3">尚未選擇</p>
                      ) : (
                        <>
                          {classGroups.map(({ grade, classes }) => {
                            const selected = classes.filter((option) =>
                              (targetViewer.classCodes ?? []).includes(option.code)
                            );
                            if (selected.length === 0) return null;
                            return (
                              <p key={grade}>
                                <span className="text-t1">{grade}</span>：
                                {selected.map((option) => option.name || option.code).join("、")}
                              </p>
                            );
                          })}
                          {unknownTargetClassCodes.length > 0 && (
                            <p>
                              <span className="text-t1">其他</span>：
                              {unknownTargetClassCodes.join("、")}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {targetViewer.studentScoped && (
                    <div className="space-y-1">
                      <p className="text-t1 font-medium">個別學生</p>
                      {(targetViewer.students ?? []).length === 0 ? (
                        <p className="text-t3">尚未選擇</p>
                      ) : (
                        <p>
                          {(targetViewer.students ?? [])
                            .map((student) =>
                              `${student.name || student.uid}${
                                student.classCode ? `（${student.classCode}）` : ""
                              }`
                            )
                            .join("、")}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="btn-theme h-9 px-4 text-sm"
                onClick={() => setTargetViewerUid(null)}
              >
                關閉
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRemoveReviewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.4)] p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="reviewer-remove-title"
        >
          <div className="border border-themed bg-card w-full max-w-sm rounded-xl p-5 shadow-lg">
            <h2 id="reviewer-remove-title" className="text-t1 mb-2 font-semibold">
              移除審查人員
            </h2>
            <p className="text-t2 mb-4 text-sm">
              確定要移除「{confirmRemoveReviewer.name}」嗎？移除後將不再出現在審查人員名單。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-theme h-9 px-4 text-sm"
                onClick={() => setConfirmRemoveReviewer(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-theme h-9 px-4 text-sm"
                onClick={() => {
                  removeReviewer(confirmRemoveReviewer.uid);
                  setConfirmRemoveReviewer(null);
                }}
              >
                確定移除
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast message={toast} onClose={() => setToast(null)} />
    </section>
  );
}
