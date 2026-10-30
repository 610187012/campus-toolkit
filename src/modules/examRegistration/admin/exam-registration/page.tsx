"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import RevealListCard from "@/components/RevealListCard";
import { useDataSaver } from "@/lib/data-saver";
import { fetchSession } from "@/lib/session";
import { ConfirmModal } from "../../components/exam-feedback";
import Toast, { type ToastMessage } from "../../components/toast";
import OfficialExamLabel from "../../components/official-exam-label";
import {
  EXAM_CATEGORY_LABELS,
  EXAM_EVENT_LIMITS,
  EXAM_EVENT_STATUS_LABELS,
  EXAM_REGISTRATION_MODE_LABELS,
  effectiveExamStatus,
  formatExamDate,
  formatExamDateRange,
  formatExamDateTime,
  makeSubjectKey,
  parseExamAdvancedOptions,
  parseExamLocationOptions,
} from "../../types/exam-registration";
import type {
  ExamAdvancedOption,
  ExamAnnouncementSync,
  ExamCalendarSync,
  ExamCategory,
  ExamEvent,
  ExamEventRoster,
  ExamEventType,
  ExamLocationOption,
  ExamMode,
  ExamRegistrationMode,
} from "../../types/exam-registration";

interface AdminListResponse {
  success?: boolean;
  message?: string;
  events?: ExamEvent[];
  epoch?: number;
  total?: number;
  roster?: ExamEventRoster;
}

interface FormSubject {
  key: string;
  label: string;
  enableAdvancedOption: boolean;
  advancedOptionsText: string;
  advancedOptionCodeText: string;
  advancedOptionLabelText: string;
  advancedOptions: ExamAdvancedOption[];
  feeStandardText: string;
  feeReducedText: string;
}

interface FormState {
  id?: string;
  title: string;
  examType: ExamCategory;
  examDate: string;
  /** 考試結束日；""＝單日 */
  examEndDate: string;
  deadlineText: string;
  /** 報名開放時間（datetime-local 字串；必填） */
  registrationOpenAtText: string;
  location: string;
  /** 考試地區批次輸入（每行：代碼,考區名稱；僅 entrance） */
  locationOptionsText: string;
  /** 考試地區單筆輸入：代碼（僅 entrance） */
  locationOptionCodeText: string;
  /** 考試地區單筆輸入：名稱（僅 entrance） */
  locationOptionLabelText: string;
  /** 地點選項（僅 entrance；由單筆／批次新增維護） */
  locationOptions: ExamLocationOption[];
  note: string;
  basicFeeStandardText: string;
  basicFeeReducedText: string;
  grades: string[];
  classes: string[];
  subjects: FormSubject[];
  examMode: ExamMode;
  registrationMode: ExamRegistrationMode;
  studentArchiveEnabled: boolean;
  announcementSync: ExamAnnouncementSync;
  calendarSync: ExamCalendarSync;
  status: ExamEventType;
}

function blankFormSubject(existingKeys: string[]): FormSubject {
  return {
    key: makeSubjectKey(new Set(existingKeys)),
    label: "",
    enableAdvancedOption: false,
    advancedOptionsText: "",
    advancedOptionCodeText: "",
    advancedOptionLabelText: "",
    advancedOptions: [],
    feeStandardText: "",
    feeReducedText: "",
  };
}

interface ClassOption {
  code: string;
  name: string;
}

interface ClassesResponse {
  success?: boolean;
  setting?: { grades?: { code: string; name: string; classes?: ClassOption[] }[] };
}

interface HookCategoryOption {
  id: string;
  name: string;
}

interface HookOptionsResponse {
  success?: boolean;
  message?: string;
  announcementCategories?: HookCategoryOption[];
  calendarCategories?: HookCategoryOption[];
}

function emptyForm(): FormState {
  return {
    title: "",
    examType: "mock",
    examDate: "",
    examEndDate: "",
    deadlineText: toDatetimeLocal(defaultDeadline()),
    registrationOpenAtText: "",
    location: "",
    locationOptionsText: "",
    locationOptionCodeText: "",
    locationOptionLabelText: "",
    locationOptions: [],
    note: "",
    basicFeeStandardText: "0",
    basicFeeReducedText: "0",
    grades: [],
    classes: [],
    subjects: [blankFormSubject([])],
    examMode: "review",
    registrationMode: "optional",
    studentArchiveEnabled: false,
    announcementSync: { enabled: true, categoryId: "other", body: "" },
    calendarSync: { enabled: true, categoryId: "other", publishUnit: "", location: "" },
    status: "draft",
  };
}

function defaultDeadline(): number {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}

function toDatetimeLocal(ms: number): string {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDatetimeLocal(value: string): number {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function sanitizeNonNegativeIntegerInput(value: string): string {
  if (value === "") return "";
  return value.replace(/[^\d]/g, "");
}

function splitCodes(value: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const part of value.split(/[,、;；\s]+/)) {
    const code = part.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    list.push(code);
  }
  return list;
}

function joinCodes(value: string[]): string {
  return value.join(", ");
}

function normalizeLocationOptions(options: ExamLocationOption[]): ExamLocationOption[] {
  if (!options.length) return [];
  const defaultIndex = Math.max(
    0,
    options.findIndex((option) => option.isDefault === true)
  );
  return options.map((option, index) => ({
    code: option.code,
    label: option.label,
    ...(index === defaultIndex ? { isDefault: true } : {}),
  }));
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return list;
  next.splice(to, 0, item);
  return next;
}

function parseLocationBatchText(value: string): { ok: true; value: ExamLocationOption[] } | { ok: false; message: string } {
  const lines = value.split(/\r?\n/);
  const list: ExamLocationOption[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    const [rawCode = "", ...labelParts] = line.split(",");
    const code = rawCode.trim();
    const label = labelParts.join(",").trim();
    if (!code || !label) {
      return { ok: false, message: `第 ${index + 1} 行格式需為「代碼,考區名稱」` };
    }
    list.push({ code, label });
  }
  return { ok: true, value: list };
}

function parseAdvancedOptionBatchText(value: string): { ok: true; value: ExamAdvancedOption[] } | { ok: false; message: string } {
  const lines = value.split(/\r?\n/);
  const list: ExamAdvancedOption[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    const [rawCode = "", ...labelParts] = line.split(",");
    const code = rawCode.trim();
    const label = labelParts.join(",").trim();
    if (!code || !label) {
      return { ok: false, message: `第 ${index + 1} 行格式需為「代碼,進階選項」` };
    }
    list.push({ code, label });
  }
  return { ok: true, value: list };
}

function formatLocationOptionError(message: string): string {
  return message.startsWith("地點") ? `考試${message}` : message;
}

function formatNumberedNote(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+\.\s*/, ""));
  return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

function formatListDateTime(value: number): string {
  return formatExamDateTime(value);
}

/** 清單上建議的下一個狀態（與狀態機一致） */
function nextStatusOf(status: ExamEventType): ExamEventType | null {
  if (status === "draft") return "open";
  if (status === "open") return "closed";
  if (status === "closed") return "archived";
  return null;
}

/**
 * 升學考試與模擬考校內報名（僅被指派 examRegistration 的管理員）。
 * 版面：建立／編輯場次（預設收合）→ 場次清單（狀態篩選、狀態轉換、名單）→ 名單與統計。
 * 場次清單依系統「省流開關」：啟用時進頁不載入，按鈕才載入（同公告／行事曆）。
 */
