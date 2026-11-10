/**
 * F（examRegistration）沙箱 pilot —— 用真正的 route 與 lib 跑在子程序。
 *
 * 這不是正式執行路徑，而是驗證：
 *   1. 自動把 F 的 TS 檔轉成 ESM
 *   2. 相對 import 遞迴編譯
 *   3. 宿主 import 換成沙箱 shim（含 scopedDb 查詢代理）
 *   4. F 的 GET summary=count 與場次列表可以在 --permission 子程序跑完
 *
 * 只讀 F 的原始碼，不修改 F。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const ROOT = process.cwd();
const requireHost = createRequire(path.join(ROOT, "package.json"));
const swc = requireHost("next/dist/build/swc");

const MODULE_ROOT = path.join(ROOT, "src", "modules", "examRegistration");
const ENTRY = path.join(MODULE_ROOT, "api", "admin", "exam-registration", "route.ts");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(MODULE_ROOT, "module.json"), "utf-8").replace(/^\uFEFF/, "")
);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-f-pilot-"));
const shimDir = path.join(temp, "__sandbox");
fs.mkdirSync(shimDir, { recursive: true });

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function parseClause(clause) {
  const names = [];
  let hasDefault = false;
  let namespace = false;
  const named = clause.match(/\{([^}]*)\}/);
  if (named) {
    for (const part of named[1].split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      const local = item.split(/\s+as\s+/).pop()?.trim();
      if (local) names.push(local);
    }
  }
  const before = named ? clause.slice(0, named.index) : clause;
  if (before.replace(/\*/g, "").replace(/,/g, "").trim()) hasDefault = true;
  if (/\*\s*as\s+/.test(clause)) namespace = true;
  return { names, hasDefault, namespace };
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`找不到相對 import：${spec}（from ${fromFile}）`);
}

function shimFileName(spec) {
  return `${spec.replace(/^@\//, "").replace(/[^A-Za-z0-9._-]+/g, "-")}.mjs`;
}

function outPathFor(sourceFile) {
  const rel = path.relative(MODULE_ROOT, sourceFile).split(path.sep).join("/");
  return path.join(temp, rel.replace(/\.tsx?$/, ".mjs"));
}

function relativeSpecifier(fromOut, toPath) {
  let rel = path.relative(path.dirname(fromOut), toPath).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** spec -> { names:Set, hasDefault, namespace } */
const hostImports = new Map();

function recordHostImport(spec, parsed) {
  if (!hostImports.has(spec)) {
    hostImports.set(spec, { names: new Set(), hasDefault: false, namespace: false });
  }
  const entry = hostImports.get(spec);
  for (const name of parsed.names) entry.names.add(name);
  if (parsed.hasDefault) entry.hasDefault = true;
  if (parsed.namespace) entry.namespace = true;
}

const compiled = new Set();
const queue = [ENTRY];

while (queue.length > 0) {
  const sourceFile = queue.shift();
  if (compiled.has(sourceFile)) continue;
  compiled.add(sourceFile);

  const source = fs.readFileSync(sourceFile, "utf-8");
  const { code } = swc.transformSync(source, {
    jsc: { parser: { syntax: "typescript", tsx: false }, target: "es2022" },
    module: { type: "es6" },
  });

  const outFile = outPathFor(sourceFile);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  let next = code;
  const replacements = [];
  let match;

  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(code)) !== null) {
    const clause = match[1] ?? "";
    const spec = match[2];
    if (spec.startsWith(".")) {
      const target = resolveRelative(sourceFile, spec);
      queue.push(target);
      replacements.push([spec, relativeSpecifier(outFile, outPathFor(target))]);
    } else if (spec === "server-only") {
      const shim = path.join(shimDir, "server-only.mjs");
      fs.writeFileSync(shim, "export {};\n");
      replacements.push([spec, relativeSpecifier(outFile, shim)]);
    } else {
      const parsed = parseClause(clause);
      recordHostImport(spec, parsed);
      replacements.push([spec, relativeSpecifier(outFile, path.join(shimDir, shimFileName(spec)))]);
    }
  }

  SIDE_EFFECT_RE.lastIndex = 0;
  while ((match = SIDE_EFFECT_RE.exec(code)) !== null) {
    const spec = match[1];
    if (spec === "server-only") {
      const shim = path.join(shimDir, "server-only.mjs");
      fs.writeFileSync(shim, "export {};\n");
      replacements.push([spec, relativeSpecifier(outFile, shim)]);
    } else if (!spec.startsWith(".")) {
      recordHostImport(spec, { names: new Set(), hasDefault: false, namespace: false });
      replacements.push([spec, relativeSpecifier(outFile, path.join(shimDir, shimFileName(spec)))]);
    }
  }

  for (const [from, to] of replacements) {
    next = next.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
  }
  fs.writeFileSync(outFile, next);
}

