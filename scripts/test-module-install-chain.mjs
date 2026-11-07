/**
 * production 安裝鏈純驗證測試（P0-5）。
 * 直接載入 src/lib/module-install-verify.ts，驗證：
 *   1. 版本號 `0.N` → `0.(N+1)`，日期沿用傳入值
 *   2. 版本檔格式錯誤 → 丟錯（fail-closed）
 *   3. tree 路徑 → 模組代碼抽取
 *   4. lock ↔ 目錄一致性（一致／缺資料夾／缺 lock）
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
  path.join(ROOT, "src", "lib", "module-install-verify.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const mod = { exports: {} };
new Function("require", "module", "exports", code)(requireHost, mod, mod.exports);
const { nextHostVersion, moduleValuesFromTreePaths, findLockTreeMismatch } = mod.exports;

assert.deepEqual(
  nextHostVersion('{"version":"0.646","date":"2026-11-07"}', "2026-11-08"),
  { version: "0.647", date: "2026-11-08" },
  "版本號應單調 +1"
);
assert.deepEqual(
  nextHostVersion('{"version":"1.9"}', "2026-11-08"),
  { version: "1.10", date: "2026-11-08" },
  "主版號應保留"
);
assert.throws(() => nextHostVersion("{not-json", "2026-11-08"), /不是合法 JSON/);
assert.throws(() => nextHostVersion('{"version":"v1"}', "2026-11-08"), /不是「主.次」格式/);
assert.throws(() => nextHostVersion("{}", "2026-11-08"), /不是「主.次」格式/);

assert.deepEqual(
  moduleValuesFromTreePaths([
    "src/modules/alpha/module.json",
    "src/modules/alpha/lib/x.ts",
    "src/modules/beta/page.tsx",
    "src/lib/not-a-module.ts",
  ]),
  ["alpha", "beta"],
  "只取 src/modules/<value>/ 的第一段"
);

const tree = [
  "src/modules/alpha/module.json",
  "src/modules/beta/module.json",
  "src/lib/x.ts",
];
assert.equal(findLockTreeMismatch(["alpha", "beta"], tree), null, "一致應回 null");
assert.deepEqual(findLockTreeMismatch(["alpha", "beta", "gamma"], tree), {
  missingDirs: ["gamma"],
  missingLock: [],
});
assert.deepEqual(findLockTreeMismatch(["alpha"], tree), {
  missingDirs: [],
  missingLock: ["beta"],
});

process.stdout.write(
  "[module-install-verify] 版本遞增、fail-closed、tree 抽取與 lock 一致性全部通過\n"
);
