import "server-only";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import { hashPassword } from "@/lib/auth";
import {
  ACCOUNT_FORMAT_MESSAGE,
  ACCOUNT_IDENTIFIER_REQUIRED_MESSAGE,
  EMAIL_FORMAT_MESSAGE,
  isStrongPassword,
  normalizeAccount,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
  PASSWORD_REQUIREMENT_MESSAGE,
} from "@/lib/validation";
import {
  AccountRecord,
  AccountStatus,
  ACTIVE_STATUS,
  AdminModule,
  ADMIN_MODULE_VALUES,
  resolveAdminModule,
  USER_COLLECTION,
  UserRole,
  isAccountActive,
  isAccountStatus,
  isStaffAttribute,
  isUserRole,
  lastLoginOf,
  normalizeAccountStatus,
  resolveStaffAttribute,
  STAFF_ATTRIBUTES,
} from "@/types/users";
import { SchoolPeriod } from "@/types/settings";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  ACCOUNT_FIELD_KEYS,
  AccountInput,
  ENTRY_DEFAULT_STATUS,
  ManagedModuleGrant,
  managedModuleKeys,
  ROSTER_ENTRY_FIELDS,
  RosterEntry,
  RosterFieldKey,
  RosterInput,
  RosterMember,
  RosterRole,
  rosterCollection,
} from "@/types/roster";

export type { RosterMember };

/** 使用者帳號的欄位（無學年度學期） */
export interface AccountFields {
  email: string;
  account: string;
  name: string;
}

/** 名冊專屬欄位（隨學年度、學期變動），鍵見 ROSTER_ENTRY_FIELDS */
export type RosterData = Partial<Record<RosterFieldKey, string | string[]>>;

export type RosterValidation =
  | { ok: true; account: AccountFields; roster: RosterData }
  | { ok: false; message: string };

const MAX_TEXT = 64;
const MAX_SHORT = 32;