// —— 沙箱 shim ——

const DB_SHIM = `
const rpc = (method, params) => globalThis.__sandboxRpc(method, params);

class DocRef {
  constructor(collection, id) {
    this.collection = collection;
    this.id = id;
  }
  async get() {
    const result = await rpc("db.doc.get", { collection: this.collection, id: this.id });
    return { exists: result.exists, id: this.id, data: () => result.data };
  }
  async set(data) {
    return rpc("db.doc.set", { collection: this.collection, id: this.id, data });
  }
  async update(data) {
    return rpc("db.doc.update", { collection: this.collection, id: this.id, data });
  }
  async delete() {
    return rpc("db.doc.delete", { collection: this.collection, id: this.id });
  }
}

class Query {
  constructor(collection) {
    this.collection = collection;
    this.filters = [];
    this.order = null;
    this.limitValue = null;
  }
  where(field, op, value) {
    this.filters.push({ field, op, value });
    return this;
  }
  orderBy(field, direction = "asc") {
    this.order = { field, direction };
    return this;
  }
  limit(value) {
    this.limitValue = value;
    return this;
  }
  doc(id) {
    const resolvedId =
      id ??
      globalThis.crypto?.randomUUID?.() ??
      \`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
    return new DocRef(this.collection, resolvedId);
  }
  async get() {
    const result = await rpc("db.query", {
      collection: this.collection,
      filters: this.filters,
      orderBy: this.order,
      limit: this.limitValue,
    });
    const docs = result.rows.map((row) => ({
      id: row.id,
      data: () => row.data,
      ref: { id: row.id },
    }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  count() {
    return {
      get: async () => {
        const result = await rpc("db.count", {
          collection: this.collection,
          filters: this.filters,
        });
        return { data: () => ({ count: result.count }) };
      },
    };
  }
}

class Database {
  collection(name) {
    return new Query(name);
  }
  batch() {
    throw new Error("沙箱尚未支援 batch");
  }
  runTransaction() {
    throw new Error("沙箱尚未支援 transaction");
  }
}

export function scopedDb() {
  return new Database();
}
export function getAdminDb() {
  return new Database();
}
export function getAdminDbRaw() {
  return new Database();
}
`;

const NEXT_SERVER_SHIM = `
export class NextRequest {}
export class NextResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this.headers = init.headers ?? {};
    this.body = typeof body === "string" ? body : "";
  }
  static json(body, init = {}) {
    return new NextResponse(JSON.stringify(body), init);
  }
}
`;

const RATE_SHIM = `
export function enforceRateLimit() { return null; }
export function enforceAccountRateLimit() { return null; }
export async function enforceRateLimitShared() { return null; }
export async function enforceAccountRateLimitShared() { return null; }
export function tooManyRequests() { return null; }
export function clientKey() { return "sandbox"; }
export const RATE = new Proxy({}, { get: () => ({ limit: 9999, windowMs: 60000 }) });
`;

