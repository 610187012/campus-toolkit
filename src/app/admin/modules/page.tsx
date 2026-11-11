"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DisclosureArrow from "@/components/DisclosureArrow";
import ModuleIcon from "@/components/ModuleIcon";
import {
  FEATURE_MODULES,
  FEATURE_MODULE_STATUS_LABELS,
  ModuleManagerPermission,
  type FeatureModuleMeta,
  type FeatureModuleRoleSwitches,
  type FeatureModuleRolesMap,
  type FeatureModulesEnabledMap,
} from "@/types/feature-modules";
import { ALL_ROLES, ROLE_LABELS, STAFF_ATTRIBUTES, type UserRole } from "@/types/users";
import { ROSTER_ROLES, type RosterRole } from "@/types/roster";
import Toast, { type ToastMessage } from "@/components/Toast";
import RevealListCard from "@/components/RevealListCard";
import { useDataSaver } from "@/lib/data-saver";

/** 功能入口欄對應的身分（管理員欄已退役——管理員恆全權，見政策修改書 G1） */
const ENTRY_ROLES: UserRole[] = ALL_ROLES.filter((role) => role !== "admin");

/** 可被指派管理的身分（管理員恆全權、不列入指派） */
const DELEGATABLE_ROLES = ROSTER_ROLES.filter((roster) => roster.value !== "admin");

/** 學生候選搜尋欄位（班號／學號／姓名） */
const STUDENT_SEARCH_FIELDS = [
  { value: "rollNo", label: "班號" },
  { value: "studentId", label: "學號" },
  { value: "name", label: "姓名" },
] as const;

interface FeatureModulesResponse {
  success?: boolean;
  message?: string;
  enabled?: FeatureModulesEnabledMap;
  roles?: FeatureModuleRolesMap;
  canUninstall?: boolean;
  branch?: string;
  commitUrl?: string;
}

interface MarketInstalledResponse {
  success?: boolean;
  modules?: Array<{ id: string; version: string; latestVersion?: string }>;
  installedModules?: Record<string, string>;
}

interface ManagerRow {
  uid: string;
  role: RosterRole;
  name: string;
  email: string;
  account: string;
  permissions: string[];
  attribute?: string;
  unit?: string;
  title?: string;
  grade?: string;
  classCode?: string;
  className?: string;
  studentId?: string;
  rollNo?: string;
  studentName?: string;
}

function parseComparableVersion(value: string): { parts: number[]; prerelease: string[] } | null {
  const match = value
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    parts: match[1].split(".").map(Number),
    prerelease: match[2] ? match[2].split(".") : [],
  };
}

/** 回傳市集版本相對目前版本的順序；非標準版本字串不做自動判斷。 */
function compareModuleVersions(current: string, latest: string): number | null {
  const currentVersion = parseComparableVersion(current);
  const latestVersion = parseComparableVersion(latest);
  if (!currentVersion || !latestVersion) return null;

  const length = Math.max(currentVersion.parts.length, latestVersion.parts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentVersion.parts[index] ?? 0;
    const latestPart = latestVersion.parts[index] ?? 0;
    if (latestPart !== currentPart) return latestPart > currentPart ? 1 : -1;
  }

  const currentPre = currentVersion.prerelease;
  const latestPre = latestVersion.prerelease;
  if (currentPre.length === 0 || latestPre.length === 0) {
    if (currentPre.length === latestPre.length) return 0;
    return currentPre.length === 0 ? -1 : 1;
  }

  const preLength = Math.max(currentPre.length, latestPre.length);
  for (let index = 0; index < preLength; index += 1) {
    const currentPart = currentPre[index];
    const latestPart = latestPre[index];
    if (currentPart === undefined || latestPart === undefined) {
      return latestPart === undefined ? -1 : 1;
    }
    if (currentPart === latestPart) continue;

    const currentNumeric = /^\d+$/.test(currentPart);
    const latestNumeric = /^\d+$/.test(latestPart);
    if (currentNumeric && latestNumeric) {
      return Number(latestPart) > Number(currentPart) ? 1 : -1;
    }
    if (currentNumeric !== latestNumeric) return latestNumeric ? -1 : 1;
    return latestPart.localeCompare(currentPart) > 0 ? 1 : -1;
  }
  return 0;
}

/** 小標籤（已上線／開發中／規劃中） */
function Badge({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span className={`text-xs border border-themed rounded px-1.5 py-0.5 ${className}`}>
      {text}
    </span>
  );
}

/** 模組名稱旁的說明展開箭頭，控制該列下方的說明列 */
function HelpToggle({
  id,
  label,
  open,
  onToggle,
}: {
  id: string;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onToggle();
      }}
      className="inline-flex align-middle"
    >
      <summary
        aria-label={`查看「${label}」說明`}
        aria-controls={`module-description-${id}`}
        title="查看說明"
        className="flex h-5 w-5 list-none cursor-pointer items-center justify-center"
      >
        <DisclosureArrow className="h-3.5 w-3.5" />
      </summary>
      <span className="sr-only">說明內容顯示於模組列下方</span>
    </details>
  );
}

/**
 * 管理員意象圖示（人像＋齒輪）：代表「以管理員身分指派／設定本模組的管理人員」，
 * 只做語意呈現，收合指示一律交給 DisclosureArrow。
 */
function AdminGrantIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="7" r="4" />
      <path d="M10 15H6a4 4 0 0 0-4 4v2" />
      <circle cx="18" cy="15" r="3" />
      <path d="m21.7 16.4-.9-.3" />
      <path d="m15.2 13.9-.9-.3" />
      <path d="m16.6 18.7.3-.9" />
      <path d="m19.1 12.2.3-.9" />
      <path d="m19.6 18.7-.4-1" />
      <path d="m16.8 12.3-.4-1" />
      <path d="m14.3 16.6 1-.4" />
      <path d="m20.7 13.8 1-.4" />
    </svg>
  );
}

