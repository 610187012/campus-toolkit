"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AdSense from "@/components/AdSense";
import Copyright from "@/components/Copyright";
import DisclosureArrow from "@/components/DisclosureArrow";
import RevealListCard from "@/components/RevealListCard";
import { logout } from "@/lib/session";
import { fetchSettings } from "@/lib/settings-client";
import { defaultSettings, type Settings } from "@/types/settings";
import ExamManagerPanel from "../../components/manager-panel";
import {
  effectiveExamStatus,
  EXAM_EVENT_STATUS_LABELS,
  EXAM_REGISTRATION_MODE_LABELS,
  formatExamDateTime,
  type ExamRegistrationMode,
  type ExamEventType,
} from "../../types/exam-registration";

interface StaffEvent {
  eventId: string;
  title: string;
  status: ExamEventType;
  registrationOpenAt: number;
  deadline: number;
  registrationMode: ExamRegistrationMode;
  students: Array<{
    name: string;
    seatNo: string;
    status: "pending" | "registered" | "opt_out";
    subjects: string[];
  }>;
}

interface StaffResponse {
  success?: boolean;
  message?: string;
  classCode?: string;
  events?: StaffEvent[];
  counts?: Record<string, StaffEventCounts>;
}

interface StaffEventCounts {
  listCount: number;
  registeredCount: number;
}

function formatDateTime(value: number): string {
  return formatExamDateTime(value);
}

