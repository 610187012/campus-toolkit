/**
 * 沙箱資料窗口 POC（P1-9 Phase 2B）。
 *
 * 模組 handler 在受限子程序中，不能直接拿 Firestore Admin。
 * 它只能組查詢（collection／where／orderBy／limit），由宿主執行後
 * 回傳最小結果；模組看不到其他集合，也拿不到 credential。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

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

process.on("message", (message) => {
  if (message?.type !== "rpc-result") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error ?? "RPC 失敗"));
});

class Query {
  constructor(collection) {
    this.collection = collection;
    this.filters = [];
    this.limitValue = null;
    this.order = null;
  }
  where(field, op, value) {
    this.filters.push({ field, op, value });
    return this;
  }
  orderBy(field, direction = "asc") {
    this.order = { field, direction };
    return this;
  }
  limit(value) {
    this.limitValue = value;
    return this;
  }
  async get() {
    const result = await rpc("db.query", {
      collection: this.collection,
      filters: this.filters,
      orderBy: this.order,
      limit: this.limitValue,
    });
    const docs = result.rows.map((row) => ({
      id: row.id,
      data: () => row.data,
    }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

const sandbox = {
  db: {
    collection: (name) => new Query(name),
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
export async function handler(_request, sandbox) {
  const snap = await sandbox.db
    .collection("demo")
    .where("x", "==", 1)
    .orderBy("name", "asc")
    .limit(2)
    .get();
  return {
    ids: snap.docs.map((doc) => doc.id),
    names: snap.docs.map((doc) => doc.data().name),
    size: snap.size,
    empty: snap.empty,
    // 證明模組拿不到其他集合：宿主只允許 demo
    other: await sandbox.db.collection("users").limit(1).get().then(
      () => "allowed",
      () => "denied"
    ),
  };
}
`;

// 宿主端的假資料；正式版會換成 scopedDb。
const HOST_DB = {
  demo: [
    { id: "c", data: { x: 2, name: "C" } },
    { id: "b", data: { x: 1, name: "B" } },
    { id: "a", data: { x: 1, name: "A" } },
  ],
  users: [{ id: "u1", data: { email: "secret@example.com" } }],
};

function applyFilters(rows, filters) {
  return rows.filter((row) =>
    filters.every(({ field, op, value }) => {
      const actual = row.data[field];
      switch (op) {
        case "==":
          return actual === value;
        case "!=":
          return actual !== value;
        case ">":
          return actual > value;
        case ">=":
          return actual >= value;
        case "<":
          return actual < value;
        case "<=":
          return actual <= value;
        case "array-contains":
          return Array.isArray(actual) && actual.includes(value);
        default:
          return false;
      }
    })
  );
}

function runQuery(params) {
  const collection = params?.collection;
  if (!Object.prototype.hasOwnProperty.call(HOST_DB, collection)) {
    throw new Error(`未宣告集合：${collection}`);
  }
  if (collection === "users") {
    throw new Error("宿主保留集合");
  }
  let rows = applyFilters(HOST_DB[collection], params.filters ?? []);
  if (params.orderBy) {
    const { field, direction } = params.orderBy;
    rows = [...rows].sort((a, b) => {
      const left = a.data[field];
      const right = b.data[field];
      if (left === right) return 0;
      return (left < right ? -1 : 1) * (direction === "desc" ? -1 : 1);
    });
  }
  if (Number.isInteger(params.limit) && params.limit >= 0) {
    rows = rows.slice(0, params.limit);
  }
  return { rows };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "module-sandbox-db-"));
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
      reject(new Error(`沙箱資料窗口逾時\nstdout: ${stdout}\nstderr: ${stderr}`));
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
          if (message.method !== "db.query") throw new Error("未知 RPC");
          child.send({
            type: "rpc-result",
            id: message.id,
            ok: true,
            result: runQuery(message.params),
          });
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
        resolve({ result: message.result, stdout, stderr });
      }
    });
  });
}

try {
  const { result } = await runSandbox();
  assert.deepEqual(result.ids, ["a", "b"], "應只回傳 x=1 且依 name 排序的前兩筆");
  assert.deepEqual(result.names, ["A", "B"]);
  assert.equal(result.size, 2);
  assert.equal(result.empty, false);
  assert.equal(result.other, "denied", "宿主保留集合應被拒絕");
  process.stdout.write(
    "[sandbox-db-poc] 查詢代理、排序、limit 與保留集合拒絕全部通過\n"
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
