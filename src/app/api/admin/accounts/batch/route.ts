import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getAdminDb } from "@/lib/firebase-admin";
import { hasAdminModule, isSuperAdmin, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod, getCacheEpoch } from "@/lib/settings-server";
import { invalidateAdminListCache } from "@/lib/list-cache";
import { deleteStudentPersonalPhotoObjects, personalPhotoObjectPathsForRecord } from "@/lib/personal-info";
import { normalizeAccount, normalizeEmail } from "@/lib/validation";
import { SchoolPeriod } from "@/types/settings";
import {
  PERSONAL_INFO_COLLECTION,
  STUDENT_PERSONAL_IDENTITY_COLLECTION,
} from "@/types/personal-info";
import {
  ACCOUNT_BATCH_MODE_LABELS,
  ACTIVE_STATUS,
  ALL_ROLES,
  AccountBatchChange,
  AccountBatchMode,
  AccountBatchPreview,
  AccountBatchProgress,
  AccountBatchResult,
  AccountBatchRow,
  AccountStatus,
  ROLE_LABELS,
  ROSTER_DELETE_SCOPE_LABELS,
  RosterDeleteScope,
  USER_COLLECTION,
  UserRole,
  isUserRole,
  normalizeAccountStatus,
  statusLabel,
} from "@/types/users";
import {
  AccountInput,
  EntryFieldKey,
  ROSTER_ENTRY_FIELDS,
  ROSTER_ENTRY_FIELD_KEYS,
  RosterInput,
  RosterRole,
  rosterCollection,
  rosterEntryHeaderAliases,
  rosterRoleLabel,
} from "@/types/roster";
import {
  AccountFields,
  AdminGuardContext,
  RosterData,
  RosterIndex,
  accountStatusGuardFrom,
  adminAttributeGuard,
  buildAccountRecord,
  buildRosterEntry,
  checkRosterConflict,
  hashRosterPassword,
  linkOrphanEntriesBatch,
  LinkTarget,
  loadAdminGuardContext,
  rosterEntryId,
  validateAccountInput,
  validateRosterInput,
} from "@/lib/roster";
import { assertBodySize, DEFAULT_FORM_BODY_BYTES } from "@/lib/http-body";

export const maxDuration = 300;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 900;
const DELETE_CHUNK = 400;
const WRITE_BATCH_CHUNK = 400;
const GET_ALL_CHUNK = 200;
/** Firestore in／not-in 子句的比較值上限 */
const IN_CHUNK = 30;
/** 各模式每批處理列數：單批須在 300 秒（Vercel maxDuration）內完成，故依模式切割、由前端依 progress 迴圈送下一批 */
const CHUNK_SIZE: Record<AccountBatchMode, number> = {
  create: 120,
  update: 400,
  delete: 400,
};

const MODES: AccountBatchMode[] = ["create", "update", "delete"];

type AccountColumnKey = "email" | "account" | "name" | "password" | "preferredRole" | "status";

/** 批次檔的欄位鍵：帳號欄位＋「身分」＋名冊專屬欄位（跨四種身分） */
type BatchFieldKey = AccountColumnKey | "role" | EntryFieldKey;

type BatchFields = Record<BatchFieldKey, string>;

interface EntryIdentitySync {
  uid: string;
  patch: { account?: string; name?: string };
}

const FIELD_HEADERS: { key: AccountColumnKey; aliases: string[] }[] = [
  { key: "email", aliases: ["電子郵件地址", "電子郵件", "信箱", "email", "e-mail", "mail"] },
  { key: "account", aliases: ["帳號", "账号", "使用者名稱", "account", "username"] },
  { key: "name", aliases: ["姓名", "名稱", "name"] },
  { key: "password", aliases: ["密碼", "密码", "password", "passwd"] },
  {
    key: "preferredRole",
    aliases: ["慣用身分", "预设身分", "預設身分", "preferredrole", "preferred role"],
  },
  { key: "status", aliases: ["狀態", "状态", "status"] },
];

/** 「身分」欄：填了才會在建立帳號的同時建立本學期該身分名冊條目 */
const ROLE_HEADER: { key: "role"; aliases: string[] } = {
  key: "role",
  aliases: ["身分", "身份", "role"],
};

/** 名冊專屬欄位（學號、班級、屬性等）的標題別名，依「身分」欄決定讀哪些 */
const ROSTER_HEADERS: { key: EntryFieldKey; aliases: string[] }[] = ROSTER_ENTRY_FIELD_KEYS.map(
  (key) => ({ key, aliases: rosterEntryHeaderAliases(key) })
);

const ALL_HEADERS = [...FIELD_HEADERS, ROLE_HEADER, ...ROSTER_HEADERS];

