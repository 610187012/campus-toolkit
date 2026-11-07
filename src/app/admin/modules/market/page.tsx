"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DisclosureArrow from "@/components/DisclosureArrow";

const DEFAULT_MARKET_INDEX_URL =
  "https://raw.githubusercontent.com/takan003/campus-toolkit-marketplace/main/index.json";
const LEGACY_PAGES_MARKET_INDEX_URL =
  "https://takan003.github.io/campus-toolkit-marketplace/index.json";
const MARKETPLACE_REPOSITORY_URL = "https://github.com/takan003/campus-toolkit-marketplace";

interface MarketModuleEntry {
  id: string;
  name: string;
  description: string;
  status?: "official" | "reviewed" | "experimental";
  version: string;
  latestVersion?: string;
  minHostVersion?: string;
  repoUrl?: string;
  downloadUrl?: string;
  checksumSha256?: string;
  signature?: string;
  publicKey?: string;
  category?: string;
  tags?: string[];
  releaseNotes?: string[];
}

interface MarketResponse {
  success: boolean;
  message?: string;
  modules?: MarketModuleEntry[];
  marketUrl?: string;
  installedModules?: Record<string, string>;
  canUninstall?: boolean;
  canAutoInstall?: boolean;
}

interface InstallResponse {
  success: boolean;
  message?: string;
  alreadyInstalled?: boolean;
  moduleId?: string;
  installedVersion?: string;
  branch?: string;
  commitUrl?: string;
  manualInstallGuide?: {
    title?: string;
    steps?: string[];
    command?: string;
    note?: string;
  };
}

interface MarketConfigResponse {
  success: boolean;
  message?: string;
  marketUrl?: string;
}

interface ToggleInstallResponse {
  success: boolean;
  message?: string;
  branch?: string;
  commitUrl?: string;
  alreadyUninstalled?: boolean;
}

const MODULE_STATUS_META: Record<
  NonNullable<MarketModuleEntry["status"]>,
  { label: string; className: string }
> = {
  official: { label: "官方", className: "border-success/60 text-success" },
  reviewed: { label: "已審核社群", className: "border-primary/60 text-primary" },
  experimental: { label: "實驗", className: "border-warning/60 text-warning" },
};

function buildFallbackManualGuide(moduleId: string): NonNullable<InstallResponse["manualInstallGuide"]> {
  return {
    title: "可改用手動安裝流程",
    steps: [
      "在本機 clone 主程式 fork 與模組 repo。",
      "進入主程式資料夾後執行 npm install。",
      `執行 npm run module:install -- ../${moduleId}（以模組資料夾路徑為準）。`,
      "完成後 commit + push，等待部署。",
    ],
    command: `npm run module:install -- ../${moduleId}`,
    note: "手動安裝同樣會走掃描器與 lint 驗證鏈。",
  };
}

