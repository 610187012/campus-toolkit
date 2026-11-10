/**
 * E Canva 設定檢查沙箱 pilot（P1-9 Phase 2C）。
 * 驗證 CANVA_* 環境變數傳遞、origin 檢查與設定窗口。
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

process.env.CANVA_CLIENT_ID = "test-client";
process.env.CANVA_CLIENT_SECRET = "test-secret";
process.env.CANVA_REDIRECT_URI =
  "http://localhost:3000/api/student/self-directed-learning/canva/callback";

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

const studentSession = {
  uid: "s1",
  role: "student",
  account: "s1",
  name: "王小明",
  displayName: "王小明",
  __entry: {
    grade: "1",
    classCode: "101",
    name: "王小明",
    studentId: "S001",
    seatNo: "1",
    className: "一年一班",
    rollNo: "10101",
  },
};

const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") {
      return { NextRequest: class {}, NextResponse: FakeNextResponse };
    }
    if (name === "@/lib/dal") return { verifySession: async () => studentSession };
    if (name === "@/lib/audit") return { getClientIp: () => "127.0.0.1" };
    if (name === "@/lib/module-secret")
      return { moduleSecret: () => "sandbox-test-module-secret-0123456789abcdef" };
    if (name === "@/lib/module-sandbox/host") return { createHostRpc: () => async () => ({}) };
    return requireHost(name);
  },
  mod,
  mod.exports
);

const fakeRpc = (method, params) => {
  switch (method) {
    case "session.get":
      if (params?.requiredRole) return { session: studentSession, denial: null };
      return { context: { session: studentSession }, session: studentSession, denial: null };
    case "db.doc.get":
      return {
        exists: true,
        data: {
          enabled: true,
          slots: [],
          documentExports: { canva: true },
        },
      };
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
  routePath: "/api/student/self-directed-learning/canva",
  method: "GET",
  request: {
    url: "/api/student/self-directed-learning/canva?op=config",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  },
  rpc: fakeRpc,
});

assert.equal(response.status, 200, response.body);
assert.deepEqual(JSON.parse(response.body), { success: true });

const authorize = await mod.exports.runSandboxedRequest({
  moduleValue: "selfDirectedLearning",
  routePath: "/api/student/self-directed-learning/canva",
  method: "POST",
  request: {
    url: "/api/student/self-directed-learning/canva",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ op: "authorize", agreed: true }),
  },
  rpc: fakeRpc,
});

assert.equal(authorize.status, 200, authorize.body);
const authorizeBody = JSON.parse(authorize.body);
assert.equal(authorizeBody.success, true, authorize.body);
assert.match(authorizeBody.url, /^https:\/\/www\.canva\.com\/api\/oauth\/authorize\?/);
assert.equal(authorize.cookies.length, 3, "應設定 state 與兩個清除 cookie");
assert.equal(authorize.cookies[0].name, "sdl_canva_state");
assert.ok(authorize.cookies[0].value.length > 40);
assert.equal(authorize.cookies[0].options.httpOnly, true);
assert.equal(authorize.cookies[1].options.maxAge, 0);
assert.equal(authorize.cookies[2].options.maxAge, 0);

const connection = await mod.exports.runSandboxedRequest({
  moduleValue: "selfDirectedLearning",
  routePath: "/api/student/self-directed-learning/canva",
  method: "GET",
  request: {
    url: "/api/student/self-directed-learning/canva?op=connection",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
      cookie: `${authorize.cookies[0].name}=${authorize.cookies[0].value}`,
    },
  },
  rpc: fakeRpc,
});

assert.equal(connection.status, 200, connection.body);
assert.deepEqual(JSON.parse(connection.body), { success: true, ready: false });

process.stdout.write(
  "[sandbox-e-canva] E Canva 設定檢查與 authorize 已由 manager 在 permission 子程序執行，jose＋CANVA_*＋cookie 回傳正常\n"
);
