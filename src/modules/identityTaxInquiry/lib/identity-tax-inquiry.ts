import "server-only";
import { getAdminDb } from "@/lib/firebase-admin";
import { getCacheTtlSeconds, getCurrentPeriod } from "@/lib/settings-server";
import type { SchoolPeriod } from "@/types/settings";
import { isActiveEntry } from "@/lib/roster";
import { cachedRead, invalidateReadCache } from "@/lib/read-cache";
import { rosterCollection } from "@/types/roster";
import {
  DEFAULT_IDENTITY_TAX_INQUIRY_SETTINGS,
  NOTE_MAX,
  PERSONAL_DATA_CONSENT_VERSION,
  RECORDS_COLLECTION,
  SETTINGS_COLLECTION,
  SETTINGS_DOC_ID,
  TAX_INQUIRY_STATUS_LABELS,
  TAX_SUBJECT_LABELS,
  buildStats,
  formatDateTime,
  maskIdNumber,
  needsTaxInquiry,
  normalizeSettings,
  periodLabelOf,
  selectionsFromLabels,
  summarizeSelections,
  type IdentitySelection,
  type IdentityTaxInquiryRecord,
  type IdentityTaxInquirySettings,
  type InquiryRow,
  type InquiryStats,
  type RecordInput,
  type TaxInquiryStatus,
  type TaxInquiryState,
  type TaxSubject,
} from "../types/identity-tax-inquiry";

const CACHE_PREFIX = "identityTaxInquiry:";

async function ttlMs(): Promise<number> {
  return (await getCacheTtlSeconds()) * 1000;
}

function settingsRef() {
  return getAdminDb().collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC_ID);
}

function recordsRef() {
  return getAdminDb().collection(RECORDS_COLLECTION);
}

export function recordDocId(period: string, studentUid: string): string {
  return `${period}_${studentUid}`;
}

/** 讀設定（缺檔即建預設值：lazy init） */
export async function getSettings(): Promise<IdentityTaxInquirySettings> {
  return cachedRead(`${CACHE_PREFIX}settings`, await ttlMs(), async () => {
    const snap = await settingsRef().get();
    if (!snap.exists) {
      const initial = { ...DEFAULT_IDENTITY_TAX_INQUIRY_SETTINGS, updatedAt: Date.now() };
      await settingsRef().set(initial);
      return initial;
    }
    return normalizeSettings(snap.data());
  });
}

/** 存設定（合併寫入＋失效快取） */
export async function saveSettings(
  value: IdentityTaxInquirySettings
): Promise<IdentityTaxInquirySettings> {
  const next: IdentityTaxInquirySettings = { ...value, updatedAt: Date.now() };
  await settingsRef().set(next, { merge: true });
  invalidateReadCache(CACHE_PREFIX);
  return next;
}

function emptyTaxInquiry(required: boolean): TaxInquiryState {
  return {
    required,
    status: required ? "pending" : "none",
    note: "",
    updatedBy: "",
    updatedByName: "",
    updatedAt: 0,
  };
}

function readTaxInquiry(raw: unknown, required: boolean): TaxInquiryState {
  const fallback = emptyTaxInquiry(required);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const data = raw as Record<string, unknown>;
  const status: TaxInquiryStatus =
    data.status === "pending" || data.status === "done" || data.status === "exempt"
      ? data.status
      : required
        ? "pending"
        : "none";
  return {
    required: data.required === true || required,
    status,
    note: typeof data.note === "string" ? data.note.slice(0, NOTE_MAX) : "",
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : "",
    updatedByName: typeof data.updatedByName === "string" ? data.updatedByName : "",
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
}

function readParent(raw: unknown): { idNumber: string } {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    idNumber: typeof data.idNumber === "string" ? data.idNumber.slice(0, 10).toUpperCase() : "",
  };
}