export default function ModuleMarketPage() {
  const router = useRouter();
  const [modules, setModules] = useState<MarketModuleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [installKind, setInstallKind] = useState<"success" | "error" | null>(null);
  const [installCommitUrl, setInstallCommitUrl] = useState<string | null>(null);
  const [installBranch, setInstallBranch] = useState<string | null>(null);
  const [manualInstallGuide, setManualInstallGuide] = useState<InstallResponse["manualInstallGuide"] | null>(null);
  const [installedModules, setInstalledModules] = useState<Record<string, string>>({});
  const [canAutoInstall, setCanAutoInstall] = useState(false);
  const [canUninstall, setCanUninstall] = useState(false);
  const [uploadArchive, setUploadArchive] = useState<File | null>(null);
  const [uploadModuleId, setUploadModuleId] = useState("");
  const [uploadingArchive, setUploadingArchive] = useState(false);
  const [marketUrlInput, setMarketUrlInput] = useState("");
  const [savingMarketUrl, setSavingMarketUrl] = useState(false);
  const [marketUrlMessage, setMarketUrlMessage] = useState<string | null>(null);
  const [marketUrlKind, setMarketUrlKind] = useState<"success" | "error" | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<MarketModuleEntry | null>(null);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const hasLegacyPagesMarketUrl = marketUrlInput.trim() === LEGACY_PAGES_MARKET_INDEX_URL;
  const alwaysVisibleGuide = manualInstallGuide ?? buildFallbackManualGuide(uploadModuleId || "examRegistration");

  async function fetchMarket(signal?: AbortSignal): Promise<MarketResponse> {
    const response = await fetch("/api/admin/feature-modules/market", { cache: "no-store", signal });
    const data: MarketResponse = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.message || "市集讀取失敗");
    }
    return data;
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const data = await fetchMarket(controller.signal);

        if (!cancelled) {
          setModules(data.modules ?? []);
          setMarketUrlInput(data.marketUrl ?? "");
          setInstalledModules(data.installedModules ?? {});
          setCanAutoInstall(Boolean(data.canAutoInstall ?? data.canUninstall));
          setCanUninstall(Boolean(data.canUninstall));
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "市集讀取失敗");
          setModules([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!installMessage) return;
    const timer = window.setTimeout(() => setInstallMessage(null), 2000);
    return () => window.clearTimeout(timer);
  }, [installMessage]);

  function installedVersion(module: MarketModuleEntry): string | null {
    return installedModules[module.id] ?? null;
  }

  function isInstalled(module: MarketModuleEntry): boolean {
    return !!installedVersion(module);
  }

  function hasUpdate(module: MarketModuleEntry): boolean {
    const installed = installedVersion(module);
    if (!installed) return false;
    const latest = module.latestVersion || module.version;
    return installed !== latest;
  }

  function applyInstallResult(moduleId: string, version?: string) {
    if (!moduleId) return;
    setInstalledModules((prev) => ({
      ...prev,
      [moduleId]: version || prev[moduleId] || "",
    }));
  }

  async function handleInstall(module: MarketModuleEntry) {
    if (!module.downloadUrl) {
      setInstallKind("error");
      setInstallMessage("該模組沒有可安裝來源，請先提供 downloadUrl");
      return;
    }

    setInstallingId(module.id);
    setInstallKind(null);
    setInstallMessage(null);
    setInstallCommitUrl(null);
    setInstallBranch(null);
    setManualInstallGuide(null);

    try {
      const response = await fetch("/api/admin/feature-modules/market/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: module.id,
          downloadUrl: module.downloadUrl,
          checksumSha256: module.checksumSha256,
          signature: module.signature,
          publicKey: module.publicKey,
        }),
      });

      const data: InstallResponse = await response.json();
      if (!response.ok || !data.success) {
        setInstallKind("error");
        setInstallMessage(data.message || "安裝失敗");
        setInstallCommitUrl(null);
        setInstallBranch(null);
        setManualInstallGuide(data.manualInstallGuide ?? buildFallbackManualGuide(module.id));
        setInstallingId(null);
        return;
      }

      setInstallKind("success");
      setInstallMessage(data.message || "安裝成功");
      setInstallCommitUrl(data.commitUrl ?? null);
      setInstallBranch(data.branch ?? null);
      setManualInstallGuide(null);
      applyInstallResult(data.moduleId || module.id, data.installedVersion || module.latestVersion || module.version);
      setInstallingId(null);
    } catch (installError) {
      setInstallKind("error");
      setInstallMessage(
        installError instanceof Error ? installError.message : "模組安裝失敗"
      );
      setInstallCommitUrl(null);
      setInstallBranch(null);
      setManualInstallGuide(buildFallbackManualGuide(module.id));
      setInstallingId(null);
    }
  }

  async function handleUploadInstall() {
    if (!uploadArchive) {
      setInstallKind("error");
      setInstallMessage("請先選擇模組壓縮檔（.zip 或 .tar.gz）");
      setManualInstallGuide(buildFallbackManualGuide(uploadModuleId || "examRegistration"));
      return;
    }

    setUploadingArchive(true);
    setInstallKind(null);
    setInstallMessage(null);
    setInstallCommitUrl(null);
    setInstallBranch(null);
    setManualInstallGuide(null);

    try {
      const payload = new FormData();
      payload.append("archive", uploadArchive);
      if (uploadModuleId.trim()) payload.append("id", uploadModuleId.trim());

      const response = await fetch("/api/admin/feature-modules/market/install", {
        method: "POST",
        body: payload,
      });
      const data: InstallResponse = await response.json();
      if (!response.ok || !data.success) {
        setInstallKind("error");
        setInstallMessage(data.message || "上傳安裝失敗");
        setInstallCommitUrl(null);
        setInstallBranch(null);
        setManualInstallGuide(data.manualInstallGuide ?? buildFallbackManualGuide(uploadModuleId || "examRegistration"));
        setUploadingArchive(false);
        return;
      }

      setInstallKind("success");
      setInstallMessage(data.message || "上傳安裝成功");
      setInstallCommitUrl(data.commitUrl ?? null);
      setInstallBranch(data.branch ?? null);
      setManualInstallGuide(null);
      applyInstallResult(data.moduleId || uploadModuleId, data.installedVersion);
      setUploadArchive(null);
      setUploadingArchive(false);
    } catch (uploadError) {
      setInstallKind("error");
      setInstallMessage(uploadError instanceof Error ? uploadError.message : "上傳安裝失敗");
      setInstallCommitUrl(null);
      setInstallBranch(null);
      setManualInstallGuide(buildFallbackManualGuide(uploadModuleId || "examRegistration"));
      setUploadingArchive(false);
    }
  }

  function openUninstallModal(module: MarketModuleEntry) {
    setUninstallTarget(module);
    setBackupConfirmed(false);
  }

  function closeUninstallModal() {
    setUninstallTarget(null);
    setBackupConfirmed(false);
  }

  async function handleUninstallConfirmed() {
    if (!uninstallTarget) return;
    const module = uninstallTarget;
    const confirmed = backupConfirmed;
    setInstallingId(module.id);
    setInstallKind(null);
    setInstallMessage(null);
    setInstallCommitUrl(null);
    setInstallBranch(null);
    closeUninstallModal();

    try {
      const response = await fetch("/api/admin/feature-modules", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: module.id, confirmedBackup: confirmed }),
      });
      const data: ToggleInstallResponse = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "卸載失敗");
      }
      setInstallKind("success");
      setInstallMessage(data.message || "卸載成功");
      setInstallCommitUrl(data.commitUrl ?? null);
      setInstallBranch(data.branch ?? null);
      setManualInstallGuide(null);
      setInstalledModules((prev) => {
        const next = { ...prev };
        delete next[module.id];
        return next;
      });
      setInstallingId(null);
    } catch (uninstallError) {
      setInstallKind("error");
      setInstallMessage(uninstallError instanceof Error ? uninstallError.message : "卸載失敗");
      setManualInstallGuide(null);
      setInstallingId(null);
    }
  }

  async function handleSaveMarketUrl() {
    setSavingMarketUrl(true);
    setMarketUrlKind(null);
    setMarketUrlMessage(null);
    try {
      const response = await fetch("/api/admin/feature-modules/market", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketUrl: marketUrlInput.trim() }),
      });
      const data: MarketConfigResponse = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || "儲存模組市集來源失敗");
      }
      setMarketUrlKind("success");
      setMarketUrlMessage(data.message || "模組市集來源已儲存");
      setMarketUrlInput(data.marketUrl ?? "");
      setLoading(true);
      setError(null);
      const refreshedData = await fetchMarket();
      setModules(refreshedData.modules ?? []);
      setMarketUrlInput(refreshedData.marketUrl ?? "");
      setInstalledModules(refreshedData.installedModules ?? {});
      setCanAutoInstall(Boolean(refreshedData.canAutoInstall ?? refreshedData.canUninstall));
      setCanUninstall(Boolean(refreshedData.canUninstall));
    } catch (saveError) {
      setMarketUrlKind("error");
      setMarketUrlMessage(saveError instanceof Error ? saveError.message : "儲存模組市集來源失敗");
    } finally {
      setSavingMarketUrl(false);
      setLoading(false);
    }
  }

  async function copyDefaultMarketUrl() {
    try {
      await navigator.clipboard.writeText(DEFAULT_MARKET_INDEX_URL);
      setMarketUrlKind("success");
      setMarketUrlMessage("Raw GitHub 市集來源 URL 已複製");
    } catch {
      setMarketUrlKind("error");
      setMarketUrlMessage("無法存取剪貼簿，請手動複製上方網址");
    }
  }

  return (
    <div className="content-width space-y-6">
      {installMessage && (
        <div
          role={installKind === "error" ? "alert" : "status"}
          aria-live={installKind === "error" ? "assertive" : "polite"}
          className={`fixed bottom-4 left-1/2 z-40 w-[min(92vw,64rem)] -translate-x-1/2 rounded-lg border p-3 text-sm shadow-lg ${
            installKind === "success"
              ? "border-success/60 bg-card text-success"
              : "border-danger/60 bg-card text-danger"
          }`}
        >
          <p className="break-words">{installMessage}</p>
          {(installCommitUrl || installBranch) && (
            <div className="mt-2 text-xs">
              {installBranch && <p>分支：{installBranch}</p>}
              {installCommitUrl && (
                <a
                  href={installCommitUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  查看提交紀錄
                </a>
              )}
            </div>
          )}
        </div>
      )}
      {uninstallTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <button
            type="button"
            onClick={closeUninstallModal}
            className="absolute inset-0 bg-black/40"
            aria-label="關閉卸載確認視窗"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="uninstall-modal-title"
            className="relative z-10 w-full max-w-lg rounded-xl border border-danger/50 bg-card p-5 shadow-xl"
          >
            <h2 id="uninstall-modal-title" className="text-lg font-bold text-danger">
              確認卸載模組
            </h2>
            <div className="mt-3 space-y-2 text-sm text-t2">
              <p>
                你即將卸載「{uninstallTarget.name}」。此動作會從程式碼移除模組並提交部署，入口將消失。
              </p>
              <p className="rounded border border-warning/60 bg-warning/10 px-3 py-2 text-warning">
                ⚠ 警告：請先備份與本模組關聯的資料（例如 Firestore 集合、匯出檔案）。
                卸載流程預設不會自動刪除資料，但後續人工清理若操作錯誤可能造成不可逆損失。
              </p>
            </div>
            <label className="mt-4 flex items-start gap-2 text-sm text-t1">
              <input
                type="checkbox"
                checked={backupConfirmed}
                onChange={(event) => setBackupConfirmed(event.target.checked)}
                className="mt-0.5 accent-current"
              />
              我已完成資料備份，並理解卸載後需重新部署才會生效。
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeUninstallModal}
                className="rounded border border-themed px-3 py-2 text-xs text-t2 hover:text-t1 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!backupConfirmed || installingId === uninstallTarget.id}
                onClick={() => void handleUninstallConfirmed()}
                className={`rounded px-3 py-2 text-xs ${
                  !backupConfirmed || installingId === uninstallTarget.id
                    ? "border border-themed bg-muted text-t3 cursor-not-allowed"
                    : "border border-danger/60 bg-danger/10 text-danger cursor-pointer"
                }`}
              >
                確認卸載
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-t1">模組市集</h1>
          <p className="text-sm text-t3">市集只提供模組資訊，實際安裝與更新仍由主程式管理。</p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/admin/modules")}
          className="btn-theme rounded px-4 py-2 text-sm cursor-pointer"
        >
          返回功能模組管理
        </button>
      </div>

      <div className="space-y-4">
        <details className="group border border-themed rounded-lg bg-card p-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-t1">全自動一鍵安裝</h2>
            <div className="flex items-center gap-2">
              <span
                className={`inline-block rounded border px-2 py-1 text-xs ${
                  canAutoInstall
                    ? "border-success/60 bg-success/10 text-success"
                    : "border-warning/60 bg-warning/10 text-warning"
                }`}
              >
                {canAutoInstall ? "目前可用" : "尚未完成參數設定"}
              </span>
              <DisclosureArrow />
            </div>
          </summary>

          <div className="mt-3 space-y-3">
            <p className="text-xs text-t2">
              直接使用模組卡片的「安裝／更新」按鈕。正式環境需設定 `MODULE_MARKET_GITHUB_TOKEN` 與 repo 來源參數。
            </p>

          <div className="pt-2 border-t border-themed space-y-2">
            <h3 className="text-xs font-semibold text-t1">模組市集來源設定</h3>
            <p className="text-xs text-t2">
              可在此設定 index.json URL；留空代表回退環境變數（MODULE_MARKET_INDEX_URL）。建議使用與模組下載網址同網域的 Raw GitHub 來源：
            </p>
            <div className="flex flex-col md:flex-row md:items-center gap-2 text-xs">
              <code className="text-t1 break-all">{DEFAULT_MARKET_INDEX_URL}</code>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void copyDefaultMarketUrl()}
                  className="border border-themed rounded px-2.5 py-1.5 text-t2 hover:text-t1 cursor-pointer"
                >
                  複製 URL
                </button>
                <a
                  href={MARKETPLACE_REPOSITORY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:opacity-80"
                >
                  GitHub Repo ↗
                </a>
              </div>
            </div>
            {hasLegacyPagesMarketUrl && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded border border-warning/60 bg-warning/10 px-3 py-2 text-xs text-warning">
                <p>
                  目前設定的 Pages 網址與模組下載網址網域不同，安裝會被安全檢查拒絕。請改用 Raw GitHub URL 並儲存。
                </p>
                <button
                  type="button"
                  onClick={() => setMarketUrlInput(DEFAULT_MARKET_INDEX_URL)}
                  className="shrink-0 rounded border border-warning/60 px-2.5 py-1.5 font-medium hover:bg-warning/10 cursor-pointer"
                >
                  改用 Raw URL
                </button>
              </div>
            )}
            <div className="flex flex-col md:flex-row gap-2">
              <input
                value={marketUrlInput}
                onChange={(event) => setMarketUrlInput(event.target.value)}
                placeholder="https://example.com/index.json"
                className="flex-1 rounded border border-themed bg-card px-3 py-2 text-sm text-t1"
              />
              <button
                type="button"
                onClick={() => void handleSaveMarketUrl()}
                disabled={savingMarketUrl}
                className={`rounded px-3 py-2 text-xs ${
                  savingMarketUrl ? "border border-themed bg-muted text-t3 cursor-wait" : "btn-theme cursor-pointer"
                }`}
              >
                {savingMarketUrl ? "儲存中..." : "儲存市集來源"}
              </button>
            </div>
            {marketUrlMessage && (
              <div
                className={`rounded border px-3 py-2 text-xs ${
                  marketUrlKind === "success"
                    ? "border-success/60 bg-success/10 text-success"
                    : "border-danger/60 bg-danger/10 text-danger"
                }`}
              >
                {marketUrlMessage}
              </div>
            )}
          </div>

            <div className="pt-2 border-t border-themed">
            {loading ? (
              <div className="border border-themed rounded-lg bg-card p-4 text-xs text-t3">
                讀取模組市集中...
              </div>
            ) : error ? (
              <div className="border border-danger/60 rounded-lg bg-card p-4 text-xs text-t2">
                <p className="font-medium text-danger">市集讀取失敗</p>
                <p className="mt-1">{error}</p>
              </div>
            ) : modules.length === 0 ? (
              <div className="border border-themed rounded-lg bg-card p-4 text-xs text-t3">
                目前沒有可用的模組，請稍後再試。
              </div>
            ) : (
              <div className="grid gap-4 items-start md:grid-cols-2">
                {/* 卡片高度各自內容決定（items-start）：展開一張不拉伸同行另一張 */}
                {modules.map((module) => (
                  <details key={module.id} className="group border border-themed rounded-lg bg-card p-5">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-bold text-t1">{module.name}</h2>
                        <p className="text-xs text-t3">{module.id}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {module.status && (
                          <span
                            className={`text-xs border rounded px-2 py-1 ${MODULE_STATUS_META[module.status].className}`}
                          >
                            {MODULE_STATUS_META[module.status].label}
                          </span>
                        )}
                        <span className="text-xs border border-themed rounded px-2 py-1 text-t2">
                          v{module.version}
                        </span>
                        <DisclosureArrow />
                      </div>
                    </summary>

                    <div className="mt-3 space-y-3">
                      {module.status === "experimental" && (
                        <p className="rounded border border-warning/60 bg-warning/10 px-3 py-2 text-xs text-warning">
                          實驗模組：未經審核，不建議在正式環境安裝。若仍要測試，請先備份資料並自行承擔風險。
                        </p>
                      )}
                      {module.releaseNotes && module.releaseNotes.length > 0 ? (
                        <div className="text-sm text-t2">
                          <p className="font-medium text-t1">v{module.version} 更新</p>
                          <ul className="mt-1 list-disc space-y-1 pl-5">
                            {module.releaseNotes.map((note, index) => (
                              <li key={`${module.id}-release-note-${index}`}>{note}</li>
                            ))}
                          </ul>
                          {module.description && (
                            <details className="mt-2 text-xs text-t3">
                              <summary className="flex cursor-pointer list-none items-center gap-1">
                                <DisclosureArrow />
                                模組介紹
                              </summary>
                              <p className="mt-2 text-sm text-t2 whitespace-pre-line leading-relaxed">
                                {module.description}
                              </p>
                            </details>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-t2">{module.description || "沒有說明"}</p>
                      )}

                      <div className="flex flex-wrap gap-2 text-xs text-t3">
                        {module.minHostVersion && (
                          <span className="border border-themed rounded px-2 py-1">
                            最低主程式版本：{module.minHostVersion}
                          </span>
                        )}
                        {isInstalled(module) && (
                          <span className="border border-success/60 rounded px-2 py-1 text-success">
                            {hasUpdate(module) ? "已安裝（可更新）" : "已安裝"}
                          </span>
                        )}
                        {module.category && (
                          <span className="border border-themed rounded px-2 py-1">
                            類別：{module.category}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-3 pt-2 border-t border-themed">
                        <div className="text-xs text-t3">
                          {module.latestVersion && module.latestVersion !== module.version
                            ? `最新：${module.latestVersion}`
                            : "已為最新版本"}
                        </div>
                        <div className="flex gap-2">
                          {module.repoUrl && (
                            <a
                              href={module.repoUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="btn-theme rounded px-3 py-1.5 text-xs"
                            >
                              查看 Repo
                            </a>
                          )}
                          <button
                            type="button"
                            disabled={installingId === module.id || (isInstalled(module) && !hasUpdate(module))}
                            onClick={() => void handleInstall(module)}
                            className={`rounded px-3 py-1.5 text-xs ${
                              installingId === module.id || (isInstalled(module) && !hasUpdate(module))
                                ? "border border-themed bg-muted text-t3 cursor-wait"
                                : module.status === "experimental"
                                  ? "btn-danger cursor-pointer"
                                  : "btn-theme cursor-pointer"
                            }`}
                            title={
                              installingId === module.id
                                ? "處理中..."
                                : isInstalled(module) && !hasUpdate(module)
                                  ? "已安裝"
                                  : module.status === "experimental"
                                    ? "實驗模組：未經審核，不建議在正式環境安裝"
                                    : "安裝模組"
                            }
                          >
                            {installingId === module.id
                              ? "處理中..."
                              : isInstalled(module) && !hasUpdate(module)
                                ? "已安裝"
                                : hasUpdate(module)
                                  ? "更新"
                                  : module.status === "experimental"
                                    ? "仍要安裝"
                                    : "安裝"}
                          </button>
                          {canUninstall && isInstalled(module) && (
                            <button
                              type="button"
                              disabled={installingId === module.id}
                              onClick={() => openUninstallModal(module)}
                              className={`rounded px-3 py-1.5 text-xs ${
                                installingId === module.id
                                  ? "border border-themed bg-muted text-t3 cursor-wait"
                                  : "border border-danger/60 text-danger cursor-pointer"
                              }`}
                              title={installingId === module.id ? "處理中..." : "卸載模組"}
                            >
                              卸載
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
            </div>
          </div>
        </details>

        <details className="group border border-themed rounded-lg bg-card p-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-t1">半自動上傳安裝</h2>
            <DisclosureArrow />
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs text-t2">
              上傳模組壓縮檔（.zip / .tar.gz）後由系統驗證並安裝。可選填模組代碼，不填則以 module.json 的 value 為準。
            </p>
            <input
              value={uploadModuleId}
              onChange={(event) => setUploadModuleId(event.target.value)}
              placeholder="模組代碼（選填，例如 examRegistration）"
              className="w-full rounded border border-themed bg-card px-3 py-2 text-xs text-t1"
            />
            <input
              type="file"
              accept=".zip,.tar.gz,application/zip,application/gzip"
              onChange={(event) => setUploadArchive(event.target.files?.[0] ?? null)}
              className="w-full text-xs text-t2 file:mr-3 file:rounded file:border file:border-themed file:bg-card file:px-2 file:py-1 file:text-xs file:text-t1"
            />
            <button
              type="button"
              disabled={uploadingArchive}
              onClick={() => void handleUploadInstall()}
              className={`rounded px-3 py-2 text-xs ${
                uploadingArchive ? "border border-themed bg-muted text-t3 cursor-wait" : "btn-theme cursor-pointer"
              }`}
            >
              {uploadingArchive ? "上傳安裝中..." : "上傳並安裝"}
            </button>
          </div>
        </details>

        <details className="group border border-themed rounded-lg bg-card p-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-t1">手動安裝</h2>
            <DisclosureArrow />
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs text-t2">
              不論一鍵安裝或上傳安裝是否可用，都可改走以下手動流程。更新同模組版本時，請先卸載再安裝新版。
            </p>
            {alwaysVisibleGuide.title && <p className="text-xs font-medium text-t1">{alwaysVisibleGuide.title}</p>}
            {Array.isArray(alwaysVisibleGuide.steps) && alwaysVisibleGuide.steps.length > 0 && (
              <ol className="list-decimal pl-4 space-y-1 text-xs text-t2">
                {alwaysVisibleGuide.steps.map((step, index) => (
                  <li key={`${index}-${step}`}>{step}</li>
                ))}
              </ol>
            )}
            {alwaysVisibleGuide.command && (
              <pre className="overflow-x-auto rounded border border-themed bg-card px-2 py-1 text-xs text-t1">
{alwaysVisibleGuide.command}
              </pre>
            )}
            {alwaysVisibleGuide.note && <p className="text-xs text-t2">{alwaysVisibleGuide.note}</p>}
          </div>
        </details>
      </div>

    </div>
  );
}
