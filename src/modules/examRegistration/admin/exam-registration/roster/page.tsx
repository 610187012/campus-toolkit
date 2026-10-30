"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchSession } from "@/lib/session";
import OfficialExamLabel from "../../../components/official-exam-label";
import { ConfirmModal } from "../../../components/exam-feedback";
import Toast, { type ToastMessage } from "../../../components/toast";
import {
  EXAM_REGISTRATION_NUMBER_FIELDS,
  EXAM_FEE_CODE_LABELS,
  EXAM_REGISTRATION_MODE_LABELS,
  formatExamDateRange,
  formatExamDateTime,
  resolveLocationLabel,
} from "../../../types/exam-registration";
import type {
  ExamClassRoster,
  ExamClassTabs,
  ExamEvent,
  ExamRegistrationNumberField,
  ExamRosterStudent,
} from "../../../types/exam-registration";

interface ClassTabsResponse {
  success?: boolean;
  message?: string;
  eventId?: string;
  event?: ExamEvent;
  classTabs?: ExamClassTabs["classTabs"];
  applicableCount?: number;
  epoch?: number;
}

interface ClassRosterResponse {
  success?: boolean;
  message?: string;
  classCode?: string;
  students?: ExamRosterStudent[];
  classSummary?: ExamClassRoster["classSummary"];
  epoch?: number;
}

interface ExportResponse {
  success?: boolean;
  message?: string;
}

function formatListDateTime(value: number): string {
  return formatExamDateTime(value);
}

