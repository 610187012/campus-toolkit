/**
 * 沙箱網路政策測試（P1-9 Phase 2C）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
const swc = requireHost("next/dist/build/swc");
const source = fs.readFileSync(
  path.join(ROOT, "src", "lib", "module-sandbox", "network-policy.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const mod = { exports: {} };
new Function("require", "module", "exports", code)(requireHost, mod, mod.exports);
const { parseAllowedHosts, isPrivateHost, isAllowedSandboxUrl } = mod.exports;

const allowed = parseAllowedHosts(" api.canva.com, example.com ,api.canva.com ");
assert.deepEqual(allowed, ["api.canva.com", "example.com"]);

assert.equal(isPrivateHost("127.0.0.1"), true);
assert.equal(isPrivateHost("192.168.1.10"), true);
assert.equal(isPrivateHost("10.0.0.5"), true);
assert.equal(isPrivateHost("api.canva.com"), false);

assert.equal(isAllowedSandboxUrl("https://api.canva.com/rest/v1/x", allowed), true);
assert.equal(isAllowedSandboxUrl("https://sub.api.canva.com/x", allowed), true);
assert.equal(isAllowedSandboxUrl("https://evil.com/x", allowed), false);
assert.equal(isAllowedSandboxUrl("http://api.canva.com/x", allowed), false);
assert.equal(isAllowedSandboxUrl("https://127.0.0.1/x", allowed), false);
assert.equal(isAllowedSandboxUrl("not-a-url", allowed), false);
assert.equal(isAllowedSandboxUrl("https://api.canva.com/x", []), false);

// 開發用 localhost http 仍需在允許清單內
assert.equal(isAllowedSandboxUrl("http://localhost:3000/x", ["localhost"]), true);
assert.equal(isAllowedSandboxUrl("http://localhost:3000/x", []), false);

process.stdout.write("[sandbox-network-policy] 允許清單、https、內網與重新導向前的 URL 檢查全部通過\n");
