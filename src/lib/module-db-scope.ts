/**
 * 模組資料存取範圍（P0-2 v2）——純政策＋Proxy 實作。
 *
 * 本檔不 import server-only／宿主模組，方便測試；
 * 實際的 AdminDb 由 `module-db.ts` 注入。
 *
 * 集合政策：
 * - `reserved`：宿主保留集合，模組一律不可讀寫（users／settings／activityLog／revokedJTIs）。
 * - `facility`：宿主設施集合（announcements／calendarEvents），一律走掛勾函式，不可直接存取。
 * - `coreReadOnly`：核心個資集合（身分名冊、個人資料），可讀不可寫。
 * - `unknown`：需在 manifest `dataCollections` 宣告；宣告後可讀寫。
 */

/** 宿主保留集合：一律拒絕（P0-2） */
export const HOST_RESERVED_COLLECTIONS = [
  "users",
  "settings",
  "activityLog",
  "revokedJTIs",
] as const;

/** 宿主設施集合：一律走 publishFromModule／publishScheduleFromModule */
export const HOST_FACILITY_COLLECTIONS = ["announcements", "calendarEvents"] as const;

/**
 * 核心個資集合：模組可讀、不可寫。
 * 名冊四張表＋學生個人資料三張表。
 */
export const CORE_READ_ONLY_COLLECTIONS = [
  "rosterStudents",
  "rosterParents",
  "rosterStaff",
  "rosterAdmins",
  "studentPersonalInfo",
  "studentPersonalIdentity",
  "studentPersonalPhoto",
] as const;

export type CollectionAccess = "readwrite" | "readonly";

function includesName(list: readonly string[], name: string): boolean {
  return list.includes(name);
}

export function isReservedCollection(name: string): boolean {
  return includesName(HOST_RESERVED_COLLECTIONS, name);
}

export function isFacilityCollection(name: string): boolean {
  return includesName(HOST_FACILITY_COLLECTIONS, name);
}

export function isCoreReadOnlyCollection(name: string): boolean {
  return includesName(CORE_READ_ONLY_COLLECTIONS, name);
}

/**
 * 判斷模組對某集合的存取模式；不允許時直接拋錯（fail-safe）。
 * @param moduleValue 模組代碼（僅用於錯誤訊息）
 * @param name 集合名稱
 * @param declared manifest `dataCollections` 宣告的集合
 */
export function resolveCollectionAccess(
  moduleValue: string,
  name: string,
  declared: ReadonlySet<string>
): CollectionAccess {
  if (isReservedCollection(name)) {
    throw new Error(
      `scopedDb(${moduleValue})：宿主保留集合「${name}」不可由模組存取【P0-2】`
    );
  }
  if (isFacilityCollection(name)) {
    throw new Error(
      `scopedDb(${moduleValue})：設施集合「${name}」請改用 publishFromModule／publishScheduleFromModule【P0-2】`
    );
  }
  if (!declared.has(name)) {
    throw new Error(
      `scopedDb(${moduleValue})：未宣告集合「${name}」——請在 module.json dataCollections 宣告`
    );
  }
  return isCoreReadOnlyCollection(name) ? "readonly" : "readwrite";
}

const writeError = (moduleValue: string, name: string, action: string) =>
  new Error(
    `scopedDb(${moduleValue})：核心集合「${name}」為唯讀，不可 ${action}【P0-2】`
  );

function collectionNameOfPath(pathValue: string): string {
  return String(pathValue).split("/")[0] ?? "";
}

/**
 * 建立受限的 AdminDb 代理。
 * @param db 真實 AdminDb（或測試用 fake）
 * @param moduleValue 模組代碼
 * @param declared manifest `dataCollections`
 */
