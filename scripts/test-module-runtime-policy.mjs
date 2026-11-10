/**
 * 模組 API runtime wrapper 政策測試（P0-8）。
 * 直接載入 src/lib/module-runtime-policy.ts（純函式）驗證路徑角色、
 * 模組閘門、CSRF 方法與宿主層限流上限。
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
  path.join(ROOT, "src", "lib", "module-runtime-policy.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const mod = { exports: {} };
new Function("require", "module", "exports", code)(requireHost, mod, mod.exports);
const {
  roleFromApiPath,
  roleFromPagePath,
  needsModuleGate,
  isMutatingMethod,
  runtimeRateLimit,
  isRuntimeRole,
} = mod.exports;

assert.equal(roleFromApiPath("/api/admin/exam-registration"), "admin");
assert.equal(roleFromApiPath("/api/admin"), "admin");
assert.equal(roleFromApiPath("/api/student/self-directed-learning"), "student");
assert.equal(roleFromApiPath("/api/parent/exam-registration"), "parent");
assert.equal(roleFromApiPath("/api/staff/identity-tax-inquiry"), "staff");
assert.equal(roleFromApiPath("/api/exam-registration"), null, "無角色前綴僅要求登入");
assert.equal(roleFromApiPath("/api/administer"), null, "不可前綴誤判");

assert.equal(roleFromPagePath("/admin/exam-registration"), "admin");
assert.equal(roleFromPagePath("/admin"), "admin");
assert.equal(roleFromPagePath("/student/self-directed-learning"), "student");
assert.equal(roleFromPagePath("/parent/exam-registration"), "parent");
assert.equal(roleFromPagePath("/staff/identity-tax-inquiry"), "staff");
assert.equal(roleFromPagePath("/recreation"), null, "無角色前綴僅要求登入");
assert.equal(roleFromPagePath("/administrator"), null, "不可前綴誤判");

assert.equal(needsModuleGate("/api/student/x"), true);
assert.equal(needsModuleGate("/api/parent/x"), true);
assert.equal(needsModuleGate("/api/staff/x"), true);
assert.equal(needsModuleGate("/api/admin/x"), false, "管理端不套用模組啟用閘門");
assert.equal(needsModuleGate("/api/exam-registration"), false);

for (const method of ["POST", "put", "Patch", "DELETE"]) {
  assert.equal(isMutatingMethod(method), true, `${method} 應視為寫入`);
}
for (const method of ["GET", "HEAD", "options"]) {
  assert.equal(isMutatingMethod(method), false, `${method} 不應視為寫入`);
}

assert.equal(runtimeRateLimit("GET"), 240);
assert.equal(runtimeRateLimit("POST"), 120);
assert.equal(runtimeRateLimit("DELETE"), 120);

assert.equal(isRuntimeRole("admin"), true);
assert.equal(isRuntimeRole("teacher"), false);
assert.equal(isRuntimeRole(null), false);

process.stdout.write(
  "[module-runtime-policy] 路徑角色、模組閘門、CSRF 方法與限流上限全部通過\n"
);
