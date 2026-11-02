import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = path.resolve(process.argv[2] || path.join(root, "..", "campus-toolkit"));
const requireHost = createRequire(path.join(host, "package.json"));
const swc = requireHost("next/dist/build/swc");

function loadTs(relativePath, imports = {}) {
  const { code } = swc.transformSync(fs.readFileSync(path.join(root, relativePath), "utf8"), {
    jsc: {
      parser: { syntax: "typescript", tsx: relativePath.endsWith(".tsx") },
      target: "es2022",
      transform: { react: { runtime: "automatic" } },
    },
    module: { type: "commonjs" },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}

const types = loadTs(path.join("types", "self-directed-learning.ts"));
const exporter = loadTs(path.join("lib", "document-export.ts"), {
  "../types/self-directed-learning": types,
});
const authorization = loadTs(path.join("lib", "google-docs-authorization.ts"), {
  "./document-export": exporter,
});
const exportInput = loadTs(path.join("lib", "document-export-input.ts"), { "./document-export": exporter });
const wordClient = loadTs(path.join("lib", "word-client.ts"), { "./document-export": exporter });
const docx = loadTs(path.join("lib", "document-docx.ts"), {
  "../types/self-directed-learning": types,
});
const jose = await import(pathToFileURL(requireHost.resolve("jose")).href);
const canva = loadTs(path.join("lib", "canva-export.ts"), {
  "server-only": {}, jose, "./document-export": exporter, "./document-export-input": exportInput,
});
const nextServer = requireHost("next/server");
let authenticated = true;
let blocked = false;
let exportSettings = types.normalizeSettings({ documentExports: { googleDocs: true, canva: true, word: false } });
const settingsImport = { getSettings: async () => exportSettings };
const routeImports = {
  "next/server": nextServer,
  "@/lib/csrf": { assertSameOrigin: (request) => request.headers.get("origin") === "http://localhost:3000" ? null : nextServer.NextResponse.json({ success: false }, { status: 403 }) },
  "@/lib/dal": {
    requireRole: async () => authenticated ? { session: { uid: "synthetic-student" }, denial: null } : { session: null, denial: { status: 401, message: "未登入" } },
    toAuthResponse: (denial) => nextServer.NextResponse.json(denial, { status: denial.status }),
  },
  "@/lib/module-gate": { requireFeatureModuleEnabled: async () => blocked ? nextServer.NextResponse.json({}, { status: 403 }) : null },
  "@/lib/rate-limit": { enforceRateLimit: () => null, RATE: {
    SELF_DIRECTED_LEARNING_CANVA: { limit: 90, windowMs: 60000 },
    SELF_DIRECTED_LEARNING_LIST: { limit: 120, windowMs: 60000 },
    SELF_DIRECTED_LEARNING_STUDENT: { limit: 20, windowMs: 60000 },
  } },
  "../../../../lib/self-directed-learning": settingsImport,
  "../../../../../lib/self-directed-learning": settingsImport,
  "../../../../types/self-directed-learning": types,
  "../../../../lib/document-export": exporter,
  "../../../../lib/document-docx": docx,
  "../../../../lib/document-export-input": exportInput,
  "../../../../lib/canva-export": canva,
  "../../../../../lib/canva-export": canva,
};
const canvaRoute = loadTs(path.join("api", "student", "self-directed-learning", "canva", "route.ts"), routeImports);
const canvaCallback = loadTs(path.join("api", "student", "self-directed-learning", "canva", "callback", "route.ts"), routeImports);
const canvaClient = loadTs(path.join("lib", "canva-client.ts"));
const exportsRoute = loadTs(path.join("api", "student", "self-directed-learning", "exports", "route.ts"), routeImports);
const react = requireHost("react");
const { renderToStaticMarkup } = requireHost("react-dom/server");
const controls = loadTs(path.join("components", "document-export-controls.tsx"), {
  react,
  "react/jsx-runtime": requireHost("react/jsx-runtime"),
  "next/script": () => null,
  "../lib/google-docs-authorization": authorization,
  "../lib/document-export": exporter,
  "../lib/canva-client": canvaClient,
  "../lib/word-client": wordClient,
  "../types/self-directed-learning": types,
}).default;

test("export services default closed for new and legacy settings and preserve independent choices", () => {
  const closed = { googleDocs: false, canva: false, word: false };
  assert.deepEqual(types.DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.documentExports, closed);
  assert.deepEqual(types.normalizeSettings({ enabled: true }).documentExports, closed);
  for (const platform of Object.keys(closed)) {
    const expected = { ...closed, [platform]: true };
    const input = { ...types.DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS, documentExports: expected };
    assert.deepEqual(types.normalizeSettings(input).documentExports, expected);
    const parsed = types.parseSettingsInput(input);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value.documentExports, expected);
  }
  for (const value of [null, [], true, {}, { googleDocs: "true", canva: false, word: false }]) {
    assert.equal(types.parseSettingsInput({ ...types.DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS, documentExports: value }).ok, false);
  }
});

test("student controls hide closed services and allow Word-only downloads", () => {
  const render = (services) => renderToStaticMarkup(react.createElement(controls, { services, getPayload: () => ({}), onToast: () => {} }));
  assert.equal(render({ googleDocs: false, canva: false, word: false }), "");
  const wordOnly = render({ googleDocs: false, canva: false, word: true });
  assert.match(wordOnly, /value="word" selected/);
  assert.doesNotMatch(wordOnly, /Google Docs|Canva|disabled/);
  const google = render({ googleDocs: true, canva: false, word: false });
  assert.match(google, /Google Docs/);
  assert.doesNotMatch(google, /Canva|Word/);
  const canvaOnly = render({ googleDocs: false, canva: true, word: true });
  assert.doesNotMatch(canvaOnly, /Google Docs/);
  assert.match(canvaOnly, /value="canva" selected/);
  assert.match(canvaOnly, /value="word">Word（.docx）/);
});

test("admin and delegated management render three distinct initially closed service switches", () => {
  const adminPage = loadTs(path.join("admin", "self-directed-learning", "page.tsx"), {
    react,
    "react/jsx-runtime": requireHost("react/jsx-runtime"),
    "@/components/Toast": () => null,
    "@/components/DisclosureArrow": () => null,
    "../../components/rich-text-editor": { RichTextEditor: () => null },
    "../../types/self-directed-learning": types,
  }).default;
  for (const delegated of [false, true]) {
    const markup = renderToStaticMarkup(react.createElement(adminPage, { delegated }));
    assert.match(markup, /文件下載／匯出服務/);
    assert.doesNotMatch(markup, /上線驗收與資料注意事項/);
    for (const label of Object.values(types.DOCUMENT_EXPORT_LABELS)) {
      const input = markup.match(new RegExp(`<input[^>]*aria-label="提供 ${label} 匯出"[^>]*>`))?.[0];
      assert.ok(input, `${label} has its own switch`);
      assert.doesNotMatch(input, /checked/);
    }
    assert.doesNotMatch(markup, /尚未完成；開啟後仍不提供下載/);
  }
});

test("admin API persists independent switches, invalidates settings cache and enforces configure permission", async () => {
  let stored = globalThis.structuredClone(types.DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS);
  let reads = 0;
  let writes = 0;
  let cached;
  let allowed = true;
  const audits = [];
  const settingsServer = loadTs(path.join("lib", "self-directed-learning.ts"), {
    "server-only": {},
    "@/lib/firebase-admin": { getAdminDb: () => ({ collection: () => ({ doc: () => ({
      get: async () => { reads++; return { exists: true, data: () => globalThis.structuredClone(stored) }; },
      set: async (value) => { writes++; stored = globalThis.structuredClone(value); },
    }) }) }) },
    "@/lib/calendar": {},
    "@/lib/read-cache": {
      cachedRead: async (_key, _ttl, read) => {
        if (!cached) cached = await read();
        return cached;
      },
      invalidateReadCache: () => { cached = undefined; },
    },
    "@/lib/settings-server": { getCacheTtlSeconds: async () => 60 },
    "@/lib/roster": {},
    "../types/self-directed-learning": types,
  });
  const admin = loadTs(path.join("api", "admin", "self-directed-learning", "route.ts"), {
    ...routeImports,
    "@/lib/rate-limit": { enforceRateLimit: () => null, RATE: { SELF_DIRECTED_LEARNING_ADMIN: { limit: 60, windowMs: 60000 } } },
    "@/lib/dal": {
      requireModulePermission: async (module, permission) => {
        assert.equal(module, "selfDirectedLearning");
        assert.equal(permission, "configure");
        return allowed ? { context: { session: { uid: "synthetic-manager", role: "staff", account: "manager" } }, denial: null }
          : { context: null, denial: { status: 403 } };
      },
      toAuthResponse: (denial) => nextServer.NextResponse.json({}, { status: denial.status }),
    },
    "@/lib/audit": { getClientIp: () => "127.0.0.1", logActivity: async (value) => { audits.push(value); } },
    "@/lib/announcements": {},
    "@/lib/calendar": {},
    "@/lib/settings-server": {},
    "@/types/announcements": {},
    "../../../lib/self-directed-learning": { ...settingsServer, getAvailableWeeks: async () => null },
    "../../../types/self-directed-learning": types,
  });
  const request = (services) => new nextServer.NextRequest("http://localhost:3000/api/admin/self-directed-learning", {
    method: "POST", headers: { origin: "http://localhost:3000", "Content-Type": "application/json" },
    body: JSON.stringify({ ...types.DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS, documentExports: services }),
  });
  await settingsServer.getSettings();
  await settingsServer.getSettings();
  assert.equal(reads, 1, "repeated settings reads use the existing cache");
  for (let mask = 0; mask < 8; mask++) {
    const services = { googleDocs: Boolean(mask & 1), canva: Boolean(mask & 2), word: Boolean(mask & 4) };
    const response = await admin.POST(request(services));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).settings.documentExports, services);
    assert.deepEqual(stored.documentExports, services);
    assert.deepEqual((await settingsServer.getSettings()).documentExports, services, "saved switches survive reload and invalidate old cache");
  }
  assert.equal(writes, 8);
  assert.equal(audits.length, 8);
  assert.match(audits[0].details, /Google Docs：關、Canva：關、Word：關/);
  allowed = false;
  assert.equal((await admin.POST(request({ googleDocs: false, canva: false, word: false }))).status, 403);
  assert.equal(writes, 8, "unauthorized callers cannot change switches");
});