function StaffExamEventCard({
  event,
  saverEnabled,
  studentsLoaded,
  studentsLoading,
  counts,
  onReveal,
  error,
}: {
  event: StaffEvent;
  saverEnabled: boolean;
  studentsLoaded: boolean;
  studentsLoading: boolean;
  counts?: StaffEventCounts;
  onReveal: () => void;
  error: string;
}) {
  const registrationStart = event.registrationOpenAt
    ? formatDateTime(event.registrationOpenAt)
    : "場次開放後";
  const effectiveStatus = effectiveExamStatus(event);
  const statusLabel = effectiveStatus === "upcoming" ? "尚未開放" : EXAM_EVENT_STATUS_LABELS[effectiveStatus];
  const registeredCount = counts?.registeredCount ?? event.students.filter((student) => student.status === "registered").length;
  const listCount = counts?.listCount ?? event.students.length;

  return (
    <details className="border border-themed rounded-lg bg-card">
      <summary className="list-none cursor-pointer rounded-lg p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-t3 shrink-0" aria-hidden="true">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75V3.75m7.5 3V3.75M3.75 9h16.5M5.25 5.25h13.5A1.5 1.5 0 0120.25 6.75v12A1.5 1.5 0 0118.75 20.25H5.25a1.5 1.5 0 01-1.5-1.5v-12a1.5 1.5 0 011.5-1.5z" />
              </svg>
            </span>
            <h3 className="text-lg font-bold text-t1 truncate">{event.title}</h3>
          </div>
          <DisclosureArrow />
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <p><span className="text-t3">場次狀態：</span><span className="text-t1">{statusLabel}</span></p>
          <p><span className="text-t3">報名方式：</span><span className="text-t1">{EXAM_REGISTRATION_MODE_LABELS[event.registrationMode]}</span></p>
          <p><span className="text-t3">報名期間：</span><span className="text-t1">{registrationStart} ～ {formatDateTime(event.deadline)}</span></p>
          <p><span className="text-t3">目前報名人數：</span><span className="text-t1">{registeredCount} 人</span></p>
        </div>
      </summary>

      <div className="border-t border-themed p-5 space-y-5">
        {saverEnabled && !studentsLoaded ? (
          error ? (
            <div className="border border-themed rounded-lg bg-surface p-4 text-center">
              <p className="text-danger mb-3">{error}</p>
              <button type="button" onClick={onReveal} className="btn-theme rounded-lg px-4 py-2 text-sm">
                重試載入本場名單
              </button>
            </div>
          ) : studentsLoading ? (
            <p className="p-6 text-center text-t3">報名名單載入中...</p>
          ) : (
            <div className="border border-themed rounded-lg bg-card overflow-hidden">
              <RevealListCard
                label="本場報名"
                summary={
                  event.registrationMode === "required"
                    ? `全班名單共 ${listCount} 人`
                    : `已報名名單共 ${listCount} 人`
                }
                onReveal={onReveal}
              />
            </div>
          )
        ) : studentsLoaded ? (
          event.students.length > 0 ? (
            <>
              <div className="text-sm text-t2">
                {event.registrationMode === "required" ? "全班應報名人數" : "已報名人數"}：{event.students.length} 人
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-themed text-t2">
                      <th className="px-3 py-2">座號</th>
                      <th className="px-3 py-2">姓名</th>
                      <th className="px-3 py-2">登錄狀態</th>
                      <th className="px-3 py-2">選考科目</th>
                    </tr>
                  </thead>
                  <tbody>
                    {event.students.map((student, index) => (
                      <tr key={`${student.name}-${student.seatNo}-${index}`} className="border-b border-themed last:border-0">
                        <td className="px-3 py-2">{student.seatNo || "—"}</td>
                        <td className="px-3 py-2">{student.name || "—"}</td>
                        <td className="px-3 py-2">
                          {student.status === "pending"
                            ? "未完成"
                            : student.status === "opt_out"
                              ? "不報名"
                              : event.registrationMode === "required"
                                ? "已完成"
                                : "已報名"}
                        </td>
                        <td className="px-3 py-2">{student.subjects.length ? student.subjects.join("、") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="rounded-lg border border-themed bg-surface p-4 text-center text-sm text-t3">
              目前尚無學生完成報名。
            </p>
          )
        ) : null}
      </div>
    </details>
  );
}

export default function StaffExamRegistrationPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [classCode, setClassCode] = useState("");
  const [events, setEvents] = useState<StaffEvent[]>([]);
  /** 非兼導師（無班級代碼）：本區不適用——直接不顯示，也不另給「無法載入」提醒 */
  const [notApplicable, setNotApplicable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saverEnabled, setSaverEnabled] = useState(false);
  const [counts, setCounts] = useState<Record<string, StaffEventCounts>>({});
  const [loadedEventIds, setLoadedEventIds] = useState<Set<string>>(new Set());
  const [loadingEventIds, setLoadingEventIds] = useState<Set<string>>(new Set());
  const [eventErrors, setEventErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settingsData = await fetchSettings().catch(() => null);
        if (!cancelled && settingsData?.success && settingsData.settings) {
          setSettings({ ...defaultSettings, ...settingsData.settings });
        }
        const useSaver = settingsData?.settings?.dataSaverEnabled === true;
        if (!cancelled) setSaverEnabled(useSaver);

        const [eventsResponse, countResponse] = await Promise.all([
          fetch(`/api/staff/exam-registration${useSaver ? "" : "?includeStudents=1"}`, {
            cache: "no-store",
          }),
          useSaver
            ? fetch("/api/staff/exam-registration?summary=counts", { cache: "no-store" })
            : Promise.resolve(null),
        ]);
        const data: StaffResponse | null = await eventsResponse.json().catch(() => null);
        if (cancelled) return;
        if (!eventsResponse.ok || !data?.success) {
          if (eventsResponse.status === 403) {
            setNotApplicable(true);
            return;
          }
          // 後端暫時取不到資料：一律以「沒有適用的考試場次」呈現，不另給洽辦提醒
          if (typeof data?.classCode === "string") setClassCode(data.classCode);
          setEvents([]);
          setLoadedEventIds(new Set());
          return;
        }
        setClassCode(data.classCode ?? "");
        if (!useSaver) {
          const loadedEvents = data.events ?? [];
          setEvents(loadedEvents);
          setLoadedEventIds(new Set(loadedEvents.map((event) => event.eventId)));
          return;
        }

        const countData = countResponse
          ? ((await countResponse.json().catch(() => null)) as StaffResponse | null)
          : null;
        if (!countResponse?.ok || !countData?.success || !countData.counts) {
          setEvents([]);
          setLoadedEventIds(new Set());
          return;
        }
        setCounts(countData.counts);
        setEvents(data.events ?? []);
      } catch {
        if (!cancelled) {
          setEvents([]);
          setLoadedEventIds(new Set());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadRoster(eventId: string) {
    if (loadingEventIds.has(eventId) || loadedEventIds.has(eventId)) return;
    setLoadingEventIds((previous) => new Set(previous).add(eventId));
    setEventErrors((previous) => {
      const next = { ...previous };
      delete next[eventId];
      return next;
    });
    try {
      const params = new URLSearchParams({ includeStudents: "1", eventId });
      const response = await fetch(`/api/staff/exam-registration?${params.toString()}`, { cache: "no-store" });
      const data: StaffResponse | null = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        setEventErrors((previous) => ({ ...previous, [eventId]: data?.message || "載入本場名單失敗。" }));
        return;
      }
      const loadedEvent = data.events?.find((event) => event.eventId === eventId);
      if (!loadedEvent) {
        setEvents((previous) => previous.filter((event) => event.eventId !== eventId));
        setCounts((previous) => ({ ...previous, [eventId]: { listCount: 0, registeredCount: 0 } }));
      } else {
        setEvents((previous) => previous.map((event) => (event.eventId === eventId ? loadedEvent : event)));
      }
      setLoadedEventIds((previous) => new Set(previous).add(eventId));
    } catch {
      setEventErrors((previous) => ({ ...previous, [eventId]: "載入本場名單失敗，請稍後再試。" }));
    } finally {
      setLoadingEventIds((previous) => {
        const next = new Set(previous);
        next.delete(eventId);
        return next;
      });
    }
  }

  function handleBack() {
    router.push("/staff");
  }

  function handleLogout() {
    void logout();
    router.push("/");
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-t3">載入中...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center bg-page px-4 pt-[20px]">
      <div className="text-center mb-2">
        <h1 className="text-4xl font-bold mb-2">{settings.systemName || "數位校園工具箱"}</h1>
        <p className="text-xl text-t2">{settings.schoolFullName || "學校名稱"}</p>
        <p className="text-lg text-t3">
          {settings.academicYear} 學年度 第{settings.semester}學期
        </p>
      </div>

      <div className="content-width mt-4 mb-6 text-center">
        <h2 className="text-2xl font-bold text-t1">升學考試與模擬考校內報名</h2>
        {classCode && <p className="text-sm text-t2 mt-2">兼導師班級：{classCode}</p>}
      </div>

      <div className="content-width flex justify-end gap-3 mb-4">
        <button onClick={handleBack} className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer">
          返回功能首頁
        </button>
        <button onClick={handleLogout} className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer">
          登出
        </button>
      </div>

      <hr className="content-width border-themed mb-4" />

      {/* 被指派管理者：同一頁內提供被授權的管理功能（未被指派者不顯示）；此身分的基本功能置於其下方 */}
      <ExamManagerPanel pageHref="/staff/exam-registration" />

      {notApplicable ? null : events.length === 0 ? (
        <div className="content-width border border-themed rounded-lg p-8 bg-card text-center mb-8">
          <p className="text-lg font-bold text-t1">目前沒有適用的考試場次</p>
          <p className="text-sm text-t2 mt-2">本班目前沒有開放中且適用的考試場次。</p>
        </div>
      ) : (
        <div className="content-width space-y-4 mb-8">
          {events.map((event) => {
            const eventStudentsLoaded = loadedEventIds.has(event.eventId);
            return (
              <StaffExamEventCard
                key={event.eventId}
                event={event}
                saverEnabled={saverEnabled}
                studentsLoaded={eventStudentsLoaded}
                studentsLoading={loadingEventIds.has(event.eventId)}
                counts={counts[event.eventId]}
                error={eventErrors[event.eventId] ?? ""}
                onReveal={() => void loadRoster(event.eventId)}
              />
            );
          })}
        </div>
      )}

      <hr className="content-width border-themed mb-4" />

      <div className="content-width flex justify-start gap-3 mb-8">
        <button onClick={handleBack} className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer">
          返回功能首頁
        </button>
        <button onClick={handleLogout} className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer">
          登出
        </button>
      </div>

      {settings.sponsorAdEnabled && (
        <div className="content-width">
          <AdSense />
        </div>
      )}

      <div className="content-width mt-auto">
        <Copyright mode={settings.copyrightNotice ? "啟用" : "關閉"} />
      </div>
    </div>
  );
}
