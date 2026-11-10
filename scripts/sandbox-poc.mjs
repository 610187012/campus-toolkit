/**
 * 模組沙箱 POC（P1-9 第二階段）。
 *
 * 這不是正式執行路徑，而是驗證三個隔離原語：
 *   1. 子程序只拿到 filtered env（沒有 SESSION_SECRET，只有模組專屬密鑰）
 *   2. Node permission model 擋掉任意檔案讀取與 child_process
 *   3. 父程序可以透過 IPC 呼叫子程序裡的模組 handler
 *
 * 正式整合還需要 session／Firestore／掛勾的 capability RPC，見
 * `docs/模組沙箱設計.md`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const RUNNER_SOURCE = `
import fs from "node:fs";

function safe(label, fn) {
  try {
    return { status: "allowed", value: fn() };
  } catch (error) {
    return { status: "denied", code: error?.code ?? "UNKNOWN" };
  }
}

const fsRead = safe("fs", () => fs.readFileSync("package.json", "utf8").slice(0, 12));
const childProcess = safe("child", () => {
  // 在 permission model 下，require 本身就會被拒絕
  return require("node:child_process").execSync("whoami").toString();
});

const { handler } = await import(new URL("./handler.mjs", import.meta.url));

process.on("message", async (message) => {
  try {
    const result = await handler(message);
    process.send({
      ok: true,
      result,
      envKeys: Object.keys(process.env).sort(),
      sessionSecret: process.env.SESSION_SECRET ?? null,
      moduleSecret: process.env.MODULE_SECRET ?? null,
      fsRead,
      childProcess,
    });
  } catch (error) {
    process.send({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

process.send({ ok: true, ready: true });
`;

const HANDLER_SOURCE = `
export async function handler(input) {
  if (!input || typeof input.value !== "number") {
    throw new Error("value 必須是數字");
  }
  return { echoed: input.value * 2 };
}
`;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "module-sandbox-poc-"));
const runner = path.join(temp, "runner.mjs");
const handler = path.join(temp, "handler.mjs");
fs.writeFileSync(runner, RUNNER_SOURCE);
fs.writeFileSync(handler, HANDLER_SOURCE);

function runSandbox() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${temp}`,
        runner,
      ],
      {
        cwd: process.cwd(),
        env: {
          // 只給模組專屬密鑰與最基本的路徑設定；刻意不放 SESSION_SECRET
          PATH: process.env.PATH ?? "",
          MODULE_SECRET: "module-specific-secret",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`沙箱子程序逾時\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(error);
    });
    child.on("message", (message) => {
      if (message?.ready) {
        child.send({ value: 21 });
        return;
      }
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      child.kill();
      if (!message?.ok) {
        reject(new Error(`handler 失敗：${message?.error}\n${stderr}`));
        return;
      }
      resolve({ message, stdout, stderr });
    });
  });
}

try {
  const { message } = await runSandbox();

  assert.equal(message.sessionSecret, null, "子程序不應看到 SESSION_SECRET");
  assert.equal(message.moduleSecret, "module-specific-secret", "應只看到模組專屬密鑰");
  assert.equal(message.fsRead.status, "denied", "任意檔案讀取應被拒絕");
  assert.equal(message.childProcess.status, "denied", "child_process 應被拒絕");
  assert.deepEqual(message.result, { echoed: 42 }, "IPC 呼叫模組 handler 應成功");
  assert.ok(!message.envKeys.includes("SESSION_SECRET"), "envKeys 不應包含 SESSION_SECRET");

  process.stdout.write(
    "[sandbox-poc] filtered env、file/child_process 拒絕與 IPC handler 呼叫全部通過\n"
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
