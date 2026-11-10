import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getAdminDb } from "@/lib/firebase-admin";
import { isSuperAdmin, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { logActivity, getClientIp } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod, getCacheEpoch } from "@/lib/settings-server";
import { invalidateAdminListCache } from "@/lib/list-cache";
import { normalizeAccount, normalizeEmail } from "@/lib/validation";
import { ADMIN_MODULES, USER_COLLECTION } from "@/types/users";
import { SchoolPeriod } from "@/types/settings";
import {
  ROSTER_BATCH_MODE_LABELS,
  ROSTER_ENTRY_FIELDS,
  ROSTER_FIELDS,
  RosterBatchChange,
  RosterBatchMode,
  RosterBatchPreview,
  RosterBatchResult,
  RosterBatchRow,
  RosterBatchStrategy,
  RosterFieldKey,
  RosterInput,
  RosterRole,
  isEmptyRosterInput,
  isImportableRole,
  isRosterBatchStrategy,
  isRosterRole,
  rosterCollection,
  rosterImportFields,
  rosterImportHint,
  rosterRoleLabel,
} from "@/types/roster";
import {
  AdminGuardContext,
  RosterData,
  RosterIndex,
  adminAttributeGuard,
  buildRosterEntry,
  countOtherActiveAdminsFrom,
  countOtherActiveSupersFrom,
  isSuperEntry,
  lastSuperGuardFrom,
  loadAdminGuardContext,
  loadPeriodEntries,
  rosterEntryId,
  storedAdminModules,
  validateRosterInput,
} from "@/lib/roster";
import { assertBodySize, DEFAULT_FORM_BODY_BYTES } from "@/lib/http-body";

/** 條目上的管理員屬性字串（無／非字串＝空） */
function attributeOf(entry: Record<string, unknown> | null | undefined): string {
  return entry && typeof entry.attribute === "string" ? entry.attribute : "";
}

/** Firestore 寫入與 900 列上限一起控管 */
export const maxDuration = 300;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 900;
/** 保留在 Firestore WriteBatch 500 筆上限內，並為不同模式留出餘裕。 */
const WRITE_BATCH_CHUNK = 400;

const MODES: RosterBatchMode[] = ["create", "update", "delete"];

/** 標題列正規化：忽略大小寫與所有空白（"Student ID" === "studentid"） */
function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function buildAliasMap(role: RosterRole): Map<string, RosterFieldKey> {
  const map = new Map<string, RosterFieldKey>();
  // 匯入只認電子郵件、姓名與該身分的名冊欄位；帳號與密碼屬使用者帳號，不屬名冊
  for (const field of rosterImportFields(role)) {
    map.set(normalizeHeader(field.label), field.key);
    for (const alias of field.aliases) map.set(normalizeHeader(alias), field.key);
  }
  return map;
}

/** 解析試算表 → 逐列輸入（回傳的 row 是工作表實際列號，第 1 列為標題） */
function parseSpreadsheet(
  buffer: Buffer,
  role: RosterRole
): { rows: RosterInput[] } | { error: string } {
  let sheetRows: Record<string, unknown>[];
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) return { error: "檔案內找不到工作表" };
    sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    });
  } catch {
    return { error: "檔案無法讀取，請確認是 Excel 或 CSV 檔" };
  }

  const aliasMap = buildAliasMap(role);
  const matchedKeys = new Set<RosterFieldKey>();
  const rows: RosterInput[] = [];

  for (const raw of sheetRows) {
    const input: RosterInput = {};
    for (const [header, value] of Object.entries(raw)) {
      const key = aliasMap.get(normalizeHeader(header));
      if (!key) continue;
      matchedKeys.add(key);
      input[key] = String(value ?? "").trim();
    }
    rows.push(input);
  }

  if (matchedKeys.size === 0) {
    return {
      error: `標題列無法辨識，需要的欄位：${rosterImportHint(role)}`,
    };
  }

  return { rows };
}

interface AccountSnapshot {
  uid: string;
  email: string;
  account: string;
  name: string;
}