test("export preflight enforces role, module, service and maintenance without invoking external APIs", async () => {
  const original = exportSettings;
  const request = (platform) => new nextServer.NextRequest(`http://localhost:3000/api/student/self-directed-learning/exports?platform=${platform}`);
  try {
    authenticated = false;
    assert.equal((await exportsRoute.GET(request("googleDocs"))).status, 401);
    authenticated = true;
    blocked = true;
    assert.equal((await exportsRoute.GET(request("googleDocs"))).status, 403);
    blocked = false;
    exportSettings = types.normalizeSettings({});
    for (const platform of ["googleDocs", "canva", "word"]) {
      assert.equal((await exportsRoute.GET(request(platform))).status, 403);
    }
    exportSettings = original;
    assert.equal((await exportsRoute.GET(request("googleDocs"))).status, 200);
    assert.equal((await exportsRoute.GET(request("canva"))).status, 200);
    assert.equal((await exportsRoute.GET(request("unknown"))).status, 400);
    exportSettings = { ...original, documentExports: { ...original.documentExports, word: true } };
    assert.equal((await exportsRoute.GET(request("word"))).status, 200);
    exportSettings = { ...original, enabled: false };
    assert.equal((await exportsRoute.GET(request("googleDocs"))).status, 403);
  } finally {
    authenticated = true;
    blocked = false;
    exportSettings = original;
  }
});

