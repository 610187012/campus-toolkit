import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { getClientIp } from "@/lib/audit";
import { moduleSecret } from "@/lib/module-secret";
import { createHostRpc } from "@/lib/module-sandbox/host";

/**
 * 模組沙箱 runtime manager（P1-9 Phase 2C）。
 *
 * 由 `scripts/build-module-sandbox.mjs` 產生 `.module-sandbox/<value>/`；
 * 本檔在執行期啟動受限子程序，把請求送進去，並處理子程序的 capability RPC。
 *
 * 啟用方式：`MODULE_SANDBOX_MODULES=examRegistration`（逗號分隔）。
 * 未啟用、或找不到編譯產物時，adapter 會回退到原本的 in-process handler。
 */

const SANDBOX_ROOT = path.join(process.cwd(), ".module-sandbox");
const XLSX_PATH = path.join(process.cwd(), "node_modules", "xlsx", "xlsx.mjs");
const PASSTHROUGH_READS = [path.join(process.cwd(), "node_modules", "jose")];
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_PER_MODULE = 4;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const inFlight = new Map<string, number>();

/** 只有清單內的模組會拿到對應環境變數；避免把 A 模組的秘密傳給 B 模組。 */
const MODULE_ENV: Record<string, readonly string[]> = {
  selfDirectedLearning: ["CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET", "CANVA_REDIRECT_URI"],
};

function moduleEnv(moduleValue: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MODULE_ENV[moduleValue] ?? []) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
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

globalThis.fetch = async (input, init = {}) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const headers = init.headers
    ? Object.fromEntries(new Headers(init.headers).entries())
    : {};
  let body;
  let bodyBase64;
  if (typeof init.body === "string") body = init.body;
  else if (init.body instanceof URLSearchParams) body = init.body.toString();
  else if (init.body instanceof Uint8Array) bodyBase64 = Buffer.from(init.body).toString("base64");
  else if (init.body != null) throw new Error("沙箱 fetch 尚未支援的 body 型別");
  const result = await rpc("net.fetch", {
    url,
    method: (init.method ?? "GET").toUpperCase(),
    headers,
    body,
    bodyBase64,
  });
  return new Response(Uint8Array.from(Buffer.from(result.body, "base64")), {
    status: result.status,
    headers: result.headers,
  });
};

process.on("message", (message) => {
  if (message?.type !== "rpc-result") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error ?? "RPC 失敗"));
});

const { pathToFileURL } = await import("node:url");
const route = await import(pathToFileURL(process.env.MODULE_SANDBOX_ROUTE).href);

