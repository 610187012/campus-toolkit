/**
 * 模組專屬密鑰測試（P1-9 第二階段基礎）。
 * 驗證：同一模組／用途穩定、不同模組／用途不同、根金鑰可覆寫、缺金鑰會 fail-closed。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
const swc = requireHost("next/dist/build/swc");
const source = fs.readFileSync(path.join(ROOT, "src", "lib", "module-secret.ts"), "utf-8");
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});

function loadModule(env) {
  const previous = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    MODULE_SECRET_ROOT: process.env.MODULE_SECRET_ROOT,
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, env);

  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(
    (name) => (name === "server-only" ? {} : requireHost(name)),
    mod,
    mod.exports
  );
  // 先派生一次，讓快取金鑰對應目前的環境
  mod.exports.moduleSecret("demoModule", "warmup");

  for (const key of Object.keys(previous)) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  return mod.exports;
}

const sessionA = "a".repeat(48);
const sessionB = "b".repeat(48);

const a = loadModule({ SESSION_SECRET: sessionA });
const s1 = a.moduleSecret("demoModule", "canva");
const s2 = a.moduleSecret("demoModule", "canva");
assert.equal(s1, s2, "同一模組／用途應穩定");
assert.match(s1, /^[A-Za-z0-9_-]{43}$/, "應為 32 bytes base64url");

assert.notEqual(s1, a.moduleSecret("demoModule", "webhook"), "不同用途應不同");
assert.notEqual(s1, a.moduleSecret("otherModule", "canva"), "不同模組應不同");
assert.equal(a.moduleSecret("demoModule"), a.moduleSecret("demoModule", "default"));
assert.notEqual(s1, a.moduleSecret("demoModule"), "預設用途與具名用途應不同");

const b = loadModule({ SESSION_SECRET: sessionB });
assert.notEqual(s1, b.moduleSecret("demoModule", "canva"), "不同根金鑰應不同");

// 明確根金鑰
const root = Buffer.alloc(32, 7).toString("base64");
const c = loadModule({ MODULE_SECRET_ROOT: root });
const c1 = c.moduleSecret("demoModule", "canva");
assert.equal(c1, c.moduleSecret("demoModule", "canva"));

// 錯誤／缺少金鑰 fail-closed
assert.throws(() => loadModule({}).moduleSecret("demoModule"), /SESSION_SECRET/);
assert.throws(
  () => loadModule({ MODULE_SECRET_ROOT: "not-a-key" }).moduleSecret("demoModule"),
  /MODULE_SECRET_ROOT/
);
assert.throws(() => a.moduleSecret("Bad-Value"), /模組代碼格式錯誤/);

process.stdout.write(
  "[module-secret] 模組×用途派生、根金鑰覆寫與 fail-closed 全部通過\n"
);
