import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { assertSameOrigin } from "@/lib/csrf";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireRole, toAuthResponse } from "@/lib/dal";
import { serverErrorMessage } from "@/lib/api-error";
import { getAdminDb } from "@/lib/firebase-admin";
import { invalidateAdminListCache } from "@/lib/list-cache";
import {
  deleteStudentPersonalPhotoObjects,
  personalPhotoObjectPathsForRecord,
} from "@/lib/personal-info";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getCacheEpoch, getCurrentPeriod } from "@/lib/settings-server";
import {
  PERSONAL_INFO_COLLECTION,
  STUDENT_PERSONAL_IDENTITY_COLLECTION,
  STUDENT_PERSONAL_IDENTITY_KEYS,
  STUDENT_PERSONAL_INFO_FIELD_DEFS,
  isIsoDate,
  readStudentPersonalIdentityFields,
  validateStudentPersonalId,
  type StudentPersonalIdentityFields,
  type StudentPersonalInfoFieldKey,
} from "@/types/personal-info";
import { rosterCollection } from "@/types/roster";
import type { SchoolPeriod } from "@/types/settings";
import { assertBodySize, DEFAULT_FORM_BODY_BYTES } from "@/lib/http-body";

export const maxDuration = 300;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 900;
const WRITE_CHUNK = 200;
const IN_CHUNK = 30;
const GET_ALL_CHUNK = 200;
const CLEAR_VALUE = "[清空]";
const MODES = ["create", "update", "delete"] as const;

type BatchMode = (typeof MODES)[number];
type MatchBy = "studentId" | "nationalId";
type BatchFields = Partial<Record<StudentPersonalInfoFieldKey, string>>;
type BatchRowAction = BatchMode | "skip";

interface ParsedRow {
  row: number;
  matchBy: MatchBy | null;
  key: string;
  referenceName: string;
  fields: BatchFields;
  error: string;
}

interface PreviewRow {
  row: number;
  action: BatchRowAction;
  label: string;
  reason?: string;
}

interface RowPlan {
  input: ParsedRow;
  action: BatchRowAction;
  reason: string;
  uid?: string;
  termRef?: FirebaseFirestore.DocumentReference;
  termData?: FirebaseFirestore.DocumentData;
  identityData?: FirebaseFirestore.DocumentData;
  identityFallback?: StudentPersonalIdentityFields;
  termPatch?: Partial<Record<string, string>>;
  identityPatch?: Partial<StudentPersonalIdentityFields>;
}

const IDENTITY_KEYS = new Set<string>(STUDENT_PERSONAL_IDENTITY_KEYS);
const FIELD_DEFS = STUDENT_PERSONAL_INFO_FIELD_DEFS;
const FIELD_KEYS = new Set<string>(FIELD_DEFS.map(({ key }) => key));
const HEADER_ALIASES: Partial<Record<StudentPersonalInfoFieldKey, string[]>> = {
  gender: ["性別"],
  birthday: ["生日", "出生日期"],
  idType: ["證件類型", "身分證類型"],
  nationalId: ["證件號碼", "身分證", "身分證字號", "統一證號", "nationalid"],
  householdPostalCode: ["戶籍郵遞區號", "戶籍郵區"],
  householdAddress: ["戶籍地址"],
  mailingPostalCode: ["通訊郵遞區號", "通訊郵區"],
  mailingAddress: ["通訊地址"],
  contactPhone: ["聯絡電話", "手機", "電話"],
  emergencyContactName: ["緊急聯絡人", "緊急聯絡人姓名"],
  emergencyContactPhone: ["緊急聯絡人電話", "緊急聯絡人手機"],
};

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[\s　_-]+/g, "");
}

function normalizeMatchKey(value: string, matchBy: MatchBy): string {
  const trimmed = value.trim();
  return matchBy === "nationalId" ? trimmed.toUpperCase() : trimmed;
}

function lookupIndexKey(matchBy: MatchBy, key: string): string {
  return `${matchBy}:${key}`;
}

function isClearValue(value: string): boolean {
  return value === CLEAR_VALUE || value === "【清空】";
}