const FIELD_KEYS: BatchFieldKey[] = ALL_HEADERS.map((field) => field.key);

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

const ROLE_HEADERS = new Map<string, UserRole>();
for (const role of ALL_ROLES) {
  ROLE_HEADERS.set(normalizeHeader(role), role);
  ROLE_HEADERS.set(normalizeHeader(ROLE_LABELS[role]), role);
}
ROLE_HEADERS.set(normalizeHeader("教師"), "staff");
ROLE_HEADERS.set(normalizeHeader("老師"), "staff");

function parseStatus(value: string): AccountStatus | null {
  const key = normalizeHeader(value);
  if (key === "有效" || key === "啟用" || key === "active") return "有效";
  if (key === "無效" || key === "停用" || key === "停權" || key === "disabled" || key === "inactive") {
    return "無效";
  }
  return null;
}

function emptyFields(): BatchFields {
  const row = {} as Record<BatchFieldKey, string>;
  for (const key of FIELD_KEYS) row[key] = "";
  return row;
}

function parseSpreadsheet(buffer: Buffer): { rows: BatchFields[] } | { error: string } {
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

  const headerMap = new Map<string, BatchFieldKey>();
  for (const field of ALL_HEADERS) {
    for (const alias of field.aliases) headerMap.set(normalizeHeader(alias), field.key);
  }

  const matched = new Set<BatchFieldKey>();
  const rows: BatchFields[] = [];
  for (const raw of sheetRows) {
    const row = emptyFields();
    for (const [header, value] of Object.entries(raw)) {
      const key = headerMap.get(normalizeHeader(header));
      if (!key) continue;
      matched.add(key);
      row[key] = String(value ?? "").trim();
    }
    rows.push(row);
  }

  if (matched.size === 0) {
    return {
      error:
        "標題列無法辨識，第一列需為欄位名稱（電子郵件地址／帳號／姓名／密碼／慣用身分／狀態／身分）",
    };
  }
  return { rows };
}

interface AccountSnapshot {
  uid: string;
  email: string;
  account: string;
  name: string;
  status: AccountStatus;
  preferredRole: UserRole | null;
}

/**
 * 辨識鍵的正規化：與 resolveUid（直接正規化）及 validateAccountInput（先截 64 字元再正規化）
 * 的寫法取聯集——兩者僅在超過 64 字元時不同，聯集可保證所有查重查詢都查得到。
 */
function lookupKeys(kind: "email" | "account", value: string): string[] {
  if (!value) return [];
  const keys = new Set<string>();
  const normalize = kind === "email" ? normalizeEmail : normalizeAccount;
  const push = (raw: string | null) => {
    if (raw) keys.add(raw);
  };
  push(normalize(value));
  push(normalize(value.trim().slice(0, 64)));
  return [...keys];
}

/**
 * 本批列的帳號索引（鐵律 3：查詢回傳幾筆＝幾次讀取）：
 * 只以 where in 精準查「本批列會查到的辨識鍵」（30 值／批），不再整表掃描 users。
 * 查無的鍵不會出現在索引裡，語意與整表索引一致；命中的文件照舊
 * 以「實際存的 email／account」入索引，查重訊息與原本相同。
 */
async function loadAccountsFor(
  rows: BatchFields[]
): Promise<{
  index: RosterIndex;
  byUid: Map<string, AccountSnapshot>;
}> {
  const users = getAdminDb().collection(USER_COLLECTION);
  const wanted: Record<"email" | "account", Set<string>> = {
    email: new Set(),
    account: new Set(),
  };
  for (const fields of rows) {
    for (const key of lookupKeys("email", fields.email)) wanted.email.add(key);
    for (const key of lookupKeys("account", fields.account)) wanted.account.add(key);
  }

  const index: RosterIndex = { emails: new Map(), accounts: new Map(), studentIds: new Map() };
  const byUid = new Map<string, AccountSnapshot>();
  const collect = (snapshot: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }) => {
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
        status: normalizeAccountStatus(data.status),
        preferredRole: isUserRole(data.preferredRole) ? data.preferredRole : null,
      });
    }
  };

  // 電子郵件先查：命中的文件已帶出帳號欄位，帳號鍵若已在索引就不再查
  //（一列常同時填兩者且指向同一帳號，避免同一帳號被兩次查詢各算 1 讀）
  const emailKeys = [...wanted.email];
  for (let i = 0; i < emailKeys.length; i += IN_CHUNK) {
    collect(await users.where("email", "in", emailKeys.slice(i, i + IN_CHUNK)).get());
  }
  const accountKeys = [...wanted.account].filter((key) => !index.accounts.has(key));
  for (let i = 0; i < accountKeys.length; i += IN_CHUNK) {
    collect(await users.where("account", "in", accountKeys.slice(i, i + IN_CHUNK)).get());
  }
  return { index, byUid };
}