/** 模組列的管理人員開關（管理員圖示＋展開箭頭），控制該列下方的管理人員指派列 */
function ManagerToggle({
  id,
  label,
  open,
  onToggle,
}: {
  id: string;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onToggle();
      }}
      className="inline-flex align-middle"
    >
      <summary
        aria-label={`設定「${label}」的管理人員`}
        aria-controls={`module-managers-${id}`}
        title="設定管理人員"
        className="flex items-center gap-1 list-none cursor-pointer rounded border border-themed px-1.5 py-1 hover:bg-surface"
      >
        <AdminGrantIcon className="h-5 w-5 text-t2" />
        <DisclosureArrow className="h-3 w-3" />
      </summary>
      <span className="sr-only">管理人員設定內容顯示於模組列下方</span>
    </details>
  );
}

/**
 * 展開時插在該列下方的管理人員指派列（只在展開時渲染）：
 * 有 managerPermissions 宣告者放指派區；未宣告者說明為何不需指派。
 */
function ManagerPanelRow({
  item,
  open,
  colSpan,
}: {
  item: FeatureModuleMeta;
  open: boolean;
  colSpan: number;
}) {
  if (!open) return null;
  const delegatable = Array.isArray(item.managerPermissions) && item.managerPermissions.length > 0;
  return (
    <tr id={`module-managers-${item.value}`} className="border-b border-themed last:border-0">
      <td colSpan={colSpan} className="p-0">
        {delegatable ? (
          <ManagerSection item={item} />
        ) : (
          <p className="px-3 py-3 text-xs text-t3 bg-surface">
            本模組未宣告可指派的子權限，不需指派管理人員（管理員對所有功能模組恆為全權）。
          </p>
        )}
      </td>
    </tr>
  );
}

/**
 * 展開時插在該列下方的說明列（只在展開時渲染）：
 * 模組說明＋作者／版本資訊＋「提供功能」唯讀矩陣＋最新改版記錄。
 */
