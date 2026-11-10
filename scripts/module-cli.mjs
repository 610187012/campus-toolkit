/**
 * module-cli.mjs —— 期 0 P3：選用功能模組在地安裝／連結／解除 CLI
 *
 *   npm run module:install   -- <模組資料夾>      複製安裝（vendored 進 src/modules，隨 commit 部署）
 *   npm run module:link      -- <模組 repo 路徑>  目錄連結（win32 junction／其餘 symlink；加 --copy 改複製）
 *   npm run module:uninstall -- <value>           移除資料夾或連結＋lock 該列（Firestore 資料保留）
 *
 * 安裝／連結流程：預檢 manifest → 放入 src/modules/<value> → 寫 module.lock.local.json →
 * 跑掃描器（同一條驗證鏈：撞名、前綴、路徑白名單、lock↔目錄一致性【E13】＋產生註冊表與轉接檔）
 * → 跑 npm run lint；任一步失敗即回復原狀（不留半套）。
 *
 * 規格：docs/主程式模組與功能模組.md §3.4 P3、
 *       docs/模組市集與外掛開發.md §5.4（lock 格式）、§5.7（在地安裝）、§3.1（link）。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES_DIR = path.join(ROOT, "src", "modules");
const LOCK_FILE = path.join(ROOT, "module.lock.local.json");
const VERSION_FILE = path.join(ROOT, "src", "version.json");
const SCANNER = path.join(ROOT, "scripts", "build-module-registry.mjs");
const CHECKER = path.join(ROOT, "scripts", "module-check.mjs");
/** 複製時排除（安裝不帶 .git／依賴／建置產物） */
const EXCLUDE = new Set([".git", "node_modules", ".next"]);
const VALUE_RE = /^[a-z][A-Za-z0-9]*$/;

class CliError extends Error {}
function fail(message) {
  throw new CliError(message);
}
const out = (message) => process.stdout.write(`${message}\n`);
const outErr = (message) => console.error(`[module-cli] 錯誤：${message}`);

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
    return { data: JSON.parse(raw), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function hostVersion() {
  const v = readJson(VERSION_FILE);
  return v.data && typeof v.data.version === "string" ? v.data.version : "0";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** lock 讀取（不存在回 null；格式壞掉即失敗） */
function readLock() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  const parsed = readJson(LOCK_FILE);
  if (parsed.error || !parsed.data || !Array.isArray(parsed.data.modules)) {
    fail(`module.lock.local.json 無法解析或缺 modules 陣列：${parsed.error ?? "格式不符"}`);
  }
  if (parsed.data.modules.some((m) => !m || typeof m.value !== "string")) {
    fail("module.lock.local.json 的 modules 列需含 value");
  }
  return parsed.data;
}

/** 寫入 lock；最後一列移除時直接刪檔（避免殘留空清單） */
function writeLock(lock) {
  if (lock.modules.length === 0) {
    fs.rmSync(LOCK_FILE, { force: true });
    return;
  }
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
}

/** 排除 EXCLUDE 後計算目錄內容雜湊（每檔 sha256 依序併入） */
function hashTree(root) {
  const digest = crypto.createHash("sha256");
  const walk = (dir) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (EXCLUDE.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        digest.update(`${rel} link: ${fs.readlinkSync(full)}\n`);
      } else if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const fileHash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        digest.update(`${rel} file: ${fileHash}\n`);
      }
    }
  };
  walk(root);
  return digest.digest("hex");
}

/** 複製（排除 .git／node_modules／.next） */
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (src) => !EXCLUDE.has(path.basename(src)),
  });
}

/** 目錄連結：win32 用 junction（免管理員），其餘平台 symlink */
function createLink(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (process.platform === "win32") {
    fs.symlinkSync(source, target, "junction");
  } else {
    fs.symlinkSync(source, target, "dir");
  }
}