function parseFieldValue(key: StudentPersonalInfoFieldKey, value: string): string {
  if (!value || isClearValue(value)) return value;
  if (key === "nationalId") return value.toUpperCase();
  if (key === "birthday") {
    const compactRocDate = value.match(/^(\d{2,3})(\d{2})(\d{2})$/);
    if (compactRocDate) {
      const [, rawYear, month, day] = compactRocDate;
      const year = Number(rawYear) + 1911;
      return `${String(year).padStart(4, "0")}-${month}-${day}`;
    }
    const separatedRocDate = value.match(/^(\d{2,3})[./-](\d{1,2})[./-](\d{1,2})$/);
    if (separatedRocDate) {
      const [, rawYear, rawMonth, rawDay] = separatedRocDate;
      const year = Number(rawYear) + 1911;
      return `${String(year).padStart(4, "0")}-${rawMonth.padStart(2, "0")}-${rawDay.padStart(2, "0")}`;
    }
  }
  if (key === "idType") {
    const normalized = normalizeHeader(value);
    if (normalized === "身分證" || normalized === "國民身分證" || normalized === "national") return "national";
    if (normalized === "居留證" || normalized === "resident") return "resident";
  }
  return value;
}

function parseSpreadsheet(buffer: Buffer, mode: BatchMode):
  | { rows: ParsedRow[] }
  | { error: string } {
  let dataRows: unknown[][];
  try {
    const workbook = XLSX.read(buffer, { type: "buffer", raw: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) return { error: "檔案內找不到工作表" };
    dataRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: false,
      blankrows: true,
    });
  } catch {
    return { error: "檔案無法讀取，請確認是 Excel 或 CSV 檔" };
  }

  if (dataRows.length < 2) return { error: "檔案需包含標題列與至少一筆資料" };
  const headers = dataRows[0].map((value) => String(value ?? "").trim());
  const headerMap = new Map<string, "studentId" | "matchNationalId" | "referenceName" | StudentPersonalInfoFieldKey>();
  for (const alias of ["辨識學號", "識別學號", "學號", "studentid", "student id"]) {
    headerMap.set(normalizeHeader(alias), "studentId");
  }
  for (const alias of ["姓名", "學生姓名", "name", "studentname"]) {
    headerMap.set(normalizeHeader(alias), "referenceName");
  }
  for (const alias of ["辨識身分證", "識別身分證", "辨識身分證統一編號", "matchnationalid"]) {
    headerMap.set(normalizeHeader(alias), "matchNationalId");
  }
  for (const { key, label } of FIELD_DEFS) {
    for (const alias of [key, label, ...(HEADER_ALIASES[key] ?? [])]) {
      headerMap.set(normalizeHeader(alias), key);
    }
  }

  const hasStudentIdHeader = headers.some((header) => headerMap.get(normalizeHeader(header)) === "studentId");
  const hasNationalIdHeader = headers.some((header) =>
    headerMap.get(normalizeHeader(header)) === "matchNationalId" || headerMap.get(normalizeHeader(header)) === "nationalId"
  );
  if (!hasStudentIdHeader && !hasNationalIdHeader) {
    return { error: "標題列需要「學號」或「證件號碼」欄位，請下載 Excel 範本。" };
  }
  if (mode !== "delete" && !headers.some((header) => FIELD_KEYS.has(String(headerMap.get(normalizeHeader(header)))))) {
    return { error: "匯入或修改檔案至少需包含一個個人資料欄位" };
  }

  const rows: ParsedRow[] = [];
  for (let rowIndex = 1; rowIndex < dataRows.length; rowIndex += 1) {
    const cells = dataRows[rowIndex];
    if (cells.every((value) => String(value ?? "").trim() === "")) continue;
    let studentId = "";
    let separateNationalIdKey = "";
    let referenceName = "";
    const fields: BatchFields = {};
    for (let column = 0; column < headers.length; column += 1) {
      const mapped = headerMap.get(normalizeHeader(headers[column]));
      if (!mapped) continue;
      const value = String(cells[column] ?? "").trim();
      if (mapped === "studentId") {
        studentId = value;
        continue;
      }
      if (mapped === "matchNationalId") {
        separateNationalIdKey = value;
        continue;
      }
      if (mapped === "referenceName") {
        referenceName = value;
        continue;
      }
      if (value) fields[mapped] = parseFieldValue(mapped, value);
    }
    const nationalIdKey = separateNationalIdKey || fields.nationalId || "";
    const matchBy: MatchBy | null = studentId ? "studentId" : nationalIdKey ? "nationalId" : null;
    const key = matchBy === "studentId" ? studentId : nationalIdKey;
    rows.push({
      row: rowIndex + 1,
      matchBy,
      key: matchBy ? normalizeMatchKey(key, matchBy) : "",
      referenceName,
      fields,
      error: matchBy ? "" : "缺少學號與證件號碼，無法辨識學生",
    });
  }

  if (rows.length === 0) return { error: "檔案沒有可處理的資料列" };
  if (rows.length > MAX_ROWS) return { error: `單次最多處理 ${MAX_ROWS} 列，請拆分檔案` };
  return { rows };
}

