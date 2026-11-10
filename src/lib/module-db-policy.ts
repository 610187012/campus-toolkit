import fs from "node:fs";
import path from "node:path";

/**
 * 模組 `dataCollections` 的讀取與快取。
 *
 * 放在獨立檔案，讓 `firebase-admin`（自動 scoped getAdminDb）與 `module-db`
 * 共用同一份宣告，不必互相 import。
 */
const cache = new Map<string, Set<string>>();

export function declaredCollections(moduleValue: string): Set<string> {
  const cached = cache.get(moduleValue);
  if (cached) return cached;
  const result = new Set<string>();
  try {
    const manifestPath = path.join(process.cwd(), "src", "modules", moduleValue, "module.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8").replace(/^﻿/, "")) as {
        dataCollections?: unknown;
      };
      if (Array.isArray(manifest.dataCollections)) {
        for (const name of manifest.dataCollections) {
          if (typeof name === "string" && name) result.add(name);
        }
      }
    }
  } catch {
    // manifest 讀不到＝不允許任何模組自有集合（fail-safe）
  }
  cache.set(moduleValue, result);
  return result;
}
