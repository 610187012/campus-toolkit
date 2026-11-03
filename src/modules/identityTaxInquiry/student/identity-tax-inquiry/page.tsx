"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import AdSense from "@/components/AdSense";
import Copyright from "@/components/Copyright";
import Toast, { type ToastMessage } from "@/components/Toast";
import { RichTextContent } from "../../components/rich-text-editor";
import PersonalDataConsentDialog from "../../components/personal-data-consent-dialog";
import { stripHtmlToText } from "../../lib/rich-text";
import { fetchSettings } from "@/lib/settings-client";
import { logout } from "@/lib/session";
import { defaultSettings, type Settings } from "@/types/settings";
import {
  CONFIRMATION_STATUS_LABELS,
  IDENTITY_WINDOW_LABELS,
  MAINTENANCE_HINT,
  MAINTENANCE_TITLE,
  PERSONAL_DATA_CONSENT_VERSION,
  TAX_INQUIRY_STATUS_LABELS,
  TAX_SUBJECT_LABELS,
  enabledIdentityOptions,
  fieldOptionName,
  formatDateTime,
  isValidIdNumber,
  needsTaxInquiry,
  type IdentityOptionDef,
  type IdentitySelection,
  type IdentityTaxInquiryRecord,
  type IdentityTaxInquirySettings,
  type IdentityWindowState,
  type TaxSubject,
} from "../../types/identity-tax-inquiry";

interface StudentPayload {
  student: { name: string; className: string };
}