function duplicateKeys(rows: ParsedRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.key && row.matchBy && !row.error) {
      const key = lookupIndexKey(row.matchBy, row.key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function addMatch(index: Map<string, Set<string>>, key: string, uid: string) {
  if (!key || !uid) return;
  const matches = index.get(key) ?? new Set<string>();
  matches.add(uid);
  index.set(key, matches);
}

async function lookupStudents(
  rows: ParsedRow[],
  matchBy: MatchBy,
  period: SchoolPeriod
): Promise<{
  index: Map<string, Set<string>>;
  identities: Map<string, FirebaseFirestore.DocumentData>;
  names: Map<string, string>;
}> {
  const db = getAdminDb();
  const index = new Map<string, Set<string>>();
  const identities = new Map<string, FirebaseFirestore.DocumentData>();
  const names = new Map<string, string>();
  const keys = [...new Set(rows.filter((row) => !row.error).map((row) => row.key))];

  for (let offset = 0; offset < keys.length; offset += IN_CHUNK) {
    const chunk = keys.slice(offset, offset + IN_CHUNK);
    if (matchBy === "studentId") {
      const snapshot = await db.collection(rosterCollection("student"))
        .where("academicYear", "==", period.academicYear)
        .where("semester", "==", period.semester)
        .where("studentId", "in", chunk)
        .get();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.academicYear !== period.academicYear || data.semester !== period.semester) continue;
        const studentId = typeof data.studentId === "string" ? data.studentId.trim() : "";
        const uid = typeof data.uid === "string" ? data.uid : "";
        addMatch(index, studentId, uid);
        if (uid && typeof data.name === "string") names.set(uid, data.name.trim());
      }
      continue;
    }

    const identitySnapshot = await db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION)
      .where("nationalId", "in", chunk)
      .get();
    const identityKeysFound = new Set<string>();
    for (const doc of identitySnapshot.docs) {
      const data = doc.data();
      const nationalId = typeof data.nationalId === "string" ? data.nationalId.trim().toUpperCase() : "";
      const uid = typeof data.uid === "string" ? data.uid : doc.id;
      addMatch(index, nationalId, uid);
      if (nationalId) identityKeysFound.add(nationalId);
      if (uid) identities.set(uid, data);
    }

    // 僅為尚無固定身分文件的辨識值回查舊版學期文件，避免重讀已遷移學生的歷史資料。
    const legacyKeys = chunk.filter((key) => !identityKeysFound.has(key));
    for (const fieldPath of ["fields.nationalId", "nationalId"]) {
      if (legacyKeys.length === 0) continue;
      const legacySnapshot = await db.collection(PERSONAL_INFO_COLLECTION)
        .where(fieldPath, "in", legacyKeys)
        .get();
      for (const doc of legacySnapshot.docs) {
        const data = doc.data();
        const rawFields = data.fields && typeof data.fields === "object"
          ? data.fields as FirebaseFirestore.DocumentData
          : data;
        const nationalId = typeof rawFields.nationalId === "string"
          ? rawFields.nationalId.trim().toUpperCase()
          : "";
        const uid = typeof data.uid === "string" ? data.uid : "";
        addMatch(index, nationalId, uid);
      }
    }
  }

  if (matchBy === "nationalId") {
    const candidateUids = [...new Set([...index.values()].flatMap((uids) => [...uids]))];
    const eligibleUids = new Set<string>();
    for (let offset = 0; offset < candidateUids.length; offset += IN_CHUNK) {
      const snapshot = await db.collection(rosterCollection("student"))
        .where("academicYear", "==", period.academicYear)
        .where("semester", "==", period.semester)
        .where("uid", "in", candidateUids.slice(offset, offset + IN_CHUNK))
        .get();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (
          typeof data.uid === "string" &&
          data.academicYear === period.academicYear &&
          data.semester === period.semester
        ) {
          eligibleUids.add(data.uid);
          if (typeof data.name === "string") names.set(data.uid, data.name.trim());
        }
      }
    }
    for (const [key, uids] of index) {
      for (const uid of uids) {
        if (!eligibleUids.has(uid)) uids.delete(uid);
      }
      if (uids.size === 0) index.delete(key);
    }
  }

  return { index, identities, names };
}

