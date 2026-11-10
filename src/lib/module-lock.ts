import "server-only";
import fs from "node:fs";
import path from "node:path";

/**
 * 讀取模組 lock（P1-10）。
 *
 * - `module.lock.json`：正式安裝（市集）用，會 commit 進 repo。
 * - `module.lock.local.json`：本機 `module:link`／`module:install` 用，不進 repo。
 *
 * 兩者合併後才是「目前這台機器已安裝的模組」。同名時以 local 為準，
 * 避免學校本機測試的版本被 repo 內的市集版本蓋掉。
 */

export interface ModuleLockEntry {
  value: string;
  version?: string;
  contractVersion?: number;
  minHostVersion?: string;
  sha256?: string;
  treeSha256?: string;
  source?: string;
  installedAt?: string;
  signature?: string;
  publicKey?: string;
}

export const MARKET_LOCK_FILE = "module.lock.json";
export const LOCAL_LOCK_FILE = "module.lock.local.json";

function readEntries(fileName: string): ModuleLockEntry[] {
  const filePath = path.join(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      modules?: unknown;
    };
    const modules = Array.isArray(parsed.modules) ? parsed.modules : [];
    return modules.filter(
      (item): item is ModuleLockEntry =>
        !!item && typeof item === "object" && typeof (item as { value?: unknown }).value === "string"
    );
  } catch {
    return [];
  }
}

/** 合併正式與本機 lock；同名以本機為準。 */
export function readInstalledModuleEntries(): ModuleLockEntry[] {
  const byValue = new Map<string, ModuleLockEntry>();
  for (const entry of readEntries(MARKET_LOCK_FILE)) byValue.set(entry.value, entry);
  for (const entry of readEntries(LOCAL_LOCK_FILE)) byValue.set(entry.value, entry);
  return [...byValue.values()];
}

/** value → 版本（供市集列表顯示已安裝版本）。 */
export function readInstalledModules(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readInstalledModuleEntries()) {
    out[entry.value] = typeof entry.version === "string" ? entry.version : "";
  }
  return out;
}

export function readInstalledModuleValues(): Set<string> {
  return new Set(readInstalledModuleEntries().map((entry) => entry.value));
}