const DAL_SHIM = `
const session = {
  uid: "u1",
  role: "admin",
  account: "demo",
  name: "Demo Admin",
  displayName: "Demo Admin",
};
export async function requireModulePermission() { return { context: { session }, session, denial: null }; }
export async function requireRole() { return { context: { session }, session, denial: null }; }
export async function requireAdminModule() { return { context: { session }, session, denial: null }; }
export async function requireSuperAdmin() { return { context: { session }, session, denial: null, isSuper: true }; }
export function toAuthResponse(denial) { return denial; }
export async function verifySession() { return session; }
export function isSuperAdmin() { return true; }
`;

const CSRF_SHIM = `
export function assertSameOrigin() { return null; }
`;

const CACHE_SHIM = `
export async function cachedRead(_key, _ttl, load) { return load(); }
export function invalidateReadCache() {}
export async function cachedListRead(_key, load) {
  return { data: await load(), epoch: 1 };
}
export async function invalidateAdminListCache() {}
`;

const AUDIT_SHIM = `
export function getClientIp() { return "127.0.0.1"; }
export async function logActivity() {}
`;

const ROSTER_SHIM = `
const MAP = {
  student: "rosterStudents",
  parent: "rosterParents",
  staff: "rosterStaff",
  admin: "rosterAdmins",
};
export function rosterCollection(role) { return MAP[role] ?? \`roster-\${role}\`; }
`;

const KNOWN_SHIMS = {
  "next/server": NEXT_SERVER_SHIM,
  "@/lib/module-db": DB_SHIM,
  "@/lib/firebase-admin": DB_SHIM,
  "@/lib/rate-limit": RATE_SHIM,
  "@/lib/dal": DAL_SHIM,
  "@/lib/csrf": CSRF_SHIM,
  "@/lib/read-cache": CACHE_SHIM,
  "@/lib/list-cache": CACHE_SHIM,
  "@/lib/audit": AUDIT_SHIM,
  "@/types/roster": ROSTER_SHIM,
};

function generateShims() {
  for (const [spec, info] of hostImports.entries()) {
    const filePath = path.join(shimDir, shimFileName(spec));
    if (fs.existsSync(filePath)) continue;
    let code = KNOWN_SHIMS[spec] ?? "";
    const exported = new Set();
    for (const match of code.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g)) {
      exported.add(match[1]);
    }
    for (const name of info.names) {
      if (exported.has(name)) continue;
      if (name === "default") continue;
      code += `\nexport const ${name} = (...args) => { throw new Error(${JSON.stringify(
        `沙箱尚未支援 ${spec}.${name}`
      )}); };\n`;
    }
    if (info.hasDefault && !/export\s+default/.test(code)) {
      code += `\nexport default new Proxy({}, { get: () => { throw new Error(${JSON.stringify(
        `沙箱尚未支援 ${spec} default`
      )}); } });\n`;
    }
    fs.writeFileSync(filePath, code);
  }
}

generateShims();

const RUNNER_SOURCE = `
const pending = new Map();
let seq = 0;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send({ type: "rpc", id, method, params });
  });
}

globalThis.__sandboxRpc = rpc;

process.on("message", (message) => {
  if (message?.type !== "rpc-result") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error ?? "RPC 失敗"));
});

const { GET, POST, PATCH, DELETE } = await import(new URL("./api/admin/exam-registration/route.mjs", import.meta.url));

process.on("message", async (message) => {
  if (message?.type !== "request") return;
  try {
    const url = new URL(message.path, "http://sandbox.local");
    const request = {
      method: message.method ?? "GET",
      nextUrl: url,
      headers: new Headers(message.headers ?? {}),
      json: async () => message.body ?? {},
      formData: async () => new FormData(),
    };
    const handler = { GET, POST, PATCH, DELETE }[message.method ?? "GET"];
    if (!handler) throw new Error("沙箱尚未支援 method：" + message.method);
    const response = await handler(request);
    process.send({ type: "response", ok: true, response });
  } catch (error) {
    process.send({ type: "response", ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

process.send({ type: "ready" });
`;

