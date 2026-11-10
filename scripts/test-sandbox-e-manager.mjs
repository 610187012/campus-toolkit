/**
 * E（selfDirectedLearning）沙箱 pilot（P1-9 Phase 2C）。
 *
 * 用 E 真正的 admin GET route，透過正式 manager 在 permission 子程序執行；
 * 宿主 RPC 用假資料回傳學校作息／班級／空間／系統文件。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));

const build = spawnSync(
  process.execPath,
  [path.join(ROOT, "scripts", "build-module-sandbox.mjs"), "--module", "selfDirectedLearning"],
  { cwd: ROOT, encoding: "utf-8" }
);
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const swc = requireHost("next/dist/build/swc");
const source = fs.readFileSync(
  path.join(ROOT, "src", "lib", "module-sandbox", "manager.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});

class FakeNextResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers ?? {};
  }
  static json(body, init = {}) {
    return new FakeNextResponse(JSON.stringify(body), init);
  }
}

const fakeSession = {
  uid: "u1",
  role: "admin",
  account: "demo",
  name: "Demo Admin",
  displayName: "Demo Admin",
};

const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") {
      return { NextRequest: class {}, NextResponse: FakeNextResponse };
    }
    if (name === "@/lib/dal") return { verifySession: async () => fakeSession };
    if (name === "@/lib/audit") return { getClientIp: () => "127.0.0.1" };
    if (name === "@/lib/module-secret") return { moduleSecret: () => "module-secret" };
    if (name === "@/lib/module-sandbox/host") return { createHostRpc: () => async () => ({}) };
    return requireHost(name);
  },
  mod,
  mod.exports
);

const fakeRpc = (method, params) => {
  switch (method) {
    case "session.get":
      return { context: { session: fakeSession }, session: fakeSession, denial: null };
    case "db.doc.get":
      return { exists: false, data: null };
    case "db.doc.set":
    case "db.doc.update":
      return { ok: true };
    case "db.query":
      return { rows: [] };
    case "db.count":
      return { count: 0 };
    case "settings.period":
      return { academicYear: 114, semester: 1 };
    case "settings.cacheTtl":
      return 30;
    case "settings.readSystemDoc":
      return { classDayStart: "2026-02-01", classDayEnd: "2026-06-30" };
    case "host.schoolPeriods":
      return {
        schoolDays: [1, 2, 3, 4, 5],
        periods: [
          { code: "p1", name: "第一節", period: 1, start: "08:00", end: "08:45" },
        ],
      };
    case "host.schoolClasses":
      return {
        grades: [
          { name: "一年級", classes: [{ code: "101", name: "一年一班", grade: "1" }] },
        ],
      };
    case "host.spaceStructure":
      return { units: [] };
    case "roster.loadPeriodEntries":
      return [];
    case "calendar.list":
      return [];
    case "audit.log":
      return { ok: true };
    default:
      throw new Error(`測試未預期的 RPC：${method} ${JSON.stringify(params)}`);
  }
};

const response = await mod.exports.runSandboxedRequest({
  moduleValue: "selfDirectedLearning",
  routePath: "/api/admin/self-directed-learning",
  method: "GET",
  request: { url: "/api/admin/self-directed-learning", headers: {} },
  rpc: fakeRpc,
});

assert.equal(response.status, 200, response.body);
const body = JSON.parse(response.body);
assert.equal(body.success, true, response.body);
assert.ok(body.settings, "應回傳 settings");
assert.deepEqual(body.periodOptions.map((row) => row.code), ["p1"]);
assert.deepEqual(body.schoolDays, [1, 2, 3, 4, 5]);
assert.deepEqual(body.classOptions, [{ code: "101", name: "一年一班", grade: "一年級" }]);

process.stdout.write(
  "[sandbox-e-pilot] E 的 admin GET 已由 manager 在 permission 子程序執行並回傳正確結果\n"
);
