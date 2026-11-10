/**
 * materialize-modules.mjs —— 依 `module.lock.json` 重建市集模組（P1-10）
 *
 * 目的：市集安裝只 commit `module.lock.json`，不再把模組檔案 commit 進 fork。
 * build／lint／dev 前由本腳本下載、驗 sha256／簽章、安全解壓到 `src/modules/<value>`，
 * 讓各校同步上游時不會再被模組檔案與安裝 commit 卡住。
 *
 * 規則：
 * - 只處理 `source: "market:<https URL>"` 的項目；`link-copy:`／`copy:`／`local:` 一律跳過。
 * - 目標資料夾已存在且 `treeSha256` 相同 → 跳過，不重複下載。
 * - 目標資料夾存在但沒有 `treeSha256`（舊版安裝）→ 保留現有檔案，不覆蓋。
 * - 下載失敗、大小超限、zip slip、簽章不符、manifest 不符 → 直接讓 build 失敗。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import AdmZip from "adm-zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES_DIR = path.join(ROOT, "src", "modules");
const LOCK_FILE = path.join(ROOT, "module.lock.json");
const TRUST_FILE = path.join(ROOT, "src", "lib", "module-trust-keys.json");

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 2000;
const EXCLUDE = new Set([".git", "node_modules", ".next"]);

/** 解析 `market:<url>`；只接受 https，開發環境額外允許 localhost http。 */
export function parseMarketSource(source) {
  if (typeof source !== "string") return null;
  const match = /^market:(.+)$/.exec(source.trim());
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !localHttp) return null;
    return url;
  } catch {
    return null;
  }
}