fs.writeFileSync(path.join(temp, "runner.mjs"), RUNNER_SOURCE);

const ALLOWED_COLLECTIONS = new Set(
  Array.isArray(MANIFEST.dataCollections) ? MANIFEST.dataCollections : []
);
function createDb() {
  return {
    examEvents: [
      {
        id: "e1",
        data: {
          title: "第一次模擬考",
          examType: "mock",
          examDate: "2026-01-10",
          examEndDate: "2026-01-10",
          status: "open",
          updatedAt: 1,
          createdAt: 1,
        },
      },
      {
        id: "e2",
        data: {
          title: "第二次模擬考",
          examType: "mock",
          examDate: "2026-02-10",
          examEndDate: "2026-02-10",
          status: "open",
          updatedAt: 2,
          createdAt: 2,
        },
      },
      {
        id: "e3",
        data: {
          title: "第三次模擬考",
          examType: "mock",
          examDate: "2026-03-10",
          examEndDate: "2026-03-10",
          status: "closed",
          updatedAt: 3,
          createdAt: 3,
        },
      },
    ],
  };
}

function applyFilters(rows, filters = []) {
  return rows.filter((row) =>
    filters.every(({ field, op, value }) => {
      const actual = row.data[field];
      switch (op) {
        case "==":
          return actual === value;
        case "!=":
          return actual !== value;
        case ">":
          return actual > value;
        case ">=":
          return actual >= value;
        case "<":
          return actual < value;
        case "<=":
          return actual <= value;
        case "in":
          return Array.isArray(value) && value.includes(actual);
        case "array-contains":
          return Array.isArray(actual) && actual.includes(value);
        default:
          return false;
      }
    })
  );
}

function handleRpc(method, params, db) {
  if (method === "session.get") {
    return { session: { uid: "u1", role: "admin", account: "demo" }, denial: null };
  }
  if (method === "db.query" || method === "db.count") {
    const collection = params?.collection;
    if (!ALLOWED_COLLECTIONS.has(collection)) {
      throw new Error(`未宣告集合：${collection}`);
    }
    let rows = applyFilters(db[collection] ?? [], params.filters);
    if (method === "db.count") return { count: rows.length };
    if (params.orderBy) {
      const { field, direction } = params.orderBy;
      rows = [...rows].sort((a, b) => {
        const left = a.data[field];
        const right = b.data[field];
        if (left === right) return 0;
        return (left < right ? -1 : 1) * (direction === "desc" ? -1 : 1);
      });
    }
    if (Number.isInteger(params.limit) && params.limit >= 0) {
      rows = rows.slice(0, params.limit);
    }
    return { rows };
  }
  if (method === "db.doc.get") {
    const collection = params?.collection;
    if (!ALLOWED_COLLECTIONS.has(collection)) {
      throw new Error(`未宣告集合：${collection}`);
    }
    const row = (db[collection] ?? []).find((item) => item.id === params.id);
    return { exists: Boolean(row), data: row?.data ?? null };
  }
  if (method === "db.doc.set" || method === "db.doc.update") {
    const collection = params?.collection;
    if (!ALLOWED_COLLECTIONS.has(collection)) {
      throw new Error(`未宣告集合：${collection}`);
    }
    const rows = db[collection] ?? (db[collection] = []);
    const id = params.id;
    const existing = rows.find((row) => row.id === id);
    if (method === "db.doc.set") {
      if (existing) existing.data = params.data;
      else rows.push({ id, data: params.data });
      return { ok: true };
    }
    if (!existing) throw new Error(`文件不存在：${collection}/${id}`);
    existing.data = { ...existing.data, ...params.data };
    return { ok: true };
  }
  if (method === "db.doc.delete") {
    const collection = params?.collection;
    if (!ALLOWED_COLLECTIONS.has(collection)) {
      throw new Error(`未宣告集合：${collection}`);
    }
    db[collection] = (db[collection] ?? []).filter((row) => row.id !== params.id);
    return { ok: true };
  }
  throw new Error(`未知 RPC：${method}`);
}