interface BatchContext {
  /** email／account → uid（名冊批次的辨識索引） */
  index: RosterIndex;
  byUid: Map<string, AccountSnapshot>;
  /** 目前學年度學期的該身分名冊條目（以 uid 為鍵） */
  entries: Map<string, Record<string, unknown>>;
}

/** Firestore in／not-in 子句的比較值上限 */
const IN_CHUNK = 30;
/** `getAll` 分塊（鐵律 4：請求體上限） */
const GET_ALL_CHUNK = 200;

async function loadBatchContext(
  role: RosterRole,
  period: SchoolPeriod,
  rows: RosterInput[],
  /** 覆蓋模式要整期條目（清空比對）；其餘只要本批列對應到的條目 */
  needAllEntries: boolean
): Promise<BatchContext> {
  const db = getAdminDb();
  const users = db.collection(USER_COLLECTION);
  // 名冊批次以電子郵件地址或帳號辨識既有帳號（密碼屬使用者帳號管理，本流程不碰）
  const index: RosterIndex = { emails: new Map(), accounts: new Map(), studentIds: new Map() };
  const byUid = new Map<string, AccountSnapshot>();

  const collect = (snapshot: {
    docs: Array<{ id: string; data: () => Record<string, unknown> }>;
  }) => {
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const email = typeof data.email === "string" ? data.email : "";
      const account = typeof data.account === "string" ? data.account : "";
      if (email) index.emails.set(email, doc.id);
      if (account) index.accounts.set(account, doc.id);
      byUid.set(doc.id, {
        uid: doc.id,
        email,
        account,
        name: typeof data.name === "string" ? data.name : "",
      });
    }
  };

  // 辨識鍵只查本批列會用到的（in 分塊 30 值／批），不再整表掃描使用者。
  // 電子郵件先查：命中的文件已帶出帳號欄位，帳號鍵若已在索引就不再查
  //（一列常同時填兩者且指向同一帳號，避免同一帳號被兩次查詢各算 1 讀）
  const emailKeys = [
    ...new Set(rows.map((input) => normalizeEmail(input.email))),
  ].filter((key): key is string => Boolean(key));
  for (let i = 0; i < emailKeys.length; i += IN_CHUNK) {
    collect(await users.where("email", "in", emailKeys.slice(i, i + IN_CHUNK)).get());
  }
  const accountKeys = [
    ...new Set(rows.map((input) => normalizeAccount(input.account))),
  ].filter((key): key is string => key !== null && !index.accounts.has(key));
  for (let i = 0; i < accountKeys.length; i += IN_CHUNK) {
    collect(await users.where("account", "in", accountKeys.slice(i, i + IN_CHUNK)).get());
  }

  // 條目：覆蓋模式整期讀一次（要清空全部）；其餘逐 uid 點查（點查不存在＝0 讀）
  const entries = new Map<string, Record<string, unknown>>();
  if (needAllEntries) {
    for (const [uid, data] of await loadPeriodEntries(period, role)) entries.set(uid, data);
  } else {
    const uids = new Set<string>();
    for (const input of rows) {
      const resolved = resolveUid(input, index);
      if (resolved.uid) uids.add(resolved.uid);
    }
    const col = db.collection(rosterCollection(role));
    const refs = [...uids].map((uid) => ({ uid, ref: col.doc(rosterEntryId(uid, period)) }));
    for (let i = 0; i < refs.length; i += GET_ALL_CHUNK) {
      const chunk = refs.slice(i, i + GET_ALL_CHUNK);
      const docs = await db.getAll(...chunk.map((item) => item.ref));
      const uidByDocId = new Map(chunk.map((item) => [item.ref.id, item.uid]));
      for (const doc of docs) {
        if (!doc.exists) continue;
        const uid = uidByDocId.get(doc.id);
        if (!uid) continue;
        const data = doc.data() ?? {};
        // 同 getRosterEntry：文件的 uid 欄位須對得上才視為該帳號的條目
        if (data.uid === uid) entries.set(uid, data);
      }
    }
  }

  return { index, byUid, entries };
}