function text(value: unknown, max = MAX_SHORT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 名冊文件 id：每「帳號 × 學年度 × 學期」唯一，方便直接更新與讀取 */
export function rosterEntryId(uid: string, period: SchoolPeriod): string {
  return `${uid}_${period.academicYear}_${period.semester}`;
}

/**
 * 驗證並正規化一列資料，拆成「使用者帳號」與「名冊專屬欄位」兩段。
 * 帳號規則：電子郵件與帳號至少填一個（登入識別，另一欄可留空）、姓名必填；
 * 密碼與帳號管理屬「使用者帳號管理」，名冊不處理。
 * 名冊規則：學生學號必填；管理員條目無屬性／模組欄位（管理員恆全權）。
 */
export function validateRosterInput(role: RosterRole, input: RosterInput): RosterValidation {
  const name = text(input.name, MAX_TEXT);
  if (!name) return { ok: false, message: "請填寫姓名" };

  const rawEmail = text(input.email, MAX_TEXT);
  const rawAccount = text(input.account, MAX_TEXT);
  if (!rawEmail && !rawAccount) {
    return { ok: false, message: ACCOUNT_IDENTIFIER_REQUIRED_MESSAGE };
  }

  const email = rawEmail ? normalizeEmail(rawEmail) || "" : "";
  if (rawEmail && !email) return { ok: false, message: EMAIL_FORMAT_MESSAGE };

  const account = rawAccount ? normalizeAccount(rawAccount) || "" : "";
  if (rawAccount && !account) return { ok: false, message: ACCOUNT_FORMAT_MESSAGE };

  const accountFields: AccountFields = { email, account, name };
  const roster: Record<string, unknown> = {};

  for (const key of ROSTER_ENTRY_FIELDS[role]) {
    roster[key] = text(input[key], MAX_TEXT);
  }

  if (role === "student" && !roster.studentId) {
    return { ok: false, message: "請填寫學號" };
  }

  if (role === "staff") {
    const attribute = resolveStaffAttribute(text(input.attribute, MAX_SHORT));
    if (attribute && !isStaffAttribute(attribute)) {
      return {
        ok: false,
        message: `教職員屬性僅支援「${STAFF_ATTRIBUTES.join("」「")}」`,
      };
    }
    roster.attribute = attribute;
  }

  // 管理員條目：無屬性／指定功能模組欄位（管理員恆全權；政策修改書決議二）
  // 舊輸入殘留的 attribute／modules 欄位一律不寫入

  return { ok: true, account: accountFields, roster: roster as RosterData };
}

export type AccountValidation =
  | { ok: true; account: AccountFields; password: string | null }
  | { ok: false; message: string };

/**
 * 驗證「使用者帳號管理」工作表的帳號輸入（無名冊欄位）。
 * 建立時密碼必填；更新時密碼留空代表不變更。
 * skipPasswordRule＝略過密碼命名規則（僅驗證非空白與長度上限），批次匯入使用。
 */
export function validateAccountInput(
  input: AccountInput,
  options: { requirePassword: boolean; skipPasswordRule?: boolean }
): AccountValidation {
  const name = text(input.name, MAX_TEXT);
  if (!name) return { ok: false, message: "請填寫姓名" };

  const rawEmail = text(input.email, MAX_TEXT);
  const rawAccount = text(input.account, MAX_TEXT);
  if (!rawEmail && !rawAccount) {
    return { ok: false, message: ACCOUNT_IDENTIFIER_REQUIRED_MESSAGE };
  }

  const email = rawEmail ? normalizeEmail(rawEmail) || "" : "";
  if (rawEmail && !email) return { ok: false, message: EMAIL_FORMAT_MESSAGE };

  const account = rawAccount ? normalizeAccount(rawAccount) || "" : "";
  if (rawAccount && !account) return { ok: false, message: ACCOUNT_FORMAT_MESSAGE };

  const rawPassword = typeof input.password === "string" ? input.password : "";
  let password: string | null = null;
  if (rawPassword) {
    if (options.skipPasswordRule) {
      if (rawPassword.length > PASSWORD_MAX_LENGTH) {
        return { ok: false, message: `密碼最多 ${PASSWORD_MAX_LENGTH} 碼` };
      }
    } else if (!isStrongPassword(rawPassword)) {
      return { ok: false, message: PASSWORD_REQUIREMENT_MESSAGE };
    }
    password = rawPassword;
  } else if (options.requirePassword) {
    return {
      ok: false,
      message: options.skipPasswordRule
        ? "請填寫密碼"
        : `請填寫密碼，${PASSWORD_REQUIREMENT_MESSAGE}`,
    };
  }

  return { ok: true, account: { email, account, name }, password };
}

/** 查重索引：email/account 依使用者帳號；學號依「當期」的該身分名冊 */
export interface RosterIndex {
  emails: Map<string, string>;
  accounts: Map<string, string>;
  studentIds: Map<string, string>;
}
/**
 * 以電子郵件或帳號找出現有使用者帳號（綁定既有帳號用）；查無回 null。
 */
export async function findAccountByKey(key: string): Promise<{
  uid: string;
  email: string;
  account: string;
  name: string;
  status: AccountStatus;
} | null> {
  const db = getAdminDbRaw();
  const raw = text(key, MAX_TEXT);
  if (!raw) return null;

  const fields: ("email" | "account")[] = raw.includes("@") ? ["email", "account"] : ["account", "email"];
  for (const field of fields) {
    const value = field === "email" ? normalizeEmail(raw) : normalizeAccount(raw);
    if (!value) continue;
    const snap = await db.collection(USER_COLLECTION).where(field, "==", value).limit(1).get();
    const doc = snap.docs[0];
    if (!doc) continue;
    const data = doc.data();
    return {
      uid: doc.id,
      email: typeof data.email === "string" ? data.email : "",
      account: typeof data.account === "string" ? data.account : "",
      name: typeof data.name === "string" ? data.name : "",
      status: normalizeAccountStatus(data.status),
    };
  }
  return null;
}

/** 回傳衝突訊息（無衝突回 null） */
export function checkRosterConflict(
  account: AccountFields,
  roster: RosterData,
  index: RosterIndex
): string | null {
  if (account.email && index.emails.has(account.email)) return "此電子郵件已被使用";
  if (account.account && index.accounts.has(account.account)) return "此帳號已被使用";
  const studentId =
    typeof roster.studentId === "string" ? roster.studentId : "";
  if (studentId && index.studentIds.has(studentId)) return "此學號已被使用";
  return null;
}

/**
 * 單筆查重（鐵律 3：查詢回傳幾筆＝幾次讀取）：以電子郵件／帳號／學號精準查詢，
 * 查無只收空查詢的最低 1 讀；取代整表掃描建索引（批次匯入也只對本批列的
 * 辨識鍵做 `where in` 查詢，不再整表掃）。
 * `excludeUid`＝忽略此帳號（更新自己時 email/account 學號不算衝突）；
 * `role`＋`period`＝學號檢查範圍（同身分、同學期；孤兒條目不佔學號）。
 * 回傳衝突訊息，無衝突回 null。檢查順序與 checkRosterConflict 一致：email → account → 學號。
 */
export async function checkAccountConflictDirect(
  account: AccountFields,
  roster: RosterData,
  options: { role?: RosterRole; period?: SchoolPeriod; excludeUid?: string } = {}
): Promise<string | null> {
  const db = getAdminDbRaw();
  const users = db.collection(USER_COLLECTION);

  // 電子郵件／帳號：各一筆等值查詢；limit(2) 保證「排除自己後仍有他人」必被看見
  const keyed: Array<["email" | "account", string]> = [
    ["email", account.email],
    ["account", account.account],
  ];
  for (const [field, value] of keyed) {
    if (!value) continue;
    const snap = await users.where(field, "==", value).limit(2).get();
    if (snap.docs.some((doc) => doc.id !== options.excludeUid)) {
      return field === "email" ? "此電子郵件已被使用" : "此帳號已被使用";
    }
  }

  const studentId = typeof roster.studentId === "string" ? roster.studentId : "";
  if (studentId && options.role && options.period) {
    const snap = await db
      .collection(rosterCollection(options.role))
      .where("studentId", "==", studentId)
      .where("academicYear", "==", options.period.academicYear)
      .where("semester", "==", options.period.semester)
      .get();
    for (const doc of snap.docs) {
      const uid = typeof doc.data().uid === "string" ? doc.data().uid : "";
      if (!uid || uid === options.excludeUid) continue;
      // 孤兒條目（帳號已刪除）不佔學號，與批次匯入的學號查重同一語意
      if (!(await users.doc(uid).get()).exists) continue;
      return "此學號已被使用";
    }
  }
  return null;
}

/** 組出「使用者帳號」文件：四種身分共用同一張 users 表（名冊欄位於名冊四表） */
export function buildAccountRecord(
  account: AccountFields,
  passwordHash: string,
  preferredRole?: UserRole | ""
): AccountRecord {
  const now = Date.now();
  const record: AccountRecord = {
    email: account.email,
    account: account.account,
    passwordHash,
    name: account.name,
    status: ACTIVE_STATUS,
    loginRecords: [],
    lastLoginMethod: "",
    loginCount: 0,
    cssThemeId: "",
    installedThemes: "[]",
    lockedUntil: 0,
    lockIp: "",
    failedAttempts: 0,
    tokenVersion: 1,
    // 管理員代設的預設密碼：本人首次登入須先修改（全螢幕擋下，見 ForceChangePassword）
    mustChangePassword: true,
    createdAt: now,
  };
  if (isUserRole(preferredRole)) record.preferredRole = preferredRole;
  return record;
}

/**
 * 組出一條名冊資料（寫入前呼叫）：
 * 共同欄位（狀態、電子郵件、帳號名、姓名、學年度、學期）＋該身分的專屬欄位。
 * 帳號名一併留存，孤兒條目（帳號已刪除）才能用「電子郵件或帳號」銜接回重建的帳號。
 */
export function buildRosterEntry(
  uid: string,
  role: RosterRole,
  period: SchoolPeriod,
  roster: RosterData,
  identity: { email: string; name: string; account?: string; status?: AccountStatus }
): RosterEntry {
  const now = Date.now();
  const data: Record<string, unknown> = {
    uid,
    status: identity.status || ENTRY_DEFAULT_STATUS,
    email: identity.email,
    account: identity.account || "",
    name: identity.name,
    academicYear: period.academicYear,
    semester: period.semester,
    createdAt: now,
    updatedAt: now,
  };
  for (const key of ROSTER_ENTRY_FIELDS[role]) {
    const value = roster[key];
    data[key] = typeof value === "undefined" ? "" : value;
  }
  // 管理員模組只存實際提供值：缺漏＝空陣列，不代為補上（超級＝全開由 attribute 決定）
  if (role === "admin" && !Array.isArray(data.modules)) {
    data.modules = [];
  }
  return data as unknown as RosterEntry;
}

/** 讀取某帳號在指定學年度學期的身分名冊條目（無則回 null） */
export async function getRosterEntry(
  uid: string,
  role: RosterRole,
  period: SchoolPeriod
): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDbRaw()
    .collection(rosterCollection(role))
    .doc(rosterEntryId(uid, period))
    .get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  return data.uid === uid ? data : null;
}

