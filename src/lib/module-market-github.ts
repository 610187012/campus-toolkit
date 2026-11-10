import fs from "node:fs";
import path from "node:path";
import { findLockTreeMismatch, nextHostVersion } from "@/lib/module-install-verify";
import { hashModuleTree } from "@/lib/module-tree-hash";

const GITHUB_API = "https://api.github.com";
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface ModuleLockEntry {
  value: string;
  version: string;
  contractVersion: number;
  minHostVersion: string;
  sha256: string;
  /** 解壓後目錄雜湊；lock-only build 用來判斷是否需要重新下載 */
  treeSha256?: string;
  source: string;
  installedAt: string;
  signature?: string;
  publicKey?: string;
}

interface ModuleLockFile {
  lockVersion: number;
  modules: ModuleLockEntry[];
}

export interface ModuleMarketGithubConfig {
  token: string;
  repo: string;
}

/** 【E13/5b】查詢分支最新 commit 的部署狀態（GitHub combined status；Vercel webhook 建立） */
export async function getBranchDeployStatus(
  branch: string
): Promise<{ state: "pending" | "success" | "failure" | "unknown"; description: string; targetUrl?: string }> {
  const config = resolveModuleMarketGithubConfig();
  if (!config) return { state: "unknown", description: "未設定 GitHub token，無法查詢部署狀態" };
  const { token, repo } = config;
  const [owner, repoName] = repo.split("/");
  try {
    const status = await githubRequest(
      token,
      `/repos/${owner}/${repoName}/commits/${encodeURIComponent(branch)}/status`
    );
    const state = typeof status?.state === "string" ? status.state : "";
    const description = typeof status?.description === "string" ? status.description : "";
    const statuses = Array.isArray(status?.statuses) ? (status!.statuses as Array<Record<string, unknown>>) : [];
    const firstTarget = statuses[0]?.target_url;
    const targetUrl = typeof firstTarget === "string" ? firstTarget : undefined;
    if (state === "success") return { state: "success", description: description || "部署完成", targetUrl };
    if (state === "failure" || state === "error") return { state: "failure", description: description || "部署失敗", targetUrl };
    if (state === "pending") return { state: "pending", description: description || "部署中", targetUrl };
    return { state: "unknown", description: description || "查無部署狀態", targetUrl };
  } catch (e) {
    return { state: "unknown", description: e instanceof Error ? e.message : "查詢部署狀態失敗" };
  }
}

export interface CommitMarketplaceInstallInput {
  moduleId: string;
  moduleDir: string;
  sourceRef: string;
  archiveSha256: string;
  manifestVersion: string;
  contractVersion: number;
  minHostVersion: string;
  signature?: string;
  publicKey?: string;
}

export interface CommitMarketplaceUninstallInput {
  moduleId: string;
}

interface CommitMarketplaceInstallResult {
  alreadyInstalled: boolean;
  updated: boolean;
  branch: string;
  commitUrl?: string;
  commitSha?: string;
}

export function resolveModuleMarketGithubConfig(): ModuleMarketGithubConfig | null {
  const token = process.env.MODULE_MARKET_GITHUB_TOKEN?.trim();
  if (!token) return null;

  const owner = process.env.VERCEL_GIT_REPO_OWNER?.trim();
  const slug = process.env.VERCEL_GIT_REPO_SLUG?.trim();
  const derivedRepo = owner && slug ? `${owner}/${slug}` : "";
  const repo = process.env.MODULE_MARKET_GITHUB_REPO?.trim() || derivedRepo;

  if (!repo || !REPO_PATTERN.test(repo)) return null;
  return { token, repo };
}

