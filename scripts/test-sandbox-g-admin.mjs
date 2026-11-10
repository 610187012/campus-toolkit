/**
 * G 管理端沙箱 pilot（P1-9 Phase 2C）。
 * 用 G 真正的 admin route 讀取名冊、匯出 CSV 與儲存設定。
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

const adminSession = {
  uid: "a1",
  role: "admin",
  account: "a1",
  name: "管理員",
  displayName: "管理員",
  __entry: { uid: "a1", name: "管理員", managedModules: [] },
};

const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") {
      return { NextRequest: class {}, NextResponse: FakeNextResponse };
    }
    if (name === "@/lib/dal") return { verifySession: async () => adminSession };
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

const writes = [];
const fakeRpc = (method, params) => {
  switch (method) {
    case "session.get":
      return {
        context: { kind: "admin", session: adminSession, permissions: [] },
        session: adminSession,
        denial: null,
      };
    case "db.doc.get":
      if (params?.collection === "identityTaxInquirySettings") {
        return { exists: true, id: params.id, data: settingsData };
      }
      return { exists: false, id: params?.id, data: null };
    case "db.doc.set":
      writes.push({ method, params });
      return { ok: true };
    case "db.doc.update":
    case "db.doc.delete":
      return { ok: true };
    case "db.query":
      if (params?.collection === "identityTaxInquiryRecords") {
        return { rows: [{ id: "114-1_s1", data: recordData }] };
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

const recordsResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/admin/identity-tax-inquiry",
  method: "GET",
  request: {
    url: "/api/admin/identity-tax-inquiry?mode=records&classCode=101",
    headers: {},
  },
  rpc: fakeRpc,
});

assert.equal(recordsResponse.status, 200, recordsResponse.body);
const recordsBody = JSON.parse(recordsResponse.body);
assert.equal(recordsBody.success, true, recordsResponse.body);
assert.equal(recordsBody.rows.length, 1);
assert.equal(recordsBody.rows[0].status, "confirmed");
assert.equal(recordsBody.rows[0].studentName, "王小明");
assert.equal(recordsBody.rows[0].identities[0], "低收入戶子女");
assert.equal(recordsBody.stats.confirmed, 1);

const csvResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/admin/identity-tax-inquiry",
  method: "GET",
  request: {
    url: "/api/admin/identity-tax-inquiry?format=csv&classCode=101",
    headers: {},
  },
  rpc: fakeRpc,
});

assert.equal(csvResponse.status, 200, csvResponse.body);
assert.match(csvResponse.headers["Content-Type"], /text\/csv/);
assert.ok(csvResponse.body.startsWith("\uFEFF"), "CSV 應含 BOM");
assert.ok(csvResponse.body.includes("王小明"), "CSV 應含學生姓名");

const saveResponse = await mod.exports.runSandboxedRequest({
  moduleValue: "identityTaxInquiry",
  routePath: "/api/admin/identity-tax-inquiry",
  method: "POST",
  request: {
    url: "/api/admin/identity-tax-inquiry",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      enabled: true,
      openAt: now - 3_600_000,
      closeAt: now + 3_600_000,
      instructions: "<p>更新後的說明</p>",
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
    }),
  },
  rpc: fakeRpc,
});

assert.equal(saveResponse.status, 200, saveResponse.body);
const saveBody = JSON.parse(saveResponse.body);
assert.equal(saveBody.success, true, saveResponse.body);
assert.equal(saveBody.settings.identityOptions[0].label, "低收入戶子女");
const settingsWrite = writes.find(
  (write) => write.params.collection === "identityTaxInquirySettings"
);
assert.ok(settingsWrite, "應寫入模組設定");
assert.equal(settingsWrite.params.id, "default");

process.stdout.write(
  "[sandbox-g-admin] G 管理端名冊、CSV 匯出與設定儲存已由 manager 在 permission 子程序執行並正確寫入\n"
);