export default function IdentityTaxInquiryStudentPage() {
  const router = useRouter();
  const [systemSettings, setSystemSettings] = useState<Settings>(defaultSettings);
  const [settings, setSettings] = useState<IdentityTaxInquirySettings | null>(null);
  const [record, setRecord] = useState<IdentityTaxInquiryRecord | null>(null);
  const [student, setStudent] = useState<StudentPayload["student"] | null>(null);
  const [windowState, setWindowState] = useState<IdentityWindowState>("unset");
  const [period, setPeriod] = useState("");
  const [maintenance, setMaintenance] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"draft" | "confirm" | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [showConsent, setShowConsent] = useState(false);

  const [selections, setSelections] = useState<IdentitySelection[]>([]);
  const [taxSubject, setTaxSubject] = useState<TaxSubject>("both");
  const [father, setFather] = useState({ idNumber: "" });
  const [mother, setMother] = useState({ idNumber: "" });
  const [self, setSelf] = useState({ idNumber: "" });
  const [guardian, setGuardian] = useState({ idNumber: "" });
  const [note, setNote] = useState("");

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

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/student/identity-tax-inquiry", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "讀取資料失敗" });
        return;
      }
      setMaintenance(Boolean(data.maintenance));
      setSettings((data.settings as IdentityTaxInquirySettings) ?? null);
      setWindowState((data.windowState as IdentityWindowState) ?? "unset");
      setPeriod(typeof data.period === "string" ? data.period : "");
      setStudent((data.student as StudentPayload["student"]) ?? null);
      const current = (data.record as IdentityTaxInquiryRecord | null) ?? null;
      setRecord(current);
      setSelections(current?.identitySelections ?? []);
      setTaxSubject(current?.taxSubject ?? "both");
      setFather({ idNumber: current?.father.idNumber ?? "" });
      setMother({ idNumber: current?.mother.idNumber ?? "" });
      setSelf({ idNumber: current?.self.idNumber ?? "" });
      setGuardian({ idNumber: current?.guardian.idNumber ?? "" });
      setNote(current?.note ?? "");
    } catch {
      setToast({ kind: "error", text: "讀取資料失敗" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (action: "draft" | "confirm", consentGiven = false) => {
    if (saving) return;
    if (action === "confirm") {
      if (selections.length === 0) {
        setToast({ kind: "error", text: "請至少選擇一個註冊身分別" });
        return;
      }
      for (const parent of [father, mother, self, guardian]) {
        if (parent.idNumber && !isValidIdNumber(parent.idNumber)) {
          setToast({ kind: "error", text: "身分證字號格式不正確（例：A123456789）" });
          return;
        }
      }
      if (settings && needsTaxInquiry(selections, settings)) {
        const complete = (info: { idNumber: string }) => isValidIdNumber(info.idNumber);
        if (taxSubject === "both" && !(complete(father) && complete(mother))) {
          setToast({ kind: "error", text: "請填寫父、母雙方的身分證字號" });
          return;
        }
        if (taxSubject === "one" && !(complete(father) || complete(mother))) {
          setToast({ kind: "error", text: "請填寫具有撫養權一方的身分證字號" });
          return;
        }
        if (taxSubject === "self" && !complete(self)) {
          setToast({ kind: "error", text: "請填寫本人的身分證字號" });
          return;
        }
        if (taxSubject === "guardian" && !complete(guardian)) {
          setToast({ kind: "error", text: "請填寫監護人的身分證字號" });
          return;
        }
      }
      if (!consentGiven) {
        setShowConsent(true);
        return;
      }
    }
    setSaving(action);
    try {
      const response = await fetch("/api/student/identity-tax-inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: action === "confirm" ? "confirm" : "save",
          identitySelections: selections,
          taxSubject,
          father,
          mother,
          self,
          guardian,
          note,
          personalDataConsent: action === "confirm" && consentGiven,
          personalDataConsentVersion: action === "confirm" ? PERSONAL_DATA_CONSENT_VERSION : null,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "儲存失敗" });
        return;
      }
      setRecord((data.record as IdentityTaxInquiryRecord) ?? record);
      setToast({
        kind: "success",
        text: data.message || (action === "confirm" ? "已送出確認" : "已儲存草稿"),
      });
      await load();
    } catch {
      setToast({ kind: "error", text: "儲存失敗" });
    } finally {
      setSaving(null);
    }
  };

  const canEdit = !maintenance && windowState === "open" && Boolean(settings);
  const taxRequired = settings ? needsTaxInquiry(selections, settings) : false;

  /** 勾選／取消身分別（互斥群組自動取消同組其他選項） */
  const toggleIdentity = (def: IdentityOptionDef) => {
    if (!settings || !canEdit) return;
    setSelections((prev) => {
      if (prev.some((selection) => selection.optionId === def.id)) {
        return prev.filter((selection) => selection.optionId !== def.id);
      }
      const kept = def.exclusiveGroup
        ? prev.filter((selection) => {
            const other = settings.identityOptions.find(
              (option) => option.id === selection.optionId
            );
            return (other?.exclusiveGroup ?? "") !== def.exclusiveGroup;
          })
        : prev;
      return [...kept, { optionId: def.id, label: def.label, values: {} }];
    });
  };

  /** 更新身分別的進階選項 */
  const setFieldValues = (optionId: string, fieldId: string, values: string[]) => {
    setSelections((prev) =>
      prev.map((selection) =>
        selection.optionId === optionId
          ? { ...selection, values: { ...selection.values, [fieldId]: values } }
          : selection
      )
    );
  };

  const actionButtons = (
    <>
      <button
        type="button"
        onClick={() => router.push("/student")}
        className="btn-theme rounded-lg px-4 py-2 text-sm"
      >
        返回功能首頁
      </button>
      <button
        type="button"
        onClick={() => {
          void logout();
          router.push("/");
        }}
        className="btn-theme rounded-lg px-4 py-2 text-sm"
      >
        登出
      </button>
    </>
  );

  const renderShell = (inner: ReactNode) => (
    <div className="bg-page flex min-h-screen flex-col items-center px-4 pt-[20px]">
      <Toast message={toast} onClose={() => setToast(null)} />
      <div className="mb-2 text-center">
        <h1 className="mb-2 text-4xl font-bold">
          {systemSettings.systemName || "數位校園工具箱"}
        </h1>
        <p className="text-t2 text-xl">{systemSettings.schoolFullName || "學校名稱"}</p>
        <p className="text-t3 text-lg">
          {systemSettings.academicYear} 學年度 第{systemSettings.semester}學期
        </p>
      </div>
      <div className="content-width mt-4 mb-2 text-center">
        <h2 className="text-t1 text-2xl font-bold">註冊身分與財稅查調</h2>
      </div>
      <div className="content-width mb-4 flex justify-end gap-2">{actionButtons}</div>
      <hr className="content-width border-themed mb-4" />
      <main className="content-width mb-6 space-y-4">{inner}</main>
      <hr className="content-width border-themed mb-4" />
      <div className="content-width mb-4 flex justify-start gap-2">{actionButtons}</div>
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

  if (loading) {
    return renderShell(<p className="text-t2 text-sm">載入中…</p>);
  }

  if (maintenance) {
    return renderShell(
      <div className="border-themed bg-card space-y-2 rounded-lg p-6 text-center">
        <p className="text-t1 text-lg font-medium">{MAINTENANCE_TITLE}</p>
        <p className="text-t2 text-sm">{MAINTENANCE_HINT}</p>
      </div>
    );
  }

  if (!settings) {
    return renderShell(<p className="text-danger text-sm">無法載入設定，請重新整理。</p>);
  }

  return renderShell(
    <>
      <section className="border-themed bg-card rounded-lg p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-t1 font-medium">
              {student?.name || "—"}
              <span className="text-t3 ml-2 text-sm font-normal">{student?.className || ""}</span>
            </p>
            <p className="text-t3 mt-1 text-sm">{period} 學期</p>
          </div>
          <div className="text-right text-sm">
            <span
              className={
                windowState === "open"
                  ? "text-success"
                  : windowState === "upcoming"
                    ? "text-warning"
                    : "text-t2"
              }
            >
              {IDENTITY_WINDOW_LABELS[windowState]}
            </span>
            {record && (
              <span
                className={`mt-1 block text-xs ${
                  record.status === "confirmed" ? "text-success" : "text-t3"
                }`}
              >
                {CONFIRMATION_STATUS_LABELS[record.status]}
                {record.confirmedAt ? `（${formatDateTime(record.confirmedAt)}）` : ""}
              </span>
            )}
          </div>
        </div>
        {stripHtmlToText(settings.instructions).trim() && (
          <div className="border-themed bg-surface mt-3 rounded-md border p-3">
            <p className="text-t1 text-xs font-medium">實施說明</p>
            <RichTextContent html={settings.instructions} className="text-t2 mt-1 text-sm" />
          </div>
        )}
      </section>

      {record?.taxInquiry.required && (
        <section className="border-themed bg-card rounded-lg p-4 text-sm">
          <p className="text-t1 font-medium">財稅查調</p>
          <p className="text-t2 mt-1">
            查調狀態：{TAX_INQUIRY_STATUS_LABELS[record.taxInquiry.status]}
            {record.taxInquiry.updatedAt
              ? `（${formatDateTime(record.taxInquiry.updatedAt)} 由 ${record.taxInquiry.updatedByName || "承辦"} 更新）`
              : ""}
          </p>
          {record.taxInquiry.note && (
            <p className="text-t3 mt-1 whitespace-pre-line text-xs">{record.taxInquiry.note}</p>
          )}
        </section>
      )}

      <section className="border-themed bg-card rounded-lg p-4">
        <h3 className="text-t1 mb-3 font-medium">註冊身分別（可複選）</h3>
        <div className="space-y-2">
          {enabledIdentityOptions(settings).map((option) => {
            const selection = selections.find((item) => item.optionId === option.id);
            const checked = Boolean(selection);
            return (
              <div
                key={option.id}
                className="border-themed flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-3 py-2"
              >
                <label className="text-t1 flex shrink-0 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={checked}
                    onChange={() => toggleIdentity(option)}
                  />
                  <span>{option.label}</span>
                  {option.taxInquiry && (
                    <span className="text-warning text-xs">（需查調財稅資料）</span>
                  )}
                </label>
                {checked &&
                  option.fields.map((field) => {
                    const values = selection?.values[field.id] ?? [];
                    if (field.type === "select") {
                      return (
                        <label key={field.id} className="flex items-center gap-2 text-xs">
                          <span className="text-t3 shrink-0">
                            {field.label}
                            {field.required ? " *" : ""}
                          </span>
                          <select
                            className="input-theme min-w-24 rounded px-2 py-1 text-sm"
                            disabled={!canEdit}
                            value={values[0] ?? ""}
                            onChange={(event) =>
                              setFieldValues(
                                option.id,
                                field.id,
                                event.target.value ? [event.target.value] : []
                              )
                            }
                          >
                            <option value="">請選擇</option>
                            {field.options.map((item) => (
                              <option key={fieldOptionName(item)} value={fieldOptionName(item)}>
                                {fieldOptionName(item)}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    }
                    if (field.type === "checkbox") {
                      return (
                        <div key={field.id} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-t3">
                            {field.label}
                            {field.required ? " *" : ""}
                          </span>
                          {field.options.map((item) => {
                            const label = fieldOptionName(item);
                            const active = values.includes(label);
                            return (
                              <label key={label} className="text-t1 flex items-center gap-1">
                                <input
                                  type="checkbox"
                                  disabled={!canEdit}
                                  checked={active}
                                  onChange={() =>
                                    setFieldValues(
                                      option.id,
                                      field.id,
                                      active
                                        ? values.filter((value) => value !== label)
                                        : [...values, label]
                                    )
                                  }
                                />
                                {label}
                              </label>
                            );
                          })}
                        </div>
                      );
                    }
                    return (
                      <label
                        key={field.id}
                        className="flex w-full flex-wrap items-center gap-2 text-xs sm:w-auto sm:min-w-64"
                      >
                        <span className="text-t3 shrink-0">
                          {field.label}
                          {field.required ? " *" : ""}
                        </span>
                        <input
                          className="input-theme min-w-40 flex-1 rounded px-2 py-1 text-sm"
                          disabled={!canEdit}
                          maxLength={100}
                          value={values[0] ?? ""}
                          placeholder={
                            field.label.includes("身分證") ? "例：A123456789" : undefined
                          }
                          onChange={(event) =>
                            setFieldValues(
                              option.id,
                              field.id,
                              event.target.value ? [event.target.value] : []
                            )
                          }
                        />
                      </label>
                    );
                  })}
              </div>
            );
          })}
        </div>
        <p className="text-t3 mt-2 text-xs">請依實際情形勾選。</p>
      </section>

      {taxRequired && (
        <section className="border-themed bg-card rounded-lg p-4">
          <h3 className="text-t1 mb-1 font-medium">財稅查調資料</h3>
          <p className="text-t3 mb-3 text-xs">
            你勾選的身分別需要財稅查調，請依下方查調對象填寫身分證字號，不需填寫姓名。
          </p>
          {taxRequired && (
          <fieldset className="mb-3">
            <legend className="text-t2 mb-1 text-xs">查調對象</legend>
            <div className="flex flex-wrap gap-3 text-sm">
              {(["both", "one", "self", "guardian"] as const).map((value) => (
                <label key={value} className="text-t1 flex items-center gap-2">
                  <input
                    type="radio"
                    name="tax-subject"
                    disabled={!canEdit}
                    checked={taxSubject === value}
                    onChange={() => setTaxSubject(value)}
                  />
                  {TAX_SUBJECT_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {(taxSubject === "self"
            ? ([["本人", self, setSelf]] as const)
            : taxSubject === "guardian"
              ? ([["監護人", guardian, setGuardian]] as const)
              : ([
                  ["父", father, setFather],
                  ["母", mother, setMother],
                ] as const)
          ).map(([label, value, setter]) => (
            <div key={label} className="space-y-2">
              <p className="text-t2 text-sm font-medium">{label}</p>
              <input
                className="input-theme w-full rounded px-3 py-2 text-sm"
                aria-label={`${label}身分證字號`}
                placeholder={`${label}身分證字號（例：A123456789）`}
                maxLength={10}
                disabled={!canEdit}
                value={value.idNumber}
                onChange={(event) =>
                  setter({ ...value, idNumber: event.target.value.toUpperCase() })
                }
              />
            </div>
          ))}
        </div>
        {taxRequired && taxSubject === "one" && (
          <p className="text-t3 mt-2 text-xs">
            父母離異或一方亡故時，請填寫具有撫養權或存續一方的資料即可。
          </p>
        )}
        <label className="mt-3 block text-sm">
          <span className="text-t2 mb-1 block">備註（選填）</span>
          <textarea
            className="input-theme min-h-24 w-full rounded px-3 py-2"
            maxLength={500}
            disabled={!canEdit}
            value={note}
            placeholder="如有特殊情形，可在此說明"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        </section>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {canEdit ? (
          <>
            <button
              type="button"
              className="btn-theme rounded px-4 py-2 text-sm disabled:opacity-50"
              disabled={saving !== null}
              onClick={() => void submit("draft")}
            >
              {saving === "draft" ? "儲存中…" : "儲存草稿"}
            </button>
            <button
              type="button"
              className="btn-primary rounded px-4 py-2 text-sm disabled:opacity-50"
              disabled={saving !== null}
              onClick={() => void submit("confirm")}
            >
              {saving === "confirm" ? "送出中…" : "送出確認"}
            </button>
          </>
        ) : (
          <p className="text-t3 text-sm">
            {windowState === "upcoming"
              ? "尚未開放，開放後即可填寫。"
              : "確認期間已結束，如需修改請洽教務處。"}
          </p>
        )}
      </div>
      {showConsent && (
        <PersonalDataConsentDialog
          schoolName={systemSettings.schoolFullName}
          onCancel={() => setShowConsent(false)}
          onConfirm={() => {
            setShowConsent(false);
            void submit("confirm", true);
          }}
        />
      )}
    </>
  );
}
