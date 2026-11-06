/**
 * build-module-registry.mjs —— 選用功能模組註冊表產生器（期 0 批次 1【E12】）
 *
 * 掃描 `src/modules/<value>/module.json`（manifest，規格見
 * `docs/主程式模組與功能模組.md` §3.2 與 `docs/模組市集與外掛開發.md` §3.3），
 * 驗證後產生四個產物（不入 git，見 .gitignore）：
 *   - `src/types/feature-modules.generated.ts` —— 產品層級功能模組列（kind 恆 optional）
 *   - `src/types/modules.generated.ts`         —— `permission.mode: "new"` 的權限單位列
 *   - `src/lib/rate.generated.ts`              —— 限流桶，併入 `lib/rate-limit.ts` 的 RATE（期 0 批次 2）
 *   - `src/lib/activity-actions.generated.ts`  —— 稽核動作，併入 `lib/audit.ts` 的 ActivityAction（期 0 批次 2）
 *
 * 另依 `routes` 產生 **P2 薄轉接檔**（`src/app/**`，re-export 模組內實體；
 * 模組實體尚未存在＝尚未掛載，實體出現即自動掛載）：
 *   轉接檔與 `src/app/.gitignore` 皆不入 commit（生成物零手改，見市集文件 §5），
 *   滯留轉接檔（manifest 移除或實體消失）自動刪除。
 *
 * 自動執行：package.json 的 predev / prebuild / prelint / pretypecheck。
 * 不合規一律 fail-fast（exit 1）：逐項列出中文錯誤訊息並標明檔案；
 * 警示（如未實作的掛勾【E9】）只警告、不阻擋。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 測試模式：MODULE_REGISTRY_DIR 覆寫模組目錄（契約測試 scripts/test-module-contract.mjs 用） */
const MODULES_DIR = process.env.MODULE_REGISTRY_DIR
  ? path.resolve(process.env.MODULE_REGISTRY_DIR)
  : path.join(ROOT, "src", "modules");
/** 測試模式：只驗證、不產生產物／不動轉接檔（附錄 A 案例驗證用） */
const VALIDATE_ONLY = process.env.MODULE_REGISTRY_VALIDATE_ONLY === "1";
const HAND_REGISTRY = path.join(ROOT, "src", "types", "modules.ts");
const VERSION_FILE = path.join(ROOT, "src", "version.json");
const LOCK_FILE = path.join(ROOT, "module.lock.json");
const OUT_FEATURE = path.join(ROOT, "src", "types", "feature-modules.generated.ts");
const OUT_MODULES = path.join(ROOT, "src", "types", "modules.generated.ts");
const RATE_TABLE = path.join(ROOT, "src", "lib", "rate-limit.ts");
const AUDIT_TABLE = path.join(ROOT, "src", "lib", "audit.ts");
const OUT_RATE = path.join(ROOT, "src", "lib", "rate.generated.ts");
const OUT_ACTIONS = path.join(ROOT, "src", "lib", "activity-actions.generated.ts");
const APP_DIR = path.join(ROOT, "src", "app");
const APP_IGNORE = path.join(APP_DIR, ".gitignore");
/** 薄轉接檔識別字串（撞名豁免與滯留清理都靠它；勿改，會造成重複產生） */
const ADAPTER_MARKER = "P2 薄轉接檔";

/** 主程式當前契約版本（與 module-sdk 的 MODULE_CONTRACT_VERSION 同步；SDK 建立前手動維持） */
const MODULE_CONTRACT_VERSION = 1;
const CATEGORIES = ["帳號與權限", "校務資料", "系統與紀錄"];
const STATUSES = ["planned", "building", "live"];
const KNOWN_HOOKS = ["announcements", "calendar"];
const PAGE_PREFIXES = ["/admin", "/student", "/parent", "/staff"];
/** manifest status → 權限單位 status（types/modules.ts 的 ModuleStatus） */
const PERMISSION_STATUS = { live: "built", building: "apiOnly", planned: "planned" };
/** 內建代碼中不在 MODULES 權限表者（撞名即報錯） */
const EXTRA_RESERVED = ["account"];
const GENERATED_HEADER = [
  "// ⚠️ 此檔由 scripts/build-module-registry.mjs 自動產生，請勿手改。",
  "// 來源：src/modules/*/module.json（predev / prebuild / prelint / pretypecheck 會覆寫）",
  "",
].join("\n");

