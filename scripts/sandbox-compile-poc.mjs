/**
 * 沙箱 import 改寫 POC（P1-9 Phase 2B）。
 *
 * 目的：讓模組原始碼不用改寫，build 時把
 *   next/server、@/lib/dal、@/lib/firebase-admin
 * 換成沙箱窗口 shim，再放進受限子程序執行。
 *
 * 這裡用一個「F 風格」的 fixture 驗證，不是直接跑 F。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const requireHost = createRequire(path.join(process.cwd(), "package.json"));
const swc = requireHost("next/dist/build/swc");

const FIXTURE_SOURCE = `
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/dal";
import { scopedDb } from "@/lib/firebase-admin";

export async function GET(_request: NextRequest) {
  const { session } = await requireRole("admin");
  const db = scopedDb("examRegistration");
  const snap = await db.collection("examEvents").limit(2).get();
  return NextResponse.json({
    ok: true,
    role: session.role,
    ids: snap.docs.map((doc) => doc.id),
    size: snap.size,
  });
}
`;

/** 把 TS 轉成 ESM，並改寫宿主 import 到沙箱 shim。 */
function compile(source) {
  const { code } = swc.transformSync(source, {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "es6" },
  });
  return code
    .replace(/(["'])next\/server\1/g, '"./__sandbox/next-server.mjs"')
    .replace(/(["'])@\/lib\/dal\1/g, '"./__sandbox/dal.mjs"')
    .replace(/(["'])@\/lib\/firebase-admin\1/g, '"./__sandbox/firebase-admin.mjs"')
    // 其他宿主 import 先明確失敗，避免安靜地拿到錯誤模組
    .replace(/(["'])@\/[^"']+\1/g, '"./__sandbox/stub.mjs"');
}

const RUNNER_SOURCE = `
const pending = new Map();
let seq = 0;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send({ type: "rpc", id, method, params });
  });
}

globalThis.__sandboxRpc = rpc;

process.on("message", (message) => {
  if (message?.type !== "rpc-result") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error ?? "RPC 失敗"));
});

const { GET } = await import(new URL("./handler.mjs", import.meta.url));

process.on("message", async (message) => {
  if (message?.type !== "request") return;
  try {
    const response = await GET(message.request);
    process.send({ type: "response", ok: true, response });
  } catch (error) {
    process.send({ type: "response", ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

process.send({ type: "ready" });
`;

const NEXT_SERVER_SHIM = `
export class NextRequest {}
export const NextResponse = {
  json(body, init = {}) {
    return {
      status: init.status ?? 200,
      headers: init.headers ?? {},
      body: JSON.stringify(body),
    };
  },
};
`;

const DAL_SHIM = `
export async function requireRole(role) {
  return globalThis.__sandboxRpc("session.get", { requiredRole: role });
}
`;

const FIREBASE_SHIM = `
class Query {
  constructor(collection) {
    this.collection = collection;
    this.limitValue = null;
  }
  limit(value) {
    this.limitValue = value;
    return this;
  }
  async get() {
    const result = await globalThis.__sandboxRpc("db.query", {
      collection: this.collection,
      limit: this.limitValue,
    });
    const docs = result.rows.map((row) => ({ id: row.id, data: () => row.data }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}
export function scopedDb() {
  return { collection: (name) => new Query(name) };
}
export function getAdminDb() {
  return scopedDb();
}
`;

const STUB_SHIM = `
const deny = (name) => {
  throw new Error("沙箱尚未允許宿主模組：" + name);
};
export default new Proxy({}, { get: (_target, prop) => deny(String(prop)) });
export const getAdminDbRaw = () => deny("getAdminDbRaw");
`;

const HOST_DB = {
  examEvents: [
    { id: "e1", data: { name: "第一次模擬考" } },
    { id: "e2", data: { name: "第二次模擬考" } },
    { id: "e3", data: { name: "第三次模擬考" } },
  ],
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "module-sandbox-compile-"));
const shimDir = path.join(temp, "__sandbox");
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(path.join(temp, "handler.mjs"), compile(FIXTURE_SOURCE));
fs.writeFileSync(path.join(temp, "runner.mjs"), RUNNER_SOURCE);
fs.writeFileSync(path.join(shimDir, "next-server.mjs"), NEXT_SERVER_SHIM);
fs.writeFileSync(path.join(shimDir, "dal.mjs"), DAL_SHIM);
fs.writeFileSync(path.join(shimDir, "firebase-admin.mjs"), FIREBASE_SHIM);
fs.writeFileSync(path.join(shimDir, "stub.mjs"), STUB_SHIM);

function runSandbox() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${temp}`, path.join(temp, "runner.mjs")],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
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
      reject(new Error(`沙箱編譯 POC 逾時\nstdout: ${stdout}\nstderr: ${stderr}`));
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
        child.send({ type: "request", request: {} });
        return;
      }
      if (message?.type === "rpc") {
        try {
          let result;
          if (message.method === "session.get") {
            result = { session: { uid: "u1", role: "admin", account: "demo" }, denial: null };
          } else if (message.method === "db.query") {
            const rows = HOST_DB[message.params?.collection];
            if (!rows) throw new Error(`未宣告集合：${message.params?.collection}`);
            result = {
              rows: Number.isInteger(message.params?.limit)
                ? rows.slice(0, message.params.limit)
                : rows,
            };
          } else {
            throw new Error(`未知 RPC：${message.method}`);
          }
          child.send({ type: "rpc-result", id: message.id, ok: true, result });
        } catch (error) {
          child.send({
            type: "rpc-result",
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
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
        resolve({ response: message.response, stdout, stderr });
      }
    });
  });
}

try {
  const { response } = await runSandbox();
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body, { ok: true, role: "admin", ids: ["e1", "e2"], size: 2 });
  process.stdout.write(
    "[sandbox-compile-poc] import 改寫、session RPC 與資料窗口全部通過\n"
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
