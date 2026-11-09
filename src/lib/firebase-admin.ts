import "server-only";
import { initializeApp, getApps, cert, App, ServiceAccount } from "firebase-admin/app";
import {
  getFirestore,
  Firestore,
  DocumentReference,
  CollectionReference,
  Query,
  WriteBatch,
  Transaction,
  DocumentSnapshot,
  QuerySnapshot,
} from "firebase-admin/firestore";
import { getAuth, Auth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import {
  isReadStatsEnabled,
  recordReads,
  recordWrites,
  recordDeletes,
} from "@/lib/read-stats";

let adminApp: App | null = null;
let adminDb: Firestore | null = null;
let adminAuth: Auth | null = null;

/** 解析 `FIREBASE_SERVICE_ACCOUNT_KEY`（純 JSON／引號包覆 JSON／base64 皆可）；「統計儀表板」取用以呼叫 Cloud Monitoring */
export function parseServiceAccount(raw: string): ServiceAccount {
  let text = raw.trim();

  // 去掉可能包在外面的一層引號
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1);
  }

  // 允許 base64 編碼的 JSON
  if (!text.startsWith("{")) {
    try {
      const decoded = Buffer.from(text, "base64").toString("utf8");
      if (decoded.trim().startsWith("{")) text = decoded;
    } catch {
      // 不是 base64，維持原文給下面 JSON.parse 報錯
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_KEY 不是有效 JSON（請貼上完整服務帳號金鑰，或使用 base64）"
    );
  }

  // env 中 private_key 常被存成字面 \n
  if (typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_KEY 缺少 client_email 或 private_key"
    );
  }

  return parsed as unknown as ServiceAccount;
}

