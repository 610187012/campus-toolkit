/**
 * E 教職員端沙箱 pilot（P1-9 Phase 2C）。
 * 用 E 真正的 staff GET（審核佇列）與 POST（通過），透過正式 manager 在 permission 子程序執行。
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

const staffSession = {
  uid: "t1",
  role: "staff",
  account: "t1",
  name: "陳老師",
  displayName: "陳老師",
  __entry: {
    uid: "t1",
    name: "陳老師",
    classCode: "101",
    attribute: "導師",
    managedModules: [],
  },
};

const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") {
      return { NextRequest: class {}, NextResponse: FakeNextResponse };
    }
    if (name === "@/lib/dal") return { verifySession: async () => staffSession };
    if (name === "@/lib/audit") return { getClientIp: () => "127.0.0.1" };
    if (name === "@/lib/module-secret")
      return { moduleSecret: () => "sandbox-test-module-secret-0123456789abcdef" };
    if (name === "@/lib/module-sandbox/host") return { createHostRpc: () => async () => ({}) };
    return requireHost(name);
  },
  mod,
  mod.exports
);

const now = Date.now();
const settingsData = {
  enabled: true,
  slots: [],
  maxDrafts: 10,
  maxDocumentPlans: 10,
  weekMode: "flexible",
  minWeeks: 6,
  venueEditable: true,
  venues: ["圖書館"],
  instructions: "",
  writingInstructions: "",
  documentExports: { canva: false, googleDocs: false, word: false },
  reviewStartAt: now - 86_400_000,
  reviewEndAt: now + 86_400_000,
  reviewers: [{ uid: "t1", name: "陳老師", classScoped: false, studentScoped: false }],
};

const planData = {
  studentUid: "s1",
  period: "114-1",
  status: "submitted",
  parentVisible: true,
  topic: "校園植物觀察",
  studyGroup: "自然科學",
  advisor: "陳老師",
  learningGoals: "<p>認識校園植物</p>",
  weeks: [{ week: 1, content: "觀察校園植物", venue: "圖書館", timing: "flexible" }],
  submittedAt: now - 3_600_000,
  updatedAt: now - 3_600_000,
  createdAt: now - 86_400_000,
};

const batchOps = [];
const fakeRpc = (method, params) => {
  switch (method) {
    case "session.get":
      return { context: { session: staffSession }, session: staffSession, denial: null };
    case "db.doc.get":
      if (params?.collection === "selfDirectedLearningSettings") {
        return { exists: true, id: params.id, data: settingsData };
      }
      if (params?.collection === "selfDirectedLearningPlans") {
        return { exists: true, id: params.id, data: planData };
      }
      if (params?.collection === "selfDirectedLearningLocks") {
        return { exists: false, id: params.id, data: null };
      }
      return { exists: true, id: params?.id, data: settingsData };
    case "db.doc.set":
    case "db.doc.update":
    case "db.doc.delete":
      return { ok: true };
    case "db.query":
      if (params?.collection === "selfDirectedLearningPlans") {
        return { rows: [{ id: "114-1_s1", data: planData }] };
      }
      return { rows: [] };
    case "db.count":
      return { count: 1 };
    case "db.batch":
      batchOps.push(...(params?.ops ?? []));
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

const listResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "selfDirectedLearning",
  routePath: "/api/staff/self-directed-learning",
  method: "GET",
  request: {
    url: "/api/staff/self-directed-learning?mode=review",
    headers: {},
  },
  rpc: fakeRpc,
});

assert.equal(listResponse.status, 200, listResponse.body);
const listBody = JSON.parse(listResponse.body);
assert.equal(listBody.success, true, listResponse.body);
assert.equal(listBody.mode, "review");
assert.equal(listBody.roles.isReviewer, true);
assert.equal(listBody.plans.length, 1);
assert.equal(listBody.plans[0].topic, "校園植物觀察");
assert.ok(Array.isArray(listBody.weekSchedule));

const approveResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "selfDirectedLearning",
  routePath: "/api/staff/self-directed-learning",
  method: "POST",
  request: {
    url: "/api/staff/self-directed-learning",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "approve",
      planId: "114-1_s1",
      note: "計畫完整，請依進度執行。",
    }),
  },
  rpc: fakeRpc,
});

assert.equal(approveResponse.status, 200, approveResponse.body);
const approveBody = JSON.parse(approveResponse.body);
assert.equal(approveBody.success, true, approveResponse.body);
assert.equal(approveBody.plan.status, "approved");
assert.equal(approveBody.plan.topic, "校園植物觀察");

const reviewWritten = batchOps.some(
  (op) => op.collection === "selfDirectedLearningReviews" && op.data?.planId === "114-1_s1"
);
assert.ok(reviewWritten, "應寫入審查意見");
const lockWritten = batchOps.some(
  (op) =>
    op.collection === "selfDirectedLearningLocks" &&
    op.data?.approvedPlanId === "114-1_s1"
);
assert.ok(lockWritten, "應更新送審鎖定文件的正式計畫");

process.stdout.write(
  "[sandbox-e-staff] E 教職員審核佇列與通過 transaction 已由 manager 在 permission 子程序執行並正確寫入\n"
);