/** 讀取指定身分在指定學年度學期的名冊，以 uid 為鍵 */
export async function loadPeriodEntries(
  period: SchoolPeriod,
  role: RosterRole
): Promise<Map<string, Record<string, unknown>>> {
  const snapshot = await getAdminDbRaw()
    .collection(rosterCollection(role))
    .where("academicYear", "==", period.academicYear)
    .where("semester", "==", period.semester)
    .get();
  const map = new Map<string, Record<string, unknown>>();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const uid = typeof data.uid === "string" ? data.uid : "";
    if (uid) map.set(uid, data);
  }
  return map;
}

/** 條目是否可用（狀態＝有效；缺 status 視為有效） */
export function isActiveEntry(entry: Record<string, unknown> | null | undefined): boolean {
  if (!entry) return false;
  if (typeof entry.status === "string") return isAccountStatus(entry.status) && entry.status === ACTIVE_STATUS;
  return true;
}

/** 名冊條目的狀態（有效／無效；缺 status 視為有效） */
export function entryStatus(entry: Record<string, unknown> | null | undefined): AccountStatus {
  return entry ? normalizeAccountStatus(entry.status) : ACTIVE_STATUS;
}

/**
 * 該帳號在當期可用（有效）的身分清單，順序固定 ALL_ROLES。
 * 登入候選、慣用身分可選範圍都由此決定。
 */