interface PlannedCreate {
  row: number;
  action: "create";
  key: string;
  uid: string;
  email: string;
  account: string;
  name: string;
  roster: RosterData;
}

interface PlannedUpdate {
  row: number;
  action: "update";
  key: string;
  uid: string;
  entryPatch: Record<string, unknown>;
  changes: RosterBatchChange[];
}

interface PlannedDelete {
  row: number;
  action: "delete";
  key: string;
  uid: string;
}

interface PlannedSkip {
  row: number;
  action: "skip";
  key: string;
  reason: string;
}

type PlannedRow = PlannedCreate | PlannedUpdate | PlannedDelete | PlannedSkip;

/** 辨識鍵（預覽清單顯示）：電子郵件地址優先，否則帳號 */
function rowKey(input: RosterInput): string {
  return input.email || input.account || "（空白）";
}

function skipRow(row: number, input: RosterInput, reason: string): PlannedSkip {
  return { row, action: "skip", key: rowKey(input), reason };
}

function fieldLabel(role: RosterRole, key: RosterFieldKey): string {
  return ROSTER_FIELDS[role].find((field) => field.key === key)?.label || key;
}

/** 「指定功能模組」的比較／顯示文字（舊代碼一併對應到現行模組） */
function modulesText(codes: string[]): string {
  return codes
    .map((code) => ADMIN_MODULES.find((item) => item.value === code)?.label || "")
    .filter(Boolean)
    .join("、");
}

/**
 * 批次新增：只在「既有帳號」上建立本期名冊條目，不建立帳號、不處理密碼。
 * 辨識鍵＝電子郵件地址或帳號（至少一個，兩者都填須指向同一帳號）；
 * 帳號（uid）＋學年度＋學期才是名冊的唯一鍵；其餘欄位重複一律放行（管理員事後修改）。
 * 追加模式遇同一學期已有條目則略過；覆蓋模式先清空同一學期條目，故同一列可直接重建。
 */
function planCreate(
  role: RosterRole,
  row: number,
  input: RosterInput,
  context: BatchContext,
  seen: Set<string>,
  strategy: RosterBatchStrategy,
  isSuper: boolean
): PlannedRow {
  const resolved = resolveUid(input, context.index);
  if (!resolved.uid) return skipRow(row, input, resolved.error ?? "查無此帳號");
  const uid = resolved.uid;
  if (seen.has(uid)) return skipRow(row, input, "檔案中重複對應到同一名冊資料");

  const current = context.byUid.get(uid);
  if (!current) return skipRow(row, input, "查無此帳號");
  // 追加模式：同一學期已有條目就略過；覆蓋模式先清空，同一列照常重建
  if (strategy === "append" && context.entries.has(uid)) {
    return skipRow(row, input, `此帳號本期已具備${rosterRoleLabel(role)}身分`);
  }

  // 帳號欄位一律以既有帳號為準（檔案只用來辨識，不改帳號層）；姓名必填，未填＝該列略過
  const validation = validateRosterInput(role, {
    ...input,
    email: current.email,
    account: current.account,
    name: input.name,
  });
  if (!validation.ok) return skipRow(row, input, validation.message);

  // 屬性層級守門：非超級管理員不得建立超級管理員（覆蓋模式會以檔案重建既有條目）
  if (role === "admin") {
    const guard = adminAttributeGuard({
      isSuper,
      nextAttribute:
        typeof validation.roster.attribute === "string" ? validation.roster.attribute : null,
      currentAttribute: attributeOf(context.entries.get(uid)),
    });
    if (guard) return skipRow(row, input, guard);
  }

  seen.add(uid);
  return {
    row,
    action: "create",
    key: current.email || current.account,
    uid,
    email: current.email,
    account: current.account,
    name: validation.account.name,
    roster: validation.roster,
  };
}