test("Canva closed switch blocks config, OAuth, import, jobs and callback even with old cookies", async () => {
  const original = exportSettings;
  try {
    exportSettings = types.normalizeSettings({});
    for (const op of ["config", "connection", "job"]) {
      assert.equal((await canvaRoute.GET(apiRequest(`?op=${op}`))).status, 403);
    }
    for (const input of [{ op: "authorize", agreed: true }, { agreed: true, payload, style: "formal" }]) {
      assert.equal((await canvaRoute.POST(apiRequest("", input))).status, 403);
    }
    const callback = await canvaCallback.GET(apiRequest("/callback?state=old&code=old"));
    assert.equal(callback.status, 403);
    assert.match(await callback.text(), /學校尚未開放 Canva/);
    exportSettings = { ...original, enabled: false };
    assert.equal((await canvaRoute.GET(apiRequest("?op=config"))).status, 403);
  } finally {
    exportSettings = original;
  }
});

test("browser export preflight rejects denied and failed requests and does not cache success", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new globalThis.Response(JSON.stringify({ success: false, message: "學校尚未開放 Google Docs 匯出服務。" }), { status: 403 });
  });
  await assert.rejects(exporter.checkDocumentExportAllowed("googleDocs"), /學校尚未開放/);
  assert.equal(calls[0].url, "/api/student/self-directed-learning/exports?platform=googleDocs");
  assert.equal(calls[0].options.cache, "no-store");
});

const payload = {
  period: "115-1", studentName: "測試學生", className: "101",
  topic: '學習 <script>bad()</script> & "主題"', studyGroup: "資訊", advisor: "",
  learningGoals: '<p><b>學習目標</b></p><script>dropMe()</script><img src=x onerror=bad()>',
  reflection: "<p>反思心得</p>", source: "approved", layout: "separate", generatedAt: 123,
  weeks: [
    { week: 1, timing: "flexible", content: "<p>第一週安排</p>", venue: "<測試場地>", slots: [], blocked: false, record: "<p>第一週成果</p>" },
    { week: 2, timing: "afterSchool", content: "第二週安排\n第二行", venue: "", slots: [], blocked: false, record: "" },
  ],
};

test("export includes plan, formatted goals, weeks, outcomes and reflection without executable HTML", () => {
  const html = exporter.buildDocumentHtml(payload);
  for (const text of ["測試學生", "101", "<b>學習目標</b>", "第一週安排", "第一週成果", "反思心得", "課餘", "不會同步或覆蓋校內計畫"]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes("&lt;script&gt;bad()&lt;/script&gt;"));
  assert.ok(html.includes("&lt;測試場地&gt;"));
  assert.ok(html.includes("第二週安排<br>第二行"));
  assert.doesNotMatch(html, /<script>|<img|onerror|dropMe/);
});

test("formal document styling uses inline headings, pale table headers and readable spacing", () => {
  const html = exporter.buildDocumentHtml(payload);
  assert.match(html, /<h1 style="[^"]*color:#17365d[^"]*font-size:24pt/);
  assert.match(html, /<h2 style="[^"]*">逐週學習安排<\/h2>/);
  assert.match(html, /<th scope="col" style="[^"]*background-color:#eaf0f7/);
  assert.match(html, /<td style="[^"]*padding:9pt[^"]*vertical-align:top/);
  assert.match(html, /line-height:1.65/);
  assert.doesNotMatch(html, /<link|@import|<img|<script/);
});

test("separate and integrated outcome layouts each include each outcome exactly once", () => {
  for (const style of Object.keys(exporter.DOCUMENT_STYLES)) {
    for (const layout of ["separate", "integrated"]) {
      const html = exporter.buildDocumentHtml({ ...payload, layout }, style);
      assert.equal(html.split("第一週成果").length - 1, 1);
      const tableEnd = html.indexOf("</table>");
      assert.equal(html.indexOf("第一週成果") < tableEnd, layout === "integrated");
      for (const text of ["測試學生", "第一週安排", "反思心得", "&lt;測試場地&gt;"]) {
        assert.ok(html.includes(text), `${style}: ${text}`);
      }
      assert.doesNotMatch(html, /<script>|<img|onerror|dropMe/);
    }
  }
});

test("basic style is undecorated and all four document styles are distinct", () => {
  const styles = Object.keys(exporter.DOCUMENT_STYLES);
  assert.deepEqual(styles, ["basic", "formal", "monochrome", "portfolio"]);
  const basic = exporter.buildDocumentHtml(payload, "basic");
  assert.doesNotMatch(basic, /background-color|border-bottom|border-top/);
  assert.match(basic, /<table\b/);
  assert.match(basic, /<h1\b/);
  assert.equal(new Set(styles.map((style) => exporter.buildDocumentHtml(payload, style))).size, 4);
  const monochrome = exporter.buildDocumentHtml(payload, "monochrome");
  for (const [, color] of monochrome.matchAll(/#([a-f0-9]{6})/g)) {
    assert.equal(color.slice(0, 2), color.slice(2, 4));
    assert.equal(color.slice(2, 4), color.slice(4, 6));
  }
  assert.match(exporter.buildDocumentHtml(payload, "portfolio"), /font-size:28pt/);
});

test("each selected style reaches the uploaded HTML without changing metadata", async (t) => {
  for (const style of Object.keys(exporter.DOCUMENT_STYLES)) {
    let uploaded;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      uploaded = await options.body.text();
      return new globalThis.Response(JSON.stringify({ id: "styled_document" }));
    });
    await exporter.createGoogleDocument(payload, "synthetic-token", style);
    assert.ok(uploaded.includes(exporter.buildDocumentHtml(payload, style)));
    assert.ok(uploaded.includes(`"name":${JSON.stringify(exporter.documentTitle(payload))}`));
    t.mock.restoreAll();
  }
});