interface PlannedCreate {
  row: number;
  action: "create";
  key: string;
  account: AccountFields;
  password: string;
  preferredRole?: UserRole;
  /** 同時建立的身分（未填「身分」欄＝只建帳號） */
  role?: RosterRole;
  /** 該身分的名冊專屬欄位（已驗證） */
  roster?: RosterData;
  /** 預覽列的附加說明 */
  note?: string;
}

interface PlannedUpdate {
  row: number;
  action: "update";
  key: string;
  uid: string;
  patch: Record<string, unknown>;
  changes: AccountBatchChange[];
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

function rowKey(fields: BatchFields): string {
  return fields.email || fields.account || "（空白）";
}

function skipRow(row: number, fields: BatchFields, reason: string): PlannedSkip {
  return { row, action: "skip", key: rowKey(fields), reason };
}

/** 「身分」欄的辨識（空白＝不建立身分）；無法辨識回錯誤訊息 */
function parseRosterRole(value: string): { role?: RosterRole; error?: string } {
  if (!value) return {};
  const role = ROLE_HEADERS.get(normalizeHeader(value));
  if (!role) return { error: "身分無法辨識（學生／家長／教職員／管理員）" };
  return { role };
}

/**
 * 本批列會用到的學號查重索引（學號查重只在同身分內比對；
 * 家長的學號是其子女學號，故不跨表比對）。
 * 只以 where in 精準查本批列填的學號（同身分＋同學期），不再整表掃描名冊；
 * 孤兒條目（帳號已刪除）不佔學號：重建同辨識鍵的帳號時由自動銜接接手。
 */
async function loadPeriodStudentIdsFor(
  role: RosterRole,
  period: SchoolPeriod,
  rows: BatchFields[]
): Promise<RosterIndex> {
  const index: RosterIndex = { emails: new Map(), accounts: new Map(), studentIds: new Map() };
  if (!ROSTER_ENTRY_FIELDS[role].includes("studentId")) return index;

  const wanted = new Set<string>();
  for (const fields of rows) {
    // 學號鍵＝validateRosterInput 的 text(...)（trim＋截 64 字元），與查重比對值一致
    const studentId =
      typeof fields.studentId === "string" ? fields.studentId.trim().slice(0, 64) : "";
    if (studentId) wanted.add(studentId);
  }
  if (wanted.size === 0) return index;

  const db = getAdminDb();
  const users = db.collection(USER_COLLECTION);
  const col = db.collection(rosterCollection(role));
  const keys = [...wanted];
  const uidOf = (doc: { data: () => Record<string, unknown>; id: string }) =>
    typeof doc.data().uid === "string" && doc.data().uid ? (doc.data().uid as string) : doc.id;

  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    const batch = keys.slice(i, i + IN_CHUNK);
    const snapshot = await col
      .where("studentId", "in", batch)
      .where("academicYear", "==", period.academicYear)
      .where("semester", "==", period.semester)
      .get();
    if (snapshot.empty) continue;
    const uids = [...new Set(snapshot.docs.map(uidOf))];
    const userDocs = uids.length
      ? await db.getAll(...uids.map((uid) => users.doc(uid)))
      : [];
    const liveUids = new Set(userDocs.filter((doc) => doc.exists).map((doc) => doc.id));
    for (const doc of snapshot.docs) {
      const uid = uidOf(doc);
      if (!liveUids.has(uid)) continue;
      const studentId = typeof doc.data().studentId === "string" ? doc.data().studentId : "";
      if (studentId) index.studentIds.set(studentId, uid);
    }
  }
  return index;
}