/** 修改／刪除／新增共用的辨識：電子郵件地址與帳號都填時必須指向同一帳號 */
function resolveUid(
  input: RosterInput,
  index: RosterIndex
): { uid?: string; error?: string; key: string } {
  const key = rowKey(input);
  const emailKey = input.email ? normalizeEmail(input.email) : "";
  const accountKey = input.account ? normalizeAccount(input.account) : "";
  if (!emailKey && !accountKey) {
    return { key, error: "請填寫電子郵件地址或帳號以辨識資料" };
  }
  const byEmail = emailKey ? index.emails.get(emailKey) : undefined;
  const byAccount = accountKey ? index.accounts.get(accountKey) : undefined;
  if (byEmail && byAccount && byEmail !== byAccount) {
    return { key, error: "電子郵件與帳號對應到不同帳號" };
  }
  const uid = byEmail ?? byAccount;
  if (!uid) return { key, error: "查無此帳號" };
  return { uid, key };
}

async function planUpdate(
  role: RosterRole,
  row: number,
  input: RosterInput,
  context: BatchContext,
  seen: Set<string>,
  isSuper: boolean,
  adminGuard: AdminGuardContext | null
): Promise<PlannedRow> {
  const resolved = resolveUid(input, context.index);
  if (!resolved.uid) return skipRow(row, input, resolved.error ?? "查無此帳號");
  const uid = resolved.uid;
  if (seen.has(uid)) return skipRow(row, input, "檔案中重複對應到同一名冊資料");

  const current = context.byUid.get(uid);
  const entry = context.entries.get(uid);
  if (!current || !entry) return skipRow(row, input, "本期無此身分名冊資料");

  // 電子郵件與帳號是辨識鍵，批次不修改；姓名與其他欄位皆可留空（空白＝不修改）
  const fileName = input.name ? input.name.trim() : "";

  // 以現有資料為底，檔案中非空白的欄位覆蓋（空白＝不修改）
  const merged: Record<string, unknown> = {
    email: current.email,
    account: current.account,
    name: fileName || current.name,
  };
  for (const key of ROSTER_ENTRY_FIELDS[role]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      merged[key] = value;
      continue;
    }
    const prev = entry[key];
    merged[key] = key === "modules" && Array.isArray(prev) ? prev.join(",") : String(prev ?? "");
  }

  const validation = validateRosterInput(role, merged as RosterInput);
  if (!validation.ok) return skipRow(row, input, validation.message);

  const roster = validation.roster;

  // 屬性層級守門：非超級管理員不得改超級條目；降級最後一位超級管理員也要擋
  if (role === "admin") {
    const nextAttribute = attributeOf(roster);
    const guard = adminAttributeGuard({
      isSuper,
      nextAttribute,
      currentAttribute: attributeOf(entry),
    });
    if (guard) return skipRow(row, input, guard);
    if (isSuperEntry(entry) && nextAttribute !== "超級") {
      if (!adminGuard) return skipRow(row, input, "管理員守門資料未載入");
      const lastSuper = lastSuperGuardFrom(adminGuard, uid);
      if (lastSuper) return skipRow(row, input, lastSuper);
    }
  }

  const changes: RosterBatchChange[] = [];
  const entryPatch: Record<string, unknown> = {};

  const prevName = typeof entry.name === "string" ? entry.name : String(entry.name ?? "");
  if (fileName && fileName !== prevName) {
    changes.push({ label: fieldLabel(role, "name"), from: prevName, to: fileName });
    entryPatch.name = fileName;
  }

  for (const key of ROSTER_ENTRY_FIELDS[role]) {
    const nextModules =
      key === "modules" && Array.isArray(roster.modules) ? (roster.modules as string[]) : null;
    // 比對「實際存的」模組（不套用超級＝全開），空白欄位沿用原值才不會誤報變更
    const prevModules = key === "modules" ? storedAdminModules(entry) : null;
    const label = fieldLabel(role, key);
    if (nextModules && prevModules) {
      const nextText = modulesText(nextModules);
      const prevText = modulesText(prevModules);
      if (nextText === prevText) continue;
      changes.push({ label, from: prevText, to: nextText });
      entryPatch[key] = nextModules;
      continue;
    }
    const nextValue = typeof roster[key] === "string" ? (roster[key] as string) : "";
    const prevValue =
      typeof entry[key] === "string" ? (entry[key] as string) : entry[key] == null ? "" : String(entry[key]);
    if (nextValue === prevValue) continue;
    changes.push({ label, from: prevValue, to: nextValue });
    entryPatch[key] = nextValue;
  }

  if (changes.length === 0) return skipRow(row, input, "沒有需要更新的欄位");
  seen.add(uid);
  return {
    row,
    action: "update",
    key: resolved.key,
    uid,
    entryPatch: { ...entryPatch, updatedAt: Date.now() },
    changes,
  };
}