export async function getActiveRoles(
  uid: string,
  period: SchoolPeriod,
  roles: readonly UserRole[]
): Promise<UserRole[]> {
  const entries = await Promise.all(
    roles.map((role) => getRosterEntry(uid, role, period))
  );
  return roles.filter((_, index) => isActiveEntry(entries[index]));
}

/**
 * 稱謂：名冊姓名（該期該身分）＞帳號姓名＞電子郵件。
 * 登入、切換身分時都以此決定 session 的 displayName。
 */
export function resolveDisplayName(
  account: Record<string, unknown> | null | undefined,
  entry: Record<string, unknown> | null | undefined
): string {
  const entryName = entry && typeof entry.name === "string" ? entry.name.trim() : "";
  if (entryName) return entryName;
  const accountName = account && typeof account.name === "string" ? account.name.trim() : "";
  if (accountName) return accountName;
  const email = account && typeof account.email === "string" ? account.email : "";
  return email;
}

/**
 * 更新帳號識別欄位時，同步當期各名冊條目的電子郵件／帳號名／姓名（展示與銜接用）。
 * 只更新確實存在的條目，歷史學期不受影響。
 */
export async function syncEntryIdentity(
  uid: string,
  period: SchoolPeriod,
  patch: { email?: string; account?: string; name?: string }
): Promise<void> {
  const db = getAdminDbRaw();
  const roles: RosterRole[] = ["student", "parent", "staff", "admin"];
  const refs = roles.map((role) =>
    db.collection(rosterCollection(role)).doc(rosterEntryId(uid, period))
  );
  const snaps = await Promise.all(refs.map((ref) => ref.get()));
  const updates = snaps
    .filter((snap) => snap.exists)
    .map((snap) => {
      const data: Record<string, unknown> = { updatedAt: Date.now() };
      if (typeof patch.email === "string") data.email = patch.email;
      if (typeof patch.account === "string") data.account = patch.account;
      if (typeof patch.name === "string") data.name = patch.name;
      return snap.ref.update(data);
    });
  await Promise.all(updates);
}

/** 四張名冊（與 syncEntryIdentity 同序） */
const ROSTER_ROLES_ALL: RosterRole[] = ["student", "parent", "staff", "admin"];

/**
 * `create()` 撞到已存在文件（ALREADY_EXISTS）的判定。
 * gRPC 狀態碼為數字 6（`@grpc/grpc-js` Status），部分執行環境／REST fallback
 * 回字串別名，三者都認，避免「已存在＝跳過」的分支被漏接而拋錯。
 */
export function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

/**
 * 把 fromUid 的名冊條目（四張名冊、所有學年度學期）改掛到 toUid：
 * 改寫 uid 欄位與 doc id（`toUid_學年度_學期`）；toUid 已有的條目跳過（不覆寫）。
 * `allowSuper＝false` 時跳過「超級」管理員條目（銜接＝授予超級，非超級操作者不得為之）。
 * toUid 查無使用者文件時不動作（`options.assumeTargetExists` 可跳過該點查，
 * 供批量銜接使用——呼叫端已保證目標存在）。回傳成功改掛的條目數。
 */