/** 壓縮檔 entry 名稱安全檢查（絕對路徑、`..`、空片段）。 */
export function assertSafeEntryName(name) {
  const normalized = String(name)
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`壓縮檔含非法絕對路徑：${name}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new Error(`壓縮檔含路徑穿越（zip slip）：${name}`);
  }
}

/** 解壓後檢查：不得有 symlink、檔案數與總大小不得超限。 */
export function assertExtractedTree(root) {
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("壓縮檔含路徑穿越（zip slip），拒絕安裝");
      }
      if (entry.isSymbolicLink()) {
        throw new Error("壓縮檔含 symbolic link，拒絕安裝");
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      if (fileCount > MAX_EXTRACTED_FILES) {
        throw new Error(`解壓後檔案數過多（超過 ${MAX_EXTRACTED_FILES} 個），拒絕安裝`);
      }
      totalBytes += fs.statSync(full).size;
      if (totalBytes > MAX_EXTRACTED_BYTES) {
        throw new Error(
          `解壓後過大（超過 ${MAX_EXTRACTED_BYTES / 1024 / 1024}MB），拒絕安裝`
        );
      }
    }
  };
  walk(root);
}

/** 目錄內容雜湊（與 src/lib/module-tree-hash.ts 相同演算法）。 */
export function hashTree(root) {
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
        throw new Error(`模組目錄含 symbolic link：${rel}`);
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const fileHash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
        digest.update(`${rel} file: ${fileHash}\n`);
      }
    }
  };
  walk(root);
  return digest.digest("hex");
}

/** 找出 `module.json` 所在目錄（archive 可能多一層資料夾）。 */
export function findModuleRoot(sourceDir) {
  if (fs.existsSync(path.join(sourceDir, "module.json"))) return sourceDir;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sourceDir, entry.name);
    if (fs.existsSync(path.join(candidate, "module.json"))) return candidate;
  }
  throw new Error("來源資料夾中未找到 module.json");
}

function readTrustedKeys() {
  const keys = new Map();
  try {
    const builtin = JSON.parse(fs.readFileSync(TRUST_FILE, "utf-8"));
    for (const [moduleId, list] of Object.entries(builtin)) {
      if (Array.isArray(list)) keys.set(moduleId, list.filter((v) => typeof v === "string"));
    }
  } catch (error) {
    throw new Error(`讀取內建模組公鑰失敗：${error instanceof Error ? error.message : error}`);
  }

  const raw = process.env.MODULE_MARKET_TRUSTED_KEYS?.trim();
  if (!raw) return keys;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MODULE_MARKET_TRUSTED_KEYS 不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return keys;
  for (const [moduleId, value] of Object.entries(parsed)) {
    const list = (Array.isArray(value) ? value : [value]).filter(
      (item) => typeof item === "string" && item.trim() !== ""
    );
    if (list.length > 0) {
      keys.set(moduleId, [...(keys.get(moduleId) ?? []), ...list.map((item) => item.trim())]);
    }
  }
  return keys;
}

function signatureRequired() {
  const raw = process.env.MODULE_MARKET_REQUIRE_SIGNATURE?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** 驗證 ed25519 簽章；簽章／公鑰必須同時存在且公鑰在釘選清單內。 */
export function verifyArchiveSignature({ moduleId, sha256, signature, publicKey }) {
  const sig = typeof signature === "string" ? signature.trim() : "";
  const key = typeof publicKey === "string" ? publicKey.trim() : "";
  if (!sig && !key) {
    if (signatureRequired()) {
      throw new Error(`模組「${moduleId}」要求簽章，但 lock 未記錄 signature／publicKey`);
    }
    return { signed: false };
  }
  if (!sig || !key) {
    throw new Error(`模組「${moduleId}」的 signature 與 publicKey 必須同時存在`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`模組「${moduleId}」的 sha256 格式錯誤`);
  }
  const trusted = readTrustedKeys().get(moduleId) ?? [];
  if (trusted.length === 0) {
    throw new Error(`模組「${moduleId}」沒有釘選公鑰，拒絕簽章套件`);
  }
  const providedDer = Buffer.from(key, "base64");
  if (providedDer.length === 0) throw new Error(`模組「${moduleId}」的 publicKey 不是合法 base64`);
  const pinned = trusted.some((item) => {
    const der = Buffer.from(item, "base64");
    return der.length > 0 && der.equals(providedDer);
  });
  if (!pinned) throw new Error(`模組「${moduleId}」的 publicKey 不在釘選信任清單`);

  try {
    const publicKeyObject = crypto.createPublicKey({
      key: providedDer,
      format: "der",
      type: "spki",
    });
    const valid = crypto.verify(
      null,
      Buffer.from(sha256, "hex"),
      publicKeyObject,
      Buffer.from(sig, "base64")
    );
    if (!valid) throw new Error(`模組「${moduleId}」簽章驗證失敗`);
  } catch (error) {
    throw new Error(
      `模組「${moduleId}」簽章驗證失敗：${error instanceof Error ? error.message : error}`
    );
  }
  return { signed: true };
}

async function downloadArchive(url) {
  const response = await globalThis.fetch(url, { redirect: "follow", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`下載模組失敗（HTTP ${response.status}）：${url}`);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`模組套件過大（超過 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`模組套件過大（超過 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）`);
  }
  return buffer;
}

function archiveExtension(url) {
  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith(".zip")) return ".zip";
  if (pathname.endsWith(".tar.gz")) return ".tar.gz";
  return null;
}

function extractArchive(buffer, extension, tempDir) {
  const archivePath = path.join(tempDir, `module${extension}`);
  fs.writeFileSync(archivePath, buffer);

  if (extension === ".zip") {
    const zip = new AdmZip(archivePath);
    let declaredBytes = 0;
    let entryCount = 0;
    for (const entry of zip.getEntries()) {
      assertSafeEntryName(entry.entryName);
      entryCount += 1;
      if (entryCount > MAX_EXTRACTED_FILES) {
        throw new Error(`解壓後檔案數過多（超過 ${MAX_EXTRACTED_FILES} 個）`);
      }
      const size = Number(entry.header?.size ?? 0);
      if (Number.isFinite(size) && size > 0) declaredBytes += size;
      if (declaredBytes > MAX_EXTRACTED_BYTES) {
        throw new Error(`解壓後過大（超過 ${MAX_EXTRACTED_BYTES / 1024 / 1024}MB）`);
      }
    }
    zip.extractAllTo(tempDir, true);
  } else {
    const listResult = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf-8" });
    if (listResult.status !== 0) {
      throw new Error("tar 無法列出壓縮檔內容，拒絕安裝");
    }
    for (const line of (listResult.stdout || "").split("\n")) {
      if (line.trim()) assertSafeEntryName(line.trim());
    }
    const verboseResult = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf-8" });
    if (verboseResult.status === 0) {
      let declaredBytes = 0;
      for (const line of (verboseResult.stdout || "").split("\n")) {
        const size = Number(/^\S+\s+\S+\s+(\d+)\s/.exec(line.trim())?.[1] ?? NaN);
        if (Number.isFinite(size)) declaredBytes += size;
        if (declaredBytes > MAX_EXTRACTED_BYTES) {
          throw new Error(`解壓後過大（超過 ${MAX_EXTRACTED_BYTES / 1024 / 1024}MB）`);
        }
      }
    }
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", tempDir], {
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      throw new Error(
        `tar 解壓失敗：${result.error?.message || result.stderr || result.stdout || ""}`
      );
    }
  }

  assertExtractedTree(tempDir);
}

