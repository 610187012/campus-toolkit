import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getAdminDb } from "@/lib/firebase-admin";

/**
 * scopedDb：選用模組的 runtime Firestore 集合管制（市集文件 §6.4，v2 備選的務實落地）。
 *
 * `dataCollections` 原本只是「宣告即承諾」（靜態掃描比對）；本模組提供
 * `scopedDb(moduleValue)`——回傳一個只允許存取該模組 manifest 已宣告集合
 * （＋掛勾豁免集合）的 AdminDb 代理：未宣告集合一律拋錯（fail-safe 朝關）。
 *
 * 使用方式（模組伺服器端，替代 getAdminDb）：
 * ```ts
 * import { scopedDb } from "@/lib/module-db";
 * const db = scopedDb("examRegistration");
 * db.collection("examEvents")… // 已宣告 → 允許
 * db.collection("anythingElse")… // 未宣告 → 拋錯
 * ```
 * - 集合宣告來源＝`src/modules/<value>/module.json` 的 `dataCollections`（掛載後即存在）。
 * - 掛鉤豁免集合（announcements、calendarEvents）自動允許——模組走掛勾函式寫入。
 * - 宿主保留集合（users、settings、activityLog、revokedJTIs）一律拒絕，即使 manifest 宣告也無效。
 * - **選用式**：不强制——現有模組用 getAdminDb 不受影響；新模組建議改用 scopedDb。
 * - 讀取失敗（manifest 缺失／毀損）＝只放行掛鉤集合（fail-safe 朝關）。
 */

/** 掛鉤設施集合——模組經 publishFromModule/publishScheduleFromModule 間接寫入，此處豁免 */
const HOOK_EXEMPT = new Set(["announcements", "calendarEvents"]);

/** 宿主保留集合：scopedDb 一律拒絕（P0-2） */
const RESERVED_COLLECTIONS = new Set(["users", "settings", "activityLog", "revokedJTIs"]);

const cache = new Map<string, Set<string>>();

function declaredCollections(moduleValue: string): Set<string> {
  const cached = cache.get(moduleValue);
  if (cached) return cached;
  const result = new Set(HOOK_EXEMPT);
  try {
    const manifestPath = path.join(process.cwd(), "src", "modules", moduleValue, "module.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8").replace(/^﻿/, "")) as {
        dataCollections?: unknown;
      };
      if (Array.isArray(manifest.dataCollections)) {
        for (const name of manifest.dataCollections) {
          if (typeof name === "string" && name && !RESERVED_COLLECTIONS.has(name)) result.add(name);
        }
      }
    }
  } catch {
    // manifest 讀不到＝只留掛鉤集合（fail-safe）
  }
  cache.set(moduleValue, result);
  return result;
}

type AnyRecord = Record<string, unknown>;

/**
 * 取得受限的 AdminDb：`collection(name)` 超出宣告範圍即拋錯。
 * 其餘 Firestore 介面（doc/getAll/runTransaction…）原樣委派。
 */
export function scopedDb(moduleValue: string): ReturnType<typeof getAdminDb> {
  const db = getAdminDb();
  const allowed = declaredCollections(moduleValue);
  const realCollection = db.collection.bind(db);
  const realDoc = db.doc.bind(db);

  const assertCollection = (name: string) => {
    if (RESERVED_COLLECTIONS.has(name)) {
      throw new Error(`scopedDb(${moduleValue})：宿主保留集合「${name}」不可由模組存取【P0-2】`);
    }
    if (!allowed.has(name)) {
      throw new Error(
        `scopedDb(${moduleValue})：未宣告集合「${name}」——請在 module.json dataCollections 宣告`
      );
    }
  };

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "collection") {
        return (name: string) => {
          if (typeof name === "string") assertCollection(name);
          return realCollection(name);
        };
      }
      if (prop === "doc") {
        return (pathValue: string) => {
          const name = String(pathValue).split("/")[0] ?? "";
          if (name) assertCollection(name);
          return realDoc(pathValue);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReturnType<typeof getAdminDb>;
}

/** 該模組是否被允許存取某集合（供測試與除錯） */
export function canAccessCollection(moduleValue: string, collectionName: string): boolean {
  return declaredCollections(moduleValue).has(collectionName);
}