function DescriptionRow({
  item,
  open,
  colSpan,
}: {
  item: FeatureModuleMeta;
  open: boolean;
  colSpan: number;
}) {
  if (!open) return null;
  const latestNote = item.changelog?.[0];
  return (
    <tr id={`module-description-${item.value}`} className="border-b border-themed last:border-0">
      <td colSpan={colSpan} className="px-3 py-2 text-xs text-t3 bg-surface space-y-1.5">
        <p>{item.description}</p>
        <p>
          作者：
          <a
            href={item.author.authorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-t1"
          >
            {item.author.author}
          </a>
          ｜版本 {item.author.version}｜發布 {item.author.releasedAt}
        </p>
        <p>
          提供功能（由模組作者決定，僅供檢視）：
          {ENTRY_ROLES.map((role) => (
            <span key={role} className="mr-2">
              {ROLE_LABELS[role]}＝{item.provides[role] ? "是" : "否"}
            </span>
          ))}
        </p>
        {latestNote && (
          <div className="border-t border-themed pt-1.5">
            <p className="font-medium text-t2">
              最新改版（v{latestNote.version}｜{latestNote.releasedAt}）
            </p>
            <ul className="list-disc pl-4 space-y-0.5">
              {latestNote.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * 使用者端三身分欄：同時顯示「提供功能」圖示＋「功能入口」勾選。
 * 提供功能＝否 → 文字「未提供」（不可操作）；＝是 → 綠勾「提供」與「功能入口」勾選上下排列。
 * 管理員欄已退役——管理員對所有模組恆為全權，不再逐模組勾選入口（政策修改書 G1）。
 */
function RoleCells({
  item,
  switches,
  disabled,
  disabledTitle,
  onToggle,
}: {
  item: FeatureModuleMeta;
  switches: FeatureModuleRoleSwitches | undefined;
  disabled: boolean;
  /** 禁用原因覆寫（如狀態載入失敗）；缺省＝處理中 */
  disabledTitle?: string;
  onToggle: (item: FeatureModuleMeta, role: UserRole, next: boolean) => void;
}) {
  return (
    <>
      {ENTRY_ROLES.map((role) => {
        const provided = item.provides[role] === true;
        if (!provided) {
          return (
            <td key={role} className="px-3 py-2 text-center text-xs text-t3">
              未提供
            </td>
          );
        }
        return (
          <td key={role} className="px-3 py-2 text-center align-middle">
            <span className="inline-flex flex-col items-center justify-center gap-1">
              <span
                className="inline-flex items-center gap-0.5 text-xs text-success whitespace-nowrap"
                title="提供功能（由模組作者決定，唯讀）"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                提供
              </span>
              <label className="inline-flex items-center justify-center gap-1 text-xs text-t3">
                <span>功能入口</span>
                <input
                  type="checkbox"
                  checked={switches?.[role] === true}
                  disabled={disabled}
                  onChange={(event) => onToggle(item, role, event.target.checked)}
                  aria-label={`「${item.label}」對${ROLE_LABELS[role]}身分的功能入口`}
                  title={
                    disabled
                      ? (disabledTitle ?? "同一時間只能處理一筆變更")
                      : "功能入口（關閉＝首頁不顯示入口、禁止進入）"
                  }
                  className="accent-current cursor-pointer disabled:opacity-50"
                />
              </label>
            </span>
          </td>
        );
      })}
    </>
  );
}

/** 內建功能模組列表列：一律啟用；已上線且有入口者可直接進入；身分欄＝功能入口 */
function BuiltinRow({
  item,
  open,
  onToggleHelp,
  managersOpen,
  onToggleManagers,
  switches,
  disabled,
  disabledTitle,
  onToggleRole,
  onOpen,
}: {
  item: FeatureModuleMeta;
  open: boolean;
  onToggleHelp: (value: string) => void;
  /** 管理人員指派列是否展開（該列下方） */
  managersOpen: boolean;
  onToggleManagers: (value: string) => void;
  switches: FeatureModuleRoleSwitches | undefined;
  disabled: boolean;
  disabledTitle?: string;
  onToggleRole: (item: FeatureModuleMeta, role: UserRole, next: boolean) => void;
  onOpen: (href: string) => void;
}) {
  const enterable = item.status === "live" && item.href !== "";
  return (
    <>
      <tr className={`border-b border-themed last:border-0 text-t1${enterable ? "" : " opacity-70"}`}>
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="flex items-center gap-2">
            <span className="font-medium">{item.label}</span>
            <HelpToggle
              id={item.value}
              label={item.label}
              open={open}
              onToggle={() => onToggleHelp(item.value)}
            />
          </span>
          <span className="mt-0.5 block">
            <Badge text={FEATURE_MODULE_STATUS_LABELS[item.status]} className="text-t3" />
          </span>
          <span className="mt-0.5 block text-xs text-t3">
            作者：{item.author.author || item.value}
            {item.marketName && item.marketName !== item.label ? `｜市集名稱：${item.marketName}` : ""}
          </span>
        </td>
        <RoleCells item={item} switches={switches} disabled={disabled} disabledTitle={disabledTitle} onToggle={onToggleRole} />
        <td className="px-3 py-2 whitespace-nowrap text-right">
          <span className="inline-flex items-center justify-end gap-1.5">
            {enterable ? (
              <button
                type="button"
                onClick={() => onOpen(item.href)}
                aria-label={`前往「${item.label}」`}
                title="前往該模組功能頁"
                className="btn-theme rounded p-1.5 cursor-pointer"
              >
                <ModuleIcon value="settings" className="h-4 w-4" />
              </button>
            ) : (
              <span className="text-xs text-t3">尚未提供，敬請期待</span>
            )}
            <ManagerToggle
              id={item.value}
              label={item.label}
              open={managersOpen}
              onToggle={() => onToggleManagers(item.value)}
            />
          </span>
        </td>
      </tr>
      <DescriptionRow item={item} open={open} colSpan={5} />
      <ManagerPanelRow item={item} open={managersOpen} colSpan={5} />
    </>
  );
}

/** 選用功能模組列表列：總開關＋使用者端三身分功能入口＋操作（齒輪前往／管理人員／卸載），全體管理員可操作 */
function OptionalRow({
  item,
  open,
  onToggleHelp,
  managersOpen,
  onToggleManagers,
  enabled,
  switches,
  loadFailed,
  canUninstall,
  pendingUninstall,
  saving,
  onToggleMaster,
  onToggleRole,
  onUninstall,
  onOpen,
  marketLatestVersion,
}: {
  item: FeatureModuleMeta;
  open: boolean;
  onToggleHelp: (value: string) => void;
  /** 管理人員指派列是否展開（該列下方） */
  managersOpen: boolean;
  onToggleManagers: (value: string) => void;
  enabled: boolean;
  switches: FeatureModuleRoleSwitches | undefined;
  /** 開關狀態載入失敗：勾選／總開關不可信，一律禁用 */
  loadFailed?: boolean;
  canUninstall: boolean;
  pendingUninstall?: { branch?: string; commitUrl?: string };
  saving: boolean;
  onToggleMaster: (item: FeatureModuleMeta, next: boolean) => void;
  onToggleRole: (item: FeatureModuleMeta, role: UserRole, next: boolean) => void;
  onUninstall: (item: FeatureModuleMeta) => void;
  onOpen: (href: string) => void;
  marketLatestVersion?: string;
}) {
  const stateText = enabled ? "已啟用" : "未啟用";
  const hasNewerVersion =
    !!marketLatestVersion && compareModuleVersions(item.author.version, marketLatestVersion) === 1;
  const loadFailedReason = "開關狀態載入失敗，請重新整理頁面";
  const disabledReason = loadFailed
    ? loadFailedReason
    : saving
      ? "處理中..."
      : undefined;
  const switchesDisabled = saving || loadFailed === true;
  const uninstallDisabledReason = !canUninstall
    ? "目前環境尚未完成卸載管線設定"
    : disabledReason ?? "移除模組程式碼；資料庫資料預設保留";
  const enterable = enabled && item.href !== "";
  return (
    <>
      <tr className="border-b border-themed last:border-0 text-t1">
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="flex items-center gap-2">
            <span className="font-medium">{item.label}</span>
            <HelpToggle
              id={item.value}
              label={item.label}
              open={open}
              onToggle={() => onToggleHelp(item.value)}
            />
          </span>
        </td>
        <td className="px-3 py-2 text-center text-xs whitespace-nowrap">
          <span className="text-t2">v{item.author.version || "—"}</span>
          {hasNewerVersion && (
            <span className="block mt-1 text-warning" role="status">
              有新版：v{marketLatestVersion}
            </span>
          )}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <span className="flex flex-col items-center gap-1">
            <span className="flex items-center justify-center gap-2">
              <span className={`text-xs font-medium ${enabled ? "text-t3" : "text-t2"}`}>
                關
              </span>
              <button
                type="button"
                onClick={() => onToggleMaster(item, !enabled)}
                disabled={switchesDisabled}
                role="switch"
                aria-checked={enabled}
                aria-label={`「${item.label}」總開關：${stateText}`}
                title={disabledReason}
                className={`inline-flex h-6 w-11 items-center rounded-full border border-themed transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? "bg-primary" : "bg-surface"}`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`}
                />
              </button>
              <span className={`text-xs font-medium ${enabled ? "text-success" : "text-t3"}`}>
                開
              </span>
            </span>
            {saving && <span className="text-xs text-t3">處理中...</span>}
          </span>
        </td>
        <RoleCells
          item={item}
          switches={switches}
          disabled={switchesDisabled}
          disabledTitle={loadFailed ? loadFailedReason : undefined}
          onToggle={onToggleRole}
        />
        <td className="px-3 py-2 whitespace-nowrap text-right">
          <span className="inline-flex items-center justify-end gap-1.5">
            {enterable ? (
              <button
                type="button"
                onClick={() => onOpen(item.href)}
                aria-label={`前往「${item.label}」`}
                title="前往該模組管理頁"
                className="btn-theme rounded p-1.5 cursor-pointer"
              >
                <ModuleIcon value="settings" className="h-4 w-4" />
              </button>
            ) : null}
            <ManagerToggle
              id={item.value}
              label={item.label}
              open={managersOpen}
              onToggle={() => onToggleManagers(item.value)}
            />
            {pendingUninstall ? (
              <span className="text-xs text-warning inline-flex items-center gap-2">
                部署中…
                {pendingUninstall.commitUrl ? (
                  <a
                    href={pendingUninstall.commitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-warning"
                  >
                    查看提交
                  </a>
                ) : null}
              </span>
            ) : canUninstall ? (
              <button
                type="button"
                onClick={() => onUninstall(item)}
                disabled={saving || !canUninstall}
                title={uninstallDisabledReason}
                className="btn-danger rounded px-3 py-1 text-xs cursor-pointer disabled:opacity-50"
              >
                卸載
              </button>
            ) : null}
          </span>
        </td>
      </tr>
      <DescriptionRow item={item} open={open} colSpan={7} />
      <ManagerPanelRow item={item} open={managersOpen} colSpan={7} />
    </>
  );
}

/**
 * 管理人員指派區（模組展開列，僅模組有 managerPermissions 時顯示）：
 * 搜尋當期名冊帳號 → 勾選子權限 → 指派；列表顯示已指派者，可改權限或移除。
 * 資料落於各身分名冊條目 managedModules（政策修改書 §6）。
 */
function ManagerSection({ item }: { item: FeatureModuleMeta }) {
  const permissionDefs: ModuleManagerPermission[] = item.managerPermissions ?? [];
  const [managers, setManagers] = useState<ManagerRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searchRole, setSearchRole] = useState<RosterRole>("staff");
  const [searchQ, setSearchQ] = useState("");
  const [searchField, setSearchField] =
    useState<(typeof STUDENT_SEARCH_FIELDS)[number]["value"]>("name");
  const [staffAttribute, setStaffAttribute] = useState("");
  const [candidates, setCandidates] = useState<ManagerRow[] | null>(null);
  const [draftPerms, setDraftPerms] = useState<Record<string, boolean>>({});
  /** 省流閘門：教職員候選名單是否已由使用者按下「顯示列表」 */
  const [staffRevealed, setStaffRevealed] = useState(false);
  /** 省流模式下的候選人數（count 聚合，不載入名單） */
  const [staffCandidateCount, setStaffCandidateCount] = useState<number | null>(null);
  const { ready: saverReady, saverOn } = useDataSaver();

  function permsFromList(list: string[]): Record<string, boolean> {
    const map: Record<string, boolean> = {};
    for (const def of permissionDefs) map[def.value] = list.includes(def.value);
    return map;
  }

  async function loadManagers() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/feature-modules/managers?module=${encodeURIComponent(item.value)}`,
        { cache: "no-store" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `載入失敗（HTTP ${res.status}）`);
      }
      setManagers(Array.isArray(data.managers) ? data.managers : []);
    } catch (e) {
      setManagers([]);
      setError(e instanceof Error ? e.message : "載入失敗");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setManagers(null);
    setCandidates(null);
    setStaffRevealed(false);
    setStaffCandidateCount(null);
    setError("");
    void loadManagers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.value]);

  async function search() {
    const q = searchQ.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({
        module: item.value,
        role: searchRole,
        q,
      });
      if (searchRole === "student") params.set("field", searchField);
      const res = await fetch(
        `/api/admin/feature-modules/managers?${params.toString()}`,
        { cache: "no-store" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `搜尋失敗（HTTP ${res.status}）`);
      }
      setCandidates(Array.isArray(data.people) ? data.people : []);
    } catch (e) {
      setCandidates([]);
      setError(e instanceof Error ? e.message : "搜尋失敗");
    } finally {
      setBusy(false);
    }
  }

  /** 教職員候選名單：列出當期名冊，可依屬性篩選（不需輸入關鍵字） */
  async function loadStaffCandidates(attribute: string) {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ module: item.value, role: "staff" });
      if (attribute) params.set("attribute", attribute);
      const res = await fetch(
        `/api/admin/feature-modules/managers?${params.toString()}`,
        { cache: "no-store" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `載入候選名單失敗（HTTP ${res.status}）`);
      }
      setCandidates(Array.isArray(data.people) ? data.people : []);
    } catch (e) {
      setCandidates([]);
      setError(e instanceof Error ? e.message : "載入候選名單失敗");
    } finally {
      setBusy(false);
    }
  }

  // 省流模式：以 count 聚合取得候選人數，供「顯示候選人員列表」按鈕顯示總數
  useEffect(() => {
    if (!saverReady || !saverOn || searchRole !== "staff") return;
    let cancelled = false;
    const params = new URLSearchParams({
      module: item.value,
      role: "staff",
      summary: "count",
    });
    if (staffAttribute) params.set("attribute", staffAttribute);
    void fetch(`/api/admin/feature-modules/managers?${params.toString()}`, {
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.success) return;
        setStaffCandidateCount(typeof data.count === "number" ? data.count : null);
      })
      .catch(() => {
        /* 人數僅為提示，失敗時不阻擋手動顯示 */
      });
    return () => {
      cancelled = true;
    };
  }, [saverReady, saverOn, searchRole, staffAttribute, item.value]);

  // 教職員候選名單：省流模式須等使用者按下「顯示列表」才載入；一般模式自動載入
  useEffect(() => {
    if (searchRole !== "staff") return;
    // 設定尚未判定前不得載入，否則省流模式下會白打一發請求
    if (!saverReady) return;
    if (saverOn && !staffRevealed) return;
    void loadStaffCandidates(staffAttribute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRole, staffAttribute, item.value, saverReady, saverOn, staffRevealed]);

  /** 指派／更新一個人的子權限：以呼叫端算好的 permissions 為準（候選區草稿已含 uid 前綴） */
  async function assign(person: ManagerRow) {
    const permissions = person.permissions.filter((code) =>
      permissionDefs.some((def) => def.value === code)
    );
    if (permissions.length === 0) {
      setError("請至少勾選一項子權限");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/feature-modules/managers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          module: item.value,
          uid: person.uid,
          role: person.role,
          permissions,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `指派失敗（HTTP ${res.status}）`);
      }
      setCandidates(null);
      setSearchQ("");
      setDraftPerms({});
      await loadManagers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "指派失敗");
    } finally {
      setBusy(false);
    }
  }

  async function remove(person: ManagerRow) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/feature-modules/managers?module=${encodeURIComponent(item.value)}&uid=${encodeURIComponent(person.uid)}&role=${person.role}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `移除失敗（HTTP ${res.status}）`);
      }
      await loadManagers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "移除失敗");
    } finally {
      setBusy(false);
    }
  }

  const roleLabel = (role: RosterRole) =>
    ROSTER_ROLES.find((item) => item.value === role)?.label || role;

  return (
    <div className="border-t border-themed px-3 py-3 bg-surface space-y-3">
      <p className="text-xs text-t2 font-medium">
        管理人員（指定非管理員身分管理本模組；管理員本身恆為全權、不需指派）
      </p>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {managers === null ? (
        <p className="text-xs text-t3">管理人員載入中...</p>
      ) : managers.length === 0 ? (
        <p className="text-xs text-t3">目前無被指定的管理人員。</p>
      ) : (
        <ul className="space-y-2">
          {managers.map((person) => (
            <li
              key={`${person.role}:${person.uid}`}
              className="flex flex-col sm:flex-row sm:items-center gap-2 text-sm"
            >
              <span className="text-t1 whitespace-nowrap">
                [{roleLabel(person.role)}] {person.name}
                <span className="text-t3 ml-1 text-xs">
                  {person.account || person.email}
                </span>
              </span>
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {permissionDefs.map((def) => (
                  <label key={def.value} className="inline-flex items-center gap-1 text-xs text-t2">
                    <input
                      type="checkbox"
                      checked={person.permissions.includes(def.value)}
                      disabled={busy}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...person.permissions, def.value]
                          : person.permissions.filter((code) => code !== def.value);
                        void assign({ ...person, permissions: next });
                      }}
                      className="accent-current"
                    />
                    {def.label}
                  </label>
                ))}
              </span>
              <button
                type="button"
                onClick={() => void remove(person)}
                disabled={busy}
                className="btn-danger rounded px-2 py-1 text-xs cursor-pointer disabled:opacity-50 sm:ml-auto"
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 border-t border-themed pt-3">
        <p className="text-xs text-t2 font-medium">新增管理人員</p>
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <select
              value={searchRole}
              onChange={(event) => {
                const next = event.target.value as RosterRole;
                setSearchRole(next);
                setCandidates(null);
                setSearchQ("");
              }}
              className="input-theme rounded px-2 py-1 text-sm"
              disabled={busy}
            >
              {DELEGATABLE_ROLES.map((roster) => (
                <option key={roster.value} value={roster.value}>
                  {roster.label}
                </option>
              ))}
            </select>
            {searchRole === "staff" ? (
              <>
                <select
                  value={staffAttribute}
                  onChange={(event) => setStaffAttribute(event.target.value)}
                  className="input-theme rounded px-2 py-1 text-sm"
                  disabled={busy}
                  aria-label="依屬性篩選教職員"
                >
                  <option value="">全部屬性</option>
                  {STAFF_ATTRIBUTES.map((attribute) => (
                    <option key={attribute} value={attribute}>
                      {attribute}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-t3">候選人員名單（依屬性篩選）</span>
              </>
            ) : (
              <>
                {searchRole === "student" && (
                  <select
                    value={searchField}
                    onChange={(event) =>
                      setSearchField(
                        event.target.value as (typeof STUDENT_SEARCH_FIELDS)[number]["value"]
                      )
                    }
                    className="input-theme rounded px-2 py-1 text-sm"
                    disabled={busy}
                    aria-label="選擇搜尋欄位"
                  >
                    {STUDENT_SEARCH_FIELDS.map((field) => (
                      <option key={field.value} value={field.value}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="text"
                  value={searchQ}
                  onChange={(event) => setSearchQ(event.target.value)}
                  placeholder={
                    searchRole === "student"
                      ? `輸入${STUDENT_SEARCH_FIELDS.find((field) => field.value === searchField)?.label ?? "姓名"}（精確比對）`
                      : "輸入帳號或姓名（精確比對）"
                  }
                  className="input-theme rounded px-2 py-1 text-sm flex-1"
                  disabled={busy}
                />
                <button
                  type="button"
                  onClick={() => void search()}
                  disabled={busy || !searchQ.trim()}
                  className="btn-theme rounded px-3 py-1 text-xs cursor-pointer disabled:opacity-50"
                >
                  搜尋
                </button>
              </>
            )}
          </div>
          {searchRole === "staff" && saverOn && !staffRevealed ? (
            <div className="border border-themed bg-card rounded-lg">
              <RevealListCard
                label="候選人員"
                onReveal={() => setStaffRevealed(true)}
                summary={
                  staffCandidateCount === null
                    ? undefined
                    : `目前候選 ${staffCandidateCount} 人${
                        staffAttribute ? `（${staffAttribute}）` : ""
                      }`
                }
              />
            </div>
          ) : (
            candidates !== null &&
            (candidates.length === 0 ? (
              <p className="text-xs text-t3">查無符合的當期名冊條目。</p>
            ) : (
              <ul className="space-y-2 max-h-96 overflow-y-auto">
                {candidates.map((person) => {
                  const existing = managers?.find(
                    (m) => m.uid === person.uid && m.role === person.role
                  );
                  const allChecked =
                    permissionDefs.length > 0 &&
                    permissionDefs.every(
                      (def) =>
                        draftPerms[`${person.uid}:${def.value}`] ??
                        existing?.permissions.includes(def.value) ??
                        false
                    );
                  const meta =
                    person.role === "staff"
                      ? [person.attribute, person.unit, person.title].filter(Boolean).join("／")
                      : person.role === "student"
                        ? [
                            person.className || person.classCode,
                            person.studentId ? `學號 ${person.studentId}` : "",
                            person.rollNo ? `班號 ${person.rollNo}` : "",
                          ]
                            .filter(Boolean)
                            .join("／")
                        : person.studentName
                          ? `子女：${person.studentName}`
                          : "";
                  return (
                    <li
                      key={`${person.role}:${person.uid}`}
                      className="flex flex-col sm:flex-row sm:items-center gap-2 text-sm border border-themed rounded p-2"
                    >
                      <span className="text-t1">
                        [{roleLabel(person.role)}] {person.name}
                        <span className="text-t3 ml-1 text-xs">
                          {person.account || person.email}
                        </span>
                        {meta && <span className="text-t3 ml-1 text-xs">{meta}</span>}
                        {existing && <span className="text-warning ml-1 text-xs">已指派</span>}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {permissionDefs.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setDraftPerms((current) => {
                                const next = { ...current };
                                for (const def of permissionDefs) {
                                  next[`${person.uid}:${def.value}`] = !allChecked;
                                }
                                return next;
                              })
                            }
                            disabled={busy}
                            className="btn-soft rounded px-2 py-0.5 text-xs cursor-pointer disabled:opacity-50"
                          >
                            {allChecked ? "取消全選" : "全選"}
                          </button>
                        )}
                        {permissionDefs.map((def) => (
                          <label
                            key={def.value}
                            className="inline-flex items-center gap-1 text-xs text-t2"
                          >
                            <input
                              type="checkbox"
                              checked={
                                draftPerms[`${person.uid}:${def.value}`] ??
                                existing?.permissions.includes(def.value) ??
                                false
                              }
                              disabled={busy}
                              onChange={(event) =>
                                setDraftPerms((current) => ({
                                  ...current,
                                  [`${person.uid}:${def.value}`]: event.target.checked,
                                }))
                              }
                              className="accent-current"
                            />
                            {def.label}
                          </label>
                        ))}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const permissions = permissionDefs
                            .filter(
                              (def) =>
                                draftPerms[`${person.uid}:${def.value}`] ??
                                existing?.permissions.includes(def.value) ??
                                false
                            )
                            .map((def) => def.value);
                          void assign({ ...person, permissions });
                        }}
                        disabled={busy}
                        className="btn-theme rounded px-2 py-1 text-xs cursor-pointer disabled:opacity-50 sm:ml-auto"
                      >
                        {existing ? "更新" : "指派"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 「功能模組管理」入口（全體管理員，政策修改書決議二）：
 * 內建／選用兩份功能模組列表，說明與作者／版本／提供功能由名稱旁箭頭就地展開；
 * 選用模組有總開關；使用者端三身分欄＝**功能入口**（提供功能＝否顯示「未提供」）。
 * 管理員欄已退役（恆全權）；操作欄＝齒輪（前往）＋管理員圖示（就地展開「管理人員」指派列）＋卸載。
 */
export default function ModulesPage() {
  const router = useRouter();
  // 總開關與功能入口開關：null＝載入中（fail-closed，先當全部未啟用）
  const [enabled, setEnabled] = useState<FeatureModulesEnabledMap | null>(null);
  const [roles, setRoles] = useState<FeatureModuleRolesMap | null>(null);
  // 處理中的鍵：總開關＝模組代碼；功能入口開關＝「模組代碼:身分」
  const [saving, setSaving] = useState<string | null>(null);
  // 開關狀態載入失敗訊息：非空＝頁面勾選／總開關不可信（禁止默默呈現全未勾選）
  const [loadError, setLoadError] = useState("");
  const [openDesc, setOpenDesc] = useState<string | null>(null);
  // 管理人員指派列：目前展開的模組代碼（null＝全收合）
  const [openManagers, setOpenManagers] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // 卸載確認視窗（modal）：null＝關閉；否則為待卸載的模組
  const [confirmUninstall, setConfirmUninstall] = useState<FeatureModuleMeta | null>(null);
  const [canUninstall, setCanUninstall] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [pendingUninstalls, setPendingUninstalls] = useState<
    Record<string, { branch?: string; commitUrl?: string }>
  >({});
  const [marketLatestVersions, setMarketLatestVersions] = useState<Record<string, string>>({});
  const pollTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    return () => {
      Object.values(pollTimersRef.current).forEach((timerId) => window.clearInterval(timerId));
      pollTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/feature-modules", { cache: "no-store" })
      .then(async (res) => {
        const data: FeatureModulesResponse | null = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && data?.success && data.enabled && data.roles) {
          setEnabled(data.enabled);
          setRoles(data.roles);
          setCanUninstall(data.canUninstall === true);
          setLoadError("");
          return;
        }
        // 取得失敗仍以空值結束載入，但明確標示狀態不可信：
        // 否則所有開關會默默呈現「未勾選」，被誤讀為權限已關閉
        setEnabled({});
        setRoles({});
        setCanUninstall(false);
        setLoadError(data?.message || `開關狀態載入失敗（HTTP ${res.status}）`);
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled({});
        setRoles({});
        setCanUninstall(false);
        setLoadError("開關狀態載入失敗（網路錯誤）");
      });

    fetch("/api/admin/feature-modules/market", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MarketInstalledResponse | null) => {
        if (cancelled || !data?.success || !Array.isArray(data.modules)) return;
        const versions: Record<string, string> = {};
        for (const module of data.modules) {
          const latest = module.latestVersion || module.version;
          if (module.id && latest) versions[module.id] = latest;
        }
        setMarketLatestVersions(versions);
      })
      .catch(() => {
        // 市集來源未設定或暫時無法連線時，仍顯示本機模組版本，不中斷模組管理。
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /** 送出 PATCH，成功後依回應更新總開關或功能入口開關 */
  async function patch(body: Record<string, unknown>, key: string) {
    if (saving) return;
    setSaving(key);
    setToast(null);
    try {
      const res = await fetch("/api/admin/feature-modules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: FeatureModulesResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `操作失敗（HTTP ${res.status}）`);
      }
      if (data.enabled) setEnabled(data.enabled);
      if (data.roles) setRoles(data.roles);
      setToast({ kind: "success", text: data.message || "已更新" });
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "操作失敗" });
    } finally {
      setSaving(null);
    }
  }

  /** 選用模組總開關 */
  function toggleMaster(item: FeatureModuleMeta, next: boolean) {
    void patch({ value: item.value, enabled: next }, item.value);
  }

  /** 模組 × 身分功能入口 */
  function toggleRole(item: FeatureModuleMeta, role: UserRole, next: boolean) {
    void patch({ value: item.value, role, enabled: next }, `${item.value}:${role}`);
  }

  /** 卸載確認：開啟 modal（不使用瀏覽器原生 confirm） */
  function uninstallModule(item: FeatureModuleMeta) {
    if (saving) return;
    setConfirmUninstall(item);
    setBackupConfirmed(false);
  }

  /** 確認卸載後執行（正式環境送出提交並等待部署；本機開發直接生效） */
  async function runUninstall(item: FeatureModuleMeta) {
    setConfirmUninstall(null);
    if (saving) return;
    setSaving(`${item.value}:uninstall`);
    setToast(null);
    try {
      const res = await fetch("/api/admin/feature-modules", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: item.value, confirmedBackup: backupConfirmed }),
      });
      const data: FeatureModulesResponse | null = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `操作失敗（HTTP ${res.status}）`);
      }
      setSaving(null);
      if (data.commitUrl || data.branch) {
        setPendingUninstalls((current) => ({
          ...current,
          [item.value]: { branch: data.branch, commitUrl: data.commitUrl },
        }));
        setToast({
          kind: "success",
          text: `${data.message || "已送出卸載提交"}（部署完成後此頁會自動刷新）`,
        });
        startUninstallPolling(item.value);
      } else {
        setToast({ kind: "success", text: data.message || "已卸載" });
        window.location.reload();
      }
    } catch (error) {
      setToast({ kind: "error", text: error instanceof Error ? error.message : "操作失敗" });
      setSaving(null);
    }
  }

  function startUninstallPolling(moduleValue: string) {
    if (pollTimersRef.current[moduleValue]) return;

    let attempts = 0;
    const maxAttempts = 60;
    const timerId = window.setInterval(async () => {
      attempts += 1;
      try {
        const res = await fetch("/api/admin/feature-modules/market", { cache: "no-store" });
        const data: MarketInstalledResponse | null = await res.json().catch(() => null);
        const installed = data?.success && data.installedModules ? data.installedModules : {};
        if (!installed[moduleValue]) {
          window.clearInterval(timerId);
          delete pollTimersRef.current[moduleValue];
          window.location.reload();
          return;
        }
      } catch {
        // 忽略暫時的輪詢失敗，讓下一次重試
      }

      if (attempts >= maxAttempts) {
        window.clearInterval(timerId);
        delete pollTimersRef.current[moduleValue];
        setSaving(null);
        setToast({ kind: "success", text: "卸載提交已送出；部署時間較長，請稍後手動重新整理。" });
      }
    }, 8000);

    pollTimersRef.current[moduleValue] = timerId;
  }

  function toggleHelp(value: string) {
    setOpenDesc((current) => (current === value ? null : value));
  }

  /** 展開／收合該列下方的管理人員指派列（同一時間一列） */
  function toggleManagers(value: string) {
    setOpenManagers((current) => (current === value ? null : value));
  }

  const builtins = FEATURE_MODULES.filter((item) => item.kind === "builtin");
  const optionals = FEATURE_MODULES.filter((item) => item.kind === "optional");
  const loading = enabled === null || roles === null;
  const loadingText = loading ? "啟用狀態載入中..." : "";

  return (
    <div className="content-width mb-8 space-y-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => router.push("/admin/modules/market")}
          className="btn-theme rounded px-4 py-2 text-sm cursor-pointer"
        >
          開啟模組市集
        </button>
      </div>

      <Toast message={toast} onClose={() => setToast(null)} />

      {/* 開關狀態載入失敗：明確標示，避免「全數未勾選」被誤讀為權限已關閉 */}
      {loadError && (
        <div className="alert-danger p-4 text-sm" role="alert">
          <span className="font-bold text-danger">開關狀態載入失敗：</span>
          {loadError}
          。目前載入的勾選與總開關狀態不可信，已暫停操作，請重新整理後再試。
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-theme rounded-lg px-4 py-2 text-sm cursor-pointer mt-3"
          >
            重新整理
          </button>
        </div>
      )}

      {/* 卸載確認視窗（modal，樣式比照 IdleTimeout 對話框） */}
      {confirmUninstall && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(3px)" }}
          role="presentation"
          onClick={() => {
            setConfirmUninstall(null);
            setBackupConfirmed(false);
          }}
        >
          <div
            className="bg-card border border-themed rounded-2xl p-8 text-center space-y-4 shadow-lg animate-fade-in w-full max-w-md"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="uninstall-confirm-title"
            aria-describedby="uninstall-confirm-desc"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex justify-center">
              <svg
                className="w-12 h-12"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                style={{ color: "var(--danger)" }}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
            </div>
            <div>
              <p id="uninstall-confirm-title" className="text-lg font-semibold text-t1 mb-2">
                確定卸載「{confirmUninstall.label}」？
              </p>
              <p id="uninstall-confirm-desc" className="text-sm text-t2">
                將移除模組資料夾與安裝清單；Firestore 模組資料預設保留。
              </p>
              <p className="text-xs text-t3 mt-2">
                卸載前請先備份模組關聯資料（例如 Firestore 集合與匯出檔）；資料清理需人工執行。
              </p>
              <label className="mt-3 inline-flex items-start gap-2 text-xs text-t2 text-left">
                <input
                  type="checkbox"
                  checked={backupConfirmed}
                  onChange={(event) => setBackupConfirmed(event.target.checked)}
                  className="mt-0.5 accent-current"
                />
                我已完成備份，並理解卸載後需重新部署才會生效。
              </label>
            </div>
            <div className="flex gap-3 justify-center pt-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmUninstall(null);
                  setBackupConfirmed(false);
                }}
                className="border border-themed rounded-lg px-6 py-2 text-sm font-medium text-t2 hover:text-t1 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!backupConfirmed}
                onClick={() => void runUninstall(confirmUninstall)}
                className="btn-danger rounded-lg px-6 py-2 text-sm font-medium cursor-pointer disabled:opacity-50"
              >
                確定卸載
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 內建功能模組（可收合／展開，預設收合） */}
      <details className="group border border-themed rounded-lg bg-card">
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 group-open:border-b group-open:border-themed hover:bg-surface">
          <DisclosureArrow />
          <h3 className="text-lg font-bold text-t1">內建功能模組</h3>
          <span className="text-xs text-t3">共 {builtins.length} 個模組，點擊展開／收合</span>
        </summary>
        <div className="p-3 space-y-3">
          <p className="text-xs text-t3">
            隨主程式提供、一律啟用；已上線的模組可直接進入（操作欄「齒輪」）。名稱旁的箭頭可展開說明與作者版本資訊；
            使用者端三身分欄：綠勾「提供」＝模組作者提供此功能（唯讀）；旁邊勾選＝功能入口
            （關閉＝首頁不顯示入口、禁止進入）。管理員對所有模組恆為全權，不設入口勾選；
            操作欄「管理員圖示」可就地展開該列下方的「管理人員」指派區。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="border-b border-themed">
                <tr className="text-t2">
                  <th className="px-3 py-2 font-medium whitespace-nowrap">模組名稱</th>
                  {ENTRY_ROLES.map((role) => (
                    <th key={role} className="px-3 py-2 font-medium whitespace-nowrap text-center">
                      {ROLE_LABELS[role]}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-medium whitespace-nowrap text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-t3">
                      {loadingText}
                    </td>
                  </tr>
                ) : builtins.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-t3">
                      沒有內建功能模組
                    </td>
                  </tr>
                ) : (
                  builtins.map((item) => (
                    <BuiltinRow
                      key={item.value}
                      item={item}
                      open={openDesc === item.value}
                      onToggleHelp={toggleHelp}
                      managersOpen={openManagers === item.value}
                      onToggleManagers={toggleManagers}
                      switches={roles[item.value]}
                      disabled={saving !== null || loadError !== ""}
                      disabledTitle={loadError ? "開關狀態載入失敗，請重新整理頁面" : undefined}
                      onToggleRole={toggleRole}
                      onOpen={(href) => router.push(href)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {/* 選用功能模組 */}
      <section>
        <div className="mb-3">
          <h3 className="text-lg font-bold text-t1">選用功能模組</h3>
          <p className="text-xs text-t3">
            已安裝的模組各有一個總開關（預設未啟用），由全體管理員啟用／停用。
            使用者端三身分欄上下排列：綠勾「提供」與「功能入口」勾選（提供功能＝否者顯示「未提供」）；版本欄顯示模組版本。
            操作欄「齒輪」在總開關開啟時可直接進入該模組管理頁面；「卸載」在卸載管線設定完成時可用（部署環境會建立 Git 提交）。
            安裝與卸載屬高風險操作：部署若設定 `MODULE_MARKET_INSTALL_ADMINS`，僅清單內的管理員可執行；未設定時全體管理員皆可。
            操作欄「管理員圖示」可就地展開該列下方的「管理人員」區，指派非管理員身分帳號（管理員恆全權、不需指派）。
            設定為現行狀態，變更會記錄於稽核紀錄。
          </p>
        </div>

        <div className="border border-themed rounded-lg bg-card overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="border-b border-themed">
              <tr className="text-t2">
                <th className="px-3 py-2 font-medium whitespace-nowrap">模組名稱</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">版本</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">總開關</th>
                {ENTRY_ROLES.map((role) => (
                  <th key={role} className="px-3 py-2 font-medium whitespace-nowrap text-center">
                    {ROLE_LABELS[role]}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium whitespace-nowrap text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-t3">
                    {loadingText}
                  </td>
                </tr>
              ) : optionals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-t3">
                    沒有選用功能模組
                  </td>
                </tr>
              ) : (
                optionals.map((item) => (
                  <OptionalRow
                    key={item.value}
                    item={item}
                    open={openDesc === item.value}
                    onToggleHelp={toggleHelp}
                    managersOpen={openManagers === item.value}
                    onToggleManagers={toggleManagers}
                    enabled={enabled[item.value] === true}
                    switches={roles[item.value]}
                    loadFailed={loadError !== ""}
                    canUninstall={canUninstall}
                    pendingUninstall={pendingUninstalls[item.value]}
                    saving={
                      saving === item.value ||
                      saving === `${item.value}:uninstall` ||
                      !!pendingUninstalls[item.value]
                    }
                    onToggleMaster={toggleMaster}
                    onToggleRole={toggleRole}
                    onUninstall={uninstallModule}
                    onOpen={(href) => router.push(href)}
                    marketLatestVersion={marketLatestVersions[item.value]}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        {/* 管理人員指派已改為各列「管理員圖示」就地展開（ManagerPanelRow），不再另置整卡 */}
      </section>

      {/* 管理權限說明（不同身分管理政策） */}
      <section className="border border-themed rounded-lg bg-card p-5">
        <h3 className="text-lg font-bold text-t1 mb-2">管理權限說明（不同身分管理政策）</h3>
        <p className="text-xs text-t3 mb-2">
          依「不同身分管理政策修改書」：管理員對所有功能模組恆為全權，不再區分超級／一般，
          也不再逐模組指派；其他三身分（教職員／家長／學生）由管理員按學期指定帳號管理特定模組：
        </p>
        <ul className="text-sm text-t2 space-y-1.5 list-disc pl-5">
          <li>
            <span className="font-bold text-t1">管理員</span>
            ：有當期管理員名冊條目即全權（含系統設定、功能模組管理、主題市集、統計）；
            僅保留「最後一位管理員不可停用」守門。
          </li>
          <li>
            <span className="font-bold text-t1">指定管理人員</span>
            ：按模組列的「管理員圖示」展開該列下方的「管理人員」區，指派教職員／家長／學生帳號，
            並勾選該模組宣告之子權限；指派綁定當期名冊條目，學期切換需重新指定。
          </li>
          <li>
            「功能入口」關閉時，該身分首頁不顯示此模組入口；
            管理權另由「管理人員」指派決定（兩者獨立）。
          </li>
          <li>
            被指定者以原身分登入，直接進入該模組管理頁；
            子權限逐 API 攔截（由各模組以 requireModulePermission 守門）。
          </li>
        </ul>
      </section>
    </div>
  );
}