async function lookupRows(
  rows: ParsedRow[],
  period: SchoolPeriod
): Promise<{
  index: Map<string, Set<string>>;
  identities: Map<string, FirebaseFirestore.DocumentData>;
  names: Map<string, string>;
}> {
  const studentRows = rows.filter((row) => row.matchBy === "studentId");
  const nationalIdRows = rows.filter((row) => row.matchBy === "nationalId");
  const empty: Awaited<ReturnType<typeof lookupStudents>> = {
    index: new Map(),
    identities: new Map(),
    names: new Map(),
  };
  const [studentLookup, nationalIdLookup] = await Promise.all([
    studentRows.length ? lookupStudents(studentRows, "studentId", period) : Promise.resolve(empty),
    nationalIdRows.length ? lookupStudents(nationalIdRows, "nationalId", period) : Promise.resolve(empty),
  ]);
  const index = new Map<string, Set<string>>();
  for (const [key, uids] of studentLookup.index) index.set(lookupIndexKey("studentId", key), uids);
  for (const [key, uids] of nationalIdLookup.index) index.set(lookupIndexKey("nationalId", key), uids);
  return {
    index,
    identities: nationalIdLookup.identities,
    names: new Map([...studentLookup.names, ...nationalIdLookup.names]),
  };
}

async function loadSnapshots(
  db: FirebaseFirestore.Firestore,
  refs: FirebaseFirestore.DocumentReference[]
): Promise<Map<string, FirebaseFirestore.DocumentData>> {
  const data = new Map<string, FirebaseFirestore.DocumentData>();
  for (let offset = 0; offset < refs.length; offset += GET_ALL_CHUNK) {
    const docs = await db.getAll(...refs.slice(offset, offset + GET_ALL_CHUNK));
    for (const doc of docs) {
      if (doc.exists) data.set(doc.id, doc.data() ?? {});
    }
  }
  return data;
}

async function loadLegacyIdentityFallbacks(
  db: FirebaseFirestore.Firestore,
  uids: string[]
): Promise<Map<string, StudentPersonalIdentityFields>> {
  const byUid = new Map<string, FirebaseFirestore.DocumentData[]>();
  for (let offset = 0; offset < uids.length; offset += IN_CHUNK) {
    const snapshot = await db.collection(PERSONAL_INFO_COLLECTION)
      .where("uid", "in", uids.slice(offset, offset + IN_CHUNK))
      .get();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (typeof data.uid !== "string" || !uids.includes(data.uid)) continue;
      const entries = byUid.get(data.uid) ?? [];
      entries.push(data);
      byUid.set(data.uid, entries);
    }
  }

  const result = new Map<string, StudentPersonalIdentityFields>();
  for (const [uid, entries] of byUid) {
    entries.sort((a, b) =>
      Number(b.academicYear ?? 0) - Number(a.academicYear ?? 0) ||
      Number(b.semester ?? 0) - Number(a.semester ?? 0)
    );
    const fields: StudentPersonalIdentityFields = { gender: "", birthday: "", idType: "", nationalId: "" };
    for (const entry of entries) {
      const legacy = readStudentPersonalIdentityFields(entry);
      for (const key of STUDENT_PERSONAL_IDENTITY_KEYS) {
        if (!fields[key] && legacy[key]) fields[key] = legacy[key];
      }
    }
    result.set(uid, fields);
  }
  return result;
}

async function loadNationalIdOwners(
  db: FirebaseFirestore.Firestore,
  nationalIds: string[]
): Promise<Map<string, Set<string>>> {
  const owners = new Map<string, Set<string>>();
  const addOwner = (nationalId: unknown, uid: unknown) => {
    if (typeof nationalId !== "string" || typeof uid !== "string" || !uid) return;
    const key = nationalId.trim().toUpperCase();
    if (!key) return;
    const matches = owners.get(key) ?? new Set<string>();
    matches.add(uid);
    owners.set(key, matches);
  };

  for (let offset = 0; offset < nationalIds.length; offset += IN_CHUNK) {
    const chunk = nationalIds.slice(offset, offset + IN_CHUNK);
    const identitySnapshot = await db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION)
      .where("nationalId", "in", chunk)
      .get();
    const identityIdsFound = new Set<string>();
    for (const doc of identitySnapshot.docs) {
      const data = doc.data();
      addOwner(data.nationalId, typeof data.uid === "string" ? data.uid : doc.id);
      if (typeof data.nationalId === "string") identityIdsFound.add(data.nationalId.trim().toUpperCase());
    }
    const legacyKeys = chunk.filter((nationalId) => !identityIdsFound.has(nationalId));
    for (const fieldPath of ["fields.nationalId", "nationalId"]) {
      if (legacyKeys.length === 0) continue;
      const legacySnapshot = await db.collection(PERSONAL_INFO_COLLECTION)
        .where(fieldPath, "in", legacyKeys)
        .get();
      for (const doc of legacySnapshot.docs) {
        const data = doc.data();
        const fields = data.fields && typeof data.fields === "object"
          ? data.fields as FirebaseFirestore.DocumentData
          : data;
        addOwner(fields.nationalId, data.uid);
      }
    }
  }
  return owners;
}