function ensureAdminApp(): App {
  if (adminApp) return adminApp;
  if (getApps().length > 0) {
    adminApp = getApps()[0];
    return adminApp;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    try {
      const serviceAccount = parseServiceAccount(raw);
      adminApp = initializeApp({ credential: cert(serviceAccount) });
      return adminApp;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Firebase Admin SDK 初始化失敗: ${msg}`);
    }
  }
  // GCP 環境（Firebase App Hosting / Cloud Run）：自動使用內建服務帳號（Application Default Credentials）
  if (process.env.K_SERVICE || process.env.GOOGLE_CLOUD_PROJECT) {
    adminApp = initializeApp();
    return adminApp;
  }
  throw new Error(
    "FIREBASE_SERVICE_ACCOUNT_KEY 未設定，無法存取 Firestore（請加入 .env / 部署平台環境變數）"
  );
}

// —— Firestore 讀取統計 Proxy（read-stats，開發輔助）——
// 攔截 get/count/set/update/delete/add/batch/runTransaction/getAll 並計數；
// 計費語意：查詢 N 筆＝N 讀（空查詢＝1）、點查存在＝1（不存在＝0）、count()＝1。
// READ_STATS 關閉時 getAdminDb 回傳原始實例，零 Proxy 開銷。

/** 會回傳新 Query 的鏈式方法（需再包一層統計 Proxy） */
const QUERY_CHAIN_METHODS = new Set([
  "where",
  "orderBy",
  "limit",
  "limitToLast",
  "select",
  "startAt",
  "startAfter",
  "endAt",
  "endBefore",
  "offset",
]);

/** count() 回傳的聚合查詢（僅需 get()；型別對齊 firebase-admin 的 AggregateQuery） */
type CountAggregate = ReturnType<Query["count"]>;

function instrumentAggregate(agg: CountAggregate, collectionName: string): CountAggregate {
  return new Proxy(agg, {
    get(target, prop, receiver) {
      if (prop === "get") {
        const original = target.get.bind(target);
        return async () => {
          const snap = await original();
          recordReads(collectionName, 1);
          return snap;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as CountAggregate;
}

function instrumentDoc(ref: DocumentReference, collectionName: string): DocumentReference {
  return new Proxy(ref, {
    get(target, prop, receiver) {
      if (prop === "get") {
        const original = target.get.bind(target);
        return async () => {
          const snap = await original();
          if (snap.exists) recordReads(collectionName, 1);
          return snap;
        };
      }
      if (prop === "set" || prop === "update" || prop === "create") {
        const original = (target[prop] as (...args: unknown[]) => Promise<unknown>).bind(target);
        return async (...args: unknown[]) => {
          const result = await original(...args);
          recordWrites(1);
          return result;
        };
      }
      if (prop === "delete") {
        const original = Reflect.get(target, "delete") as (...args: unknown[]) => Promise<unknown>;
        const bound = original.bind(target);
        return async (...args: unknown[]) => {
          const result = await bound(...args);
          recordDeletes(1);
          return result;
        };
      }
      if (prop === "collection") {
        const original = target.collection.bind(target);
        return (name: string) => instrumentCollection(original(name), name);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DocumentReference;
}

function instrumentQueryLike<T extends Query | CollectionReference>(
  target: T,
  collectionName: string
): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "get") {
        const original = (t as Query).get.bind(t as Query);
        return async () => {
          const snap = (await original()) as QuerySnapshot;
          // 計費語意：查詢回 N 筆＝N 讀；空查詢仍計 1 讀
          recordReads(collectionName, snap.size === 0 ? 1 : snap.size);
          return snap;
        };
      }
      if (prop === "count") {
        const original = (t as Query).count.bind(t as Query);
        return () => instrumentAggregate(original(), collectionName);
      }
      if (prop === "doc" && t instanceof Object && "doc" in t) {
        const original = (t as CollectionReference).doc.bind(t as CollectionReference);
        // `.doc()` 不帶參數時由 Firestore 自動產生 id；不可傳入 undefined，
        // 否則 Admin SDK 會把 undefined 當成 documentPath 而拋錯（F 建立場次 500 的根因）。
        return (...args: unknown[]) =>
          instrumentDoc(
            args.length === 0 ? original() : original(args[0] as string),
            collectionName
          );
      }
      if (prop === "add") {
        const original = (t as CollectionReference).add.bind(t as CollectionReference);
        return async (data: unknown) => {
          const ref = await original(data as never);
          recordWrites(1);
          return instrumentDoc(ref, collectionName);
        };
      }
      if (typeof prop === "string" && QUERY_CHAIN_METHODS.has(prop)) {
        const original = Reflect.get(t, prop) as (...args: unknown[]) => Query;
        const bound = original.bind(t);
        return (...args: unknown[]) => instrumentQueryLike(bound(...args) as T, collectionName);
      }
      const value = Reflect.get(t, prop, receiver);
      return typeof value === "function" ? value.bind(t) : value;
    },
  }) as T;
}

function instrumentCollection(col: CollectionReference, collectionName: string): CollectionReference {
  return instrumentQueryLike(col, collectionName);
}

function instrumentBatch(batch: WriteBatch): WriteBatch {
  let writes = 0;
  let deletes = 0;
  return new Proxy(batch, {
    get(target, prop, receiver) {
      if (prop === "set" || prop === "update" || prop === "create") {
        const original = (target[prop] as (...args: unknown[]) => WriteBatch).bind(target);
        return (...args: unknown[]) => {
          writes += 1;
          return original(...args);
        };
      }
      if (prop === "delete") {
        const original = Reflect.get(target, "delete") as (...args: unknown[]) => WriteBatch;
        const bound = original.bind(target);
        return (...args: unknown[]) => {
          deletes += 1;
          return bound(...args);
        };
      }
      if (prop === "commit") {
        const original = target.commit.bind(target);
        return async () => {
          const result = await original();
          recordWrites(writes);
          recordDeletes(deletes);
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WriteBatch;
}

function instrumentTransaction(tx: Transaction): Transaction {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "get") {
        const original = target.get.bind(target);
        return async (ref: DocumentReference) => {
          const snap = (await original(ref)) as DocumentSnapshot;
          if (snap.exists) recordReads(ref.parent?.path ?? "(transaction)", 1);
          return snap;
        };
      }
      if (prop === "getAll") {
        const original = target.getAll.bind(target);
        return async (...refs: DocumentReference[]) => {
          const snaps = await original(...refs);
          recordReads(refs[0]?.parent?.path ?? "(transaction)", refs.length);
          return snaps;
        };
      }
      if (prop === "set" || prop === "update" || prop === "create") {
        const original = (target[prop] as (...args: unknown[]) => Transaction).bind(target);
        return (...args: unknown[]) => {
          recordWrites(1);
          return original(...args);
        };
      }
      if (prop === "delete") {
        const original = Reflect.get(target, "delete") as (...args: unknown[]) => Transaction;
        const bound = original.bind(target);
        return (...args: unknown[]) => {
          recordDeletes(1);
          return bound(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Transaction;
}

function instrumentDb(db: Firestore): Firestore {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "collection") {
        const original = target.collection.bind(target);
        return (name: string) => instrumentCollection(original(name), name);
      }
      if (prop === "collectionGroup") {
        const original = target.collectionGroup.bind(target);
        return (id: string) => instrumentQueryLike(original(id), `${id}（群組）`);
      }
      if (prop === "getAll") {
        const original = target.getAll.bind(target);
        return async (...refs: DocumentReference[]) => {
          const snaps = await original(...refs);
          recordReads(refs[0]?.parent?.path ?? "(getAll)", refs.length);
          return snaps;
        };
      }
      if (prop === "batch") {
        const original = target.batch.bind(target);
        return () => instrumentBatch(original());
      }
      if (prop === "runTransaction") {
        const original = target.runTransaction.bind(target);
        return (fn: (tx: Transaction) => Promise<unknown>, ...rest: unknown[]) =>
          original((tx: Transaction) => fn(instrumentTransaction(tx)), ...(rest as []));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Firestore;
}

export function getAdminDb(): Firestore {
  if (adminDb) return adminDb;
  const raw = getFirestore(ensureAdminApp());
  adminDb = isReadStatsEnabled() ? instrumentDb(raw) : raw;
  return adminDb;
}

export function getAdminAuth(): Auth {
  if (adminAuth) return adminAuth;
  adminAuth = getAuth(ensureAdminApp());
  return adminAuth;
}

/** Firebase Storage 私有 bucket：每個主程式 fork 使用自己的 NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET。 */
export function getAdminStorageBucket() {
  const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim();
  if (!bucketName) {
    throw new Error("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET 未設定，無法存取證件照儲存空間");
  }
  return getStorage(ensureAdminApp()).bucket(bucketName);
}

export { FieldValue } from "firebase-admin/firestore";
