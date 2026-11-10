/**
 * 模組能力掃描測試（P1-9 第一階段）。
 * 確認 module-check 會拒絕：
 *   - node: 內建模組
 *   - 宿主秘密環境變數
 *   - 枚舉 process.env
 *   - eval()／new Function()
 * 並允許讀取模組自己的環境變數（只用 SESSION_SECRET 時給警示，不阻擋）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = path.join(ROOT, "scripts", "module-check.mjs");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "module-capability-scan-"));
const moduleDir = path.join(work, "demoModule");

function writeFixture(extraFileContent) {
  fs.rmSync(moduleDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(moduleDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(moduleDir, "admin", "demo-module"), { recursive: true });
  fs.writeFileSync(
    path.join(moduleDir, "module.json"),
    JSON.stringify(
      {
        value: "demoModule",
        label: "能力掃描 fixture",
        kind: "optional",
        status: "live",
        description: "能力掃描測試用",
        href: "/admin/demo-module",
        contractVersion: 1,
        minHostVersion: "0.381",
        author: {
          author: "test",
          authorUrl: "",
          version: "1.0.0",
          releasedAt: "2026-11-10",
        },
        provides: { student: false, parent: false, staff: false, admin: true },
        routes: [{ kind: "page", path: "/admin/demo-module" }],
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(moduleDir, "admin", "demo-module", "page.tsx"),
    "export default function Page() { return null; }\n"
  );
  fs.writeFileSync(
    path.join(moduleDir, "admin", "demo-module", "layout.tsx"),
    'import AdminSectionShell from "@/components/AdminSectionShell";\n' +
      "export default function Layout({ children }: { children: React.ReactNode }) {\n" +
      '  return <AdminSectionShell moduleKey="demoModule">{children}</AdminSectionShell>;\n' +
      "}\n"
  );
  fs.writeFileSync(path.join(moduleDir, "lib", "capability.ts"), extraFileContent);
}

function scan() {
  const result = spawnSync(process.execPath, [SCANNER, moduleDir], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function expectReject(content, contains) {
  writeFixture(content);
  const result = scan();
  assert.equal(result.status, 1, `應拒絕：${content}\n${result.output}`);
  assert.ok(result.output.includes(contains), `錯誤訊息應包含「${contains}」\n${result.output}`);
}

function expectPass(content, contains) {
  writeFixture(content);
  const result = scan();
  assert.equal(result.status, 0, `應通過：${content}\n${result.output}`);
  if (contains) assert.ok(result.output.includes(contains), `應有警示「${contains}」\n${result.output}`);
}

try {
  expectReject('import fs from "node:fs";\nexport const x = fs;\n', "node: 內建模組");
  expectReject(
    "export const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;\n",
    "FIREBASE_SERVICE_ACCOUNT_KEY"
  );
  expectReject("export const all = Object.keys(process.env);\n", "枚舉 process.env");
  expectReject('export const x = eval("1");\n', "eval()");
  expectReject("export const x = new Function('return 1');\n", "new Function()");

  // 模組自己的環境變數可以讀；SESSION_SECRET 只警示
  expectPass("export const id = process.env.CANVA_CLIENT_ID;\n");
  expectPass(
    "export const secret = process.env.SESSION_SECRET;\n",
    "SESSION_SECRET"
  );

  process.stdout.write(
    "[module-capability-scan] node: 內建、秘密環境變數、process.env 枚舉與 eval 全部正確攔截\n"
  );
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
