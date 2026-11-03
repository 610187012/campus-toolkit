"use client";

import { useCallback, useEffect, useState } from "react";
import Toast, { type ToastMessage } from "@/components/Toast";
import { RichTextContent } from "../../components/rich-text-editor";
import { stripHtmlToText } from "../../lib/rich-text";
import DisclosureArrow from "@/components/DisclosureArrow";
import {
  CONFIRMATION_STATUS_LABELS,
  IDENTITY_WINDOW_LABELS,
  MAINTENANCE_HINT,
  MAINTENANCE_TITLE,
  TAX_INQUIRY_STATUS_LABELS,
  formatDateTime,
  summarizeSelections,
  type IdentityTaxInquiryRecord,
  type IdentityTaxInquirySettings,
  type IdentityWindowState,
} from "../../types/identity-tax-inquiry";

interface LinkedChild {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  className: string;
}

export default function IdentityTaxInquiryParentPage() {
  const [child, setChild] = useState<LinkedChild | null>(null);
  const [record, setRecord] = useState<IdentityTaxInquiryRecord | null>(null);
  const [settings, setSettings] = useState<IdentityTaxInquirySettings | null>(null);
  const [windowState, setWindowState] = useState<IdentityWindowState>("unset");
  const [period, setPeriod] = useState("");
  const [maintenance, setMaintenance] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/parent/identity-tax-inquiry", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "讀取資料失敗" });
        return;
      }
      setMaintenance(Boolean(data.maintenance));
      setChild((data.child as LinkedChild | null) ?? null);
      setRecord((data.record as IdentityTaxInquiryRecord | null) ?? null);
      setSettings((data.settings as IdentityTaxInquirySettings) ?? null);
      setWindowState((data.windowState as IdentityWindowState) ?? "unset");
      setPeriod(typeof data.period === "string" ? data.period : "");
    } catch {
      setToast({ kind: "error", text: "讀取資料失敗" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-t2 p-4 text-sm">載入中…</p>;
  }

  if (maintenance) {
    return (
      <section className="content-width mx-auto space-y-4 p-4 sm:p-6">
        <h1 className="text-t1 text-xl">註冊身分與財稅查調</h1>
        <div className="border-themed bg-card space-y-2 rounded-lg border p-6 text-center">
          <p className="text-t1 text-lg font-medium">{MAINTENANCE_TITLE}</p>
          <p className="text-t2 text-sm">{MAINTENANCE_HINT}</p>
        </div>
        <Toast message={toast} onClose={() => setToast(null)} />
      </section>
    );
  }

  return (
    <section className="content-width mx-auto space-y-4 p-4 sm:p-6">
      <Toast message={toast} onClose={() => setToast(null)} />
      <header>
        <h1 className="text-t1 text-xl">註冊身分與財稅查調</h1>
        {child && (
          <p className="text-t2 mt-1 text-sm">
            檢視對象：{child.name}（{child.grade}
            {child.className || child.classCode}）
          </p>
        )}
        <p className="text-t3 mt-1 text-xs">
          {period} 學期・{IDENTITY_WINDOW_LABELS[windowState]}
        </p>
      </header>

      {settings?.instructions && stripHtmlToText(settings.instructions).trim() && (
        <details className="border-themed bg-card rounded-lg border">
          <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
            <DisclosureArrow />
            實施說明
          </summary>
          <div className="px-4 pb-4">
            <RichTextContent html={settings.instructions} className="text-t2 text-sm" />
          </div>
        </details>
      )}

      {!record ? (
        <div className="border-themed bg-card text-t2 rounded-lg border p-4 text-sm">
          子女本學期尚未填寫註冊身分確認。
        </div>
      ) : (
        <>
          <section className="border-themed bg-card rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-t1 font-medium">註冊身分</h2>
                <p className="text-t2 mt-1 text-sm">
                  {summarizeSelections(record.identitySelections) ||
                    record.identities.join("、") ||
                    "（未選擇）"}
                </p>
              </div>
              <div className="text-right text-xs">
                <span className={record.status === "confirmed" ? "text-success" : "text-t3"}>
                  {CONFIRMATION_STATUS_LABELS[record.status]}
                </span>
                {record.confirmedAt && (
                  <span className="text-t3 block">確認：{formatDateTime(record.confirmedAt)}</span>
                )}
              </div>
            </div>
            {record.note && (
              <p className="text-t3 mt-3 whitespace-pre-line text-xs">備註：{record.note}</p>
            )}
          </section>

          {record.taxInquiry.required && (
            <section className="border-themed bg-card rounded-lg border p-4">
              <h2 className="text-t1 text-sm font-medium">財稅查調</h2>
              <p className="text-t2 mt-1 text-sm">
                狀態：{TAX_INQUIRY_STATUS_LABELS[record.taxInquiry.status]}
              </p>
              {record.taxInquiry.note && (
                <p className="text-t3 mt-1 whitespace-pre-line text-xs">{record.taxInquiry.note}</p>
              )}
              <p className="text-t3 mt-2 text-xs">
                家長檢視時，父母身分證字號一律遮蔽。
              </p>
            </section>
          )}

          <section className="border-themed bg-card rounded-lg border p-4">
            <h2 className="text-t1 mb-2 text-sm font-medium">
              {record.taxSubject === "self"
                ? "本人資料（遮蔽顯示）"
                : record.taxSubject === "guardian"
                  ? "監護人資料（遮蔽顯示）"
                  : "父母資料（遮蔽顯示）"}
            </h2>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {record.taxSubject === "self" ? (
                <div>
                  <dt className="text-t3 text-xs">本人</dt>
                  <dd className="text-t1">
                    {record.self.idNumber || "—"}
                  </dd>
                </div>
              ) : record.taxSubject === "guardian" ? (
                <div>
                  <dt className="text-t3 text-xs">監護人</dt>
                  <dd className="text-t1">
                    {record.guardian.idNumber || "—"}
                  </dd>
                </div>
              ) : (
                <>
                  <div>
                    <dt className="text-t3 text-xs">父</dt>
                    <dd className="text-t1">
                      {record.father.idNumber || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-t3 text-xs">母</dt>
                    <dd className="text-t1">
                      {record.mother.idNumber || "—"}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </section>
        </>
      )}
    </section>
  );
}
