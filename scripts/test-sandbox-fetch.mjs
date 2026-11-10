/**
 * 沙箱 fetch 窗口測試（P1-9 Phase 2C）。
 * 驗證子程序的 fetch 被改成 host RPC，而不是直接連外網。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
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
    if (name === "@/lib/dal") return { verifySession: async () => ({}) };
    if (name === "@/lib/audit") return { getClientIp: () => "127.0.0.1" };
    if (name === "@/lib/module-secret") return { moduleSecret: () => "module-secret" };
    if (name === "@/lib/module-sandbox/host") return { createHostRpc: () => async () => ({}) };
    return requireHost(name);
  },
  mod,
  mod.exports
);

const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-fetch-test-"));
fs.writeFileSync(
  path.join(bundleDir, "manifest.json"),
  JSON.stringify({
    moduleValue: "fetchModule",
    routes: [{ path: "/api/fetch", file: "route.mjs", methods: ["GET"] }],
  })
);
fs.writeFileSync(
  path.join(bundleDir, "route.mjs"),
  `export async function GET() {
  const response = await fetch("https://api.example.com/data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a: 1 }),
  });
  const text = await response.text();
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  };
}
`
);

try {
  const response = await mod.exports.runSandboxedRequest({
    moduleValue: "fetchModule",
    routePath: "/api/fetch",
    method: "GET",
    request: { url: "/api/fetch", headers: {} },
    bundleDir,
    rpc: (method, params) => {
      if (method !== "net.fetch") throw new Error(`未預期 RPC：${method}`);
      assert.equal(params.url, "https://api.example.com/data");
      assert.equal(params.method, "POST");
      assert.equal(params.body, '{"a":1}');
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("hello").toString("base64"),
      };
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { text: "hello" });
  process.stdout.write(
    "[sandbox-fetch] 子程序 fetch 已改走 host RPC，請求與回應皆正確\n"
  );
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}
