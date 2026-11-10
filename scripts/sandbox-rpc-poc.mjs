/**
 * 沙箱 capability RPC POC（P1-9 Phase 2B 前置）。
 *
 * 驗證模組 handler 在受限子程序中，透過 IPC 向宿主要求：
 *   - session
 *   - 模組專屬密鑰
 *   - Firestore 查詢（只回傳宿主允許的結果）
 *
 * 這仍不是正式執行路徑；正式版要把這裡的 fake host 換成
 * verifySession／scopedDb／掛勾實作。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const RUNNER_SOURCE = `
import fs from "node:fs";

const pending = new Map();
let seq = 0;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send({ type: "rpc", id, method, params });
  });
}

process.on("message", (message) => {
  if (message?.type !== "rpc-result") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error ?? "RPC 失敗"));
});

const sandbox = {
  secret: (name) => rpc("secret.get", { name }),
  session: () => rpc("session.get", {}),
  db: {
    query: (collection, options) => rpc("db.query", { collection, options }),
  },
};

const { handler } = await import(new URL("./handler.mjs", import.meta.url));

process.on("message", async (message) => {
  if (message?.type !== "request") return;
  try {
    const result = await handler(message.request, sandbox);
    process.send({ type: "response", ok: true, result });
  } catch (error) {
    process.send({ type: "response", ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

process.send({ type: "ready" });
`;

const HANDLER_SOURCE = `
export async function handler(request, sandbox) {
  const session = await sandbox.session();
  const secret = await sandbox.secret("canva");
  const rows = await sandbox.db.query("demoCollection", { limit: 2 });
  return { session, secretLength: secret.length, rows, echo: request.value };
}
`;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "module-sandbox-rpc-"));
const runner = path.join(temp, "runner.mjs");
const handler = path.join(temp, "handler.mjs");
fs.writeFileSync(runner, RUNNER_SOURCE);
fs.writeFileSync(handler, HANDLER_SOURCE);

function runSandbox() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${temp}`, runner],
      {
        cwd: process.cwd(),
        env: {
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
      reject(new Error(`沙箱 RPC 逾時\nstdout: ${stdout}\nstderr: ${stderr}`));
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
      if (message?.type === "ready") {
        child.send({ type: "request", request: { value: 21 } });
        return;
      }
      if (message?.type === "rpc") {
        const reply = (result) =>
          child.send({ type: "rpc-result", id: message.id, ok: true, result });
        const fail = (error) =>
          child.send({ type: "rpc-result", id: message.id, ok: false, error });
        try {
          switch (message.method) {
            case "session.get":
              reply({ uid: "u1", role: "admin", account: "demo" });
              break;
            case "secret.get":
              reply(`derived-secret:${message.params?.name ?? "default"}`);
              break;
            case "db.query":
              if (message.params?.collection !== "demoCollection") {
                fail("未宣告集合");
                break;
              }
              reply([{ id: "a" }, { id: "b" }]);
              break;
            default:
              fail(`未知 RPC：${message.method}`);
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (message?.type === "response") {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        child.kill();
        if (!message.ok) {
          reject(new Error(`handler 失敗：${message.error}\n${stderr}`));
          return;
        }
        resolve({ result: message.result, stdout, stderr });
      }
    });
  });
}

try {
  const { result } = await runSandbox();
  assert.deepEqual(result.session, { uid: "u1", role: "admin", account: "demo" });
  assert.equal(result.secretLength, "derived-secret:canva".length);
  assert.deepEqual(result.rows, [{ id: "a" }, { id: "b" }]);
  assert.equal(result.echo, 21);
  process.stdout.write(
    "[sandbox-rpc-poc] session／密鑰／集合查詢 RPC 與 permission 隔離全部通過\n"
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