function planCreate(
  row: number,
  fields: BatchFields,
  index: RosterIndex,
  period: SchoolPeriod | null,
  entryIndexes: Map<RosterRole, RosterIndex>,
  isSuper: boolean
): PlannedRow {
  const input: AccountInput = {};
  if (fields.email) input.email = fields.email;
  if (fields.account) input.account = fields.account;
  if (fields.name) input.name = fields.name;
  if (fields.password) input.password = fields.password;

  const validation = validateAccountInput(input, {
    requirePassword: true,
    skipPasswordRule: true,
  });
  if (!validation.ok) return skipRow(row, fields, validation.message);

  let preferredRole: UserRole | undefined;
  if (fields.preferredRole) {
    const role = ROLE_HEADERS.get(normalizeHeader(fields.preferredRole));
    if (!role) return skipRow(row, fields, "慣用身分無法辨識（學生／家長／教職員／管理員）");
    preferredRole = role;
  }

  // 同時建立身分：填了「身分」欄才建立本學期名冊條目，其名冊欄位一併驗證
  const rosterRole = parseRosterRole(fields.role);
  if (rosterRole.error) return skipRow(row, fields, rosterRole.error);
  let roster: RosterData | undefined;
  let note: string | undefined;
  if (rosterRole.role && period) {
    const entryIndex = entryIndexes.get(rosterRole.role) ?? null;
    const rosterInput: RosterInput = {};
    for (const key of ROSTER_ENTRY_FIELD_KEYS) {
      if (fields[key]) rosterInput[key] = fields[key];
    }
    const rosterValidation = validateRosterInput(rosterRole.role, {
      ...rosterInput,
      email: validation.account.email,
      account: validation.account.account,
      name: validation.account.name,
    });
    if (!rosterValidation.ok) return skipRow(row, fields, rosterValidation.message);

    // 屬性層級守門：非超級管理員不得藉「同時建立身分」建立超級管理員
    if (rosterRole.role === "admin") {
      const guard = adminAttributeGuard({
        isSuper,
        nextAttribute:
          typeof rosterValidation.roster.attribute === "string"
            ? rosterValidation.roster.attribute
            : null,
        currentAttribute: null,
      });
      if (guard) return skipRow(row, fields, guard);
    }

    // 學號查重：只與「本學期同身分」名冊比對（含本檔前列已排入者）
    const studentId = typeof rosterValidation.roster.studentId === "string"
      ? rosterValidation.roster.studentId
      : "";
    if (studentId && entryIndex?.studentIds.has(studentId)) {
      return skipRow(row, fields, "此學號已被使用");
    }

    roster = rosterValidation.roster;
    note = `同時建立本學期${rosterRoleLabel(rosterRole.role)}身分`;
    if (studentId && entryIndex) entryIndex.studentIds.set(studentId, `row:${row}`);
  }

  const conflict = checkRosterConflict(validation.account, roster ?? {}, index);
  if (conflict) return skipRow(row, fields, conflict);

  if (validation.account.email) index.emails.set(validation.account.email, `row:${row}`);
  if (validation.account.account) index.accounts.set(validation.account.account, `row:${row}`);

  return {
    row,
    action: "create",
    key: validation.account.account || validation.account.email,
    account: validation.account,
    password: validation.password as string,
    preferredRole,
    role: rosterRole.role,
    roster,
    note,
  };
}

/** 修改／刪除共用的辨識：電子郵件地址與帳號都填時必須指向同一帳號 */
function resolveUid(
  fields: BatchFields,
  index: RosterIndex
): { uid?: string; error?: string; key: string } {
  const key = rowKey(fields);
  const emailKey = fields.email ? normalizeEmail(fields.email) : "";
  const accountKey = fields.account ? normalizeAccount(fields.account) : "";
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
  row: number,
  fields: BatchFields,
  index: RosterIndex,
  byUid: Map<string, AccountSnapshot>,
  seen: Set<string>,
  sessionUid: string,
  adminGuard: AdminGuardContext | null
): Promise<PlannedRow> {
  const resolved = resolveUid(fields, index);
  if (!resolved.uid) return skipRow(row, fields, resolved.error ?? "查無此帳號");
  const uid = resolved.uid;
  if (seen.has(uid)) return skipRow(row, fields, "檔案中重複對應到同一帳號");
  const current = byUid.get(uid);
  if (!current) return skipRow(row, fields, "查無此帳號");
  if (fields.email && normalizeEmail(fields.email) !== current.email) {
    return skipRow(row, fields, "電子郵件地址與現有帳號不符（批次不支援修改電子郵件地址）");
  }

  const accountKey = fields.account ? normalizeAccount(fields.account) : "";
  const isAccountIdentity = accountKey === current.account;
  const changes: AccountBatchChange[] = [];
  const patch: Record<string, unknown> = {};

  const candidate: RosterInput = {
    email: current.email,
    name: fields.name || current.name,
    account: fields.account && !isAccountIdentity ? fields.account : current.account,
  };
  const validation = validateAccountInput(candidate, { requirePassword: false });
  if (!validation.ok) return skipRow(row, fields, validation.message);

  if (validation.account.name !== current.name) {
    changes.push({ label: "姓名", from: current.name, to: validation.account.name });
    patch.name = validation.account.name;
  }
  if (validation.account.account !== current.account) {
    const holder = index.accounts.get(validation.account.account);
    if (holder && holder !== uid) return skipRow(row, fields, "此帳號已被使用");
    changes.push({ label: "帳號", from: current.account, to: validation.account.account });
    patch.account = validation.account.account;
  }

  if (fields.status) {
    const status = parseStatus(fields.status);
    if (!status) return skipRow(row, fields, "狀態無法辨識（有效／停用）");
      if (status !== current.status) {
        changes.push({ label: "狀態", from: statusLabel(current.status), to: statusLabel(status) });
        patch.status = status;
        if (status !== ACTIVE_STATUS) {
          if (!adminGuard) return skipRow(row, fields, "管理員守門資料未載入");
          const guard = accountStatusGuardFrom(adminGuard, uid, sessionUid);
          if (guard) return skipRow(row, fields, guard);
        }
      }
  }

  if (fields.preferredRole) {
    const role = ROLE_HEADERS.get(normalizeHeader(fields.preferredRole));
    if (!role) return skipRow(row, fields, "慣用身分無法辨識（學生／家長／教職員／管理員）");
    if (role !== current.preferredRole) {
      changes.push({
        label: "慣用身分",
        from: current.preferredRole ? ROLE_LABELS[current.preferredRole] : "未設定",
        to: ROLE_LABELS[role],
      });
      patch.preferredRole = role;
    }
  }

  if (changes.length === 0) return skipRow(row, fields, "沒有需要更新的欄位");
  seen.add(uid);
  return { row, action: "update", key: resolved.key, uid, patch, changes };
}

