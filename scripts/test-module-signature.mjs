/**
 * 模組套件簽章信任根測試（P0-6）。
 * 直接載入 src/lib/module-signature.ts，驗證：
 *   1. 釘選公鑰＋正確簽章 → 通過
 *   2. 未釘選公鑰 → 拒絕
 *   3. 未簽章＋預設模式 → 放行（v1 相容）
 *   4. 未簽章＋MODULE_MARKET_REQUIRE_SIGNATURE=1 → 拒絕
 *   5. 簽章內容被竄改 → 拒絕
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHost = createRequire(path.join(ROOT, "package.json"));
const swc = requireHost("next/dist/build/swc");

const source = fs.readFileSync(path.join(ROOT, "src", "lib", "module-signature.ts"), "utf-8");
const { code } = swc.transformSync(source, {
  jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (name) => {
    if (name === "server-only") return {};
    if (name === "@/lib/module-trust-keys.json") {
      return JSON.parse(
        fs.readFileSync(path.join(ROOT, "src", "lib", "module-trust-keys.json"), "utf-8")
      );
    }
    return requireHost(name);
  },
  mod,
  mod.exports
);
const { readTrustedModuleKeys, verifyModuleArchiveSignature } = mod.exports;

const officialKeys = readTrustedModuleKeys();
for (const moduleId of ["examRegistration", "selfDirectedLearning", "identityTaxInquiry"]) {
  assert.ok((officialKeys.get(moduleId) ?? []).length > 0, `${moduleId} 應有內建官方公鑰`);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const other = crypto.generateKeyPairSync("ed25519");
const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const otherPublicKeyBase64 = other.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const sha256 = crypto.createHash("sha256").update(crypto.randomBytes(1024)).digest("hex");
const signature = crypto.sign(null, Buffer.from(sha256, "hex"), privateKey).toString("base64");

process.env.MODULE_MARKET_TRUSTED_KEYS = JSON.stringify({ demoModule: [publicKeyBase64] });
delete process.env.MODULE_MARKET_REQUIRE_SIGNATURE;

assert.deepEqual(
  verifyModuleArchiveSignature({ moduleId: "demoModule", sha256, signature, publicKey: publicKeyBase64 }),
  { ok: true, signed: true },
  "釘選公鑰＋正確簽章應通過"
);

const untrusted = verifyModuleArchiveSignature({
  moduleId: "demoModule",
  sha256,
  signature,
  publicKey: otherPublicKeyBase64,
});
assert.equal(untrusted.ok, false);
assert.match(untrusted.reason, /不在釘選信任清單/);

assert.deepEqual(
  verifyModuleArchiveSignature({ moduleId: "demoModule", sha256 }),
  { ok: true, signed: false },
  "未簽章在預設模式應放行"
);

process.env.MODULE_MARKET_REQUIRE_SIGNATURE = "1";
const required = verifyModuleArchiveSignature({ moduleId: "demoModule", sha256 });
assert.equal(required.ok, false);
assert.match(required.reason, /要求套件簽章/);

delete process.env.MODULE_MARKET_REQUIRE_SIGNATURE;
const tampered = verifyModuleArchiveSignature({
  moduleId: "demoModule",
  sha256,
  signature: Buffer.from(crypto.randomBytes(64)).toString("base64"),
  publicKey: publicKeyBase64,
});
assert.equal(tampered.ok, false);
assert.match(tampered.reason, /簽章驗證失敗/);

process.stdout.write("[module-signature] 信任根、釘選公鑰、未簽章模式與竄改偵測全部通過\n");