export async function moveEntriesUid(
  fromUid: string,
  toUid: string,
  allowSuper: boolean,
  options?: { assumeTargetExists?: boolean }
): Promise<number> {
  if (!fromUid || !toUid || fromUid === toUid) return 0;
  const db = getAdminDbRaw();
  if (
    !options?.assumeTargetExists &&
    !(await db.collection(USER_COLLECTION).doc(toUid).get()).exists
  ) {
    return 0;
  }

  const snaps = await Promise.all(
    ROSTER_ROLES_ALL.map((role) =>
      db.collection(rosterCollection(role)).where("uid", "==", fromUid).get()
    )
  );
  let moved = 0;
  for (let i = 0; i < ROSTER_ROLES_ALL.length; i += 1) {
    const role = ROSTER_ROLES_ALL[i];
    const col = db.collection(rosterCollection(role));
    for (const doc of snaps[i].docs) {
      const data = doc.data();
      if (!allowSuper && role === "admin" && isSuperEntry(data)) continue;
      const academicYear = typeof data.academicYear === "number" ? data.academicYear : null;
      const semester = typeof data.semester === "number" ? data.semester : null;
      if (academicYear === null || semester === null) continue;
      const targetId = rosterEntryId(toUid, { academicYear, semester });
      if (targetId === doc.id) continue;
      const targetRef = col.doc(targetId);
      // 用 create 取代「先 get 判存在再 set」：存在即 ALREADY_EXISTS 跳過、不覆寫，
      // 語意相同但省下每條 1 次點查讀取
      try {
        await targetRef.create({ ...data, uid: toUid });
      } catch (error) {
        if (isAlreadyExistsError(error)) continue;
        throw error;
      }
      await doc.ref.delete();
      moved += 1;
    }
  }
  return moved;
}

/**
 * 自動銜接：建立／更新帳號時，把「孤兒名冊條目」（uid 已查無使用者文件）
 * 且辨識鍵（電子郵件地址或帳號）相符者，整批改掛回此帳號。
 * `allowSuper＝false` 時不接「超級」管理員條目（見 moveEntriesUid）。
 * 仍屬活著帳號的條目一律不動。回傳銜接的條目數（無相符回 0）。
 */
