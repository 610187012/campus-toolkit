import "server-only";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import {
  CORE_READ_ONLY_COLLECTIONS,
  HOST_FACILITY_COLLECTIONS,
  HOST_RESERVED_COLLECTIONS,
  createScopedDb,
  isCoreReadOnlyCollection,
} from "@/lib/module-db-scope";
import { declaredCollections } from "@/lib/module-db-policy";

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
 * 注意：`firebase-admin` 的 `getAdminDb()` 在模組 API context 內會**自動**
 * 套用同樣的 scopedDb；宿主內部函式一律用 `getAdminDbRaw()`。
 * 頁面（server component）目前不在 runtime wrapper context 內，仍需自行使用
 * `scopedDb` 或等頁面層 wrapper 落地。
 */

/** 取得受限的 AdminDb（見檔頭政策） */
export function scopedDb(moduleValue: string): ReturnType<typeof getAdminDbRaw> {
  return createScopedDb(getAdminDbRaw(), moduleValue, declaredCollections(moduleValue));
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
