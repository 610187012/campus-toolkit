/**
 * E 學生端寫入沙箱 pilot（P1-9 Phase 2C）。
 * 用 E 真正的 student POST route，儲存一份草稿計畫。
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
    if (name === "@/lib/module-secret") return { moduleSecret: () => "module-secret" };
    if (name === "@/lib/module-sandbox/host") return { createHostRpc: () => async () => ({}) };
    return requireHost(name);
  },
  mod,
  mod.exports
);

const writes = [];
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
          maxDrafts: 10,
          maxDocumentPlans: 10,
          weekMode: "flexible",
          minWeeks: 6,
          venueEditable: true,
          venues: ["圖書館"],
        },
      };
    case "db.doc.set":
      writes.push({ method, params });
      return { ok: true };
    case "db.doc.update":
    case "db.doc.delete":
      return { ok: true };
    case "db.query":
      return { rows: [] };
    case "db.count":
      return { count: 0 };
    case "db.batch":
      return { ok: true };
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

const weeks = Array.from({ length: 6 }, (_, index) => ({
  content: `第 ${index + 1} 週學習內容`,
  venue: "圖書館",
  timing: "flexible",
}));

const response = await mod.exports.runSandboxedRequest({
  moduleValue: "selfDirectedLearning",
  routePath: "/api/student/self-directed-learning",
  method: "POST",
  request: {
    url: "/api/student/self-directed-learning",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "save",
      draft: {
        topic: "沙箱測試計畫",
        studyGroup: "自然科學",
        advisor: "",
        learningGoals: "",
        weeks,
      },
    }),
  },
  rpc: fakeRpc,
});

assert.equal(response.status, 200, response.body);
const body = JSON.parse(response.body);
assert.equal(body.success, true, response.body);
assert.equal(body.plan.topic, "沙箱測試計畫");
assert.equal(body.plan.status, "draft");
assert.equal(writes.length, 1, "應寫入一筆計畫");
assert.ok(writes[0].params.collection === "selfDirectedLearningPlans");

process.stdout.write(
  "[sandbox-e-write] E 學生端儲存草稿已由 manager 在 permission 子程序執行並正確寫入\n"
);