function validateFields(
  fields: BatchFields,
  currentIdentity: StudentPersonalIdentityFields
): string {
  for (const { key, maxLength } of FIELD_DEFS) {
    const value = fields[key];
    if (value === undefined || isClearValue(value)) continue;
    if (value.length > maxLength) return `${FIELD_DEFS.find((field) => field.key === key)?.label ?? key}超過 ${maxLength} 字`;
    if (key === "gender" && value && !["男", "女"].includes(value)) return "性別欄僅接受「男」或「女」";
    if (key === "idType" && value && value !== "national" && value !== "resident") return "證件類型請填國民身分證或居留證";
    if (key === "birthday" && value && !isIsoDate(value)) return "生日格式需為 YYYY-MM-DD";
    if ((key === "householdPostalCode" || key === "mailingPostalCode") && value && !/^\d{3,6}$/.test(value)) {
      return `${key === "householdPostalCode" ? "戶籍郵區" : "通訊郵區"}需為 3 至 6 位數字`;
    }
  }

  if (fields.nationalId === undefined && fields.idType === undefined) return "";
  const nationalId = fields.nationalId === undefined
    ? currentIdentity.nationalId
    : isClearValue(fields.nationalId)
      ? ""
      : fields.nationalId;
  const idType = fields.idType === undefined
    ? currentIdentity.idType
    : isClearValue(fields.idType)
      ? ""
      : fields.idType;
  if (nationalId) {
    if (!idType) return "保留或新增身分證時，必須同時保留或提供證件類型";
    const validation = validateStudentPersonalId(idType, nationalId);
    if (!validation.ok) return validation.message;
  }
  return "";
}

function rowHasData(fields: BatchFields): boolean {
  return Object.keys(fields).length > 0;
}