async function githubRequest(
  token: string,
  apiPath: string,
  init: { method?: string; body?: unknown; allow404?: boolean } = {}
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${GITHUB_API}${apiPath}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  if (response.status === 404 && init.allow404) return null;
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`GitHub API 失敗（HTTP ${response.status}）：${detail}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

function readModuleFiles(moduleDir: string): Array<{ path: string; contentBase64: string }> {
  const files: Array<{ path: string; contentBase64: string }> = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".next") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(moduleDir, fullPath).split(path.sep).join("/");
      files.push({
        path: rel,
        contentBase64: fs.readFileSync(fullPath).toString("base64"),
      });
    }
  };
  walk(moduleDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function parseLockFile(raw: string): ModuleLockFile {
  const parsed = JSON.parse(raw) as { lockVersion?: unknown; modules?: unknown };
  const modules = Array.isArray(parsed.modules) ? parsed.modules : [];
  return {
    lockVersion: typeof parsed.lockVersion === "number" && Number.isFinite(parsed.lockVersion) ? parsed.lockVersion : 1,
    modules: modules.filter((item): item is ModuleLockEntry => {
      return !!item && typeof item === "object" && typeof (item as { value?: unknown }).value === "string";
    }),
  };
}

async function readRemoteLockFile(
  token: string,
  repoBase: string,
  ref: string
): Promise<{ sha: string; lock: ModuleLockFile } | null> {
  const lockContent = await githubRequest(
    token,
    `${repoBase}/contents/${encodeURIComponent("module.lock.json")}?ref=${encodeURIComponent(ref)}`,
    { allow404: true }
  );
  if (!lockContent) return null;

  const encoded = typeof lockContent.content === "string" ? lockContent.content : "";
  const fileSha = typeof lockContent.sha === "string" ? lockContent.sha : "";
  if (!encoded || !fileSha) {
    throw new Error("讀取 module.lock.json 失敗（內容或 SHA 缺失）");
  }

  const decoded = Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf-8");
  return { sha: fileSha, lock: parseLockFile(decoded) };
}

/** 讀取遠端文字檔（Contents API）；不存在回 null */
async function readRemoteTextFile(
  token: string,
  repoBase: string,
  filePath: string,
  ref: string
): Promise<string | null> {
  const file = await githubRequest(
    token,
    `${repoBase}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
    { allow404: true }
  );
  if (!file) return null;
  const encoded = typeof file.content === "string" ? file.content : "";
  if (!encoded) throw new Error(`讀取 ${filePath} 失敗（內容缺失）`);
  return Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf-8");
}

/**
 * 產生 `src/version.json` 的 tree entry（P0-5）。
 * production 安裝／卸載都要留下版本足跡；遠端版本檔缺失或格式不符時 fail-closed。
 */
async function createVersionTreeEntry(
  token: string,
  repoBase: string,
  ref: string
): Promise<Record<string, unknown>> {
  const raw = await readRemoteTextFile(token, repoBase, "src/version.json", ref);
  if (raw === null) {
    throw new Error("遠端缺少 src/version.json，拒絕在未更新版本號的情況下變更模組");
  }
  const next = nextHostVersion(raw, new Date().toISOString().slice(0, 10));
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  const blob = await githubRequest(token, `${repoBase}/git/blobs`, {
    method: "POST",
    body: {
      content: Buffer.from(
        `${JSON.stringify(next, null, 2)}${trailingNewline}`,
        "utf-8"
      ).toString("base64"),
      encoding: "base64",
    },
  });
  if (!blob?.sha) {
    throw new Error("建立 src/version.json blob 失敗");
  }
  return {
    path: "src/version.json",
    mode: "100644",
    type: "blob",
    sha: blob.sha,
  };
}

