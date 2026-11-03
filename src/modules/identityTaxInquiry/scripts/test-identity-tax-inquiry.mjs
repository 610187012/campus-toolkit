import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = path.resolve(process.argv[2] || path.join(root, "..", "campus-toolkit"));
const hostRequire = createRequire(path.join(host, "package.json"));
const swc = hostRequire("next/dist/build/swc");

function loadTs(relativePath, imports = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const { code } = swc.transformSync(source, {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const module = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function("require", "module", "exports", code)(require, module, module.exports);
  return module.exports;
}

const types = loadTs(path.join("types", "identity-tax-inquiry.ts"));
const {
  DEFAULT_IDENTITY_TAX_INQUIRY_SETTINGS,
  PERSONAL_DATA_CONSENT_VERSION,
  maskIdNumber,
  parseRecordInput,
} = types;
const now = 1_800_000_000_000;
const settings = { ...DEFAULT_IDENTITY_TAX_INQUIRY_SETTINGS, openAt: now - 1000, closeAt: null };
const person = { idNumber: "A123456789" };

function input(overrides = {}) {
  return {
    identitySelections: [{ optionId: "low-income", values: {} }],
    taxSubject: "both",
    father: { ...person },
    mother: { ...person },
    self: { idNumber: "" },
    guardian: { idNumber: "" },
    personalDataConsent: true,
    personalDataConsentVersion: PERSONAL_DATA_CONSENT_VERSION,
    ...overrides,
  };
}

for (const taxSubject of ["both", "one", "self", "guardian"]) {
  test(`confirmation accepts ${taxSubject} without tax-subject names`, () => {
    const raw = input({
      taxSubject,
      father: taxSubject === "both" || taxSubject === "one" ? person : {},
      mother: taxSubject === "both" ? person : {},
      self: taxSubject === "self" ? person : {},
      guardian: taxSubject === "guardian" ? person : {},
    });
    const parsed = parseRecordInput(raw, settings, "confirm");
    assert.equal(parsed.ok, true);
    for (const key of ["father", "mother", "self", "guardian"]) {
      assert.deepEqual(Object.keys(parsed.value[key]), ["idNumber"]);
    }
  });

  test(`confirmation still requires ID numbers for ${taxSubject}`, () => {
    const parsed = parseRecordInput(
      input({ taxSubject, father: {}, mother: {}, self: {}, guardian: {} }),
      settings,
      "confirm"
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.message, /身分證字號/);
    assert.doesNotMatch(parsed.message, /姓名/);
  });
}

test("legacy names and client-supplied consent timestamps are discarded", () => {
  const parsed = parseRecordInput(
    input({ father: { ...person, name: "Legacy name" }, agreedAt: 123 }),
    settings,
    "confirm"
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.father, person);
  assert.equal(Object.hasOwn(parsed.value, "agreedAt"), false);
});

test("every confirmation requires explicit consent and the current notice version", () => {
  for (const consent of [undefined, false, "true", 1, {}]) {
    const parsed = parseRecordInput(input({ personalDataConsent: consent }), settings, "confirm");
    assert.equal(parsed.ok, false);
    assert.match(parsed.message, /個人資料授權/);
  }
  for (const version of [undefined, "", "old-version"]) {
    assert.equal(
      parseRecordInput(input({ personalDataConsentVersion: version }), settings, "confirm").ok,
      false
    );
  }
  const nonTax = input({
    identitySelections: [{ optionId: "indigenous", values: {} }],
    father: {},
    mother: {},
    personalDataConsent: false,
  });
  assert.equal(parseRecordInput(nonTax, settings, "confirm").ok, false);
  assert.equal(
    parseRecordInput({ ...nonTax, personalDataConsent: true }, settings, "confirm").ok,
    true
  );
});

test("drafts do not require consent, identities, names or complete ID numbers", () => {
  const parsed = parseRecordInput(
    { father: { name: "Discard this" }, personalDataConsent: true },
    settings,
    "draft"
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.father, { idNumber: "" });
  assert.equal(parsed.value.personalDataConsentVersion, null);
});

test("malformed ID numbers are still rejected for drafts and confirmations", () => {
  for (const mode of ["draft", "confirm"]) {
    assert.equal(
      parseRecordInput(input({ father: { idNumber: "bad" } }), settings, mode).ok,
      false
    );
  }
});

function storageFixture() {
  const docs = new Map();
  const writes = [];
  let reads = 0;
  const lib = loadTs(path.join("lib", "identity-tax-inquiry.ts"), {
    "server-only": {},
    "@/lib/firebase-admin": {
      getAdminDb: () => ({
        collection: () => ({
          doc: (id) => ({
            get: async () => {
              reads += 1;
              return { id, exists: docs.has(id), data: () => docs.get(id) };
            },
            set: async (value, options) => {
              writes.push({ id, value, options });
              assert.equal(options, undefined, "replace the record to remove legacy nested names");
              docs.set(id, JSON.parse(JSON.stringify(value)));
            },
          }),
        }),
      }),
    },
    "@/lib/settings-server": {},
    "@/lib/roster": {},
    "@/lib/read-cache": { invalidateReadCache: () => {} },
    "@/types/roster": {},
    "../types/identity-tax-inquiry": types,
  });
  const parsed = parseRecordInput(input(), settings, "confirm");
  assert.equal(parsed.ok, true);
  const saveInput = {
    period: "115-1",
    student: { uid: "fixture-student", name: "Test student", grade: "1", classCode: "101", className: "101" },
    value: parsed.value,
    confirm: true,
    settings,
    now,
  };
  return { lib, docs, writes, saveInput, reads: () => reads };
}

test("stored consent uses server time, is refreshed on resubmit and is cleared by a draft", async () => {
  const { lib, docs, writes, saveInput } = storageFixture();
  const first = await lib.saveStudentRecord(saveInput);
  assert.equal(first.ok, true);
  assert.deepEqual(first.record.personalDataConsent, {
    version: PERSONAL_DATA_CONSENT_VERSION,
    agreedAt: now,
  });

  const old = docs.get(first.record.id);
  old.father.name = "Legacy father";
  old.mother.name = "Legacy mother";
  const second = await lib.saveStudentRecord({ ...saveInput, now: now + 1000 });
  assert.equal(second.ok, true);
  assert.equal(second.record.personalDataConsent.agreedAt, now + 1000);
  assert.equal(second.record.confirmedAt, now + 1000);
  assert.deepEqual(docs.get(first.record.id).father, person);
  assert.equal(JSON.stringify(docs.get(first.record.id)).includes("Legacy"), false);

  const draft = await lib.saveStudentRecord({
    ...saveInput,
    confirm: false,
    value: { ...saveInput.value, personalDataConsentVersion: null },
    now: now + 2000,
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.record.status, "draft");
  assert.equal(draft.record.personalDataConsent, null);
  assert.equal(writes.length, 3);
});

test("storage rejects confirmations without new consent before reading or writing", async () => {
  const fixture = storageFixture();
  const result = await fixture.lib.saveStudentRecord({
    ...fixture.saveInput,
    value: { ...fixture.saveInput.value, personalDataConsentVersion: null },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(fixture.reads(), 0);
  assert.equal(fixture.writes.length, 0);
});

test("legacy reads omit tax names and do not invent consent", async () => {
  const { lib, docs, saveInput } = storageFixture();
  const id = lib.recordDocId(saveInput.period, saveInput.student.uid);
  docs.set(id, {
    ...saveInput.value,
    father: { ...person, name: "Legacy father" },
    self: { ...person, name: "Legacy self" },
  });
  const record = await lib.getRecord(saveInput.period, saveInput.student.uid);
  assert.deepEqual(record.father, person);
  assert.deepEqual(record.self, person);
  assert.equal(record.personalDataConsent, null);
  const masked = lib.maskRecordForParent(record);
  assert.deepEqual(masked.father, { idNumber: maskIdNumber(person.idNumber) });
  assert.equal(JSON.stringify(masked).includes("Legacy"), false);
});

test("CSV has no tax-name columns and includes all four subject ID numbers", async () => {
  const { lib, saveInput } = storageFixture();
  const saved = await lib.saveStudentRecord({
    ...saveInput,
    value: { ...saveInput.value, taxSubject: "self", self: person, guardian: person },
  });
  const row = { ...saved.record, studentId: "fixture-id", seatNo: "1" };
  for (const includeIdNumbers of [true, false]) {
    const csv = lib.buildInquiryCsv([row], includeIdNumbers);
    const [header, data] = csv.split("\r\n").map((line) => line.split(","));
    assert.equal(header.length, data.length);
    assert.equal(header.includes("姓名"), true, "retain the student's roster name");
    for (const label of ["父姓名", "母姓名", "監護人姓名"]) {
      assert.equal(header.includes(label), false);
    }
    for (const label of ["父身分證", "母身分證", "本人身分證", "監護人身分證"]) {
      assert.equal(
        data[header.indexOf(label)],
        includeIdNumbers ? person.idNumber : maskIdNumber(person.idNumber)
      );
    }
  }
});
