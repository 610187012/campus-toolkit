"use client";

import { Suspense, useEffect, useState } from "react";
import DisclosureArrow from "@/components/DisclosureArrow";
import { fetchSession } from "@/lib/session";
import { FEATURE_MODULES } from "@/types/feature-modules";
import AdminSelfDirectedLearningPage from "../admin/self-directed-learning/page";

const MODULE_VALUE = "selfDirectedLearning";

const PERMISSION_LABELS = (
  FEATURE_MODULES.find((item) => item.value === MODULE_VALUE)?.managerPermissions ?? []
).reduce<Record<string, string>>((map, item) => {
  map[item.value] = item.label;
  return map;
}, {});

/**
 * 教職員頁的管理面板（不同身分管理政策 §6）：
 * 非管理員被指派本模組子權限後，在自己的功能頁直接使用，不必前往 /admin。
 * 未被指派者不渲染。
 */
export default function SelfDirectedLearningManagerPanel() {
  const [permissions, setPermissions] = useState<string[] | null>(null);

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
        setPermissions([]);
        return;
      }
      const grant = (session.delegatedModules ?? []).find(
        (item) => item.module === MODULE_VALUE
      );
      setPermissions(grant?.permissions ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (permissions === null || permissions.length === 0) return null;
  const canConfigure = permissions.includes("configure");
  if (!canConfigure) return null;

  return (
    <section className="content-width mb-8 print:hidden">
      <details className="group border border-themed rounded-lg bg-card">
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 list-none group-open:border-b group-open:border-themed hover:bg-surface rounded-lg">
          <DisclosureArrow />
          <h3 className="text-lg font-bold text-t1">管理功能</h3>
          <span className="text-xs text-t3">依管理人員指派的子權限顯示可執行的操作</span>
        </summary>
        <div className="p-4 space-y-3">
          <p className="text-xs text-t3 max-w-2xl">
            你被管理員指派管理「自主學習計畫」，此處依你持有的子權限顯示可執行的操作：
            {permissions.map((code) => PERMISSION_LABELS[code] ?? code).join("、")}
            。下方為此身分的基本功能。
          </p>
          <Suspense fallback={<p className="text-sm text-t3">管理功能載入中...</p>}>
            <AdminSelfDirectedLearningPage fill delegated />
          </Suspense>
        </div>
      </details>
    </section>
  );
}
