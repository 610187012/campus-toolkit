"use client";

import { Suspense, useEffect, useState } from "react";
import DisclosureArrow from "@/components/DisclosureArrow";
import { fetchSession } from "@/lib/session";
import { FEATURE_MODULES } from "@/types/feature-modules";
import AdminExamRegistrationPage from "../admin/exam-registration/page";
import ExamRegistrationRosterPage from "../admin/exam-registration/roster/page";

const MODULE_VALUE = "examRegistration";

/** 子權限中文標題：與「功能模組管理」頁同源（manifest 宣告，主程式註冊表提供） */
const PERMISSION_LABELS = (
  FEATURE_MODULES.find((item) => item.value === MODULE_VALUE)?.managerPermissions ?? []
).reduce<Record<string, string>>((map, item) => {
  map[item.value] = item.label;
  return map;
}, {});

/**
 * 身分功能頁的管理面板（不同身分管理政策 §6／§8.4）：
 * 非管理員被指派本模組的管理子權限（session.delegatedModules）後，
 * 在**自己的功能頁**內直接使用被授權的功能，不必前往 /admin：
 * - 帶 `?eventId=`＝名單／審核／匯出（viewRoster／approve／export）；
 * - 否則＝場次列表與建立／編輯／刪除（configure）。
 * 以「管理功能」收合區呈現（預設收合；帶 eventId 時自動展開），
 * 未被指派者不渲染（該身分的基本功能不受影響）。
 */
export default function ExamManagerPanel({ pageHref }: { pageHref: string }) {
  // null＝尚未確認是否被指派；[]＝未被指派（不渲染）
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [eventId, setEventId] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await fetchSession(true).catch(() => null);
      if (cancelled) return;
      if (!session) {
        setPermissions([]);
        return;
      }
      if (session.role === "admin") {
        setPermissions(Object.keys(PERMISSION_LABELS));
      } else {
        const grant = (session.delegatedModules ?? []).find(
          (item) => item.module === MODULE_VALUE
        );
        setPermissions(grant?.permissions ?? []);
      }
      setEventId(new URLSearchParams(window.location.search).get("eventId") ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (permissions === null || permissions.length === 0) return null;

  const viewingRoster = eventId !== "";

  return (
    <section className="content-width mb-8 print:hidden">
      <details
        open={viewingRoster}
        className="group border border-themed rounded-lg bg-card"
      >
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 list-none group-open:border-b group-open:border-themed hover:bg-surface rounded-lg">
          <DisclosureArrow />
          <h3 className="text-lg font-bold text-t1">管理功能</h3>
          <span className="text-xs text-t3">依管理人員指派的子權限顯示可執行的操作</span>
        </summary>
        <div className="p-4 space-y-3">
          <p className="text-xs text-t3 max-w-2xl">
            你被管理員指派管理「升學考試與模擬考校內報名」，此處依你持有的子權限顯示可執行的操作：
            {permissions.map((code) => PERMISSION_LABELS[code] ?? code).join("、")}
            。下方為此身分的基本功能。
          </p>
          {viewingRoster ? (
            <div className="flex justify-end">
              <a href={pageHref} className="btn-soft rounded px-3 py-1 text-xs cursor-pointer">
                返回場次管理
              </a>
            </div>
          ) : null}
          <Suspense fallback={<p className="text-sm text-t3">管理功能載入中...</p>}>
            {viewingRoster ? (
              <ExamRegistrationRosterPage listHref={pageHref} fill />
            ) : (
              <AdminExamRegistrationPage rosterHrefBase={pageHref} fill />
            )}
          </Suspense>
        </div>
      </details>
    </section>
  );
}
