"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AdSense from "@/components/AdSense";
import Copyright from "@/components/Copyright";
import { fetchSettings } from "@/lib/settings-client";
import { logout } from "@/lib/session";
import { defaultSettings } from "@/types/settings";
import OfficialExamLabel from "../../components/official-exam-label";
import ExamManagerPanel from "../../components/manager-panel";
import {
  EXAM_FEE_CODE_LABELS,
  EXAM_REGISTRATION_MODE_LABELS,
  formatExamDateRange,
  formatExamDateTime,
  resolveLocationLabel,
} from "../../types/exam-registration";
import type { Settings } from "@/types/settings";
import type { StudentExamEvent } from "../../types/exam-registration";

interface ParentExamRegistrationResponse {
  success?: boolean;
  message?: string;
  child?: {
    name: string;
    studentId: string;
    grade: string;
    classCode: string;
    className: string;
    seatNo: string;
  };
  events?: StudentExamEvent[];
}

function subjectsOf(item: StudentExamEvent): string[] {
  return item.mySubjectKeys.flatMap((key) => {
    const subject = item.subjects.find((candidate) => candidate.key === key);
    if (!subject) return [];
    const code = item.mySubjectAdvancedOptionCodes[key] ?? "";
    const option = subject.advancedOptions?.find((candidate) => candidate.code === code);
    return [option ? `${subject.label}（${option.label}）` : subject.label];
  });
}