test("draft and student-promoted copies cannot be mislabelled as school-approved", () => {
  assert.ok(exporter.buildDocumentHtml({ ...payload, source: "draft" }).includes("草稿副本"));
  const promoted = exporter.buildDocumentHtml({ ...payload, formalByStudent: true });
  assert.ok(promoted.includes("學生自行提升之正式計畫副本"));
  assert.ok(!promoted.includes("學校審核通過之計畫副本"));
});

test("multipart import converts HTML into a private native Google Doc without permission changes", async () => {
  const body = exporter.buildGoogleDocsUpload(payload, "test-boundary");
  assert.equal(body.type, "multipart/related; boundary=test-boundary");
  const text = await body.text();
  const metadata = JSON.parse(text.split("\r\n\r\n")[1].split("\r\n--")[0]);
  assert.equal(metadata.mimeType, "application/vnd.google-apps.document");
  assert.equal(metadata.name, exporter.documentTitle(payload));
  assert.deepEqual(Object.keys(metadata).sort(), ["mimeType", "name"]);
  assert.ok(text.includes("Content-Type: text/html; charset=UTF-8"));
  assert.ok(text.endsWith("--test-boundary--\r\n"));
});

test("successful upload uses only Drive upload, ephemeral bearer token and a safe document link", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    captured = { url, options };
    return new globalThis.Response(JSON.stringify({ id: "document_123-abc" }), { status: 200 });
  });
  assert.equal(
    await exporter.createGoogleDocument(payload, "synthetic-token"),
    "https://docs.google.com/document/d/document_123-abc/edit"
  );
  assert.equal(captured.url, exporter.GOOGLE_DOCS_UPLOAD_URL);
  assert.equal(captured.options.headers.Authorization, "Bearer synthetic-token");
  assert.equal(captured.options.credentials, "omit");
  assert.equal(captured.options.referrerPolicy, "no-referrer");
  const text = await captured.options.body.text();
  assert.ok(!text.includes("synthetic-token"));
  assert.ok(!text.includes("permissions"));
});

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} is surfaced without automatic retries`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new globalThis.Response("{}", { status });
    });
    await assert.rejects(exporter.createGoogleDocument(payload, "synthetic-token"));
    assert.equal(calls, 1);
  });
}

for (const [reason, expected] of [
  ["accessNotConfigured", /尚未啟用 Google Drive API/],
  ["SERVICE_DISABLED", /尚未啟用 Google Drive API/],
  ["storageQuotaExceeded", /空間不足/],
  ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", /權限不足/],
  ["domainPolicy", /學校限制/],
  ["userRateLimitExceeded", /使用量已達限制/],
  ["unrecognisedReason", /請洽學校管理員/],
]) {
  test(`HTTP 403 shows a brief actionable message: ${reason}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new globalThis.Response(JSON.stringify({
      error: { message: "原始測試錯誤", errors: [{ reason }], details: [{ reason }] },
    }), { status: 403 }));
    await assert.rejects(exporter.createGoogleDocument(payload, "synthetic-token"), (error) => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(reason));
      assert.ok(!error.message.includes("原始測試錯誤"));
      assert.ok(error.message.length <= 60);
      return true;
    });
  });
}

test("non-JSON Google rejection shows a brief explicit error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new globalThis.Response("<html>Forbidden</html>", { status: 403 }));
  await assert.rejects(exporter.createGoogleDocument(payload, "synthetic-token"), /Google 拒絕建立文件，請洽學校管理員確認設定。/);
});

test("malformed success responses warn of possible creation rather than claiming success", async (t) => {
  for (const value of [{}, { id: "../bad" }, { id: "https://example.com" }]) {
    t.mock.method(globalThis, "fetch", async () => new globalThis.Response(JSON.stringify(value)));
    await assert.rejects(exporter.createGoogleDocument(payload, "token"), /可能已建立/);
    t.mock.restoreAll();
  }
});

test("network failure and timeout explicitly warn to check Drive before retrying", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("network"); });
  await assert.rejects(exporter.createGoogleDocument(payload, "token"), /先查看自己的雲端硬碟/);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  await assert.rejects(exporter.createGoogleDocument(payload, "token"), /逾時.*先檢查/);
});

function mockOAuth(t, outcome) {
  let config;
  let request;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    google: { accounts: { oauth2: {
      initTokenClient(value) {
        config = value;
        return { requestAccessToken(value) {
          request = value;
          if (outcome.type) config.error_callback(outcome);
          else config.callback(outcome);
        } };
      },
      hasGrantedAllScopes: () => outcome.granted !== false,
    } } },
  } });
  return { config: () => config, request: () => request };
}

