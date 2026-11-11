"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DisclosureArrow from "@/components/DisclosureArrow";
import {
  CALENDAR_FALLBACK_CATEGORY_ID,
  CALENDAR_FALLBACK_CATEGORY_NAME,
  CALENDAR_SURFACE_LABELS,
  CALENDAR_SURFACE_LIMIT_MAX,
  CALENDAR_SURFACE_LIMIT_MIN,
  CALENDAR_SURFACES,
  DEFAULT_CALENDAR_POLICIES,
  DEFAULT_CALENDAR_SETTINGS,
  type AdminCalendarEventRow,
  type CalendarAccess,
  type CalendarCategory,
  type CalendarEventStatus,
  type CalendarGradeOption,
  type CalendarPolicies,
  type CalendarSchoolActivity,
  type CalendarSettings,
  type CalendarSurfaces,
  calendarPermissionText,
  emptySchoolActivity,
  schoolActivityText,
} from "@/types/calendar";
import { normalizeCategoryId } from "@/types/category";
import { ROLE_LABELS, ALL_ROLES, type UserRole } from "@/types/users";
import type { SchoolPeriodRow } from "@/types/school-periods";
import { useDataSaver } from "@/lib/data-saver";
import { stripHtmlToText } from "@/lib/rich-text";
import RevealListCard from "@/components/RevealListCard";
import { RichTextEditor } from "@/components/RichTextEditor";
import Toast, { type ToastMessage } from "@/components/Toast";

/** 單位層級設定選項（settings GET 一併回傳，供「發佈單位」下拉建議） */
interface OrgUnitOption {
  code: string;
  name: string;
  level: number;
  parent: string | null;
}

/** 樓層空間設定選項（settings GET 一併回傳，供「地點」下拉建議） */
interface SpaceOption {
  code: string;
  name: string;
  parent: string | null;
}

/** 批次匯入預覽列（伺服器 dryRun 回應） */
interface CalendarImportRow {
  row: number;
  title: string;
  timeText: string;
  action: "create" | "skip";
  reason?: string;
  categoryName?: string;
  /** 學校活動層級顯示文字（未指定＝省略） */
  schoolActivity?: string;
}

interface CalendarImportPreview {
  total: number;
  creatable: number;
  skipped: number;
  rows: CalendarImportRow[];
}

interface CalendarImportResult {
  message: string;
  created: number;
  skipped: Array<{ row: number; reason: string }>;
}

interface AdminListResponse {
  success?: boolean;
  message?: string;
  events?: AdminCalendarEventRow[];
  settings?: CalendarSettings;
  orgUnits?: OrgUnitOption[];
  spaceOptions?: SpaceOption[];
  /** 目前帳號的行事曆子權限（管理員恆全權） */
  access?: CalendarAccess;
  /** 學校課表作息（套用節次時間用） */
  schoolPeriods?: SchoolPeriodRow[];
  /** 年級／班級（學校活動層級勾選用） */
  classGrades?: CalendarGradeOption[];
}

interface FormState {
  id?: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  allDayDate: string;
  startAtText: string;
  endAtText: string;
  important: boolean;
  /** 學校活動層級（多選年級／班級；皆空＝無） */
  schoolActivity: CalendarSchoolActivity;
  categoryId: string;
  publishUnit: string;
  roles: UserRole[];
  classCodesText: string;
  /** 閱讀權限「無」＝公開（不需登入）；與身分勾選互斥 */
  isPublic: boolean;
}

const emptyForm: FormState = {
  title: "",
  description: "",
  location: "",
  allDay: false,
  allDayDate: "",
  startAtText: "",
  endAtText: "",
  important: false,
  schoolActivity: emptySchoolActivity(),
  categoryId: DEFAULT_CALENDAR_SETTINGS.categories[0].id,
  publishUnit: "",
  roles: ["student", "parent", "staff", "admin"],
  classCodesText: "",
  isPublic: false,
};

