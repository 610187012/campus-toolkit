"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Toast, { type ToastMessage } from "@/components/Toast";
import DisclosureArrow from "@/components/DisclosureArrow";
import { RichTextEditor } from "../../components/rich-text-editor";
import {
  CONFIRMATION_STATUS_LABELS,
  IDENTITY_WINDOW_LABELS,
  TAX_INQUIRY_STATUS_LABELS,
  formatDateTime,
  fromDateTimeLocal,
  makeId,
  summarizeSelections,
  toDateTimeLocal,
  type IdentityFieldDef,
  type IdentityFieldOption,
  type IdentityOptionDef,
  type IdentityTaxInquirySettings,
  type IdentityWindowState,
  type InquiryRow,
  type InquiryStats,
} from "../../types/identity-tax-inquiry";

interface SettingsForm {
  enabled: boolean;
  openAt: string;
  closeAt: string;
  instructions: string;
  identityOptions: IdentityOptionDef[];
}

const EMPTY_STATS: InquiryStats = {
  total: 0,
  confirmed: 0,
  draft: 0,
  missing: 0,
  taxPending: 0,
  taxDone: 0,
  taxExempt: 0,
};

function formOf(settings: IdentityTaxInquirySettings): SettingsForm {
  return {
    enabled: settings.enabled,
    openAt: toDateTimeLocal(settings.openAt),
    closeAt: toDateTimeLocal(settings.closeAt),
    instructions: settings.instructions,
    identityOptions: settings.identityOptions.map((option) => ({
      ...option,
      fields: option.fields.map((field) => ({ ...field, options: [...field.options] })),
    })),
  };
}

const PAGE_SIZE = 20;

