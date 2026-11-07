/**
 * 模組安裝／卸載權限政策測試（P0-7）。
 * 直接載入 src/lib/module-install-policy.ts（純函式，零依賴），驗證：
 *   1. 未設定／空白 → 空清單（不限制）
 *   2. 逗號／分號／空白分隔、大小寫、重複值正規化
 *   3. 清單為空 → 任何 session 都通過
 *   4. 清單非空 → uid 或 email 命中才通過（不分大小寫）
 *   5. 缺 uid／email → 不通過
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
  path.join(ROOT, "src", "lib", "module-install-policy.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const mod = { exports: {} };
new Function("require", "module", "exports", code)(requireHost, mod, mod.exports);
const { parseModuleInstallAdmins, matchesModuleInstallAdmin } = mod.exports;

assert.deepEqual(parseModuleInstallAdmins(undefined), [], "undefined → 空清單");
assert.deepEqual(parseModuleInstallAdmins(null), [], "null → 空清單");
assert.deepEqual(parseModuleInstallAdmins("   "), [], "空白 → 空清單");

assert.deepEqual(
  parseModuleInstallAdmins("  UID-1, Admin@School.edu;;uid-2\nuid-1 "),
  ["uid-1", "admin@school.edu", "uid-2"],
  "分隔、大小寫與重複值應正規化"
);

assert.equal(matchesModuleInstallAdmin({ uid: "anyone" }, []), true, "空清單＝不限制");
assert.equal(
  matchesModuleInstallAdmin({ uid: "UID-1" }, ["uid-1"]),
  true,
  "uid 命中（不分大小寫）"
);
assert.equal(
  matchesModuleInstallAdmin({ email: "Admin@School.edu" }, ["admin@school.edu"]),
  true,
  "email 命中（不分大小寫）"
);
assert.equal(
  matchesModuleInstallAdmin({ uid: "uid-9", email: "other@school.edu" }, ["uid-1"]),
  false,
  "未命中應拒絕"
);
assert.equal(matchesModuleInstallAdmin({ uid: "uid-1" }, ["uid-2"]), false, "不同 uid 應拒絕");
assert.equal(matchesModuleInstallAdmin({}, ["uid-1"]), false, "缺 uid／email 應拒絕");
assert.equal(
  matchesModuleInstallAdmin({ uid: "", email: "" }, ["uid-1"]),
  false,
  "空字串 uid／email 應拒絕"
);

process.stdout.write(
  "[module-install-policy] 解析、大小寫、重複值、uid／email 命中與預設不限制全部通過\n"
);
