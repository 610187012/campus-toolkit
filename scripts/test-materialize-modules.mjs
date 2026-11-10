/**
 * lock-only 模組 materializer 的單元測試（P1-10）。
 * 只測純函式與本機檔案操作，不連線網路。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseMarketSource,
  assertSafeEntryName,
  hashTree,
  findModuleRoot,
  verifyArchiveSignature,
  materializeEntry,
} from "../scripts/materialize-modules.mjs";

// 1) source 解析
const httpsUrl = parseMarketSource("market:https://example.com/modules/a.zip");
assert.equal(httpsUrl?.hostname, "example.com");
const localUrl = parseMarketSource("market:http://localhost:3000/a.zip");
assert.equal(localUrl?.hostname, "localhost");
assert.equal(parseMarketSource("market:http://evil.example.com/a.zip"), null);
assert.equal(parseMarketSource("link-copy:D:\\workspace\\CT\\examRegistration"), null);
assert.equal(parseMarketSource(""), null);

// 2) zip slip 名稱
assert.doesNotThrow(() => assertSafeEntryName("src/modules/a/module.json"));
assert.doesNotThrow(() => assertSafeEntryName("./a/b.txt"));
for (const bad of ["../evil", "/abs/path", "C:/Windows/x", "a//b", "", "..\\evil"]) {
  assert.throws(() => assertSafeEntryName(bad), `應拒絕：${bad}`);
}

// 3) 目錄雜湊：穩定、內容變更會變
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-test-"));
try {
  const treeRoot = path.join(temp, "tree");
  fs.mkdirSync(path.join(treeRoot, "sub"), { recursive: true });
  fs.writeFileSync(path.join(treeRoot, "module.json"), '{"value":"demo"}');
  fs.writeFileSync(path.join(treeRoot, "sub", "a.txt"), "hello");
  const first = hashTree(treeRoot);
  assert.equal(hashTree(treeRoot), first, "同一內容應得到相同雜湊");
  fs.writeFileSync(path.join(treeRoot, "sub", "a.txt"), "hello2");
  assert.notEqual(hashTree(treeRoot), first, "內容變更應改變雜湊");

  // 4) 找 module.json 根目錄
  assert.equal(findModuleRoot(treeRoot), treeRoot);
  const nested = path.join(temp, "nested");
  fs.mkdirSync(path.join(nested, "module-folder"), { recursive: true });
  fs.writeFileSync(path.join(nested, "module-folder", "module.json"), "{}");
  assert.equal(findModuleRoot(nested), path.join(nested, "module-folder"));
  const emptyDir = path.join(temp, "empty");
  fs.mkdirSync(emptyDir);
  assert.throws(() => findModuleRoot(emptyDir), /module\.json/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// 5) 非 market 來源直接略過，不應碰網路
assert.equal(
  await materializeEntry({ value: "demo", source: "link-copy:D:\\tmp\\demo" }),
  "skipped"
);

// 6) 簽章政策
const previousRequire = process.env.MODULE_MARKET_REQUIRE_SIGNATURE;
try {
  process.env.MODULE_MARKET_REQUIRE_SIGNATURE = "1";
  assert.throws(
    () =>
      verifyArchiveSignature({
        moduleId: "demo",
        sha256: "a".repeat(64),
        signature: "",
        publicKey: "",
      }),
    /要求簽章/
  );
} finally {
  if (previousRequire === undefined) delete process.env.MODULE_MARKET_REQUIRE_SIGNATURE;
  else process.env.MODULE_MARKET_REQUIRE_SIGNATURE = previousRequire;
}

assert.throws(
  () =>
    verifyArchiveSignature({
      moduleId: "demo",
      sha256: "a".repeat(64),
      signature: "abc",
      publicKey: Buffer.alloc(44).toString("base64"),
    }),
  /沒有釘選公鑰/
);

process.stdout.write(
  "[materialize-modules] source 解析、zip slip、目錄雜湊、manifest 根目錄與簽章政策全部通過\n"
);