async function planDelete(
  role: RosterRole,
  row: number,
  input: RosterInput,
  context: BatchContext,
  seen: Set<string>,
  sessionUid: string,
  isSuper: boolean,
  adminGuard: AdminGuardContext | null
): Promise<PlannedRow> {
  const resolved = resolveUid(input, context.index);
  if (!resolved.uid) return skipRow(row, input, resolved.error ?? "查無此帳號");
  const uid = resolved.uid;
  if (seen.has(uid)) return skipRow(row, input, "檔案中重複對應到同一名冊資料");
  if (!context.entries.has(uid)) return skipRow(row, input, "本期無此身分名冊資料");

  if (role === "admin") {
    const entry = context.entries.get(uid);
    // 屬性層級守門：非超級管理員不得刪除超級條目、不得刪最後一位超級管理員
    const guardMsg = adminAttributeGuard({ isSuper, currentAttribute: attributeOf(entry) });
    if (guardMsg) return skipRow(row, input, guardMsg);
    if (uid === sessionUid) return skipRow(row, input, "無法刪除自己的管理員身分");
    if (!adminGuard) return skipRow(row, input, "管理員守門資料未載入");
    if (countOtherActiveAdminsFrom(adminGuard, uid) === 0) {
      return skipRow(row, input, "無法刪除最後一位有效管理員");
    }
    if (isSuperEntry(entry)) {
      const lastSuper = lastSuperGuardFrom(adminGuard, uid);
      if (lastSuper) return skipRow(row, input, lastSuper);
    }
  }

  seen.add(uid);
  return { row, action: "delete", key: resolved.key, uid };
}

function buildPreview(
  mode: RosterBatchMode,
  strategy: RosterBatchStrategy,
  cleared: number,
  planned: PlannedRow[]
): RosterBatchPreview {
  const rows: RosterBatchRow[] = planned.map((item) => {
    if (item.action === "skip") {
      return { row: item.row, key: item.key, action: "skip", reason: item.reason };
    }
    if (item.action === "update") {
      return { row: item.row, key: item.key, action: "update", changes: item.changes };
    }
    return { row: item.row, key: item.key, action: item.action };
  });
  const count = (action: PlannedRow["action"]) =>
    planned.filter((item) => item.action === action).length;
  return {
    mode,
    strategy,
    cleared,
    total: planned.length,
    created: count("create"),
    updated: count("update"),
    deleted: count("delete"),
    skipped: count("skip"),
    rows,
  };
}

/**
 * 覆蓋模式要先行刪除的 uid：本期該身分的全部條目。
 * 管理員身分保留三道防呆（自己的管理員身分、最後一位有效管理員、最後一位超級管理員），
 * 檔案包含該人時仍會在下一輪以檔案資料覆寫重建。
 */
async function planReplaceDeletions(
  role: RosterRole,
  context: BatchContext,
  sessionUid: string,
  adminGuard: AdminGuardContext | null
): Promise<string[]> {
  const uids = [...context.entries.keys()];
  if (role !== "admin" || uids.length === 0) return uids;
  // 防禦：上下文未載入時一個都不清（寧可不清空，也不能刪光管理員把自己鎖在門外）
  if (!adminGuard) return [];

  const keep = new Set<string>([sessionUid]);
  for (const uid of uids) {
    if (keep.has(uid)) continue;
    if (countOtherActiveAdminsFrom(adminGuard, uid) === 0) keep.add(uid);
    else if (
      isSuperEntry(context.entries.get(uid)) &&
      countOtherActiveSupersFrom(adminGuard, uid) === 0
    ) {
      keep.add(uid);
    }
  }
  return uids.filter((uid) => !keep.has(uid));
}

