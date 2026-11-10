/**
 * 沙箱 runtime manager 測試（P1-9 Phase 2C）。
 * 用假 bundle 驗證：manifest 解析、permission 子程序、RPC、response 序列化。
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
    if (name === "@/lib/dal") {
      return { verifySession: async () => ({ uid: "u1", role: "admin" }) };
    }
    if (name === "@/lib/audit") {
      return { getClientIp: () => "127.0.0.1" };
    }
    if (name === "@/lib/module-secret") {
      return { moduleSecret: () => "module-secret" };
    }
    if (name === "@/lib/module-sandbox/host") {
      return { createHostRpc: () => async () => ({ ok: true }) };
    }
    return requireHost(name);
  },
  mod,
  mod.exports
);

const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-manager-test-"));
fs.writeFileSync(
  path.join(bundleDir, "manifest.json"),
  JSON.stringify(
    {
      moduleValue: "testModule",
      routes: [{ path: "/api/test", file: "route.mjs", methods: ["GET"] }],
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(bundleDir, "route.mjs"),
  `export async function GET() {
  const result = await globalThis.__sandboxRpc("demo.ping", { value: 21 });
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  };
}
`
);

try {
  const response = await mod.exports.runSandboxedRequest({
    moduleValue: "testModule",
    routePath: "/api/test",
    method: "GET",
    request: { url: "/api/test", headers: {} },
    bundleDir,
    rpc: (method, params) => ({ method, params }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.binary, false);
  assert.deepEqual(JSON.parse(response.body), {
    method: "demo.ping",
    params: { value: 21 },
  });

  process.stdout.write(
    "[module-sandbox-manager] manifest、permission 子程序、RPC 與 response 序列化全部通過\n"
  );
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}