export default function AdminExamRegistrationPage({
  rosterHrefBase = "/admin/exam-registration/roster",
  fill = false,
}: {
  /** 「查看名單」連結前綴；身分功能頁內嵌管理面板時改傳該頁路徑，名單留在同一頁檢視 */
  rosterHrefBase?: string;
  /** 於身分功能頁（content-width）內嵌時填滿容器；/admin 獨立使用維持 max-w-4xl 標準 */
  fill?: boolean;
}) {
  const { ready: settingsReady, saverOn } = useDataSaver();
  // 子權限（managerPermissions）：管理員恆全權；非管理員看 delegatedModules（政策修改書 G3）
  const [canConfigure, setCanConfigure] = useState(true);
  const [permsLoaded, setPermsLoaded] = useState(false);
  const [items, setItems] = useState<ExamEvent[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const gating = saverOn && !listLoaded;
  const [loadingList, setLoadingList] = useState(false);
  const [listCount, setListCount] = useState<number | null>(null);
  const [loadingListCount, setLoadingListCount] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const subjectNameInputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const subjectStandardFeeInputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const subjectReducedFeeInputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const [subjectFocusIndex, setSubjectFocusIndex] = useState<number | null>(null);
  const [studentArchiveHelpOpen, setStudentArchiveHelpOpen] = useState(false);
  const [announcementSyncExpanded, setAnnouncementSyncExpanded] = useState(false);
  const [calendarSyncExpanded, setCalendarSyncExpanded] = useState(false);
  const [announcementSyncHelpOpen, setAnnouncementSyncHelpOpen] = useState(false);
  const [calendarSyncHelpOpen, setCalendarSyncHelpOpen] = useState(false);
  const [classOptions, setClassOptions] = useState<Record<string, ClassOption[]> | null>(null);
  const [hookOptions, setHookOptions] = useState<HookOptionsResponse | null>(null);
  const [loadingHookOptions, setLoadingHookOptions] = useState(false);
  const [hookOptionsError, setHookOptionsError] = useState("");
  const hookOptionsRequestRef = useRef(false);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ExamEventType>("all");
  // 場次清單排序（純前端排序，不增加任何 Firestore 讀取）：預設考試日期由舊到新
  const [sortKey, setSortKey] = useState<"title" | "examDate" | "registrationDate">("examDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // 清單分頁（純前端切片，不增加任何 Firestore 讀取；同帳號／名冊清單）
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [roster, setRoster] = useState<ExamEventRoster | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(false);
  /** 主題化確認框（取代 window.confirm）：text 顯示、danger 決定確定鈕樣式、onConfirm 確定時執行 */
  const [confirm, setConfirm] = useState<{
    text: string;
    danger: boolean;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);

  // 子權限載入：管理員＝全開；非管理員＝delegatedModules 中 examRegistration 的 permissions
  useEffect(() => {
    let cancelled = false;
    fetchSession(true)
      .then((session) => {
        if (cancelled) return;
        if (!session) {
          setCanConfigure(false);
          setPermsLoaded(true);
          return;
        }
        if (session.role === "admin") {
          setCanConfigure(true);
        } else {
          const grant = (session.delegatedModules ?? []).find(
            (item) => item.module === "examRegistration"
          );
          setCanConfigure(Boolean(grant?.permissions.includes("configure")));
        }
        setPermsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setCanConfigure(false);
          setPermsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (subjectFocusIndex === null) return;
    const input = subjectNameInputsRef.current[subjectFocusIndex];
    if (!input) return;
    input.focus();
    setSubjectFocusIndex(null);
  }, [form.subjects.length, subjectFocusIndex]);

  // 年級／班級選項：需「學校基本設定」權限，讀不到就退回手動輸入代碼
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/school/classes", { cache: "no-store" });
        const data: ClassesResponse | null = await res.json().catch(() => null);
        if (cancelled || !res.ok || !data?.success) return;
        const map: Record<string, ClassOption[]> = {};
        for (const grade of data.setting?.grades ?? []) {
          map[grade.code] = grade.classes ?? [];
        }
        setClassOptions(map);
      } catch {
        // 無權限或讀取失敗：改用手動輸入年級／班級代碼
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const shouldLoadAnnouncementCategories =
      formOpen && announcementSyncExpanded && form.announcementSync.enabled && !hookOptions?.announcementCategories;
    const shouldLoadCalendarCategories =
      formOpen && calendarSyncExpanded && form.calendarSync.enabled && !hookOptions?.calendarCategories;
    if ((!shouldLoadAnnouncementCategories && !shouldLoadCalendarCategories) || hookOptionsRequestRef.current) return;

    const scope =
      shouldLoadAnnouncementCategories && shouldLoadCalendarCategories
        ? "both"
        : shouldLoadAnnouncementCategories
          ? "announcement"
          : "calendar";
    hookOptionsRequestRef.current = true;
    setLoadingHookOptions(true);
    setHookOptionsError("");
    void (async () => {
      try {
        const res = await fetch(`/api/admin/exam-registration?hookOptions=1&scope=${scope}`, { cache: "no-store" });
        const data: HookOptionsResponse | null = await res.json().catch(() => null);
        if (!res.ok || !data?.success) throw new Error(data?.message || "讀取公告／行事曆選項失敗");
        const options: HookOptionsResponse = {
          ...(hookOptions ?? {}),
          ...data,
        };
        setHookOptions(options);
        setForm((previous) => ({
          ...previous,
          announcementSync: options.announcementCategories
            ? {
                ...previous.announcementSync,
                categoryId: options.announcementCategories.some(
                  (category) => category.id === previous.announcementSync.categoryId
                )
                  ? previous.announcementSync.categoryId
                  : options.announcementCategories[0]?.id ?? "other",
              }
            : previous.announcementSync,
          calendarSync: options.calendarCategories
            ? {
                ...previous.calendarSync,
                categoryId: options.calendarCategories.some(
                  (category) => category.id === previous.calendarSync.categoryId
                )
                  ? previous.calendarSync.categoryId
                  : options.calendarCategories[0]?.id ?? "other",
              }
            : previous.calendarSync,
        }));
      } catch (error) {
        setHookOptionsError(error instanceof Error ? error.message : "讀取公告／行事曆選項失敗");
      } finally {
        setLoadingHookOptions(false);
        hookOptionsRequestRef.current = false;
      }
    })();
  }, [
    formOpen,
    form.announcementSync.enabled,
    form.calendarSync.enabled,
    announcementSyncExpanded,
    calendarSyncExpanded,
    hookOptions,
  ]);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/admin/exam-registration", { cache: "no-store" });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (data?.success) {
        setItems(data.events ?? []);
        setListCount(data.total ?? data.events?.length ?? 0);
        setListLoaded(true);
      } else {
        setToast({ kind: "error", text: data?.message || "載入場次失敗" });
      }
    } catch {
      setToast({ kind: "error", text: "載入場次失敗" });
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadListCount = useCallback(async () => {
    setLoadingListCount(true);
    try {
      const res = await fetch("/api/admin/exam-registration?summary=count", { cache: "no-store" });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (data?.success && typeof data.total === "number") {
        setListCount(data.total);
      }
    } finally {
      setLoadingListCount(false);
    }
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    if (gating || listLoaded) return;
    void loadList();
  }, [settingsReady, gating, listLoaded, loadList]);

  useEffect(() => {
    if (!settingsReady || !gating) return;
    void loadListCount();
  }, [settingsReady, gating, loadListCount]);

  function applyList(data: AdminListResponse) {
    if (!data.events) return;
    setListCount(data.events.length);
    if (listLoaded) setItems(data.events);
  }

  function addBlankSubjectAndFocus() {
    const nextIndex = form.subjects.length;
    if (nextIndex >= EXAM_EVENT_LIMITS.subjectsMax) return;
    setForm((previous) => ({
      ...previous,
      subjects: [
        ...previous.subjects,
        blankFormSubject(previous.subjects.map((subject) => subject.key)),
      ],
    }));
    setSubjectFocusIndex(nextIndex);
  }

  function handleSubjectEnter(
    event: KeyboardEvent<HTMLInputElement>,
    index: number,
    field: "name" | "standardFee" | "reducedFee"
  ) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (field === "name") {
      const input = subjectStandardFeeInputsRef.current[index];
      input?.focus();
      input?.select();
    } else if (field === "standardFee") {
      const input = subjectReducedFeeInputsRef.current[index];
      input?.focus();
      input?.select();
    } else if (form.subjects.length < EXAM_EVENT_LIMITS.subjectsMax) {
      addBlankSubjectAndFocus();
    }
  }

  function addLocationOption() {
    const code = form.locationOptionCodeText.trim();
    const label = form.locationOptionLabelText.trim();
    if (!code || !label) {
      setToast({ kind: "error", text: "請輸入考試地區代碼與名稱" });
      return;
    }
    const parsed = parseExamLocationOptions([...form.locationOptions, { code, label }]);
    if (!parsed.ok) {
      setToast({ kind: "error", text: formatLocationOptionError(parsed.message) });
      return;
    }
    setForm((prev) => ({
      ...prev,
      locationOptions: normalizeLocationOptions(parsed.value),
      locationOptionCodeText: "",
      locationOptionLabelText: "",
    }));
  }

  function applyLocationBatch() {
    const batch = parseLocationBatchText(form.locationOptionsText);
    if (!batch.ok) {
      setToast({ kind: "error", text: batch.message });
      return;
    }
    if (!batch.value.length) {
      setToast({ kind: "error", text: "請先輸入批次內容" });
      return;
    }
    const parsed = parseExamLocationOptions([...form.locationOptions, ...batch.value]);
    if (!parsed.ok) {
      setToast({ kind: "error", text: formatLocationOptionError(parsed.message) });
      return;
    }
    setForm((prev) => ({
      ...prev,
      locationOptions: normalizeLocationOptions(parsed.value),
      locationOptionsText: "",
    }));
  }

  function removeLocationOption(index: number) {
    setForm((prev) => ({
      ...prev,
      locationOptions: normalizeLocationOptions(prev.locationOptions.filter((_, i) => i !== index)),
    }));
  }

  function editLocationOption(index: number, field: "code" | "label", value: string) {
    setForm((prev) => ({
      ...prev,
      locationOptions: prev.locationOptions.map((option, i) =>
        i === index ? { ...option, [field]: value } : option
      ),
    }));
  }

  function moveLocationOption(index: number, direction: "up" | "down") {
    const target = direction === "up" ? index - 1 : index + 1;
    setForm((prev) => ({
      ...prev,
      locationOptions: normalizeLocationOptions(moveItem(prev.locationOptions, index, target)),
    }));
  }

  function setLocationOptionDefault(index: number) {
    const selected = form.locationOptions[index];
    if (!selected) return;
    setForm((prev) => ({
      ...prev,
      locationOptions: normalizeLocationOptions(
        prev.locationOptions.map((option, i) => ({ ...option, isDefault: i === index }))
      ),
    }));
    setToast({ kind: "success", text: `已將「${selected.label}」設為預設考區` });
  }

  function addAdvancedOption(subjectIndex: number) {
    const subject = form.subjects[subjectIndex];
    if (!subject) return;
    const code = subject.advancedOptionCodeText.trim();
    const label = subject.advancedOptionLabelText.trim();
    if (!code || !label) {
      setToast({ kind: "error", text: "請輸入進階選項代碼與名稱" });
      return;
    }
    const parsed = parseExamAdvancedOptions([...subject.advancedOptions, { code, label }]);
    if (!parsed.ok) {
      setToast({ kind: "error", text: parsed.message });
      return;
    }
    setForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((item, index) =>
        index === subjectIndex
          ? {
              ...item,
              advancedOptions: parsed.value,
              advancedOptionCodeText: "",
              advancedOptionLabelText: "",
            }
          : item
      ),
    }));
  }

  function applyAdvancedOptionBatch(subjectIndex: number) {
    const subject = form.subjects[subjectIndex];
    if (!subject) return;
    const batch = parseAdvancedOptionBatchText(subject.advancedOptionsText);
    if (!batch.ok) {
      setToast({ kind: "error", text: batch.message });
      return;
    }
    if (!batch.value.length) {
      setToast({ kind: "error", text: "請先輸入批次內容" });
      return;
    }
    const parsed = parseExamAdvancedOptions([...subject.advancedOptions, ...batch.value]);
    if (!parsed.ok) {
      setToast({ kind: "error", text: parsed.message });
      return;
    }
    setForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((item, index) =>
        index === subjectIndex
          ? {
              ...item,
              advancedOptions: parsed.value,
              advancedOptionsText: "",
            }
          : item
      ),
    }));
  }

  function removeAdvancedOption(subjectIndex: number, optionIndex: number) {
    setForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((item, index) =>
        index === subjectIndex
          ? { ...item, advancedOptions: item.advancedOptions.filter((_, i) => i !== optionIndex) }
          : item
      ),
    }));
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (!canConfigure) {
      setToast({ kind: "error", text: "此帳號無建立／編輯場次的權限" });
      return;
    }
    if (saving) return;
    const subjects: ExamEvent["subjects"] = [];
    for (const subject of form.subjects) {
      const label = subject.label.trim();
      if (!label) continue;
      const feeStandard = Number(subject.feeStandardText);
      const feeReduced = Number(subject.feeReducedText);
      const entry: ExamEvent["subjects"][number] = {
        key: subject.key,
        label,
      };
      const parsedAdvancedOptions = parseExamAdvancedOptions(subject.advancedOptions);
      if (!parsedAdvancedOptions.ok) {
        setToast({ kind: "error", text: `科目「${label}」的進階選項${parsedAdvancedOptions.message}` });
        return;
      }
      if (subject.enableAdvancedOption) {
        if (!parsedAdvancedOptions.value.length) {
          setToast({ kind: "error", text: `科目「${label}」啟用進階選項時，請至少新增一個進階選項` });
          return;
        }
        entry.enableAdvancedOption = true;
        entry.advancedOptions = parsedAdvancedOptions.value;
      }
      if (subject.feeStandardText.trim() !== "" && Number.isInteger(feeStandard) && feeStandard > 0) {
        entry.feeStandard = feeStandard;
      }
      if (subject.feeReducedText.trim() !== "" && Number.isInteger(feeReduced) && feeReduced > 0) {
        entry.feeReduced = feeReduced;
      }
      subjects.push(entry);
    }
    if (subjects.length < EXAM_EVENT_LIMITS.subjectsMin) {
      setToast({ kind: "error", text: "請至少輸入一個科目名稱" });
      return;
    }
    if (subjects.length > EXAM_EVENT_LIMITS.subjectsMax) {
      setToast({
        kind: "error",
        text: `科目最多 ${EXAM_EVENT_LIMITS.subjectsMax} 項（目前 ${subjects.length} 項）`,
      });
      return;
    }
    if (!form.grades.length) {
      setToast({ kind: "error", text: "請至少指定一個年級" });
      return;
    }
    const deadline = parseDatetimeLocal(form.deadlineText);
    if (!deadline) {
      setToast({ kind: "error", text: "請設定報名截止時間" });
      return;
    }
    if (form.status === "open" && deadline <= Date.now()) {
      setToast({ kind: "error", text: "開放報名狀態的截止時間必須晚於現在" });
      return;
    }
    // 考試結束日須 >= 起日（空＝單日）
    if (form.examEndDate && form.examDate && form.examEndDate < form.examDate) {
      setToast({ kind: "error", text: "考試結束日不可早於開始日" });
      return;
    }
    const registrationOpenAt = parseDatetimeLocal(form.registrationOpenAtText);
    if (!registrationOpenAt) {
      setToast({ kind: "error", text: "請設定報名開放時間" });
      return;
    }
    if (registrationOpenAt >= deadline) {
      setToast({ kind: "error", text: "報名開放時間須早於報名截止時間" });
      return;
    }
    // 考試地區（僅升學考試）
    let locationOptions: ExamLocationOption[] = [];
    let location = form.location;
    if (form.examType === "entrance") {
      const parsedLocationOptions = parseExamLocationOptions(form.locationOptions);
      if (!parsedLocationOptions.ok) {
        setToast({ kind: "error", text: formatLocationOptionError(parsedLocationOptions.message) });
        return;
      }
      locationOptions = normalizeLocationOptions(parsedLocationOptions.value);
      location = "";
    } else {
      location = "";
      locationOptions = [];
    }
    const basicFeeStandard = Number(form.basicFeeStandardText);
    const basicFeeReduced = Number(form.basicFeeReducedText);
    if (!Number.isInteger(basicFeeStandard) || basicFeeStandard < 0 || !Number.isInteger(basicFeeReduced) || basicFeeReduced < 0) {
      setToast({ kind: "error", text: "基本費用數值無效（需 0 以上整數）" });
      return;
    }

    const normalizedNote = formatNumberedNote(form.note);

    setSaving(true);
    setToast(null);
    try {
      const payload = {
        id: form.id,
        title: form.title,
        examType: form.examType,
        examDate: form.examDate,
        examEndDate: form.examEndDate,
        location,
        locationOptions,
        note: normalizedNote,
        deadline,
        registrationOpenAt,
        subjects,
        target: { grades: form.grades, classes: form.classes },
        basicFee: { standard: basicFeeStandard, reduced: basicFeeReduced },
        examMode: "review",
        registrationMode: form.registrationMode,
        studentArchiveEnabled: form.studentArchiveEnabled,
        announcementSync: form.announcementSync,
        calendarSync: form.calendarSync,
        status: form.status,
      };
      const res = await fetch("/api/admin/exam-registration", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "儲存失敗");
      applyList(data);
      setForm(emptyForm());
      setFormOpen(false);
      setRoster(null);
      setToast({ kind: "success", text: data.message || "已儲存" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "儲存失敗" });
    } finally {
      setSaving(false);
    }
  }

  async function patchStatus(item: ExamEvent, status: ExamEventType) {
    if (!canConfigure) {
      setToast({ kind: "error", text: "此帳號無變更場次狀態的權限" });
      return;
    }
    if (saving) return;
    const label = EXAM_EVENT_STATUS_LABELS[status];
    const confirmText =
      status === "open"
        ? `確定要「${label}」？\n開放時會依管理規則設定同步發佈系統公告與行事曆。`
        : status === "archived"
          ? "確定要封存？\n封存後不可再變更狀態。"
          : `確定要將場次改為「${label}」？`;
    setConfirm({
      text: confirmText,
      danger: status === "archived",
      confirmLabel: label,
      onConfirm: () => void runPatchStatus(item, status),
    });
  }

  async function runPatchStatus(item: ExamEvent, status: ExamEventType) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/exam-registration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status }),
      });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "操作失敗");
      applyList(data);
      setRoster((prev) => (prev && prev.eventId === item.id ? null : prev));
      setToast({ kind: "success", text: data.message || "已更新" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "操作失敗" });
    } finally {
      setSaving(false);
    }
  }

  /** 硬刪除場次與該場次所有學生登錄資料（需先確認不可復原） */
  function deleteEvent(item: ExamEvent) {
    if (!canConfigure) {
      setToast({ kind: "error", text: "此帳號無刪除場次的權限" });
      return;
    }
    if (saving) return;
    setConfirm({
      text:
        `確定要刪除「${item.title}」？\n\n` +
        "⚠️ 刪除不可恢復——將連同該場次全部學生登錄名單一併刪除。\n" +
        "若此場次曾「開放報名」，系統公告與學生行事曆不會自動撤回，請到公告管理與行事曆管理另行封存/取消。",
      danger: true,
      confirmLabel: "刪除",
      onConfirm: () => void runDeleteEvent(item),
    });
  }

  async function runDeleteEvent(item: ExamEvent) {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/exam-registration?id=${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "刪除失敗");
      applyList(data);
      setRoster((prev) => (prev && prev.eventId === item.id ? null : prev));
      setForm((prev) => (prev.id === item.id ? emptyForm() : prev));
      if (form.id === item.id) setFormOpen(false);
      setToast({ kind: "success", text: data.message || "已刪除" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "刪除失敗" });
    } finally {
      setSaving(false);
    }
  }

  function edit(item: ExamEvent) {
    const isEntrance = item.examType === "entrance";
    setAnnouncementSyncExpanded(false);
    setCalendarSyncExpanded(false);
    setAnnouncementSyncHelpOpen(false);
    setCalendarSyncHelpOpen(false);
    setForm({
      id: item.id,
      title: item.title,
      examType: item.examType,
      examDate: item.examDate,
      examEndDate: item.examEndDate ?? "",
      deadlineText: toDatetimeLocal(item.deadline),
      registrationOpenAtText: item.registrationOpenAt ? toDatetimeLocal(item.registrationOpenAt) : "",
      location: isEntrance ? item.location : "",
      locationOptionsText: "",
      locationOptionCodeText: "",
      locationOptionLabelText: "",
      locationOptions: isEntrance ? normalizeLocationOptions(item.locationOptions ?? []) : [],
      note: item.note,
      basicFeeStandardText: String(item.basicFee.standard),
      basicFeeReducedText: String(item.basicFee.reduced),
      grades: [...item.target.grades],
      classes: [...item.target.classes],
      subjects: item.subjects.map((subject) => ({
        key: subject.key,
        label: subject.label,
        enableAdvancedOption: subject.enableAdvancedOption === true,
        advancedOptionsText: "",
        advancedOptionCodeText: "",
        advancedOptionLabelText: "",
        advancedOptions: subject.advancedOptions ?? [],
        feeStandardText: subject.feeStandard ? String(subject.feeStandard) : "",
        feeReducedText: subject.feeReduced ? String(subject.feeReduced) : "",
      })),
      examMode: "review",
      registrationMode: item.registrationMode,
      studentArchiveEnabled: item.studentArchiveEnabled,
      announcementSync: { ...item.announcementSync },
      calendarSync: { ...item.calendarSync },
      status: item.status,
    });
    setFormOpen(true);
    setRoster(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setForm(emptyForm());
    setFormOpen(false);
    setAnnouncementSyncExpanded(false);
    setCalendarSyncExpanded(false);
    setAnnouncementSyncHelpOpen(false);
    setCalendarSyncHelpOpen(false);
  }

  async function loadRoster(eventId: string) {
    if (loadingRoster) return;
    setLoadingRoster(true);
    try {
      // stats=1：統計面板需要完整名單與統計（延遲載入改為分頁後，?eventId= 只回班級分頁）
      const res = await fetch(
        `/api/admin/exam-registration?eventId=${encodeURIComponent(eventId)}&stats=1`,
        { cache: "no-store" }
      );
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data.roster) {
        throw new Error(data?.message || "載入名單失敗");
      }
      setRoster(data.roster);
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "載入名單失敗" });
    } finally {
      setLoadingRoster(false);
    }
  }

  function toggleCode(list: string[], code: string): string[] {
    return list.includes(code) ? list.filter((item) => item !== code) : [...list, code];
  }

  function subjectEditor(index: number, label: string) {
    setForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((item, i) => (i === index ? { ...item, label } : item)),
    }));
  }

  function subjectFeeEditor(index: number, field: "feeStandardText" | "feeReducedText", value: string) {
    const sanitized = sanitizeNonNegativeIntegerInput(value);
    setForm((prev) => ({
      ...prev,
      subjects: prev.subjects.map((item, i) => (i === index ? { ...item, [field]: sanitized } : item)),
    }));
  }

  const searchKeyword = keyword.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (!searchKeyword) return true;
      const haystack =
        `${item.title}\n${item.location}\n${(item.locationOptions ?? []).map((o) => `${o.code} ${o.label}`).join("\n")}\n${item.subjects.map((s) => s.label).join("\n")}\n${item.createdBy.name}`.toLowerCase();
      return haystack.includes(searchKeyword);
    });
  }, [items, statusFilter, searchKeyword]);

  // 排序（純前端）：title 用中文 locale 比較；examDate 為 YYYY-MM-DD 字串，字串序即時間序；
  // 報名日期以開放時間為準（未設開放時間者以截止時間計）。Array.sort 穩定，同值保留伺服器原序。
  const sortedItems = useMemo(() => {
    const factor = sortDir === "asc" ? 1 : -1;
    const keyOf = (item: ExamEvent): string | number => {
      if (sortKey === "title") return item.title;
      if (sortKey === "examDate") return item.examDate;
      return item.registrationOpenAt > 0 ? item.registrationOpenAt : item.deadline;
    };
    return [...filteredItems].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (typeof ka === "string" && typeof kb === "string") {
        return factor * ka.localeCompare(kb, "zh-Hant");
      }
      return factor * ((ka as number) - (kb as number));
    });
  }, [filteredItems, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedItems.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedItems = useMemo(
    () => sortedItems.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sortedItems, currentPage, pageSize]
  );

  // 篩選／排序條件變動時回到第一頁
  useEffect(() => {
    setPage(1);
  }, [keyword, statusFilter, sortKey, sortDir]);

  const targetText = (item: ExamEvent) =>
    `${item.target.grades.join("、") || "—"} 年級${
      item.target.classes.length ? `（${item.target.classes.join("、")}）` : "（全年級）"
    }`;
  const announcementCategories = hookOptions?.announcementCategories?.length
    ? hookOptions.announcementCategories
    : [{ id: "other", name: "其他" }];
  const calendarCategories = hookOptions?.calendarCategories?.length
    ? hookOptions.calendarCategories
    : [{ id: "other", name: "其他" }];

  return (
          <div className={`w-full ${fill ? "" : "max-w-4xl"} mb-8 space-y-6`}>
      <Toast message={toast} onClose={() => setToast(null)} />
      {confirm && (
        <ConfirmModal
          text={confirm.text}
          danger={confirm.danger}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => {
            const action = confirm.onConfirm;
            setConfirm(null);
            action();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {/* 1. 建立／編輯場次（預設收合；無 configure 權限不顯示——政策修改書 G3） */}
      {canConfigure && (
      <section className="border border-themed rounded-lg bg-card">
        <button
          type="button"
          onClick={() => {
            if (formOpen) {
              cancelEdit();
              return;
            }
            setAnnouncementSyncExpanded(false);
            setCalendarSyncExpanded(false);
            setAnnouncementSyncHelpOpen(false);
            setCalendarSyncHelpOpen(false);
            setFormOpen(true);
          }}
          aria-expanded={formOpen}
          className="w-full flex items-center justify-between px-5 py-4 text-left cursor-pointer"
        >
          <h3 className="text-lg font-bold text-t1">{form.id ? "編輯場次" : "建立場次"}</h3>
          <span className="text-t3 text-sm shrink-0">
            {formOpen ? "收合" : "展開"} {formOpen ? "▲" : "▼"}
          </span>
        </button>
        {formOpen && (
          <div className="px-5 pt-2.5 pb-5">
            <form onSubmit={submitForm} className="space-y-3">
              <section className="rounded-lg border border-themed bg-card p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-t1">管理規則</h4>
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full text-t3 hover:text-t1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                    aria-label="管理規則說明"
                    aria-expanded={studentArchiveHelpOpen}
                    aria-controls="student-archive-help"
                    onClick={() => setStudentArchiveHelpOpen((open) => !open)}
                  >
                    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
                      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
                      <path
                        d="M7.9 7.45a2.15 2.15 0 1 1 3.56 1.62c-.86.73-1.46 1.12-1.46 2.43M10 14.35v.1"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
                <p id="student-archive-help" className="text-xs text-t3" hidden={!studentArchiveHelpOpen}>
                  啟用後，學生完成報名即可自行封存資料；封存後不能修改或取消，若需更動，須由承辦師長在名單中解除封存。
                </p>
                <label className="inline-flex items-center gap-2 text-sm text-t1">
                  <input
                    type="checkbox"
                    checked={form.studentArchiveEnabled}
                    onChange={(e) => setForm({ ...form, studentArchiveEnabled: e.target.checked })}
                  />
                  啟用學生報名後資料封存
                </label>

                <div className="border-t border-themed pt-3 space-y-3">
                  <p className="text-xs text-t3">
                    同步設定會隨場次儲存，場次轉為開放時依勾選發布；維持開放編輯不會重發公告，關閉同步不會撤回已發布項目。
                  </p>
                  <div className="rounded-md border border-themed p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <label className="inline-flex items-center gap-2 text-sm font-medium text-t1">
                          <input
                            type="checkbox"
                            checked={form.announcementSync.enabled}
                            onChange={(e) =>
                              setForm((previous) => ({
                                ...previous,
                                announcementSync: { ...previous.announcementSync, enabled: e.target.checked },
                              }))
                            }
                          />
                          同步發送系統公告
                        </label>
                        <button
                          type="button"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-t3 hover:text-t1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                          aria-label="同步發送系統公告說明"
                          aria-expanded={announcementSyncHelpOpen}
                          aria-controls="exam-announcement-sync-help"
                          onClick={() => setAnnouncementSyncHelpOpen((open) => !open)}
                        >
                          ?
                        </button>
                      </div>
                      <button
                        type="button"
                        className="text-xs text-t2 hover:text-t1"
                        aria-expanded={announcementSyncExpanded}
                        aria-controls="exam-announcement-sync-settings"
                        onClick={() => setAnnouncementSyncExpanded((open) => !open)}
                      >
                        {announcementSyncExpanded ? "收合設定 ▲" : "展開設定 ▼"}
                      </button>
                    </div>
                    <p
                      id="exam-announcement-sync-help"
                      className="text-xs text-t3"
                      hidden={!announcementSyncHelpOpen}
                    >
                      場次轉為開放時，依所選分類發送公告。可自訂公告內容；留空時會自動帶入場次資訊。
                    </p>
                    <div
                      id="exam-announcement-sync-settings"
                      className="ml-6 space-y-2 rounded-md border border-themed p-3"
                      hidden={!announcementSyncExpanded}
                    >
                      {!form.announcementSync.enabled ? (
                        <p className="text-xs text-t3">勾選「同步發送系統公告」後即可設定分類與內容。</p>
                      ) : (
                        <>
                            <label className="block space-y-1 text-sm text-t2" htmlFor="exam-announcement-category">
                              <span>公告分類</span>
                              <select
                                id="exam-announcement-category"
                                className="input-theme w-full rounded px-3 py-2"
                                value={form.announcementSync.categoryId}
                                onChange={(e) =>
                                  setForm((previous) => ({
                                    ...previous,
                                    announcementSync: { ...previous.announcementSync, categoryId: e.target.value },
                                  }))
                                }
                              >
                                {announcementCategories.map((category) => (
                                  <option key={category.id} value={category.id}>
                                    {category.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="block space-y-1 text-sm text-t2" htmlFor="exam-announcement-body">
                              <span>公告內容（留空時自動帶入場次資訊）</span>
                              <textarea
                                id="exam-announcement-body"
                                className="input-theme w-full rounded px-3 py-2"
                                rows={4}
                                maxLength={2000}
                                value={form.announcementSync.body}
                                onChange={(e) =>
                                  setForm((previous) => ({
                                    ...previous,
                                    announcementSync: { ...previous.announcementSync, body: e.target.value },
                                  }))
                                }
                                placeholder="留空時自動包含報名期間、考試日期、科目與適用對象"
                              />
                            </label>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="rounded-md border border-themed p-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <label className="inline-flex items-center gap-2 text-sm font-medium text-t1">
                          <input
                            type="checkbox"
                            checked={form.calendarSync.enabled}
                            onChange={(e) =>
                              setForm((previous) => ({
                                ...previous,
                                calendarSync: { ...previous.calendarSync, enabled: e.target.checked },
                              }))
                            }
                          />
                          同步發布至行事曆
                        </label>
                        <button
                          type="button"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-t3 hover:text-t1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                          aria-label="同步發布至行事曆說明"
                          aria-expanded={calendarSyncHelpOpen}
                          aria-controls="exam-calendar-sync-help"
                          onClick={() => setCalendarSyncHelpOpen((open) => !open)}
                        >
                          ?
                        </button>
                      </div>
                      <button
                        type="button"
                        className="text-xs text-t2 hover:text-t1"
                        aria-expanded={calendarSyncExpanded}
                        aria-controls="exam-calendar-sync-settings"
                        onClick={() => setCalendarSyncExpanded((open) => !open)}
                      >
                        {calendarSyncExpanded ? "收合設定 ▲" : "展開設定 ▼"}
                      </button>
                    </div>
                    <p id="exam-calendar-sync-help" className="text-xs text-t3" hidden={!calendarSyncHelpOpen}>
                      場次轉為開放時建立或更新行事曆項目。可自訂發佈單位、地點和類型；地點留空時沿用場次地點。
                    </p>
                    <div
                      id="exam-calendar-sync-settings"
                      className="ml-6 space-y-2 rounded-md border border-themed p-3"
                      hidden={!calendarSyncExpanded}
                    >
                      {!form.calendarSync.enabled ? (
                        <p className="text-xs text-t3">勾選「同步發布至行事曆」後即可設定發佈資訊。</p>
                      ) : (
                        <>
                            <label className="block space-y-1 text-sm text-t2" htmlFor="exam-calendar-unit">
                              <span>發佈單位</span>
                              <input
                                id="exam-calendar-unit"
                                className="input-theme w-full rounded px-3 py-2"
                                maxLength={64}
                                value={form.calendarSync.publishUnit}
                                onChange={(e) =>
                                  setForm((previous) => ({
                                    ...previous,
                                    calendarSync: { ...previous.calendarSync, publishUnit: e.target.value },
                                  }))
                                }
                                placeholder="例如：教務處（可留空）"
                              />
                            </label>
                            <label className="block space-y-1 text-sm text-t2" htmlFor="exam-calendar-location">
                              <span>行事曆地點</span>
                              <input
                                id="exam-calendar-location"
                                className="input-theme w-full rounded px-3 py-2"
                                maxLength={EXAM_EVENT_LIMITS.location}
                                value={form.calendarSync.location}
                                onChange={(e) =>
                                  setForm((previous) => ({
                                    ...previous,
                                    calendarSync: { ...previous.calendarSync, location: e.target.value },
                                  }))
                                }
                                placeholder="留空時沿用場次的考試地點"
                              />
                            </label>
                            <label className="block space-y-1 text-sm text-t2" htmlFor="exam-calendar-category">
                              <span>行事曆類型</span>
                              <select
                                id="exam-calendar-category"
                                className="input-theme w-full rounded px-3 py-2"
                                value={form.calendarSync.categoryId}
                                onChange={(e) =>
                                  setForm((previous) => ({
                                    ...previous,
                                    calendarSync: { ...previous.calendarSync, categoryId: e.target.value },
                                  }))
                                }
                              >
                                {calendarCategories.map((category) => (
                                  <option key={category.id} value={category.id}>
                                    {category.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                        </>
                      )}
                    </div>
                  </div>

                  {loadingHookOptions && <p className="ml-6 text-xs text-t3">載入公告分類與行事曆類型…</p>}
                  {hookOptionsError && <p className="ml-6 text-xs text-danger">{hookOptionsError}</p>}
                </div>
              </section>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="exam-title">
                  場次名稱
                </label>
                <input
                  id="exam-title"
                  className="flex-1 input-theme rounded px-3 py-2"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                  maxLength={EXAM_EVENT_LIMITS.title}
                  placeholder="例如：115 學年度模擬考（第一次）"
                />
              </div>

              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <label className="text-t2 sm:w-40 shrink-0 sm:pt-2" htmlFor="exam-type">
                  考試類型
                </label>
                <div className="flex-1 space-y-1.5">
                  <select
                    id="exam-type"
                    className="w-full input-theme rounded px-3 py-2"
                    value={form.examType}
                    onChange={(e) => {
                      const examType = e.target.value as ExamCategory;
                      setForm({
                        ...form,
                        examType,
                        ...(examType !== "entrance"
                          ? {
                              location: "",
                              locationOptions: [],
                              locationOptionsText: "",
                              locationOptionCodeText: "",
                              locationOptionLabelText: "",
                            }
                          : {}),
                      });
                    }}
                  >
                    {(Object.keys(EXAM_CATEGORY_LABELS) as ExamCategory[]).map((key) => (
                      <option key={key} value={key}>
                        {EXAM_CATEGORY_LABELS[key]}
                      </option>
                    ))}
                  </select>
                  {form.examType === "entrance" && (
                    <div className="text-xs text-t3 space-y-1">
                      <p>
                        為取得官方報名資料上傳用檔案，建議使用正式名稱，以便程式能下載正確的報名資料檔案。
                        目前各級學校升學考試正式名稱常見如下：
                      </p>
                      <ul className="list-disc pl-5 space-y-0.5">
                        <li>學科能力測驗</li>
                        <li>高中英語聽力測驗第一次考試</li>
                        <li>高中英語聽力測驗第二次考試</li>
                        <li>統一測驗</li>
                        <li>分科測驗</li>
                        <li>大學術科考試音樂組</li>
                        <li>大學術科考試美術組</li>
                        <li>大學術科考試體育組</li>
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="exam-date">
                  考試日期
                </label>
                <div className="flex-1 flex items-center gap-2">
                  <input
                    id="exam-date"
                    type="date"
                    className="input-theme rounded px-3 py-2"
                    value={form.examDate}
                    onChange={(e) => setForm({ ...form, examDate: e.target.value })}
                    required
                  />
                  <span className="text-t3 text-sm shrink-0">～</span>
                  <input
                    type="date"
                    className="input-theme rounded px-3 py-2"
                    value={form.examEndDate}
                    min={form.examDate || undefined}
                    onChange={(e) => setForm({ ...form, examEndDate: e.target.value })}
                    aria-label="考試結束日（留空＝單日）"
                    placeholder="結束日"
                  />
                  <span className="text-xs text-t3 shrink-0">訖（留空＝單日）</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="exam-open-at">
                  報名期間
                </label>
                <div className="flex-1 flex items-center gap-2">
                  <input
                    id="exam-open-at"
                    type="datetime-local"
                    className="input-theme rounded px-3 py-2"
                    value={form.registrationOpenAtText}
                    onChange={(e) => setForm({ ...form, registrationOpenAtText: e.target.value })}
                    required
                  />
                  <span className="text-t3 text-sm shrink-0">～</span>
                  <input
                    id="exam-deadline"
                    type="datetime-local"
                    className="input-theme rounded px-3 py-2"
                    value={form.deadlineText}
                    onChange={(e) => setForm({ ...form, deadlineText: e.target.value })}
                    required
                  />
                  <span className="text-xs text-t3 shrink-0">開放與截止皆為必填</span>
                </div>
              </div>

              {form.examType === "entrance" && (
                <>
                <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                  <label className="text-t2 sm:w-40 shrink-0" htmlFor="exam-location-option-code">
                    考試地區
                  </label>
                  <div className="flex-1 space-y-2">
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-t2">單筆新增</div>
                      <div className="space-y-2">
                        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                          <input
                            id="exam-location-option-code"
                            className="input-theme rounded px-3 py-2"
                            value={form.locationOptionCodeText}
                            onChange={(e) => setForm({ ...form, locationOptionCodeText: e.target.value })}
                            placeholder="代碼（例：100）"
                            maxLength={EXAM_EVENT_LIMITS.locationCode}
                          />
                          <input
                            className="input-theme rounded px-3 py-2 min-w-0"
                            value={form.locationOptionLabelText}
                            onChange={(e) => setForm({ ...form, locationOptionLabelText: e.target.value })}
                            placeholder="考區名稱（例：台北）"
                            maxLength={EXAM_EVENT_LIMITS.locationLabel}
                          />
                        </div>
                        <button
                          type="button"
                          className="btn-theme px-3 py-2 rounded text-sm shrink-0"
                          onClick={addLocationOption}
                        >
                          + 新增考區
                        </button>
                      </div>
                      {form.locationOptions.length > 0 ? (
                        <div className="space-y-1">
                          {form.locationOptions.map((option, index) => (
                            <div key={index} className="flex items-center gap-2 text-sm">
                              <span className="text-t3 w-5 text-right">{index + 1}</span>
                              <input
                                className="input-theme rounded px-2 py-1 w-24"
                                value={option.code}
                                onChange={(e) => editLocationOption(index, "code", e.target.value)}
                                maxLength={EXAM_EVENT_LIMITS.locationCode}
                                aria-label={`第 ${index + 1} 考區代碼`}
                              />
                              <input
                                className="input-theme rounded px-2 py-1 flex-1"
                                value={option.label}
                                onChange={(e) => editLocationOption(index, "label", e.target.value)}
                                maxLength={EXAM_EVENT_LIMITS.locationLabel}
                                aria-label={`第 ${index + 1} 考區名稱`}
                              />
                              <button
                                type="button"
                                className={`px-2 py-1 rounded shrink-0 ${
                                  option.isDefault ? "btn-theme" : "btn-soft"
                                }`}
                                onClick={() => setLocationOptionDefault(index)}
                                aria-label={option.isDefault ? `預設考區：${option.label}` : `將 ${option.label} 設為預設`}
                                title={option.isDefault ? "目前預設" : "設為預設"}
                              >
                                {option.isDefault ? (
                                  <svg viewBox="0 0 20 20" className="w-4 h-4" aria-hidden="true">
                                    <path
                                      d="M10 2.4L12.35 7.16L17.6 7.92L13.8 11.63L14.7 16.86L10 14.39L5.3 16.86L6.2 11.63L2.4 7.92L7.65 7.16L10 2.4Z"
                                      fill="currentColor"
                                    />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 20 20" className="w-4 h-4" aria-hidden="true">
                                    <path
                                      d="M10 2.4L12.35 7.16L17.6 7.92L13.8 11.63L14.7 16.86L10 14.39L5.3 16.86L6.2 11.63L2.4 7.92L7.65 7.16L10 2.4Z"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.6"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                )}
                              </button>
                              <button
                                type="button"
                                className="text-t3 hover:text-t1 shrink-0"
                                onClick={() => moveLocationOption(index, "up")}
                                disabled={index === 0}
                                aria-label={`上移 ${option.label}`}
                                title="上移"
                              >
                                <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4" aria-hidden="true">
                                  <path d="M10 4L4 10H8V16H12V10H16L10 4Z" fill="currentColor" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="text-t3 hover:text-t1 shrink-0"
                                onClick={() => moveLocationOption(index, "down")}
                                disabled={index === form.locationOptions.length - 1}
                                aria-label={`下移 ${option.label}`}
                                title="下移"
                              >
                                <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4" aria-hidden="true">
                                  <path d="M10 16L16 10H12V4H8V10H4L10 16Z" fill="currentColor" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="text-danger/80 hover:text-danger shrink-0"
                                onClick={() => removeLocationOption(index)}
                                aria-label={`刪除 ${option.label}`}
                                title="刪除"
                              >
                                <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4" aria-hidden="true">
                                  <path
                                    d="M7 3.5H13L14 5H17V7H3V5H6L7 3.5ZM5 8H15L14.2 16.2C14.15 16.75 13.69 17.17 13.14 17.17H6.86C6.31 17.17 5.85 16.75 5.8 16.2L5 8ZM8 10V15H9.5V10H8ZM10.5 10V15H12V10H10.5Z"
                                    fill="currentColor"
                                  />
                                </svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-t3">尚未新增考區（可留空，表示試場由主辦單位分配）</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-t2">批次新增</div>
                    <textarea
                      id="exam-location-options-text"
                      className="w-full input-theme rounded px-3 py-2 min-h-24"
                      value={form.locationOptionsText}
                      onChange={(e) => setForm({ ...form, locationOptionsText: e.target.value })}
                      placeholder={"110,臺北\n250,板橋、土城"}
                    />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          className="btn-theme px-3 py-1.5 rounded text-xs"
                          onClick={applyLocationBatch}
                        >
                          套用為單筆新增
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-t3">
                      單筆新增與批次新增會合併，不可重複；每行一筆格式「代碼,考區名稱」
                    </p>
                  </div>
                </div>
                </>
              )}

              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="exam-note">
                  備註（選填）
                </label>
                <textarea
                  id="exam-note"
                  className="flex-1 input-theme rounded px-3 py-2 min-h-20"
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  maxLength={EXAM_EVENT_LIMITS.note}
                />
              </div>
              <div className="flex flex-col sm:flex-row sm:items-start gap-2 -mt-1">
                <span className="text-t2 sm:w-40 shrink-0" />
                <p className="text-xs text-t3 flex-1">
                  說明：按 Enter 斷行後，系統會自動依序編號為 1.、2.、3.…
                </p>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <span className="text-t2 sm:w-40 shrink-0">基本費用</span>
                <div className="flex-1 flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-1.5 text-sm text-t1">
                    一般生
                    <input
                      type="number"
                      min={0}
                      max={EXAM_EVENT_LIMITS.fee}
                      step={1}
                      inputMode="numeric"
                      className="input-theme rounded px-2 py-1 w-24"
                      value={form.basicFeeStandardText}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          basicFeeStandardText: sanitizeNonNegativeIntegerInput(e.target.value),
                        })
                      }
                      aria-label="基本費用（一般生）"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-sm text-t1">
                    中低收入戶
                    <input
                      type="number"
                      min={0}
                      max={EXAM_EVENT_LIMITS.fee}
                      step={1}
                      inputMode="numeric"
                      className="input-theme rounded px-2 py-1 w-24"
                      value={form.basicFeeReducedText}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          basicFeeReducedText: sanitizeNonNegativeIntegerInput(e.target.value),
                        })
                      }
                      aria-label="基本費用（中低收入戶）"
                    />
                  </label>
                  <span className="text-xs text-t3">低收入戶免繳</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-start gap-2 -mt-1">
                <span className="text-t2 sm:w-40 shrink-0" />
                <p className="text-xs text-t3 flex-1">
                  僅能填寫 0 或正整數，不收基本費時填0
                </p>
              </div>

              {/* 適用對象：年級（必填）＋班級（選填＝全年級） */}
              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <span className="text-t2 sm:w-40 shrink-0">適用對象</span>
                <div className="flex-1 space-y-3">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-t2">年級</div>
                    {classOptions ? (
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {Object.entries(classOptions).map(([code, classes]) => (
                          <label
                            key={code}
                            className="inline-flex items-center gap-1.5 text-sm text-t1"
                            title={`班級：${classes.map((item) => item.name).join("、") || "尚未設定"}`}
                          >
                            <input
                              type="checkbox"
                              checked={form.grades.includes(code)}
                              onChange={() =>
                                setForm({ ...form, grades: toggleCode(form.grades, code) })
                              }
                            />
                            {code}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <input
                        className="w-full input-theme rounded px-3 py-2"
                        value={joinCodes(form.grades)}
                        onChange={(e) => setForm({ ...form, grades: splitCodes(e.target.value) })}
                        placeholder="年級代碼，例：1, 2, 3"
                      />
                    )}
                    <p className="text-xs text-t3">
                      年級代碼須與名冊「年級」欄一致；未取得班級清單時可直接輸入代碼（逗號分隔）
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-medium text-t2">班級</div>
                    {classOptions && Object.keys(classOptions).length ? (
                      <div className="space-y-2">
                        {form.grades.map((gradeCode) => (
                          <div key={gradeCode} className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-t2 w-8 shrink-0">{gradeCode}</span>
                            {(classOptions[gradeCode] ?? []).map((item) => (
                              <label
                                key={item.code}
                                className="inline-flex items-center gap-1 text-xs text-t1"
                              >
                                <input
                                  type="checkbox"
                                  checked={form.classes.includes(item.code)}
                                  onChange={() =>
                                    setForm({ ...form, classes: toggleCode(form.classes, item.code) })
                                  }
                                />
                                {item.name}
                              </label>
                            ))}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <input
                        className="w-full input-theme rounded px-3 py-2"
                        value={joinCodes(form.classes)}
                        onChange={(e) => setForm({ ...form, classes: splitCodes(e.target.value) })}
                        placeholder="班級代碼，例：101, 102（留空＝該年級全體）"
                      />
                    )}
                    <p className="text-xs text-t3">未勾選＝該年級全體；勾選＝僅這些班可見</p>
                  </div>
                </div>
              </div>

              {/* 科目（1～15 項） */}
              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <span className="text-t2 sm:w-40 shrink-0">選考科目</span>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-t2">
                    <span className="w-5 shrink-0" />
                    <span className="w-[150px] shrink-0">科目名稱</span>
                    <span className="w-[72px] shrink-0 text-center">進階選項</span>
                    <span className="w-[75px] shrink-0">一般生</span>
                    <span className="w-[75px] shrink-0">中低收入戶</span>
                    <span className="w-10 shrink-0" />
                  </div>
                  {form.subjects.map((subject, index) => (
                    <div key={subject.key} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-t3 w-5 shrink-0 text-center">{index + 1}</span>
                        <input
                          ref={(element) => {
                            subjectNameInputsRef.current[index] = element;
                          }}
                          className="h-8 w-[150px] min-w-0 input-theme rounded px-2 py-1"
                          value={subject.label}
                          onChange={(e) => subjectEditor(index, e.target.value)}
                          onKeyDown={(event) => handleSubjectEnter(event, index, "name")}
                          maxLength={EXAM_EVENT_LIMITS.subjectLabel}
                          placeholder="例：國文"
                          aria-label={`第 ${index + 1} 科科目名稱`}
                        />
                        <label className="w-[72px] shrink-0 inline-flex justify-center">
                          <input
                            type="checkbox"
                            checked={subject.enableAdvancedOption}
                            onChange={(e) =>
                              setForm((prev) => ({
                                ...prev,
                                subjects: prev.subjects.map((item, i) =>
                                  i === index ? { ...item, enableAdvancedOption: e.target.checked } : item
                                ),
                              }))
                            }
                            aria-label={`第 ${index + 1} 科啟用進階選項`}
                          />
                        </label>
                        <input
                          ref={(element) => {
                            subjectStandardFeeInputsRef.current[index] = element;
                          }}
                          type="number"
                          min={0}
                          max={EXAM_EVENT_LIMITS.fee}
                          className="h-8 input-theme rounded px-2 py-1 w-[75px] text-xs"
                          value={subject.feeStandardText || "0"}
                          onChange={(e) => subjectFeeEditor(index, "feeStandardText", e.target.value)}
                          onKeyDown={(event) => handleSubjectEnter(event, index, "standardFee")}
                          aria-label={`第 ${index + 1} 科一般生費用`}
                        />
                        <input
                          ref={(element) => {
                            subjectReducedFeeInputsRef.current[index] = element;
                          }}
                          type="number"
                          min={0}
                          max={EXAM_EVENT_LIMITS.fee}
                          className="h-8 input-theme rounded px-2 py-1 w-[75px] text-xs"
                          value={subject.feeReducedText || "0"}
                          onChange={(e) => subjectFeeEditor(index, "feeReducedText", e.target.value)}
                          onKeyDown={(event) => handleSubjectEnter(event, index, "reducedFee")}
                          aria-label={`第 ${index + 1} 科中低收入戶費用`}
                        />
                        <button
                          type="button"
                          className="text-xs text-t3 hover:text-danger cursor-pointer px-1 w-10 shrink-0"
                          disabled={form.subjects.length <= 1}
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              subjects: prev.subjects.filter((_, i) => i !== index),
                            }))
                          }
                        >
                          刪除
                        </button>
                      </div>
                      {subject.enableAdvancedOption && (
                        <div className="ml-7 rounded border border-themed p-2 space-y-2">
                          <div className="text-xs font-medium text-t2">第 {index + 1} 科進階選項</div>
                          <div className="space-y-2">
                            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                              <input
                                className="h-8 input-theme rounded px-2 py-1 text-xs"
                                value={subject.advancedOptionCodeText}
                                onChange={(e) =>
                                  setForm((prev) => ({
                                    ...prev,
                                    subjects: prev.subjects.map((item, i) =>
                                      i === index ? { ...item, advancedOptionCodeText: e.target.value } : item
                                    ),
                                  }))
                                }
                                placeholder="代碼（例：0101）"
                                maxLength={EXAM_EVENT_LIMITS.advancedOptionCode}
                              />
                              <input
                                className="h-8 input-theme rounded px-2 py-1 min-w-0 text-xs"
                                value={subject.advancedOptionLabelText}
                                onChange={(e) =>
                                  setForm((prev) => ({
                                    ...prev,
                                    subjects: prev.subjects.map((item, i) =>
                                      i === index ? { ...item, advancedOptionLabelText: e.target.value } : item
                                    ),
                                  }))
                                }
                                placeholder="進階選項（例：鋼琴）"
                                maxLength={EXAM_EVENT_LIMITS.advancedOptionLabel}
                              />
                            </div>
                            <button
                              type="button"
                              className="btn-theme h-8 px-3 py-1 rounded text-xs shrink-0"
                              onClick={() => addAdvancedOption(index)}
                            >
                              + 新增進階選項
                            </button>
                          </div>
                          {subject.advancedOptions.length > 0 ? (
                            <div className="space-y-1">
                              {subject.advancedOptions.map((option, optionIndex) => (
                                <div key={option.code} className="flex items-center gap-2 text-xs">
                                  <span className="text-t3 w-5 text-right">{optionIndex + 1}</span>
                                  <input
                                    className="h-8 input-theme rounded px-2 py-1 w-24"
                                    value={option.code}
                                    readOnly
                                    aria-label={`第 ${index + 1} 科進階選項代碼 ${option.code}`}
                                  />
                                  <input
                                    className="h-8 input-theme rounded px-2 py-1 flex-1"
                                    value={option.label}
                                    readOnly
                                    aria-label={`第 ${index + 1} 科進階選項名稱 ${option.label}`}
                                  />
                                  <button
                                    type="button"
                                    className="text-danger/80 hover:text-danger shrink-0"
                                    onClick={() => removeAdvancedOption(index, optionIndex)}
                                    aria-label={`刪除第 ${index + 1} 科進階選項 ${option.label}`}
                                    title="刪除"
                                  >
                                    <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4" aria-hidden="true">
                                      <path
                                        d="M7 3.5H13L14 5H17V7H3V5H6L7 3.5ZM5 8H15L14.2 16.2C14.15 16.75 13.69 17.17 13.14 17.17H6.86C6.31 17.17 5.85 16.75 5.8 16.2L5 8ZM8 10V15H9.5V10H8ZM10.5 10V15H12V10H10.5Z"
                                        fill="currentColor"
                                      />
                                    </svg>
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-t3">尚未新增進階選項</p>
                          )}
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-t2">批次新增</div>
                            <textarea
                              className="w-full input-theme rounded px-2 py-1 min-h-20 text-xs"
                              value={subject.advancedOptionsText}
                              onChange={(e) =>
                                setForm((prev) => ({
                                  ...prev,
                                  subjects: prev.subjects.map((item, i) =>
                                    i === index ? { ...item, advancedOptionsText: e.target.value } : item
                                  ),
                                }))
                              }
                              placeholder={"0101,鋼琴\n0301,聲樂"}
                            />
                            <div className="flex justify-end">
                              <button
                                type="button"
                                className="btn-theme h-8 px-3 py-1 rounded text-xs"
                                onClick={() => applyAdvancedOptionBatch(index)}
                              >
                                套用為單筆新增
                              </button>
                            </div>
                          </div>
                          <p className="text-xs text-t3">
                            第 {index + 1} 科：單筆新增與批次新增會合併，不可重複；每行一筆格式「代碼,進階選項」
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="btn-soft rounded px-3 py-1 text-xs cursor-pointer disabled:opacity-50"
                      disabled={form.subjects.length >= EXAM_EVENT_LIMITS.subjectsMax}
                      onClick={addBlankSubjectAndFocus}
                    >
                      ＋ 新增科目
                    </button>
                    <span className="text-xs text-t3">
                      {form.subjects.length} / {EXAM_EVENT_LIMITS.subjectsMax}
                    </span>
                  </div>
                  <p className="text-xs text-t3">僅能填寫 0 或正整數</p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="exam-reg-mode">
                  報名方式
                </label>
                <div className="flex-1">
                  <select
                    id="exam-reg-mode"
                    className="w-full input-theme rounded px-3 py-2 sm:max-w-56"
                    value={form.registrationMode}
                    onChange={(e) =>
                      setForm({ ...form, registrationMode: e.target.value as ExamRegistrationMode })
                    }
                  >
                    {(Object.keys(EXAM_REGISTRATION_MODE_LABELS) as ExamRegistrationMode[]).map((key) => (
                      <option key={key} value={key}>
                        {EXAM_REGISTRATION_MODE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-t3 mt-1">
                    必須報名時，堅決不報名的學生須至報名頁面點選"不報名並說明理由"
                  </p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="exam-status">
                  狀態
                </label>
                <select
                  id="exam-status"
                  className="flex-1 input-theme rounded px-3 py-2 sm:max-w-56"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as ExamEventType })}
                >
                  {(Object.keys(EXAM_EVENT_STATUS_LABELS) as ExamEventType[]).map((key) => (
                    <option key={key} value={key}>
                      {EXAM_EVENT_STATUS_LABELS[key]}
                    </option>
                  ))}
                </select>
                {form.id && (
                  <p className="text-xs text-t3 sm:ml-2">
                    狀態轉換受狀態機限制（草稿 → 開放 ⇄ 截止 → 封存）
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
                >
                  {saving ? "儲存中..." : form.id ? "儲存變更" : "建立場次"}
                </button>
                {form.id && (
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="btn-soft rounded-lg px-4 py-2 text-sm cursor-pointer"
                  >
                    取消編輯
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </section>
      )}

      {/* 2. 場次清單 */}
      <section className="border border-themed rounded-lg bg-card">
        <div className="px-5 py-4 border-b border-themed flex flex-wrap items-center gap-3">
          <h3 className="text-lg font-bold text-t1">場次清單</h3>
          <input
            className="input-theme rounded px-2 py-1 text-sm flex-1 min-w-40"
            value={keyword}
            onChange={(e) => {
              const value = e.target.value;
              setKeyword(value);
              // 省流閘門外搜尋：輸入即載入清單，載入後再本機過濾（與公告／行事曆一致）
              if (value && gating) void loadList();
            }}
            placeholder="搜尋名稱、地點、科目、建立者"
          />
          <select
            className="input-theme rounded px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | ExamEventType)}
            aria-label="狀態篩選"
          >
            <option value="all">全部狀態</option>
            {(Object.keys(EXAM_EVENT_STATUS_LABELS) as ExamEventType[]).map((key) => (
              <option key={key} value={key}>
                {EXAM_EVENT_STATUS_LABELS[key]}
              </option>
            ))}
          </select>
        </div>

        {/* 排序列：省流閘門解除後才顯示（列表已載入才有排序意義） */}
        {!gating && (
          <div className="px-5 py-3 border-b border-themed flex flex-wrap items-center gap-3">
            <span className="text-sm text-t2">排序</span>
            <select
              className="input-theme rounded px-2 py-1 text-sm"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as "title" | "examDate" | "registrationDate")}
              aria-label="排序欄位"
            >
              <option value="examDate">考試日期</option>
              <option value="registrationDate">報名日期</option>
              <option value="title">場次</option>
            </select>
            <button
              type="button"
              onClick={() => setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))}
              aria-label={sortDir === "asc" ? "切換為由新到舊" : "切換為由舊到新"}
              className="btn-theme rounded px-2 py-1 text-sm shrink-0"
            >
              {sortDir === "asc" ? "↑ 舊到新" : "↓ 新到舊"}
            </button>
          </div>
        )}

        <div className="border-t border-themed overflow-x-auto">
          {gating ? (
            <RevealListCard
              label="場次"
              onReveal={() => void loadList()}
              summary={loadingListCount ? "目前顯示中（全部狀態）讀取中…" : `目前顯示中（全部狀態）${listCount ?? 0} 筆`}
            />
          ) : loadingList && !listLoaded ? (
            <p className="p-6 text-center text-t3">場次清單載入中...</p>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="border-b border-themed">
                <tr className="text-t2">
                  <th className="px-3 py-2 font-medium">場次</th>
                  <th className="px-3 py-2 font-medium">重要日期</th>
                  <th className="px-3 py-2 font-medium">對象</th>
                  <th className="px-3 py-2 font-medium">科目</th>
                  <th className="px-3 py-2 font-medium">狀態</th>
                  <th className="px-3 py-2 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-t3">
                      尚無符合條件的場次
                    </td>
                  </tr>
                ) : (
                  pagedItems.map((item) => {
                    const nextStatus = nextStatusOf(item.status);
                    const pastDeadline =
                      item.status === "open" && effectiveExamStatus(item) === "closed";
                    return (
                      <Fragment key={item.id}>
                      <tr className="border-b border-themed last:border-0 text-t1">
                        <td className="px-3 py-2">
                          <div className="space-y-1">
                            <div className="font-medium">
                              {item.title}
                              <OfficialExamLabel title={item.title} />
                            </div>
                            <div className="text-xs text-t3">
                              報名方式：{EXAM_REGISTRATION_MODE_LABELS[item.registrationMode]}
                            </div>
                            <div className="text-xs text-t3">
                              {roster?.eventId === item.id
                                ? `適用人數 ${roster.summary.applicableCount} 人／完成報名 ${roster.summary.registeredCount} 人`
                                : "人數按「統計」載入"}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-t2 whitespace-nowrap">
                          <div className="space-y-1">
                            <div>
                              <span className="text-xs text-t3 mr-1">考試日期：</span>
                              {item.examEndDate && item.examEndDate !== item.examDate ? (
                                <span className="inline-flex flex-col align-top">
                                  <span>{formatExamDate(item.examDate)}</span>
                                  <span>{formatExamDate(item.examEndDate)}</span>
                                </span>
                              ) : (
                                <span>{formatExamDate(item.examDate)}</span>
                              )}
                            </div>
                          </div>
                          <div className="mt-1.5 space-y-1">
                            <div>
                              <span className="text-xs text-t3 mr-1">報名日期：</span>
                              {item.registrationOpenAt > 0 ? (
                                <span className="inline-flex flex-col align-top">
                                  <span>{formatListDateTime(item.registrationOpenAt)}</span>
                                  <span>{formatListDateTime(item.deadline)}</span>
                                </span>
                              ) : (
                                <span>{formatListDateTime(item.deadline)}</span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-t2">{targetText(item)}</td>
                        <td className="px-3 py-2 text-t2">{item.subjects.length}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`text-xs ${
                              item.status === "open"
                                ? pastDeadline
                                  ? "text-t3"
                                  : "text-success"
                                : item.status === "archived"
                                  ? "text-t3"
                                  : "text-t2"
                            }`}
                          >
                            {EXAM_EVENT_STATUS_LABELS[item.status]}
                            {pastDeadline && "（已逾截止）"}
                          </span>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex justify-end">
                            <div className="grid grid-cols-2 gap-1 min-w-[170px]">
                              {canConfigure && (
                                <button
                                  type="button"
                                  onClick={() => edit(item)}
                                  className="btn-theme rounded px-2.5 py-1 text-[10px] cursor-pointer"
                                  aria-label={`編輯 ${item.title}`}
                                  title="編輯"
                                >
                                  編輯
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void loadRoster(item.id)}
                                disabled={loadingRoster}
                                className="btn-soft rounded px-2.5 py-1 text-[10px] cursor-pointer disabled:opacity-50"
                                aria-label={`${item.title} 報名統計`}
                                title="報名統計"
                              >
                                {roster?.eventId === item.id ? "統計 ✓" : "統計"}
                              </button>
                              {canConfigure && nextStatus ? (
                                <button
                                  type="button"
                                  onClick={() => void patchStatus(item, nextStatus)}
                                  disabled={saving}
                                  className="btn-soft rounded px-2.5 py-1 text-[10px] cursor-pointer disabled:opacity-50"
                                  aria-label={`切換為${EXAM_EVENT_STATUS_LABELS[nextStatus]}`}
                                  title={EXAM_EVENT_STATUS_LABELS[nextStatus]}
                                >
                                  {EXAM_EVENT_STATUS_LABELS[nextStatus]}
                                </button>
                              ) : (
                                <span />
                              )}
                              {canConfigure && (
                                <button
                                  type="button"
                                  onClick={() => void deleteEvent(item)}
                                  disabled={saving}
                                  className="rounded px-2.5 py-1 text-[10px] cursor-pointer disabled:opacity-50 border border-themed text-t3 hover:text-danger hover:border-danger"
                                  aria-label={`刪除 ${item.title}`}
                                  title="刪除場次（連同全部登錄名單一併刪除）"
                                >
                                  刪除
                                </button>
                              )}
                              <a
                                href={`${rosterHrefBase}?eventId=${encodeURIComponent(item.id)}`}
                                className="btn-soft rounded px-2.5 py-1 text-[10px] cursor-pointer text-center"
                                aria-label={`查看 ${item.title} 名單`}
                                title="查看名單"
                              >
                                查看名單
                              </a>
                              <span />
                            </div>
                          </div>
                        </td>
                      </tr>
                      {roster?.eventId === item.id ? (
                        <tr>
                          <td colSpan={6} className="px-3 pb-4 pt-1">
                            <section className="border border-themed rounded-lg bg-card px-5 py-4 space-y-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <h3 className="text-lg font-bold text-t1">
                                    名單｜{roster.event.title}
                                    <OfficialExamLabel title={roster.event.title} />
                                  </h3>
                                  <p className="text-xs text-t3">
                                    應報名 {roster.summary.applicableCount} 人／完成報名 {roster.summary.registeredCount} 人；
                                    {formatExamDateRange(roster.event)}・
                                    {EXAM_REGISTRATION_MODE_LABELS[roster.event.registrationMode]}
                                  </p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <a
                                    href={`${rosterHrefBase}?eventId=${encodeURIComponent(roster.eventId)}`}
                                    className="btn-soft rounded px-3 py-1 text-xs cursor-pointer"
                                  >
                                    查看名單
                                  </a>
                                  <button
                                    type="button"
                                    onClick={() => setRoster(null)}
                                    className="btn-soft rounded px-3 py-1 text-xs cursor-pointer"
                                  >
                                    關閉
                                  </button>
                                </div>
                              </div>

                              {/* 各科統計數字（表格格線） */}
                              <div className="overflow-x-auto border border-themed rounded">
                                <table className="w-full text-sm text-left">
                                  <thead className="border-b border-themed bg-themed">
                                    <tr className="text-t2">
                                      <th className="px-3 py-2 font-medium border-r border-themed">選考科目</th>
                                      <th className="px-3 py-2 font-medium text-right">已報名</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {roster.event.subjects.map((subject) => {
                                      const entry = roster.summary.bySubject[subject.key];
                                      const count = entry?.count ?? 0;
                                      return (
                                        <tr key={subject.key} className="border-b border-themed last:border-b-0">
                                          <td className="px-3 py-2 text-t2 border-r border-themed">{subject.label}</td>
                                          <td className="px-3 py-2 text-t1 text-right">{count} 人</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </section>
                          </td>
                        </tr>
                      ) : null}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>
        {/* 分頁列：每頁筆數選擇與頁次切換（同帳號清單） */}
        {!gating && listLoaded && filteredItems.length > 0 && (
          <div className="border-t border-themed px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-sm text-t2">
            <div className="flex items-center gap-2">
              <label htmlFor="exam-events-page-size">每頁</label>
              <select
                id="exam-events-page-size"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="input-theme rounded px-2 py-1 cursor-pointer"
              >
                {[10, 20, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              <span>
                筆，共 {filteredItems.length} 筆
                {filteredItems.length !== items.length && `（全部 ${items.length} 筆）`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={currentPage <= 1}
                className="btn-theme rounded px-3 py-1 text-xs cursor-pointer disabled:opacity-50"
              >
                第一頁
              </button>
              <button
                type="button"
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage <= 1}
                className="btn-theme rounded px-3 py-1 text-xs cursor-pointer disabled:opacity-50"
              >
                上一頁
              </button>
              <span>
                第 {currentPage} / {totalPages} 頁
              </span>
              <button
                type="button"
                onClick={() => setPage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="btn-theme rounded px-3 py-1 text-xs cursor-pointer disabled:opacity-50"
              >
                下一頁
              </button>
              <button
                type="button"
                onClick={() => setPage(totalPages)}
                disabled={currentPage >= totalPages}
                className="btn-theme rounded px-3 py-1 text-xs cursor-pointer disabled:opacity-50"
              >
                最後一頁
              </button>
            </div>
          </div>
        )}
        {!gating && listLoaded && (
          <p className="text-xs text-t3 mt-2 px-5 pb-4">
            狀態轉換受狀態機限制（草稿 → 開放 ⇄ 截止 → 封存，封存不可逆）；單頁最多 200 場次。
          </p>
        )}
      </section>
    </div>
  );
}
