/**
 * TOTP 密鑰靜態加密測試（P0-5）。
 * 直接載入 src/lib/totp-secret-crypto.ts，驗證：
 *   1. 加密／解密往返
 *   2. 舊版明文相容
 *   3. 竄改密文偵測（AES-GCM）
 *   4. 不同金鑰無法解密
 *   5. TOTP_ENCRYPTION_KEY 覆寫
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
  path.join(ROOT, "src", "lib", "totp-secret-crypto.ts"),
  "utf-8"
);

function loadModule(env) {
  const previous = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    TOTP_ENCRYPTION_KEY: process.env.TOTP_ENCRYPTION_KEY,
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, env);

  const { code } = swc.transformSync(source, {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(
    requireHost,
    mod,
    mod.exports
  );

  // 在目前的環境變數下先派生並快取金鑰，之後 restore 環境也不影響
  mod.exports.encryptTotpSecret("warmup");

  for (const key of Object.keys(previous)) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  return mod.exports;
}

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const sessionA = "a".repeat(48);
const sessionB = "b".repeat(48);

// 1) 加密／解密往返
const cryptoA = loadModule({ SESSION_SECRET: sessionA });
const encrypted = cryptoA.encryptTotpSecret(SECRET);
assert.ok(encrypted.startsWith("enc:v1:"), "應使用 enc:v1 格式");
assert.ok(!encrypted.includes(SECRET), "密文不應包含明文");
assert.equal(cryptoA.decryptTotpSecret(encrypted), SECRET);
assert.equal(cryptoA.isEncryptedTotpSecret(encrypted), true);

// 空字串維持空字串
assert.equal(cryptoA.encryptTotpSecret(""), "");
assert.equal(cryptoA.decryptTotpSecret(""), "");
assert.equal(cryptoA.decryptTotpSecret(undefined), "");

// 2) 舊版明文相容
assert.equal(cryptoA.decryptTotpSecret(SECRET), SECRET);
assert.equal(cryptoA.isEncryptedTotpSecret(SECRET), false);

// 3) 竄改密文 → 解密失敗回空字串
const originalError = console.error;
console.error = () => {};
const encParts = encrypted.split(":");
const cipherPart = encParts[2];
encParts[2] =
  (cipherPart[0] === "A" ? "B" : "A") + cipherPart.slice(1);
const tampered = encParts.join(":");
assert.equal(cryptoA.decryptTotpSecret(tampered), "");
assert.equal(cryptoA.decryptTotpSecret("enc:v1:bad"), "");
console.error = originalError;

// 4) 不同 SESSION_SECRET 派生不同金鑰，無法解密
const cryptoB = loadModule({ SESSION_SECRET: sessionB });
console.error = () => {};
assert.equal(cryptoB.decryptTotpSecret(encrypted), "");
console.error = originalError;

// 5) TOTP_ENCRYPTION_KEY 覆寫（32 bytes base64）
const explicitKey = Buffer.alloc(32, 7).toString("base64");
const cryptoC = loadModule({ TOTP_ENCRYPTION_KEY: explicitKey });
const encryptedC = cryptoC.encryptTotpSecret(SECRET);
assert.equal(cryptoC.decryptTotpSecret(encryptedC), SECRET);
console.error = () => {};
assert.equal(cryptoA.decryptTotpSecret(encryptedC), "");
console.error = originalError;

// 6) 金鑰格式錯誤 → 明確錯誤
assert.throws(
  () => loadModule({ TOTP_ENCRYPTION_KEY: "not-a-key" }).encryptTotpSecret(SECRET),
  /TOTP_ENCRYPTION_KEY/
);

// 7) 沒有 SESSION_SECRET 也不能默默使用弱金鑰
assert.throws(
  () => loadModule({}).encryptTotpSecret(SECRET),
  /SESSION_SECRET/
);

process.stdout.write(
  "[totp-secret-crypto] 加解密、明文相容、竄改偵測、不同金鑰與顯式金鑰全部通過\n"
);