process.on("message", async (message) => {
  if (message?.type !== "request") return;
  try {
    const url = new URL(message.url, "http://sandbox.local");
    const cookieMap = new Map();
    for (const part of String(message.headers?.cookie ?? "").split(";")) {
      const index = part.indexOf("=");
      if (index > 0) cookieMap.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
    const request = {
      method: message.method,
      nextUrl: url,
      headers: new Headers(message.headers ?? {}),
      json: async () => (message.body ? JSON.parse(message.body) : {}),
      text: async () => message.body ?? "",
      formData: async () => {
        const form = new FormData();
        for (const part of message.form ?? []) {
          if (part.filename === undefined) {
            form.append(part.name, part.value ?? "");
          } else {
            const bytes = Uint8Array.from(Buffer.from(part.data ?? "", "base64"));
            form.append(
              part.name,
              new Blob([bytes], { type: part.type || "application/octet-stream" }),
              part.filename
            );
          }
        }
        return form;
      },
      cookies: {
        get: (name) => (cookieMap.has(name) ? { name, value: cookieMap.get(name) } : undefined),
        has: (name) => cookieMap.has(name),
      },
    };
    const handler = route[message.method];
    if (!handler) throw new Error("沙箱尚未支援 method：" + message.method);
    const response = await handler(request);
    process.send({
      type: "response",
      ok: true,
      response: {
        status: response?.status ?? 200,
        headers: response?.headers ?? {},
        body: typeof response?.body === "string" ? response.body : "",
        binary: response?.binary === true,
        cookies: Array.isArray(response?.cookies?._items) ? response.cookies._items : [],
      },
    });
  } catch (error) {
    process.send({
      type: "response",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

process.send({ type: "ready" });
`;

let cachedRunnerPath: string | null = null;

function ensureRunnerFile(): string {
  if (cachedRunnerPath && fs.existsSync(cachedRunnerPath)) return cachedRunnerPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "campus-module-sandbox-"));
  const file = path.join(dir, "runner.mjs");
  fs.writeFileSync(file, RUNNER_SOURCE, "utf-8");
  cachedRunnerPath = file;
  return file;
}

export interface SandboxFormPart {
  name: string;
  value?: string;
  filename?: string;
  type?: string;
  /** 檔案內容 base64 */
  data?: string;
}

export interface SandboxRequest {
  url: string;
  headers: Record<string, string>;
  body?: string;
  form?: SandboxFormPart[];
}

export interface SandboxResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  binary: boolean;
  cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>;
}

export type SandboxRpc = (method: string, params: unknown) => Promise<unknown> | unknown;

interface SandboxManifest {
  moduleValue: string;
  routes: Array<{ path: string; file: string; methods: string[] }>;
}

/** 該模組是否啟用沙箱（環境變數＋編譯產物都存在才算）。 */
export function isSandboxEnabled(moduleValue: string): boolean {
  const list = (process.env.MODULE_SANDBOX_MODULES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!list.includes(moduleValue)) return false;
  return fs.existsSync(path.join(SANDBOX_ROOT, moduleValue, "manifest.json"));
}

/**
 * 在受限子程序執行一次模組請求。
 *
 * `bundleDir` 供測試注入；正式路徑使用 `.module-sandbox/<value>/`。
 */
export async function runSandboxedRequest(options: {
  moduleValue: string;
  routePath: string;
  method: string;
  request: SandboxRequest;
  rpc: SandboxRpc;
  timeoutMs?: number;
  bundleDir?: string;
  clientIp?: string;
}): Promise<SandboxResponse> {
  const bundleDir = options.bundleDir ?? path.join(SANDBOX_ROOT, options.moduleValue);
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`找不到沙箱 manifest：${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SandboxManifest;
  const route = manifest.routes.find(
    (item) => item.path === options.routePath && item.methods.includes(options.method)
  );
  if (!route) {
    throw new Error(`沙箱沒有對應路由：${options.method} ${options.routePath}`);
  }
  const runnerPath = ensureRunnerFile();
  const routeFile = path.join(bundleDir, route.file);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const running = inFlight.get(options.moduleValue) ?? 0;
  if (running >= MAX_CONCURRENT_PER_MODULE) {
    throw new Error("模組沙箱同時請求過多，請稍後再試");
  }
  inFlight.set(options.moduleValue, running + 1);
  const release = () => {
    const next = (inFlight.get(options.moduleValue) ?? 1) - 1;
    if (next <= 0) inFlight.delete(options.moduleValue);
    else inFlight.set(options.moduleValue, next);
  };

  return new Promise<SandboxResponse>((resolve, reject) => {
    const args = [
      "--permission",
      `--allow-fs-read=${bundleDir}`,
      `--allow-fs-read=${runnerPath}`,
    ];
    if (fs.existsSync(XLSX_PATH)) args.push(`--allow-fs-read=${XLSX_PATH}`);
    for (const readPath of PASSTHROUGH_READS) {
      if (fs.existsSync(readPath)) args.push(`--allow-fs-read=${readPath}`);
    }
    args.push(runnerPath);

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...moduleEnv(options.moduleValue),
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        MODULE_SANDBOX_ROUTE: routeFile,
        SANDBOX_CLIENT_IP: options.clientIp ?? "",
        // 過渡期相容：讓仍讀 process.env.SESSION_SECRET 的模組拿到「模組專屬」
        // 密鑰，而不是宿主真正用來簽 session 的 SESSION_SECRET。
        SESSION_SECRET: moduleSecret(options.moduleValue, "session"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let settled = false;
    let stderr = "";
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`模組沙箱逾時（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(error);
    });
    child.on("message", (message: unknown) => {
      const data = message as Record<string, unknown>;
      if (data?.type === "ready") {
        child.send({
          type: "request",
          method: options.method,
          url: options.request.url,
          headers: options.request.headers,
          body: options.request.body,
          form: options.request.form,
        });
        return;
      }
      if (data?.type === "rpc") {
        Promise.resolve(options.rpc(String(data.method), data.params))
          .then((result) => {
            child.send({ type: "rpc-result", id: data.id, ok: true, result });
          })
          .catch((error: unknown) => {
            child.send({
              type: "rpc-result",
              id: data.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      if (data?.type === "response") {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        child.kill();
        if (!data.ok) {
          reject(new Error(`模組沙箱執行失敗：${String(data.error)}\n${stderr}`));
          return;
        }
        const response = data.response as SandboxResponse;
        const responseBody = typeof response?.body === "string" ? response.body : "";
        if (responseBody.length > MAX_RESPONSE_BYTES) {
          reject(new Error("模組沙箱回應過大，已中止"));
          return;
        }
        resolve({
          status: Number(response?.status ?? 200),
          headers: response?.headers ?? {},
          body: responseBody,
          binary: response?.binary === true,
          cookies: Array.isArray(response?.cookies) ? response.cookies : [],
        });
      }
    });
  }).finally(release);
}

type RouteHandler = (request: NextRequest, context?: unknown) => Promise<Response> | Response;

/**
 * 包裝模組 API handler：沙箱啟用時走子程序，否則原樣呼叫。
 */
export function withModuleSandbox<T extends RouteHandler>(
  moduleValue: string,
  routePath: string,
  original: T
): T {
  const wrapped = async (request: NextRequest, context?: unknown): Promise<Response> => {
    if (!isSandboxEnabled(moduleValue)) return original(request, context);

    const contentType = request.headers.get("content-type") ?? "";

    try {
      const session = await verifySession();
      if (!session) {
        return NextResponse.json(
          { success: false, message: "未登入或登入已失效" },
          { status: 401 }
        );
      }
      const method = request.method.toUpperCase();
      let body: string | undefined;
      let form: SandboxFormPart[] | undefined;
      if (method !== "GET" && method !== "HEAD") {
        if (contentType.includes("multipart/form-data")) {
          const parsed = await request.formData();
          form = [];
          for (const [name, value] of parsed.entries()) {
            if (typeof value === "string") {
              form.push({ name, value });
            } else {
              form.push({
                name,
                filename: value.name,
                type: value.type,
                data: Buffer.from(await value.arrayBuffer()).toString("base64"),
              });
            }
          }
        } else {
          body = await request.text();
        }
      }
      const result = await runSandboxedRequest({
        moduleValue,
        routePath,
        method,
        request: {
          url: `${request.nextUrl.pathname}${request.nextUrl.search}`,
          headers: Object.fromEntries(request.headers.entries()),
          body,
          form,
        },
        rpc: createHostRpc({
          moduleValue,
          session,
          ip: getClientIp(request),
        }),
        clientIp: getClientIp(request),
      });
      const responseBody = result.binary
        ? new Uint8Array(Buffer.from(result.body, "base64"))
        : result.body;
      const nextResponse = new NextResponse(responseBody, {
        status: result.status,
        headers: result.headers,
      });
      for (const cookie of result.cookies) {
        nextResponse.cookies.set(
          cookie.name,
          cookie.value,
          cookie.options as Parameters<typeof nextResponse.cookies.set>[2]
        );
      }
      return nextResponse;
    } catch (error) {
      console.error(`[module-sandbox] ${moduleValue} ${routePath} 執行失敗`, error);
      return NextResponse.json(
        { success: false, message: "模組執行失敗，請稍後再試" },
        { status: 502 }
      );
    }
  };
  return wrapped as T;
}