export async function commitMarketplaceModuleInstall(
  input: CommitMarketplaceInstallInput
): Promise<CommitMarketplaceInstallResult> {
  const config = resolveModuleMarketGithubConfig();
  if (!config) {
    throw new Error(
      "尚未設定 MODULE_MARKET_GITHUB_TOKEN（或 MODULE_MARKET_GITHUB_REPO / VERCEL_GIT_REPO_OWNER+SLUG）——無法在正式環境自動安裝"
    );
  }

  const { token, repo } = config;
  const [owner, repoName] = repo.split("/");
  const repoBase = `/repos/${owner}/${repoName}`;

  const repoInfo = await githubRequest(token, repoBase);
  const baseBranch = typeof repoInfo?.default_branch === "string" ? repoInfo.default_branch : "main";

  const baseRef = await githubRequest(
    token,
    `${repoBase}/git/ref/heads/${encodeURIComponent(baseBranch)}`
  );
  const baseSha = (baseRef?.object as { sha?: string } | undefined)?.sha;
  if (!baseSha) {
    throw new Error("無法取得目標 repo 基準分支位置");
  }

  const baseCommit = await githubRequest(token, `${repoBase}/git/commits/${baseSha}`);
  const baseTreeSha = (baseCommit?.tree as { sha?: string } | undefined)?.sha;
  if (!baseTreeSha) {
    throw new Error("無法取得目標 repo 基準 tree");
  }

  const lockRecord = await readRemoteLockFile(token, repoBase, baseBranch);
  const lock = lockRecord?.lock ?? { lockVersion: 1, modules: [] };
  /** 變更前的遠端 lock 值，僅供 legacy 檔案安裝的 lock ↔ 目錄一致性檢查 */
  const remoteLockValues = lock.modules.map((item) => item.value);
  const sourceTag = input.sourceRef;
  const lockOnly = sourceTag.startsWith("market:");
  const existingIndex = lock.modules.findIndex((item) => item.value === input.moduleId);
  const existing = existingIndex >= 0 ? lock.modules[existingIndex] : null;
  const treeSha256 = hashModuleTree(input.moduleDir);
  const nextEntry: ModuleLockEntry = {
    value: input.moduleId,
    version: input.manifestVersion,
    contractVersion: input.contractVersion,
    minHostVersion: input.minHostVersion,
    sha256: input.archiveSha256,
    treeSha256,
    source: sourceTag,
    installedAt: new Date().toISOString().slice(0, 10),
    ...(input.signature ? { signature: input.signature } : {}),
    ...(input.publicKey ? { publicKey: input.publicKey } : {}),
  };

  if (
    existing &&
    existing.version === nextEntry.version &&
    existing.contractVersion === nextEntry.contractVersion &&
    existing.minHostVersion === nextEntry.minHostVersion &&
    existing.sha256 === nextEntry.sha256 &&
    existing.treeSha256 === nextEntry.treeSha256 &&
    existing.source === nextEntry.source
  ) {
    return { alreadyInstalled: true, updated: false, branch: baseBranch };
  }

  if (existingIndex >= 0) {
    lock.modules[existingIndex] = nextEntry;
  } else {
    lock.modules.push(nextEntry);
  }

  const treePayload = await githubRequest(
    token,
    `${repoBase}/git/trees/${encodeURIComponent(baseTreeSha)}?recursive=1`
  );
  const treeItems = Array.isArray(treePayload?.tree)
    ? (treePayload.tree as Array<{ path?: unknown; type?: unknown }>)
    : [];
  const treePaths = treeItems
    .filter((item) => item && item.type === "blob" && typeof item.path === "string")
    .map((item) => String(item.path));

  const targetPrefix = `src/modules/${input.moduleId}/`;
  const existingModuleFiles = treePaths.filter((pathValue) =>
    pathValue.startsWith(targetPrefix)
  );
  const treeEntries: Array<Record<string, unknown>> = [];

  if (lockOnly) {
    // P1-10：市集安裝只留下 lock；同時清掉舊版 commit 進 repo 的模組檔案。
    // 下一次 build 會由 scripts/materialize-modules.mjs 依 lock 下載並驗章。
    for (const stalePath of existingModuleFiles) {
      treeEntries.push({
        path: stalePath,
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }
  } else {
    const mismatch = findLockTreeMismatch(remoteLockValues, treePaths);
    if (mismatch) {
      const detail = [
        mismatch.missingDirs.length > 0
          ? `lock 有登記但沒有資料夾：${mismatch.missingDirs.join("、")}`
          : "",
        mismatch.missingLock.length > 0
          ? `有資料夾但 lock 沒登記：${mismatch.missingLock.join("、")}`
          : "",
      ]
        .filter(Boolean)
        .join("；");
      throw new Error(
        `module.lock.json 與 src/modules 目錄不一致（${detail}）——請先修正遠端 repo 後再安裝`
      );
    }

    const moduleFiles = readModuleFiles(input.moduleDir);
    if (moduleFiles.length === 0) {
      throw new Error("模組來源資料夾沒有可提交檔案");
    }

    const incomingModulePaths = new Set(
      moduleFiles.map((file) => `src/modules/${input.moduleId}/${file.path}`)
    );
    for (const stalePath of existingModuleFiles) {
      if (!incomingModulePaths.has(stalePath)) {
        treeEntries.push({
          path: stalePath,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }
    }

    for (const file of moduleFiles) {
      const blob = await githubRequest(token, `${repoBase}/git/blobs`, {
        method: "POST",
        body: { content: file.contentBase64, encoding: "base64" },
      });
      if (!blob?.sha) {
        throw new Error(`建立 blob 失敗：${file.path}`);
      }
      treeEntries.push({
        path: `src/modules/${input.moduleId}/${file.path}`,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
  }

  const lockBlob = await githubRequest(token, `${repoBase}/git/blobs`, {
    method: "POST",
    body: { content: Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf-8").toString("base64"), encoding: "base64" },
  });
  if (!lockBlob?.sha) {
    throw new Error("建立 module.lock.json blob 失敗");
  }
  treeEntries.push({
    path: "module.lock.json",
    mode: "100644",
    type: "blob",
    sha: lockBlob.sha,
  });
  if (!lockOnly) {
    // legacy 檔案安裝才需要版本足跡；lock-only 不碰版本號，避免同步衝突
    treeEntries.push(await createVersionTreeEntry(token, repoBase, baseBranch));
  }

  const tree = await githubRequest(token, `${repoBase}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSha, tree: treeEntries },
  });
  if (!tree?.sha) {
    throw new Error("建立 tree 失敗");
  }

  const commit = await githubRequest(token, `${repoBase}/git/commits`, {
    method: "POST",
    body: {
      message: `${existing ? "update" : "install"}(module): ${input.moduleId} v${input.manifestVersion}`,
      tree: tree.sha,
      parents: [baseSha],
    },
  });
  if (!commit?.sha) {
    throw new Error("建立 commit 失敗");
  }

  await githubRequest(token, `${repoBase}/git/refs/heads/${encodeURIComponent(baseBranch)}`, {
    method: "PATCH",
    body: { sha: commit.sha, force: false },
  });

  return {
    alreadyInstalled: false,
    updated: !!existing,
    branch: baseBranch,
    commitSha: String(commit.sha),
    commitUrl: `https://github.com/${repo}/commit/${String(commit.sha)}`,
  };
}

export async function commitMarketplaceModuleUninstall(
  input: CommitMarketplaceUninstallInput
): Promise<{ alreadyUninstalled: boolean; branch: string; commitUrl?: string; commitSha?: string }> {
  const config = resolveModuleMarketGithubConfig();
  if (!config) {
    throw new Error(
      "尚未設定 MODULE_MARKET_GITHUB_TOKEN（或 MODULE_MARKET_GITHUB_REPO / VERCEL_GIT_REPO_OWNER+SLUG）——無法在正式環境自動卸載"
    );
  }

  const { token, repo } = config;
  const [owner, repoName] = repo.split("/");
  const repoBase = `/repos/${owner}/${repoName}`;

  const repoInfo = await githubRequest(token, repoBase);
  const baseBranch = typeof repoInfo?.default_branch === "string" ? repoInfo.default_branch : "main";

  const baseRef = await githubRequest(
    token,
    `${repoBase}/git/ref/heads/${encodeURIComponent(baseBranch)}`
  );
  const baseSha = (baseRef?.object as { sha?: string } | undefined)?.sha;
  if (!baseSha) {
    throw new Error("無法取得目標 repo 基準分支位置");
  }

  const baseCommit = await githubRequest(token, `${repoBase}/git/commits/${baseSha}`);
  const baseTreeSha = (baseCommit?.tree as { sha?: string } | undefined)?.sha;
  if (!baseTreeSha) {
    throw new Error("無法取得目標 repo 基準 tree");
  }

  const lockRecord = await readRemoteLockFile(token, repoBase, baseBranch);
  const lock = lockRecord?.lock ?? { lockVersion: 1, modules: [] };
  const hadModule = lock.modules.some((item) => item.value === input.moduleId);
  lock.modules = lock.modules.filter((item) => item.value !== input.moduleId);

  const modulePath = `src/modules/${input.moduleId}`;
  const treePayload = await githubRequest(
    token,
    `${repoBase}/git/trees/${encodeURIComponent(baseTreeSha)}?recursive=1`
  );
  const treeItems = Array.isArray(treePayload?.tree)
    ? (treePayload.tree as Array<{ path?: unknown; type?: unknown }>)
    : [];
  const moduleFiles = treeItems
    .filter((item) => item && item.type === "blob" && typeof item.path === "string")
    .map((item) => String(item.path))
    .filter((pathValue) => pathValue.startsWith(`${modulePath}/`));

  if (!hadModule && moduleFiles.length === 0) {
    return { alreadyUninstalled: true, branch: baseBranch };
  }

  const treeEntries: Array<Record<string, unknown>> = moduleFiles.map((filePath) => ({
    path: filePath,
    mode: "100644",
    type: "blob",
    sha: null,
  }));

  if (lock.modules.length === 0) {
    treeEntries.push({ path: "module.lock.json", mode: "100644", type: "blob", sha: null });
  } else {
    const lockBlob = await githubRequest(token, `${repoBase}/git/blobs`, {
      method: "POST",
      body: { content: Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf-8").toString("base64"), encoding: "base64" },
    });
    if (!lockBlob?.sha) {
      throw new Error("建立 module.lock.json blob 失敗");
    }
    treeEntries.push({
      path: "module.lock.json",
      mode: "100644",
      type: "blob",
      sha: lockBlob.sha,
    });
  }
  const tree = await githubRequest(token, `${repoBase}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSha, tree: treeEntries },
  });
  if (!tree?.sha) {
    throw new Error("建立 tree 失敗");
  }

  const commit = await githubRequest(token, `${repoBase}/git/commits`, {
    method: "POST",
    body: {
      message: `uninstall(module): ${input.moduleId}`,
      tree: tree.sha,
      parents: [baseSha],
    },
  });
  if (!commit?.sha) {
    throw new Error("建立 commit 失敗");
  }

  await githubRequest(token, `${repoBase}/git/refs/heads/${encodeURIComponent(baseBranch)}`, {
    method: "PATCH",
    body: { sha: commit.sha, force: false },
  });

  return {
    alreadyUninstalled: false,
    branch: baseBranch,
    commitSha: String(commit.sha),
    commitUrl: `https://github.com/${repo}/commit/${String(commit.sha)}`,
  };
}