/** camelCase 代碼 → snake_case（auditActions 前綴用）：spaceBooking → space_booking */
function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
/** camelCase 代碼 → UPPER_SNAKE（rateLimits.key 前綴用）：spaceBooking → SPACE_BOOKING */
function toUpperSnake(value) {
  return camelToSnake(value).toUpperCase();
}
/** "0.381" → [0, 381]（無法解析回空陣列） */
function versionParts(value) {
  return String(value)
    .split(".")
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isNaN(n) ? -1 : n;
    });
}
/** a > b？（逐段比較，缺段視為 0） */
function versionGreater(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
function readJson(file) {
  try {
    // 去 BOM（Windows 編輯器另存的 JSON 帶 BOM 會讓 JSON.parse 失敗）
    const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
    return { data: JSON.parse(raw), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}
/** 內建權限單位代碼（types/modules.ts 手刻列，撞名即報錯） */
function collectReservedValues() {
  const reserved = new Set(EXTRA_RESERVED);
  if (fs.existsSync(HAND_REGISTRY)) {
    const src = fs.readFileSync(HAND_REGISTRY, "utf-8");
    for (const m of src.matchAll(/\bvalue:\s*"([A-Za-z0-9_]+)"/g)) reserved.add(m[1]);
  }
  return reserved;
}
/** 既有 src/app 路由是否已存在（自家薄轉接檔＝將被覆寫，不算撞名） */
function isOwnAdapter(file) {
  try {
    return fs.readFileSync(file, "utf-8").includes(ADAPTER_MARKER);
  } catch {
    return false;
  }
}
function routeFileExists(kind, routePath) {
  const rel = routePath.replace(/^\//, "").replace(/\/$/, "");
  const base = path.join(APP_DIR, rel);
  const names =
    kind === "page" ? ["page.tsx", "page.ts", "page.jsx", "page.js"] : ["route.ts", "route.js"];
  return names.some((name) => {
    const file = path.join(base, name);
    return fs.existsSync(file) && !isOwnAdapter(file);
  });
}
/** 既有 RATE 桶（lib/rate-limit.ts 手刻列；撞名＝與內建覆寫同一鍵，報錯） */
function collectBuiltinRateKeys() {
  const keys = new Set();
  if (!fs.existsSync(RATE_TABLE)) return keys;
  const src = fs.readFileSync(RATE_TABLE, "utf-8");
  for (const m of src.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*\{\s*limit:/gm)) keys.add(m[1]);
  return keys;
}
/** 既有 ActivityAction 聯集字串（lib/audit.ts；撞名＝型別重複，報錯） */
function collectBuiltinAuditActions() {
  const actions = new Set();
  if (!fs.existsSync(AUDIT_TABLE)) return actions;
  const src = fs.readFileSync(AUDIT_TABLE, "utf-8");
  const union = src.match(/export type ActivityAction =([\s\S]*?);/);
  if (union) for (const m of union[1].matchAll(/"([a-z0-9_]+)"/g)) actions.add(m[1]);
  return actions;
}

const errors = [];
const warnings = [];
function fail(file, message) {
  errors.push(`${file}：${message}`);
}
function warn(file, message) {
  warnings.push(`${file}：${message}`);
}
function isString(value) {
  return typeof value === "string";
}
function isNonEmptyString(value) {
  return isString(value) && value.trim() !== "";
}
/** 路由路徑安全檢查：禁止 .／..、反斜線、編碼、查詢字串、空片段（防 path traversal）【E13】 */
const DYNAMIC_SEGMENT_RE = /^\[\[?\.\.\.[A-Za-z0-9_]+\]\]?$|^\[[A-Za-z0-9_]+\]$/;
function isSafeRoutePath(value) {
  if (!isString(value) || !value.startsWith("/") || value.length > 300) return false;
  if (/[\\?#%]/.test(value)) return false;
  for (const char of value) {
    if (char.charCodeAt(0) < 0x20) return false;
  }
  if (value.includes("//")) return false;
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if ((segment.includes("[") || segment.includes("]")) && !DYNAMIC_SEGMENT_RE.test(segment)) {
      return false;
    }
  }
  return true;
}

/** 單一 manifest 的結構驗證（對應文件 §3.2 規則 1–4 與 §3.3 擴充 5–9） */
function validateManifest(relDir, dirName, m, reserved, ctx) {
  const at = (msg) => fail(`${relDir}/module.json`, msg);

  if (!/^[a-z][A-Za-z0-9]*$/.test(dirName)) at(`資料夾名 ${dirName} 需為 camelCase 小寫起頭`);
  if (!isNonEmptyString(m.value)) {
    at("缺少 value");
    return; // value 缺了，後續比對無意義
  }
  if (m.value !== dirName) at(`value「${m.value}」與資料夾名「${dirName}」不一致`);
  if (reserved.has(m.value)) at(`value「${m.value}」與內建模組／權限單位撞名`);
  if (!isNonEmptyString(m.label)) at("缺少 label");
  if (m.kind !== "optional") at(`kind 需為 "optional"（選用模組），實得 ${JSON.stringify(m.kind)}`);
  if (!STATUSES.includes(m.status)) at(`status 需為 ${STATUSES.join("／")} 之一`);
  if (!isNonEmptyString(m.description)) at("缺少 description");
  if (!isString(m.href)) at("缺少 href（尚未建頁請給空字串）");
  if (m.status === "live" && m.href === "") at('status 為 live 時 href 不可為空（已上線必須有入口）');

  const author = m.author && typeof m.author === "object" ? m.author : null;
  if (!author) {
    at("缺少 author 物件");
  } else {
    for (const key of ["author", "authorUrl", "version", "releasedAt"]) {
      if (!isString(author[key])) at(`author.${key} 需為字串`);
    }
    if (isString(author.version) && author.version.trim() === "") at("author.version 不可為空");
  }

  const provides = m.provides && typeof m.provides === "object" ? m.provides : null;
  if (!provides) {
    at("缺少 provides 物件");
  } else {
    for (const role of ["student", "parent", "staff", "admin"]) {
      if (typeof provides[role] !== "boolean") at(`provides.${role} 需為布林值`);
    }
  }

  if (m.defaultRoleEnabled !== undefined) {
    const dre = m.defaultRoleEnabled;
    if (!dre || typeof dre !== "object" || Array.isArray(dre)) {
      at("defaultRoleEnabled 需為物件");
    } else {
      for (const [role, value] of Object.entries(dre)) {
        if (!["student", "parent", "staff", "admin"].includes(role)) {
          at(`defaultRoleEnabled 含未知身分「${role}」`);
        }
        if (typeof value !== "boolean") at(`defaultRoleEnabled.${role} 需為布林值`);
        if (provides && provides[role] === false) {
          at(`defaultRoleEnabled.${role} 宣告 false，但 provides.${role} 亦為 false（未提供身分不需預設）`);
        }
      }
    }
  }

  // managerPermissions（政策修改書 §6）：非管理員管理者之子權限宣告
  // 未宣告＝該模組不開放非管理員指派；有宣告時每項需有 value（camelCase）與 label
  if (m.managerPermissions !== undefined) {
    if (!Array.isArray(m.managerPermissions)) {
      at("managerPermissions 需為陣列");
    } else {
      const seen = new Set();
      m.managerPermissions.forEach((perm, i) => {
        if (!perm || typeof perm !== "object") {
          at(`managerPermissions[${i}] 需為物件`);
          return;
        }
        const value = perm.value;
        const label = perm.label;
        if (!isNonEmptyString(value) || !/^[a-z][A-Za-z0-9]*$/.test(value)) {
          at(`managerPermissions[${i}].value 需為 camelCase（小寫字母起頭）`);
          return;
        }
        if (seen.has(value)) {
          at(`managerPermissions 重複：${value}`);
        } else {
          seen.add(value);
        }
        if (!isNonEmptyString(label)) at(`managerPermissions[${i}].label 缺少或為空`);
      });
    }
  }

  if (!Array.isArray(m.routes) || m.routes.length === 0) {
    at("routes 需為非空陣列");
  } else {
    m.routes.forEach((route, i) => {
      const kind = route && route.kind;
      const p = route && route.path;
      if (kind !== "page" && kind !== "api") {
        at(`routes[${i}].kind 需為 page 或 api`);
        return;
      }
      if (!isNonEmptyString(p)) {
        at(`routes[${i}].path 缺少或為空`);
        return;
      }
      if (p.length > 1 && p.endsWith("/")) {
        at(`routes[${i}].path「${p}」不可有結尾斜線`);
        return;
      }
      if (!isSafeRoutePath(p)) {
        at(
          `routes[${i}].path「${p}」含不安全路徑片段（禁止 .、..、反斜線、編碼、查詢字串與空片段）【E13】`
        );
        return;
      }
      if (kind === "page") {
        const ok = PAGE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
        if (!ok) {
          at(
            `routes[${i}] 頁面路徑「${p}」不在白名單前綴（${PAGE_PREFIXES.join("、")}）——` +
              "該前綴之外無 proxy 角色閘門【E13】"
          );
        }
      } else if (!p.startsWith("/api/")) {
        at(`routes[${i}] API 路徑「${p}」需以 /api/ 開頭`);
      }
      if (routeFileExists(kind, p)) {
        at(`路由「${p}」與既有 src/app 路由撞名（撞名＝build 失敗）【E13】`);
      }
    });
  }

  const permission = m.permission && typeof m.permission === "object" ? m.permission : null;
  if (!permission) {
    at("缺少 permission 物件");
  } else if (permission.mode === "new") {
    if (permission.value !== m.value) at('permission.mode 為 "new" 時 permission.value 需等於 value');
    if (!CATEGORIES.includes(permission.category)) {
      at(`permission.category 需為 ${CATEGORIES.join("／")} 之一`);
    }
  } else if (permission.mode === "reuse") {
    if (!isNonEmptyString(permission.value)) at('permission.mode 為 "reuse" 時需給 permission.value');
    else if (!reserved.has(permission.value)) {
      at(`permission.reuse「${permission.value}」不是既有權限單位代碼`);
    }
  } else {
    at('permission.mode 需為 "new" 或 "reuse"');
  }

  if (m.rateLimits !== undefined) {
    if (!Array.isArray(m.rateLimits)) {
      at("rateLimits 需為陣列");
    } else {
      const prefix = `${toUpperSnake(m.value)}_`;
      const seen = new Set();
      m.rateLimits.forEach((bucket, i) => {
        if (!bucket || typeof bucket !== "object") {
          at(`rateLimits[${i}] 需為物件`);
          return;
        }
        const key = bucket.key;
        if (!isNonEmptyString(key) || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
          at(`rateLimits[${i}].key 需為 UPPER_SNAKE（英數字與底線，大寫起頭）`);
          return;
        }
        let duplicate = false;
        if (!key.startsWith(prefix)) {
          at(`rateLimits[${i}].key 需以「${prefix}」開頭（模組代碼前綴）`);
        } else if (seen.has(key)) {
          duplicate = true;
          at(`rateLimits 重複：${key}`);
        } else {
          seen.add(key);
        }
        if (duplicate) return;
        if (ctx.builtinRateKeys.has(key)) {
          at(`rateLimits key「${key}」與內建 RATE 桶撞名（外掛不可覆寫內建）`);
        } else if (ctx.allRateKeys.has(key)) {
          at(`rateLimits key「${key}」與「${ctx.allRateKeys.get(key)}」的 manifest 撞名`);
        } else {
          ctx.allRateKeys.set(key, m.value);
        }
        if (!Number.isInteger(bucket.limit) || bucket.limit <= 0) {
          at(`rateLimits[${i}].limit 需為正整數`);
        }
        if (!Number.isInteger(bucket.windowMs) || bucket.windowMs <= 0) {
          at(`rateLimits[${i}].windowMs 需為正整數`);
        }
      });
    }
  }

  if (m.auditActions !== undefined) {
    if (!Array.isArray(m.auditActions)) {
      at("auditActions 需為陣列");
    } else {
      const prefix = `${camelToSnake(m.value)}_`;
      const seen = new Set();
      m.auditActions.forEach((action, i) => {
        if (!isNonEmptyString(action) || !/^[a-z][a-z0-9_]*$/.test(action)) {
          at(`auditActions[${i}] 需為 snake_case 小寫字串`);
          return;
        }
        let duplicate = false;
        if (!action.startsWith(prefix)) {
          at(`auditActions[${i}]「${action}」需以「${prefix}」開頭（模組代碼前綴）`);
        } else if (seen.has(action)) {
          duplicate = true;
          at(`auditActions 重複：${action}`);
        } else {
          seen.add(action);
        }
        if (duplicate) return;
        if (ctx.builtinActions.has(action)) {
          at(`auditActions「${action}」與內建 ActivityAction 撞名（外掛不可覆寫內建）`);
        } else if (ctx.allActions.has(action)) {
          at(`auditActions「${action}」與「${ctx.allActions.get(action)}」的 manifest 撞名`);
        } else {
          ctx.allActions.set(action, m.value);
        }
      });
    }
  }

  if (m.dataCollections !== undefined) {
    if (!Array.isArray(m.dataCollections)) {
      at("dataCollections 需為陣列");
    } else {
      const seen = new Set();
      m.dataCollections.forEach((name, i) => {
        if (!isNonEmptyString(name) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
          at(`dataCollections[${i}] 格式不符（英數字起頭）`);
        } else if (seen.has(name)) {
          at(`dataCollections 重複：${name}`);
        } else {
          seen.add(name);
        }
      });
    }
  }

  if (m.hooks !== undefined) {
    if (!Array.isArray(m.hooks)) {
      at("hooks 需為陣列");
    } else {
      m.hooks.forEach((hook) => {
        if (!KNOWN_HOOKS.includes(hook)) {
          warn(`${relDir}/module.json`, `hooks 宣告尚未實作的掛勾「${hook}」【E9】（警示不阻擋）`);
        }
      });
    }
  }

  if (m.contractVersion !== undefined) {
    if (!Number.isInteger(m.contractVersion) || m.contractVersion < 1) {
      at("contractVersion 需為正整數");
    } else if (m.contractVersion > MODULE_CONTRACT_VERSION) {
      at(`contractVersion ${m.contractVersion} ＞ 主程式當前契約 ${MODULE_CONTRACT_VERSION}（請升級主程式）`);
    }
  }

  if (m.minHostVersion !== undefined) {
    if (!isNonEmptyString(m.minHostVersion) || versionParts(m.minHostVersion).includes(-1)) {
      at('minHostVersion 需為 "0.381" 格式的版本字串');
    } else {
      const current = readJson(VERSION_FILE);
      const host = current.data && isString(current.data.version) ? current.data.version : "";
      if (host && versionGreater(m.minHostVersion, host)) {
        at(`minHostVersion ${m.minHostVersion} ＞ 學校主程式 ${host}（需先升級主程式）`);
      }
    }
  }

  const pkgFile = path.join(MODULES_DIR, dirName, "package.json");
  if (fs.existsSync(pkgFile)) {
    const pkg = readJson(pkgFile);
    if (pkg.error) {
      at(`package.json 無法解析：${pkg.error}`);
    } else if (pkg.data && pkg.data.dependencies && Object.keys(pkg.data.dependencies).length > 0) {
      at("package.json 不可含 dependencies（主程式零新依賴【E10】）");
    }
  }
}

/** 產生 feature-modules.generated.ts 內容 */
function renderFeatureFile(manifests) {
  const rows = manifests.map((m) => {
    const a = m.author;
    const p = m.provides;
    // 各身分入口：取 routes 中該前綴的首個 page 路徑（RoleHome 非管理員首頁組卡用）
    const roleHrefs = {};
    for (const [role, prefix] of Object.entries({
      student: "/student",
      parent: "/parent",
      staff: "/staff",
      admin: "/admin",
    })) {
      const hit = (Array.isArray(m.routes) ? m.routes : []).find(
        (r) => r && r.kind === "page" && typeof r.path === "string" && r.path.startsWith(`${prefix}/`)
      );
      if (hit) roleHrefs[role] = hit.path;
    }
    const roleHrefsLines =
      Object.keys(roleHrefs).length > 0
        ? [
            "    roleHrefs: {",
            ...Object.entries(roleHrefs).map(([role, path]) => `      ${role}: ${JSON.stringify(path)},`),
            "    },",
          ]
        : [];
    const defaultRoleEnabled = m.defaultRoleEnabled && typeof m.defaultRoleEnabled === "object" ? m.defaultRoleEnabled : null;
    const defaultRoleEnabledLines = defaultRoleEnabled
      ? [
          "    defaultRoleEnabled: {",
          ...Object.entries(defaultRoleEnabled)
            .filter(([, value]) => typeof value === "boolean")
            .map(([role, value]) => `      ${role}: ${value},`),
          "    },",
        ]
      : [];
    const managerPermissions = Array.isArray(m.managerPermissions)
      ? m.managerPermissions.filter(
          (perm) =>
            perm &&
            typeof perm === "object" &&
            typeof perm.value === "string" &&
            perm.value &&
            typeof perm.label === "string" &&
            perm.label
        )
      : [];
    const managerPermissionsLines = managerPermissions.length
      ? [
          "    managerPermissions: [",
          ...managerPermissions.map(
            (perm) =>
              `      { value: ${JSON.stringify(perm.value)}, label: ${JSON.stringify(perm.label)} },`
          ),
          "    ],",
        ]
      : [];
    const changelog = Array.isArray(m.changelog)
      ? m.changelog.filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.version === "string" &&
            typeof entry.releasedAt === "string" &&
            Array.isArray(entry.notes) &&
            entry.notes.every((note) => typeof note === "string")
        )
      : [];
    const changelogLines = changelog.length
      ? [
          "    changelog: [",
          ...changelog.map(
            (entry) =>
              [
                "      {",
                `        version: ${JSON.stringify(entry.version)},`,
                `        releasedAt: ${JSON.stringify(entry.releasedAt)},`,
                `        notes: ${JSON.stringify(entry.notes)},`,
                "      },",
              ].join("\n")
          ),
          "    ],",
        ]
      : [];
    return [
      "  {",
      `    value: ${JSON.stringify(m.value)},`,
      `    label: ${JSON.stringify(m.label)},`,
      '    kind: "optional",',
      `    status: ${JSON.stringify(m.status)},`,
      `    description: ${JSON.stringify(m.description)},`,
      `    href: ${JSON.stringify(m.href)},`,
      "    author: {",
      `      author: ${JSON.stringify(isString(a.author) ? a.author : "")},`,
      `      authorUrl: ${JSON.stringify(isString(a.authorUrl) ? a.authorUrl : "")},`,
      `      version: ${JSON.stringify(isString(a.version) ? a.version : "")},`,
      `      releasedAt: ${JSON.stringify(isString(a.releasedAt) ? a.releasedAt : "")},`,
      "    },",
      "    provides: {",
      `      student: ${p.student === true},`,
      `      parent: ${p.parent === true},`,
      `      staff: ${p.staff === true},`,
      `      admin: ${p.admin === true},`,
      "    },",
      ...defaultRoleEnabledLines,
      ...managerPermissionsLines,
      ...roleHrefsLines,
      ...changelogLines,
      "  },",
    ].join("\n");
  });
  return [
    GENERATED_HEADER,
    'import type { FeatureModuleMeta } from "./feature-modules";',
    "",
    "export const GENERATED_FEATURE_MODULES = [",
    ...rows,
    '] as const satisfies readonly FeatureModuleMeta[];',
    "",
  ].join("\n");
}

/** 產生 modules.generated.ts 內容（僅 permission.mode = "new"） */
function renderModulesFile(manifests) {
  const rows = manifests.map((m) => [
    "  {",
    `    value: ${JSON.stringify(m.value)},`,
    `    label: ${JSON.stringify(m.label)},`,
    `    category: ${JSON.stringify(m.permission.category)},`,
    `    description: ${JSON.stringify(m.description)},`,
    '    scope: "assignable",',
    `    status: ${JSON.stringify(PERMISSION_STATUS[m.status])},`,
    `    href: ${JSON.stringify(m.href)},`,
    "    children: [],",
    "  },",
  ].join("\n"));
  const union =
    manifests.length === 0
      ? "never"
      : manifests.map((m) => JSON.stringify(m.value)).join(" | ");
  const values = manifests.map((m) => JSON.stringify(m.value)).join(", ");
  return [
    GENERATED_HEADER,
    'import type { ModuleMeta } from "./modules";',
    "",
    "export const GENERATED_MODULES = [",
    ...rows,
    '] as const satisfies readonly ModuleMeta[];',
    "",
    "/** 產生列的代碼清單（註冊表過濾／比對用；空陣列時為空清單） */",
    `export const GENERATED_MODULE_VALUES: readonly string[] = [${values}];`,
    "",
    "/** 由產生列派生的權限單位代碼聯合型別（無產生列時為 never） */",
    `export type GeneratedModuleValue = ${union};`,
    "",
  ].join("\n");
}

/** 產生 rate.generated.ts 內容（manifest rateLimits 併入 RATE，後者勝同鍵已被驗證擋下） */
function renderRateFile(manifests) {
  const rows = [];
  for (const m of manifests) {
    if (!Array.isArray(m.rateLimits)) continue;
    for (const bucket of m.rateLimits) {
      if (!bucket || !isString(bucket.key)) continue;
      rows.push(`  ${bucket.key}: { limit: ${bucket.limit}, windowMs: ${bucket.windowMs} },`);
    }
  }
  return [GENERATED_HEADER, "export const GENERATED_RATE = {", ...rows, "} as const;", ""].join("\n");
}

/** 產生 activity-actions.generated.ts 內容（manifest auditActions 併入 ActivityAction） */
function renderActionsFile(manifests) {
  const actions = [];
  for (const m of manifests) {
    if (!Array.isArray(m.auditActions)) continue;
    for (const action of m.auditActions) if (isString(action)) actions.push(action);
  }
  const union = actions.length === 0 ? "never" : actions.map((a) => JSON.stringify(a)).join(" | ");
  return [
    GENERATED_HEADER,
    "/** manifest auditActions 併入 lib/audit.ts 的 ActivityAction（無產生列時為 never） */",
    `export type GeneratedActivityAction = ${union};`,
    "",
  ].join("\n");
}

// ——— P2 薄轉接檔 ———

const ADAPTER_HEADER = [
  `// ⚠️ ${ADAPTER_MARKER}：由 scripts/build-module-registry.mjs 依 manifest routes 自動產生，請勿手改。`,
  "// 模組實體（src/modules/<value>/<路徑>/…）才是本體；本檔只是 re-export 掛載點。",
  "",
].join("\n");
const PAGE_ENTITIES = ["page.tsx", "page.ts", "page.jsx", "page.js"];
const LAYOUT_ENTITIES = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];
const ROUTE_ENTITIES = ["route.ts", "route.js"];
const ADAPTER_CANDIDATES = /^(page|layout|route)\.(tsx|ts|jsx|js)$/;

function findEntity(dir, candidates) {
  return candidates.find((name) => fs.existsSync(path.join(dir, name)));
}

function writeAdapter(file, body) {
  const content = `${ADAPTER_HEADER}${body}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function pruneEmptyDirs(startDir) {
  let dir = startDir;
  while (dir !== APP_DIR && dir.startsWith(APP_DIR)) {
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length > 0) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

/** 滯留轉接檔清理：識別到 ADAPTER_MARKER 但不屬目前應產生清單者刪除，並收合空目錄；回傳刪除數 */
function removeStaleAdapters(wanted) {
  let removed = 0;
  const stack = [APP_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ADAPTER_CANDIDATES.test(entry.name)) continue;
      const rel = path.relative(APP_DIR, full).split(path.sep).join("/");
      if (wanted.has(rel) || !isOwnAdapter(full)) continue;
      fs.rmSync(full);
      pruneEmptyDirs(path.dirname(full));
      removed += 1;
    }
  }
  return removed;
}

/** src/app/.gitignore：逐一列出轉接檔（生成物不入 commit；檔本身需入 git 才能在各環境生效） */
function writeAppIgnore(adapterPaths) {
  const lines = [
    "# P2 模組薄轉接檔（scripts/build-module-registry.mjs 產生）——列入 commit 即破壞「生成物不入 commit」約定",
    ...[...adapterPaths].sort().map((rel) => `/${rel}`),
    "",
  ];
  const content = lines.join("\n");
  if (fs.existsSync(APP_IGNORE) && fs.readFileSync(APP_IGNORE, "utf-8") === content) return;
  fs.writeFileSync(APP_IGNORE, content, "utf-8");
}

/** 依 manifest routes 同步薄轉接檔（實體存在才掛載）；回傳產生的轉接檔路徑清單 */
function syncAdapters(manifests) {
  const wanted = new Set();
  for (const m of manifests) {
    if (!Array.isArray(m.routes) || !isString(m.value)) continue;
    for (const route of m.routes) {
      if (!route || !isString(route.path) || (route.kind !== "page" && route.kind !== "api")) continue;
      const targetRel = route.path.replace(/^\//, "").replace(/\/$/, "");
      if (targetRel === "") continue;
      // 防禦深度：即使 manifest 驗證漏掉，也絕不把檔案寫出模組／src/app 之外。
      const moduleRoot = path.resolve(ROOT, "src", "modules", m.value);
      const entityDir = path.resolve(moduleRoot, targetRel);
      const adapterDir = path.resolve(APP_DIR, targetRel);
      if (entityDir !== moduleRoot && !entityDir.startsWith(`${moduleRoot}${path.sep}`)) continue;
      if (adapterDir !== APP_DIR && !adapterDir.startsWith(`${APP_DIR}${path.sep}`)) continue;
      if (route.kind === "page") {
        if (!findEntity(entityDir, PAGE_ENTITIES)) continue; // 尚未實作＝尚未掛載
        const pageRel = `${targetRel}/page.tsx`;
        writeAdapter(
          path.join(adapterDir, "page.tsx"),
          `export { default } from "@/modules/${m.value}/${targetRel}/page";\n`
        );
        wanted.add(pageRel);
        if (findEntity(entityDir, LAYOUT_ENTITIES)) {
          const layoutRel = `${targetRel}/layout.tsx`;
          writeAdapter(
            path.join(adapterDir, "layout.tsx"),
            `export { default } from "@/modules/${m.value}/${targetRel}/layout";\n`
          );
          wanted.add(layoutRel);
        }
      } else {
        if (!findEntity(entityDir, ROUTE_ENTITIES)) continue;
        const routeRel = `${targetRel}/route.ts`;
        writeAdapter(
          path.join(adapterDir, "route.ts"),
          `export * from "@/modules/${m.value}/${targetRel}/route";\n`
        );
        wanted.add(routeRel);
      }
    }
  }
  const stale = removeStaleAdapters(wanted);
  if (stale > 0) {
    // 滯留轉接檔已刪：.next 的 route 型別驗證檔仍引用它，留著會讓 tsc --noEmit 失敗；
    // 刪掉讓下次 dev/build 重建（lint 只跑 eslint+tsc，不依賴它）
    // dev 伺服器寫在 .next/dev/types（0.399 實測漏清會產生殘引用假錯誤）
    fs.rmSync(path.join(ROOT, ".next", "types"), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, ".next", "dev", "types"), { recursive: true, force: true });
    process.stdout.write(`[module-registry] 已移除 ${stale} 個滯留轉接檔，重置 .next/types 與 .next/dev/types 型別驗證\n`);
  }
  writeAppIgnore(wanted);
  return wanted.size;
}

// ——— 主流程 ———

const reserved = collectReservedValues();
const ctx = {
  builtinRateKeys: collectBuiltinRateKeys(),
  builtinActions: collectBuiltinAuditActions(),
  allRateKeys: new Map(),
  allActions: new Map(),
};
const manifests = [];

if (fs.existsSync(MODULES_DIR)) {
  const entries = fs
    .readdirSync(MODULES_DIR, { withFileTypes: true })
    // 含 module:link 建立的目錄連結（win32 junction 的 Dirent 是 isSymbolicLink 而非 isDirectory）
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relDir = `src/modules/${entry.name}`;
    const manifestFile = path.join(MODULES_DIR, entry.name, "module.json");
    if (!fs.existsSync(manifestFile)) {
      fail(relDir, "缺少 module.json（模組資料夾必須有 manifest，或移除該資料夾）");
      continue;
    }
    const parsed = readJson(manifestFile);
    if (parsed.error || !parsed.data || typeof parsed.data !== "object") {
      fail(`${relDir}/module.json`, `JSON 解析失敗：${parsed.error ?? "非物件"}`);
      continue;
    }
    validateManifest(relDir, entry.name, parsed.data, reserved, ctx);
    manifests.push(parsed.data);
  }
}

// value 全域唯一（跨 manifest）
const seenValues = new Map();
for (const m of manifests) {
  if (!isString(m.value)) continue;
  if (seenValues.has(m.value)) {
    fail("src/modules", `value「${m.value}」被多個 manifest 使用（全域唯一）`);
  } else {
    seenValues.set(m.value, true);
  }
}

// 路由路徑全域唯一（跨 manifest；同路徑不同模組＝轉接檔互寫）
const seenRoutes = new Map();
for (const m of manifests) {
  if (!Array.isArray(m.routes) || !isString(m.value)) continue;
  for (const route of m.routes) {
    if (!route || !isString(route.path)) continue;
    if (seenRoutes.has(route.path)) {
      fail(
        `${m.value} manifest`,
        `路由「${route.path}」已由「${seenRoutes.get(route.path)}」宣告（路徑全域唯一）`
      );
    } else {
      seenRoutes.set(route.path, m.value);
    }
  }
}

// 【E13】module.lock.json ↔ 目錄一致性（lock 存在時雙向檢查；測試模式略過——fixtures 不入 lock）
if (!VALIDATE_ONLY && fs.existsSync(LOCK_FILE)) {
  const lock = readJson(LOCK_FILE);
  if (lock.error || !Array.isArray(lock.data?.modules)) {
    fail("module.lock.json", `無法解析或缺少 modules 陣列：${lock.error ?? "格式不符"}`);
  } else {
    const locked = new Set(lock.data.modules.map((item) => item && item.value));
    const installed = new Set(manifests.map((m) => m.value).filter(isString));
    for (const value of locked) {
      if (!installed.has(value)) fail("module.lock.json", `已登記「${value}」但 src/modules 無此資料夾（殘 lock）`);
    }
    for (const value of installed) {
      if (!locked.has(value)) fail("src/modules", `「${value}」不在 module.lock.json（手放未登記，請走安裝/lock 流程）`);
    }
  }
}

if (warnings.length > 0) for (const message of warnings) console.warn(`[module-registry] 警示：${message}`);
if (errors.length > 0) {
  for (const message of errors) console.error(`[module-registry] 錯誤：${message}`);
  console.error(`[module-registry] 共 ${errors.length} 個錯誤，註冊表未更新。`);
  process.exit(1);
}

// 測試模式：只驗證（含警示），不產生產物／不動轉接檔
if (VALIDATE_ONLY) {
  process.stdout.write(`[module-registry] validate-only：${manifests.length} 個 manifest 檢查通過\n`);
  process.exit(0);
}

const newPermission = manifests.filter((m) => m.permission && m.permission.mode === "new");
const rateCount = manifests.reduce(
  (n, m) => n + (Array.isArray(m.rateLimits) ? m.rateLimits.length : 0),
  0
);
const actionCount = manifests.reduce(
  (n, m) => n + (Array.isArray(m.auditActions) ? m.auditActions.length : 0),
  0
);
fs.writeFileSync(OUT_FEATURE, renderFeatureFile(manifests), "utf-8");
fs.writeFileSync(OUT_MODULES, renderModulesFile(newPermission), "utf-8");
fs.writeFileSync(OUT_RATE, renderRateFile(manifests), "utf-8");
fs.writeFileSync(OUT_ACTIONS, renderActionsFile(manifests), "utf-8");
const adapterCount = syncAdapters(manifests);
process.stdout.write(
  `模組註冊表：${manifests.length} 個 manifest（功能列 ${manifests.length}、權限列 ${newPermission.length}、限流桶 ${rateCount}、稽核動作 ${actionCount}、轉接檔 ${adapterCount}）\n`
);