async function buildPlans(
  rows: ParsedRow[],
  mode: BatchMode,
  period: SchoolPeriod,
  duplicates: Set<string>
): Promise<RowPlan[]> {
  const db = getAdminDb();
  const lookup = await lookupRows(
    rows.filter((row) => !row.error && row.matchBy && !duplicates.has(lookupIndexKey(row.matchBy, row.key))),
    period
  );
  const uidCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.error || !row.matchBy || duplicates.has(lookupIndexKey(row.matchBy, row.key))) continue;
    const matches = lookup.index.get(lookupIndexKey(row.matchBy, row.key));
    if (!matches || matches.size !== 1) continue;
    const uid = [...matches][0];
    uidCounts.set(uid, (uidCounts.get(uid) ?? 0) + 1);
  }
  const duplicateUids = new Set([...uidCounts].filter(([, count]) => count > 1).map(([uid]) => uid));
  const uniqueUids = [...new Set(rows
    .filter((row) => !row.error && row.matchBy && !duplicates.has(lookupIndexKey(row.matchBy, row.key)))
    .flatMap((row) => [...(lookup.index.get(lookupIndexKey(row.matchBy!, row.key)) ?? [])])
    .filter((uid) => !duplicateUids.has(uid)))];
  const termRefs = uniqueUids.map((uid) =>
    db.collection(PERSONAL_INFO_COLLECTION).doc(`${uid}_${period.academicYear}_${period.semester}`)
  );
  const terms = await loadSnapshots(db, termRefs);

  const identityFieldsRequested = mode !== "delete" && rows.some((row) =>
    Object.keys(row.fields).some((key) => IDENTITY_KEYS.has(key))
  );
  const identityRequiredUids = new Set<string>();
  if (mode === "delete" || identityFieldsRequested) {
    for (const row of rows) {
      if (row.error || !row.matchBy || duplicates.has(lookupIndexKey(row.matchBy, row.key))) continue;
      if (mode !== "delete" && !Object.keys(row.fields).some((key) => IDENTITY_KEYS.has(key))) continue;
      const matches = lookup.index.get(lookupIndexKey(row.matchBy, row.key));
      if (matches?.size === 1 && !duplicateUids.has([...matches][0])) {
        identityRequiredUids.add([...matches][0]);
      }
    }
  }
  const identities = new Map<string, FirebaseFirestore.DocumentData>(lookup.identities);
  if (identityRequiredUids.size > 0) {
    const missingIdentityRefs = [...identityRequiredUids]
      .filter((uid) => !identities.has(uid))
      .map((uid) => db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION).doc(uid));
    for (const [uid, data] of await loadSnapshots(db, missingIdentityRefs)) identities.set(uid, data);
  }

  const missingIdentityUids = [...identityRequiredUids].filter((uid) => !identities.has(uid));
  const legacyFallbacks = missingIdentityUids.length > 0
    ? await loadLegacyIdentityFallbacks(db, missingIdentityUids)
    : new Map<string, StudentPersonalIdentityFields>();
  const proposedIdsByUid = new Map<string, Set<string>>();
  if (mode !== "delete") {
    for (const input of rows) {
      const proposedId = input.fields.nationalId;
      if (!proposedId || isClearValue(proposedId) || input.error || !input.matchBy || duplicates.has(lookupIndexKey(input.matchBy, input.key))) continue;
      const matches = lookup.index.get(lookupIndexKey(input.matchBy, input.key));
      if (!matches || matches.size !== 1) continue;
      const uid = [...matches][0];
      if (duplicateUids.has(uid)) continue;
      const termRefId = `${uid}_${period.academicYear}_${period.semester}`;
      const hasTermRecord = terms.has(termRefId);
      if ((mode === "create" && hasTermRecord) || (mode === "update" && !hasTermRecord)) continue;
      const identityData = identities.get(uid);
      const identity = identityData
        ? readStudentPersonalIdentityFields(identityData)
        : legacyFallbacks.get(uid) ?? { gender: "", birthday: "", idType: "", nationalId: "" };
      if (validateFields(input.fields, identity)) continue;
      const uids = proposedIdsByUid.get(proposedId) ?? new Set<string>();
      uids.add(uid);
      proposedIdsByUid.set(proposedId, uids);
    }
  }
  const proposedNationalIds = [...proposedIdsByUid.keys()];
  const duplicateNationalIds = new Set(
    [...proposedIdsByUid].filter(([, uids]) => uids.size > 1).map(([nationalId]) => nationalId)
  );
  const nationalIdOwners = mode !== "delete" && proposedNationalIds.length > 0
    ? await loadNationalIdOwners(db, proposedNationalIds)
    : new Map<string, Set<string>>();

  return rows.map((input) => {
    if (input.error) return { input, action: "skip", reason: input.error };
    if (!input.matchBy) return { input, action: "skip", reason: "缺少學號與證件號碼，無法辨識學生" };
    if (duplicates.has(lookupIndexKey(input.matchBy, input.key))) {
      return { input, action: "skip", reason: "檔案內辨識欄位重複" };
    }
    const matches = lookup.index.get(lookupIndexKey(input.matchBy, input.key));
    if (!matches || matches.size === 0) {
      return {
        input,
        action: "skip",
        reason: input.matchBy === "studentId"
          ? "選定學年度學期的學生名冊中找不到此學號"
          : "找不到此證件號碼對應的學生",
      };
    }
    if (matches.size > 1) return { input, action: "skip", reason: "辨識欄位對應到多位學生，請先修正重複資料" };
    const uid = [...matches][0];
    if (duplicateUids.has(uid)) return { input, action: "skip", reason: "檔案內多列指向同一位學生" };
    const rosterName = lookup.names.get(uid);
    if (input.referenceName && rosterName && input.referenceName !== rosterName) {
      return { input, action: "skip", reason: "姓名與選定學年度學期學生名冊不符" };
    }
    const termRef = db.collection(PERSONAL_INFO_COLLECTION).doc(`${uid}_${period.academicYear}_${period.semester}`);
    const termData = terms.get(termRef.id);
    const exists = Boolean(termData);

    if (mode === "create" && exists) return { input, action: "skip", reason: "本期資料已存在" };
    if (mode === "update" && !exists) return { input, action: "skip", reason: "本期資料不存在，無法修改" };
    if (mode === "delete" && !exists) return { input, action: "skip", reason: "本期資料不存在，無法刪除" };
    if (mode !== "delete" && !rowHasData(input.fields)) return { input, action: "skip", reason: "沒有提供要寫入的資料欄位" };

    const identityData = identities.get(uid);
    const identity = identityData
      ? readStudentPersonalIdentityFields(identityData)
      : legacyFallbacks.get(uid) ?? { gender: "", birthday: "", idType: "", nationalId: "" };
    const validationError = mode === "delete" ? "" : validateFields(input.fields, identity);
    if (validationError) return { input, action: "skip", reason: validationError };
    const proposedNationalId = input.fields.nationalId;
    if (mode !== "delete" && proposedNationalId && !isClearValue(proposedNationalId)) {
      if (duplicateNationalIds.has(proposedNationalId)) {
        return { input, action: "skip", reason: "檔案內身分證統一編號重複" };
      }
      if ([...(nationalIdOwners.get(proposedNationalId) ?? [])].some((ownerUid) => ownerUid !== uid)) {
        return { input, action: "skip", reason: "身分證統一編號已登記於其他學生" };
      }
    }

    const termPatch: Partial<Record<string, string>> = {};
    const identityPatch: Partial<StudentPersonalIdentityFields> = {};
    for (const [key, rawValue] of Object.entries(input.fields)) {
      if (!FIELD_KEYS.has(key) || rawValue === undefined) continue;
      const value = isClearValue(rawValue) ? "" : rawValue;
      if (IDENTITY_KEYS.has(key)) identityPatch[key as keyof StudentPersonalIdentityFields] = value;
      else termPatch[key] = value;
    }

    return {
      input,
      action: mode,
      reason: "",
      uid,
      termRef,
      termData,
      identityData,
      identityFallback: legacyFallbacks.get(uid),
      identityPatch,
      termPatch,
    };
  });
}