export default function ParentExamRegistrationPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [child, setChild] = useState<ParentExamRegistrationResponse["child"]>();
  const [events, setEvents] = useState<StudentExamEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchSettings();
        if (!cancelled && data?.success && data.settings) {
          setSettings({ ...defaultSettings, ...data.settings });
        }
      } catch {
        // 頁面資料仍可在設定讀取失敗時顯示。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/parent/exam-registration", { cache: "no-store" });
        const data: ParentExamRegistrationResponse | null = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
          throw new Error(data?.message || "載入子女報名資料失敗");
        }
        if (!cancelled) {
          setChild(data.child);
          setEvents(data.events ?? []);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "載入子女報名資料失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const actionButtons = (
    <>
      <button
        type="button"
        onClick={() => router.push("/parent")}
        className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer"
      >
        返回功能首頁
      </button>
      <button
        type="button"
        onClick={() => {
          void logout();
          router.push("/");
        }}
        className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer"
      >
        登出
      </button>
    </>
  );

  return (
    <div className="min-h-screen flex flex-col items-center bg-page px-4 pt-[20px]">
      <div className="text-center mb-2">
        <h1 className="text-4xl font-bold mb-2">{settings.systemName || "數位校園工具箱"}</h1>
        <p className="text-xl text-t2">{settings.schoolFullName || "學校名稱"}</p>
        <p className="text-lg text-t3">
          {settings.academicYear} 學年度 第{settings.semester}學期
        </p>
      </div>

      <div className="content-width mt-4 mb-2 text-center">
        <h2 className="text-2xl font-bold text-t1">升學考試與模擬考校內報名</h2>
        <p className="mt-1 text-sm text-t3">家長可查看家長名冊綁定子女的場次與報名資料。</p>
      </div>

      <div className="content-width flex justify-end gap-2 mb-4">{actionButtons}</div>
      <hr className="content-width border-themed mb-4" />

      {/* 被指派管理者：同一頁內提供被授權的管理功能（未被指派者不顯示）；此身分的基本功能置於其下方 */}
      <ExamManagerPanel pageHref="/parent/exam-registration" />

      <main className="content-width mb-6 space-y-4">
        {child && (
          <section className="border border-themed rounded-lg bg-card p-4">
            <h3 className="font-bold text-t1">子女資料</h3>
            <p className="mt-1 text-sm text-t2">
              {child.name}｜{child.className || child.classCode} 班｜座號 {child.seatNo || "—"}｜學號 {child.studentId}
            </p>
          </section>
        )}

        {loading ? (
          <p className="p-6 text-center text-t3">報名資料載入中…</p>
        ) : error ? (
          <div role="alert" className="border border-danger rounded-lg bg-card p-4 text-sm text-danger">
            {error}
          </div>
        ) : events.length === 0 ? (
          <div className="border border-themed rounded-lg bg-card p-6 text-center text-sm text-t3">
            目前沒有符合子女年級與班級的報名場次
          </div>
        ) : (
          <div className="space-y-4">
            {events.map((item) => {
              const subjectLabels = subjectsOf(item);
              const registrationState = item.myOptOut
                ? "不報名"
                : item.mySubjectKeys.length > 0
                  ? "已完成報名"
                  : "尚未報名";
              const statusLabel =
                item.status === "upcoming" ? "尚未開放" : item.status === "open" ? "報名中" : "已截止";
              return (
                <article key={item.id} className="border border-themed rounded-lg bg-card p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-t1">
                        {item.title}
                        <OfficialExamLabel title={item.title} />
                      </h3>
                      <p className="text-xs text-t3">
                        {formatExamDateRange(item)} ・{EXAM_REGISTRATION_MODE_LABELS[item.registrationMode]} ・{statusLabel}
                      </p>
                    </div>
                    <span className="rounded border border-themed px-2 py-1 text-xs text-t2">{registrationState}</span>
                  </div>

                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-t3">報名期間</dt>
                      <dd className="text-t2">
                        {item.registrationOpenAt > 0 ? formatExamDateTime(item.registrationOpenAt) : "開放後即可報名"}
                        {" ～ "}
                        {formatExamDateTime(item.deadline)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-t3">考試地點</dt>
                      <dd className="text-t2">
                        {item.myLocationCode
                          ? resolveLocationLabel(item.locationOptions, item.myLocationCode)
                          : item.location || "依主辦單位安排"}
                      </dd>
                    </div>
                    {item.myOptOut ? (
                      <div className="sm:col-span-2">
                        <dt className="text-xs text-t3">不報名原因</dt>
                        <dd className="text-t2">{item.myOptOutReason || "—"}</dd>
                      </div>
                    ) : subjectLabels.length > 0 ? (
                      <div className="sm:col-span-2">
                        <dt className="text-xs text-t3">已選科目</dt>
                        <dd className="text-t2">{subjectLabels.join("、")}</dd>
                      </div>
                    ) : null}
                    {item.myFeeAmount !== null && !item.myOptOut && (
                      <div>
                        <dt className="text-xs text-t3">繳費身分與費用</dt>
                        <dd className="text-t2">
                          {item.myFeeCode ? EXAM_FEE_CODE_LABELS[item.myFeeCode] : "—"} {item.myFeeAmount} 元
                        </dd>
                      </div>
                    )}
                    {(item.myNonAirConditionedRoom || item.myExamServiceNote) && (
                      <div className="sm:col-span-2">
                        <dt className="text-xs text-t3">特殊應考服務</dt>
                        <dd className="text-t2">
                          {[
                            item.myNonAirConditionedRoom ? "非冷氣試場" : "",
                            item.myExamServiceNote.trim(),
                          ].filter(Boolean).join("；")}
                        </dd>
                      </div>
                    )}
                    {item.myArchived && (
                      <div className="sm:col-span-2 text-xs text-t3">學生已封存此筆報名資料</div>
                    )}
                  </dl>
                  {item.note && <p className="whitespace-pre-wrap border-t border-themed pt-2 text-sm text-t2">{item.note}</p>}
                </article>
              );
            })}
          </div>
        )}
      </main>

      <hr className="content-width border-themed mb-4" />
      <div className="content-width flex justify-start gap-2 mb-4">{actionButtons}</div>

      {settings.sponsorAdEnabled && (
        <div className="content-width mt-8">
          <AdSense />
        </div>
      )}
      <div className="content-width mt-auto">
        <Copyright mode={settings.copyrightNotice ? "啟用" : "關閉"} />
      </div>
    </div>
  );
}