test("authorization requests only drive.file, account selection and no inherited grants", async (t) => {
  const fixture = mockOAuth(t, { access_token: "synthetic-token" });
  assert.equal(await authorization.authorizeGoogleDocs("test-client"), "synthetic-token");
  assert.equal(fixture.config().scope, exporter.GOOGLE_DRIVE_FILE_SCOPE);
  assert.equal(fixture.config().include_granted_scopes, false);
  assert.equal(fixture.request().prompt, "select_account");
});

for (const outcome of [
  { error: "access_denied" },
  { access_token: "token", granted: false },
  { type: "popup_closed" },
  { type: "popup_failed_to_open" },
]) {
  test(`authorization failure is explicit: ${JSON.stringify(outcome)}`, async (t) => {
    mockOAuth(t, outcome);
    await assert.rejects(authorization.authorizeGoogleDocs("test-client"));
  });
}

function canvaEnv(t) {
  const values = {
    CANVA_CLIENT_ID: "synthetic-canva-client", CANVA_CLIENT_SECRET: "synthetic-secret",
    CANVA_REDIRECT_URI: "http://localhost:3000/api/student/self-directed-learning/canva/callback",
    SESSION_SECRET: "synthetic-session-secret-at-least-32-characters",
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
}

test("Canva PKCE uses fresh state, SHA-256, minimal scope and exact configured callback", async (t) => {
  canvaEnv(t);
  const first = await canva.canvaAuthorization();
  const second = await canva.canvaAuthorization();
  const url = new globalThis.URL(first.url);
  assert.equal(url.origin, "https://www.canva.com");
  assert.equal(url.searchParams.get("scope"), "design:content:write");
  assert.equal(url.searchParams.get("redirect_uri"), process.env.CANVA_REDIRECT_URI);
  assert.equal(url.searchParams.get("code_challenge_method"), "s256");
  assert.notEqual(first.state, second.state);
  const digest = Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", new globalThis.TextEncoder().encode(first.verifier))).toString("base64url");
  assert.equal(url.searchParams.get("code_challenge"), digest);
  assert.ok(!url.toString().includes("synthetic-secret"));
});

test("Canva encrypted cookies enforce user, purpose, expiry and tamper checks", async (t) => {
  canvaEnv(t);
  const token = await canva.sealCanva({ uid: "student-a", accessToken: "synthetic-access-token" }, "token");
  assert.ok(!token.includes("synthetic-access-token"));
  assert.equal((await canva.unsealCanva(token, "token", "student-a")).accessToken, "synthetic-access-token");
  await assert.rejects(canva.unsealCanva(token, "token", "student-b"));
  await assert.rejects(canva.unsealCanva(token, "state", "student-a"));
  await assert.rejects(canva.unsealCanva(`${token.slice(0, -4)}xxxx`, "token", "student-a"));
  const expired = await canva.sealCanva({ uid: "student-a" }, "token", -1);
  await assert.rejects(canva.unsealCanva(expired, "token", "student-a"));
  assert.equal(canva.canvaCookieOptions().httpOnly, true);
  assert.equal(canva.canvaCookieOptions().sameSite, "lax");
});

test("Canva validates consent, style, week and field limits without trusting arbitrary metadata", () => {
  const input = { agreed: true, style: "formal", payload };
  assert.equal(canva.parseCanvaExport(input).payload.topic, payload.topic);
  for (const invalid of [
    { ...input, agreed: false }, { ...input, style: "__proto__" },
    { ...input, payload: { ...payload, weeks: [{ ...payload.weeks[0], week: -1 }] } },
    { ...input, payload: { ...payload, learningGoals: "a".repeat(100001) } },
  ]) assert.throws(() => canva.parseCanvaExport(invalid));
});

function unzipStored(buffer) {
  const files = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameSize = buffer.readUInt16LE(offset + 26);
    const extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString();
    const start = offset + 30 + nameSize + extra;
    const bytes = buffer.subarray(start, start + size);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, buffer.readUInt32LE(offset + 14));
    files[name] = bytes.toString();
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return files;
}

test("Word and Canva DOCX package contains editable, safe text and tables in every style/layout", () => {
  for (const style of Object.keys(exporter.DOCUMENT_STYLES)) {
    for (const layout of ["integrated", "separate"]) {
      const files = unzipStored(docx.buildDocumentDocx({ ...payload, layout }, style));
      assert.equal(Object.keys(files).length, 5);
      const content = files["word/document.xml"];
      for (const text of ["測試學生", "第一週安排", "反思心得", "第一週成果", "&lt;測試場地&gt;"]) assert.ok(content.includes(text));
      assert.match(content, /<w:tbl>/);
      assert.match(content, /<w:b\/>/);
      assert.doesNotMatch(content, /<script>|dropMe|onerror/);
      assert.equal(content.split("第一週成果").length - 1, 1);
      assert.equal(content.indexOf("第一週成果") < content.indexOf("</w:tbl>"), layout === "integrated");
    }
  }
});

