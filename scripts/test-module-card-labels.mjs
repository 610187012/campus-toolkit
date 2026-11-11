/**
 * 功能入口卡片同名處理測試。
 * 驗證：單一同名不加作者、不同作者加作者、同作者再加模組代碼。
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
  path.join(ROOT, "src", "lib", "module-card-label.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});

const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { moduleCardLabels } = mod.exports;

assert.deepEqual(
  moduleCardLabels([
    { value: "selfDirectedLearning", label: "自主學習計畫", author: { author: "原創" } },
  ]),
  ["自主學習計畫"],
  "只有一個同名模組時，維持乾淨名稱"
);

assert.deepEqual(
  moduleCardLabels([
    { value: "selfDirectedLearningPlus", label: "自主學習計畫", author: { author: "帥哥" } },
    { value: "selfDirectedLearning", label: "自主學習計畫", author: { author: "原創" } },
  ]),
  ["自主學習計畫（帥哥）", "自主學習計畫（原創）"],
  "不同作者的同名模組，加上作者名"
);

assert.deepEqual(
  moduleCardLabels([
    { value: "selfDirectedLearningA", label: "自主學習計畫", author: { author: "帥哥" } },
    { value: "selfDirectedLearningB", label: "自主學習計畫", author: { author: "帥哥" } },
  ]),
  ["自主學習計畫（帥哥／selfDirectedLearningA）", "自主學習計畫（帥哥／selfDirectedLearningB）"],
  "同作者的同名模組，再加模組代碼"
);

assert.deepEqual(
  moduleCardLabels([
    { value: "a", label: "自主學習計畫" },
    { value: "b", label: "自主學習計畫" },
  ]),
  ["自主學習計畫（a）", "自主學習計畫（b）"],
  "沒有作者時，以模組代碼區分"
);

assert.deepEqual(
  moduleCardLabels([
    { value: "a", label: "自主學習計畫", author: { author: "甲" } },
    { value: "b", label: "身分財稅", author: { author: "乙" } },
  ]),
  ["自主學習計畫", "身分財稅"],
  "不同名稱不應被改名"
);

process.stdout.write(
  "[module-card-label] 同名加作者、同作者加代碼、不同名稱不變，全部通過\n"
);