export function createScopedDb<T extends Record<string, any>>(
  db: T,
  moduleValue: string,
  declared: ReadonlySet<string>
): T {
  /** Proxy → 原生 ref，供 getAll／transaction／batch 解包 */
  const nativeOf = new WeakMap<object, any>();

  const unwrap = (value: any): any => {
    if (value && typeof value === "object") {
      const native = nativeOf.get(value);
      if (native) return native;
    }
    return value;
  };

  const accessOf = (name: string): CollectionAccess =>
    resolveCollectionAccess(moduleValue, name, declared);

  const assertWritableRef = (ref: any): any => {
    const native = unwrap(ref);
    const pathValue = typeof native?.path === "string" ? native.path : "";
    const name = collectionNameOfPath(pathValue);
    if (!name) return native;
    const access = resolveCollectionAccess(moduleValue, name, declared);
    if (access === "readonly") {
      throw writeError(moduleValue, name, "寫入");
    }
    return native;
  };

  const readOnlyDoc = (native: any): any => {
    const name = collectionNameOfPath(native?.path ?? "");
    const proxy = new Proxy(native, {
      get(target, prop) {
        if (prop === "set" || prop === "update" || prop === "delete" || prop === "create") {
          return () => {
            throw writeError(moduleValue, name, String(prop));
          };
        }
        if (prop === "collection") {
          return (sub: string) => readOnlyCollection(target.collection(sub));
        }
        if (prop === "parent") {
          return readOnlyCollection(target.parent);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeOf.set(proxy, native);
    return proxy;
  };

  const readOnlyCollection = (native: any): any => {
    const name = collectionNameOfPath(native?.path ?? native?.id ?? "");
    const proxy = new Proxy(native, {
      get(target, prop) {
        if (prop === "add") {
          return () => {
            throw writeError(moduleValue, name, "add");
          };
        }
        if (prop === "doc") {
          return (id?: string) => readOnlyDoc(target.doc(id));
        }
        if (prop === "withConverter") {
          return (...args: any[]) => readOnlyCollection(target.withConverter(...args));
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeOf.set(proxy, native);
    return proxy;
  };

  const guardWriter = (writer: any): any =>
    new Proxy(writer, {
      get(target, prop) {
        if (prop === "set" || prop === "update" || prop === "delete") {
          return (ref: any, ...rest: any[]) =>
            target[prop](assertWritableRef(ref), ...rest);
        }
        if (prop === "get") {
          return (ref: any) => {
            const native = unwrap(ref);
            const name = collectionNameOfPath(native?.path ?? "");
            if (name) accessOf(name); // 保留／設施／未宣告一律拒絕；核心集合唯讀查詢允許
            return target.get(native);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return new Proxy(db, {
    get(target, prop) {
      if (prop === "collection") {
        return (name: string) => {
          const access = accessOf(name);
          const native = target.collection(name);
          return access === "readonly" ? readOnlyCollection(native) : native;
        };
      }
      if (prop === "doc") {
        return (pathValue: string) => {
          const name = collectionNameOfPath(pathValue);
          const access = accessOf(name);
          const native = target.doc(pathValue);
          return access === "readonly" ? readOnlyDoc(native) : native;
        };
      }
      if (prop === "collectionGroup") {
        return (name: string) => {
          accessOf(name); // 保留／設施／未宣告一律拒絕；核心集合查詢本身唯讀
          return target.collectionGroup(name);
        };
      }
      if (prop === "getAll") {
        return (...refs: any[]) => {
          const natives = refs.map(unwrap);
          for (const native of natives) {
            const name = collectionNameOfPath(native?.path ?? "");
            if (name) accessOf(name); // 保留／設施／未宣告一律拒絕
          }
          return target.getAll(...natives);
        };
      }
      if (prop === "batch") {
        return () => guardWriter(target.batch());
      }
      if (prop === "runTransaction") {
        return (fn: (tx: any) => Promise<any>, options?: unknown) =>
          target.runTransaction((tx: any) => fn(guardWriter(tx)), options);
      }
      if (prop === "recursiveDelete") {
        return (ref: any) => {
          assertWritableRef(ref);
          return target.recursiveDelete(unwrap(ref));
        };
      }
      if (prop === "bulkWriter") {
        return () => {
          throw new Error(
            `scopedDb(${moduleValue})：模組不得使用 bulkWriter，請改用 batch／逐筆寫入【P0-2】`
          );
        };
      }
      const value = Reflect.get(target as any, prop, target) as any;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
