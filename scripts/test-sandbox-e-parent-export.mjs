/**
 * E 家長端與 Word 匯出沙箱 pilot（P1-9 Phase 2C）。
 * 用 E 真正的 parent GET 與 exports POST route，透過正式 manager 在 permission 子程序執行。
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

const parentSession = {
  uid: "p1",
  role: "parent",
  account: "p1",
  name: "王大明",
  displayName: "王大明",
  __entry: {
    studentId: "S001",
    grade: "1",
    classCode: "101",
    name: "王大明",
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
  instructions: "請家長撥空與孩子討論學習進度。",
  documentExports: { canva: true, googleDocs: true, word: true },
};

const planData = {
  studentUid: "s1",
  period: "114-1",
  status: "approved",
  parentVisible: true,
  topic: "校園植物觀察",
  studyGroup: "自然科學",
  advisor: "陳老師",
  learningGoals: "<p>認識校園植物</p>",
  weeks: [{ week: 1, content: "觀察校園植物", venue: "圖書館", timing: "flexible" }],
  submittedAt: now - 86_400_000,
  updatedAt: now - 3_600_000,
  createdAt: now - 86_400_000,
};

const reviewData = {
  planId: "114-1_s1",
  reviewerUid: "t1",
  reviewerName: "陳老師",
  decision: "approved",
  note: "計畫完整，請依進度執行。",
  reviewedAt: now - 1_800_000,
};

const fakeRpc = (method, params) => {
  switch (method) {
    case "session.get":
      if (params?.requiredRole === "parent") {
        return { context: { session: parentSession }, session: parentSession, denial: null };
      }
      return { context: { session: studentSession }, session: studentSession, denial: null };
    case "db.doc.get":
      return { exists: true, data: settingsData };
    case "db.doc.set":
    case "db.doc.update":
    case "db.doc.delete":
      return { ok: true };
    case "db.query":
      if (params?.collection === "rosterStudents") {
        return {
          rows: [
            {
              id: "114-1_101_S001",
              data: {
                uid: "s1",
                name: "王小明",
                studentId: "S001",
                grade: "1",
                classCode: "101",
                className: "一年一班",
                academicYear: 114,
                semester: 1,
                status: "active",
              },
            },
          ],
        };
      }
      if (params?.collection === "selfDirectedLearningPlans") {
        return { rows: [{ id: "114-1_s1", data: planData }] };
      }
      if (params?.collection === "selfDirectedLearningReviews") {
        return { rows: [{ id: "r1", data: reviewData }] };
      }
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

const parentResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "selfDirectedLearning",
  routePath: "/api/parent/self-directed-learning",
  method: "GET",
  request: {
    url: "/api/parent/self-directed-learning",
    headers: {},
  },
  rpc: fakeRpc,
});

assert.equal(parentResponse.status, 200, parentResponse.body);
const parentBody = JSON.parse(parentResponse.body);
assert.equal(parentBody.success, true, parentResponse.body);
assert.equal(parentBody.child.name, "王小明");
assert.equal(parentBody.child.className, "一年一班");
assert.equal(parentBody.plan.topic, "校園植物觀察");
assert.equal(parentBody.latestReview.note, "計畫完整，請依進度執行。");
assert.equal(parentBody.hiddenByStudent, false);

const exportResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "selfDirectedLearning",
  routePath: "/api/student/self-directed-learning/exports",
  method: "POST",
  request: {
    url: "/api/student/self-directed-learning/exports",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      style: "formal",
      payload: {
        period: "114-1",
        studentName: "王小明",
        className: "一年一班",
        topic: "校園植物觀察",
        studyGroup: "自然科學",
        advisor: "陳老師",
        learningGoals: "<p>認識校園植物</p>",
        reflection: "",
        source: "approved",
        layout: "separate",
        formalByStudent: false,
        weeks: [
          {
            week: 1,
            timing: "flexible",
            content: "觀察校園植物",
            venue: "圖書館",
            record: "",
          },
        ],
      },
    }),
  },
  rpc: fakeRpc,
});

assert.equal(exportResponse.status, 200, exportResponse.body);
assert.equal(exportResponse.binary, true, "Word 匯出應為二進位");
assert.match(
  exportResponse.headers["Content-Type"],
  /wordprocessingml\.document/
);
assert.match(exportResponse.headers["Content-Disposition"], /self-directed-learning\.docx/);
const file = Buffer.from(exportResponse.body, "base64");
assert.equal(file.subarray(0, 2).toString("latin1"), "PK", "DOCX 應為 zip 格式");

process.stdout.write(
  "[sandbox-e-parent-export] E 家長端讀取與 Word 匯出已由 manager 在 permission 子程序執行並回傳正確結果\n"
);
