/**
 * production 安裝鏈的純驗證函式（P0-5）。
 *
 * 本檔刻意保持零依賴（不 import server-only／Node API），
 * 供 `module-market-github.ts` 與測試腳本共用：
 *
 * - `nextHostVersion`：依遠端 `src/version.json` 計算下一個版本號。
 *   主程式版本格式固定為 `0.<build>`；production 沒有完整 git 歷史，
 *   因此採「目前值 +1」的單調遞增策略（永不倒退）。
 * - `findLockTreeMismatch`：比對 `module.lock.json` 與遠端
 *   `src/modules/<value>/` 目錄，確保 lock ↔ 目錄一致。
 */

export interface HostVersionFile {
  version: string;
  date: string;
}

/**
 * 由目前版本檔計算下一個版本（`0.646` → `0.647`）。
 * 格式不符時丟錯——寧可拒絕安裝，也不要在沒有版本號的情況下提交。
 */
export function nextHostVersion(raw: string, today: string): HostVersionFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("src/version.json 不是合法 JSON，拒絕在未更新版本號的情況下安裝");
  }
  const current = parsed as { version?: unknown };
  const version = typeof current.version === "string" ? current.version.trim() : "";
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(
      `src/version.json 的 version「${version || "（空）"}」不是「主.次」格式，拒絕在未更新版本號的情況下安裝`
    );
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    throw new Error("src/version.json 的 version 無法解析，拒絕在未更新版本號的情況下安裝");
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10);
  return { version: `${major}.${minor + 1}`, date };
}

/** 從 GitHub tree 的 blob 路徑取出 `src/modules/<value>` 的模組代碼 */
export function moduleValuesFromTreePaths(treePaths: readonly string[]): string[] {
  const values = new Set<string>();
  for (const item of treePaths) {
    const match = /^src\/modules\/([^/]+)\//.exec(item);
    if (match) values.add(match[1]);
  }
  return [...values].sort();
}

export interface LockTreeMismatch {
  /** lock 有登記，但遠端沒有資料夾 */
  missingDirs: string[];
  /** 遠端有資料夾，但 lock 沒登記 */
  missingLock: string[];
}

/**
 * 比對 lock 與遠端模組目錄。
 * 回傳 null＝一致；否則回傳兩邊差異，供呼叫端拒絕安裝並提示修復。
 */
export function findLockTreeMismatch(
  lockValues: readonly string[],
  treePaths: readonly string[]
): LockTreeMismatch | null {
  const lock = new Set(lockValues);
  const dirs = new Set(moduleValuesFromTreePaths(treePaths));
  const missingDirs = [...lock].filter((value) => !dirs.has(value)).sort();
  const missingLock = [...dirs].filter((value) => !lock.has(value)).sort();
  if (missingDirs.length === 0 && missingLock.length === 0) return null;
  return { missingDirs, missingLock };
}