function toDatetimeLocal(ms?: number): string {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** 取 datetime-local 值的日期部分（YYYY-MM-DD）；格式不符回空字串 */
function datePartOf(value: string): string {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

interface PeriodRangeTexts {
  startAtText: string;
  endAtText: string;
  crossDay: boolean;
}

/**
 * 課表節次 → 開始／結束 datetime-local 值。
 * 開始節次套在開始日期，結束節次套在結束日期（未填結束日期＝與開始同日），
 * 因此支援跨日區間（如 11/12 第一節 → 11/13 第七節）。
 * 日期格式錯誤、結束早於開始或結束時間未晚於開始時間時回錯誤訊息。
 */
function buildPeriodRangeTexts(
  startPeriod: SchoolPeriodRow,
  endPeriod: SchoolPeriodRow,
  startAtText: string,
  endAtText: string,
  now: number = Date.now()
): { ok: true; value: PeriodRangeTexts } | { ok: false; message: string } {
  const startInput = startAtText.trim();
  if (startInput && !datePartOf(startInput)) {
    return { ok: false, message: "開始時間格式不正確，請重新選擇" };
  }
  const endInput = endAtText.trim();
  if (endInput && !datePartOf(endInput)) {
    return { ok: false, message: "結束時間格式不正確，請重新選擇或清空" };
  }

  const today = toDatetimeLocal(now).slice(0, 10);
  const startDate = datePartOf(startInput) || today;
  const endDate = datePartOf(endInput) || startDate;
  if (endDate < startDate) {
    return { ok: false, message: "結束日期不得早於開始日期" };
  }

  const startValue = `${startDate}T${startPeriod.start}`;
  const endValue = `${endDate}T${endPeriod.end}`;
  if (endValue <= startValue) {
    return { ok: false, message: "結束時間必須晚於開始時間" };
  }
  return {
    ok: true,
    value: { startAtText: startValue, endAtText: endValue, crossDay: endDate !== startDate },
  };
}

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(key: string, dir: -1 | 1): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + dir, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatRange(item: {
  startAt: number;
  endAt?: number;
  allDayDate?: string;
}): string {
  if (item.allDayDate) {
    const label = new Date(item.startAt).toLocaleDateString("zh-TW");
    return `全天（${label}）`;
  }
  const start = new Date(item.startAt).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (!item.endAt || item.endAt === item.startAt) return start;
  const end = new Date(item.endAt).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${start} ~ ${end}`;
}

/**
 * 行事曆（僅超級／被指派「行事曆」的管理員）。
 * 版面順序：設定卡片（規則設定／顯示位置／行程類型，全部預設收合）
 * → 建立／編輯行程（預設收合）→ 行程清單（月份切換、搜尋、狀態篩選）。
 * 清單依系統「省流開關」：啟用時進頁不載入，改按鈕或搜尋時載入（同公告／帳號清單）。
 */
export default function AdminCalendarPage() {
  const { ready: settingsReady, saverOn } = useDataSaver();
  const [settings, setSettings] = useState<CalendarSettings>(DEFAULT_CALENDAR_SETTINGS);
  // 目前帳號可操作的功能（管理員恆全權；被指派者依子權限分開授權）
  const [access, setAccess] = useState<CalendarAccess>({
    manage: false,
    import: false,
    delete: false,
    settings: false,
  });
  const selectable = access.manage || access.delete;
  const [items, setItems] = useState<AdminCalendarEventRow[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const gating = saverOn && !listLoaded;
  const [loadingList, setLoadingList] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [categories, setCategories] = useState<CalendarCategory[]>(
    DEFAULT_CALENDAR_SETTINGS.categories
  );
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  // 5 個顯示位置的顯示與否＋可翻頁則數（顯示方式統一：單一行、上下箭頭逐則翻頁）
  const [surfaces, setSurfaces] = useState<CalendarSurfaces>(
    DEFAULT_CALENDAR_SETTINGS.surfaces
  );
  // 行程原則（下架行程真實刪除）
  const [policies, setPolicies] = useState<CalendarPolicies>(DEFAULT_CALENDAR_POLICIES);
  // 單位層級設定選項（settings GET 一併回傳，供「發佈單位」下拉建議）
  const [orgUnits, setOrgUnits] = useState<OrgUnitOption[]>([]);
  // 樓層空間設定選項（settings GET 一併回傳，供「地點」下拉建議）
  const [spaceOptions, setSpaceOptions] = useState<SpaceOption[]>([]);
  // 學校課表作息（settings GET 一併回傳）：表單可套用節次起訖時間
  const [schoolPeriods, setSchoolPeriods] = useState<SchoolPeriodRow[]>([]);
  // 年級／班級（settings GET 一併回傳）：學校活動層級勾選用
  const [classGrades, setClassGrades] = useState<CalendarGradeOption[]>([]);
  // 表單選擇的課表節次（套用後才寫入開始／結束時間）
  const [periodStartCode, setPeriodStartCode] = useState("");
  const [periodEndCode, setPeriodEndCode] = useState("");
  const sortedSchoolPeriods = useMemo(
    () =>
      [...schoolPeriods].sort(
        (a, b) => a.start.localeCompare(b.start) || a.period - b.period
      ),
    [schoolPeriods]
  );
  const periodByCode = useMemo(
    () => new Map(schoolPeriods.map((period) => [period.code, period] as const)),
    [schoolPeriods]
  );
  // 省流模式的輕量統計（count 聚合，僅在省流啟用時取一次）
  const [counts, setCounts] = useState<{ active: number; cancelled: number } | null>(null);
  const [cardOpen, setCardOpen] = useState({
    settings: false,
    policies: false,
    surfaces: false,
    categories: false,
  });
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | CalendarEventStatus>("all");
  const [month, setMonth] = useState<string | null>(null);
  // 確認對話 modal：取代原生 confirm，樣式跟隨主題
  const [confirmRequest, setConfirmRequest] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);
  // 批次勾選：目前選取的行程 id（批次完成後清空）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 批次新增（xlsx/xls 匯入）：預覽 → 確認
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [batchBusy, setBatchBusy] = useState<"" | "preview" | "execute">("");
  const [batchError, setBatchError] = useState("");
  const [batchPreview, setBatchPreview] = useState<CalendarImportPreview | null>(null);
  const [batchResult, setBatchResult] = useState<CalendarImportResult | null>(null);
  const batchFileRef = useRef<HTMLInputElement>(null);

  function askConfirm(message: string, onConfirm: () => void) {
    setConfirmRequest({ message, onConfirm });
  }

  // 確認 modal：Esc 取消
  useEffect(() => {
    if (!confirmRequest) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmRequest(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmRequest]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 表頭全選：僅切換「目前篩選結果」的選取狀態 */
  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const allIds = filteredItems.map((item) => item.id);
      const allSelected = allIds.length > 0 && allIds.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(allIds);
    });
  }



  const applySettings = useCallback((next: CalendarSettings) => {
    setSettings(next);
    setCategories(next.categories);
    setRemindersEnabled(next.defaultRemindersEnabled !== false);
    setSurfaces(next.surfaces ?? DEFAULT_CALENDAR_SETTINGS.surfaces);
    setPolicies(next.policies ?? DEFAULT_CALENDAR_POLICIES);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/calendar/settings", { cache: "no-store" });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (data?.success && data.settings) applySettings(data.settings);
      if (data?.success && data.access) setAccess(data.access);
      if (data?.success && Array.isArray(data.schoolPeriods)) {
        setSchoolPeriods(data.schoolPeriods);
      }
      if (data?.success && Array.isArray(data.classGrades)) {
        setClassGrades(data.classGrades);
      }
      if (data?.success && Array.isArray(data.orgUnits)) setOrgUnits(data.orgUnits);
      if (data?.success && Array.isArray(data.spaceOptions)) setSpaceOptions(data.spaceOptions);
    } catch {
      // 設定讀失敗不擋頁面：表單分類退回預設
    }
  }, [applySettings]);

  useEffect(() => {
    if (!settingsReady) return;
    void loadSettings();
  }, [settingsReady, loadSettings]);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/admin/calendar", { cache: "no-store" });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (data?.success) {
        setItems(data.events ?? []);
        if (data.settings) applySettings(data.settings);
        if (data.access) setAccess(data.access);
        setListLoaded(true);
      } else {
        setToast({ kind: "error", text: data?.message || "載入行程失敗" });
      }
    } catch {
      setToast({ kind: "error", text: "載入行程失敗" });
    } finally {
      setLoadingList(false);
    }
  }, [applySettings]);

  useEffect(() => {
    if (!settingsReady) return;
    if (gating) return;
    if (listLoaded) return;
    void loadList();
  }, [settingsReady, gating, listLoaded, loadList]);

  // 省流啟用時抓輕量統計（count 聚合，每筆僅 1 次讀取）
  useEffect(() => {
    if (!settingsReady || !saverOn) return;
    let cancelled = false;
    void fetch("/api/admin/calendar/count", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { success?: boolean; active?: number; cancelled?: number } | null) => {
        if (!cancelled && data?.success) {
          setCounts({ active: data.active ?? 0, cancelled: data.cancelled ?? 0 });
        }
      })
      .catch(() => {
        // 統計取不到就不出現，不影響省流閘門運作
      });
    return () => {
      cancelled = true;
    };
  }, [settingsReady, saverOn]);

  // 「發佈單位」下拉選項：以 parent 爲鍵建樹、由最上層走訪（depth 縮排），
  // 對齊樓層空間設定的既有做法——不用 unit.level（層級欄位可能與實際上下級不符）
  const publishUnitOptions = useMemo(() => {
    const byParent = new Map<string | null, OrgUnitOption[]>();
    for (const unit of orgUnits) {
      // 空名稱單位仍入樹（其下一層要走訪得到），只是不出現在選項
      const key = unit.parent ?? null;
      const bucket = byParent.get(key);
      if (bucket) bucket.push(unit);
      else byParent.set(key, [unit]);
    }
    const options: Array<{ code: string; name: string; depth: number }> = [];
    const seenNames = new Set<string>();
    const walk = (parentCode: string | null, depth: number) => {
      for (const unit of byParent.get(parentCode) ?? []) {
        const name = unit.name.trim();
        if (name && !seenNames.has(name)) {
          seenNames.add(name);
          options.push({ code: unit.code, name, depth });
        }
        walk(unit.code, depth + 1);
      }
    };
    walk(null, 0);
    return options;
  }, [orgUnits]);

  // 「地點」下拉選項：樓層空間以 parent 建樹走訪（depth 縮排），做法同發佈單位
  const locationOptions = useMemo(() => {
    const byParent = new Map<string | null, SpaceOption[]>();
    for (const unit of spaceOptions) {
      const key = unit.parent ?? null;
      const bucket = byParent.get(key);
      if (bucket) bucket.push(unit);
      else byParent.set(key, [unit]);
    }
    const options: Array<{ code: string; name: string; depth: number }> = [];
    const seenNames = new Set<string>();
    const walk = (parentCode: string | null, depth: number) => {
      for (const unit of byParent.get(parentCode) ?? []) {
        const name = unit.name.trim();
        if (name && !seenNames.has(name)) {
          seenNames.add(name);
          options.push({ code: unit.code, name, depth });
        }
        walk(unit.code, depth + 1);
      }
    };
    walk(null, 0);
    return options;
  }, [spaceOptions]);

  function applyListFromResponse(data: AdminListResponse) {
    if (listLoaded && data.events) setItems(data.events);
    if (data.settings) applySettings(data.settings);
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setToast(null);
    try {
      const classCodes = form.classCodesText
        .split(/[,、;；\s]+/)
        .map((c) => c.trim())
        .filter(Boolean);
      const startAt = parseDatetimeLocal(form.startAtText);
      if (!form.allDay && !startAt) {
        throw new Error("請填寫開始時間");
      }
      const payload = {
        title: form.title,
        description: form.description,
        location: form.location.trim(),
        allDay: form.allDay,
        allDayDate: form.allDay ? form.allDayDate : undefined,
        startAt: form.allDay ? undefined : startAt,
        endAt: form.allDay ? null : (parseDatetimeLocal(form.endAtText) ?? null),
        important: form.important,
        schoolActivity: form.schoolActivity,
        categoryId: formCategoryId,
        publishUnit: form.publishUnit.trim(),
        audience: {
          roles: form.isPublic ? [] : form.roles,
          classCodes: form.isPublic ? [] : classCodes,
        },
        isPublic: form.isPublic,
      };
      const res = await fetch(form.id ? `/api/admin/calendar/${form.id}` : "/api/admin/calendar", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "儲存失敗");
      applyListFromResponse(data);
      setForm(emptyForm);
      setPeriodStartCode("");
      setPeriodEndCode("");
      setFormOpen(false);
      setToast({ kind: "success", text: data.message || "已儲存" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "儲存失敗" });
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(id: string, status: CalendarEventStatus) {
    if (saving) return;
    // 沒有刪除權限者即使啟用「下架行程真實刪除」也只會軟取消（伺服器同步把關）
    const hardDelete = policies.hardDeleteCancelled && access.delete;
    const confirmText =
      status === "cancelled"
        ? hardDelete
          ? "確定要下架此行程？（已啟用「下架行程真實刪除」：將連同個人提醒一併刪除，無法恢復）"
          : "確定要取消此行程？（文件會保留，但不再顯示給任何身分）"
        : "確定要恢復此行程？";
    askConfirm(confirmText, () => void runSetStatus(id, status));
  }

  async function runSetStatus(id: string, status: CalendarEventStatus) {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/calendar/${id}`, {
        method: status === "cancelled" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: status === "cancelled" ? undefined : JSON.stringify({ status: "active" }),
      });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "操作失敗");
      applyListFromResponse(data);
      setToast({ kind: "success", text: data.message || "已更新" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "操作失敗" });
    } finally {
      setSaving(false);
    }
  }

  // —— 批次新增（xlsx/xls）：預覽 → 確認 ——

  async function runImport(dryRun: boolean) {
    if (!batchFile || batchBusy) return;
    setBatchBusy(dryRun ? "preview" : "execute");
    setBatchError("");
    if (dryRun) {
      setBatchResult(null);
    }
    try {
      const formData = new FormData();
      formData.set("dryRun", dryRun ? "true" : "false");
      formData.set("file", batchFile);
      const res = await fetch("/api/admin/calendar/import", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        message?: string;
        dryRun?: boolean;
        total?: number;
        creatable?: number;
        skipped?: number | Array<{ row: number; reason: string }>;
        rows?: CalendarImportRow[];
        created?: number;
        events?: AdminCalendarEventRow[];
        settings?: CalendarSettings;
      } | null;
      if (dryRun) {
        if (!res.ok || !data?.success || !Array.isArray(data.rows)) {
          throw new Error(data?.message || "解析檔案失敗");
        }
        setBatchPreview({
          total: data.total ?? 0,
          creatable: data.creatable ?? 0,
          skipped: typeof data.skipped === "number" ? data.skipped : 0,
          rows: data.rows,
        });
      } else {
        if (!res.ok || !data?.success) {
          throw new Error(data?.message || "批次新增失敗");
        }
        applyListFromResponse({ events: data.events, settings: data.settings });
        setBatchResult({
          message: data.message || "批次新增完成",
          created: data.created ?? 0,
          skipped: Array.isArray(data.skipped) ? data.skipped : [],
        });
        setBatchPreview(null);
        setBatchFile(null);
        if (batchFileRef.current) batchFileRef.current.value = "";
        setToast({ kind: "success", text: data.message || "批次新增完成" });
      }
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : "批次新增失敗");
    } finally {
      setBatchBusy("");
    }
  }

  function confirmImport() {
    if (!batchPreview || batchPreview.creatable === 0) return;
    askConfirm(
      `確定要依預覽新增 ${batchPreview.creatable} 筆行程嗎？`,
      () => void runImport(false)
    );
  }

  /** 真實刪除（硬刪除）：連同個人提醒一併從資料庫刪除，不可恢復 */
  function remove(id: string, title: string) {
    if (saving) return;
    askConfirm(
      `確定要刪除「${title}」？\n將連同所有個人提醒一併從資料庫真實刪除，無法恢復。`,
      () => void runRemove(id)
    );
  }

  async function runRemove(id: string) {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/calendar/${id}`, { method: "DELETE" });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "刪除失敗");
      applyListFromResponse(data);
      setToast({ kind: "success", text: data.message || "已真實刪除" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "刪除失敗" });
    } finally {
      setSaving(false);
    }
  }

  /** 批次取消：勾選多筆一併下架（原則開啟時連帶硬刪除） */
  function batchCancel() {
    if (saving || selectedIds.size === 0) return;
    const count = selectedIds.size;
    const hardDelete = policies.hardDeleteCancelled && access.delete;
    const confirmText = hardDelete
      ? `確定要批次下架選取的 ${count} 筆行程？（已啟用「下架行程真實刪除」：將連同個人提醒一併刪除，無法恢復）`
      : `確定要批次取消選取的 ${count} 筆行程？（文件會保留，但不再顯示給任何身分）`;
    askConfirm(confirmText, () => void runBatch("cancel"));
  }

  /** 批次刪除：勾選多筆一併真實刪除（不可恢復） */
  function batchRemove() {
    if (saving || selectedIds.size === 0) return;
    const count = selectedIds.size;
    askConfirm(
      `確定要批次刪除選取的 ${count} 筆行程？\n將連同所有個人提醒一併從資料庫真實刪除，無法恢復。`,
      () => void runBatch("delete")
    );
  }

  async function runBatch(action: "cancel" | "delete") {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/calendar/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: [...selectedIds] }),
      });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "批次作業失敗");
      applyListFromResponse(data);
      setSelectedIds(new Set());
      setToast({ kind: "success", text: data.message || "批次作業完成" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "批次作業失敗" });
    } finally {
      setSaving(false);
    }
  }

  function timeOfDay(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * 套用課表作息：開始節次套在開始日期，結束節次套在結束日期
   * （結束日期未填＝與開始同日），支援跨日；未填開始日期時用今天。
   */
  function applyPeriodTimes() {
    const startPeriod = periodByCode.get(periodStartCode);
    if (!startPeriod) {
      setToast({ kind: "error", text: "請先選擇開始節次" });
      return;
    }
    const endPeriod = periodByCode.get(periodEndCode) ?? startPeriod;
    const range = buildPeriodRangeTexts(
      startPeriod,
      endPeriod,
      form.startAtText,
      form.endAtText
    );
    if (!range.ok) {
      setToast({ kind: "error", text: range.message });
      return;
    }
    setForm((prev) => ({
      ...prev,
      allDay: false,
      startAtText: range.value.startAtText,
      endAtText: range.value.endAtText,
    }));
    if (range.value.crossDay) {
      const label = (value: string) => datePartOf(value).replace(/-/g, "/");
      setToast({
        kind: "success",
        text: `已套用 ${startPeriod.name}（${label(range.value.startAtText)}）～${endPeriod.name}（${label(range.value.endAtText)}）的課表時間`,
      });
    } else {
      setToast({ kind: "success", text: `已套用 ${startPeriod.name}～${endPeriod.name} 的課表時間` });
    }
  }

  function edit(item: AdminCalendarEventRow) {
    const startMatch = item.allDayDate
      ? undefined
      : sortedSchoolPeriods.find((period) => period.start === timeOfDay(item.startAt));
    const endAt = item.endAt;
    const endMatch =
      endAt && !item.allDayDate
        ? sortedSchoolPeriods.find((period) => period.end === timeOfDay(endAt))
        : undefined;
    setPeriodStartCode(startMatch?.code ?? "");
    setPeriodEndCode(endMatch?.code ?? "");
    setForm({
      id: item.id,
      title: item.title,
      description: item.description ?? "",
      location: item.location ?? "",
      allDay: Boolean(item.allDayDate),
      allDayDate: item.allDayDate ?? "",
      startAtText: toDatetimeLocal(item.startAt),
      endAtText: toDatetimeLocal(item.endAt),
      important: item.important === true,
      schoolActivity: item.schoolActivity ?? emptySchoolActivity(),
      categoryId: item.categoryId,
      publishUnit: item.publishUnit ?? "",
      roles: item.isPublic
        ? []
        : item.audience.roles.filter((role) => (ALL_ROLES as string[]).includes(role)),
      classCodesText: item.isPublic
        ? ""
        : item.audience.classCodes.filter((c) => c !== "*").join(", "),
      isPublic: item.isPublic === true,
    });
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setForm(emptyForm);
    setPeriodStartCode("");
    setPeriodEndCode("");
    setFormOpen(false);
  }

  async function saveSettings() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/calendar/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categories,
          defaultRemindersEnabled: remindersEnabled,
          surfaces,
          policies,
        }),
      });
      const data: AdminListResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.message || "設定儲存失敗");
      if (data.settings) applySettings(data.settings);
      setToast({ kind: "success", text: data.message || "設定已儲存" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "設定儲存失敗" });
    } finally {
      setSaving(false);
    }
  }

  function moveCategory(index: number, dir: -1 | 1) {
    setCategories((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      const tmp = next[index];
      next[index] = next[target];
      next[target] = tmp;
      return next.map((cat, i) => ({ ...cat, sortOrder: i }));
    });
  }

  function toggleRole(role: UserRole) {
    setForm((prev) => ({
      ...prev,
      roles: prev.roles.includes(role)
        ? prev.roles.filter((r) => r !== role)
        : [...prev.roles, role],
    }));
  }

  function toggleSchoolActivitySchool(checked: boolean) {
    setForm((prev) => ({
      ...prev,
      schoolActivity: {
        school: checked,
        grades: checked ? [] : prev.schoolActivity.grades,
      },
    }));
  }

  function toggleSchoolActivityGrade(grade: string, checked: boolean) {
    setForm((prev) => ({
      ...prev,
      schoolActivity: {
        ...prev.schoolActivity,
        grades: checked
          ? [
              ...prev.schoolActivity.grades.filter((entry) => entry.grade !== grade),
              { grade, classCodes: [] },
            ]
          : prev.schoolActivity.grades.filter((entry) => entry.grade !== grade),
      },
    }));
  }

  function toggleSchoolActivityClass(grade: string, classCode: string, checked: boolean) {
    setForm((prev) => ({
      ...prev,
      schoolActivity: {
        ...prev.schoolActivity,
        grades: prev.schoolActivity.grades.map((entry) =>
          entry.grade === grade
            ? {
                ...entry,
                classCodes: checked
                  ? [...new Set([...entry.classCodes, classCode])]
                  : entry.classCodes.filter((code) => code !== classCode),
              }
            : entry
        ),
      },
    }));
  }

  // 表單目前生效的類型：id 已被刪除（或停用）時自動歸到後備類型「其他」
  const enabledCategories = categories.filter((c) => c.enabled);
  const formCategoryId = normalizeCategoryId(
    enabledCategories,
    CALENDAR_FALLBACK_CATEGORY_ID,
    form.categoryId
  );

  const searchKeyword = keyword.trim().toLowerCase();
  const filteredItems = items.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (month && monthKey(item.startAt) !== month) return false;
    if (!searchKeyword) return true;
    const haystack =
      `${item.title}\n${stripHtmlToText(item.description ?? "")}\n${item.location ?? ""}\n${item.categoryName}\n${item.publishUnit ?? ""}\n${item.createdBy.name}`.toLowerCase();
    return haystack.includes(searchKeyword);
  });

  const monthLabel = month
    ? `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`
    : "不限月份";

  return (
    <div className="content-width mb-8 space-y-6">
      <Toast message={toast} onClose={() => setToast(null)} />

      {/* 1. 設定管理（預設收合）：收納規則設定／顯示位置／行程類型三張卡片 */}
      {access.settings && (
      <SettingsCard
        title="設定管理"
        open={cardOpen.settings}
        onToggle={() => setCardOpen((prev) => ({ ...prev, settings: !prev.settings }))}
      >
        <div className="space-y-6">
          {/* 1-1. 規則設定（預設收合，第一順位）：行程原則 */}
          <SettingsCard
            title="規則設定"
            open={cardOpen.policies}
            onToggle={() => setCardOpen((prev) => ({ ...prev, policies: !prev.policies }))}
          >
            <div>
              <div className="space-y-3">
                <PolicyRow
                  id="pol-hard-delete"
                  label="下架行程真實刪除（預設停用）"
                  checked={policies.hardDeleteCancelled}
                  onChange={(checked) =>
                    setPolicies((prev) => ({ ...prev, hardDeleteCancelled: checked }))
                  }
                  hint="開啟後，取消（下架）的行程連同個人提醒一併從資料庫真實刪除（無法恢復）。關閉時僅隱藏保留：文件不顯示給任何身分，供來源模組對帳。"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="pol-public-past" className="text-sm text-t1">
                    公開行事曆可回溯月數
                  </label>
                  <input
                    id="pol-public-past"
                    type="number"
                    min={0}
                    max={12}
                    step={1}
                    value={policies.publicPastMonths}
                    onChange={(e) =>
                      setPolicies((prev) => ({
                        ...prev,
                        publicPastMonths: Math.min(
                          12,
                          Math.max(0, Math.round(Number(e.target.value) || 0))
                        ),
                      }))
                    }
                    className="input-theme rounded px-2 py-1 text-sm w-20"
                  />
                  <span className="text-xs text-t3">
                    0＝僅本月起；預設 1＝本月＋上月；上限 12（影響未登入的公開行事曆頁可回溯幾个月）
                  </span>
                </div>
              </div>
              {/* 儲存設定與上方元件固定 10px 間距 */}
              <div className="mt-2.5">
                <button
                  type="button"
                  onClick={saveSettings}
                  disabled={saving}
                  className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
                >
                  {saving ? "處理中..." : "儲存設定"}
                </button>
              </div>
            </div>
          </SettingsCard>

          {/* 1-2. 顯示位置（預設收合）：5 處顯示與否＋可翻頁則數（顯示方式統一） */}
          <SettingsCard
            title="顯示位置"
            open={cardOpen.surfaces}
            onToggle={() => setCardOpen((prev) => ({ ...prev, surfaces: !prev.surfaces }))}
          >
            <div>
              <span className="block text-t2 mb-1">顯示與否／顯示筆數，5 處各自設定</span>
              <div className="space-y-2">
                {CALENDAR_SURFACES.map((key) => (
                  <div key={key} className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 text-sm text-t1 w-60">
                      <input
                        type="checkbox"
                        checked={surfaces[key].enabled}
                        onChange={(e) =>
                          setSurfaces((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], enabled: e.target.checked },
                          }))
                        }
                      />
                      {CALENDAR_SURFACE_LABELS[key]}
                    </label>
                    <label className="inline-flex items-center gap-1 text-xs text-t2">
                      顯示筆數
                      <input
                        type="number"
                        min={CALENDAR_SURFACE_LIMIT_MIN}
                        max={CALENDAR_SURFACE_LIMIT_MAX}
                        className="w-16 input-theme rounded px-2 py-1 disabled:opacity-50"
                        value={surfaces[key].limit}
                        disabled={!surfaces[key].enabled}
                        onChange={(e) =>
                          setSurfaces((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], limit: Number(e.target.value) },
                          }))
                        }
                      />
                    </label>
                  </div>
                ))}
              </div>
              <p className="text-xs text-t3 mt-1">
                顯示方式統一處理：標題「行事曆」右側固定放「進入行事曆」入口圖示；有 2 則以上尚未結束（含今天）的行程
                時，入口圖示左側出現左右箭頭逐則翻頁（預設 5 則，省 Firestore 讀取量）；翻到盡頭再按箭頭則改為「前往行事曆」連結（符號不變）。
                沒有行程則只顯示入口。
              </p>
              <p className="text-xs text-t3 mt-1">
                「系統首頁」只顯示閱讀權限「無」（不需登入）的公開行程；各身分首頁依其身分顯示。
              </p>
              <p className="text-xs text-t3 mt-1">
                顯示位置啟用 {CALENDAR_SURFACES.filter((key) => surfaces[key].enabled).length} / 5 處。
              </p>
              {/* 儲存設定與上方元件固定 10px 間距 */}
              <div className="mt-2.5">
                <button
                  type="button"
                  onClick={saveSettings}
                  disabled={saving}
                  className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
                >
                  {saving ? "處理中..." : "儲存設定"}
                </button>
              </div>
            </div>
          </SettingsCard>

          {/* 1-3. 行程類型（預設收合） */}
          <SettingsCard
            title="行程類型"
            open={cardOpen.categories}
            onToggle={() => setCardOpen((prev) => ({ ...prev, categories: !prev.categories }))}
          >
            <div>
              <div className="space-y-4">
                <div>
                  <span className="block text-t2 mb-1">行事曆類型名稱、啟用與排序</span>
                  <div className="space-y-2">
                    {categories.map((cat, index) => {
                      const isFallback = cat.id === CALENDAR_FALLBACK_CATEGORY_ID;
                      return (
                        <div key={cat.id || index} className="flex items-center gap-2">
                          <span className="text-xs text-t3 w-4 text-center">{index + 1}</span>
                          <input
                            className="w-28 input-theme rounded px-2 py-1"
                            value={cat.name}
                            onChange={(e) => {
                              const next = [...categories];
                              next[index] = { ...cat, name: e.target.value };
                              setCategories(next);
                            }}
                            placeholder="名稱"
                          />
                          <label className="inline-flex items-center gap-1 text-xs text-t2">
                            <input
                              type="checkbox"
                              checked={cat.enabled}
                              disabled={isFallback}
                              title={isFallback ? "後備類型必須啟用" : undefined}
                              onChange={(e) => {
                                const next = [...categories];
                                next[index] = { ...cat, enabled: e.target.checked };
                                setCategories(next);
                              }}
                            />
                            啟用
                          </label>
                          <button
                            type="button"
                            className="text-xs text-t3 hover:text-t1 cursor-pointer px-1"
                            disabled={index === 0}
                            onClick={() => moveCategory(index, -1)}
                            title="上移"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="text-xs text-t3 hover:text-t1 cursor-pointer px-1"
                            disabled={index === categories.length - 1}
                            onClick={() => moveCategory(index, 1)}
                            title="下移"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className={`text-xs px-1 ${
                              isFallback
                                ? "text-t3 cursor-not-allowed"
                                : "text-t3 hover:text-danger cursor-pointer"
                            }`}
                            disabled={isFallback}
                            title={
                              isFallback
                                ? `後備類型「${CALENDAR_FALLBACK_CATEGORY_NAME}」不可刪除`
                                : undefined
                            }
                            onClick={() => setCategories(categories.filter((_, i) => i !== index))}
                          >
                            刪除
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-t3 mt-2">
                    「{CALENDAR_FALLBACK_CATEGORY_NAME}」為後備類型（不可刪除／停用）：其他類型被刪除後，
                    已發佈的行程會在顯示時自動歸入「{CALENDAR_FALLBACK_CATEGORY_NAME}」，不需批次搬移資料。
                  </p>
                  <button
                    type="button"
                    className="mt-2 btn-soft rounded px-3 py-1 text-xs cursor-pointer"
                    onClick={() =>
                      setCategories([
                        ...categories,
                        {
                          id: `custom_${Date.now()}`,
                          name: "",
                          sortOrder: categories.length,
                          enabled: true,
                        },
                      ])
                    }
                  >
                    ＋ 新增行事曆類型
                  </button>
                </div>

                <label className="inline-flex items-center gap-1.5 text-sm text-t1">
                  <input
                    type="checkbox"
                    checked={remindersEnabled}
                    onChange={(e) => setRemindersEnabled(e.target.checked)}
                  />
                  啟用個人提醒（行程清單的「提醒我」按鈕；非推播，開啟頁面才更新）
                </label>
              </div>

              {/* 儲存設定與上方元件固定 10px 間距 */}
              <div className="mt-2.5">
                <button
                  type="button"
                  onClick={saveSettings}
                  disabled={saving}
                  className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
                >
                  {saving ? "處理中..." : "儲存設定"}
                </button>
              </div>
              <p className="mt-4 text-xs text-t3">
                跨模組發佈行程請呼叫 <code>publishScheduleFromModule()</code>（src/lib/calendar.ts）。
              </p>
            </div>
          </SettingsCard>
        </div>
      </SettingsCard>
      )}

      {/* 2. 建立／編輯行程（預設收合） */}
      {access.manage && (
      <details
        open={formOpen}
        onToggle={(event) => {
          const nextOpen = event.currentTarget.open;
          if (nextOpen === formOpen) return;
          if (nextOpen) setFormOpen(true);
          else cancelEdit();
        }}
        className="border border-themed rounded-lg bg-card"
      >
        <summary className="flex list-none cursor-pointer items-center justify-between gap-3 px-5 py-4 text-left">
          <h3 className="text-lg font-bold text-t1">{form.id ? "編輯行程" : "建立行程"}</h3>
          <DisclosureArrow />
        </summary>
        {formOpen && (
          <div className="px-5 pt-2.5 pb-5">
            <form onSubmit={submitForm} className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="cal-title">
                  標題
                </label>
                <input
                  id="cal-title"
                  className={`flex-1 input-theme rounded px-3 py-2 ${
                    form.schoolActivity.school || form.schoolActivity.grades.length > 0
                      ? "!text-danger"
                      : ""
                  }`}
                  style={
                    form.schoolActivity.school || form.schoolActivity.grades.length > 0
                      ? { color: "var(--danger)" }
                      : undefined
                  }
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                  maxLength={120}
                />
              </div>
              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <label className="text-t2 sm:w-40 shrink-0">
                  說明（選填）
                </label>
                <div className="flex-1 min-w-0">
                  <RichTextEditor
                    value={form.description}
                    onChange={(html) => setForm((prev) => ({ ...prev, description: html }))}
                    placeholder="請輸入行程說明（選填）"
                    maxLength={2000}
                    ariaLabel="行程說明"
                    className={
                      form.schoolActivity.school || form.schoolActivity.grades.length > 0
                        ? "rich-text-danger"
                        : ""
                    }
                    style={
                      form.schoolActivity.school || form.schoolActivity.grades.length > 0
                        ? { color: "var(--danger)" }
                        : undefined
                    }
                  />
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="cal-location">
                  地點（選填）
                </label>
                <div className="flex-1 flex flex-col sm:flex-row gap-2">
                  {/* 常駐可見的空間下拉（含層級縮排）：選取即填入右側文字欄位 */}
                  {locationOptions.length > 0 && (
                    <select
                      aria-label="從樓層空間設定選取地點"
                      value=""
                      onChange={(e) => {
                        const name = e.target.value;
                        if (name) setForm({ ...form, location: name });
                        e.target.value = "";
                      }}
                      className="input-theme rounded px-3 py-2 sm:w-60 shrink-0 cursor-pointer"
                    >
                      <option value="">從樓層空間設定選取…</option>
                      {locationOptions.map((option) => (
                        <option key={option.code} value={option.name}>
                          {option.depth > 0 ? "　".repeat(option.depth) : ""}
                          {option.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    id="cal-location"
                    className="flex-1 min-w-0 input-theme rounded px-3 py-2"
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    placeholder="亦可自行填寫（例如：禮堂）"
                    maxLength={120}
                  />
                </div>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="cal-publish-unit">
                  發佈單位（選填）
                </label>
                <div className="flex-1 flex flex-col sm:flex-row gap-2">
                  {/* 常駐可見的單位下拉（含層級縮排）：選取即填入右側文字欄位 */}
                  <select
                    aria-label="從單位層級設定選取發佈單位"
                    value=""
                    onChange={(e) => {
                      const name = e.target.value;
                      if (name) setForm({ ...form, publishUnit: name });
                      e.target.value = "";
                    }}
                    className="input-theme rounded px-3 py-2 sm:w-60 shrink-0 cursor-pointer"
                  >
                    <option value="">從單位層級設定選取…</option>
                    {publishUnitOptions.map((option) => (
                      <option key={option.code} value={option.name}>
                        {option.depth > 0 ? "　".repeat(option.depth) : ""}
                        {option.name}
                      </option>
                    ))}
                  </select>
                  <input
                    id="cal-publish-unit"
                    className="flex-1 min-w-0 input-theme rounded px-3 py-2"
                    value={form.publishUnit}
                    onChange={(e) => setForm({ ...form, publishUnit: e.target.value })}
                    placeholder="亦可自行填寫（例如：學年會）"
                    maxLength={64}
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <span className="text-t2 sm:w-40 shrink-0">時間</span>
                <div className="flex-1 space-y-2">
                  <label className="inline-flex items-center gap-1.5 text-sm text-t1">
                    <input
                      type="checkbox"
                      checked={form.allDay}
                      onChange={(e) => setForm({ ...form, allDay: e.target.checked })}
                    />
                    全天行程
                  </label>
                  {form.allDay ? (
                    <div>
                      <label className="block text-xs text-t2 mb-1" htmlFor="cal-date">
                        日期
                      </label>
                      <input
                        id="cal-date"
                        type="date"
                        className="w-full sm:w-56 input-theme rounded px-3 py-2"
                        value={form.allDayDate}
                        onChange={(e) => setForm({ ...form, allDayDate: e.target.value })}
                        required
                      />
                    </div>
                  ) : (
                    <>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <label className="block text-xs text-t2 mb-1" htmlFor="cal-start">
                          開始時間
                        </label>
                        <input
                          id="cal-start"
                          type="datetime-local"
                          className="w-full input-theme rounded px-3 py-2"
                          value={form.startAtText}
                          onChange={(e) => setForm({ ...form, startAtText: e.target.value })}
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-t2 mb-1" htmlFor="cal-end">
                          結束時間（選填，留空＝單點）
                        </label>
                        <input
                          id="cal-end"
                          type="datetime-local"
                          className="w-full input-theme rounded px-3 py-2"
                          value={form.endAtText}
                          onChange={(e) => setForm({ ...form, endAtText: e.target.value })}
                        />
                      </div>
                    </div>
                    {sortedSchoolPeriods.length > 0 && (
                      <div className="border-themed bg-surface space-y-1 rounded-md p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-t2 text-xs">課表作息</span>
                          <select
                            aria-label="開始節次"
                            className="input-theme rounded px-2 py-1 text-xs"
                            value={periodStartCode}
                            onChange={(e) => {
                              const code = e.target.value;
                              setPeriodStartCode(code);
                              const start = periodByCode.get(code);
                              const end = periodByCode.get(periodEndCode);
                              const startDate = datePartOf(form.startAtText);
                              const endDate = datePartOf(form.endAtText);
                              const today = toDatetimeLocal(Date.now()).slice(0, 10);
                              const effectiveStart = startDate || today;
                              const effectiveEnd = endDate || effectiveStart;
                              // 同一天才自動把結束節次對齊到不早於開始節次；
                              // 跨日時結束節次可以比開始節次早（如 11/12 第七節 → 11/13 第一節）。
                              const sameDay = effectiveStart === effectiveEnd;
                              if (
                                code &&
                                (!periodEndCode ||
                                  !end ||
                                  (sameDay && start && end.start < start.start))
                              ) {
                                setPeriodEndCode(code);
                              }
                            }}
                          >
                            <option value="">開始節次</option>
                            {sortedSchoolPeriods.map((period) => (
                              <option key={period.code} value={period.code}>
                                {period.name}（{period.start}–{period.end}）
                              </option>
                            ))}
                          </select>
                          <span className="text-t3 text-xs">～</span>
                          <select
                            aria-label="結束節次"
                            className="input-theme rounded px-2 py-1 text-xs"
                            value={periodEndCode}
                            onChange={(e) => setPeriodEndCode(e.target.value)}
                          >
                            <option value="">結束節次（同開始）</option>
                            {sortedSchoolPeriods.map((period) => (
                              <option key={period.code} value={period.code}>
                                {period.name}（{period.start}–{period.end}）
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={applyPeriodTimes}
                            disabled={!periodStartCode}
                            className="btn-soft rounded px-2 py-1 text-xs cursor-pointer disabled:opacity-50"
                          >
                            套用課表時間
                          </button>
                        </div>
                        <p className="text-t3 text-xs">
                          以開始／結束欄位的日期套用：結束日期晚於開始日期時，結束節次會套在結束日期（支援跨日）；未填日期時用今天。套用後仍可手動微調。
                        </p>
                      </div>
                    )}
                    </>
                  )}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="cal-cat">
                  行事曆類型
                </label>
                  <select
                    id="cal-cat"
                    className="flex-1 input-theme rounded px-3 py-2"
                    value={formCategoryId}
                    onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                  >
                    {enabledCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {form.id && formCategoryId !== form.categoryId && (
                    <p className="text-xs text-t3 mt-1">
                      原類型已刪除，已自動歸入「{CALENDAR_FALLBACK_CATEGORY_NAME}」
                    </p>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <span className="text-t2 sm:w-40 shrink-0">重要行程</span>
                  <label className="inline-flex items-center gap-1.5 text-sm text-t1">
                    <input
                      type="checkbox"
                      checked={form.important}
                      onChange={(e) => setForm({ ...form, important: e.target.checked })}
                    />
                    以星號標記
                  </label>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <span className="text-danger sm:w-40 shrink-0 font-medium">學校活動層級</span>
                <div className="flex-1 space-y-2">
                  <p className="text-danger text-xs">用於日後衝堂比對；未勾選任何層級＝無。</p>
                  <label className="inline-flex items-center gap-1.5 text-sm text-t1">
                    <input
                      type="checkbox"
                      checked={form.schoolActivity.school}
                      onChange={(e) => toggleSchoolActivitySchool(e.target.checked)}
                    />
                    全校
                  </label>
                  {classGrades.length === 0 ? (
                    <p className="text-t3 text-xs">學校尚未設定年段班級。</p>
                  ) : (
                    <div
                      className={`space-y-2${form.schoolActivity.school ? " opacity-50" : ""}`}
                    >
                      {classGrades.map((gradeOption) => {
                        const selected = form.schoolActivity.grades.find(
                          (entry) => entry.grade === gradeOption.grade
                        );
                        return (
                          <div
                            key={gradeOption.grade}
                            className="border-themed bg-surface rounded-md p-2"
                          >
                            <label className="inline-flex items-center gap-1.5 text-sm text-t1">
                              <input
                                type="checkbox"
                                checked={Boolean(selected)}
                                disabled={form.schoolActivity.school}
                                onChange={(e) =>
                                  toggleSchoolActivityGrade(gradeOption.grade, e.target.checked)
                                }
                              />
                              {gradeOption.grade}
                            </label>
                            {selected && !form.schoolActivity.school && (
                              <div className="mt-1 ml-6 space-y-1">
                                <div className="flex flex-wrap gap-x-3 gap-y-1">
                                  {gradeOption.classes.map((cls) => (
                                    <label
                                      key={cls.code}
                                      className="text-t2 inline-flex items-center gap-1 text-xs"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selected.classCodes.includes(cls.code)}
                                        onChange={(e) =>
                                          toggleSchoolActivityClass(
                                            gradeOption.grade,
                                            cls.code,
                                            e.target.checked
                                          )
                                        }
                                      />
                                      {cls.name || cls.code}
                                    </label>
                                  ))}
                                </div>
                                <p className="text-t3 text-xs">未勾選班級＝全年級。</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <span className="text-t2 sm:w-40 shrink-0">閱讀權限</span>
                <div className="flex-1">
                  <div className="flex flex-wrap gap-3">
                    <label className="inline-flex items-center gap-1.5 text-sm text-t1">
                      <input
                        type="checkbox"
                        checked={form.isPublic}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            isPublic: e.target.checked,
                            roles: e.target.checked ? [] : prev.roles,
                            classCodesText: e.target.checked ? "" : prev.classCodesText,
                          }))
                        }
                      />
                      無（公開，不需登入即可查閱）
                    </label>
                    {ALL_ROLES.map((role) => (
                      <label
                        key={role}
                        className={`inline-flex items-center gap-1.5 text-sm ${
                          form.isPublic ? "text-t3" : "text-t1"
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={form.isPublic}
                          checked={form.roles.includes(role)}
                          onChange={() => toggleRole(role)}
                        />
                        {ROLE_LABELS[role]}
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-t3 mt-1">
                    勾選「無」＝任何人（含未登入）皆可查閱、一律全校；勾選身分＝僅該身分登入後可見（可多選，與「無」互斥）。
                  </p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label className="text-t2 sm:w-40 shrink-0" htmlFor="cal-classes">
                  班級代碼（選填，逗號分隔；留空＝全校）
                </label>
                <input
                  id="cal-classes"
                  className="flex-1 input-theme rounded px-3 py-2 disabled:opacity-50"
                  value={form.classCodesText}
                  disabled={form.isPublic}
                  onChange={(e) => setForm({ ...form, classCodesText: e.target.value })}
                  placeholder={form.isPublic ? "閱讀權限「無」＝全校" : "例如：101, 102"}
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
                >
                  {saving ? "處理中..." : form.id ? "儲存變更" : "建立行程"}
                </button>
                {form.id && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={cancelEdit}
                    className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
                  >
                    取消編輯
                  </button>
                )}
              </div>
            </form>
          </div>
        )}
      </details>
      )}

      {/* 2-5. 批次新增（xlsx/xls 匯入：下載範例 → 上傳預覽 → 確認建立） */}
      {access.import && (
      <details
        open={batchOpen}
        onToggle={(e) => setBatchOpen(e.currentTarget.open)}
        className="border border-themed rounded-lg bg-card"
      >
        <summary className="flex list-none cursor-pointer items-center justify-between gap-3 px-5 py-3.5 text-left">
          <div>
            <h3 className="text-base font-bold text-t1">批次新增行程</h3>
            <p className="text-xs text-t3 mt-0.5">
              上傳試算表（xlsx／xls）批次建立行程；含全天、時段、跨日日期、跨日日期時間、課表節次與學校活動層級範例。
            </p>
          </div>
          <DisclosureArrow />
        </summary>
        {batchOpen && (
          <div className="px-5 pb-5 space-y-4">
            {/* 第一步：明顯的範例檔下載按鈕 */}
            <div className="flex flex-wrap items-center gap-3">
              <a
                href="/api/admin/calendar/import"
                download
                className="btn-theme inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
                下載範例檔（xlsx）
              </a>
              <p className="text-xs text-t3">
                範例含全天、單日時段、跨日日期、跨日日期時間4種格式；
                <span className="font-semibold text-t1">上傳前請刪除所有「【範例】」列</span>
                。
              </p>
            </div>

            <div className="rounded-lg border border-themed bg-surface px-4 py-3 text-xs text-t2 space-y-1">
              <p>1. 下載範例檔，照格式填寫行程（全天＝僅單日；跨日請用日期／日期時間區間，結束不帶時間＝補到當日結束）。</p>
              <p>2. 使用課表節次時，「開始」欄只需填日期，並在「開始節次／結束節次」填節次（代碼、名稱或編號均可）；只填開始節次＝單一節次。</p>
              <p>3. 學校活動層級：「學校活動層級」填「全校」或年級名稱（多個年級以逗號／頓號分隔）；「學校活動班級」選填：單一年級直接填班級代碼（留空＝全年級），多個年級要指定班級時用「年級:班級」分號分隔（例：一年級:101,102;二年級:201）；年級與班級須為學校已設定者，兩欄留空＝無。</p>
              <p>4. 選擇檔案 →「解析預覽」確認列內容 →「確認新增」才會寫入。</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={batchFileRef}
                type="file"
                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                onChange={(e) => {
                  setBatchFile(e.target.files?.[0] ?? null);
                  setBatchPreview(null);
                  setBatchResult(null);
                  setBatchError("");
                }}
                className="text-sm text-t2 file:mr-3 file:rounded file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-sm file:cursor-pointer"
              />
              <button
                type="button"
                disabled={!batchFile || batchBusy !== ""}
                onClick={() => void runImport(true)}
                className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
              >
                {batchBusy === "preview" ? "解析中…" : "解析預覽"}
              </button>
              {batchPreview && batchPreview.creatable > 0 && (
                <button
                  type="button"
                  disabled={batchBusy !== ""}
                  onClick={confirmImport}
                  className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer disabled:opacity-50"
                >
                  {batchBusy === "execute" ? "新增中…" : `確認新增（${batchPreview.creatable} 筆）`}
                </button>
              )}
            </div>

            {batchError && (
              <p className="text-sm text-danger" role="alert">
                {batchError}
              </p>
            )}

            {batchResult && (
              <div className="rounded-lg border border-themed bg-surface px-4 py-3 text-sm text-t2 space-y-1">
                <p className="font-medium text-t1">{batchResult.message}</p>
                {batchResult.skipped.length > 0 && (
                  <ul className="text-xs text-t3 space-y-0.5">
                    {batchResult.skipped.map((item) => (
                      <li key={item.row}>
                        第 {item.row} 列：{item.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {batchPreview && (
              <div className="border border-themed rounded-lg overflow-hidden">
                <div className="px-4 py-2.5 border-b border-themed text-sm text-t2">
                  預覽：共 {batchPreview.total} 列，可新增 {batchPreview.creatable} 筆
                  {batchPreview.skipped > 0 ? `、略過 ${batchPreview.skipped} 列` : ""}
                  {batchPreview.creatable === 0 ? "（無可新增列，請修正錯誤後重新預覽）" : ""}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[44rem] text-sm text-left">
                    <thead className="border-b border-themed bg-surface text-t2">
                      <tr>
                        <th className="px-4 py-2 font-medium">列</th>
                        <th className="px-4 py-2 font-medium">標題</th>
                        <th className="px-4 py-2 font-medium">類型</th>
                        <th className="px-4 py-2 font-medium">學校活動</th>
                        <th className="px-4 py-2 font-medium">時間</th>
                        <th className="px-4 py-2 font-medium">結果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchPreview.rows.map((row) => (
                        <tr key={row.row} className="border-b border-themed last:border-0 text-t1">
                          <td className="px-4 py-2 text-t3">{row.row}</td>
                          <td className="px-4 py-2">{row.title || "—"}</td>
                          <td className="px-4 py-2 text-t2">{row.categoryName ?? "—"}</td>
                          <td className="px-4 py-2 text-t2">{row.schoolActivity ?? "—"}</td>
                          <td className="px-4 py-2 text-t2">{row.timeText}</td>
                          <td className="px-4 py-2">
                            {row.action === "create" ? (
                              <span className="text-success">可新增</span>
                            ) : (
                              <span className="text-danger">略過：{row.reason}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </details>
      )}

      {/* 3. 行程清單（月份切換、搜尋、狀態篩選；省流啟用時預設不載入） */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-bold text-t1">行程清單</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={keyword}
              onChange={(e) => {
                const value = e.target.value;
                setKeyword(value);
                if (value && gating) void loadList();
              }}
              placeholder="搜尋標題／說明／地點／建立者"
              aria-label="搜尋行程"
              className="input-theme rounded px-2 py-1 text-sm w-44"
            />
            {!gating && listLoaded && (
              <>
                <div className="flex items-center gap-1 text-sm">
                  <button
                    type="button"
                    onClick={() => setMonth(null)}
                    aria-pressed={month === null}
                    className={`px-2 py-1 rounded border cursor-pointer ${
                      month === null
                        ? "border-primary text-primary"
                        : "border-themed text-t3 hover:text-t1"
                    }`}
                  >
                    全部
                  </button>
                  <button
                    type="button"
                    aria-label="上一個月"
                    onClick={() => setMonth(shiftMonth(month ?? monthKey(Date.now()), -1))}
                    className="px-2 py-1 rounded border border-themed text-t3 hover:text-t1 cursor-pointer"
                  >
                    ‹
                  </button>
                  <span className="px-1 text-t2 whitespace-nowrap">{monthLabel}</span>
                  <button
                    type="button"
                    aria-label="下一個月"
                    onClick={() => setMonth(shiftMonth(month ?? monthKey(Date.now()), 1))}
                    className="px-2 py-1 rounded border border-themed text-t3 hover:text-t1 cursor-pointer"
                  >
                    ›
                  </button>
                </div>
                <label className="flex items-center gap-1 text-sm text-t2" htmlFor="cal-status">
                  篩選
                </label>
                <select
                  id="cal-status"
                  className="input-theme rounded px-2 py-1"
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as "all" | CalendarEventStatus)
                  }
                >
                  <option value="all">全部</option>
                  <option value="active">顯示中</option>
                  <option value="cancelled">已取消</option>
                </select>
              </>
            )}
          </div>
        </div>
        {/* 批次操作列：有勾選時出現 */}
        {selectable && !gating && listLoaded && selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-3 px-1">
            <span className="text-sm text-t2">已選取 {selectedIds.size} 筆</span>
            {access.manage && (
            <button
              type="button"
              onClick={batchCancel}
              disabled={saving}
              className="btn-theme rounded-lg px-3 py-1.5 text-sm cursor-pointer disabled:opacity-50"
            >
              {policies.hardDeleteCancelled && access.delete ? "批次下架" : "批次取消"}
            </button>
            )}
            {access.delete && (
            <button
              type="button"
              onClick={batchRemove}
              disabled={saving}
              className="btn-danger rounded-lg px-3 py-1.5 text-sm cursor-pointer disabled:opacity-50"
            >
              批次刪除
            </button>
            )}
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              disabled={saving}
              className="btn-theme rounded-lg px-3 py-1.5 text-sm cursor-pointer disabled:opacity-50"
            >
              取消選取
            </button>
          </div>
        )}
        <div className="border border-themed rounded-lg bg-card overflow-x-auto">
    {gating ? (
      <RevealListCard
        label="行程"
        onReveal={() => void loadList()}
        summary={
          counts
            ? `目前顯示中（未取消）${counts.active} 筆｜已取消 ${counts.cancelled} 筆`
            : undefined
        }
      />
    ) : loadingList && !listLoaded ? (
            <p className="p-6 text-center text-t3">行程清單載入中...</p>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="border-b border-themed">
                <tr className="text-t2">
                  <th className="px-3 py-2 font-medium w-10">
                    {selectable && (
                    <input
                      type="checkbox"
                      aria-label="全選目前清單"
                      checked={
                        filteredItems.length > 0 &&
                        filteredItems.every((item) => selectedIds.has(item.id))
                      }
                      onChange={toggleSelectAll}
                      className="cursor-pointer"
                    />
                    )}
                  </th>
                  <th className="px-3 py-2 font-medium">標題</th>
                  <th className="px-3 py-2 font-medium">時間</th>
                  <th className="px-3 py-2 font-medium">地點</th>
                  <th className="px-3 py-2 font-medium">閱讀權限</th>
                  <th className="px-3 py-2 font-medium">發佈單位</th>
                  <th className="px-3 py-2 font-medium">發佈者</th>
                  <th className="px-3 py-2 font-medium">狀態</th>
                  <th className="px-3 py-2 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={selectable ? 9 : 8} className="px-3 py-6 text-center text-t3">
                      尚無符合條件的行程
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => (
                    <tr key={item.id} className="border-b border-themed last:border-0 text-t1">
                      <td className="px-3 py-2 align-top">
                        {selectable && (
                        <input
                          type="checkbox"
                          aria-label={`選取「${item.title}」`}
                          checked={selectedIds.has(item.id)}
                          onChange={() => toggleSelect(item.id)}
                          className="cursor-pointer mt-1"
                        />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{item.title}</span>
                        {item.important && (
                          <span className="ml-1.5 text-xs text-primary">★ 重要</span>
                        )}
                        <span className="ml-1.5 text-xs text-t3">
                          行事曆類型：{item.categoryName}
                        </span>
                        {schoolActivityText(item.schoolActivity) && (
                          <span className="ml-1.5 text-xs text-warning">
                            學校活動：{schoolActivityText(item.schoolActivity)}
                          </span>
                        )}
                        {item.sourceModule !== "calendar" && (
                          <span className="ml-1.5 text-xs text-t3">[{item.sourceModule}]</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-t2 whitespace-nowrap">
                        {formatRange(item)}
                      </td>
                      <td className="px-3 py-2 text-t2">{item.location || "—"}</td>
                      <td className="px-3 py-2 text-t2">
                        {calendarPermissionText(item.audience, item.isPublic)}
                        {item.audience.classCodes[0] !== "*" &&
                        item.audience.classCodes.length > 0
                          ? `（${item.audience.classCodes.join("、")}）`
                          : "（全校）"}
                      </td>
                      <td className="px-3 py-2 text-t2">{item.publishUnit || "—"}</td>
                      <td className="px-3 py-2 text-t2">{item.createdBy.name || "—"}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`text-xs ${
                            item.status === "active" ? "text-success" : "text-t3"
                          }`}
                        >
                          {item.status === "active" ? "顯示中" : "已取消"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <div className="inline-flex flex-col items-end gap-1">
                          {(access.manage || access.delete) && (
                          <div className="flex gap-1.5">
                            {access.manage && (
                            <>
                            <button
                              type="button"
                              onClick={() => edit(item)}
                              className="btn-theme rounded px-2.5 py-1 text-xs cursor-pointer"
                            >
                              編輯
                            </button>
                            {item.status === "active" ? (
                              <button
                                type="button"
                                onClick={() => setStatus(item.id, "cancelled")}
                                disabled={saving}
                                className="btn-danger rounded px-2.5 py-1 text-xs cursor-pointer disabled:opacity-50"
                              >
                                {policies.hardDeleteCancelled && access.delete ? "下架" : "取消"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setStatus(item.id, "active")}
                                disabled={saving}
                                className="btn-soft rounded px-2.5 py-1 text-xs cursor-pointer disabled:opacity-50"
                              >
                                恢復
                              </button>
                            )}
                            </>
                            )}
                          </div>
                          )}
                          {access.delete && (
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => remove(item.id, item.title)}
                              disabled={saving}
                              className="btn-danger rounded px-2.5 py-1 text-xs cursor-pointer disabled:opacity-50"
                            >
                              刪除
                            </button>
                          </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
        {!gating && listLoaded && (
          <p className="text-xs text-t3 mt-2">
            已取消的行程保留文件但不會回給任何身分（「下架行程真實刪除」開啟時改為連同個人提醒刪除）；
            單頁最多載入最近 200 筆行程。
          </p>
        )}
      </section>

      {/* 確認 modal：取代原生 confirm，樣式跟隨主題（取消／恢復／刪除／批次共用） */}
      {confirmRequest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(3px)" }}
          onClick={() => setConfirmRequest(null)}
        >
          <div
            className="bg-card rounded-2xl p-6 w-full max-w-md space-y-4 shadow-lg animate-fade-in"
            role="alertdialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <h3 className="text-lg font-bold text-t1">確認操作</h3>
              <p className="text-sm text-t2 mt-2 whitespace-pre-line">{confirmRequest.message}</p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmRequest(null)}
                className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const onConfirm = confirmRequest.onConfirm;
                  setConfirmRequest(null);
                  onConfirm();
                }}
                className="btn-danger rounded-lg px-4 py-2 text-sm cursor-pointer"
              >
                確認
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 設定卡片：標題列可收合（收合時不渲染內容） */
function SettingsCard({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onToggle();
      }}
      className="border border-themed rounded-lg bg-card"
    >
      <summary className="flex list-none cursor-pointer items-center justify-between gap-3 px-5 py-3.5 text-left">
        <h3 className="text-base font-bold text-t1">{title}</h3>
        <DisclosureArrow />
      </summary>
      {open && <div className="px-5 pt-2.5 pb-5">{children}</div>}
    </details>
  );
}

/** 行程原則列：核取框＋「？」說明（點選才顯示） */
function PolicyRow({
  id,
  label,
  checked,
  onChange,
  hint,
}: {
  id: string;
  label: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <label
        htmlFor={id}
        className="inline-flex flex-1 items-center gap-1.5 text-sm text-t1 cursor-pointer"
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      <details className="mt-0.5 shrink-0">
        <summary aria-label="顯示說明" title="顯示說明" className="list-none cursor-pointer">
          <DisclosureArrow className="h-3.5 w-3.5" />
        </summary>
        <p className="mt-1 text-xs text-t3">{hint}</p>
      </details>
    </div>
  );
}