function runSandbox(requestPath, options = {}) {
  const db = options.db ?? createDb();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${temp}`, path.join(temp, "runner.mjs")],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`F 沙箱 pilot 逾時\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15_000);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(error);
    });
    child.on("message", (message) => {
      if (message?.type === "ready") {
        child.send({
          type: "request",
          path: requestPath,
          method: options.method ?? "GET",
          body: options.body,
        });
        return;
      }
      if (message?.type === "rpc") {
        try {
          const result = handleRpc(message.method, message.params, db);
          child.send({ type: "rpc-result", id: message.id, ok: true, result });
        } catch (error) {
          child.send({
            type: "rpc-result",
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (message?.type === "response") {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        child.kill();
        if (!message.ok) {
          reject(new Error(`F handler 失敗：${message.error}\n${stderr}`));
          return;
        }
        resolve({ response: message.response, stdout, stderr });
      }
    });
  });
}

try {
  const countRun = await runSandbox("/api/admin/exam-registration?summary=count");
  assert.equal(countRun.response.status, 200);
  assert.deepEqual(JSON.parse(countRun.response.body), { success: true, total: 3 });

  const listRun = await runSandbox("/api/admin/exam-registration");
  assert.equal(listRun.response.status, 200);
  const listBody = JSON.parse(listRun.response.body);
  assert.equal(listBody.success, true);
  assert.equal(listBody.total, 3);
  assert.deepEqual(
    listBody.events.map((event) => event.id),
    ["e3", "e2", "e1"],
    "應依 examDate 由新到舊"
  );

  const sharedDb = createDb();
  const createRun = await runSandbox("/api/admin/exam-registration", {
    method: "POST",
    db: sharedDb,
    body: {
      title: "沙箱測試場次",
      examType: "mock",
      examDate: "2026-12-01",
      examEndDate: "2026-12-01",
      deadline: Date.now() + 86400000,
      target: { grades: ["1"], classes: [] },
      subjects: [{ key: "chinese", label: "國文" }],
      status: "draft",
    },
  });
  assert.equal(createRun.response.status, 200, createRun.response.body);
  const createBody = JSON.parse(createRun.response.body);
  assert.equal(createBody.success, true, createRun.response.body);
  assert.equal(createBody.events.length, 4);
  assert.equal(createBody.events[0].title, "沙箱測試場次");
  assert.equal(createBody.events[0].status, "draft");
  const createdId = createBody.events[0].id;

  const patchRun = await runSandbox("/api/admin/exam-registration", {
    method: "PATCH",
    db: sharedDb,
    body: { id: createdId, title: "更新後場次" },
  });
  assert.equal(patchRun.response.status, 200, patchRun.response.body);
  const patchBody = JSON.parse(patchRun.response.body);
  assert.equal(patchBody.success, true, patchRun.response.body);
  assert.ok(
    patchBody.events.some((event) => event.id === createdId && event.title === "更新後場次"),
    patchRun.response.body
  );

  const deleteRun = await runSandbox(
    `/api/admin/exam-registration?id=${encodeURIComponent(createdId)}`,
    { method: "DELETE", db: sharedDb }
  );
  assert.equal(deleteRun.response.status, 200, deleteRun.response.body);
  const deleteBody = JSON.parse(deleteRun.response.body);
  assert.equal(deleteBody.success, true, deleteRun.response.body);
  assert.equal(deleteBody.events.length, 3);
  assert.ok(!deleteBody.events.some((event) => event.id === createdId));

  process.stdout.write(
    "[sandbox-f-pilot] F 真正的 count／列表／建立／更新／刪除已在 --permission 子程序跑通\n"
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