export default function IdentityTaxInquiryAdminPage() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [stats, setStats] = useState<InquiryStats>(EMPTY_STATS);
  const [period, setPeriod] = useState("");
  const [windowState, setWindowState] = useState<IdentityWindowState>("unset");
  const [rows, setRows] = useState<InquiryRow[] | null>(null);
  const [classCode, setClassCode] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [optionInput, setOptionInput] = useState("");
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const applyPayload = useCallback(
    (data: {
      settings?: IdentityTaxInquirySettings;
      stats?: InquiryStats;
      period?: string;
      windowState?: IdentityWindowState;
      rows?: InquiryRow[];
    }) => {
      if (data.settings) setForm(formOf(data.settings));
      if (data.stats) setStats(data.stats);
      if (typeof data.period === "string") setPeriod(data.period);
      if (data.windowState) setWindowState(data.windowState);
      if (Array.isArray(data.rows)) {
        setRows(data.rows);
        setPage(1);
      }
    },
    []
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/identity-tax-inquiry", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "讀取設定失敗" });
        return;
      }
      applyPayload(data);
    } catch {
      setToast({ kind: "error", text: "讀取設定失敗" });
    } finally {
      setLoading(false);
    }
  }, [applyPayload]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRows = useCallback(async () => {
    try {
      const query = new URLSearchParams({ mode: "records" });
      if (classCode.trim()) query.set("classCode", classCode.trim());
      const response = await fetch(`/api/admin/identity-tax-inquiry?${query.toString()}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "讀取名冊失敗" });
        return;
      }
      applyPayload(data);
    } catch {
      setToast({ kind: "error", text: "讀取名冊失敗" });
    }
  }, [applyPayload, classCode]);

  const save = async () => {
    if (!form || saving) return;
    setSaving(true);
    try {
      // 取消「開放勾選」的項目儲存時自動排到最後（同組內維持原順序）
      const orderedOptions = [...form.identityOptions].sort(
        (a, b) => Number(b.enabled) - Number(a.enabled)
      );
      setForm({ ...form, identityOptions: orderedOptions });
      const response = await fetch("/api/admin/identity-tax-inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: form.enabled,
          openAt: fromDateTimeLocal(form.openAt),
          closeAt: fromDateTimeLocal(form.closeAt),
          instructions: form.instructions,
          identityOptions: orderedOptions,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "儲存失敗" });
        return;
      }
      applyPayload(data);
      setToast({ kind: "success", text: data.message || "已儲存設定" });
    } catch {
      setToast({ kind: "error", text: "儲存失敗" });
    } finally {
      setSaving(false);
    }
  };

  const addOption = () => {
    if (!form) return;
    const text = optionInput.trim().slice(0, 40);
    if (!text) return;
    if (form.identityOptions.some((option) => option.label === text)) {
      setToast({ kind: "error", text: "身分別已存在" });
      return;
    }
    setForm({
      ...form,
      identityOptions: [
        ...form.identityOptions,
        {
          id: makeId("option"),
          label: text,
          enabled: true,
          taxInquiry: false,
          exclusiveGroup: "",
          benefitType: "",
          benefitAmount: null,
          benefitNote: "",
          fields: [],
        },
      ],
    });
    setOptionInput("");
  };

  /** 更新單一身分別欄位 */
  const updateOption = (id: string, patch: Partial<IdentityOptionDef>) => {
    if (!form) return;
    setForm({
      ...form,
      identityOptions: form.identityOptions.map((option) =>
        option.id === id ? { ...option, ...patch } : option
      ),
    });
  };

  /** 在目前群組（開放／候選）內調整順序 */
  const moveOption = (id: string, delta: number) => {
    if (!form) return;
    const current = form.identityOptions.find((option) => option.id === id);
    if (!current) return;
    const group = form.identityOptions.filter((option) => option.enabled === current.enabled);
    const index = group.findIndex((option) => option.id === id);
    const target = group[index + delta];
    if (!target) return;
    const list = [...form.identityOptions];
    const i = list.findIndex((option) => option.id === id);
    const j = list.findIndex((option) => option.id === target.id);
    [list[i], list[j]] = [list[j], list[i]];
    setForm({ ...form, identityOptions: list });
  };

  const removeOption = (id: string) => {
    if (!form) return;
    setForm({
      ...form,
      identityOptions: form.identityOptions.filter((option) => option.id !== id),
    });
  };

  const addField = (optionId: string) => {
    if (!form) return;
    updateOption(optionId, {
      fields: [
        ...(form.identityOptions.find((option) => option.id === optionId)?.fields ?? []),
        {
          id: makeId("field"),
          type: "select",
          label: "新選項",
          required: false,
          options: [],
        } satisfies IdentityFieldDef,
      ],
    });
  };

  const updateField = (optionId: string, fieldId: string, patch: Partial<IdentityFieldDef>) => {
    if (!form) return;
    updateOption(optionId, {
      fields: (form.identityOptions.find((option) => option.id === optionId)?.fields ?? []).map(
        (field) => (field.id === fieldId ? { ...field, ...patch } : field)
      ),
    });
  };

  const removeField = (optionId: string, fieldId: string) => {
    if (!form) return;
    updateOption(optionId, {
      fields: (form.identityOptions.find((option) => option.id === optionId)?.fields ?? []).filter(
        (field) => field.id !== fieldId
      ),
    });
  };

  /** 更新進階選項的單一可選值 */
  const updateFieldOption = (
    optionId: string,
    fieldId: string,
    index: number,
    patch: Partial<IdentityFieldOption>
  ) => {
    if (!form) return;
    const fields = form.identityOptions.find((option) => option.id === optionId)?.fields ?? [];
    updateField(optionId, fieldId, {
      options: (fields.find((field) => field.id === fieldId)?.options ?? []).map((item, i) =>
        i === index ? { ...item, ...patch } : item
      ),
    });
  };

  /** 新增一個可選值（預設空白，由管理者填代碼與名稱） */
  const addFieldOption = (optionId: string, fieldId: string) => {
    const fields = form?.identityOptions.find((option) => option.id === optionId)?.fields ?? [];
    updateField(optionId, fieldId, {
      options: [...(fields.find((field) => field.id === fieldId)?.options ?? []), { code: "", name: "" }],
    });
  };

  const removeFieldOption = (optionId: string, fieldId: string, index: number) => {
    const fields = form?.identityOptions.find((option) => option.id === optionId)?.fields ?? [];
    updateField(optionId, fieldId, {
      options: (fields.find((field) => field.id === fieldId)?.options ?? []).filter(
        (_, i) => i !== index
      ),
    });
  };

  /** 單一身分別卡片（group 用來判斷上移／下移是否到頂） */
  const renderOptionCard = (option: IdentityOptionDef, group: IdentityOptionDef[]) => {
    const index = group.findIndex((item) => item.id === option.id);
    return (
      <div key={option.id} className="border-themed rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-t3 w-6 shrink-0 text-xs tabular-nums" aria-hidden="true">
            {index + 1}.
          </span>
          <input
            className="input-theme min-w-40 flex-1 rounded px-3 py-2 text-sm"
            value={option.label}
            maxLength={40}
            aria-label="身分別名稱"
            onChange={(event) => updateOption(option.id, { label: event.target.value })}
          />
          <button
            type="button"
            className="btn-theme rounded px-2 py-1 text-xs disabled:opacity-40"
            disabled={index <= 0}
            aria-label="上移"
            onClick={() => moveOption(option.id, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn-theme rounded px-2 py-1 text-xs disabled:opacity-40"
            disabled={index === group.length - 1}
            aria-label="下移"
            onClick={() => moveOption(option.id, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="text-danger rounded px-2 py-1 text-xs"
            onClick={() => removeOption(option.id)}
          >
            刪除
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
          <label className="text-danger flex items-center gap-2">
            <input
              type="checkbox"
              checked={option.enabled}
              onChange={(event) => updateOption(option.id, { enabled: event.target.checked })}
            />
            開放勾選
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={option.taxInquiry}
              onChange={(event) => updateOption(option.id, { taxInquiry: event.target.checked })}
            />
            需財稅查調
          </label>
          <label className="flex items-center gap-2">
            <span className="text-t2 text-xs">互斥群組</span>
            <input
              className="input-theme w-32 rounded px-3 py-2 text-sm"
              value={option.exclusiveGroup}
              maxLength={40}
              placeholder="例：lowIncome"
              onChange={(event) =>
                updateOption(option.id, { exclusiveGroup: event.target.value })
              }
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
          <span className="text-t2 text-xs">優待性質</span>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={option.benefitType === "reduction"}
              onChange={(event) =>
                updateOption(option.id, {
                  benefitType: event.target.checked ? "reduction" : "",
                })
              }
            />
            減免
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={option.benefitType === "subsidy"}
              onChange={(event) =>
                updateOption(option.id, {
                  benefitType: event.target.checked ? "subsidy" : "",
                })
              }
            />
            補助
          </label>
          <label className="flex items-center gap-2">
            <span className="text-t2 text-xs">金額</span>
            <input
              type="text"
              inputMode="numeric"
              className="input-theme w-28 rounded px-3 py-2 text-sm"
              value={option.benefitAmount ?? ""}
              placeholder="正整數"
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, "");
                updateOption(option.id, {
                  benefitAmount: digits ? Number(digits) : null,
                });
              }}
            />
          </label>
        </div>
        <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-t2 shrink-0 text-xs">項目說明</span>
          <input
            type="text"
            className="input-theme w-full max-w-xl rounded px-3 py-2 text-sm"
            value={option.benefitNote ?? ""}
            maxLength={100}
            placeholder="例：學雜費減免"
            onChange={(event) => updateOption(option.id, { benefitNote: event.target.value })}
          />
        </label>
        <details className="mt-2">
          <summary className="text-t2 flex cursor-pointer list-none items-center gap-1 text-xs">
            <DisclosureArrow />
            進階選項（{option.fields.length}）
          </summary>
          <div className="mt-2 space-y-2">
            {option.fields.map((field) => (
              <div key={field.id} className="border-themed bg-surface rounded-md border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="input-theme min-w-32 flex-1 rounded px-3 py-2 text-sm"
                    value={field.label}
                    maxLength={40}
                    aria-label="進階選項名稱"
                    onChange={(event) =>
                      updateField(option.id, field.id, { label: event.target.value })
                    }
                  />
                  <select
                    className="input-theme rounded px-3 py-2 text-sm"
                    value={field.type}
                    aria-label="進階選項型態"
                    onChange={(event) =>
                      updateField(option.id, field.id, {
                        type: event.target.value as IdentityFieldDef["type"],
                      })
                    }
                  >
                    <option value="select">下拉單選</option>
                    <option value="checkbox">勾選</option>
                    <option value="text">文字</option>
                  </select>
                  <label className="text-t2 flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(event) =>
                        updateField(option.id, field.id, { required: event.target.checked })
                      }
                    />
                    必填
                  </label>
                  <button
                    type="button"
                    className="text-danger rounded px-2 py-1 text-xs"
                    onClick={() => removeField(option.id, field.id)}
                  >
                    刪除
                  </button>
                </div>
                {field.type !== "text" && (
                  <div className="mt-1 space-y-1">
                    <span className="text-t3 block text-xs">
                      選項清單（項目代碼＋項目名稱；下拉＝單選、勾選＝可多選）
                    </span>
                    {field.options.map((item, optionIndex) => (
                      <div
                        key={`${field.id}-${optionIndex}`}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <input
                          className="input-theme w-24 rounded px-2 py-1.5 text-sm"
                          placeholder="代碼"
                          value={item.code}
                          maxLength={20}
                          aria-label="項目代碼"
                          onChange={(event) =>
                            updateFieldOption(option.id, field.id, optionIndex, {
                              code: event.target.value,
                            })
                          }
                        />
                        <input
                          className="input-theme min-w-40 flex-1 rounded px-2 py-1.5 text-sm"
                          placeholder="項目名稱"
                          value={item.name}
                          maxLength={100}
                          aria-label="項目名稱"
                          onChange={(event) =>
                            updateFieldOption(option.id, field.id, optionIndex, {
                              name: event.target.value,
                            })
                          }
                        />
                        <button
                          type="button"
                          className="text-danger rounded px-2 py-1 text-xs"
                          onClick={() => removeFieldOption(option.id, field.id, optionIndex)}
                        >
                          刪除
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn-theme rounded px-3 py-1 text-xs"
                      onClick={() => addFieldOption(option.id, field.id)}
                    >
                      新增選項
                    </button>
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              className="btn-theme rounded px-3 py-1 text-xs"
              onClick={() => addField(option.id)}
            >
              新增進階選項
            </button>
          </div>
        </details>
      </div>
    );
  };

  const pageCount = useMemo(() => {
    if (!rows) return 0;
    return Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  }, [rows]);

  const pageRows = useMemo(() => {
    if (!rows) return [];
    return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }, [rows, page]);

  if (loading) {
    return <p className="text-t2 p-4 text-sm">載入中…</p>;
  }
  if (!form) {
    return <p className="text-danger p-4 text-sm">無法載入設定，請重新整理。</p>;
  }

  const enabledOptions = form.identityOptions.filter((option) => option.enabled);
  const disabledOptions = form.identityOptions.filter((option) => !option.enabled);

  return (
    <div className="content-width mx-auto space-y-4">
      <Toast message={toast} onClose={() => setToast(null)} />

      <details className="border border-themed bg-card rounded-lg p-4">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
          <h2 className="text-t1 flex items-center gap-2 text-[46px] font-bold">
            <DisclosureArrow />
            管理規則
          </h2>
          <span className="text-t3 text-xs">{period ? `${period} 學期` : ""}</span>
        </summary>

        <div className="mt-3 space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary rounded px-4 py-2 text-sm disabled:opacity-50"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "儲存中…" : "儲存設定"}
            </button>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            <span>
              <span className="text-t1 block text-[36px] font-bold">啟用本功能</span>
              <span className="text-t3 block text-xs">
                關閉後學生／教職員／家長端只顯示維護說明，資料仍保留。
              </span>
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-t2 mb-1 block text-[36px] font-bold">確認開放時間</span>
              <input
                type="datetime-local"
                className="input-theme w-full rounded px-3 py-2"
                value={form.openAt}
                onChange={(event) => setForm({ ...form, openAt: event.target.value })}
              />
            </label>
            <label className="block text-sm">
              <span className="text-t2 mb-1 block text-[36px] font-bold">確認截止時間</span>
              <input
                type="datetime-local"
                className="input-theme w-full rounded px-3 py-2"
                value={form.closeAt}
                onChange={(event) => setForm({ ...form, closeAt: event.target.value })}
              />
            </label>
          </div>
          <p className="text-t3 text-xs">
            目前狀態：{IDENTITY_WINDOW_LABELS[windowState]}（未設定開放時間＝學生端唯讀）
          </p>

          <label className="block text-sm">
            <span className="text-t2 mb-1 block text-[36px] font-bold">實施說明</span>
            <RichTextEditor
              value={form.instructions}
              onChange={(value) => setForm({ ...form, instructions: value })}
              maxLength={2000}
              placeholder="提供給學生與家長閱讀的說明"
              ariaLabel="實施說明"
            />
          </label>

          <div className="border-themed rounded-md border p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-t2 text-[36px] font-bold">身分別選項（依序顯示）</p>
              <span className="text-t3 text-xs">共 {enabledOptions.length} 項</span>
            </div>
            <div className="space-y-2">
              {enabledOptions.map((option) => renderOptionCard(option, enabledOptions))}
              {enabledOptions.length === 0 && (
                <span className="text-t3 text-xs">目前沒有開放勾選的身分別。</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                className="input-theme min-w-40 flex-1 rounded px-3 py-2 text-sm"
                placeholder="新增身分別（例：僑生）"
                value={optionInput}
                maxLength={40}
                onChange={(event) => setOptionInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addOption();
                  }
                }}
              />
              <button type="button" className="btn-theme rounded px-3 py-2 text-sm" onClick={addOption}>
                新增
              </button>
            </div>
            <p className="text-t3 mt-2 text-xs">
              互斥群組填相同代號的身分別，學生只能擇一勾選（例：低收入戶子女與中低收入戶子女同為
              lowIncome）。
            </p>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary rounded px-4 py-2 text-sm disabled:opacity-50"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "儲存中…" : "儲存設定"}
            </button>
          </div>

          <div className="border-themed mt-2 rounded-md border border-dashed p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-t2 text-[36px] font-bold">候選區</p>
              <span className="text-t3 text-xs">共 {disabledOptions.length} 項</span>
            </div>
            <p className="text-t3 mb-2 text-xs">
              取消「開放勾選」並儲存後，身分別會移到這裡；重新勾選「開放勾選」即可回到上方清單。
            </p>
            <div className="space-y-2">
              {disabledOptions.map((option) => renderOptionCard(option, disabledOptions))}
              {disabledOptions.length === 0 && (
                <span className="text-t3 text-xs">目前沒有候選項目。</span>
              )}
            </div>
          </div>
        </div>
      </details>

      <section className="border border-themed bg-card rounded-lg p-4">
        <h2 className="text-t1 mb-3 text-[27px] font-bold">確認進度</h2>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {[
            ["應確認", stats.total],
            ["已確認", stats.confirmed],
            ["草稿", stats.draft],
            ["未填寫", stats.missing],
            ["待查調", stats.taxPending],
            ["已查調", stats.taxDone],
            ["免查調", stats.taxExempt],
          ].map(([label, value]) => (
            <div key={String(label)} className="border-themed bg-surface rounded-md border px-3 py-2">
              <p className="text-t3 text-xs">{label}</p>
              <p className="text-t1 text-lg font-semibold">{value}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border border-themed bg-card rounded-lg p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-t1 text-[27px] font-bold">確認名冊</h2>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="text-t2 mb-1 block text-xs">班級代碼（可留空＝全部）</span>
              <input
                className="input-theme w-40 rounded px-3 py-2 text-sm"
                value={classCode}
                onChange={(event) => setClassCode(event.target.value)}
                placeholder="例：301"
              />
            </label>
            <button type="button" className="btn-theme rounded px-3 py-2 text-sm" onClick={() => void loadRows()}>
              載入名冊
            </button>
            <a
              className="btn-primary rounded px-3 py-2 text-sm"
              href={`/api/admin/identity-tax-inquiry?format=csv${
                classCode.trim() ? `&classCode=${encodeURIComponent(classCode.trim())}` : ""
              }`}
            >
              匯出查調名冊
            </a>
          </div>
        </div>

        {!rows ? (
          <p className="text-t3 text-sm">尚未載入名冊。</p>
        ) : rows.length === 0 ? (
          <p className="text-t3 text-sm">目前沒有資料。</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="bg-surface text-t2">
                    <th className="border border-themed px-2 py-2 text-left">班級</th>
                    <th className="border border-themed px-2 py-2 text-left">座號</th>
                    <th className="border border-themed px-2 py-2 text-left">姓名</th>
                    <th className="border border-themed px-2 py-2 text-left">註冊身分</th>
                    <th className="border border-themed px-2 py-2 text-left">確認</th>
                    <th className="border border-themed px-2 py-2 text-left">財稅查調</th>
                    <th className="border border-themed px-2 py-2 text-left">更新</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
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
                      </td>
                      <td className="border border-themed px-2 py-2">
                        {TAX_INQUIRY_STATUS_LABELS[row.taxInquiry.status]}
                      </td>
                      <td className="border border-themed px-2 py-2 text-xs">
                        {formatDateTime(row.updatedAt || null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-t3">
                共 {rows.length} 筆，第 {page} / {pageCount} 頁
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-theme rounded px-3 py-1 text-xs disabled:opacity-50"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  上一頁
                </button>
                <button
                  type="button"
                  className="btn-theme rounded px-3 py-1 text-xs disabled:opacity-50"
                  disabled={page >= pageCount}
                  onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                >
                  下一頁
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