async function executePlan(
  planned: PlannedRow[],
  role: RosterRole,
  period: SchoolPeriod,
  clearUids: string[]
): Promise<RosterBatchResult> {
  const db = getAdminDb();
  const entries = db.collection(rosterCollection(role));
  const skipped: { row: number; reason: string }[] = [];
  let cleared = 0;
  let created = 0;
  let updated = 0;
  let deleted = 0;

  // 覆蓋：先以多個原子 batch 清空同一學期既有條目，再依計畫建立。
  for (let offset = 0; offset < clearUids.length; offset += WRITE_BATCH_CHUNK) {
    const chunk = clearUids.slice(offset, offset + WRITE_BATCH_CHUNK);
    const batch = db.batch();
    for (const uid of chunk) batch.delete(entries.doc(rosterEntryId(uid, period)));
    await batch.commit();
    cleared += chunk.length;
  }

  const actionable = planned.filter((item) => item.action !== "skip");
  for (const item of planned) {
    if (item.action === "skip") skipped.push({ row: item.row, reason: item.reason });
  }

  // 每列原本各自 await 一次 Firestore RPC；改為每批最多 400 筆原子寫入，
  // 降低 900 列匯入時的網路往返，同時維持批次大小低於 Firestore 500 筆上限。
  for (let offset = 0; offset < actionable.length; offset += WRITE_BATCH_CHUNK) {
    const chunk = actionable.slice(offset, offset + WRITE_BATCH_CHUNK);
    const batch = db.batch();
    let chunkCreated = 0;
    let chunkUpdated = 0;
    let chunkDeleted = 0;
    for (const item of chunk) {
      const ref = entries.doc(rosterEntryId(item.uid, period));
      if (item.action === "create") {
        // 只建立名冊條目：帳號與密碼一律不動
        batch.set(
          ref,
          buildRosterEntry(item.uid, role, period, item.roster, {
            email: item.email,
            account: item.account,
            name: item.name,
          })
        );
        chunkCreated += 1;
      } else if (item.action === "update") {
        batch.update(ref, item.entryPatch);
        chunkUpdated += 1;
      } else {
        batch.delete(ref);
        chunkDeleted += 1;
      }
    }
    await batch.commit();
    created += chunkCreated;
    updated += chunkUpdated;
    deleted += chunkDeleted;
  }

  return { cleared, created, updated, deleted, skipped };
}