async function planDelete(
  row: number,
  fields: BatchFields,
  index: RosterIndex,
  seen: Set<string>,
  sessionUid: string,
  adminGuard: AdminGuardContext | null
): Promise<PlannedRow> {
  const resolved = resolveUid(fields, index);
  if (!resolved.uid) return skipRow(row, fields, resolved.error ?? "查無此帳號");
  const uid = resolved.uid;
  if (seen.has(uid)) return skipRow(row, fields, "檔案中重複對應到同一帳號");
  if (!adminGuard) return skipRow(row, fields, "管理員守門資料未載入");
  const guard = accountStatusGuardFrom(adminGuard, uid, sessionUid);
  if (guard) return skipRow(row, fields, "無法刪除自己或最後一位有效管理員");
  seen.add(uid);
  return { row, action: "delete", key: resolved.key, uid };
}

function buildPreview(mode: AccountBatchMode, planned: PlannedRow[]): AccountBatchPreview {
  const rows: AccountBatchRow[] = planned.map((item) => {
    if (item.action === "skip") {
      return { row: item.row, key: item.key, action: "skip", reason: item.reason };
    }
    if (item.action === "update") {
      return { row: item.row, key: item.key, action: "update", changes: item.changes };
    }
    const note = item.action === "create" ? item.note : undefined;
    return {
      row: item.row,
      key: item.key,
      action: item.action,
      ...(note ? { note } : {}),
    };
  });
  const count = (action: PlannedRow["action"]) =>
    planned.filter((item) => item.action === action).length;
  const rostered = planned.filter(
    (item) => item.action === "create" && item.roster
  ).length;
  return {
    mode,
    total: planned.length,
    created: count("create"),
    updated: count("update"),
    deleted: count("delete"),
    skipped: count("skip"),
    ...(rostered > 0 ? { rostered } : {}),
    rows,
  };
}

/**
 * 批次同步帳號展示欄位：先以 getAll 200/批精準點查當期四種名冊，
 * 再以 WriteBatch 400/批更新存在的條目，避免逐帳號串行執行四次 get＋多次 update。
 */
async function syncEntryIdentityBatch(items: EntryIdentitySync[], period: SchoolPeriod): Promise<void> {
  if (items.length === 0) return;
  const db = getAdminDb();
  const roles: RosterRole[] = ["student", "parent", "staff", "admin"];
  const refs = items.flatMap((item) =>
    roles.map((role) => ({
      ref: db.collection(rosterCollection(role)).doc(rosterEntryId(item.uid, period)),
      patch: item.patch,
    }))
  );
  const updates: { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }[] = [];

  for (let offset = 0; offset < refs.length; offset += GET_ALL_CHUNK) {
    const chunk = refs.slice(offset, offset + GET_ALL_CHUNK);
    const snapshots = await db.getAll(...chunk.map(({ ref }) => ref));
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      if (!snapshot.exists) continue;
      updates.push({
        ref: snapshot.ref,
        data: { ...chunk[index].patch, updatedAt: Date.now() },
      });
    }
  }

  for (let offset = 0; offset < updates.length; offset += WRITE_BATCH_CHUNK) {
    const batch = db.batch();
    for (const update of updates.slice(offset, offset + WRITE_BATCH_CHUNK)) {
      batch.update(update.ref, update.data);
    }
    await batch.commit();
  }
}

/**
 * 執行計畫：建立帳號的同時寫入本學期身分名冊條目（有「身分」者）、
 * 自動銜接同辨識鍵的孤兒名冊條目；刪除列的名冊處理依 rosterScope
 * （all＝所有學期、current＝僅本學期、none＝完全保留）。
 * period 由呼叫端一次取得，整批寫入／比對同一學期。
 */
