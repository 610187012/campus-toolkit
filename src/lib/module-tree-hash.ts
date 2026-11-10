import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 模組目錄的內容雜湊（P1-10）。
 *
 * 與 `scripts/module-cli.mjs` 的 `hashTree` 相同演算法：
 * 依路徑排序，逐檔把「相對路徑＋檔案 sha256」併入同一個 sha256。
 * 用於 lock-only 安裝時判斷 `src/modules/<value>` 是否已是最新的套件內容。
 */

const EXCLUDE = new Set([".git", "node_modules", ".next"]);

export function hashModuleTree(root: string): string {
  const digest = crypto.createHash("sha256");
  const walk = (dir: string) => {
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