function summarize(plans: RowPlan[]) {
  const rows: PreviewRow[] = plans.map(({ input, action, reason }) => {
    const parts: string[] = [];
    if (input.matchBy === "studentId" && input.key) parts.push(input.key);
    else if (input.matchBy === "nationalId" && input.key) parts.push(input.key);
    if (input.referenceName) parts.push(input.referenceName);
    return {
      row: input.row,
      action,
      label: parts.join(" ") || `第 ${input.row} 列`,
      ...(reason ? { reason } : {}),
    };
  });
  return {
    created: rows.filter((row) => row.action === "create").length,
    updated: rows.filter((row) => row.action === "update").length,
    deleted: rows.filter((row) => row.action === "delete").length,
    skipped: rows.filter((row) => row.action === "skip").length,
    total: rows.length,
    rows,
  };
}

async function getTemplateResponse() {
  const { denial } = await requireRole("admin");
  if (denial) return toAuthResponse(denial);
  const headers = [
    "學號",
    "姓名",
    "性別",
    "生日",
    "證件類型",
    "證件號碼",
    "戶籍郵區",
    "戶籍地址",
    "通訊郵區",
    "通訊地址",
    "聯絡電話",
    "緊急聯絡人（姓名）",
    "緊急聯絡人電話",
    "標題不可刪除",
  ];
  const examples = [
    ["910998", "A同學", "女", "0990101", "身分證", "A123456789", "970", "菁華街2號", "970", "菁華街2號", "0922415546", "A媽媽", "0922415546", ""],
    ["910999", "B同學", "男", "0991010", "居留證", "U900000001", "970", "菁華街2號", "970", "菁華街2號", "0922415546", "B爸爸", "0922415546", ""],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers]), "匯入資料");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...examples]), "範例資料");
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
  const bytes = new Uint8Array(buffer);
  return new NextResponse(bytes, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("學生個人資料範本.xlsx")}`,
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get("template") === "1") return await getTemplateResponse();
    const limited = enforceRateLimit(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_GET.limit,
      RATE.FEATURE_MODULES_GET.windowMs
    );
    if (limited) return limited;
    const { denial } = await requireRole("admin");
    if (denial) return toAuthResponse(denial);
    return noStoreJson({ success: true, period: await getCurrentPeriod() });
  } catch (error) {
    console.error("Get student personal info batch settings error:", error);
    return noStoreJson({ success: false, message: serverErrorMessage(error, "讀取目前學年度學期失敗") }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;
    const limited = enforceRateLimit(request, "feature-modules", RATE.FEATURE_MODULES_MUTATE.limit, RATE.FEATURE_MODULES_MUTATE.windowMs);
    if (limited) return limited;
    const { session, denial } = await requireRole("admin");
    if (denial) return toAuthResponse(denial);

    const bodyTooLarge = assertBodySize(request, DEFAULT_FORM_BODY_BYTES);
    if (bodyTooLarge) return bodyTooLarge;

    const formData = await request.formData().catch(() => null);
    if (!formData) return noStoreJson({ success: false, message: "請求內容無效" }, 400);
    const modeRaw = formData.get("mode");
    const mode = typeof modeRaw === "string" && MODES.includes(modeRaw as BatchMode)
      ? modeRaw as BatchMode
      : null;
    const academicYear = Number(formData.get("academicYear"));
    const semester = Number(formData.get("semester"));
    const dryRun = formData.get("dryRun") === "true";
    const offset = Number(formData.get("offset") ?? 0);
    if (!mode) return noStoreJson({ success: false, message: "批次作業模式無效" }, 400);
    if (!Number.isInteger(academicYear) || academicYear <= 0 || academicYear > 999 || (semester !== 1 && semester !== 2)) {
      return noStoreJson({ success: false, message: "請選擇有效的學年度與學期" }, 400);
    }
    if (!Number.isInteger(offset) || offset < 0) return noStoreJson({ success: false, message: "批次位置無效" }, 400);

    const file = formData.get("file");
    if (!file || typeof file === "string") return noStoreJson({ success: false, message: "請選擇要上傳的檔案" }, 400);
    if (file.size > MAX_FILE_BYTES) return noStoreJson({ success: false, message: "檔案超過 5 MB，請拆分檔案" }, 400);
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return noStoreJson({ success: false, message: "僅支援 Excel 或 CSV 檔案" }, 400);

    const parsed = parseSpreadsheet(Buffer.from(await file.arrayBuffer()), mode);
    if ("error" in parsed) return noStoreJson({ success: false, message: parsed.error }, 400);
    const period: SchoolPeriod = { academicYear, semester };
    const duplicates = duplicateKeys(parsed.rows);
    const chunkRows = dryRun
      ? parsed.rows
      : parsed.rows.slice(offset, offset + WRITE_CHUNK);
    const plans = await buildPlans(chunkRows, mode, period, duplicates);

    if (dryRun) return noStoreJson({ success: true, preview: summarize(plans) });

    const actionable = plans.filter((plan) => plan.action !== "skip");
    const db = getAdminDb();
    const writeBatch = db.batch();
    const photoPaths: string[] = [];
    for (const plan of actionable) {
      if (!plan.uid || !plan.termRef) continue;
      if (plan.action === "delete") {
        if (plan.termData) photoPaths.push(...personalPhotoObjectPathsForRecord(plan.uid, period, plan.termData));
        if (
          !plan.identityData &&
          plan.identityFallback &&
          Object.values(plan.identityFallback).some(Boolean)
        ) {
          writeBatch.create(db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION).doc(plan.uid), {
            uid: plan.uid,
            ...plan.identityFallback,
            updatedAt: Date.now(),
          });
        }
        writeBatch.delete(plan.termRef);
        continue;
      }

      const now = Date.now();
      if (plan.action === "create") {
        writeBatch.create(plan.termRef, {
          uid: plan.uid,
          academicYear,
          semester,
          fields: plan.termPatch ?? {},
          updatedAt: now,
        });
      } else if (plan.action === "update" && Object.keys(plan.termPatch ?? {}).length > 0) {
        const update: Record<string, unknown> = { updatedAt: now };
        for (const [key, value] of Object.entries(plan.termPatch ?? {})) update[`fields.${key}`] = value;
        writeBatch.update(plan.termRef, update);
      }

      if (plan.identityPatch && Object.keys(plan.identityPatch).length > 0) {
        const identityRef = db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION).doc(plan.uid);
        const identityExists = Boolean(plan.identityData);
        const base = identityExists
          ? {}
          : plan.identityFallback ?? { gender: "", birthday: "", idType: "", nationalId: "" };
        writeBatch.set(identityRef, {
          uid: plan.uid,
          ...base,
          ...plan.identityPatch,
          updatedAt: now,
        }, { merge: true });
      }
    }

    if (actionable.length > 0) {
      await writeBatch.commit();
      if (photoPaths.length > 0) await deleteStudentPersonalPhotoObjects(photoPaths);
      await invalidateAdminListCache();
      const counts = summarize(plans);
      const label = mode === "create" ? "匯入" : mode === "update" ? "修改" : "刪除";
      await logActivity({
        userId: session.uid,
        role: "admin",
        action: "student_personal_info_batch_updated",
        ip: getClientIp(request),
        details: `${academicYear} 學年度第 ${semester} 學期學生個人資料批次${label}：新增 ${counts.created} 筆、修改 ${counts.updated} 筆、刪除 ${counts.deleted} 筆、略過 ${counts.skipped} 筆`,
      });
    }

    const counts = summarize(plans);
    return noStoreJson({
      success: true,
      message: "批次學生個人資料作業完成",
      result: {
        created: counts.created,
        updated: counts.updated,
        deleted: counts.deleted,
        skipped: counts.skipped,
        skippedRows: counts.rows.filter((row) => row.action === "skip"),
      },
      cacheEpoch: actionable.length > 0 ? await getCacheEpoch() : undefined,
      progress: {
        processed: Math.min(offset + chunkRows.length, parsed.rows.length),
        total: parsed.rows.length,
        done: offset + chunkRows.length >= parsed.rows.length,
      },
    });
  } catch (error) {
    console.error("Student personal info batch error:", error);
    return noStoreJson({ success: false, message: serverErrorMessage(error, "批次學生個人資料作業失敗") }, 500);
  }
}
