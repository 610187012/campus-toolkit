/**
 * F 的正式沙箱 bundle 測試（P1-9 Phase 2C）。
 *
 * 流程：build-module-sandbox 編譯 F → manager 啟動 permission 子程序 →
 * 用假 RPC 回傳 Firestore 結果 → 驗證 F 的回應。
 *
 * 這是「正式 manager + 正式編譯產物」的整合測試；Next.js 認證尚未接入。
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

const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") {
      return { NextRequest: class {}, NextResponse: FakeNextResponse };
    }
    if (name === "@/lib/dal") {
      return { verifySession: async () => ({ uid: "u1", role: "admin" }) };
    }
    if (name === "@/lib/audit") {
      return { getClientIp: () => "127.0.0.1" };
    }
    if (name === "@/lib/module-sandbox/host") {
      return { createHostRpc: () => async () => ({ ok: true }) };
    }
    return requireHost(name);
  },
  mod,
  mod.exports
);

const response = await mod.exports.runSandboxedRequest({
  moduleValue: "examRegistration",
  routePath: "/api/admin/exam-registration",
  method: "GET",
  request: { url: "/api/admin/exam-registration?summary=count", headers: {} },
  rpc: (method) => {
    if (method === "session.get") {
      return {
        session: { uid: "u1", role: "admin", account: "demo" },
        denial: null,
      };
    }
    if (method === "db.count") return { count: 3 };
    if (method === "db.query") return { rows: [] };
    if (method === "settings.period") return { academicYear: 114, semester: 1 };
    if (method === "settings.cacheTtl") return 30;
    if (method === "audit.log") return { ok: true };
    throw new Error(`測試未預期的 RPC：${method}`);
  },
});

assert.equal(response.status, 200, response.body);
assert.deepEqual(JSON.parse(response.body), { success: true, total: 3 });
process.stdout.write(
  "[sandbox-f-manager] F 的正式 bundle 已由 manager 在 permission 子程序執行並回傳正確結果\n"
);