function readManifest(dir) {
  const raw = fs.readFileSync(path.join(dir, "module.json"), "utf-8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

/** 處理單一 lock 項目；回傳 "skipped"／"installed"／"updated"。 */
export async function materializeEntry(entry, options = {}) {
  const url = parseMarketSource(entry?.source);
  if (!url) return "skipped";

  const moduleId = typeof entry.value === "string" ? entry.value : "";
  if (!/^[a-z][A-Za-z0-9]*$/.test(moduleId)) {
    throw new Error(`module.lock.json 的 value 格式錯誤：${entry.value}`);
  }

  const target = path.join(MODULES_DIR, moduleId);
  const exists = fs.existsSync(target);
  if (exists && typeof entry.treeSha256 === "string" && entry.treeSha256) {
    if (hashTree(target) === entry.treeSha256) return "skipped";
  } else if (exists) {
    // 舊版 lock 沒有 treeSha256（通常也把檔案 commit 進 repo）→ 保留現況
    return "skipped";
  }

  const extension = archiveExtension(url);
  if (!extension) {
    throw new Error(`模組「${moduleId}」的下載網址不是 .zip／.tar.gz：${url}`);
  }

  if (options.log) options.log(`[materialize] 下載 ${moduleId}：${url}`);
  const buffer = await downloadArchive(url);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (entry.sha256 && sha256 !== entry.sha256) {
    throw new Error(`模組「${moduleId}」套件完整性校驗失敗（sha256 不符）`);
  }
  verifyArchiveSignature({
    moduleId,
    sha256,
    signature: entry.signature,
    publicKey: entry.publicKey,
  });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `campus-materialize-${moduleId}-`));
  try {
    extractArchive(buffer, extension, tempRoot);
    const moduleRoot = findModuleRoot(tempRoot);
    const manifest = readManifest(moduleRoot);
    if (manifest.value !== moduleId) {
      throw new Error(
        `模組「${moduleId}」manifest.value 不符（實際：${String(manifest.value)}）`
      );
    }
    if (entry.version && manifest.author?.version !== entry.version) {
      throw new Error(
        `模組「${moduleId}」版本不符（lock：${entry.version}、manifest：${String(
          manifest.author?.version
        )}）`
      );
    }
    const treeSha256 = hashTree(moduleRoot);
    if (entry.treeSha256 && treeSha256 !== entry.treeSha256) {
      throw new Error(`模組「${moduleId}」目錄雜湊不符（lock 與下載內容不一致）`);
    }

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(moduleRoot, target, { recursive: true });
    return exists ? "updated" : "installed";
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function materializeAll(options = {}) {
  if (!fs.existsSync(LOCK_FILE)) return { installed: 0, updated: 0, skipped: 0 };
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf-8"));
  } catch (error) {
    throw new Error(`module.lock.json 無法解析：${error instanceof Error ? error.message : error}`);
  }
  const modules = Array.isArray(lock?.modules) ? lock.modules : [];
  const counts = { installed: 0, updated: 0, skipped: 0 };
  for (const entry of modules) {
    const result = await materializeEntry(entry, options);
    if (result in counts) counts[result] += 1;
  }
  return counts;
}

async function main() {
  const counts = await materializeAll({
    log: (message) => process.stdout.write(`${message}\n`),
  });
  if (counts.installed || counts.updated) {
    process.stdout.write(
      `[materialize] 完成：新安裝 ${counts.installed}、更新 ${counts.updated}、略過 ${counts.skipped}\n`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[materialize] 失敗：${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
