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
 *   6. Firestore 集合字面值須在 dataCollections 宣告；核心個資集合可讀不可寫；
 *      設施集合（announcements／calendarEvents）一律走掛勾函式，不可直接存取
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
/** 掛鉤設施集合：不可直接讀寫，一律走 publishFromModule／publishScheduleFromModule */
const HOST_FACILITY_COLLECTIONS = new Set(["announcements", "calendarEvents"]);
/** 宿主保留集合：模組不得宣告或直接存取（P0-2） */
const HOST_RESERVED_COLLECTIONS = new Set(["users", "settings", "activityLog", "revokedJTIs"]);
/** 核心個資集合：可讀不可寫（P0-2 v2） */
const HOST_CORE_READONLY_COLLECTIONS = new Set([
  "rosterStudents",
  "rosterParents",
  "rosterStaff",
  "rosterAdmins",
  "studentPersonalInfo",
  "studentPersonalIdentity",
  "studentPersonalPhoto",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 核心集合的直接寫入樣式（鏈式呼叫；變數型別仍靠 runtime scopedDb 擋） */
function coreWritePatterns(name) {
  const quoted = `["'\x60]${escapeRegExp(name)}["'\x60]`;
  return [
    new RegExp(
      `\\.collection\\(\\s*${quoted}\\s*\\)\\s*(?:\\.doc\\([^)]*\\)\\s*)?\\.(?:add|set|update|delete|create)\\s*\\(`
    ),
    new RegExp(
      `\\.doc\\(\\s*["'\x60]${escapeRegExp(name)}\\/[^"'\x60]*["'\x60]\\s*\\)\\s*\\.(?:set|update|delete|create)\\s*\\(`
    ),
  ];
}

function hasCoreWrite(source, name) {
  return coreWritePatterns(name).some((re) => re.test(source));
}
/** 客戶端檔危險模式（§6.3-8） */
const CLIENT_DANGER = [
  { re: /localStorage/, name: "localStorage" },
  { re: /sessionStorage/, name: "sessionStorage" },
  { re: /document\.cookie/, name: "document.cookie" },
  { re: /(^|[^.\w])eval\s*\(/, name: "eval()" },
  { re: /new\s+Function\s*\(/, name: "new Function()" },
];
/** 伺服器檔危險模式（P1-9 第一階段：不執行任意程式碼） */
const SERVER_DANGER = [
  { re: /(^|[^.\w])eval\s*\(/, name: "eval()" },
  { re: /new\s+Function\s*\(/, name: "new Function()" },
  { re: /process\.(?:binding|exit|kill|mainModule)\b/, name: "process 危險 API" },
];
/** 宿主秘密環境變數：模組不得讀取（P1-9） */
const HOST_SECRET_ENV_KEYS = [
  "FIREBASE_SERVICE_ACCOUNT_KEY",
  "MODULE_MARKET_GITHUB_TOKEN",
  "THEME_MARKET_GITHUB_TOKEN",
  "SMTP_PASS",
  "VERCEL_TOKEN",
  "TOTP_ENCRYPTION_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "MODULE_MARKET_INSTALL_ADMINS",
];
/** 一次枚舉整個 process.env 也不行（即使沒有直接寫出金鑰名稱） */
const ENV_ENUMERATION = [
  /Object\.(?:keys|values|entries|assign)\(\s*process\.env\b/,
  /JSON\.stringify\(\s*process\.env\b/,
  /\.\.\.\s*process\.env\b/,
  /for\s*\(\s*(?:const|let|var)\s+[^)]*\bin\s+process\.env\b/,
];
const SCRIPT_TEST_RE = /^(?:scripts|tests?)\//;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const DYNAMIC_IMPORT_DYNAMIC_RE = /\bimport\s*\(\s*[A-Za-z_$]/;
const DOC_PATH_RE = /\.doc\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

function isScriptOrTest(rel) {
  return SCRIPT_TEST_RE.test(rel);
}

/** 找出真正的 "use client"（允許前面有註解／空白） */
function isUseClient(source) {
  const stripped = source
    .replace(/^\uFEFF/, "")
    .replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return /^["']use client["']/.test(stripped);
}

/** 相對 import：解析後必須在模組資料夾內；執行期檔案不可 import scripts/tests 內的東西 */
function checkRelativeImport(spec, relFile, file, moduleDir, fail) {
  const resolved = path.resolve(path.dirname(file), spec);
  const targetRel = path.relative(moduleDir, resolved);
  if (targetRel.startsWith("..") || path.isAbsolute(targetRel)) {
    fail(`${relFile} import「${spec}」——相對路徑逃出模組資料夾【P0-3】`);
    return;
  }
  const normalized = targetRel.split(path.sep).join("/");
  if (!isScriptOrTest(relFile) && isScriptOrTest(normalized)) {
    fail(`${relFile} import「${spec}」——執行期檔案不可 import scripts/tests 內容【P0-3】`);
  }
}

/** 單一 import spec 的白名單檢查（靜態與動態 import 共用） */
function checkImportSpec(spec, relFile, file, moduleDir, moduleValue, hostDeps, fail) {
  if (spec.startsWith(".")) {
    checkRelativeImport(spec, relFile, file, moduleDir, fail);
    return;
  }
  if (spec.startsWith("node:")) {
    if (!isScriptOrTest(relFile)) {
      fail(`${relFile} import「${spec}」——執行期檔案禁用 node: 內建模組【P0-3】`);
    }
    return;
  }
  if (!spec.startsWith("@/")) {
    const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!hostDeps.has(pkgName)) fail(`${relFile} import「${spec}」——非主程式既有依賴【E10】`);
    return;
  }
  if (HOST_FORBIDDEN.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`))) {
    fail(`${relFile} import「${spec}」——主程式核心寫入面禁止 import【§6.3-1】`);
    return;
  }
  if (spec.startsWith("@/modules/")) {
    const rest = spec.slice("@/modules/".length);
    const other = rest.split("/")[0];
    if (other && other !== moduleValue) {
      fail(`${relFile} import「${spec}」——禁止 import 其他模組【§6.3-9】`);
    }
    return;
  }
  const allowed = HOST_SURFACE_ALLOW.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`));
  if (!allowed) {
    fail(`${relFile} import「${spec}」——不在主程式公開面白名單【§6.3-1】`);
  }
}

const errors = [];
const warnings = [];
function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
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

/** 管理頁是否有任一祖先 layout 使用 AdminSectionShell（client-side 權限殼） */
function hasAdminShellAncestor(moduleDir, file) {
  const adminRoot = path.join(moduleDir, "admin");
  let dir = path.dirname(file);
  while (dir.startsWith(adminRoot)) {
    const layout = fs
      .readdirSync(dir)
      .find((name) => /^layout\.(tsx|ts|jsx|js)$/.test(name));
    if (layout) {
      const text = fs.readFileSync(path.join(dir, layout), "utf-8");
      if (text.includes("AdminSectionShell")) return true;
    }
    if (dir === adminRoot) break;
    dir = path.dirname(dir);
  }
  return false;
}

/** API route 守門三件套＋非管理端 module gate 的存在性檢查（P0-8 build-time gate） */
function checkRouteGuards(moduleDir, file, source, relFile, fail) {
  if (/^api\/.*\/route\.(ts|js)$/.test(relFile) || /^api\/route\.(ts|js)$/.test(relFile)) {
    const routePath = `/${relFile.replace(/route\.(ts|js)$/, "").replace(/\/$/, "")}`;
    if (!/enforceRateLimit\s*\(|checkRateLimit\s*\(/.test(source)) {
      fail(`${relFile}：缺少限流（enforceRateLimit／checkRateLimit）【P0-8】`);
    }
    if (!/requireRole\s*\(|requireAdminModule\s*\(|requireModulePermission\s*\(/.test(source)) {
      fail(`${relFile}：缺少鑑權（requireRole／requireAdminModule／requireModulePermission）【P0-8】`);
    }
    const mutating =
      /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/.test(source) ||
      /export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=/.test(source);
    if (mutating && !/assertSameOrigin\s*\(/.test(source)) {
      fail(`${relFile}：寫入方法缺少 CSRF（assertSameOrigin）【P0-8】`);
    }
    if (/^\/api\/(student|parent|staff)\//.test(routePath) && !/requireFeatureModuleEnabled\s*\(/.test(source)) {
      fail(`${relFile}：${routePath} 缺少模組啟用閘門（requireFeatureModuleEnabled）【P0-8】`);
    }
  }

  if (relFile.startsWith("admin/") && /page\.(tsx|ts|jsx|js)$/.test(relFile)) {
    if (!hasAdminShellAncestor(moduleDir, file)) {
      fail(`${relFile}：管理頁缺少任一祖先 layout 的 AdminSectionShell 權限殼【P0-8】`);
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
    const isClient = isUseClient(source);
    const relFile = rel(file);

    // 規則 8：客戶端危險模式
    if (isClient) {
      for (const { re, name } of CLIENT_DANGER) {
        if (re.test(source)) fail(`${relFile}（"use client"）使用 ${name}【§6.3-8】`);
      }
    } else {
      // P1-9：伺服器端也不得執行任意程式碼
      for (const { re, name } of SERVER_DANGER) {
        if (re.test(source)) fail(`${relFile} 使用 ${name}——模組不得執行任意程式碼【P1-9】`);
      }
    }

    // P1-9：不得讀取宿主秘密環境變數
    for (const key of HOST_SECRET_ENV_KEYS) {
      const patterns = [
        new RegExp(`process\\.env\\.${key}\\b`),
        new RegExp(`process\\.env\\[\\s*["'\`]${key}["'\`]\\s*\\]`),
      ];
      if (patterns.some((re) => re.test(source))) {
        fail(`${relFile} 讀取宿主秘密環境變數「${key}」【P1-9】`);
      }
    }
    if (ENV_ENUMERATION.some((re) => re.test(source))) {
      fail(`${relFile} 枚舉 process.env——模組不得取得宿主完整環境變數【P1-9】`);
    }
    if (/process\.env\.SESSION_SECRET\b/.test(source) || /process\.env\[\s*["'`]SESSION_SECRET["'`]\s*\]/.test(source)) {
      warn(`${relFile} 讀取 SESSION_SECRET；正式沙箱會改為模組專屬密鑰，請改用 getModuleSecret【P1-9】`);
    }

    // 規則 1/2/9：import 檢查（靜態＋動態＋require）
    const importRe = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g;
    const requireRe = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    let match;
    const specs = new Set();
    while ((match = importRe.exec(source)) !== null) specs.add(match[1]);
    while ((match = requireRe.exec(source)) !== null) specs.add(match[1]);
    while ((match = DYNAMIC_IMPORT_RE.exec(source)) !== null) specs.add(match[1]);
    for (const spec of specs) {
      checkImportSpec(spec, relFile, file, moduleDir, moduleValue, hostDeps, fail);
    }
    if (!isScriptOrTest(relFile) && DYNAMIC_IMPORT_DYNAMIC_RE.test(source)) {
      fail(`${relFile}：動態 import 非字面值，無法驗證【P0-3】`);
    }

    // 規則 6：Firestore 集合字面值 vs dataCollections 宣告（collection＋doc 路徑）
    const collectionRe = /\.collection\(\s*["'`]([A-Za-z][A-Za-z0-9_]*)["'`]\s*\)/g;
    while ((match = collectionRe.exec(source)) !== null) {
      const name = match[1];
      if (HOST_RESERVED_COLLECTIONS.has(name)) {
        fail(`${relFile} 存取宿主保留集合「${name}」——模組不得直接讀寫【P0-2】`);
        continue;
      }
      if (HOST_FACILITY_COLLECTIONS.has(name)) {
        fail(
          `${relFile} 存取設施集合「${name}」——請改用 publishFromModule／publishScheduleFromModule【P0-2】`
        );
        continue;
      }
      if (!declaredCollections.has(name)) {
        fail(
          `${relFile} 存取未宣告集合「${name}」——請在 module.json dataCollections 宣告【§6.3-6】`
        );
        continue;
      }
      if (HOST_CORE_READONLY_COLLECTIONS.has(name) && hasCoreWrite(source, name)) {
        fail(`${relFile} 對核心集合「${name}」進行寫入——核心個資集合僅供讀取【P0-2】`);
      }
    }
    DOC_PATH_RE.lastIndex = 0;
    while ((match = DOC_PATH_RE.exec(source)) !== null) {
      if (!match[1].includes("/")) continue; // .doc("id") 是文件 ID，不是集合路徑
      const name = match[1].split("/")[0]?.trim() ?? "";
      if (!name) continue;
      if (HOST_RESERVED_COLLECTIONS.has(name)) {
        fail(`${relFile} 以 doc 路徑存取宿主保留集合「${name}」——模組不得直接讀寫【P0-2】`);
        continue;
      }
      if (HOST_FACILITY_COLLECTIONS.has(name)) {
        fail(
          `${relFile} 以 doc 路徑存取設施集合「${name}」——請改用掛勾函式【P0-2】`
        );
        continue;
      }
      if (!declaredCollections.has(name)) {
        fail(
          `${relFile} 以 doc 路徑存取未宣告集合「${name}」——請在 module.json dataCollections 宣告【P0-3／§6.3-6】`
        );
        continue;
      }
      if (HOST_CORE_READONLY_COLLECTIONS.has(name) && hasCoreWrite(source, name)) {
        fail(`${relFile} 對核心集合「${name}」進行寫入——核心個資集合僅供讀取【P0-2】`);
      }
    }

    // P0-8：API 守門三件套與管理頁權限殼的存在性
    checkRouteGuards(moduleDir, file, source, relFile, fail);
  }

  if (warnings.length) {
    for (const w of warnings) console.warn(`[module-check] 警示：${w}`);
  }
  if (errors.length) {
    for (const e of errors) console.error(`[module-check] 錯誤：${e}`);
    console.error(`[module-check] 共 ${errors.length} 個問題，掃描未通過。`);
    process.exit(1);
  }
  process.stdout.write(`[module-check] ${moduleValue} 靜態掃描通過\n`);
}

main();