/** 只移除連結、絕不碰目標（real dir 才走 recursive 刪除） */
function removeTarget(target) {
  let lstat = null;
  try {
    lstat = fs.lstatSync(target);
  } catch {
    return; // 不存在
  }
  if (lstat.isSymbolicLink()) {
    try {
      fs.rmdirSync(target); // 目錄連結（junction/symlink dir）只刪連結
    } catch {
      fs.unlinkSync(target);
    }
  } else {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function runScanner() {
  const r = spawnSync(process.execPath, [SCANNER], { cwd: ROOT, stdio: "inherit" });
  return r.status ?? 1;
}

function runChecker(moduleDir) {
  const r = spawnSync(process.execPath, [CHECKER, moduleDir], { cwd: ROOT, stdio: "inherit" });
  return r.status ?? 1;
}

function runLint() {
  // win32 的 npm 是 .cmd：Node ≥20 需 shell 才能啟動；以整串指令避開 DEP0190
  const r =
    process.platform === "win32"
      ? spawnSync("npm run lint", { cwd: ROOT, stdio: "inherit", shell: true })
      : spawnSync("npm", ["run", "lint"], { cwd: ROOT, stdio: "inherit" });
  return r.status ?? 1;
}

function requireTarget(command, targetArg) {
  if (!targetArg) {
    fail(
      command === "uninstall"
        ? "缺少 <value>；用法：npm run module:uninstall -- <value>"
        : `缺少路徑；用法：npm run ${command === "install" ? "module:install" : "module:link"} -- <模組資料夾>`
    );
  }
}

function validateSource(sourceArg) {
  const source = path.resolve(sourceArg);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    fail(`來源路徑不存在或不是資料夾：${source}`);
  }
  const manifestPath = path.join(source, "module.json");
  if (!fs.existsSync(manifestPath)) fail(`來源不是模組資料夾（缺 module.json）：${source}`);
  const parsed = readJson(manifestPath);
  if (parsed.error || !parsed.data || typeof parsed.data !== "object") {
    fail(`來源 module.json 解析失敗：${parsed.error ?? "非物件"}`);
  }
  const m = parsed.data;
  if (typeof m.value !== "string" || !VALUE_RE.test(m.value)) {
    fail(`manifest.value 需為 camelCase（英數字、小寫起頭），實得 ${JSON.stringify(m.value)}`);
  }
  return { source, manifest: m };
}

function assertNotInstalled(value) {
  const target = path.join(MODULES_DIR, value);
  let exists = false;
  try {
    fs.lstatSync(target);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    fail(`src/modules/${value} 已存在——先執行 npm run module:uninstall -- ${value}`);
  }
  const lock = readLock();
  const hit = lock && lock.modules.find((m) => m.value === value);
  if (hit) {
    fail(`module.lock.local.json 已登記「${value}」但資料夾不存在（殘 lock）——先修復或移除該列`);
  }
  return lock;
}

function buildLockEntry(mode, sourceArg, manifest, sha256, copyFlag) {
  return {
    value: manifest.value,
    version: typeof manifest.author?.version === "string" ? manifest.author.version : "",
    contractVersion: Number.isInteger(manifest.contractVersion) ? manifest.contractVersion : 1,
    minHostVersion:
      typeof manifest.minHostVersion === "string" ? manifest.minHostVersion : hostVersion(),
    sha256: sha256,
    source:
      mode === "link"
        ? `${copyFlag ? "link-copy" : "link"}:${sourceArg}`
        : `copy:${sourceArg}`,
    installedAt: today(),
  };
}

// ——— install / link ———

/**
 * copy-sync watch【E14 備案落地】：監聽來源資料夾，變更即整棵重複製到掛載點；
 * 若動到 module.json 另重跑掃描器（轉接檔與註冊表跟著更新）。程序常駐（Ctrl+C 結束）。
 */
function startWatch(source, target) {
  out(`[module-cli] watch 模式：監聽 ${source}（Ctrl+C 結束）；動到 module.json 會自動重跑掃描器`);
  let timer = null;
  let manifestChanged = false;
  const sync = () => {
    try {
      copyTree(source, target);
      if (manifestChanged) {
        manifestChanged = false;
        runScanner();
      }
      out(`[module-cli] 已同步 ${new Date().toTimeString().slice(0, 8)}`);
    } catch (e) {
      console.error(`[module-cli] 同步失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  fs.watch(source, { recursive: true }, (_event, filename) => {
    if (filename) {
      const first = filename.split(path.sep)[0];
      if (EXCLUDE.has(first)) return;
      if (filename === "module.json") manifestChanged = true;
    }
    if (timer) globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(sync, 300);
  });
}

function installOrLink(mode, sourceArg, opts) {
  requireTarget(mode, sourceArg);
  if (opts.watch && !opts.copy) {
    fail("--watch 需搭配 --copy（win32 junction 無法可靠監聽，風險【E14】）");
  }
  const { source, manifest } = validateSource(sourceArg);
  const value = manifest.value;
  const target = path.join(MODULES_DIR, value);
  if (path.resolve(source) === path.resolve(target)) {
    fail("來源與安裝位置相同（來源已在 src/modules 下）");
  }
  const lock = assertNotInstalled(value);

  const sha256 = hashTree(source);
  const lockSnapshot = fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE) : null;
  let placed = false;
  let lockWritten = false;

  const rollback = () => {
    if (placed) removeTarget(target);
    if (lockWritten) {
      if (lockSnapshot === null) fs.rmSync(LOCK_FILE, { force: true });
      else fs.writeFileSync(LOCK_FILE, lockSnapshot);
    }
    runScanner(); // 產物回到一致狀態（結果忽略；原失敗已另行回報）
  };

  try {
    if (mode === "link" && !opts.copy) {
      createLink(source, target);
    } else {
      copyTree(source, target);
    }
    placed = true;

    const nextLock = lock ?? { lockVersion: 1, modules: [] };
    nextLock.modules.push(buildLockEntry(mode, sourceArg, manifest, sha256, opts.copy));
    writeLock(nextLock);
    lockWritten = true;

    out(`[module-cli] 已${mode === "link" ? "連結" : "安裝"} ${value}，執行驗證鏈…`);
    if (runScanner() !== 0) {
      rollback();
      fail("掃描器驗證失敗（見上方訊息）——已回復原狀");
    }
    if (runChecker(target) !== 0) {
      rollback();
      fail("靜態安全掃描失敗（module-check，見上方訊息）——已回復原狀");
    }
    if (runLint() !== 0) {
      rollback();
      fail("npm run lint 失敗（模組程式碼與主程式不合）——已回復原狀");
    }
    const kind = mode === "link" ? "連結" : "安裝";
    out(`[module-cli] ${value} ${kind}完成（sha256 ${sha256.slice(0, 12)}…）。`);
    out("[module-cli] 下一步：npm run dev 驗證；本機 lock（module.lock.local.json）不會進 git。");
    out("[module-cli] 啟用：/admin/modules（預設未啟用 fail-safe）。");
    if (mode === "link" && process.platform === "win32" && !opts.copy) {
      out(
        "[module-cli] 提示：連結為 win32 junction；若 npm run dev 改檔未即時更新（Turbopack watch 風險【E14】），改用 npm run module:link -- <路徑> --copy --watch 以複製＋監聽同步。"
      );
    }
    if (mode === "link" && opts.watch && opts.copy) {
      startWatch(source, target);
    }
  } catch (e) {
    if (e instanceof CliError) throw e; // 驗證鏈失敗已在站內回復過，勿二次包裹
    rollback();
    fail(e instanceof Error ? `${e.message}——已回復原狀` : String(e));
  }
}

// ——— uninstall ———

function uninstall(value) {
  requireTarget("uninstall", value);
  if (!VALUE_RE.test(value)) fail(`value 需為 camelCase，實得 ${JSON.stringify(value)}`);
  const target = path.join(MODULES_DIR, value);
  let lstat = null;
  try {
    lstat = fs.lstatSync(target);
  } catch {
    lstat = null;
  }
  const lock = readLock();
  const hit = lock && lock.modules.find((m) => m.value === value);
  if (!lstat && !hit) fail(`未安裝「${value}」（src/modules 與 module.lock.local.json 皆無）`);

  if (lstat) {
    removeTarget(target);
    out(`[module-cli] 已移除 ${lstat.isSymbolicLink() ? "連結" : "資料夾"} src/modules/${value}`);
  }
  if (lock && hit) {
    lock.modules = lock.modules.filter((m) => m.value !== value);
    writeLock(lock);
    out(`[module-cli] 已從 module.lock.local.json 移除「${value}」`);
  } else if (!lock) {
    out("[module-cli] 提示：module.lock.local.json 未登記該值（手放資料夾已清）");
  }

  if (runScanner() !== 0) fail("掃描器回報剩餘問題（見上方訊息）");
  if (runLint() !== 0) fail("npm run lint 失敗（見上方訊息）");
  out(`[module-cli] ${value} 已解除。Firestore 模組資料預設保留（規格 §5.6.3）。`);
  out("[module-cli] 下一步：commit（刪檔與 lock 變更）→ push 自動部署；權限單位與入口卡隨之消失。");
}

// ——— main ———

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const opts = { copy: args.includes("--copy"), watch: args.includes("--watch") };
  const positional = args.filter((a) => !a.startsWith("--")).slice(1);
  const targetArg = positional[0];

  if (command === "install") return installOrLink("install", targetArg, opts);
  if (command === "link") return installOrLink("link", targetArg, opts);
  if (command === "uninstall") return uninstall(targetArg);
  fail(
    "用法：node scripts/module-cli.mjs <install|link|uninstall> <路徑或 value>（npm：module:install／module:link／module:uninstall）"
  );
}

try {
  main();
} catch (e) {
  outErr(e instanceof CliError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
}
