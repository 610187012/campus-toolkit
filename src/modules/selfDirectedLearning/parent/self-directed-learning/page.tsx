"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import AdSense from "@/components/AdSense";
import Copyright from "@/components/Copyright";
import Toast, { type ToastMessage } from "@/components/Toast";
import DisclosureArrow from "@/components/DisclosureArrow";
import { RichTextContent } from "../../components/rich-text-editor";
import { fetchSettings } from "@/lib/settings-client";
import { logout } from "@/lib/session";
import { defaultSettings, type Settings } from "@/types/settings";
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

/** 表格內的時段短標籤（與學生端一致） */
const TIMING_SHORT_LABELS: Record<string, string> = {
  flexible: "彈性學習",
  afterSchool: "課餘",
};

function formatDateTime(epoch: number | null): string {
  if (!epoch) return "—";
  const d = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 學期識別（如 115-1）轉為易讀文字 */
function periodText(period: string): string {
  const [year, semester] = period.split("-");
  if (!year || !semester) return period || "—";
  return `${year} 學年度第 ${semester} 學期`;
}

function statusClass(status: SelfDirectedLearningPlan["status"]): string {
  if (status === "approved") return "text-success";
  if (status === "returned") return "text-danger";
  if (status === "submitted") return "text-warning";
  return "text-t2";
}

export default function ParentSelfDirectedLearningPage() {
  const router = useRouter();
  const [systemSettings, setSystemSettings] = useState<Settings>(defaultSettings);
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

  const actionButtons = (
    <>
      <button
        type="button"
        onClick={() => router.push("/parent")}
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
        <h2 className="text-t1 text-2xl font-bold">自主學習計畫</h2>
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

  // 總開關關閉：只見維護說明（子女資料不呈現）
  if (!loading && maintenance) {
    return renderShell(
      <div className="border-themed bg-card space-y-2 rounded-lg border p-6 text-center">
        <p className="text-t1 text-lg font-medium">{MAINTENANCE_TITLE}</p>
        <p className="text-t2 text-sm">{MAINTENANCE_HINT}</p>
      </div>
    );
  }

  if (loading) {
    return renderShell(
      <div className="border-themed bg-card text-t2 rounded-lg border p-4 text-sm">載入中…</div>
    );
  }

  return renderShell(
    <>
      {stripHtmlToText(instructions).trim() && (
        <section className="border-themed bg-card overflow-hidden rounded-lg border shadow-sm">
          <div className="bg-primary" style={{ height: "0.25rem" }} />
          <details>
            <summary className="border-themed bg-surface flex cursor-pointer items-start justify-between gap-3 border-b px-5 py-4">
              <span className="flex items-start gap-3">
                <span className="text-primary mt-0.5" aria-hidden="true">
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 11v5" />
                    <path d="M12 7.75h.01" />
                  </svg>
                </span>
                <span>
                  <span className="text-t1 block text-base font-semibold">自主學習實施說明</span>
                  <span className="text-t3 mt-0.5 block text-xs">撰寫前請先閱讀（點擊可收合）</span>
                </span>
              </span>
              <DisclosureArrow />
            </summary>
            <div className="px-5 py-4">
              <RichTextContent html={instructions} className="text-t2 text-sm" />
            </div>
          </details>
        </section>
      )}

      <section className="border-themed bg-card overflow-hidden rounded-lg border shadow-sm">
        <div className="bg-primary" style={{ height: "0.25rem" }} />
        <div className="border-themed bg-surface border-b px-5 py-4">
          <h2 className="text-t1 text-lg font-semibold">子女的自主學習計畫</h2>
          <p className="text-t3 mt-0.5 text-xs">
            {child
              ? `檢視對象：${child.name}（${child.grade}${child.className || child.classCode}）`
              : "家長唯讀檢視"}
          </p>
        </div>

        <div className="p-4">
          {!plan ? (
            <div className="border-themed bg-surface rounded-lg border px-4 py-6 text-center">
              <p className="text-t3 text-sm">
                {hiddenByStudent
                  ? "子女目前未將自主學習計畫開放給家長檢視。"
                  : "子女尚未建立自主學習計畫。"}
              </p>
              {hiddenByStudent && (
                <p className="text-t3 mt-1 text-xs">若要查看，請向子女確認。</p>
              )}
            </div>
          ) : (
            <article className="border-themed bg-surface space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-t1 text-base font-semibold break-words">
                      {plan.topic || "（未命名計畫）"}
                    </h3>
                    <span
                      className={`border-themed bg-card rounded-full border px-2 py-0.5 text-xs ${statusClass(
                        plan.status
                      )}`}
                    >
                      {PLAN_STATUS_LABELS[plan.status]}
                    </span>
                    {isFormalPlan(plan) && plan.status !== "approved" && (
                      <span
                        className="border-themed bg-card text-success rounded-full border px-2 py-0.5 text-xs"
                        title="學生自行提升為正式；學校審核仍會保留"
                      >
                        正式（自行提升）
                      </span>
                    )}
                  </div>
                  <p className="text-t3 text-xs">
                    {periodText(plan.period)}・{plan.studyGroup || "未填學群"}・指導老師：
                    {plan.advisor || "未指定"}
                  </p>
                  <p className="text-t3 text-xs">
                    送出：{formatDateTime(plan.submittedAt)}・更新：
                    {formatDateTime(plan.updatedAt)}
                  </p>
                </div>
              </div>

              {latestReview && (
                <div className="border-l-primary border-themed bg-card rounded-md border border-l-4 p-3">
                  <p className="text-t1 text-xs font-medium">學校審查意見回饋</p>
                  <RichTextContent
                    html={latestReview.note}
                    emptyText="（無文字意見）"
                    className="text-t2 mt-1 text-xs"
                  />
                </div>
              )}

              <details className="border-themed border-t pt-2" open>
                <summary className="text-t2 flex cursor-pointer items-center gap-1 text-xs">
                  <DisclosureArrow />
                  查看計畫與撰寫成果（{plan.weeks.length} 週）
                </summary>
                {plan.learningGoals && (
                  <div className="mt-2 space-y-1">
                    <p className="text-t1 text-xs font-medium">學習目標</p>
                    <div className="border-themed bg-card rounded-md border p-3">
                      <RichTextContent html={plan.learningGoals} className="text-t2 text-xs" />
                    </div>
                  </div>
                )}
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        <th
                          scope="col"
                          className="border-themed bg-surface text-t1 border px-2 py-2 text-xs"
                          style={{ width: "14%", textAlign: "center" }}
                        >
                          週次
                        </th>
                        <th
                          scope="col"
                          className="border-themed bg-surface text-t1 border px-2 py-2 text-xs"
                          style={{ textAlign: "center" }}
                        >
                          學習安排
                        </th>
                        <th
                          scope="col"
                          className="border-themed bg-surface text-t1 border px-2 py-2 text-xs"
                          style={{ width: "16%", textAlign: "center" }}
                        >
                          場地
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.weeks.map((week) => {
                        const weekReview = latestReview?.weekNotes?.find(
                          (item) => item.week === week.week
                        );
                        return (
                          <tr key={week.week}>
                            <td className="border-themed border px-2 py-2 align-middle text-xs">
                              <div className="text-t1 font-medium whitespace-nowrap">
                                第 {week.week} 週
                              </div>
                              <div className="text-t3 whitespace-nowrap">
                                {TIMING_SHORT_LABELS[week.timing] ??
                                  PLAN_TIMING_LABELS[week.timing]}
                              </div>
                            </td>
                            <td className="border-themed border px-2 py-2 align-top">
                              <RichTextContent html={week.content} />
                              {weekReview && (
                                <div className="border-l-primary border-themed bg-card mt-2 rounded-md border border-l-4 p-2">
                                  <p className="text-t1 text-xs font-medium">審查意見</p>
                                  <RichTextContent
                                    html={weekReview.note}
                                    className="text-t2 text-xs"
                                  />
                                </div>
                              )}
                            </td>
                            <td className="border-themed text-t2 border px-2 py-2 align-top text-xs">
                              {week.venue || "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            </article>
          )}
        </div>
      </section>
    </>
  );
}
