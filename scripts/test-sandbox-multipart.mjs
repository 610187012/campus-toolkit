/**
 * 沙箱 multipart／檔案上傳窗口測試（P1-9 Phase 2C 收尾）。
 * 建立一個臨時 probe bundle，驗證 manager 會把 FormData 傳進子程序，不再回退原流程。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
const PROBE_DIR = path.join(ROOT, ".module-sandbox", "sandboxProbe");

fs.rmSync(PROBE_DIR, { recursive: true, force: true });
fs.mkdirSync(PROBE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(PROBE_DIR, "route.mjs"),
  `export async function POST(request) {
  const form = await request.formData();
  const title = form.get("title");
  const file = form.get("file");
  const bytes = file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      filename: file?.name ?? "",
      type: file?.type ?? "",
      text: Buffer.from(bytes).toString("utf8"),
      canvaClientId: process.env.CANVA_CLIENT_ID ?? "",
    }),
    binary: false,
    cookies: [],
  };
}
`
);
fs.writeFileSync(
  path.join(PROBE_DIR, "manifest.json"),
  `${JSON.stringify(
    {
      moduleValue: "sandboxProbe",
      routes: [{ path: "/api/probe", file: "route.mjs", methods: ["POST"] }],
    },
    null,
    2
  )}\n`
);

process.env.MODULE_SANDBOX_MODULES = "sandboxProbe";
process.env.CANVA_CLIENT_ID = "should-not-leak";

const swc = requireHost("next/dist/build/swc");
const source = fs.readFileSync(
  path.join(ROOT, "src", "lib", "module-sandbox", "manager.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});

class FakeNextResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers ?? {};
  }
  static json(body, init = {}) {
    return new FakeNextResponse(JSON.stringify(body), init);
  }
}

const session = { uid: "u1", role: "admin", account: "u1", displayName: "測試員" };
const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") {
      return { NextRequest: class {}, NextResponse: FakeNextResponse };
    }
    if (name === "@/lib/dal") return { verifySession: async () => session };
    if (name === "@/lib/audit") return { getClientIp: () => "127.0.0.1" };
    if (name === "@/lib/module-secret")
      return { moduleSecret: () => "sandbox-test-module-secret-0123456789abcdef" };
    if (name === "@/lib/module-sandbox/host") return { createHostRpc: () => async () => ({}) };
    return requireHost(name);
  },
  mod,
  mod.exports
);

const form = new globalThis.FormData();
form.append("title", "測試標題");
form.append("file", new globalThis.Blob(["hello sandbox"], { type: "text/plain" }), "note.txt");

const request = {
  method: "POST",
  headers: new globalThis.Headers({ "content-type": "multipart/form-data; boundary=probe" }),
  nextUrl: { pathname: "/api/probe", search: "" },
  formData: async () => form,
  text: async () => {
    throw new Error("multipart 不應呼叫 text()");
  },
};

let fellBack = false;
const wrapped = mod.exports.withModuleSandbox("sandboxProbe", "/api/probe", async () => {
  fellBack = true;
  throw new Error("不應回退原流程");
});

const response = await wrapped(request);
assert.equal(fellBack, false, "multipart 應進沙箱，不應回退原流程");
assert.equal(response.status, 200, String(response.body));
const body = JSON.parse(response.body);
assert.equal(body.title, "測試標題");
assert.equal(body.filename, "note.txt");
assert.equal(body.type, "text/plain");
assert.equal(body.text, "hello sandbox");
assert.equal(body.canvaClientId, "", "非 E 模組不應拿到 CANVA_* 環境變數");

fs.rmSync(PROBE_DIR, { recursive: true, force: true });

process.stdout.write(
  "[sandbox-multipart] 檔案上傳已由 manager 傳入 permission 子程序並正確重建 FormData\n"
);
