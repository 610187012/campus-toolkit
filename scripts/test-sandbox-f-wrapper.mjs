/**
 * 正式 adapter 包裝測試（P1-9 Phase 2C）。
 *
 * 驗證 `withModuleSandbox`：
 *   - 讀 MODULE_SANDBOX_MODULES 開關
 *   - 檢查 manifest
 *   - 序列化 NextRequest
 *   - 啟動 F 的正式 bundle
 *   - 透過 host RPC 回傳結果
 *   - 轉成 NextResponse
 *
 * 用假 session／假 RPC；真實 Firestore 需要部署環境憑證。
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
  [path.join(ROOT, "scripts", "build-module-sandbox.mjs"), "--module", "examRegistration"],
  { cwd: ROOT, encoding: "utf-8" }
);
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

process.env.MODULE_SANDBOX_MODULES = "examRegistration";

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

const fakeRpc = (method, params) => {
  if (method === "session.get") {
    if (params?.requiredRole) return { session: fakeSession, denial: null };
    if (params?.moduleValue) return { context: { session: fakeSession }, denial: null };
    return { session: fakeSession, denial: null };
  }
  if (method === "db.count") return { count: 3 };
  if (method === "db.query") return { rows: [] };
  if (method === "settings.period") return { academicYear: 114, semester: 1 };
  if (method === "settings.cacheTtl") return 30;
  if (method === "audit.log") return { ok: true };
  throw new Error(`測試未預期的 RPC：${method}`);
};

const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") {
      return { NextRequest: class {}, NextResponse: FakeNextResponse };
    }
    if (name === "@/lib/dal") {
      return { verifySession: async () => fakeSession };
    }
    if (name === "@/lib/audit") {
      return { getClientIp: () => "127.0.0.1" };
    }
    if (name === "@/lib/module-sandbox/host") {
      return { createHostRpc: () => fakeRpc };
    }
    return requireHost(name);
  },
  mod,
  mod.exports
);

const original = async () => ({ status: 599, body: "original" });
const wrapped = mod.exports.withModuleSandbox(
  "examRegistration",
  "/api/admin/exam-registration",
  original
);

const request = {
  method: "GET",
  headers: new globalThis.Headers({}),
  nextUrl: new globalThis.URL("http://localhost/api/admin/exam-registration?summary=count"),
  text: async () => "",
};

const response = await wrapped(request);
assert.equal(response.status, 200, String(response.body).slice(0, 120));
assert.deepEqual(JSON.parse(response.body), { success: true, total: 3 });
process.stdout.write(
  "[sandbox-f-wrapper] 正式 adapter 已把請求送進 F bundle 並回傳正確結果\n"
);