async function executePlan(
  planned: PlannedRow[],
  period: SchoolPeriod | null,
  rosterScope: RosterDeleteScope,
  byUid: Map<string, AccountSnapshot>,
  isSuper: boolean
): Promise<AccountBatchResult> {
  const db = getAdminDb();
  const users = db.collection(USER_COLLECTION);
  const skipped: { row: number; reason: string }[] = [];
  let created = 0;
  let updated = 0;
  let rostered = 0;
  let linked = 0;
  const deleteUids: string[] = [];

  // 三段式：A 建立／更新帳號 → B 一次批量銜接孤兒 → C 寫入本學期條目。
  // 銜接必須早於本學期條目寫入（同身分同學期先銜接、再依檔案覆寫，
  // 與單筆建立的順序一致）；逐列改為整批後語意不變、查詢數大幅下降。
  const linkTargets: LinkTarget[] = [];
  const entryWrites: {
    role: RosterRole;
    uid: string;
    roster: RosterData;
    email: string;
    account: string;
    name: string;
  }[] = [];
  const identitySyncs: EntryIdentitySync[] = [];
  const userWriteBatch = db.batch();
  let userWriteCount = 0;
  const createItems = planned.filter((item): item is PlannedCreate => item.action === "create");
  // 先產生 uid 並平行計算本批密碼雜湊；之後一次批次建立使用者文件。
  const preparedCreates = await Promise.all(createItems.map(async (item) => {
    const ref = users.doc();
    const record = buildAccountRecord(
      item.account,
      await hashRosterPassword(item.password),
      item.preferredRole
    );
    return { item, ref, record };
  }));
  const preparedCreateByRow = new Map(preparedCreates.map((entry) => [entry.item.row, entry]));

  for (const item of planned) {
    if (item.action === "skip") {
      skipped.push({ row: item.row, reason: item.reason });
    } else if (item.action === "create") {
      const prepared = preparedCreateByRow.get(item.row);
      if (!prepared) throw new Error(`第 ${item.row} 列帳號資料準備失敗`);
      userWriteBatch.create(prepared.ref, prepared.record);
      userWriteCount += 1;
      created += 1;
      // 自動銜接與條目寫入延後到 B／C 段統一處理（順序：先銜接、後寫條目）
      linkTargets.push({
        uid: prepared.ref.id,
        email: item.account.email,
        account: item.account.account,
      });
      if (item.role && item.roster && period) {
        entryWrites.push({
          role: item.role,
          uid: prepared.ref.id,
          roster: item.roster,
          email: item.account.email,
          account: item.account.account,
          name: item.account.name,
        });
      }
    } else if (item.action === "update") {
      userWriteBatch.update(users.doc(item.uid), item.patch);
      userWriteCount += 1;
      const nameChanged = typeof item.patch.name === "string";
      const accountChanged = typeof item.patch.account === "string";
      if (nameChanged || accountChanged) {
        identitySyncs.push({
          uid: item.uid,
          patch: {
            ...(nameChanged ? { name: item.patch.name as string } : {}),
            ...(accountChanged ? { account: item.patch.account as string } : {}),
          },
        });
      }
      // 帳號名（辨識鍵）變更：把同辨識鍵的孤兒名冊條目銜接回本帳號（併入 B 段）
      if (accountChanged) {
        const current = byUid.get(item.uid);
        linkTargets.push({
          uid: item.uid,
          email: current?.email ?? "",
          account: (item.patch.account as string) || current?.account || "",
        });
      }
      updated += 1;
    } else {
      deleteUids.push(item.uid);
    }
  }

  if (userWriteCount > 0) await userWriteBatch.commit();

  if (identitySyncs.length > 0) {
    await syncEntryIdentityBatch(identitySyncs, period ?? await getCurrentPeriod());
  }

  // B) 全部帳號就緒後一次批量銜接：in 分塊查詢＋跨目標共用孤兒判定
  if (linkTargets.length > 0) {
    linked += await linkOrphanEntriesBatch(linkTargets, isSuper);
  }

  // C) 批次寫入本學期條目（銜接已完成，同身分同學期不會重複）。
  for (let offset = 0; offset < entryWrites.length; offset += WRITE_BATCH_CHUNK) {
    const chunk = entryWrites.slice(offset, offset + WRITE_BATCH_CHUNK);
    const batch = db.batch();
    for (const write of chunk) {
      batch.set(
        db.collection(rosterCollection(write.role)).doc(rosterEntryId(write.uid, period!)),
        buildRosterEntry(write.uid, write.role, period!, write.roster, {
          email: write.email,
          account: write.account,
          name: write.name,
        })
      );
    }
    await batch.commit();
    rostered += chunk.length;
  }

  if (deleteUids.length > 0) {
    const targets = new Set(deleteUids);
    const refs = deleteUids.map((uid) => users.doc(uid));
    const personalPhotoPaths: string[] = [];
    // 名冊條目：none＝完全保留（只刪帳號）；current＝僅本學期；all＝所有學期
    // 範圍下推成 Firestore 查詢：uid in＋（current 時）學期等值條件，
    // 只讀命中的列，不再把四張名冊整表抓回來過濾（鐵律 3：查詢回傳幾筆＝幾次讀取）
    if (rosterScope !== "none") {
      if (rosterScope === "all") {
        for (const uid of deleteUids) {
          refs.push(db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION).doc(uid));
        }
      }
      const collections = ["rosterStudents", "rosterParents", "rosterStaff", "rosterAdmins"];
      for (const name of collections) {
        const col = db.collection(name);
        for (let i = 0; i < deleteUids.length; i += IN_CHUNK) {
          const chunk = deleteUids.slice(i, i + IN_CHUNK);
          const query =
            rosterScope === "current" && period
              ? col
                  .where("uid", "in", chunk)
                  .where("academicYear", "==", period.academicYear)
                  .where("semester", "==", period.semester)
              : col.where("uid", "in", chunk);
          const snapshot = await query.get();
          for (const doc of snapshot.docs) {
            const entry = doc.data();
            if (!targets.has(String(entry.uid ?? ""))) continue;
            if (
              rosterScope === "current" &&
              period &&
              (entry.academicYear !== period.academicYear || entry.semester !== period.semester)
            ) {
              continue;
            }
            refs.push(doc.ref);
          }
        }
      }
      const personalInfoCollection = db.collection(PERSONAL_INFO_COLLECTION);
      for (let i = 0; i < deleteUids.length; i += IN_CHUNK) {
        const chunk = deleteUids.slice(i, i + IN_CHUNK);
        const query =
          rosterScope === "current" && period
            ? personalInfoCollection
                .where("uid", "in", chunk)
                .where("academicYear", "==", period.academicYear)
                .where("semester", "==", period.semester)
            : personalInfoCollection.where("uid", "in", chunk);
        const snapshot = await query.get();
        for (const doc of snapshot.docs) {
          const record = doc.data();
          const uid = String(record.uid ?? "");
          if (!targets.has(uid)) continue;
          refs.push(doc.ref);
          if (typeof record.academicYear === "number" && typeof record.semester === "number") {
            personalPhotoPaths.push(
              ...personalPhotoObjectPathsForRecord(
                uid,
                { academicYear: record.academicYear, semester: record.semester },
                record
              )
            );
          }
        }
      }
    }
    for (let i = 0; i < refs.length; i += DELETE_CHUNK) {
      const batch = db.batch();
      for (const ref of refs.slice(i, i + DELETE_CHUNK)) batch.delete(ref);
      await batch.commit();
    }
    await deleteStudentPersonalPhotoObjects(personalPhotoPaths);
  }

  return { created, updated, deleted: deleteUids.length, rostered, linked, skipped };
}

