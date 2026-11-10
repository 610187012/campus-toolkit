/**
 * G 家長端與教職員端沙箱 pilot（P1-9 Phase 2C）。
 * 用 G 真正的 parent GET、staff GET 與 staff POST（財稅查調狀態）。
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

const parentSession = {
  uid: "p1",
  role: "parent",
  account: "p1",
  name: "王大明",
  displayName: "王大明",
  __entry: { studentId: "S001", grade: "1", classCode: "101", name: "王大明" },
};

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
    attribute: "兼導師",
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
  ],
  updatedAt: now,
};

const recordData = {
  period: "114-1",
  studentUid: "s1",
  studentName: "王小明",
  grade: "1",
  classCode: "101",
  className: "一年一班",
  identities: ["低收入戶子女"],
  identitySelections: [
    { optionId: "low-income", label: "低收入戶子女", values: {} },
  ],
  taxSubject: "both",
  father: { idNumber: "A123456789" },
  mother: { idNumber: "A223456789" },
  self: { idNumber: "" },
  guardian: { idNumber: "" },
  note: "",
  status: "confirmed",
  confirmedAt: now - 1_000_000,
  personalDataConsent: { version: "2026-11-02", agreedAt: now - 1_000_000 },
  taxInquiry: {
    required: true,
    status: "pending",
    note: "",
    updatedBy: "",
    updatedByName: "",
    updatedAt: 0,
  },
  updatedAt: now - 1_000_000,
};

const records = new Map([["114-1_s1", recordData]]);
const writes = [];
let currentSession = parentSession;
const fakeRpc = (method, params) => {
  switch (method) {
    case "session.get":
      if (params?.requiredRole === "parent") currentSession = parentSession;
      else if (params?.requiredRole === "staff") currentSession = staffSession;
      return { context: { session: currentSession }, session: currentSession, denial: null };
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
        records.set(params.id, { ...records.get(params.id), ...params.data });
      }
      return { ok: true };
    case "db.doc.update":
    case "db.doc.delete":
      return { ok: true };
    case "db.query":
      if (params?.collection === "identityTaxInquiryRecords") {
        return { rows: [{ id: "114-1_s1", data: records.get("114-1_s1") }] };
      }
      if (params?.collection === "rosterStudents") {
        return {
          rows: [
            {
              id: "114-1_101_S001",
              data: {
                uid: "s1",
                name: "王小明",
                studentId: "S001",
                seatNo: "1",
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

const parentResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/parent/identity-tax-inquiry",
  method: "GET",
  request: { url: "/api/parent/identity-tax-inquiry", headers: {} },
  rpc: fakeRpc,
});

assert.equal(parentResponse.status, 200, parentResponse.body);
const parentBody = JSON.parse(parentResponse.body);
assert.equal(parentBody.success, true, parentResponse.body);
assert.equal(parentBody.child.name, "王小明");
assert.equal(parentBody.record.status, "confirmed");
assert.notEqual(parentBody.record.father.idNumber, "A123456789", "家長端應遮蔽身分證字號");
assert.match(parentBody.record.father.idNumber, /＊/);

const staffListResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/staff/identity-tax-inquiry",
  method: "GET",
  request: { url: "/api/staff/identity-tax-inquiry", headers: {} },
  rpc: fakeRpc,
});

assert.equal(staffListResponse.status, 200, staffListResponse.body);
const staffListBody = JSON.parse(staffListResponse.body);
assert.equal(staffListBody.success, true, staffListResponse.body);
assert.equal(staffListBody.roles.isTutor, true);
assert.equal(staffListBody.rows.length, 1);
assert.equal(staffListBody.rows[0].status, "confirmed");
assert.equal(staffListBody.rows[0].taxInquiry.status, "pending");

const updateResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/staff/identity-tax-inquiry",
  method: "POST",
  request: {
    url: "/api/staff/identity-tax-inquiry",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      studentUid: "s1",
      status: "done",
      note: "已完成查調",
    }),
  },
  rpc: fakeRpc,
});

assert.equal(updateResponse.status, 200, updateResponse.body);
const updateBody = JSON.parse(updateResponse.body);
assert.equal(updateBody.success, true, updateResponse.body);
assert.equal(updateBody.record.taxInquiry.status, "done");
assert.equal(updateBody.record.taxInquiry.note, "已完成查調");
assert.ok(
  writes.some(
    (write) =>
      write.params.collection === "identityTaxInquiryRecords" &&
      write.params.data?.taxInquiry?.status === "done"
  ),
  "應寫入財稅查調狀態"
);

process.stdout.write(
  "[sandbox-g-parent-staff] G 家長端遮蔽讀取與教職員財稅查調更新已由 manager 在 permission 子程序執行並正確寫入\n"
);
