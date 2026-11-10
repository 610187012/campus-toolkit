/**
 * 沙箱資源上限測試（P1-9 Phase 2C 收尾）。
 * 驗證同一模組同時請求超過上限時會被拒絕，且請求結束後名額會釋放。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
const PROBE_DIR = path.join(ROOT, ".module-sandbox", "sandboxLimits");

fs.rmSync(PROBE_DIR, { recursive: true, force: true });
fs.mkdirSync(PROBE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(PROBE_DIR, "route.mjs"),
  `export async function POST(request) {
  const body = await request.json();
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, id: body.id }),
    binary: false,
    cookies: [],
  };
}
`
);
fs.writeFileSync(
  path.join(PROBE_DIR, "manifest.json"),
  `${JSON.stringify(
    {
      moduleValue: "sandboxLimits",
      routes: [{ path: "/api/limits", file: "route.mjs", methods: ["POST"] }],
    },
    null,
    2
  )}\n`
);

process.env.MODULE_SANDBOX_MODULES = "sandboxLimits";

const swc = requireHost("next/dist/build/swc");
const source = fs.readFileSync(
  path.join(ROOT, "src", "lib", "module-sandbox", "manager.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});

const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") {
      return {
        NextRequest: class {},
        NextResponse: class {
          static json(body, init = {}) {
            return { body: JSON.stringify(body), status: init.status ?? 200 };
          }
        },
      };
    }
    if (name === "@/lib/dal") return { verifySession: async () => ({}) };
    if (name === "@/lib/audit") return { getClientIp: () => "127.0.0.1" };
    if (name === "@/lib/module-secret") return { moduleSecret: () => "x" };
    if (name === "@/lib/module-sandbox/host") return { createHostRpc: () => async () => ({}) };
    return requireHost(name);
  },
  mod,
  mod.exports
);

const call = (id) =>
  mod.exports.runSandboxedRequest({
    moduleValue: "sandboxLimits",
    routePath: "/api/limits",
    method: "POST",
    request: {
      url: "/api/limits",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    },
    rpc: async () => ({}),
  });

const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => call(index)));
const fulfilled = results.filter((result) => result.status === "fulfilled");
const rejected = results.filter((result) => result.status === "rejected");
assert.equal(fulfilled.length, 4, "最多同時 4 個請求");
assert.equal(rejected.length, 2, "超過上限的請求應被拒絕");
assert.ok(
  rejected.every((result) => result.reason.message.includes("同時請求過多")),
  "拒絕原因應為同時請求過多"
);
for (const result of fulfilled) {
  assert.equal(result.value.status, 200);
}

const after = await call("after");
assert.equal(after.status, 200, "請求結束後應釋放名額");

fs.rmSync(PROBE_DIR, { recursive: true, force: true });

process.stdout.write(
  "[sandbox-limits] 同時請求上限與名額釋放已驗證\n"
);