export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "accounts-batch",
      RATE.ACCOUNTS_BATCH.limit,
      RATE.ACCOUNTS_BATCH.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("users");
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
        ? (modeRaw as AccountBatchMode)
        : null;
    if (!mode) {
      return NextResponse.json({ success: false, message: "批次作業模式無效" }, { status: 400 });
    }
    const dryRun = formData.get("dryRun") === "true";
    // 分批執行的起始列（僅執行生效；預覽整檔規劃，忽略 offset）
    const offsetRaw = formData.get("offset");
    const offset =
      typeof offsetRaw === "string" && /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : 0;
    // 刪除模式的名冊處理範圍（其餘模式忽略；預設＝所有學期）
    const scopeRaw = formData.get("rosterScope");
    const rosterScope: RosterDeleteScope =
      scopeRaw === "current" || scopeRaw === "none"
        ? (scopeRaw as RosterDeleteScope)
        : "all";

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

    const parsed = parseSpreadsheet(Buffer.from(await file.arrayBuffer()));
    if ("error" in parsed) {
      return NextResponse.json({ success: false, message: parsed.error }, { status: 400 });
    }

    const dataRows = parsed.rows
      .map((fields, index) => ({ row: index + 2, fields }))
      .filter(({ fields }) => Object.values(fields).some((value) => value !== ""));

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

    // 執行時只取本批列（offset 由前端依上一批回傳的 progress 推進）；預覽不切
    const totalRows = dataRows.length;
    const chunkRows = dryRun ? dataRows : dataRows.slice(offset, offset + CHUNK_SIZE[mode]);

    // 只對「本批列」建索引（整檔預覽＝整檔列；執行＝offset 那一批），不再整表掃描
    const chunkFields = chunkRows.map(({ fields }) => fields);
    const { index, byUid } = await loadAccountsFor(chunkFields);
    // 操作者是否為超級管理員（管理員屬性守門與孤兒銜接的超級條目處理共用）
    const isSuper = await isSuperAdmin(session);

    // 新增模式：先取本學期，並載入檔案內出現身分的學號索引（同身分內查重）
    let period: SchoolPeriod | null = null;
    const entryIndexes = new Map<RosterRole, RosterIndex>();
    if (mode === "create") {
      const wantedRoles = new Set<RosterRole>();
      for (const { fields } of chunkRows) {
        const parsedRole = parseRosterRole(fields.role);
        if (parsedRole.role) wantedRoles.add(parsedRole.role);
      }
      // 名冊寫入屬「身分名冊管理」權限：未被指派者整批不建立身分（直接回報，避免逐列略過）
      if (wantedRoles.size > 0 && !(await hasAdminModule(session, "roster"))) {
        return NextResponse.json(
          {
            success: false,
            message: "需具備「身分名冊管理」權限才能同時建立身分，請移除「身分」欄後重試",
          },
          { status: 403 }
        );
      }
      period = await getCurrentPeriod();
      for (const role of wantedRoles) {
        entryIndexes.set(role, await loadPeriodStudentIdsFor(role, period, chunkFields));
      }
    } else if (mode === "delete" && rosterScope === "current") {
      // 只刪本學期名冊條目：需取得目前學年度學期做比對
      period = await getCurrentPeriod();
    }

    const seen = new Set<string>();
    // 管理員守門上下文：整批只讀一次（刪除、或更新含狀態欄位時才需載入）
    const needsAdminGuard =
      mode === "delete" || (mode === "update" && chunkRows.some(({ fields }) => Boolean(fields.status)));
    const adminGuard = needsAdminGuard ? await loadAdminGuardContext() : null;
    const planned: PlannedRow[] = [];
    for (const { row, fields } of chunkRows) {
      if (mode === "create") {
        planned.push(planCreate(row, fields, index, period, entryIndexes, isSuper));
      } else if (mode === "update") {
        planned.push(await planUpdate(row, fields, index, byUid, seen, session.uid, adminGuard));
      } else {
        planned.push(await planDelete(row, fields, index, seen, session.uid, adminGuard));
      }
    }

    // 分批進度：前端依 done 決定是否送下一批（offset + processed >= 總列數 即完成）
    const progress: AccountBatchProgress = {
      offset,
      processed: chunkRows.length,
      total: totalRows,
      done: offset + chunkRows.length >= totalRows,
    };

    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        preview: buildPreview(mode, planned),
        progress,
      });
    }

    const result = await executePlan(planned, period, rosterScope, byUid, isSuper);
    const label = ACCOUNT_BATCH_MODE_LABELS[mode];
    const rosterNote = (result.rostered ?? 0) > 0 ? `、同時建立身分 ${result.rostered} 筆` : "";
    const linkNote = (result.linked ?? 0) > 0 ? `、銜接名冊 ${result.linked} 筆` : "";
    const deleteNote =
      mode === "delete" && result.deleted > 0
        ? `（${ROSTER_DELETE_SCOPE_LABELS[rosterScope]}）`
        : "";
    // 多批時於稽核紀錄與訊息標示批次序號，便於對照單批完成範圍
    const chunkTotal = Math.ceil(totalRows / CHUNK_SIZE[mode]);
    const chunkNo = Math.min(Math.floor(offset / CHUNK_SIZE[mode]) + 1, chunkTotal);
    const chunkNote = chunkTotal > 1 ? `（第 ${chunkNo}/${chunkTotal} 批）` : "";
    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "account_batch",
      ip: getClientIp(request),
      details: `批次${label}${chunkNote}：新增 ${result.created} 筆${rosterNote}${linkNote}、更新 ${result.updated} 筆、刪除 ${result.deleted} 筆${deleteNote}、略過 ${result.skipped.length} 筆`,
    });

    return NextResponse.json({
      success: true,
      dryRun: false,
      result,
      progress,
      // 批次回應只有計數（前端無法據此 patch，維持一次整表 refetch 的例外）；
      // epoch 供前端同步 settings 快取，避免下次進頁誤判清單仍有效
      cacheEpoch: await getCacheEpoch(),
      message: `批次作業完成${chunkNote}：新增 ${result.created} 筆${rosterNote}${linkNote}、更新 ${result.updated} 筆、刪除 ${result.deleted} 筆${deleteNote}、略過 ${result.skipped.length} 筆`,
    });
  } catch (error) {
    console.error("Account batch error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}
