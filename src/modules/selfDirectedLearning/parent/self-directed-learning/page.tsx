"use client";

import { useCallback, useEffect, useState } from "react";
import Toast, { type ToastMessage } from "@/components/Toast";
import DisclosureArrow from "@/components/DisclosureArrow";
import { RichTextContent } from "../../components/rich-text-editor";
import {
  MAINTENANCE_HINT,
  MAINTENANCE_TITLE,
  PLAN_STATUS_LABELS,
  PLAN_TIMING_LABELS,
  isFormalPlan,
  stripHtmlToText,
  type PlanReview,
  type SelfDirectedLearningPlan,
} from "../../types/self-directed-learning";

interface LinkedChild {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  className: string;
}

function formatDateTime(epoch: number | null): string {
  if (!epoch) return "—";
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ParentSelfDirectedLearningPage() {
  const [child, setChild] = useState<LinkedChild | null>(null);
  const [plan, setPlan] = useState<SelfDirectedLearningPlan | null>(null);
  const [latestReview, setLatestReview] = useState<PlanReview | null>(null);
  const [instructions, setInstructions] = useState("");
  /** 子女尚未將任何計畫開放給家長檢視 */
  const [hiddenByStudent, setHiddenByStudent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  /** 總開關關閉：只顯示維護說明 */
  const [maintenance, setMaintenance] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/parent/self-directed-learning", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setToast({ kind: "error", text: data.message || "讀取資料失敗" });
        return;
      }
      setMaintenance(Boolean(data.maintenance));
      setChild((data.child as LinkedChild | null) ?? null);
      setPlan((data.plan as SelfDirectedLearningPlan | null) ?? null);
      setLatestReview((data.latestReview as PlanReview | null) ?? null);
      setInstructions(typeof data.instructions === "string" ? data.instructions : "");
      setHiddenByStudent(Boolean(data.hiddenByStudent));
    } catch {
      setToast({ kind: "error", text: "讀取資料失敗" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 總開關關閉：只見維護說明（子女資料不呈現）
  if (!loading && maintenance) {
    return (
      <section className="mx-auto content-width space-y-4 p-4 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-xl text-t1">自主學習計畫</h1>
        </header>
        <div className="border border-themed bg-card space-y-2 rounded-lg p-6 text-center">
          <p className="text-t1 text-lg font-medium">{MAINTENANCE_TITLE}</p>
          <p className="text-t2 text-sm">{MAINTENANCE_HINT}</p>
        </div>
        <Toast message={toast} onClose={() => setToast(null)} />
      </section>
    );
  }

  return (
    <section className="mx-auto content-width space-y-4 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-xl text-t1">自主學習計畫</h1>
        {child && (
          <p className="text-t2 text-sm">
            檢視對象：{child.name}（{child.grade}
            {child.className || child.classCode}）
          </p>
        )}
      </header>

      {stripHtmlToText(instructions).trim() && (
        <details className="border border-themed bg-card rounded-lg">
          <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
            <DisclosureArrow />
            自主學習實施說明
          </summary>
          <RichTextContent
            html={instructions}
            className="text-t2 px-4 pb-4 text-sm"
          />
        </details>
      )}

      {loading ? (
        <div className="border-themed bg-card text-t2 rounded-lg p-4 text-sm">載入中…</div>
      ) : !plan ? (
        <div className="border border-themed bg-card text-t2 rounded-lg p-4 text-sm">
          {hiddenByStudent
            ? "子女目前未將自主學習計畫開放給家長檢視；若要查看，請向子女確認。"
            : "子女尚未建立自主學習計畫。"}
        </div>
      ) : (
        <>
          <section className="border border-themed bg-card rounded-lg p-4">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-t1 font-medium">
                  {plan.topic}
                  <span className="text-t3 ml-2 text-sm font-normal">{plan.studyGroup}</span>
                </h2>
                <p className="text-t2 mt-1 text-sm">
                  {plan.advisor ? `指導老師：${plan.advisor}` : "未指定指導老師"}
                </p>
              </div>
              <div className="text-right text-xs">
                <span
                  className={
                    plan.status === "approved"
                      ? "text-success"
                      : plan.status === "returned"
                        ? "text-danger"
                        : "text-t2"
                  }
                >
                  {PLAN_STATUS_LABELS[plan.status]}
                </span>
                {isFormalPlan(plan) && plan.status !== "approved" && (
                  <span className="text-success mt-0.5 block text-xs">正式（自行提升）</span>
                )}
                <div className="text-t3">送出：{formatDateTime(plan.submittedAt)}</div>
              </div>
            </div>
          </section>

          <section className="border border-themed bg-card rounded-lg p-4" aria-label="學習目標">
            <h2 className="text-t1 mb-1 text-sm font-medium">學習目標</h2>
            <RichTextContent
              html={plan.learningGoals}
              emptyText="（未填寫）"
              className="text-t2 text-sm"
            />
          </section>

          {latestReview && (
            <section className="border border-themed bg-card rounded-lg p-4" aria-label="審查意見">
              <h2 className="text-t1 mb-1 text-sm font-medium">學校審查意見回饋</h2>
              <RichTextContent
                html={latestReview.note}
                emptyText="（無文字意見）"
                className="text-t2 text-sm"
              />
            </section>
          )}

          <details className="border border-themed bg-card rounded-lg" open>
            <summary className="text-t1 flex cursor-pointer items-center gap-2 p-4 font-medium">
              <DisclosureArrow />
              逐週課程安排（{plan.weeks.length} 週）
            </summary>
            <ul className="space-y-2 px-4 pb-4">
              {plan.weeks.map((week) => {
                const weekReview = latestReview?.weekNotes?.find(
                  (item) => item.week === week.week
                );
                return (
                  <li key={week.week} className="border border-themed bg-surface rounded-md p-3">
                    <div className="text-t1 mb-1 flex flex-wrap gap-3 text-xs font-medium">
                      <span>第 {week.week} 週</span>
                      <span>{PLAN_TIMING_LABELS[week.timing]}</span>
                      <span className="text-t3">{week.venue}</span>
                    </div>
                    <RichTextContent html={week.content} />
                    {weekReview && (
                      <div className="border-l-primary border-themed bg-card mt-2 rounded-md border border-l-4 p-2">
                        <p className="text-t1 text-xs font-medium">審查意見</p>
                        <RichTextContent html={weekReview.note} className="text-t2 text-xs" />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        </>
      )}

      <Toast message={toast} onClose={() => setToast(null)} />
    </section>
  );
}
