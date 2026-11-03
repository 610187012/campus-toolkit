"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Toast, { type ToastMessage } from "@/components/Toast";
import { RichTextContent } from "../../components/rich-text-editor";
import { stripHtmlToText } from "../../lib/rich-text";
import {
  CONFIRMATION_STATUS_LABELS,
  IDENTITY_WINDOW_LABELS,
  TAX_INQUIRY_STATUS_LABELS,
  formatDateTime,
  summarizeSelections,
  type IdentityTaxInquirySettings,
  type IdentityWindowState,
  type InquiryRow,
  type InquiryStats,
  type StaffRoles,
  type TaxInquiryStatus,
} from "../../types/identity-tax-inquiry";

const EMPTY_STATS: InquiryStats = {
  total: 0,
  confirmed: 0,
  draft: 0,
  missing: 0,
  taxPending: 0,
  taxDone: 0,
  taxExempt: 0,
};

const TAX_STATUS_OPTIONS: Array<Exclude<TaxInquiryStatus, "none">> = ["pending", "done", "exempt"];

export default function IdentityTaxInquiryStaffPage() {
  const router = useRouter();
  const [rows, setRows] = useState<InquiryRow[]>([]);
  const [stats, setStats] = useState<InquiryStats>(EMPTY_STATS);
  const [roles, setRoles] = useState<StaffRoles | null>(null);
  const [settings, setSettings] = useState<IdentityTaxInquirySettings | null>(null);
  const [windowState, setWindowState] = useState<IdentityWindowState>("unset");
  const [period, setPeriod] = useState("");
  const [classCode, setClassCode] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState("");
  const [target, setTarget] = useState<InquiryRow | null>(null);
  const [taxStatus, setTaxStatus] = useState<Exclude<TaxInquiryStatus, "none">>("done");
  const [taxNote, setTaxNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const load = useCallback(async () => {
    try {
      const query = filter.trim() ? `?classCode=${encodeURIComponent(filter.trim())}` : "";
      const response = await fetch(`/api/staff/identity-tax-inquiry${query}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setDenied(data.message || "讀取名冊失敗");
        return;
      }
      setDenied("");
      setRows(Array.isArray(data.rows) ? (data.rows as InquiryRow[]) : []);
      setStats((data.stats as InquiryStats) ?? EMPTY_STATS);
      setRoles((data.roles as StaffRoles) ?? null);
      setSettings((data.settings as IdentityTaxInquirySettings) ?? null);
      setWindowState((data.windowState as IdentityWindowState) ?? "unset");
      setPeriod(typeof data.period === "string" ? data.period : "");
      setClassCode(typeof data.classCode === "string" ? data.classCode : "");
    } catch {
      setToast({ kind: "error", text: "讀取名冊失敗" });
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openTaxModal = (row: InquiryRow) => {
    setTarget(row);
    setTaxStatus(row.taxInquiry.status === "none" ? "pending" : row.taxInquiry.status);
    setTaxNote(row.taxInquiry.note);
  };

  const saveTax = async () => {
    if (!target || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/staff/identity-tax-inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentUid: target.studentUid, status: taxStatus, note: taxNote }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "更新失敗" });
        return;
      }
      setToast({ kind: "success", text: data.message || "已更新財稅查調狀態" });
      setTarget(null);
      await load();
    } catch {
      setToast({ kind: "error", text: "更新失敗" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-t2 p-4 text-sm">載入中…</p>;
  }

  return (
    <div className="content-width mx-auto space-y-4 p-4 sm:p-6">
      <Toast message={toast} onClose={() => setToast(null)} />

      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-t1 text-xl font-semibold">註冊身分與財稅查調</h1>
          <p className="text-t2 mt-1 text-sm">
            {period} 學期
            {roles?.isTutor && classCode ? `・本班 ${classCode}` : ""}
            {roles?.permissions.includes("taxInquiry") ? "・具財稅查調權限" : ""}
          </p>
          <p className="text-t3 mt-1 text-xs">{IDENTITY_WINDOW_LABELS[windowState]}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-theme rounded px-3 py-2 text-sm" onClick={() => router.push("/staff")}>
            返回功能首頁
          </button>
        </div>
      </header>

      {denied ? (
        <div className="alert-danger rounded-lg p-4 text-sm">{denied}</div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ["應確認", stats.total],
              ["已確認", stats.confirmed],
              ["草稿", stats.draft],
              ["未填寫", stats.missing],
              ["待查調", stats.taxPending],
              ["已查調", stats.taxDone],
              ["免查調", stats.taxExempt],
            ].map(([label, value]) => (
              <div key={String(label)} className="border-themed bg-card rounded-md border px-3 py-2">
                <p className="text-t3 text-xs">{label}</p>
                <p className="text-t1 text-lg font-semibold">{value}</p>
              </div>
            ))}
          </section>

          {(roles?.permissions.includes("viewRecords") || roles?.permissions.includes("taxInquiry")) && (
            <section className="border-themed bg-card rounded-lg p-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  <span className="text-t2 mb-1 block text-xs">班級代碼（留空＝全部）</span>
                  <input
                    className="input-theme w-40 rounded px-3 py-2 text-sm"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="例：301"
                  />
                </label>
                <button type="button" className="btn-theme rounded px-3 py-2 text-sm" onClick={() => void load()}>
                  查詢
                </button>
              </div>
            </section>
          )}

          <section className="border-themed bg-card rounded-lg p-4">
            <h2 className="text-t1 mb-3 text-base font-semibold">確認名冊</h2>
            {settings && stripHtmlToText(settings.instructions).trim() && (
              <RichTextContent html={settings.instructions} className="text-t3 mb-3 text-xs" />
            )}
            {rows.length === 0 ? (
              <p className="text-t3 text-sm">目前沒有資料。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-sm">
                  <thead>
                    <tr className="bg-surface text-t2">
                      <th className="border border-themed px-2 py-2 text-left">班級</th>
                      <th className="border border-themed px-2 py-2 text-left">座號</th>
                      <th className="border border-themed px-2 py-2 text-left">姓名</th>
                      <th className="border border-themed px-2 py-2 text-left">註冊身分</th>
                      <th className="border border-themed px-2 py-2 text-left">確認</th>
                      <th className="border border-themed px-2 py-2 text-left">財稅查調</th>
                      <th className="border border-themed px-2 py-2 text-left">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.studentUid}>
                        <td className="border border-themed px-2 py-2">{row.className || row.classCode}</td>
                        <td className="border border-themed px-2 py-2">{row.seatNo || "—"}</td>
                        <td className="border border-themed text-t1 px-2 py-2">{row.studentName || "—"}</td>
                        <td className="border border-themed px-2 py-2">
                          {summarizeSelections(row.identitySelections) ||
                            row.identities.join("、") ||
                            "—"}
                        </td>
                        <td className="border border-themed px-2 py-2">
                          {row.status === "missing" ? "未填寫" : CONFIRMATION_STATUS_LABELS[row.status]}
                          {row.confirmedAt ? (
                            <span className="text-t3 block text-xs">{formatDateTime(row.confirmedAt)}</span>
                          ) : null}
                        </td>
                        <td className="border border-themed px-2 py-2">
                          {TAX_INQUIRY_STATUS_LABELS[row.taxInquiry.status]}
                          {row.taxInquiry.updatedAt ? (
                            <span className="text-t3 block text-xs">
                              {row.taxInquiry.updatedByName || "承辦"}・
                              {formatDateTime(row.taxInquiry.updatedAt)}
                            </span>
                          ) : null}
                        </td>
                        <td className="border border-themed px-2 py-2">
                          <button
                            type="button"
                            className="btn-theme rounded px-2 py-1 text-xs disabled:opacity-50"
                            disabled={row.status !== "confirmed"}
                            onClick={() => openTaxModal(row)}
                          >
                            更新查調
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {target && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="tax-modal-title"
            className="border-themed bg-card w-full max-w-md rounded-lg border p-4 shadow-lg"
          >
            <h2 id="tax-modal-title" className="text-t1 text-base font-semibold">
              更新財稅查調：{target.studentName}
            </h2>
            <p className="text-t3 mt-1 text-xs">
              查調證號：
              {target.father.idNumber ||
              target.mother.idNumber ||
              target.self.idNumber ||
              target.guardian.idNumber
                ? "已填寫"
                : "未填寫"}
            </p>
            <label className="mt-3 block text-sm">
              <span className="text-t2 mb-1 block">查調狀態</span>
              <select
                className="input-theme w-full rounded px-3 py-2"
                value={taxStatus}
                onChange={(event) =>
                  setTaxStatus(event.target.value as Exclude<TaxInquiryStatus, "none">)
                }
              >
                {TAX_STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {TAX_INQUIRY_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm">
              <span className="text-t2 mb-1 block">備註（選填）</span>
              <textarea
                className="input-theme min-h-24 w-full rounded px-3 py-2"
                maxLength={500}
                value={taxNote}
                onChange={(event) => setTaxNote(event.target.value)}
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-theme rounded px-4 py-2 text-sm"
                disabled={saving}
                onClick={() => setTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary rounded px-4 py-2 text-sm disabled:opacity-50"
                disabled={saving}
                onClick={() => void saveTax()}
              >
                {saving ? "儲存中…" : "儲存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
