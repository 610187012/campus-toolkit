/**
 * test-module-contract.mjs —— 模組契約測試（附錄 A 掃描器可測案例）
 *
 * 對照 `docs/模組市集與外掛開發.md` 附錄 A：以壞 manifest fixtures 驗證
 * `build-module-registry.mjs` 的驗證鏈逐項點名。以 env 觸發掃描器的測試模式：
 *   MODULE_REGISTRY_DIR          → fixtures 目錄
 *   MODULE_REGISTRY_VALIDATE_ONLY=1 → 只驗證、不產生產物／不動轉接檔
 *
 * 執行：node scripts/test-module-contract.mjs（npm run module:contract-test）
 * 任一案例不符期望即 exit 1；全過輸出通過數。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = path.join(ROOT, "scripts", "build-module-registry.mjs");

/** 合法 manifest 基底（各案例以此覆寫單一欄位） */
function baseManifest(overrides = {}) {
  return {
    value: "contractFixture",
    label: "契約測試fixture",
    kind: "optional",
    status: "live",
    description: "契約測試用臨時模組。",
    href: "/admin/contract-fixture",
    contractVersion: 1,
    minHostVersion: "0.381",
    author: { author: "test", authorUrl: "", version: "1.0.0", releasedAt: "2026-10-17" },
    provides: { student: false, parent: false, staff: true, admin: true },
    routes: [{ kind: "page", path: "/admin/contract-fixture" }],
    permission: { mode: "new", value: "contractFixture", category: "校務資料" },
    ...overrides,
  };
}

/**
 * 附錄 A 掃描器可測案例（其餘如 sha256、體積、簽章屬市集側，不在此跑）。
 * expect: "reject"（exit 1 且輸出含 contains）／"pass"（exit 0；warnAt 含警示字樣）
 */
const CASES = [
  {
    id: 1,
    dir: "contractFixture",
    manifest: baseManifest(),
    expect: "pass",
  },
  {
    id: 2,
    dir: "contractFixture",
    manifest: baseManifest({ contractVersion: 2 }),
    expect: "reject",
    contains: "contractVersion 2 ＞ 主程式當前契約",
  },
  {
    id: 3,
    dir: "contractFixture",
    manifest: baseManifest({ minHostVersion: "0.999" }),
    expect: "reject",
    contains: "需先升級主程式",
  },
  {
    id: 5,
    dir: "contractFixture",
    manifest: baseManifest({ href: "" }),
    expect: "reject",
    contains: "status 為 live 時 href 不可為空",
  },
  {
    id: 6,
    dir: "announcements",
    manifest: baseManifest({ value: "announcements", permission: { mode: "new", value: "announcements", category: "校務資料" } }),
    expect: "reject",
    contains: "與內建模組／權限單位撞名",
  },
  {
    id: 7,
    dir: "contractFixture",
    manifest: baseManifest(),
    packageJson: { dependencies: { lodash: "^4.17.0" } },
    expect: "reject",
    contains: "不可含 dependencies",
  },
  {
    id: 10,
    dir: "contractFixture",
    manifest: baseManifest({ rateLimits: [{ key: "GET", limit: 60, windowMs: 60000 }] }),
    expect: "reject",
    contains: "需以「CONTRACT_FIXTURE_」開頭",
  },
  {
    id: 12,
    dir: "contractFixture",
    manifest: baseManifest({ hooks: ["notImplementedHook"] }),
    expect: "pass",
    warnAt: "尚未實作的掛勾",
  },
  {
    id: 14,
    dir: "contractFixture",
    manifest: baseManifest({ routes: [{ kind: "page", path: "/dashboard" }] }),
    expect: "reject",
    contains: "不在白名單前綴",
  },
  {
    id: 15,
    dir: "contractFixture",
    manifest: baseManifest({ routes: [{ kind: "api", path: "/api/admin/announcements" }] }),
    expect: "reject",
    contains: "與既有 src/app 路由撞名",
  },
  {
    id: 17,
    dir: "contractFixture",
    manifest: baseManifest({
      provides: { student: false, parent: false, staff: true, admin: true },
      defaultRoleEnabled: { parent: false },
    }),
    expect: "reject",
    contains: "未提供身分不需預設",
  },
  {
    id: 19,
    dir: "contractFixture",
    manifest: baseManifest({ routes: [{ kind: "page", path: "/admin/../../../../scripts/evil" }] }),
    expect: "reject",
    contains: "不安全路徑",
  },
  {
    id: 20,
    dir: "contractFixture",
    manifest: baseManifest({ routes: [{ kind: "page", path: "/admin/..\\..\\scripts\\evil" }] }),
    expect: "reject",
    contains: "不安全路徑",
  },
  {
    id: 21,
    dir: "contractFixture",
    manifest: baseManifest({ dataCollections: ["users"] }),
    expect: "reject",
    contains: "宿主保留集合",
  },
];

function runScanner(fixtureDir) {
  return spawnSync(process.execPath, [SCANNER], {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      MODULE_REGISTRY_DIR: fixtureDir,
      MODULE_REGISTRY_VALIDATE_ONLY: "1",
    },
  });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "module-contract-"));
let failed = 0;

try {
  for (const testCase of CASES) {
    const fixtureDir = path.join(tmpRoot, `case${testCase.id}`);
    const moduleDir = path.join(fixtureDir, testCase.dir);
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, "module.json"),
      `${JSON.stringify(testCase.manifest, null, 2)}\n`,
      "utf-8"
    );
    if (testCase.packageJson) {
      fs.writeFileSync(
        path.join(moduleDir, "package.json"),
        `${JSON.stringify(testCase.packageJson, null, 2)}\n`,
        "utf-8"
      );
    }

    const result = runScanner(fixtureDir);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    let ok;
    let reason;
    if (testCase.expect === "reject") {
      ok = result.status === 1 && output.includes(testCase.contains);
      reason = ok ? "" : `期望拒絕（含「${testCase.contains}」），實得 status=${result.status}`;
    } else {
      ok = result.status === 0 && (!testCase.warnAt || output.includes(testCase.warnAt));
      reason = ok ? "" : `期望通過${testCase.warnAt ? `（含警示「${testCase.warnAt}」）` : ""}，實得 status=${result.status}`;
    }

    if (ok) {
      process.stdout.write(`#${testCase.id} ${testCase.expect === "reject" ? "拒絕" : "通過"} ✓\n`);
    } else {
      failed += 1;
      process.stderr.write(`#${testCase.id} 失敗：${reason}\n`);
      process.stderr.write(`${output}\n`);
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failed > 0) {
  process.stderr.write(`契約測試：${failed}/${CASES.length} 個案例失敗\n`);
  process.exit(1);
}
process.stdout.write(`契約測試：${CASES.length} 個案例全數通過\n`);
