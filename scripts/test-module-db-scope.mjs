/**
 * scopedDb v2 權限測試（P0-2）。
 * 直接載入 src/lib/module-db-scope.ts，用 fake Firestore 驗證：
 *   1. 保留集合／設施集合／未宣告集合 → 拒絕
 *   2. 核心個資集合 → 可讀，寫入（含 batch／transaction／recursiveDelete）→ 拒絕
 *   3. 已宣告的模組自有集合 → 可讀寫
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
const swc = requireHost("next/dist/build/swc");

const source = fs.readFileSync(path.join(ROOT, "src", "lib", "module-db-scope.ts"), "utf-8");
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const mod = { exports: {} };
new Function("require", "module", "exports", code)(requireHost, mod, mod.exports);
const { createScopedDb, CORE_READ_ONLY_COLLECTIONS } = mod.exports;

const writes = [];

function makeDoc(docPath) {
  const doc = {
    path: docPath,
    id: docPath.split("/").pop(),
    ref: {
      path: docPath,
      set: async () => {
        writes.push(["ref.set", docPath]);
      },
      update: async () => {
        writes.push(["ref.update", docPath]);
      },
      delete: async () => {
        writes.push(["ref.delete", docPath]);
      },
    },
    get: async () => ({ exists: true, data: () => ({}), ref: doc.ref }),
    set: async () => {
      writes.push(["set", docPath]);
    },
    update: async () => {
      writes.push(["update", docPath]);
    },
    delete: async () => {
      writes.push(["delete", docPath]);
    },
    collection: (name) => makeCollection(`${docPath}/${name}`),
  };
  return doc;
}

function makeCollection(collectionPath) {
  const collection = {
    path: collectionPath,
    id: collectionPath.split("/").pop(),
    doc: (id) => makeDoc(id ? `${collectionPath}/${id}` : `${collectionPath}/auto`),
    add: async () => {
      writes.push(["add", collectionPath]);
      return makeDoc(`${collectionPath}/new`);
    },
    where() {
      return collection;
    },
    limit() {
      return collection;
    },
    get: async () => ({ docs: [makeDoc(`${collectionPath}/u1`)] }),
  };
  return collection;
}

const db = {
  collection: (name) => makeCollection(name),
  doc: (docPath) => makeDoc(docPath),
  collectionGroup: () => ({ get: async () => ({ docs: [] }) }),
  getAll: async (...refs) => refs.map((ref) => ({ path: ref.path })),
  batch: () => ({
    set: (ref) => writes.push(["batch.set", ref.path]),
    update: (ref) => writes.push(["batch.update", ref.path]),
    delete: (ref) => writes.push(["batch.delete", ref.path]),
    commit: async () => {},
  }),
  runTransaction: async (fn) =>
    fn({
      get: async () => ({ exists: true }),
      set: (ref) => writes.push(["tx.set", ref.path]),
      update: (ref) => writes.push(["tx.update", ref.path]),
      delete: (ref) => writes.push(["tx.delete", ref.path]),
    }),
  recursiveDelete: async (ref) => writes.push(["recursiveDelete", ref.path]),
  bulkWriter: () => ({}),
};

const declared = new Set([
  "ownCollection",
  "rosterStudents",
  "studentPersonalInfo",
  "announcements",
]);
const scoped = createScopedDb(db, "demoModule", declared);

assert.deepEqual(
  [...CORE_READ_ONLY_COLLECTIONS].sort(),
  [
    "rosterAdmins",
    "rosterParents",
    "rosterStaff",
    "rosterStudents",
    "studentPersonalIdentity",
    "studentPersonalInfo",
    "studentPersonalPhoto",
  ].sort(),
  "核心唯讀集合清單應完整"
);

for (const name of ["users", "settings", "activityLog", "revokedJTIs"]) {
  assert.throws(() => scoped.collection(name), /宿主保留集合/, `${name} 應被拒絕`);
}
assert.throws(() => scoped.collection("announcements"), /設施集合/, "設施集合應被拒絕");
assert.throws(() => scoped.collection("notDeclared"), /未宣告集合/, "未宣告集合應被拒絕");
assert.throws(() => scoped.doc("users/u1"), /宿主保留集合/, "doc 路徑也應拒絕保留集合");
assert.throws(() => scoped.getAll({ path: "users/u1" }), /宿主保留集合/, "getAll 也應拒絕保留集合");

// 已宣告的模組自有集合：可讀寫
await scoped.collection("ownCollection").doc("d1").set({ ok: true });
assert.deepEqual(writes.pop(), ["set", "ownCollection/d1"]);
await scoped.collection("ownCollection").add({ ok: true });
assert.deepEqual(writes.pop(), ["add", "ownCollection"]);

// 核心集合：可讀
const rosterDoc = scoped.collection("rosterStudents").doc("u1");
assert.equal((await rosterDoc.get()).exists, true, "核心集合應可讀");
assert.throws(() => rosterDoc.set({}), /唯讀/);
assert.throws(() => rosterDoc.update({}), /唯讀/);
assert.throws(() => rosterDoc.delete(), /唯讀/);
assert.throws(() => scoped.collection("rosterStudents").add({}), /唯讀/);
assert.throws(() => rosterDoc.collection("sub").doc("x").set({}), /唯讀/);

const personalDoc = scoped.doc("studentPersonalInfo/u1");
await personalDoc.get();
assert.throws(() => personalDoc.set({}), /唯讀/);
assert.deepEqual(await scoped.getAll(personalDoc), [{ path: "studentPersonalInfo/u1" }]);

// snapshot.ref 也不能逃逸
const personalSnapshot = await personalDoc.get();
assert.throws(() => personalSnapshot.ref.set({}), /唯讀/);
const rosterSnapshots = await scoped.collection("rosterStudents").where("x", "==", 1).get();
assert.throws(() => rosterSnapshots.docs[0].ref.set({}), /唯讀/);

// batch／transaction／recursiveDelete 也必須擋核心集合
assert.throws(
  () => scoped.batch().set(scoped.collection("rosterStudents").doc("u1"), {}),
  /唯讀/
);
scoped.batch().set(scoped.collection("ownCollection").doc("d1"), {});
assert.deepEqual(writes.pop(), ["batch.set", "ownCollection/d1"]);

await assert.rejects(
  scoped.runTransaction(async (tx) => tx.set(scoped.collection("rosterStudents").doc("u1"), {})),
  /唯讀/
);
await scoped.runTransaction(async (tx) => tx.set(scoped.collection("ownCollection").doc("d2"), {}));
assert.deepEqual(writes.pop(), ["tx.set", "ownCollection/d2"]);

assert.throws(
  () => scoped.recursiveDelete(scoped.collection("rosterStudents").doc("u1")),
  /唯讀/
);
await scoped.recursiveDelete(scoped.collection("ownCollection").doc("d1"));
assert.deepEqual(writes.pop(), ["recursiveDelete", "ownCollection/d1"]);

assert.throws(() => scoped.bulkWriter(), /bulkWriter/, "bulkWriter 應被拒絕");
assert.throws(() => scoped.collectionGroup("users"), /宿主保留集合/);
scoped.collectionGroup("rosterStudents"); // 核心集合的 collectionGroup 查詢本身唯讀，允許

process.stdout.write(
  "[module-db-scope] 保留／設施／未宣告拒絕、核心唯讀、batch／transaction／recursiveDelete 全部通過\n"
);