export async function linkOrphanEntries(
  target: {
    uid: string;
    email: string;
    account: string;
  },
  allowSuper: boolean
): Promise<number> {
  if (!target.uid || (!target.email && !target.account)) return 0;
  const db = getAdminDbRaw();

  // 1) 以辨識鍵找候選條目（email／account 各查一次，同文件去重）
  const seen = new Set<string>();
  const candidateUids = new Set<string>();
  for (const role of ROSTER_ROLES_ALL) {
    const col = db.collection(rosterCollection(role));
    const queries = [
      ...(target.email ? [col.where("email", "==", target.email).get()] : []),
      ...(target.account ? [col.where("account", "==", target.account).get()] : []),
    ];
    const snaps = await Promise.all(queries);
    for (const snap of snaps) {
      for (const doc of snap.docs) {
        const key = `${role}:${doc.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const uid = typeof doc.data().uid === "string" ? doc.data().uid : "";
        if (!uid || uid === target.uid) continue;
        candidateUids.add(uid);
      }
    }
  }
  if (candidateUids.size === 0) return 0;

  // 2) 孤兒判定：uid 已無使用者文件（仍活著的帳號不接，避免誤掛）
  const uids = [...candidateUids];
  const orphanUids = new Set<string>();
  for (let i = 0; i < uids.length; i += 200) {
    const chunk = uids.slice(i, i + 200);
    const snaps = await db.getAll(...chunk.map((uid) => db.collection(USER_COLLECTION).doc(uid)));
    snaps.forEach((snap, index) => {
      if (!snap.exists) orphanUids.add(chunk[index]);
    });
  }
  if (orphanUids.size === 0) return 0;

  // 3) 逐個孤兒 uid 整批改掛（同一辨識鍵可能來自多個孤兒 uid）
  let linked = 0;
  for (const uid of orphanUids) {
    linked += await moveEntriesUid(uid, target.uid, allowSuper);
  }
  return linked;
}

/** 批量銜接的目標帳號（批次建立／更新帳號時彙整） */
export interface LinkTarget {
  uid: string;
  email: string;
  account: string;
}

/**
 * 批量版 linkOrphanEntries：一次把多個目標帳號的孤兒條目銜接回來。
 * 省讀取的三個手段（批次建立 120 列時，逐列執行＝每列 8 條查詢＋各自的孤兒點查）：
 * 1) 辨識鍵查詢以 `in` 分塊（30 值一塊）合併：每角色每欄位 ⌈鍵數/30⌉ 條查詢；
 * 2) 孤兒判定跨目標去重後共用同一輪 getAll；
 * 3) 改掛時跳過目標使用者文件的存在性點查（呼叫端剛建立／既有的帳號，保證存在）。
 * 語意與單筆版一致：仍屬活著帳號的條目不動、超級條目依 allowSuper 決定、
 * 目標已有條目不覆寫（moveEntriesUid 的 create）。
 * 回傳全部目標成功銜接的條目數總和。
 */
export async function linkOrphanEntriesBatch(
  targets: LinkTarget[],
  allowSuper: boolean
): Promise<number> {
  const active = targets.filter((item) => item.uid && (item.email || item.account));
  if (active.length === 0) return 0;
  const db = getAdminDbRaw();

  // 辨識鍵 → 目標（辨識鍵全站唯一；重複時保留先出現者）
  const byEmail = new Map<string, LinkTarget>();
  const byAccount = new Map<string, LinkTarget>();
  for (const target of active) {
    if (target.email && !byEmail.has(target.email)) byEmail.set(target.email, target);
    if (target.account && !byAccount.has(target.account)) byAccount.set(target.account, target);
  }

  // 1) 合併查詢：每角色 × 每辨識鍵欄位，比較值以 in 分塊
  const fields: [string, Map<string, LinkTarget>][] = [
    ["email", byEmail],
    ["account", byAccount],
  ];
  const candidates = new Map<string, { uid: string; target: LinkTarget }>();
  for (const role of ROSTER_ROLES_ALL) {
    const col = db.collection(rosterCollection(role));
    for (const [field, map] of fields) {
      const values = [...map.keys()];
      if (values.length === 0) continue;
      for (let i = 0; i < values.length; i += 30) {
        const chunk = values.slice(i, i + 30);
        const snap = await col.where(field, "in", chunk).get();
        for (const doc of snap.docs) {
          const data = doc.data();
          const target = map.get(String(data[field] ?? ""));
          if (!target) continue;
          const uid = typeof data.uid === "string" ? data.uid : "";
          if (!uid || uid === target.uid) continue;
          // 同一條目可能同時被 email 與 account 命中，以角色＋文件 id 去重
          const key = `${role}:${doc.id}`;
          if (!candidates.has(key)) candidates.set(key, { uid, target });
        }
      }
    }
  }
  if (candidates.size === 0) return 0;

  // 2) 孤兒判定：uid 去重後共用一輪 getAll（仍活著的帳號一律不接，避免誤掛）
  const uids = [...new Set([...candidates.values()].map((item) => item.uid))];
  const orphanUids = new Set<string>();
  for (let i = 0; i < uids.length; i += 200) {
    const chunk = uids.slice(i, i + 200);
    const snaps = await db.getAll(...chunk.map((uid) => db.collection(USER_COLLECTION).doc(uid)));
    snaps.forEach((snap, index) => {
      if (!snap.exists) orphanUids.add(chunk[index]);
    });
  }
  if (orphanUids.size === 0) return 0;

  // 3) 依目標分組改掛（同一孤兒 uid 對到多個目標時保留先出現者）
  const perTarget = new Map<string, Set<string>>();
  for (const { uid, target } of candidates.values()) {
    if (!orphanUids.has(uid)) continue;
    const group = perTarget.get(target.uid) ?? new Set<string>();
    group.add(uid);
    perTarget.set(target.uid, group);
  }

  let linked = 0;
  for (const [targetUid, group] of perTarget) {
    for (const orphanUid of group) {
      linked += await moveEntriesUid(orphanUid, targetUid, allowSuper, {
        assumeTargetExists: true,
      });
    }
  }
  return linked;
}

/** 使用者帳號文件 → 帳號清單的帳號段（不含密碼） */
function accountStatus(account: Record<string, unknown> | null): AccountStatus {
  return account ? normalizeAccountStatus(account.status) : ACTIVE_STATUS;
}

/** 使用者帳號＋當期名冊條目 → 帳號清單一列（不含密碼；名冊欄位取自目前學年度學期）
 *  參數同時接受 Firestore 回傳的 DocumentData 與型別化的 AccountRecord／RosterEntry
 *（回應即真相：mutation 路由用寫入前的快照直接組列，免再點查）。 */
export function toRosterMember(
  role: RosterRole,
  uid: string,
  account: AccountRecord | Record<string, unknown> | null,
  entry: RosterEntry | Record<string, unknown> | null
): RosterMember {
  const acc = account as Record<string, unknown> | null;
  const ent = entry as Record<string, unknown> | null;
  const str = (source: Record<string, unknown> | null, key: string) =>
    source && typeof source[key] === "string" ? (source[key] as string) : "";

  const member: RosterMember = {
    uid,
    // 孤兒列（帳號已刪除）：退回條目留存的辨識鍵，方便辨識與銜接
    email: acc ? str(acc, "email") : str(ent, "email"),
    account: acc ? str(acc, "account") : str(ent, "account"),
    name: str(ent, "name") || str(acc, "name"),
    status: accountStatus(acc),
    rosterStatus: entryStatus(ent),
    orphan: !acc,
  };
  if (acc) {
    const lastLogin = lastLoginOf(acc);
    if (lastLogin) member.lastLogin = lastLogin;
    if (typeof acc.loginCount === "number") member.loginCount = acc.loginCount;
    if (isUserRole(acc.preferredRole)) member.preferredRole = acc.preferredRole;
  }

  const target = member as unknown as Record<string, string | string[] | undefined>;
  for (const key of ROSTER_ENTRY_FIELDS[role]) {
    const value = key === "attribute" && role === "staff"
      ? resolveStaffAttribute(str(ent, key))
      : str(ent, key);
    if (value) target[key] = value;
  }
  // 被指定管理的功能模組（僅非管理員身分；管理員恆全權不用此欄）
  if (role !== "admin") {
    const grants = managedModulesOf(ent);
    if (grants.length > 0) {
      member.managedModules = grants;
      (member as unknown as Record<string, unknown>).managedModuleKeys = managedModuleKeys(grants);
    }
  }
  return member;
}

/** 密碼雜湊（匯入／表單共用；costFactor 固定 12，不接受外部指定） */
export async function hashRosterPassword(plain: string): Promise<string> {
  return hashPassword(plain, 12);
}

/** 表單／匯入的帳號欄位判定（無學年度學期的欄位寫入 users） */
export function isAccountFieldKey(key: RosterFieldKey): boolean {
  return (ACCOUNT_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * 管理員守門上下文：整批作業只讀一次「當期管理員名冊＋其使用者帳號」，
 * 之後每列的守門判定全是純計算（docs/資料庫讀取規範.md 鐵律 4：禁止 N+1）。
 * 原本批次每列各查一次管理員名冊＋getAll，400 列即可放大成數千次讀取。
 */
export interface AdminGuardContext {
  period: SchoolPeriod;
  /** 當期管理員條目（uid → entry，含有效與無效） */
  entries: Map<string, Record<string, unknown>>;
  /** 條目有效 ＋ 使用者帳號有效 的管理員 uid */
  activeAdminUids: Set<string>;
  /** 上者之中屬性＝超級者 */
  activeSuperUids: Set<string>;
}

/** 載入管理員守門上下文（讀 1 次當期管理員名冊＋分塊 getAll 使用者帳號） */
export async function loadAdminGuardContext(): Promise<AdminGuardContext> {
  const db = getAdminDbRaw();
  const period = await getCurrentPeriod();
  const snapshot = await db
    .collection(rosterCollection("admin"))
    .where("academicYear", "==", period.academicYear)
    .where("semester", "==", period.semester)
    .get();

  const entries = new Map<string, Record<string, unknown>>();
  const activeUids: string[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const uid = typeof data.uid === "string" ? data.uid : "";
    if (!uid) continue;
    entries.set(uid, data);
    if (isActiveEntry(data)) activeUids.push(uid);
  }

  const activeAdminUids = new Set<string>();
  const activeSuperUids = new Set<string>();
  for (let i = 0; i < activeUids.length; i += 200) {
    const chunk = activeUids.slice(i, i + 200);
    const snaps = await db.getAll(...chunk.map((uid) => db.collection(USER_COLLECTION).doc(uid)));
    snaps.forEach((snap, index) => {
      if (!snap.exists || !isAccountActive(snap.data())) return;
      const uid = chunk[index];
      activeAdminUids.add(uid);
      // 超級屬性已退役：不再有超級管理員集合（維持欄位相容舊呼叫點）
    });
  }

  return { period, entries, activeAdminUids, activeSuperUids };
}

/** 除本人外的有效管理員數（由上下文純計算） */
export function countOtherActiveAdminsFrom(ctx: AdminGuardContext, excludeUid: string): number {
  let count = 0;
  for (const uid of ctx.activeAdminUids) if (uid !== excludeUid) count += 1;
  return count;
}

/** 【已退役】除本人外的有效超級管理員數——超級概念已取消，固定回 0 */
export function countOtherActiveSupersFrom(_ctx: AdminGuardContext, _excludeUid: string): number {
  return 0;
}

/**
 * 【已退役】最後一位超級守門——超級概念已取消，固定放行（null）。
 * 「最後一位管理員不可停用」由 accountStatusGuardFrom 保留。
 */
export function lastSuperGuardFrom(_ctx: AdminGuardContext, _uid: string): string | null {
  return null;
}

/** 【已退役】同 lastSuperGuardFrom（整批上下文版）；保留供批次路徑相容 */
export async function lastSuperGuard(_uid: string): Promise<string | null> {
  return null;
}

/** 狀態變更／刪除守門（由上下文純計算；訊息與 accountStatusGuard 一致） */
export function accountStatusGuardFrom(
  ctx: AdminGuardContext,
  uid: string,
  sessionUid: string
): string | null {
  if (uid === sessionUid) return "無法停用自己使用的帳號";
  const entry = ctx.entries.get(uid) ?? null;
  if (!isActiveEntry(entry)) return null;
  // 最後一位有效管理員不可停用（保留：沒管理員就沒人能進管理端）
  if (countOtherActiveAdminsFrom(ctx, uid) === 0) return "無法停用最後一位有效管理員";
  return null;
}

/**
 * 狀態變更／刪除的守門：本人、以及「仍是有效管理員且只剩他一位」。
 * 回傳擋下訊息，null＝放行（訊息用語由呼叫端依情境調整）。
 * 單筆操作可用本函式；批次作業請改用 loadAdminGuardContext＋accountStatusGuardFrom。
 */
export async function accountStatusGuard(uid: string, sessionUid: string): Promise<string | null> {
  if (uid === sessionUid) return "無法停用自己使用的帳號";
  const period = await getCurrentPeriod();
  const entry = await getRosterEntry(uid, "admin", period);
  if (!isActiveEntry(entry)) return null;
  // 是有效管理員才載入整批上下文（非管理員維持 1 次點查的最低成本）
  return accountStatusGuardFrom(await loadAdminGuardContext(), uid, sessionUid);
}

/**
 * 【已退役】超級管理員條目判定——管理員屬性已取消（政策修改書決議二）：
 * 全體管理員平等，不再有「超級」特殊條目。固定回 false，舊呼叫點自然失效。
 */
export function isSuperEntry(_entry: Record<string, unknown> | null | undefined): boolean {
  return false;
}

/**
 * 【已退役】管理員屬性層級守門——屬性已取消，固定放行（null）。
 * 保留函式相容既有呼叫點；「最後一位管理員不可停用」另由 accountStatusGuard 守門。
 */
export function adminAttributeGuard(_options: {
  isSuper: boolean;
  nextAttribute?: string | null;
  currentAttribute?: string | null;
}): string | null {
  return null;
}

/**
 * 名冊條目「實際存的」功能模組代碼（僅舊資料相容顯示用；
 * 新政策下管理員恆全權，本函式不再參與授予判定）。
 */
export function storedAdminModules(
  entry: Record<string, unknown> | null | undefined
): AdminModule[] {
  const modules = entry && Array.isArray(entry.modules) ? entry.modules : [];
  const resolved = modules
    .filter((item): item is string => typeof item === "string")
    .map((item) => resolveAdminModule(item))
    .filter((item): item is AdminModule => Boolean(item));
  return ADMIN_MODULE_VALUES.filter((module) => resolved.includes(module));
}

/**
 * 管理員可用的功能模組權限（政策修改書決議二）：
 * 有當期管理員名冊條目＝全體模組全開（含原 superOnly）；無條目＝無權限。
 * 「屬性／指定功能模組」欄位已退役，不再逐模組判定。
 */
export function adminModulesOf(entry: Record<string, unknown> | null | undefined): AdminModule[] {
  if (!entry) return [];
  return [...ADMIN_MODULE_VALUES];
}

/** managedModules 欄位正規化：僅承認 { module: string, permissions: string[] } 形狀 */
function normalizeManagedModules(value: unknown): ManagedModuleGrant[] {
  if (!Array.isArray(value)) return [];
  const out: ManagedModuleGrant[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const module = typeof (item as { module?: unknown }).module === "string"
      ? (item as { module: string }).module.trim()
      : "";
    if (!module) continue;
    const rawPerms = (item as { permissions?: unknown }).permissions;
    const permissions = Array.isArray(rawPerms)
      ? rawPerms.filter((perm): perm is string => typeof perm === "string" && perm.trim() !== "")
      : [];
    if (!out.some((grant) => grant.module === module)) {
      out.push({ module, permissions });
    }
  }
  return out;
}

/**
 * 非管理員身分條目被指定管理的功能模組（政策修改書 §6）。
 * 無條目或無欄位＝空陣列（未被指定）。
 */
export function managedModulesOf(
  entry: Record<string, unknown> | null | undefined
): ManagedModuleGrant[] {
  if (!entry) return [];
  return normalizeManagedModules(entry.managedModules);
}

/**
 * 守門判定用：該條目對模組是否被指定管理，及是否含指定子權限。
 * - `permission` 省略＝只要被指定（不論子權限）即為 true；
 * - `permission` 有值＝permissions 需含該碼；被指定但 permissions 為空陣列＝false。
 */
export function hasManagedModule(
  entry: Record<string, unknown> | null | undefined,
  module: string,
  permission?: string
): boolean {
  const grants = managedModulesOf(entry);
  const grant = grants.find((item) => item.module === module);
  if (!grant) return false;
  if (permission === undefined) return true;
  return grant.permissions.includes(permission);
}
