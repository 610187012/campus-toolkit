/**
 * API request body 大小限制的單元測試（P0-4）。
 * 直接載入 src/lib/http-body-policy.ts（零依賴）驗證 Content-Type／
 * Content-Length／chunked 的判斷。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
const swc = requireHost("next/dist/build/swc");

const source = fs.readFileSync(
  path.join(ROOT, "src", "lib", "http-body-policy.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const mod = { exports: {} };
new Function("require", "module", "exports", code)(requireHost, mod, mod.exports);
const {
  DEFAULT_JSON_BODY_BYTES,
  DEFAULT_FORM_BODY_BYTES,
  maxBytesForContentType,
  parseContentLength,
  evaluateBodyLimit,
} = mod.exports;

const base = {
  method: "POST",
  contentType: "application/json",
  contentLength: null,
  transferEncoding: null,
};

// Content-Type → 上限
assert.equal(maxBytesForContentType("application/json"), DEFAULT_JSON_BODY_BYTES);
assert.equal(maxBytesForContentType("application/json; charset=utf-8"), DEFAULT_JSON_BODY_BYTES);
assert.equal(maxBytesForContentType("application/merge-patch+json"), DEFAULT_JSON_BODY_BYTES);
assert.equal(maxBytesForContentType("multipart/form-data; boundary=x"), DEFAULT_FORM_BODY_BYTES);
assert.equal(maxBytesForContentType(null), DEFAULT_JSON_BODY_BYTES);

// Content-Length 解析
assert.equal(parseContentLength("123"), 123);
assert.equal(parseContentLength(" 0 "), 0);
assert.equal(parseContentLength("-1"), null);
assert.equal(parseContentLength("12.5"), null);
assert.equal(parseContentLength("abc"), null);
assert.equal(parseContentLength(null), null);
assert.equal(parseContentLength(""), null);

// 未超過上限
assert.deepEqual(
  evaluateBodyLimit({ ...base, contentLength: String(DEFAULT_JSON_BODY_BYTES) }),
  { ok: true, maxBytes: DEFAULT_JSON_BODY_BYTES }
);

// 超過上限
assert.equal(
  evaluateBodyLimit({ ...base, contentLength: String(DEFAULT_JSON_BODY_BYTES + 1) }).ok,
  false
);

// multipart 用較大的上限
assert.equal(
  evaluateBodyLimit({
    ...base,
    contentType: "multipart/form-data; boundary=x",
    contentLength: String(DEFAULT_JSON_BODY_BYTES + 1),
  }).ok,
  true
);
assert.equal(
  evaluateBodyLimit({
    ...base,
    contentType: "multipart/form-data; boundary=x",
    contentLength: String(DEFAULT_FORM_BODY_BYTES + 1),
  }).ok,
  false
);

// 格式錯誤的 Content-Length → fail-closed
assert.equal(evaluateBodyLimit({ ...base, contentLength: "oops" }).ok, false);

// chunked 且無 Content-Length → fail-closed
assert.equal(
  evaluateBodyLimit({ ...base, transferEncoding: "chunked" }).ok,
  false
);

// 無 body 的方法不受限制
assert.equal(
  evaluateBodyLimit({
    ...base,
    method: "GET",
    contentLength: String(DEFAULT_JSON_BODY_BYTES + 1),
  }).ok,
  true
);

process.stdout.write(
  "[http-body-policy] JSON／multipart 上限、Content-Length 與 chunked fail-closed 全部通過\n"
);
