/**
 * 跨實例 rate limit（Upstash REST）純邏輯測試（P0-3）。
 * 不連線真實 Upstash；用假 fetch 驗證請求格式、計數與失敗退回。
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
  path.join(ROOT, "src", "lib", "rate-limit-shared.ts"),
  "utf-8"
);
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const mod = { exports: {} };
new Function("require", "module", "exports", code)(requireHost, mod, mod.exports);
const {
  parseSharedRateLimitConfig,
  hashRateLimitKey,
  buildSharedRateLimitKey,
  parsePipelineCount,
  decideSharedRateLimit,
  checkSharedRateLimit,
} = mod.exports;

// 設定解析
assert.deepEqual(
  parseSharedRateLimitConfig(" https://redis.example.com/ ", " token "),
  { url: "https://redis.example.com", token: "token" }
);
assert.equal(parseSharedRateLimitConfig(undefined, "x"), null);
assert.equal(parseSharedRateLimitConfig("https://x", ""), null);

// key 雜湊：不含原始識別資料
const rawKey = "login:acct:1:teacher@school.edu.tw";
const hashed = hashRateLimitKey(rawKey);
assert.equal(hashed.length, 32);
assert.match(hashed, /^[a-f0-9]+$/);
assert.ok(!hashed.includes("school.edu.tw"));
assert.equal(hashRateLimitKey(rawKey), hashed, "同一 key 應穩定");
assert.notEqual(hashRateLimitKey("other"), hashed);

const windowMs = 60_000;
const now = 1_700_000_030_000; // 固定時間，避免跨視窗
const built = buildSharedRateLimitKey(now, windowMs, rawKey);
assert.ok(built.startsWith(`rl:${Math.floor(now / windowMs)}:`));
assert.ok(!built.includes("school.edu.tw"));

// pipeline 回應解析
assert.equal(parsePipelineCount([{ result: 1 }, { result: 1 }]), 1);
assert.equal(parsePipelineCount([{ result: "7" }]), 7);
assert.equal(parsePipelineCount([{ result: -1 }]), null);
assert.equal(parsePipelineCount([{ result: "x" }]), null);
assert.equal(parsePipelineCount({}), null);

// 結果判斷
assert.deepEqual(decideSharedRateLimit(2, 5, now, windowMs), {
  ok: true,
  remaining: 3,
  retryAfterSec: 0,
});
const denied = decideSharedRateLimit(6, 5, now, windowMs);
assert.equal(denied.ok, false);
assert.equal(denied.remaining, 0);
assert.ok(denied.retryAfterSec >= 1 && denied.retryAfterSec <= 60);

// 假 fetch：成功
const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, init });
  return {
    ok: true,
    json: async () => [{ result: 3 }, { result: 1 }],
  };
};
const config = { url: "https://redis.example.com", token: "secret-token" };
const okResult = await checkSharedRateLimit({
  key: rawKey,
  limit: 5,
  windowMs,
  config,
  now,
  fetchImpl: fakeFetch,
});
assert.deepEqual(okResult, { ok: true, remaining: 2, retryAfterSec: 0 });
assert.equal(calls.length, 1);
assert.equal(calls[0].url, "https://redis.example.com/pipeline");
assert.equal(calls[0].init.method, "POST");
assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
const sentBody = JSON.parse(calls[0].init.body);
assert.equal(sentBody[0][0], "INCR");
assert.equal(sentBody[1][0], "PEXPIRE");
assert.ok(!calls[0].init.body.includes("school.edu.tw"), "不可送出原始識別資料");

// 假 fetch：超限
const deniedResult = await checkSharedRateLimit({
  key: rawKey,
  limit: 5,
  windowMs,
  config,
  now,
  fetchImpl: async () => ({
    ok: true,
    json: async () => [{ result: 6 }],
  }),
});
assert.equal(deniedResult.ok, false);

// 假 fetch：HTTP 失敗、格式錯誤、網路錯誤 → 回 null（退回進程內）
for (const fetchImpl of [
  async () => ({ ok: false, json: async () => ({}) }),
  async () => ({ ok: true, json: async () => ({ nope: true }) }),
  async () => {
    throw new Error("network down");
  },
]) {
  assert.equal(
    await checkSharedRateLimit({
      key: rawKey,
      limit: 5,
      windowMs,
      config,
      now,
      fetchImpl,
    }),
    null
  );
}

process.stdout.write(
  "[rate-limit-shared] 設定解析、key 雜湊、固定視窗判斷與失敗退回全部通過\n"
);