function readSelection(raw: unknown): IdentitySelection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const label = typeof data.label === "string" ? data.label.slice(0, 40) : "";
  if (!label) return null;
  const values: Record<string, string[]> = {};
  if (data.values && typeof data.values === "object" && !Array.isArray(data.values)) {
    for (const [key, value] of Object.entries(data.values as Record<string, unknown>)) {
      const list = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string").slice(0, 30)
        : [];
      if (list.length > 0) values[key] = list;
    }
  }
  return {
    optionId: typeof data.optionId === "string" ? data.optionId.slice(0, 64) : label,
    label,
    values,
  };
}

function readRecord(id: string, raw: Record<string, unknown>): IdentityTaxInquiryRecord {
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const identities = Array.isArray(raw.identities)
    ? raw.identities.filter((item): item is string => typeof item === "string").slice(0, 20)
    : [];
  const identitySelections = Array.isArray(raw.identitySelections)
    ? raw.identitySelections
        .map((item) => readSelection(item))
        .filter((item): item is IdentitySelection => item !== null)
        .slice(0, 40)
    : identities.map((label) => ({ optionId: label, label, values: {} }));
  const taxSubject: TaxSubject =
    raw.taxSubject === "one"
      ? "one"
      : raw.taxSubject === "self"
        ? "self"
        : raw.taxSubject === "guardian"
          ? "guardian"
          : "both";
  const status = raw.status === "confirmed" ? "confirmed" : "draft";
  const consent = raw.personalDataConsent;
  const personalDataConsent =
    consent && typeof consent === "object" &&
    "version" in consent && typeof consent.version === "string" &&
    "agreedAt" in consent && typeof consent.agreedAt === "number" &&
    Number.isFinite(consent.agreedAt) && consent.agreedAt > 0
      ? { version: consent.version, agreedAt: consent.agreedAt }
      : null;
  return {
    id,
    period: str(raw.period),
    studentUid: str(raw.studentUid),
    studentName: str(raw.studentName),
    grade: str(raw.grade),
    classCode: str(raw.classCode),
    className: str(raw.className),
    identities,
    identitySelections,
    taxSubject,
    father: readParent(raw.father),
    mother: readParent(raw.mother),
    self: readParent(raw.self),
    guardian: readParent(raw.guardian),
    note: typeof raw.note === "string" ? raw.note.slice(0, NOTE_MAX) : "",
    status,
    confirmedAt: typeof raw.confirmedAt === "number" && raw.confirmedAt > 0 ? raw.confirmedAt : null,
    personalDataConsent,
    taxInquiry: readTaxInquiry(raw.taxInquiry, false),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

export async function getRecord(
  period: string,
  studentUid: string
): Promise<IdentityTaxInquiryRecord | null> {
  const snap = await recordsRef().doc(recordDocId(period, studentUid)).get();
  if (!snap.exists) return null;
  return readRecord(snap.id, (snap.data() || {}) as Record<string, unknown>);
}

export type SaveRecordResult =
  | { ok: true; record: IdentityTaxInquiryRecord }
  | { ok: false; status: 400 | 403 | 409; message: string };

/** 學生儲存草稿或送出確認（僅在開放期間內可寫） */
export async function saveStudentRecord(input: {
  period: string;
  student: { uid: string; name: string; grade: string; classCode: string; className: string };
  value: RecordInput;
  confirm: boolean;
  settings: IdentityTaxInquirySettings;
  now?: number;
}): Promise<SaveRecordResult> {
  const now = input.now ?? Date.now();
  if (input.confirm && input.value.personalDataConsentVersion !== PERSONAL_DATA_CONSENT_VERSION) {
    return { ok: false, status: 400, message: "請閱讀並同意本次個人資料授權後再送出確認" };
  }
  const { openAt, closeAt } = input.settings;
  if (openAt === null) return { ok: false, status: 409, message: "學校尚未設定確認期間" };
  if (now < openAt) return { ok: false, status: 409, message: "尚未到確認期間" };
  if (closeAt !== null && now > closeAt) {
    return { ok: false, status: 409, message: "已超過確認期間，無法修改" };
  }

  const id = recordDocId(input.period, input.student.uid);
  const existing = await getRecord(input.period, input.student.uid);
  const required = needsTaxInquiry(input.value.identitySelections, input.settings);
  const previousTax = existing?.taxInquiry;

  let taxInquiry: TaxInquiryState;
  if (required) {
    taxInquiry = previousTax
      ? { ...previousTax, required: true, status: previousTax.status === "none" ? "pending" : previousTax.status }
      : emptyTaxInquiry(true);
  } else {
    taxInquiry = previousTax
      ? { ...previousTax, required: false, status: "none", note: "", updatedBy: "", updatedByName: "", updatedAt: 0 }
      : emptyTaxInquiry(false);
  }

  const record: IdentityTaxInquiryRecord = {
    id,
    period: input.period,
    studentUid: input.student.uid,
    studentName: input.student.name,
    grade: input.student.grade,
    classCode: input.student.classCode,
    className: input.student.className,
    identities: input.value.identities,
    identitySelections: input.value.identitySelections,
    taxSubject: input.value.taxSubject,
    father: input.value.father,
    mother: input.value.mother,
    self: input.value.self,
    guardian: input.value.guardian,
    note: input.value.note,
    status: input.confirm ? "confirmed" : "draft",
    confirmedAt: input.confirm ? now : existing?.confirmedAt ?? null,
    personalDataConsent: input.confirm
      ? { version: PERSONAL_DATA_CONSENT_VERSION, agreedAt: now }
      : null,
    taxInquiry,
    updatedAt: now,
  };

  // 替換完整紀錄，避免 merge 保留舊版查調對象的 name 欄位。
  await recordsRef().doc(id).set(record);
  invalidateReadCache(CACHE_PREFIX);
  return { ok: true, record };
}

export type UpdateTaxInquiryResult =
  | { ok: true; record: IdentityTaxInquiryRecord }
  | { ok: false; status: 403 | 404 | 409; message: string };

/** 教職員更新財稅查調狀態（scopeClassCode 有值＝只限該班） */
export async function updateTaxInquiry(input: {
  period: string;
  studentUid: string;
  status: Exclude<TaxInquiryStatus, "none">;
  note: string;
  staffUid: string;
  staffName: string;
  scopeClassCode?: string | null;
  now?: number;
}): Promise<UpdateTaxInquiryResult> {
  const now = input.now ?? Date.now();
  const record = await getRecord(input.period, input.studentUid);
  if (!record) return { ok: false, status: 404, message: "查無此學生的確認紀錄" };
  if (input.scopeClassCode && record.classCode !== input.scopeClassCode) {
    return { ok: false, status: 403, message: "此學生不在你的班級範圍內" };
  }
  if (record.status !== "confirmed") {
    return { ok: false, status: 409, message: "學生尚未送出確認，無法更新查調狀態" };
  }
  const next: IdentityTaxInquiryRecord = {
    ...record,
    taxInquiry: {
      required: record.taxInquiry.required,
      status: input.status,
      note: input.note.slice(0, NOTE_MAX),
      updatedBy: input.staffUid,
      updatedByName: input.staffName,
      updatedAt: now,
    },
    updatedAt: now,
  };
  await recordsRef().doc(record.id).set({ taxInquiry: next.taxInquiry, updatedAt: now }, { merge: true });
  invalidateReadCache(CACHE_PREFIX);
  return { ok: true, record: next };
}

/** 讀本學期已有確認紀錄（可依班級過濾） */
export async function listRecords(
  period: string,
  classCode?: string
): Promise<IdentityTaxInquiryRecord[]> {
  const key = `${CACHE_PREFIX}records:${period}:${classCode ?? "all"}`;
  return cachedRead(key, await ttlMs(), async () => {
    let query = recordsRef().where("period", "==", period);
    if (classCode) query = query.where("classCode", "==", classCode);
    const snap = await query.limit(classCode ? 200 : 1000).get();
    return snap.docs
      .map((doc) => readRecord(doc.id, (doc.data() || {}) as Record<string, unknown>))
      .sort((a, b) => a.studentName.localeCompare(b.studentName, "zh-Hant"));
  });
}

interface RosterStudent {
  uid: string;
  name: string;
  studentId: string;
  seatNo: string;
  grade: string;
  classCode: string;
  className: string;
}

/** 讀當期某班有效學生（過濾下推：學年＋學期＋班級） */
export async function loadClassStudents(
  period: SchoolPeriod,
  classCode: string
): Promise<RosterStudent[]> {
  const key = `${CACHE_PREFIX}roster:${period.academicYear}-${period.semester}:${classCode}`;
  return cachedRead(key, await ttlMs(), async () => {
    const snap = await getAdminDb()
      .collection(rosterCollection("student"))
      .where("academicYear", "==", period.academicYear)
      .where("semester", "==", period.semester)
      .where("classCode", "==", classCode)
      .limit(200)
      .get();
    const students: RosterStudent[] = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      if (!isActiveEntry(data)) continue;
      const uid = typeof data.uid === "string" ? data.uid : "";
      if (!uid) continue;
      students.push({
        uid,
        name: typeof data.name === "string" ? data.name : "",
        studentId: typeof data.studentId === "string" ? data.studentId : "",
        seatNo: typeof data.seatNo === "string" ? data.seatNo : String(data.seatNo ?? ""),
        grade: typeof data.grade === "string" ? data.grade : "",
        classCode: typeof data.classCode === "string" ? data.classCode : "",
        className: typeof data.className === "string" ? data.className : classCode,
      });
    }
    students.sort((a, b) => {
      const aNo = Number(a.seatNo) || 0;
      const bNo = Number(b.seatNo) || 0;
      if (aNo !== bNo) return aNo - bNo;
      return a.name.localeCompare(b.name, "zh-Hant");
    });
    return students;
  });
}

/** 名冊＋確認紀錄合併（教職員／管理端名冊） */
export async function buildInquiryRows(input: {
  period: SchoolPeriod;
  classCode?: string;
}): Promise<InquiryRow[]> {
  const label = periodLabelOf(input.period);
  const [students, records] = await Promise.all([
    input.classCode ? loadClassStudents(input.period, input.classCode) : Promise.resolve([]),
    listRecords(label, input.classCode),
  ]);
  const byUid = new Map(records.map((record) => [record.studentUid, record]));
  const rows: InquiryRow[] = [];
  const seen = new Set<string>();

  for (const student of students) {
    const record = byUid.get(student.uid) ?? null;
    seen.add(student.uid);
    rows.push({
      studentUid: student.uid,
      studentName: student.name,
      studentId: student.studentId,
      seatNo: student.seatNo,
      grade: student.grade,
      classCode: student.classCode,
      className: student.className,
      status: record?.status ?? "missing",
      identities: record?.identities ?? [],
      identitySelections: record?.identitySelections ?? [],
      taxSubject: record?.taxSubject ?? "both",
      taxInquiry: record?.taxInquiry ?? emptyTaxInquiry(false),
      father: record?.father ?? { idNumber: "" },
      mother: record?.mother ?? { idNumber: "" },
      self: record?.self ?? { idNumber: "" },
      guardian: record?.guardian ?? { idNumber: "" },
      note: record?.note ?? "",
      confirmedAt: record?.confirmedAt ?? null,
      updatedAt: record?.updatedAt ?? 0,
    });
  }
  // 沒有班級名冊（例如彙整全部）時，至少列出已有紀錄的學生
  for (const record of records) {
    if (seen.has(record.studentUid)) continue;
    rows.push({
      studentUid: record.studentUid,
      studentName: record.studentName,
      studentId: "",
      seatNo: "",
      grade: record.grade,
      classCode: record.classCode,
      className: record.className,
      status: record.status,
      identities: record.identities,
      identitySelections: record.identitySelections,
      taxSubject: record.taxSubject,
      taxInquiry: record.taxInquiry,
      father: record.father,
      mother: record.mother,
      self: record.self,
      guardian: record.guardian,
      note: record.note,
      confirmedAt: record.confirmedAt,
      updatedAt: record.updatedAt,
    });
  }
  return rows;
}

export function statsOf(rows: InquiryRow[]): InquiryStats {
  return buildStats(rows);
}

function csvCell(value: string): string {
  const text = value.replace(/"/g, '""');
  return /[",\n\r]/.test(text) ? `"${text}"` : text;
}

/** 匯出查調名冊 CSV（不含 BOM，由 route 加上） */
export function buildInquiryCsv(rows: InquiryRow[], includeIdNumbers: boolean): string {
  const header = [
    "班級",
    "學號",
    "座號",
    "姓名",
    "註冊身分",
    "確認狀態",
    "財稅查調",
    "查調對象",
    "父身分證",
    "母身分證",
    "本人身分證",
    "監護人身分證",
    "備註",
    "確認時間",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const statusLabel =
      row.status === "missing" ? "未填寫" : row.status === "draft" ? "草稿" : "已確認";
    const identityText =
      summarizeSelections(row.identitySelections) || row.identities.join("、");
    lines.push(
      [
        row.className || row.classCode,
        row.studentId,
        row.seatNo,
        row.studentName,
        identityText,
        statusLabel,
        TAX_INQUIRY_STATUS_LABELS[row.taxInquiry.status],
        TAX_SUBJECT_LABELS[row.taxSubject],
        includeIdNumbers ? row.father.idNumber : maskIdNumber(row.father.idNumber),
        includeIdNumbers ? row.mother.idNumber : maskIdNumber(row.mother.idNumber),
        includeIdNumbers ? row.self.idNumber : maskIdNumber(row.self.idNumber),
        includeIdNumbers ? row.guardian.idNumber : maskIdNumber(row.guardian.idNumber),
        row.note,
        formatDateTime(row.confirmedAt),
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

/** 家長端：身分證字號一律遮蔽 */
export function maskRecordForParent(
  record: IdentityTaxInquiryRecord
): IdentityTaxInquiryRecord {
  return {
    ...record,
    father: { ...record.father, idNumber: maskIdNumber(record.father.idNumber) },
    mother: { ...record.mother, idNumber: maskIdNumber(record.mother.idNumber) },
    self: { ...record.self, idNumber: maskIdNumber(record.self.idNumber) },
    guardian: { ...record.guardian, idNumber: maskIdNumber(record.guardian.idNumber) },
  };
}

export interface LinkedChild {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  className: string;
}

/** 家長→子女：以名冊學號＋當期學年學期等值下推，唯一有效匹配才回傳 */
export async function linkedChildForParent(
  parentEntry: Record<string, unknown>
): Promise<LinkedChild | null> {
  const studentId = typeof parentEntry.studentId === "string" ? parentEntry.studentId.trim() : "";
  if (!studentId) return null;
  const expectedGrade = typeof parentEntry.grade === "string" ? parentEntry.grade.trim() : "";
  const expectedClass =
    typeof parentEntry.classCode === "string" ? parentEntry.classCode.trim() : "";
  const period = await getCurrentPeriod();
  const snapshot = await getAdminDb()
    .collection(rosterCollection("student"))
    .where("studentId", "==", studentId)
    .where("academicYear", "==", period.academicYear)
    .where("semester", "==", period.semester)
    .get();

  const matches: LinkedChild[] = [];
  for (const doc of snapshot.docs) {
    const entry = doc.data();
    if (!isActiveEntry(entry)) continue;
    const uid = typeof entry.uid === "string" ? entry.uid : "";
    const grade = typeof entry.grade === "string" ? entry.grade.trim() : "";
    const classCode = typeof entry.classCode === "string" ? entry.classCode.trim() : "";
    if (!uid || (expectedGrade && grade !== expectedGrade) || (expectedClass && classCode !== expectedClass)) {
      continue;
    }
    matches.push({
      uid,
      name: typeof entry.name === "string" ? entry.name : "",
      grade,
      classCode,
      className: typeof entry.className === "string" ? entry.className : classCode,
    });
  }
  return matches.length === 1 ? matches[0] : null;
}