export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "roster-batch",
      RATE.ROSTER_BATCH.limit,
      RATE.ROSTER_BATCH.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    const bodyTooLarge = assertBodySize(request, DEFAULT_FORM_BODY_BYTES);
    if (bodyTooLarge) return bodyTooLarge;

    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    const modeRaw = formData.get("mode");
    const mode =
      typeof modeRaw === "string" && (MODES as string[]).includes(modeRaw)
        ? (modeRaw as RosterBatchMode)
        : null;
    if (!mode) {
      return NextResponse.json({ success: false, message: "批次作業模式無效" }, { status: 400 });
    }
    const dryRun = formData.get("dryRun") === "true";

    // 寫入策略：僅「新增」模式有意義，缺省＝追加（其餘模式一律忽略）
    const strategyRaw = formData.get("strategy");
    const strategy: RosterBatchStrategy =
      mode === "create" && isRosterBatchStrategy(strategyRaw) ? strategyRaw : "append";

    const roleValue = formData.get("role");
    const role = isRosterRole(roleValue) ? roleValue : null;
    if (!role) {
      return NextResponse.json({ success: false, message: "帳號身分無效" }, { status: 400 });
    }
    if (mode === "create" && !isImportableRole(role)) {
      return NextResponse.json(
        { success: false, message: `${rosterRoleLabel(role)}不提供檔案匯入，請使用表單建立` },
        { status: 400 }
      );
    }

    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, message: "請選擇要上傳的檔案" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { success: false, message: "檔案超過 5MB，請拆成多個檔案分批處理" },
        { status: 400 }
      );
    }

    const parsed = parseSpreadsheet(Buffer.from(await file.arrayBuffer()), role);
    if ("error" in parsed) {
      return NextResponse.json({ success: false, message: parsed.error }, { status: 400 });
    }

    const dataRows = parsed.rows
      .map((input, index) => ({ row: index + 2, input }))
      .filter(({ input }) => !isEmptyRosterInput(input));

    if (dataRows.length === 0) {
      return NextResponse.json(
        { success: false, message: "檔案中沒有資料列" },
        { status: 400 }
      );
    }
    if (dataRows.length > MAX_ROWS) {
      return NextResponse.json(
        {
          success: false,
          message: `單次最多處理 ${MAX_ROWS} 列，此檔有 ${dataRows.length} 列，請分批處理`,
        },
        { status: 400 }
      );
    }

    const period = await getCurrentPeriod();
    // 覆蓋模式要整期條目（清空比對）；其餘只取本批列會對應到的條目（鐵律 3）
    const needAllEntries = mode === "create" && strategy === "replace";
    const context = await loadBatchContext(
      role,
      period,
      dataRows.map((item) => item.input),
      needAllEntries
    );
    // 管理員屬性的層級守門需知道操作者是否為超級管理員（其餘身分不涉及）
    const isSuper = role === "admin" ? await isSuperAdmin(session) : false;
    // 管理員守門上下文：整批只讀一次（更新／刪除／覆蓋會用到；純新增追加不需）
    const needsAdminGuard =
      role === "admin" && (mode !== "create" || strategy === "replace");
    const adminGuard = needsAdminGuard ? await loadAdminGuardContext() : null;
    const seen = new Set<string>();
    const planned: PlannedRow[] = [];
    for (const { row, input } of dataRows) {
      if (mode === "create") {
        planned.push(planCreate(role, row, input, context, seen, strategy, isSuper));
      } else if (mode === "update") {
        planned.push(await planUpdate(role, row, input, context, seen, isSuper, adminGuard));
      } else {
        planned.push(
          await planDelete(role, row, input, context, seen, session.uid, isSuper, adminGuard)
        );
      }
    }

    // 覆蓋：先算出要清空的既有條目（管理員身分有防呆保留）
    const clearUids =
      mode === "create" && strategy === "replace"
        ? await planReplaceDeletions(role, context, session.uid, adminGuard)
        : [];

    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        preview: buildPreview(mode, strategy, clearUids.length, planned),
      });
    }

    // 覆蓋會刪掉檔案以外的資料：有任何略過列就要求先修正，避免清空後建不出來
    const blocked = planned.find(
      (item): item is PlannedSkip => item.action === "skip"
    );
    if (clearUids.length > 0 && blocked) {
      return NextResponse.json(
        {
          success: false,
          message: `覆蓋模式不允許略過列（第 ${blocked.row} 列：${blocked.reason}），請修正檔案後重新上傳`,
        },
        { status: 400 }
      );
    }

    const result = await executePlan(planned, role, period, clearUids);
    const label = ROSTER_BATCH_MODE_LABELS[mode];
    const clearedText = result.cleared > 0 ? `覆蓋刪除 ${result.cleared} 筆、` : "";
    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "roster_batch",
      ip: getClientIp(request),
      details: `${rosterRoleLabel(role)}批次${label}：${clearedText}新增 ${result.created} 筆、更新 ${result.updated} 筆、刪除 ${result.deleted} 筆、略過 ${result.skipped.length} 筆`,
    });

    return NextResponse.json({
      success: true,
      dryRun: false,
      result,
      // 批次回應只有計數（前端維持一次整表 refetch 的例外）；
      // epoch 供前端同步 settings 快取，避免下次進頁誤判清單仍有效
      cacheEpoch: await getCacheEpoch(),
      message: `批次作業完成：${clearedText}新增 ${result.created} 筆、更新 ${result.updated} 筆、刪除 ${result.deleted} 筆、略過 ${result.skipped.length} 筆`,
    });
  } catch (error) {
    console.error("Roster batch error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}
