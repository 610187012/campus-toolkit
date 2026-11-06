/**
 * module-check.mjs —— 模組靜態安全掃描（市集文件 §6.3 規則的 v1 務實版）
 *
 * 用法：
 *   node scripts/module-check.mjs <模組資料夾>   （npm run module:check -- <路徑>）
 *
 * 檢查項目（對應 §6.3；純字串/檔案掃描，非完美但可擋常見違規）：
 *   1. import 白名單＝主程式公開面＋宿主既有 npm 依賴＋模組內相對路徑
 *   2. 禁止 import 主程式核心寫入面（@/types/modules 等）
 *   5. 禁止新依賴（package.json.dependencies 非空）
 *   6. Firestore 集合字面值須在 dataCollections 宣告（掛勾集合自動豁免）
 *   8. 客戶端檔（"use client"）禁 localStorage/sessionStorage/document.cookie/eval/new Function
 *   9. 禁 import 其他模組資料夾
 * 規則 3/4/7/10 由 build-module-registry.mjs 掃描器負責，不重複。
 *
 * 任一違規 exit 1；全過輸出通過摘要。停用：MODULE_CHECK_SKIP=1。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_PKG = path.join(ROOT, "package.json");

/** 主程式公開面允許的 @/ 匯入（原文件 §3.3 允許表＋module-gate/module-db【E4】） */
const HOST_SURFACE_ALLOW = [
  "@/lib/dal",
  "@/lib/firebase-admin",
  "@/lib/csrf",
  "@/lib/rate-limit",
  "@/lib/audit",
  "@/lib/read-cache",
  "@/lib/list-cache",
  "@/lib/announcements",
  "@/lib/calendar",
  "@/lib/module-gate",
  "@/lib/module-db",
  "@/lib/module-host-data",
  "@/lib/settings-client",
  "@/lib/settings-server",
  "@/lib/session",
  "@/lib/data-saver",
  "@/lib/feature-modules",
  "@/lib/roster",
  "@/types/feature-modules",
  "@/types/settings",
  "@/types/users",
  "@/types/announcements",
  "@/types/calendar",
  "@/types/personal-info",
  "@/types/roster",
  "@/components/AdminSectionShell",
  "@/components/ModuleIcon",
  "@/components/AdSense",
  "@/components/Copyright",
  "@/components/DisclosureArrow",
  "@/components/RevealListCard",
  "@/components/Toast",
  "@/components/RoleLayout",
  "@/components/RolePageShell",
];
/** 主程式核心寫入面——一律禁止（§6.3-1） */
const HOST_FORBIDDEN = [
  "@/types/modules",
  "@/types/modules.generated",
  "@/app/api/settings",
  "@/app/admin/modules",
];
/** 掛豁免集合（掛勾設施；§6.3-3 由掃描器管寫入面，此處僅豁免集合宣告比對） */
const HOOK_COLLECTIONS = new Set(["announcements", "calendarEvents", "settings"]);
/** 客戶端檔危險模式（§6.3-8） */
const CLIENT_DANGER = [
  { re: /localStorage/, name: "localStorage" },
  { re: /sessionStorage/, name: "sessionStorage" },
  { re: /document\.cookie/, name: "document.cookie" },
  { re: /(^|[^.\w])eval\s*\(/, name: "eval()" },
  { re: /new\s+Function\s*\(/, name: "new Function()" },
];

const errors = [];
function fail(msg) {
  errors.push(msg);
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
    return { data: JSON.parse(raw), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function* walkFiles(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) yield full;
    }
  }
}

function main() {
  if (process.env.MODULE_CHECK_SKIP === "1") {
    process.stdout.write("[module-check] MODULE_CHECK_SKIP=1，略過掃描\n");
    return;
  }
  const targetArg = process.argv[2];
  if (!targetArg) {
    console.error("用法：node scripts/module-check.mjs <模組資料夾>");
    process.exit(1);
  }
  const moduleDir = path.resolve(targetArg);
  if (!fs.existsSync(moduleDir) || !fs.statSync(moduleDir).isDirectory()) {
    console.error(`[module-check] 模組資料夾不存在：${moduleDir}`);
    process.exit(1);
  }
  const manifestPath = path.join(moduleDir, "module.json");
  const manifest = readJson(manifestPath);
  if (manifest.error || !manifest.data) {
    console.error(`[module-check] module.json 無法解析：${manifest.error ?? "未知"}`);
    process.exit(1);
  }
  const moduleValue = typeof manifest.data.value === "string" ? manifest.data.value : "";
  const declaredCollections = new Set(
    Array.isArray(manifest.data.dataCollections)
      ? manifest.data.dataCollections.filter((c) => typeof c === "string")
      : []
  );

  // 規則 5：新依賴
  const pkgPath = path.join(moduleDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (pkg.data?.dependencies && Object.keys(pkg.data.dependencies).length > 0) {
      fail("package.json 含 dependencies（主程式零新依賴【E10】）");
    }
  }

  // 宿主既有 npm 依賴（bare import 白名單來源）
  const hostPkg = readJson(HOST_PKG);
  const hostDeps = new Set(Object.keys(hostPkg.data?.dependencies ?? {}));
  hostDeps.add("server-only");

  const rel = (file) => path.relative(moduleDir, file).split(path.sep).join("/");

  for (const file of walkFiles(moduleDir)) {
    const source = fs.readFileSync(file, "utf-8");
    const isClient = /^["']use client["'];?/m.test(source);
    const relFile = rel(file);

    // 規則 8：客戶端危險模式
    if (isClient) {
      for (const { re, name } of CLIENT_DANGER) {
        if (re.test(source)) fail(`${relFile}（"use client"）使用 ${name}【§6.3-8】`);
      }
    }

    // 規則 1/2/9：import 檢查
    const importRe = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g;
    let match;
    while ((match = importRe.exec(source)) !== null) {
      const spec = match[1];

      // 相對路徑（模組內）
      if (spec.startsWith("./") || spec.startsWith("../")) continue;

      if (!spec.startsWith("@/")) {
        // bare import：宿主既有依賴才可
        const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (!hostDeps.has(pkgName)) fail(`${relFile} import「${spec}」——非主程式既有依賴【E10】`);
        continue;
      }

      // 絕對 @/ 匯入
      if (HOST_FORBIDDEN.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`))) {
        fail(`${relFile} import「${spec}」——主程式核心寫入面禁止 import【§6.3-1】`);
        continue;
      }
      if (spec.startsWith("@/modules/")) {
        const rest = spec.slice("@/modules/".length);
        const other = rest.split("/")[0];
        if (other && other !== moduleValue) {
          fail(`${relFile} import「${spec}」——禁止 import 其他模組【§6.3-9】`);
        }
        continue;
      }
      const allowed = HOST_SURFACE_ALLOW.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`));
      if (!allowed) {
        fail(`${relFile} import「${spec}」——不在主程式公開面白名單【§6.3-1】`);
      }
    }

    // 規則 6：Firestore 集合字面值 vs dataCollections 宣告
    const collectionRe = /\.collection\(\s*["']([A-Za-z][A-Za-z0-9_]*)["']\s*\)/g;
    while ((match = collectionRe.exec(source)) !== null) {
      const name = match[1];
      if (!declaredCollections.has(name) && !HOOK_COLLECTIONS.has(name)) {
        fail(
          `${relFile} 存取未宣告集合「${name}」——請在 module.json dataCollections 宣告【§6.3-6】`
        );
      }
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`[module-check] 錯誤：${e}`);
    console.error(`[module-check] 共 ${errors.length} 個問題，掃描未通過。`);
    process.exit(1);
  }
  process.stdout.write(`[module-check] ${moduleValue} 靜態掃描通過\n`);
}

main();
