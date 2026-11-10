/**
 * G 學生端沙箱 pilot（P1-9 Phase 2C）。
 * 用 G 真正的 student route 讀取、儲存草稿與送出確認。
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
  [path.join(ROOT, "scripts", "build-module-sandbox.mjs"), "--module", "identityTaxInquiry"],
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
  openAt: now - 3_600_000,
  closeAt: now + 3_600_000,
  instructions: "<p>請依實際情形勾選。</p>",
  identityOptions: [
    {
      id: "low-income",
      label: "低收入戶子女",
      enabled: true,
      taxInquiry: true,
      exclusiveGroup: "lowIncome",
      fields: [],
    },
    {
      id: "disabled-student",
      label: "身心障礙學生",
      enabled: true,
      taxInquiry: false,
      exclusiveGroup: "",
      fields: [
        {
          id: "disability-level",
          type: "select",
          label: "障礙程度",
          required: true,
          options: [{ code: "mild", name: "輕度" }],
        },
      ],
    },
  ],
  updatedAt: now,
};

const records = new Map();
const writes = [];
const fakeRpc = (method, params) => {
  switch (method) {
    case "session.get":
      return { context: { session: studentSession }, session: studentSession, denial: null };
    case "db.doc.get":
      if (params?.collection === "identityTaxInquirySettings") {
        return { exists: true, id: params.id, data: settingsData };
      }
      if (params?.collection === "identityTaxInquiryRecords") {
        const data = records.get(params.id) ?? null;
        return { exists: Boolean(data), id: params.id, data };
      }
      return { exists: false, id: params?.id, data: null };
    case "db.doc.set":
      writes.push({ method, params });
      if (params?.collection === "identityTaxInquiryRecords") {
        records.set(params.id, params.data);
      }
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
    case "settings.featureModuleRoles":
      return { identityTaxInquiry: { student: true, parent: true, staff: true } };
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

const getResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/student/identity-tax-inquiry",
  method: "GET",
  request: { url: "/api/student/identity-tax-inquiry", headers: {} },
  rpc: fakeRpc,
});

assert.equal(getResponse.status, 200, getResponse.body);
const getBody = JSON.parse(getResponse.body);
assert.equal(getBody.success, true, getResponse.body);
assert.equal(getBody.record, null);
assert.equal(getBody.student.name, "王小明");
assert.equal(getBody.windowState, "open");
assert.equal(getBody.settings.identityOptions.length, 2);

const draftResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/student/identity-tax-inquiry",
  method: "POST",
  request: {
    url: "/api/student/identity-tax-inquiry",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "draft",
      identitySelections: [
        { optionId: "low-income", label: "低收入戶子女", values: {} },
      ],
      taxSubject: "both",
      father: { idNumber: "A123456789" },
      mother: { idNumber: "A223456789" },
      note: "草稿測試",
    }),
  },
  rpc: fakeRpc,
});

assert.equal(draftResponse.status, 200, draftResponse.body);
const draftBody = JSON.parse(draftResponse.body);
assert.equal(draftBody.success, true, draftResponse.body);
assert.equal(draftBody.record.status, "draft");
assert.equal(draftBody.record.identities[0], "低收入戶子女");
assert.equal(draftBody.record.taxInquiry.required, true);

const confirmResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/student/identity-tax-inquiry",
  method: "POST",
  request: {
    url: "/api/student/identity-tax-inquiry",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "confirm",
      personalDataConsent: true,
      personalDataConsentVersion: "2026-11-02",
      identitySelections: [
        { optionId: "low-income", label: "低收入戶子女", values: {} },
      ],
      taxSubject: "both",
      father: { idNumber: "A123456789" },
      mother: { idNumber: "A223456789" },
      note: "",
    }),
  },
  rpc: fakeRpc,
});

assert.equal(confirmResponse.status, 200, confirmResponse.body);
const confirmBody = JSON.parse(confirmResponse.body);
assert.equal(confirmBody.success, true, confirmResponse.body);
assert.equal(confirmBody.record.status, "confirmed");
assert.equal(confirmBody.record.personalDataConsent.version, "2026-11-02");
assert.ok(writes.some((write) => write.params.collection === "identityTaxInquiryRecords"));

process.stdout.write(
  "[sandbox-g-student] G 學生端讀取、儲存草稿與送出確認已由 manager 在 permission 子程序執行並正確寫入\n"
);