test("Word endpoint produces genuine downloadable DOCX for all styles/layouts without external calls", async (t) => {
  const original = exportSettings;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Word must not contact external platforms"); });
  try {
    exportSettings = types.normalizeSettings({ documentExports: { word: true } });
    for (const style of Object.keys(exporter.DOCUMENT_STYLES)) {
      for (const layout of ["integrated", "separate"]) {
        const response = await exportsRoute.POST(new nextServer.NextRequest("http://localhost:3000/api/student/self-directed-learning/exports", {
          method: "POST", headers: { origin: "http://localhost:3000" },
          body: JSON.stringify({ payload: { ...payload, layout, topic: '未儲存 / 計畫 "\r\n😀' }, style }),
        }));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        const disposition = response.headers.get("content-disposition");
        assert.match(disposition, /^attachment; filename="self-directed-learning.docx"; filename\*=UTF-8''/);
        assert.match(decodeURIComponent(disposition.split("UTF-8''")[1]), /未儲存 _ 計畫/);
        assert.doesNotMatch(disposition, /[\r\n]/);
        const bytes = Buffer.from(await response.arrayBuffer());
        const zip = new (requireHost("adm-zip"))(bytes);
        assert.ok(zip.test(), "independent ZIP reader verifies the DOCX package");
        const files = unzipStored(bytes);
        assert.match(files["word/document.xml"], /未儲存 _|未儲存 \//);
        assert.match(files["word/document.xml"], /第一週成果/);
        assert.equal(files["word/document.xml"].indexOf("第一週成果") < files["word/document.xml"].indexOf("</w:tbl>"), layout === "integrated");
      }
    }
  } finally { exportSettings = original; }
});

test("Word endpoint rejects unauthorized, disabled, malformed and oversized requests", async () => {
  const original = exportSettings;
  const request = (body, origin = "http://localhost:3000") => new nextServer.NextRequest("http://localhost:3000/api/student/self-directed-learning/exports", {
    method: "POST", headers: { origin }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const input = { payload, style: "formal" };
  try {
    exportSettings = types.normalizeSettings({ documentExports: { word: true } });
    assert.equal((await exportsRoute.POST(request(input, "https://evil.example"))).status, 403);
    authenticated = false;
    assert.equal((await exportsRoute.POST(request(input))).status, 401);
    authenticated = true;
    blocked = true;
    assert.equal((await exportsRoute.POST(request(input))).status, 403);
    blocked = false;
    for (const body of ["not json", { ...input, style: "__proto__" }, { ...input, payload: {} }]) {
      assert.equal((await exportsRoute.POST(request(body))).status, 400);
    }
    assert.equal((await exportsRoute.POST(request("a".repeat(1_000_001)))).status, 413);
    exportSettings = types.normalizeSettings({});
    assert.equal((await exportsRoute.POST(request(input))).status, 403);
    exportSettings = types.normalizeSettings({ enabled: false, documentExports: { word: true } });
    assert.equal((await exportsRoute.POST(request(input))).status, 403);
  } finally {
    exportSettings = original;
    authenticated = true;
    blocked = false;
  }
});

test("Word browser helper downloads a blob with a safe filename and releases its URL", async (t) => {
  const clicks = [];
  let attached = false;
  let removed = false;
  let revoked = "";
  let cleanup;
  const anchor = { href: "", download: "", click: () => clicks.push(anchor.download), remove: () => { removed = true; } };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag) => { assert.equal(tag, "a"); return anchor; },
    body: { appendChild: () => { attached = true; } },
  } });
  t.mock.method(globalThis.URL, "createObjectURL", (blob) => { assert.ok(blob.size); return "blob:word-test"; });
  t.mock.method(globalThis.URL, "revokeObjectURL", (url) => { revoked = url; });
  t.mock.method(globalThis, "setTimeout", (callback) => { cleanup = callback; return 0; });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/student/self-directed-learning/exports");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.payload, payload);
    assert.equal(body.style, "basic");
    return new globalThis.Response(new Uint8Array(docx.buildDocumentDocx(payload, "basic")), {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    });
  });
  try {
    await wordClient.downloadWordDocument(payload, "basic");
    assert.equal(attached, true);
    assert.equal(removed, true);
    assert.deepEqual(clicks, [exporter.documentFilename(payload)]);
    assert.equal(anchor.href, "blob:word-test");
    cleanup();
    assert.equal(revoked, "blob:word-test");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
  }
});

test("Word browser helper surfaces service denial, login HTML and empty file errors", async (t) => {
  const responses = [
    new globalThis.Response(JSON.stringify({ message: "學校尚未開放 Word 匯出服務。" }), { status: 403 }),
    new globalThis.Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }),
    new globalThis.Response("", { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }),
    new globalThis.Response("upstream unavailable", { status: 502 }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  await assert.rejects(wordClient.downloadWordDocument(payload, "formal"), /學校尚未開放/);
  await assert.rejects(wordClient.downloadWordDocument(payload, "formal"), /未收到有效/);
  await assert.rejects(wordClient.downloadWordDocument(payload, "formal"), /內容為空/);
  await assert.rejects(wordClient.downloadWordDocument(payload, "formal"), /暫時無法回應/);
});