export default function ExamRegistrationRosterPage({
  listHref = "/admin/exam-registration",
  fill = false,
}: {
  /** 「返回場次清單」連結；身分功能頁內嵌管理面板時改傳該頁路徑 */
  listHref?: string;
  /** 於身分功能頁（content-width）內嵌時填滿容器；/admin 獨立使用維持 max-w-4xl 標準 */
  fill?: boolean;
}) {
  const searchParams = useSearchParams();
  const eventId = searchParams.get("eventId") ?? "";

  // 子權限（managerPermissions）：管理員恆全權；非管理員看 delegatedModules
  const [canExport, setCanExport] = useState(true);
  const [canApprove, setCanApprove] = useState(true);

  const [loading, setLoading] = useState(false);
  const [classLoading, setClassLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ uid: string; name: string } | null>(null);
  const [event, setEvent] = useState<ExamEvent | null>(null);
  const [classTabs, setClassTabs] = useState<ExamClassTabs["classTabs"]>([]);
  const [applicableCount, setApplicableCount] = useState(0);
  const [activeClass, setActiveClass] = useState("");
  const [classCache, setClassCache] = useState<Record<string, ExamClassRoster>>({});
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exportScope, setExportScope] = useState("");
  const [schoolExamCode, setSchoolExamCode] = useState("");
  const [registrationNumberField, setRegistrationNumberField] = useState<ExamRegistrationNumberField>("rollNo");
  const [ignoreNationalId, setIgnoreNationalId] = useState(false);

  // 子權限載入：管理員＝全開；非管理員＝delegatedModules 中 examRegistration 的 permissions
  useEffect(() => {
    let cancelled = false;
    fetchSession(true)
      .then((session) => {
        if (cancelled) return;
        if (!session) {
          setCanExport(false);
          setCanApprove(false);
          return;
        }
        if (session.role === "admin") {
          setCanExport(true);
          setCanApprove(true);
          return;
        }
        const grant = (session.delegatedModules ?? []).find(
          (item) => item.module === "examRegistration"
        );
        setCanExport(Boolean(grant?.permissions.includes("export")));
        setCanApprove(Boolean(grant?.permissions.includes("approve")));
      })
      .catch(() => {
        if (!cancelled) {
          setCanExport(false);
          setCanApprove(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadClassTabs = useCallback(async () => {
    if (!eventId) {
      setEvent(null);
      setClassTabs([]);
      setToast({ kind: "error", text: "缺少場次 id" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/exam-registration?eventId=${encodeURIComponent(eventId)}`, {
        cache: "no-store",
      });
      const data: ClassTabsResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data.classTabs) {
        throw new Error(data?.message || "載入班級清單失敗");
      }
      setEvent(data.event ?? null);
      setClassTabs(data.classTabs);
      setApplicableCount(data.applicableCount ?? 0);
    } catch (e) {
      setToast({ kind: "error", text: e instanceof Error ? e.message : "載入班級清單失敗" });
      setEvent(null);
      setClassTabs([]);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void loadClassTabs();
  }, [loadClassTabs]);

  useEffect(() => {
    if (!classTabs.length) {
      setActiveClass("");
      return;
    }
    if (!activeClass || !classTabs.some((item) => item.key === activeClass)) {
      setActiveClass(classTabs[0].key);
    }
  }, [activeClass, classTabs]);

  const loadClassRoster = useCallback(
    async (classCode: string) => {
      if (!eventId || !classCode) return;
      if (classCache[classCode]) return;
      setClassLoading(true);
      try {
        const params = new URLSearchParams({ eventId, classCode });
        const res = await fetch(`/api/admin/exam-registration?${params.toString()}`, { cache: "no-store" });
        const data: ClassRosterResponse | null = await res.json().catch(() => null);
        if (!res.ok || !data?.success || !data.students) {
          throw new Error(data?.message || "載入班級名冊失敗");
        }
        setClassCache((prev) => ({
          ...prev,
          [classCode]: {
            classCode: data.classCode ?? classCode,
            students: data.students ?? [],
            classSummary: data.classSummary ?? { total: 0, registeredCount: 0, optOutCount: 0, archivedCount: 0 },
            epoch: data.epoch ?? 0,
          },
        }));
      } catch (e) {
        setToast({ kind: "error", text: e instanceof Error ? e.message : "載入班級名冊失敗" });
      } finally {
        setClassLoading(false);
      }
    },
    [eventId, classCache]
  );

  useEffect(() => {
    if (activeClass) void loadClassRoster(activeClass);
  }, [activeClass, loadClassRoster]);

  const currentClassData = useMemo(() => classCache[activeClass] ?? null, [classCache, activeClass]);

  const classOptions = useMemo(() => {
    const codes = new Set<string>();
    event?.target.classes.forEach((code) => {
      if (code) codes.add(code);
    });
    classTabs.forEach((tab) => {
      if (tab.key && tab.key !== "__no_class__") codes.add(tab.key);
    });
    return Array.from(codes).sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true }));
  }, [event, classTabs]);

  useEffect(() => {
    if (!classOptions.length) {
      setExportFrom("");
      setExportTo("");
      return;
    }
    if (!classOptions.includes(exportFrom)) setExportFrom(classOptions[0]);
    if (!classOptions.includes(exportTo)) setExportTo(classOptions[classOptions.length - 1]);
  }, [classOptions, exportFrom, exportTo]);

  async function downloadScopeXlsx(scope: string, includeRegistrationNumber = false) {
    if (!event) return;
    const params = new URLSearchParams({
      eventId,
      format: includeRegistrationNumber ? "official-xlsx" : "xlsx",
      scope,
      from: exportFrom,
      to: exportTo,
    });
    if (includeRegistrationNumber) {
      const code = schoolExamCode.trim();
      if (!code) {
        setToast({ kind: "error", text: "請輸入學校升學代碼" });
        return;
      }
      params.set("schoolExamCode", code);
      params.set("registrationNumberField", registrationNumberField);
      params.set("ignoreNationalId", ignoreNationalId ? "1" : "0");
    }
    try {
      const res = await fetch(`/api/admin/exam-registration?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        const data: ExportResponse | null = await res.json().catch(() => null);
        throw new Error(data?.message || "下載名單失敗");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const filename = match ? decodeURIComponent(match[1]) : "名單.xlsx";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setToast({ kind: "error", text: e instanceof Error ? e.message : "下載名單失敗" });
    }
  }

  const filteredRows = useMemo(() => {
    return currentClassData?.students ?? [];
  }, [currentClassData]);

  async function unarchiveRegistration(studentUid: string) {
    if (!canApprove) {
      setToast({ kind: "error", text: "此帳號無審核報名（解除封存）的權限" });
      return;
    }
    if (!eventId || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/exam-registration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: eventId, registrationId: studentUid, unarchive: true }),
      });
      const data: ExportResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || "解除封存失敗");
      }
      setClassCache((prev) => {
        const next = { ...prev };
        delete next[activeClass];
        return next;
      });
      await loadClassRoster(activeClass);
      setToast({ kind: "success", text: "已解除封存" });
    } catch (e) {
      setToast({ kind: "error", text: e instanceof Error ? e.message : "解除封存失敗" });
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteClick(studentUid: string, studentName: string) {
    if (!canApprove) {
      setToast({ kind: "error", text: "此帳號無審核報名（刪除登錄）的權限" });
      return;
    }
    if (saving) return;
    setConfirmDelete({ uid: studentUid, name: studentName });
  }

  async function confirmDeleteRegistration() {
    if (!eventId || !confirmDelete || saving) return;
    setSaving(true);
    setConfirmDelete(null);
    try {
      const params = new URLSearchParams({ id: eventId, registrationId: confirmDelete.uid });
      const res = await fetch(`/api/admin/exam-registration?${params.toString()}`, {
        method: "DELETE",
      });
      const data: ExportResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || "刪除失敗");
      }
      setClassCache((prev) => {
        const next = { ...prev };
        delete next[activeClass];
        return next;
      });
      await loadClassRoster(activeClass);
      setToast({ kind: "success", text: "已刪除報名登錄" });
    } catch (e) {
      setToast({ kind: "error", text: e instanceof Error ? e.message : "刪除失敗" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`w-full ${fill ? "" : "max-w-4xl"} mb-8 space-y-4`}>
      <section className="border border-themed rounded-lg bg-card px-5 py-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold text-t1">查看名單</h2>
            <p className="text-xs text-t3">點選班級分頁載入該班名冊，匯出檔案請使用下方「資料整理」。</p>
          </div>
          <a href={listHref} className="btn-soft rounded px-3 py-1 text-xs cursor-pointer">
            返回場次清單
          </a>
        </div>

        {loading ? <p className="text-sm text-t2">載入中…</p> : null}

        {event && !loading ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-t1">
                  {event.title}
                  <OfficialExamLabel title={event.title} />
                </h3>
                <p className="text-xs text-t3">
                  應報名 {applicableCount} 人；
                  {currentClassData
                    ? `本班 ${currentClassData.classSummary.total} 人／完成報名 ${currentClassData.classSummary.registeredCount} 人／不報名 ${currentClassData.classSummary.optOutCount} 人／未完成報名 ${Math.max(0, currentClassData.classSummary.total - currentClassData.classSummary.registeredCount - currentClassData.classSummary.optOutCount)} 人；`
                    : "點選班級查看明細；"}
                  {formatExamDateRange(event)}・
                  {EXAM_REGISTRATION_MODE_LABELS[event.registrationMode]}
                </p>
              </div>
            </div>

            {canExport && (
            <div className="border border-themed rounded-lg p-4 space-y-3">
              <div>
                <h4 className="text-sm font-bold text-t1">資料整理</h4>
                <p className="text-xs text-t3">設定班級範圍與名單類型，產生報名資料檔。</p>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <span className="block text-xs text-t2">起始班級</span>
                  <select
                    value={exportFrom}
                    onChange={(evt) => setExportFrom(evt.target.value)}
                    disabled={!classOptions.length}
                    className="input-theme rounded px-3 py-2 text-sm cursor-pointer disabled:opacity-50"
                  >
                    {classOptions.length ? (
                      classOptions.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))
                    ) : (
                      <option value="">（尚無班級）</option>
                    )}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-t2">結束班級</span>
                  <select
                    value={exportTo}
                    onChange={(evt) => setExportTo(evt.target.value)}
                    disabled={!classOptions.length}
                    className="input-theme rounded px-3 py-2 text-sm cursor-pointer disabled:opacity-50"
                  >
                    {classOptions.length ? (
                      classOptions.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))
                    ) : (
                      <option value="">（尚無班級）</option>
                    )}
                  </select>
                </label>
                <span className="text-t3 self-end pb-2.5">/</span>
                <label className="space-y-1">
                  <span className="block text-xs text-t2">名單類型</span>
                  <select
                    value={exportScope}
                    onChange={(evt) => {
                      const scope = evt.target.value;
                      setExportScope(scope);
                      if (!scope) return;
                      void downloadScopeXlsx(scope).finally(() => setExportScope(""));
                    }}
                    className="input-theme rounded px-3 py-2 text-sm cursor-pointer"
                  >
                    <option value="">請選擇報表</option>
                    <option value="all">全部情形名單</option>
                    <option value="registered">完成報名名單</option>
                    <option value="pending">未完成報名名單</option>
                  </select>
                </label>
                <span className="text-t3 self-end pb-2.5">/</span>
                <label className="space-y-1">
                  <span className="block text-xs text-t2">學校升學代碼</span>
                  <input
                    type="text"
                    size={6}
                    value={schoolExamCode}
                    onChange={(evt) => setSchoolExamCode(evt.target.value)}
                    className="input-theme rounded px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-t2">報名序號欄位</span>
                  <select
                    value={registrationNumberField}
                    onChange={(evt) => setRegistrationNumberField(evt.target.value as ExamRegistrationNumberField)}
                    className="input-theme rounded px-3 py-2 text-sm cursor-pointer"
                  >
                    {EXAM_REGISTRATION_NUMBER_FIELDS.map((field) => (
                      <option key={field.key} value={field.key}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-t1 pb-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ignoreNationalId}
                    onChange={(e) => setIgnoreNationalId(e.target.checked)}
                  />
                  忽略身分證
                </label>
                <button
                  type="button"
                  onClick={() => void downloadScopeXlsx("registered", true)}
                  className="btn-theme rounded px-3 py-1.5 text-sm cursor-pointer"
                >
                  報名資料檔
                </button>
              </div>
              <p className="text-xs text-t3">
                官方報名序號＝學校升學代碼＋所選學生名冊欄位；例如 931＋班號 30101＝93130101。
                報名資料檔的列依報名序號由小到大排序，缺身分證的列排在檔案最上方（未勾選「忽略身分證」時，
                缺證號會阻止匯出並列出班級與姓名；勾選後照常匯出）。
              </p>
            </div>
            )}

            <div className="flex flex-wrap gap-2">
              {classTabs.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveClass(item.key)}
                  className={`rounded border px-3 py-1 text-xs cursor-pointer ${
                    activeClass === item.key
                      ? "border-primary text-primary bg-themed"
                      : "border-themed text-t2 hover:text-t1"
                  }`}
                >
                  {item.label}（{item.count}）
                </button>
              ))}
            </div>

            {classLoading ? <p className="text-sm text-t2">載入班級名冊中…</p> : null}

            {!classLoading && currentClassData ? (
            <div className="overflow-x-auto border border-themed rounded">
              <table className="w-full text-sm text-left">
                <thead className="border-b border-themed">
                  <tr className="text-t2">
                    <th className="px-3 py-2 font-medium">班級</th>
                    <th className="px-3 py-2 font-medium">座號</th>
                    <th className="px-3 py-2 font-medium">姓名</th>
                    <th className="px-3 py-2 font-medium">報名情形</th>
                    <th className="px-3 py-2 font-medium">選考科目</th>
                    {event.locationOptions?.length ? (
                      <th className="px-3 py-2 font-medium">試場</th>
                    ) : null}
                    <th className="px-3 py-2 font-medium">繳費</th>
                    <th className="px-3 py-2 font-medium">更新時間</th>
                    <th className="px-3 py-2 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8 + (event.locationOptions?.length ? 1 : 0)}
                        className="px-3 py-6 text-center text-t3"
                      >
                        {event.registrationMode === "optional"
                          ? "此班級尚無完成報名的學生"
                          : "此班級尚無學生"}
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => {
                      const reg = row.registration;
                      const isPending = row.status === "pending";
                      const isOptOut = row.status === "opt_out";
                      const labels = isOptOut || !reg
                        ? []
                        : event.subjects
                            .filter((subject) => reg.subjectKeys.includes(subject.key))
                            .map((subject) => {
                              const selectedCode = reg.subjectAdvancedOptionCodes?.[subject.key] ?? "";
                              const selectedLabel =
                                selectedCode && subject.advancedOptions?.length
                                  ? subject.advancedOptions.find((option) => option.code === selectedCode)?.label ?? selectedCode
                                  : "";
                              return selectedLabel ? `${subject.label}（${selectedLabel}）` : subject.label;
                            });
                      return (
                        <tr key={row.studentUid} className="border-b border-themed last:border-0 text-t1">
                          <td className="px-3 py-2 whitespace-nowrap">{row.studentClass || "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap text-t2">{row.seatNo || "—"}</td>
                          <td className="px-3 py-2">
                            {row.studentName}
                            {reg?.archived && <span className="ml-1.5 text-xs text-t3">（已封存）</span>}
                          </td>
                          <td className="px-3 py-2">
                            {isPending ? (
                              <span className="text-xs text-t3">未完成報名</span>
                            ) : isOptOut ? (
                              <span className="text-xs text-t2" title={reg?.optOutReason}>
                                不報名
                              </span>
                            ) : (
                              <span className="text-xs text-success">完成報名</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-t2">{isOptOut || isPending ? "—" : labels.join("、") || "—"}</td>
                          {event.locationOptions?.length ? (
                            <td className="px-3 py-2 text-t2 whitespace-nowrap">
                              {isOptOut || isPending || !reg?.locationCode
                                ? "—"
                                : resolveLocationLabel(event.locationOptions, reg.locationCode)}
                            </td>
                          ) : null}
                          <td className="px-3 py-2 text-t2 whitespace-nowrap">
                            {isOptOut || isPending || !reg
                              ? "—"
                              : `${EXAM_FEE_CODE_LABELS[reg.feeCode] ?? reg.feeCode} ${reg.feeAmount} 元`}
                          </td>
                          <td className="px-3 py-2 text-t3 whitespace-nowrap">
                            {reg ? formatListDateTime(reg.updatedAt) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {reg && canApprove ? (
                              <span className="inline-flex items-center gap-1">
                                {reg.archived ? (
                                  <button
                                    type="button"
                                    onClick={() => void unarchiveRegistration(reg.studentUid)}
                                    disabled={saving}
                                    className="btn-soft rounded px-2 py-1 text-xs cursor-pointer disabled:opacity-50"
                                  >
                                    解除封存
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => handleDeleteClick(reg.studentUid, row.studentName)}
                                  disabled={saving}
                                  className="rounded border border-danger px-2 py-1 text-xs text-danger cursor-pointer disabled:opacity-50 hover:bg-danger hover:text-white"
                                >
                                  刪除
                                </button>
                              </span>
                            ) : (
                              <span className="text-xs text-t3">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {confirmDelete && (
        <ConfirmModal
          text={`確定要硬刪除「${confirmDelete.name}」的報名登錄嗎？\n此操作無法復原。`}
          confirmLabel="刪除"
          danger
          onConfirm={() => void confirmDeleteRegistration()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
