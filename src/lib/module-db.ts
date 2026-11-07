import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  CORE_READ_ONLY_COLLECTIONS,
  HOST_FACILITY_COLLECTIONS,
  HOST_RESERVED_COLLECTIONS,
  createScopedDb,
  isCoreReadOnlyCollection,
} from "@/lib/module-db-scope";

/**
 * scopedDb：選用模組的 runtime Firestore 集合管制（P0-2 v2）。
 *
 * 模組應以 `scopedDb(moduleValue)` 取代 `getAdminDb()`：
 * ```ts
 * import { scopedDb } from "@/lib/module-db";
 * const db = scopedDb("examRegistration");
 * db.collection("examEvents")…        // 已宣告 → 可讀寫
 * db.collection("rosterStudents")…    // 核心集合 → 可讀，寫入拋錯
 * db.collection("users")…             // 保留集合 → 拋錯
 * db.collection("announcements")…     // 設施集合 → 拋錯（改用掛勾函式）
 * db.collection("anythingElse")…      // 未宣告 → 拋錯
 * ```
 *
 * - 集合宣告來源＝`src/modules/<value>/module.json` 的 `dataCollections`。
 * - 核心個資集合（名冊四表＋學生個人資料三表）唯讀；寫入由主程式管理端負責。
 * - 設施集合（announcements／calendarEvents）不可直接讀寫，一律走掛勾函式。
 * - 保留集合（users／settings／activityLog／revokedJTIs）一律拒絕。
 * - 讀取 manifest 失敗＝只允許空集合（fail-safe）。
 * - v1 的 `getAdminDb()` 仍可用（E／F／G 尚未遷移），但市集審核與掃描器會提示遷移。
 */

const cache = new Map<string, Set<string>>();

function declaredCollections(moduleValue: string): Set<string> {
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

/** 取得受限的 AdminDb（見檔頭政策） */
export function scopedDb(moduleValue: string): ReturnType<typeof getAdminDb> {
  return createScopedDb(getAdminDb(), moduleValue, declaredCollections(moduleValue));
}

/** 該模組是否被允許存取某集合（供測試與除錯；核心集合回 true，但僅唯讀） */
export function canAccessCollection(moduleValue: string, collectionName: string): boolean {
  return declaredCollections(moduleValue).has(collectionName);
}

export {
  CORE_READ_ONLY_COLLECTIONS,
  HOST_FACILITY_COLLECTIONS,
  HOST_RESERVED_COLLECTIONS,
  isCoreReadOnlyCollection,
};