test("Word filenames safely preserve Chinese and emoji without splitting surrogate pairs", () => {
  for (const topic of ['測試😀'.repeat(100), '\ud800invalid\udfff', '../test\\:*?"<>|\r\n']) {
    const name = exporter.documentFilename({ ...payload, topic });
    assert.doesNotThrow(() => encodeURIComponent(name));
    assert.match(name, /\.docx$/);
    assert.doesNotMatch(name, /[<>:"/\\|?*]/);
    assert.ok([...name].every((char) => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127));
    assert.ok([...name].length <= 105);
  }
});

test("Word download connection errors are actionable and aborted operations remain aborted", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(wordClient.downloadWordDocument(payload, "formal"), /無法連線至校內 Word 下載服務/);
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(wordClient.downloadWordDocument(payload, "formal", controller.signal), /Failed to fetch/);
});

test("Word dialog enables its download without issuing a redundant service preflight", () => {
  const effects = [];
  const updates = [];
  let stateIndex = 0;
  const component = loadTs(path.join("components", "document-export-controls.tsx"), {
    react: {
      useState: (initial) => {
        const index = stateIndex++;
        return [index === 0 ? payload : initial, (value) => updates.push({ index, value })];
      },
      useEffect: (effect) => effects.push(effect),
      useRef: () => ({ current: null }),
    },
    "react/jsx-runtime": requireHost("react/jsx-runtime"),
    "next/script": () => null,
    "../lib/google-docs-authorization": authorization,
    "../lib/document-export": { ...exporter, checkDocumentExportAllowed: () => { throw new Error("Word must not preflight"); } },
    "../lib/canva-client": canvaClient,
    "../lib/word-client": wordClient,
    "../types/self-directed-learning": types,
  }).default;
  component({ services: { googleDocs: false, canva: false, word: true }, getPayload: () => payload, onToast: () => {} });
  assert.equal(effects[1](), undefined);
  assert.equal(updates.at(-1).value, true);
});

test("Canva job handling accepts progress/multiple links and rejects failures/untrusted links", () => {
  assert.equal(canva.canvaJob({ job: { id: "job-1", status: "in_progress" } }).status, "in_progress");
  const success = { job: { id: "job-1", status: "success", result: { designs: [{ urls: { edit_url: "https://www.canva.com/design/one/edit" } }, { urls: { edit_url: "https://www.canva.com/design/two/edit" } }] } } };
  assert.equal(canva.canvaJob(success).urls.length, 2);
  for (const value of [
    {}, { job: { id: "../bad", status: "in_progress" } },
    { job: { id: "job", status: "failed", error: { code: "invalid_file" } } },
    { job: { id: "job", status: "success", result: { designs: [{ urls: { edit_url: "https://www.canva.com.evil.example/edit" } }] } } },
  ]) assert.throws(() => canva.canvaJob(value));
});

function apiRequest(query = "", body, cookies = "") {
  return new nextServer.NextRequest(`http://localhost:3000${canva.CANVA_BASE_PATH}${query}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", cookie: cookies, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("Canva routes deny anonymous users, disabled modules, cross-origin and unconsented requests", async (t) => {
  canvaEnv(t);
  authenticated = false;
  assert.equal((await canvaRoute.GET(apiRequest("?op=config"))).status, 401);
  authenticated = true;
  blocked = true;
  assert.equal((await canvaRoute.GET(apiRequest("?op=config"))).status, 403);
  blocked = false;
  assert.equal((await canvaRoute.POST(new nextServer.NextRequest(`http://localhost:3000${canva.CANVA_BASE_PATH}`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }))).status, 403);
  assert.equal((await canvaRoute.POST(apiRequest("", { op: "authorize", agreed: false }))).status, 400);
});

test("Canva full server flow keeps secrets in cookies, validates callback, imports once and polls", async (t) => {
  canvaEnv(t);
  const start = await canvaRoute.POST(apiRequest("", { op: "authorize", agreed: true }));
  const startData = await start.json();
  const stateCookie = start.cookies.get(canva.CANVA_COOKIE.state).value;
  const state = new globalThis.URL(startData.url).searchParams.get("state");
  const cookies = `${canva.CANVA_COOKIE.state}=${stateCookie}`;
  const bad = await canvaCallback.GET(apiRequest("/callback?state=wrong&code=synthetic-code", undefined, cookies));
  assert.equal(bad.status, 400);
  let tokenCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.canva.com/rest/v1/oauth/token");
    assert.equal(options.body.get("grant_type"), "authorization_code");
    assert.equal(options.body.get("redirect_uri"), process.env.CANVA_REDIRECT_URI);
    tokenCalls++;
    return new globalThis.Response(JSON.stringify({ access_token: "synthetic-canva-token", expires_in: 3600, scope: canva.CANVA_SCOPE }));
  });
  const callback = await canvaCallback.GET(apiRequest(`/callback?state=${state}&code=synthetic-code`, undefined, cookies));
  assert.equal(callback.status, 200);
  assert.equal(tokenCalls, 1);
  const html = await callback.text();
  assert.ok(!html.includes("synthetic-canva-token"));
  const tokenCookie = callback.cookies.get(canva.CANVA_COOKIE.token);
  const authorizedCookies = `${cookies}; ${canva.CANVA_COOKIE.token}=${tokenCookie.value}`;
  const connection = await canvaRoute.GET(apiRequest("?op=connection", undefined, authorizedCookies));
  assert.equal((await connection.json()).ready, true);
  t.mock.restoreAll();
  let imports = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.canva.com/rest/v1/imports");
    imports++;
    assert.match(options.headers["Content-Type"], /octet-stream/);
    assert.ok([...Buffer.from(JSON.parse(options.headers["Import-Metadata"]).title_base64, "base64").toString()].length <= 50);
    const files = unzipStored(Buffer.from(options.body));
    assert.ok(files["word/document.xml"].includes("第一週成果"));
    return new globalThis.Response(JSON.stringify({ job: { id: "job-one", status: "in_progress" } }));
  });
  const imported = await canvaRoute.POST(apiRequest("", { agreed: true, payload, style: "portfolio" }, authorizedCookies));
  assert.equal(imported.status, 200);
  assert.equal(imports, 1);
  const body = await imported.json();
  assert.equal(body.status, "in_progress");
  assert.ok(!JSON.stringify(body).includes("synthetic-canva-token"));
  const jobCookie = imported.cookies.get(canva.CANVA_COOKIE.job).value;
  const jobCookies = `${authorizedCookies}; ${canva.CANVA_COOKIE.job}=${jobCookie}`;
  assert.equal((await canvaRoute.POST(apiRequest("", { agreed: true, payload, style: "formal" }, jobCookies))).status, 409);
  assert.equal(imports, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://api.canva.com/rest/v1/imports/job-one");
    return new globalThis.Response(JSON.stringify({ job: { id: "job-one", status: "success", result: { designs: [{ urls: { edit_url: "https://www.canva.com/design/synthetic/edit" } }] } } }));
  });
  const polled = await canvaRoute.GET(apiRequest("?op=job", undefined, jobCookies));
  assert.deepEqual((await polled.json()).urls, ["https://www.canva.com/design/synthetic/edit"]);
});

