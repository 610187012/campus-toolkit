/**
 * build-module-sandbox.mjs —— 把指定模組的 API 編譯成沙箱版本（P1-9 Phase 2C）
 *
 * 用法：
 *   node scripts/build-module-sandbox.mjs --module examRegistration
 *   MODULE_SANDBOX_MODULES=examRegistration node scripts/build-module-sandbox.mjs
 *
 * 產物（gitignored）：
 *   .module-sandbox/<value>/api/**.mjs
 *   .module-sandbox/<value>/__sandbox/*.mjs
 *   .module-sandbox/<value>/manifest.json
 *
 * 只讀模組原始碼，不修改模組。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
const swc = requireHost("next/dist/build/swc");
const XLSX_PATH = path.join(ROOT, "node_modules", "xlsx", "xlsx.mjs");
const OUT_ROOT = path.join(ROOT, ".module-sandbox");

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteSpecifier(code, from, to) {
  const escaped = escapeRegExp(from);
  const replacer = (match, prefix, quote) => `${prefix}${quote}${to}${quote}`;
  return code
    .replace(new RegExp(`(from\\s*)(["'])${escaped}\\2`, "g"), replacer)
    .replace(new RegExp(`(import\\s*\\(\\s*)(["'])${escaped}\\2`, "g"), replacer)
    .replace(new RegExp(`(import\\s*)(["'])${escaped}\\2`, "g"), replacer);
}

const DB_SHIM = `
const rpc = (method, params) => globalThis.__sandboxRpc(method, params);

class DocRef {
  constructor(collection, id) { this.collection = collection; this.id = id; }
  async get() {
    const result = await rpc("db.doc.get", { collection: this.collection, id: this.id });
    return { exists: result.exists, id: this.id, data: () => result.data };
  }
  async set(data) { return rpc("db.doc.set", { collection: this.collection, id: this.id, data }); }
  async update(data) { return rpc("db.doc.update", { collection: this.collection, id: this.id, data }); }
  async delete() { return rpc("db.doc.delete", { collection: this.collection, id: this.id }); }
}

class Query {
  constructor(collection) {
    this.collection = collection;
    this.filters = [];
    this.order = null;
    this.limitValue = null;
    this.selected = null;
  }
  where(field, op, value) { this.filters.push({ field, op, value }); return this; }
  orderBy(field, direction = "asc") { this.order = { field, direction }; return this; }
  limit(value) { this.limitValue = value; return this; }
  select(...fields) { this.selected = fields; return this; }
  doc(id) {
    const resolvedId = id ?? globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    return new DocRef(this.collection, resolvedId);
  }
  async get() {
    const result = await rpc("db.query", {
      collection: this.collection,
      filters: this.filters,
      orderBy: this.order,
      limit: this.limitValue,
      select: this.selected,
    });
    const docs = result.rows.map((row) => ({
      id: row.id,
      data: () => row.data,
      ref: new DocRef(this.collection, row.id),
    }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  count() {
    return {
      get: async () => {
        const result = await rpc("db.count", { collection: this.collection, filters: this.filters });
        return { data: () => ({ count: result.count }) };
      },
    };
  }
}

class Database {
  collection(name) { return new Query(name); }
  async getAll(...refs) {
    const result = await rpc("db.getAll", {
      refs: refs.map((ref) => ({ collection: ref.collection, id: ref.id })),
    });
    return result.snapshots.map((snapshot) => ({
      exists: snapshot.exists,
      id: snapshot.id,
      data: () => snapshot.data,
    }));
  }
  batch() {
    const ops = [];
    return {
      set(ref, data) { ops.push({ type: "set", collection: ref.collection, id: ref.id, data }); },
      update(ref, data) { ops.push({ type: "update", collection: ref.collection, id: ref.id, data }); },
      delete(ref) { ops.push({ type: "delete", collection: ref.collection, id: ref.id }); },
      async commit() { if (ops.length) await rpc("db.batch", { ops }); },
    };
  }
  async runTransaction(fn) {
    const ops = [];
    const tx = {
      async get(ref) {
        const result = await rpc("db.doc.get", { collection: ref.collection, id: ref.id });
        return { exists: result.exists, id: ref.id, data: () => result.data };
      },
      set(ref, data) { ops.push({ type: "set", collection: ref.collection, id: ref.id, data }); },
      update(ref, data) { ops.push({ type: "update", collection: ref.collection, id: ref.id, data }); },
      delete(ref) { ops.push({ type: "delete", collection: ref.collection, id: ref.id }); },
    };
    const result = await fn(tx);
    if (ops.length) await rpc("db.batch", { ops });
    return result;
  }
}

export function scopedDb() { return new Database(); }
export function getAdminDb() { return new Database(); }
export function getAdminDbRaw() { return new Database(); }
`;

const NEXT_SERVER_SHIM = `
export class NextRequest {}
export class NextResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this.headers = init.headers ?? {};
    this.body =
      typeof body === "string"
        ? body
        : body instanceof Uint8Array || Buffer.isBuffer(body)
          ? Buffer.from(body).toString("base64")
          : "";
    this.binary = typeof body !== "string" && (body instanceof Uint8Array || Buffer.isBuffer(body));
  }
  static json(body, init = {}) { return new NextResponse(JSON.stringify(body), init); }
}
`;

const DAL_SHIM = `
export async function requireRole(role) { return globalThis.__sandboxRpc("session.get", { requiredRole: role }); }
export async function requireModulePermission(moduleValue, permission) {
  return globalThis.__sandboxRpc("session.get", { moduleValue, permission });
}
export async function requireAdminModule(moduleValue) {
  return globalThis.__sandboxRpc("session.get", { moduleValue });
}
export async function requireSuperAdmin() {
  return globalThis.__sandboxRpc("session.get", { superAdmin: true });
}
export function toAuthResponse(denial) { return denial; }
export async function verifySession() { return (await globalThis.__sandboxRpc("session.get", {})).session; }
export function isSuperAdmin() { return true; }
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

const CSRF_SHIM = `export function assertSameOrigin() { return null; }`;
const CACHE_SHIM = `
export async function cachedRead(_key, _ttl, load) { return load(); }
export function invalidateReadCache() {}
export async function cachedListRead(_key, load) { return { data: await load(), epoch: 1 }; }
export async function invalidateAdminListCache() {}
`;
const AUDIT_SHIM = `
export function getClientIp() { return process.env.SANDBOX_CLIENT_IP ?? "sandbox"; }
export async function logActivity(input) { return globalThis.__sandboxRpc("audit.log", input); }
`;
const ROSTER_SHIM = `
const MAP = { student: "rosterStudents", parent: "rosterParents", staff: "rosterStaff", admin: "rosterAdmins" };
export function rosterCollection(role) { return MAP[role] ?? "roster-" + role; }
export function isActiveEntry(entry) {
  if (!entry) return false;
  if (typeof entry.status === "string") return entry.status === "active";
  return true;
}
export async function loadPeriodEntries(period, role) {
  const pairs = await globalThis.__sandboxRpc("roster.loadPeriodEntries", { period, role });
  return new Map(pairs);
}
`;
const SETTINGS_SHIM = `
export async function getCurrentPeriod() { return globalThis.__sandboxRpc("settings.period", {}); }
export async function getCacheTtlSeconds() { return globalThis.__sandboxRpc("settings.cacheTtl", {}); }
`;
const ANNOUNCEMENTS_SHIM = `
export async function publishFromModule(input) { return globalThis.__sandboxRpc("hook.publishAnnouncement", input); }
export async function getAnnouncementSettings() { return { categories: [] }; }
`;
const CALENDAR_SHIM = `
export async function publishScheduleFromModule(input) { return globalThis.__sandboxRpc("hook.publishSchedule", input); }
export async function getCalendarSettings() { return { categories: [] }; }
`;
const ANNOUNCEMENT_TYPES_SHIM = `export function schoolWideAudience(roles) { return { roles }; }`;
const MODULE_GATE_SHIM = `
export async function requireFeatureModuleEnabled() { return null; }
export async function isFeatureModuleEnabled() { return true; }
`;
const PERSONAL_INFO_SHIM = `
export const STUDENT_PERSONAL_IDENTITY_COLLECTION = "studentPersonalIdentity";
export const PERSONAL_INFO_COLLECTION = "studentPersonalInfo";
export function readStudentPersonalIdentityFields(data) {
  return { nationalId: typeof data?.nationalId === "string" ? data.nationalId : "" };
}
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
  "@/lib/roster": ROSTER_SHIM,
  "@/lib/settings-server": SETTINGS_SHIM,
  "@/lib/announcements": ANNOUNCEMENTS_SHIM,
  "@/lib/calendar": CALENDAR_SHIM,
  "@/types/announcements": ANNOUNCEMENT_TYPES_SHIM,
  "@/lib/module-gate": MODULE_GATE_SHIM,
  "@/types/personal-info": PERSONAL_INFO_SHIM,
};

function shimFileName(spec) {
  return `${spec.replace(/^@\//, "").replace(/[^A-Za-z0-9._-]+/g, "-")}.mjs`;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`找不到相對 import：${spec}（from ${fromFile}）`);
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function outPathFor(moduleRoot, outDir, sourceFile) {
  const rel = path.relative(moduleRoot, sourceFile).split(path.sep).join("/");
  return path.join(outDir, rel.replace(/\.tsx?$/, ".mjs"));
}

function relativeSpecifier(fromOut, toPath) {
  let rel = path.relative(path.dirname(fromOut), toPath).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function methodNames(source) {
  return ROUTE_METHODS.filter((method) =>
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`).test(source)
  );
}

function moduleRoutePath(apiDir, sourceFile) {
  const relDir = path.relative(apiDir, path.dirname(sourceFile)).split(path.sep).join("/");
  return relDir ? `/api/${relDir}` : "/api";
}

function compileModule(moduleValue) {
  const moduleRoot = path.join(ROOT, "src", "modules", moduleValue);
  if (!fs.existsSync(moduleRoot)) throw new Error(`找不到模組：${moduleRoot}`);
  const apiDir = path.join(moduleRoot, "api");
  if (!fs.existsSync(apiDir)) throw new Error(`模組沒有 api 目錄：${apiDir}`);

  const outDir = path.join(OUT_ROOT, moduleValue);
  const shimDir = path.join(outDir, "__sandbox");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(shimDir, { recursive: true });

  const entryFiles = walkFiles(apiDir).filter((file) => path.basename(file) === "route.ts");
  if (entryFiles.length === 0) throw new Error(`模組沒有 route.ts：${apiDir}`);

  const hostImports = new Map();
  const compiled = new Set();
  const queue = [...entryFiles];
  const routes = [];

  while (queue.length > 0) {
    const sourceFile = queue.shift();
    if (compiled.has(sourceFile)) continue;
    compiled.add(sourceFile);

    const source = fs.readFileSync(sourceFile, "utf-8");
    const { code } = swc.transformSync(source, {
      jsc: { parser: { syntax: "typescript", tsx: false }, target: "es2022" },
      module: { type: "es6" },
    });
    const outFile = outPathFor(moduleRoot, outDir, sourceFile);
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
        replacements.push([spec, relativeSpecifier(outFile, outPathFor(moduleRoot, outDir, target))]);
      } else if (spec === "server-only") {
        const shim = path.join(shimDir, "server-only.mjs");
        fs.writeFileSync(shim, "export {};\n");
        replacements.push([spec, relativeSpecifier(outFile, shim)]);
      } else {
        const parsed = parseClause(clause);
        if (!hostImports.has(spec)) hostImports.set(spec, { names: new Set(), hasDefault: false });
        const entry = hostImports.get(spec);
        for (const name of parsed.names) entry.names.add(name);
        if (parsed.hasDefault) entry.hasDefault = true;
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
        if (!hostImports.has(spec)) hostImports.set(spec, { names: new Set(), hasDefault: false });
        replacements.push([spec, relativeSpecifier(outFile, path.join(shimDir, shimFileName(spec)))]);
      }
    }
    for (const [from, to] of replacements) next = rewriteSpecifier(next, from, to);
    fs.writeFileSync(outFile, next);

    if (entryFiles.includes(sourceFile)) {
      routes.push({
        path: moduleRoutePath(apiDir, sourceFile),
        file: path.relative(outDir, outFile).split(path.sep).join("/"),
        methods: methodNames(source),
      });
    }
  }

  for (const [spec, info] of hostImports.entries()) {
    const filePath = path.join(shimDir, shimFileName(spec));
    if (fs.existsSync(filePath)) continue;
    let code = KNOWN_SHIMS[spec] ?? "";
    if (spec === "xlsx" && fs.existsSync(XLSX_PATH)) {
      code = `export * from ${JSON.stringify(`file:///${XLSX_PATH.replace(/\\/g, "/")}`)};\n`;
    }
    const exported = new Set();
    for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g)) exported.add(m[1]);
    for (const name of info.names) {
      if (exported.has(name)) continue;
      code += `\nexport const ${name} = (...args) => { throw new Error(${JSON.stringify(`沙箱尚未支援 ${spec}.${name}`)}); };\n`;
    }
    if (info.hasDefault && !/export\s+default/.test(code)) {
      code += `\nexport default new Proxy({}, { get: () => { throw new Error(${JSON.stringify(`沙箱尚未支援 ${spec} default`)}); } });\n`;
    }
    fs.writeFileSync(filePath, code);
  }

  const manifest = { moduleValue, generatedAt: new Date().toISOString(), routes };
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const args = process.argv.slice(2);
const moduleArgIndex = args.indexOf("--module");
const moduleList = moduleArgIndex >= 0
  ? [args[moduleArgIndex + 1]]
  : (process.env.MODULE_SANDBOX_MODULES ?? "").split(",").map((v) => v.trim()).filter(Boolean);

if (moduleList.length === 0) {
  process.stdout.write("[module-sandbox] 未指定模組（--module 或 MODULE_SANDBOX_MODULES），略過\n");
  process.exit(0);
}

for (const moduleValue of moduleList) {
  const manifest = compileModule(moduleValue);
  process.stdout.write(
    `[module-sandbox] ${moduleValue}：${manifest.routes.length} 個 API 路由 → ${path.relative(ROOT, path.join(OUT_ROOT, moduleValue))}\n`
  );
}