test("Canva denied callback reports the error to the original page without importing", async (t) => {
  canvaEnv(t);
  const stateCookie = await canva.sealCanva({ uid: "synthetic-student", state: "test-state", verifier: "synthetic-verifier" }, "state");
  const cookies = `${canva.CANVA_COOKIE.state}=${stateCookie}`;
  const denied = await canvaCallback.GET(apiRequest("/callback?state=test-state&error=access_denied", undefined, cookies));
  assert.equal(denied.status, 400);
  const token = denied.cookies.get(canva.CANVA_COOKIE.token).value;
  const connection = await canvaRoute.GET(apiRequest("?op=connection", undefined, `${cookies}; ${canva.CANVA_COOKIE.token}=${token}`));
  assert.equal(connection.status, 400);
  assert.match((await connection.json()).message, /未完成 Canva 授權/);
});

test("Canva origin mismatch explicitly points to the configured 127.0.0.1 origin", async (t) => {
  canvaEnv(t);
  process.env.CANVA_REDIRECT_URI = "http://127.0.0.1:3000/api/student/self-directed-learning/canva/callback";
  const response = await canvaRoute.GET(apiRequest("?op=config"));
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /127\.0\.0\.1:3000.*重新登入/);
});

test("Canva accepts loopback Host even when Next normalizes the internal URL to localhost", async (t) => {
  canvaEnv(t);
  process.env.CANVA_REDIRECT_URI = "http://127.0.0.1:3000/api/student/self-directed-learning/canva/callback";
  const request = new nextServer.NextRequest(`http://localhost:3000${canva.CANVA_BASE_PATH}?op=config`, {
    headers: { host: "127.0.0.1:3000", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http" },
  });
  assert.equal((await canvaRoute.GET(request)).status, 200);
  const authorization = await canva.canvaAuthorization();
  assert.match(new globalThis.URL(authorization.url).searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:3000/);
  for (const headers of [
    { host: "localhost:3000" },
    { host: "127.0.0.1:3001" },
    { host: "127.0.0.1:3000", "x-forwarded-proto": "https" },
    { host: "127.0.0.1:3000.evil.example" },
  ]) assert.throws(() => canva.assertCanvaOrigin(new globalThis.Request("http://localhost:3000", { headers })));
});

for (const status of [401, 403, 429, 500]) {
  test(`Canva API HTTP ${status} is surfaced without retrying`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new globalThis.Response("{}", { status });
    });
    await assert.rejects(canva.canvaRequest("imports"));
    assert.equal(calls, 1);
  });
}

function clientWindow(t, popup) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { open: () => popup } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window"); });
}

test("Canva client opens OAuth from the click and polls without sending tokens or repeating upload", async (t) => {
  const popup = { opener: {}, location: {}, close() {} };
  clientWindow(t, popup);
  const originalTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn) => originalTimer(fn, 0));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: options.body });
    let result;
    if (options.body && JSON.parse(options.body).op === "authorize") result = { success: true, url: "https://www.canva.com/api/oauth/authorize?state=synthetic" };
    else if (String(url).includes("connection")) result = { success: true, ready: true };
    else if (options.method === "POST") result = { success: true, id: "job", status: "in_progress", urls: [] };
    else result = { success: true, status: "success", urls: ["https://www.canva.com/design/test/edit"] };
    return new globalThis.Response(JSON.stringify(result));
  });
  let creating = false;
  const links = await canvaClient.exportToCanva(payload, "basic", new globalThis.AbortController().signal, () => { creating = true; });
  assert.equal(creating, true);
  assert.equal(popup.opener, null);
  assert.match(popup.location.href, /^https:\/\/www.canva.com\/api\/oauth\/authorize/);
  assert.deepEqual(links, ["https://www.canva.com/design/test/edit"]);
  const imports = calls.filter((call) => call.body && JSON.parse(call.body).payload);
  assert.equal(imports.length, 1);
  assert.equal(JSON.parse(imports[0].body).style, "basic");
  assert.ok(!JSON.stringify(calls).includes("access_token"));
});

test("Canva popup blocked and cancelled authorization never upload content", async (t) => {
  clientWindow(t, null);
  await assert.rejects(canvaClient.exportToCanva(payload, "formal", new globalThis.AbortController().signal, () => {}), /彈出視窗/);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { open: () => ({ location: {}, close() {} }) } });
  const controller = new globalThis.AbortController();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    controller.abort();
    return new globalThis.Response(JSON.stringify({ success: true, url: "https://www.canva.com/api/oauth/authorize" }));
  });
  await assert.rejects(canvaClient.exportToCanva(payload, "formal", controller.signal, () => {}), /已取消/);
  assert.equal(requests, 1);
});
