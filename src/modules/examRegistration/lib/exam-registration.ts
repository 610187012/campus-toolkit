import "server-only";
import * as XLSX from "xlsx";
import { getAdminDb } from "@/lib/firebase-admin";
import { cachedRead, invalidateReadCache } from "@/lib/read-cache";
import { cachedListRead, invalidateAdminListCache } from "@/lib/list-cache";
import { getCurrentPeriod, getCacheTtlSeconds } from "@/lib/settings-server";
import { isActiveEntry, loadPeriodEntries } from "@/lib/roster";
import type { SchoolPeriod } from "@/types/settings";
import { logActivity } from "@/lib/audit";
import { publishFromModule } from "@/lib/announcements";
import { publishScheduleFromModule } from "@/lib/calendar";
import { schoolWideAudience } from "@/types/announcements";
import {
  PERSONAL_INFO_COLLECTION,
  STUDENT_PERSONAL_IDENTITY_COLLECTION,
  readStudentPersonalIdentityFields,
} from "@/types/personal-info";
import type { UserRole } from "@/types/users";
import { rosterCollection } from "@/types/roster";
import {
  ACADEMIC_ABILITY_EXAM_OFFICIAL_HEADERS,
  EXAM_EVENT_STATUS_LABELS,
  EXAM_FEE_CODE_LABELS,
  EXAM_ROSTER_EXPORT_SCOPE_LABELS,
  HIGH_SCHOOL_ENGLISH_LISTENING_EXAM_OFFICIAL_HEADERS,
  SUBJECT_APTITUDE_EXAM_OFFICIAL_HEADERS,
  UNIVERSITY_ARTS_EXAM_OFFICIAL_HEADERS,
  academicAbilityExamSubjectFlags,
  subjectAptitudeExamSubjectFlags,
  buildExamRegistrationCsv,
  calcExamFee,
  canTransitionExamStatus,
  combineUniversityArtsExamOfficialFields,
  composeExamRegistrationNumber,
  effectiveExamStatus,
  examEventToDraft,
  formatExamDateRange,
  formatExamRosterDateTime,
  getUniversityArtsExamGroup,
  genericOfficialExamHeaders,
  genericOfficialExamSubjectValues,
  isAcademicAbilityExamTitle,
  isExamCategory,
  isExamEventType,
  isExamFeeCode,
  isExamOpen,
  isExamRegistrationMode,
  isExamReviewStatus,
  isHighSchoolEnglishListeningExamTitle,
  isSubjectAptitudeExamTitle,
  isTargetMatch,
  parseExamEventDraft,
  parseSubjectKeys,
  pickValidSubjectKeys,
  resolveLocationLabel,
  universityArtsExamOfficialFields,
  EXAM_SERVICE_NOTE_MAX,
  OPT_OUT_REASON_MAX,
} from "../types/exam-registration";
import type {
  ExamAnnouncementSync,
  ExamAdvancedOption,
  ExamCalendarSync,
  ExamClassRoster,
  ExamClassTabs,
  ExamEvent,
  ExamEventDraft,
  ExamEventRoster,
  ExamRegistration,
  ExamRegistrationNumberField,
  ExamRosterExportScope,
  ExamRosterStudent,
  ExamRosterSummary,
  StudentExamEvent,
  UniversityArtsExamGroup,
} from "../types/exam-registration";

export const EXAM_EVENTS_COLLECTION = "examEvents";
export const EXAM_REGISTRATIONS_COLLECTION = "examRegistrations";

const ADMIN_EVENT_LIST_KEY = "admin:exam-registration:events";
const ADMIN_ROSTER_KEY_PREFIX = "admin:exam-registration:roster:";
const STUDENT_CACHE_PREFIX = "exam-registration:";
const STUDENT_EVENT_CACHE_KEY = `${STUDENT_CACHE_PREFIX}events:visible`;
/**
 * 快取壽命統一讀系統設定（settings.cacheTtlSeconds，30–300 秒）：
 * 學生寫入只清本程序模組前綴（不 bump epoch），跨實例新鮮度以設定 TTL 為上限。
 * 取代過去寫死 30 秒——管理端可於「系統設定→省錢專區」調整。
 */
async function cacheTtlMs(): Promise<number> {
  return (await getCacheTtlSeconds()) * 1000;
}
const ADMIN_EVENT_LIST_LIMIT = 200;
const ROSTER_LIMIT = 1000;

/** API 可直接對應 HTTP 狀態的模組錯誤 */
export class ExamRegistrationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ExamRegistrationError";
    this.status = status;
  }
}

export interface StudentIdentity {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  /** 學號（名冊有才帶；CSV 造冊用） */
  studentId?: string;
  /** 座號（名冊有才帶） */
  seatNo?: string;
  /** 班級名稱（名冊有才帶） */
  className?: string;
  /** 班號（名冊有才帶） */
  rollNo?: string;
}

export interface Actor {
  uid: string;
  name: string;
  role: UserRole;
}

export interface ExamEventWriteResult {
  events: ExamEvent[];
  epoch: number;
}

export function registrationDocId(eventId: string, studentUid: string): string {
  return `${eventId}__${studentUid}`;
}

export function readExamEvent(id: string, raw: Record<string, unknown>): ExamEvent {
  const legacyAdvancedOptions = readAdvancedOptions(raw.advancedOptions);
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    examType: isExamCategory(raw.examType) ? raw.examType : "other",
    examDate: typeof raw.examDate === "string" ? raw.examDate : "",
    examEndDate: typeof raw.examEndDate === "string" ? raw.examEndDate : "",
    location: typeof raw.location === "string" ? raw.location : "",
    locationOptions: readLocationOptions(raw.locationOptions),
    note: typeof raw.note === "string" ? raw.note : "",
    deadline: typeof raw.deadline === "number" ? raw.deadline : 0,
    registrationOpenAt:
      typeof raw.registrationOpenAt === "number" && Number.isFinite(raw.registrationOpenAt) && raw.registrationOpenAt > 0
        ? raw.registrationOpenAt
        : 0,
    subjects: Array.isArray(raw.subjects)
      ? raw.subjects.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const record = item as Record<string, unknown>;
          const key = typeof record.key === "string" ? record.key : "";
          const label = typeof record.label === "string" ? record.label : "";
          if (!key || !label) return [];
          const subjectAdvancedOptions = readAdvancedOptions(record.advancedOptions);
          const enableAdvancedOption = record.enableAdvancedOption === true || subjectAdvancedOptions.length > 0;
          const advancedOptions =
            subjectAdvancedOptions.length > 0
              ? subjectAdvancedOptions
              : enableAdvancedOption
                ? legacyAdvancedOptions
                : [];
          // 名額上限機制已廢止：舊資料的 capacity 欄位忽略不讀
          const feeStandard = readFee(record.feeStandard);
          const feeReduced = readFee(record.feeReduced);
          const entry: ExamEvent["subjects"][number] = { key, label };
          if (enableAdvancedOption) entry.enableAdvancedOption = true;
          if (enableAdvancedOption && advancedOptions.length) entry.advancedOptions = advancedOptions;
          if (feeStandard > 0) entry.feeStandard = feeStandard;
          if (feeReduced > 0) entry.feeReduced = feeReduced;
          return [entry];
        })
      : [],
    target: readTarget(raw.target),
    basicFee: readBasicFee(raw),
    examMode: "review",
    registrationMode: isExamRegistrationMode(raw.registrationMode) ? raw.registrationMode : "optional",
    // 舊場次未保存此設定，沿用原本允許學生封存的行為。
    studentArchiveEnabled:
      typeof raw.studentArchiveEnabled === "boolean" ? raw.studentArchiveEnabled : true,
    announcementSync: readAnnouncementSync(raw.announcementSync),
    calendarSync: readCalendarSync(raw.calendarSync),
    status: isExamEventType(raw.status) ? raw.status : "draft",
    createdBy: readActor(raw.createdBy),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function readAnnouncementSync(raw: unknown): ExamAnnouncementSync {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    categoryId: typeof record.categoryId === "string" && record.categoryId.trim() ? record.categoryId.trim() : "other",
    body: typeof record.body === "string" ? record.body.trim() : "",
  };
}

function readCalendarSync(raw: unknown): ExamCalendarSync {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    categoryId: typeof record.categoryId === "string" && record.categoryId.trim() ? record.categoryId.trim() : "other",
    publishUnit: typeof record.publishUnit === "string" ? record.publishUnit.trim() : "",
    location: typeof record.location === "string" ? record.location.trim() : "",
  };
}

/** 費用欄位（M1 舊資料只有單一 fee 欄位 → standard=fee、reduced=0 向後相容） */
function readFee(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** 地點選項（缺省 []；code/label 缺一即略過該項） */
function readLocationOptions(raw: unknown): ExamEvent["locationOptions"] {
  if (!Array.isArray(raw)) return [];
  const list: ExamEvent["locationOptions"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!code || !label) continue;
    list.push(record.isDefault === true ? { code, label, isDefault: true } : { code, label });
  }
  return list;
}

function readAdvancedOptions(raw: unknown): ExamAdvancedOption[] {
  if (!Array.isArray(raw)) return [];
  const list: ExamAdvancedOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!code || !label) continue;
    list.push({ code, label });
  }
  return list;
}

function readBasicFee(raw: Record<string, unknown>): { standard: number; reduced: number } {
  const record = (raw.basicFee && typeof raw.basicFee === "object" ? raw.basicFee : null) as
    | Record<string, unknown>
    | null;
  if (record) return { standard: readFee(record.standard), reduced: readFee(record.reduced) };
  const legacy = readFee(raw.fee);
  return { standard: legacy, reduced: 0 };
}

export function readExamRegistration(
  id: string,
  raw: Record<string, unknown>
): ExamRegistration {
  return {
    id,
    eventId: typeof raw.eventId === "string" ? raw.eventId : "",
    studentUid: typeof raw.studentUid === "string" ? raw.studentUid : "",
    studentName: typeof raw.studentName === "string" ? raw.studentName : "",
    studentClass: typeof raw.studentClass === "string" ? raw.studentClass : "",
    studentGrade: typeof raw.studentGrade === "string" ? raw.studentGrade : "",
    studentId: typeof raw.studentId === "string" ? raw.studentId : "",
    studentClassName: typeof raw.studentClassName === "string" ? raw.studentClassName : "",
    studentRollNo: typeof raw.studentRollNo === "string" ? raw.studentRollNo : "",
    seatNo: typeof raw.seatNo === "string" ? raw.seatNo : "",
    subjectKeys: parseSubjectKeys(raw.subjectKeys),
    subjectAdvancedOptionCodes: readSubjectAdvancedOptionCodes(raw.subjectAdvancedOptionCodes),
    optOut: raw.optOut === true,
    optOutReason: typeof raw.optOutReason === "string" ? raw.optOutReason : "",
    locationCode: typeof raw.locationCode === "string" ? raw.locationCode : "",
    nonAirConditionedRoom: raw.nonAirConditionedRoom === true,
    examServiceNote: typeof raw.examServiceNote === "string" ? raw.examServiceNote : "",
    feeCode: isExamFeeCode(raw.feeCode) ? raw.feeCode : "1",
    feeAmount: typeof raw.feeAmount === "number" && Number.isFinite(raw.feeAmount) && raw.feeAmount > 0
      ? Math.floor(raw.feeAmount)
      : 0,
    archived: raw.archived === true,
    archivedAt: typeof raw.archivedAt === "number" ? raw.archivedAt : null,
    reviewStatus: isExamReviewStatus(raw.reviewStatus) ? raw.reviewStatus : "pending",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function readSubjectAdvancedOptionCodes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    const code = value.trim();
    if (!key || !code) continue;
    result[key] = code;
  }
  return result;
}

function readTarget(raw: unknown): { grades: string[]; classes: string[] } {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    grades: readStringArray(record.grades),
    classes: readStringArray(record.classes),
  };
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function readActor(raw: unknown): { uid: string; name: string } {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    uid: typeof record.uid === "string" ? record.uid : "",
    name: typeof record.name === "string" ? record.name : "",
  };
}

function readExamEventDraft(raw: unknown): ExamEventDraft {
  const parsed = parseExamEventDraft(raw);
  if (!parsed.ok) throw new ExamRegistrationError(400, parsed.message);
  return parsed.value;
}

/** 管理端寫入（場次增修刪、解除封存、硬刪登錄）：清全站讀取快取＋bump epoch（跨實例失效） */
async function invalidateExamRegistrationCaches(): Promise<void> {
  invalidateReadCache(STUDENT_CACHE_PREFIX);
  await invalidateAdminListCache();
}

/**
 * 學生端寫入（登錄／取消／封存，高頻）：只清本程序的模組前綴快取，
 * 不 bump epoch、不清全站（鐵律 6——高頻寫入不得打爆全站清單快取）。
 * 管理端名單快取 TTL 30 秒，跨實例延遲上限 30 秒。
 */
function invalidateStudentRegistrationCaches(): void {
  invalidateReadCache(STUDENT_CACHE_PREFIX);
  invalidateReadCache(ADMIN_ROSTER_KEY_PREFIX);
  invalidateReadCache(APPLICABLE_STUDENTS_KEY_PREFIX);
}

// —— 學生端 ——

/**
 * 學生可見場次（status ∈ open/closed）：快取壽命讀系統設定（預設 30 秒）。
 * 鐵律 6：非管理端寫入的快取，只 invalidateReadCache(前綴)、不 bump epoch。
 */
export async function listVisibleExamEvents(): Promise<ExamEvent[]> {
  return cachedRead(STUDENT_EVENT_CACHE_KEY, await cacheTtlMs(), async () => {
    const snap = await getAdminDb()
      .collection(EXAM_EVENTS_COLLECTION)
      .where("status", "in", ["open", "closed"])
      .get();
    const rows = snap.docs.map((doc) => readExamEvent(doc.id, doc.data()));
    rows.sort((a, b) => a.examDate.localeCompare(b.examDate) || a.createdAt - b.createdAt);
    return rows;
  });
}

/** 場次快取＋本人登錄 → 對象過濾在記憶體內完成（場次數量為個位數）。名額上限機制已廢止，不再聚合各科人數。 */
export async function listStudentExamEvents(student: StudentIdentity): Promise<StudentExamEvent[]> {
  const events = await listVisibleExamEvents();
  const visible = events.filter((event) => isTargetMatch(event.target, student));
  const snap = await getAdminDb()
    .collection(EXAM_REGISTRATIONS_COLLECTION)
    .where("studentUid", "==", student.uid)
    .get();
  const mine = new Map<string, ExamRegistration>();
  for (const doc of snap.docs) {
    const registration = readExamRegistration(doc.id, doc.data());
    mine.set(registration.eventId, registration);
  }
  const now = Date.now();
  return visible.map((event) => {
    const registration = mine.get(event.id);
    const effective = effectiveExamStatus(event, now);
    const { announcementSync: _announcementSync, calendarSync: _calendarSync, ...studentEvent } = event;
    void _announcementSync;
    void _calendarSync;
    return {
      ...studentEvent,
      status:
        effective === "open"
          ? ("open" as const)
          : effective === "upcoming"
            ? ("upcoming" as const)
            : ("closed" as const),
      mySubjectKeys: registration ? pickValidSubjectKeys(registration.subjectKeys, event.subjects) : [],
      mySubjectAdvancedOptionCodes: registration?.subjectAdvancedOptionCodes ?? {},
      registeredAt: registration ? registration.updatedAt : null,
      reviewStatus: registration ? registration.reviewStatus : null,
      myOptOut: registration?.optOut ?? false,
      myOptOutReason: registration?.optOutReason ?? "",
      myLocationCode: registration?.locationCode ?? "",
      myNonAirConditionedRoom: registration?.nonAirConditionedRoom ?? false,
      myExamServiceNote: registration?.examServiceNote ?? "",
      myFeeCode: registration ? registration.feeCode : null,
      myFeeAmount: registration ? (registration.optOut ? 0 : registration.feeAmount) : null,
      myArchived: registration?.archived ?? false,
    };
  });
}

/** 依家長名冊綁定的學號、年級、班級解析唯一有效子女；供家長唯讀查看報名資料。 */
export async function linkedStudentIdentityForParent(
  parentEntry: Record<string, unknown>
): Promise<StudentIdentity | null> {
  const studentId = typeof parentEntry.studentId === "string" ? parentEntry.studentId.trim() : "";
  if (!studentId) return null;
  const expectedGrade = typeof parentEntry.grade === "string" ? parentEntry.grade.trim() : "";
  const expectedClass = typeof parentEntry.classCode === "string" ? parentEntry.classCode.trim() : "";
  const period = await getCurrentPeriod();
  // 嚴格省流：以學號＋學期等值條件下推（1 筆查詢、≈1 讀），
  // 取代原先整期全校學生名冊全量讀取（≈全校人數讀/請求）。
  const snapshot = await getAdminDb()
    .collection(rosterCollection("student"))
    .where("studentId", "==", studentId)
    .where("academicYear", "==", period.academicYear)
    .where("semester", "==", period.semester)
    .get();
  const matches: StudentIdentity[] = [];

  for (const doc of snapshot.docs) {
    const entry = doc.data();
    if (!isActiveEntry(entry)) continue;
    const uid = typeof entry.uid === "string" ? entry.uid : "";
    const grade = typeof entry.grade === "string" ? entry.grade.trim() : "";
    const classCode = typeof entry.classCode === "string" ? entry.classCode.trim() : "";
    if (
      !uid ||
      (expectedGrade && grade !== expectedGrade) ||
      (expectedClass && classCode !== expectedClass)
    ) {
      continue;
    }
    const seatNo = typeof entry.seatNo === "string" ? entry.seatNo : "";
    matches.push({
      uid,
      name: typeof entry.name === "string" ? entry.name : "",
      grade,
      classCode,
      studentId,
      seatNo,
      className: typeof entry.className === "string" ? entry.className : classCode,
      rollNo: typeof entry.rollNo === "string" ? entry.rollNo : `${classCode}${seatNo}`,
    });
  }

  return matches.length === 1 ? matches[0] : null;
}

/** 點查（不存在＝0 讀）；學生與管理端共用 */
export async function getExamEvent(eventId: string): Promise<ExamEvent | null> {
  const snap = await getAdminDb().collection(EXAM_EVENTS_COLLECTION).doc(eventId).get();
  return snap.exists ? readExamEvent(snap.id, snap.data() ?? {}) : null;
}

/**
 * 登錄／修改（含不報名、繳費身分）：先驗場次、對象、科目（純計算），再 transaction upsert。
 * 文件 id ＝ `eventId__studentUid`（決定論），唯一性由文件 id 直接保證。
 * - optOut=true（僅 required 場次）：不報名，optOutReason 必填，subjectKeys 恆空、費用 0
 * - archived=true：凍結唯讀，upsert／取消一律 409（解除封存走管理端）
 */
export async function upsertExamRegistration(input: {
  eventId: string;
  student: StudentIdentity;
  subjectKeys: string[];
  /** 各科進階選項代碼（key=subject.key） */
  subjectAdvancedOptionCodes?: Record<string, unknown>;
  optOut?: boolean;
  optOutReason?: string;
  /** 所選地點代碼（場次有選項時驗證；空值取預設項） */
  locationCode?: string;
  /** 勾選非冷氣試場 */
  nonAirConditionedRoom?: boolean;
  /** 特殊應考服務需求 */
  examServiceNote?: string;
  feeCode?: string;
  ip?: string;
}): Promise<{ registration: ExamRegistration; created: boolean }> {
  const event = await getExamEvent(input.eventId);
  if (!event) throw new ExamRegistrationError(404, "找不到報名場次");
  assertEventAcceptingRegistration(event);
  if (!isTargetMatch(event.target, input.student)) {
    throw new ExamRegistrationError(403, "你不在本次報名對象內（年級／班級不符）");
  }

  const optOut = input.optOut === true;
  const optOutReason = typeof input.optOutReason === "string" ? input.optOutReason.trim() : "";
  const nonAirConditionedRoom = input.nonAirConditionedRoom === true;
  const examServiceNote = typeof input.examServiceNote === "string" ? input.examServiceNote.trim() : "";
  const feeCode = isExamFeeCode(input.feeCode) ? input.feeCode : "1";

  // 地點選項（僅場次有選項時要求；預設＝標記 isDefault 項、否則第一項）
  let locationCode = "";
  if (!optOut && event.locationOptions.length) {
    const requested = typeof input.locationCode === "string" ? input.locationCode.trim() : "";
    const fallback =
      event.locationOptions.find((option) => option.isDefault)?.code ?? event.locationOptions[0].code;
    const code = requested || fallback;
    if (!event.locationOptions.some((option) => option.code === code)) {
      throw new ExamRegistrationError(400, "所選考試地點無效，請重新整理後再試");
    }
    locationCode = code;
  }

  if (optOut) {
    if (event.registrationMode !== "required") {
      throw new ExamRegistrationError(400, "自由報名場次不需勾選不報名——不登錄即可");
    }
    if (!optOutReason) throw new ExamRegistrationError(400, "勾選不報名時，請說明原因");
    if (optOutReason.length > OPT_OUT_REASON_MAX) {
      throw new ExamRegistrationError(400, `不報名原因過長（最多 ${OPT_OUT_REASON_MAX} 字）`);
    }
  } else if (examServiceNote.length > EXAM_SERVICE_NOTE_MAX) {
    throw new ExamRegistrationError(400, `特殊應考服務需求過長（最多 ${EXAM_SERVICE_NOTE_MAX} 字）`);
  } else {
    const keys = parseSubjectKeys(input.subjectKeys);
    if (!keys.length) throw new ExamRegistrationError(400, "請至少勾選一個科目");
    const subjectKeys = pickValidSubjectKeys(keys, event.subjects);
    if (subjectKeys.length !== keys.length) {
      throw new ExamRegistrationError(400, "勾選的科目與本場次不符，請重新整理後再試");
    }
  }

  const subjectKeys = optOut ? [] : pickValidSubjectKeys(parseSubjectKeys(input.subjectKeys), event.subjects);
  const requestedAdvancedCodes =
    input.subjectAdvancedOptionCodes && typeof input.subjectAdvancedOptionCodes === "object"
      ? (input.subjectAdvancedOptionCodes as Record<string, unknown>)
      : {};
  const selectedKeySet = new Set(subjectKeys);
  const subjectAdvancedOptionCodes: Record<string, string> = {};
  if (!optOut) {
    for (const subject of event.subjects) {
      if (!selectedKeySet.has(subject.key)) continue;
      const options = subject.advancedOptions ?? [];
      const needAdvanced = subject.enableAdvancedOption === true && options.length > 0;
      if (!needAdvanced) continue;
      const codeRaw = requestedAdvancedCodes[subject.key];
      const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
      if (!code) {
        throw new ExamRegistrationError(400, `科目「${subject.label}」尚未選擇進階選項`);
      }
      if (!options.some((option) => option.code === code)) {
        throw new ExamRegistrationError(400, `科目「${subject.label}」的進階選項無效，請重新選擇`);
      }
      subjectAdvancedOptionCodes[subject.key] = code;
    }
    for (const [subjectKey, codeRaw] of Object.entries(requestedAdvancedCodes)) {
      const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
      if (!code) continue;
      if (!selectedKeySet.has(subjectKey)) {
        throw new ExamRegistrationError(400, "進階選項資料與已選科目不符，請重新整理後再試");
      }
    }
  }
  const feeAmount = optOut ? 0 : calcExamFee(event, subjectKeys, feeCode);

  const db = getAdminDb();
  const ref = db.collection(EXAM_REGISTRATIONS_COLLECTION).doc(registrationDocId(event.id, input.student.uid));
  const now = Date.now();
  const base = {
    eventId: event.id,
    studentUid: input.student.uid,
    studentName: input.student.name,
    studentGrade: input.student.grade,
    studentClass: input.student.classCode,
    studentId: input.student.studentId ?? "",
    studentClassName: input.student.className ?? "",
    studentRollNo: input.student.rollNo ?? "",
    seatNo: input.student.seatNo ?? "",
  };
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const record = {
      ...base,
      subjectKeys,
      subjectAdvancedOptionCodes: optOut ? {} : subjectAdvancedOptionCodes,
      optOut,
      optOutReason: optOut ? optOutReason : "",
      locationCode,
      nonAirConditionedRoom: optOut ? false : nonAirConditionedRoom,
      examServiceNote: optOut ? "" : examServiceNote,
      feeCode,
      feeAmount,
      archived: false,
      archivedAt: null,
    };
    if (snap.exists) {
      const previous = readExamRegistration(snap.id, snap.data() ?? {});
      if (previous.archived) {
        throw new ExamRegistrationError(409, "資料已封存，無法修改——請聯繫承辦解除封存");
      }
      tx.update(ref, { ...record, updatedAt: now });
      return {
        created: false,
        registration: { ...previous, ...record, updatedAt: now },
      };
    }
    const full = { ...record, reviewStatus: "pending" as const, createdAt: now, updatedAt: now };
    tx.set(ref, full);
    return {
      created: true,
      registration: { id: ref.id, ...full },
    };
  });

  invalidateStudentRegistrationCaches();
  await logActivity({
    userId: input.student.uid,
    role: "student",
    action: "exam_registration_recorded",
    ip: input.ip,
    details: optOut
      ? `勾選不報名（${event.title}，原因：${optOutReason}）`
      : `${result.created ? "登錄" : "修改"}報名（${event.title}，科目 ${subjectKeys.length} 項，${EXAM_FEE_CODE_LABELS[feeCode]}，費用 ${feeAmount} 元）`,
  });
  return result;
}

export async function withdrawExamRegistration(input: {
  eventId: string;
  studentUid: string;
  ip?: string;
}): Promise<{ eventId: string }> {
  const event = await getExamEvent(input.eventId);
  if (!event) throw new ExamRegistrationError(404, "找不到報名場次");
  assertEventAcceptingRegistration(event);

  const ref = getAdminDb()
    .collection(EXAM_REGISTRATIONS_COLLECTION)
    .doc(registrationDocId(event.id, input.studentUid));
  await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ExamRegistrationError(404, "你尚未登錄本場次");
    const existing = readExamRegistration(snap.id, snap.data() ?? {});
    if (existing.archived) throw new ExamRegistrationError(409, "資料已封存，無法取消——請聯繫承辦解除封存");
    tx.delete(ref);
  });

  invalidateStudentRegistrationCaches();
  await logActivity({
    userId: input.studentUid,
    role: "student",
    action: "exam_registration_withdrawn",
    ip: input.ip,
    details: `取消報名（${event.title}）`,
  });
  return { eventId: event.id };
}

/**
 * 學生自行封存（對齊原系統「資料封存」）：確認資料無誤後凍結唯讀，可下載報名表留存。
 * 已封存者再封存為 no-op（幂等）；無登錄不可封存。
 */
export async function archiveExamRegistration(input: {
  eventId: string;
  studentUid: string;
  ip?: string;
}): Promise<{ registration: ExamRegistration }> {
  const event = await getExamEvent(input.eventId);
  if (!event) throw new ExamRegistrationError(404, "找不到報名場次");
  if (event.status === "archived") throw new ExamRegistrationError(409, "場次已封存");
  if (!event.studentArchiveEnabled) {
    throw new ExamRegistrationError(403, "本場次未開放學生自行封存資料");
  }

  const ref = getAdminDb()
    .collection(EXAM_REGISTRATIONS_COLLECTION)
    .doc(registrationDocId(event.id, input.studentUid));
  const registration = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ExamRegistrationError(404, "你尚未登錄本場次");
    const previous = readExamRegistration(snap.id, snap.data() ?? {});
    if (previous.archived) return previous;
    const now = Date.now();
    tx.update(ref, { archived: true, archivedAt: now, updatedAt: now });
    return { ...previous, archived: true, archivedAt: now, updatedAt: now };
  });

  invalidateStudentRegistrationCaches();
  await logActivity({
    userId: input.studentUid,
    role: "student",
    action: "exam_registration_archived",
    ip: input.ip,
    details: `封存報名資料（${event.title}）`,
  });
  return { registration };
}

/** 承辦解除封存（對齊原系統 removeStudentArchive）：學生可重新修改 */
export async function unarchiveExamRegistration(input: {
  eventId: string;
  registrationId: string;
  actor: Actor;
  ip?: string;
}): Promise<{ registration: ExamRegistration }> {
  const event = await getExamEvent(input.eventId);
  if (!event) throw new ExamRegistrationError(404, "找不到報名場次");

  const ref = getAdminDb()
    .collection(EXAM_REGISTRATIONS_COLLECTION)
    .doc(registrationDocId(event.id, input.registrationId));
  const registration = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ExamRegistrationError(404, "查無此登錄資料");
    const previous = readExamRegistration(snap.id, snap.data() ?? {});
    if (!previous.archived) return previous;
    const now = Date.now();
    tx.update(ref, { archived: false, archivedAt: null, updatedAt: now });
    return { ...previous, archived: false, archivedAt: null, updatedAt: now };
  });

  await invalidateExamRegistrationCaches();
  await logActivity({
    userId: input.actor.uid,
    role: input.actor.role,
    action: "exam_registration_unarchived",
    ip: input.ip,
    details: `解除封存（${event.title}，${registration.studentName}）`,
  });
  return { registration };
}

export async function deleteExamRegistration(input: {
  eventId: string;
  registrationId: string;
  actor: Actor;
  ip?: string;
}): Promise<{ studentName: string }> {
  const event = await getExamEvent(input.eventId);
  if (!event) throw new ExamRegistrationError(404, "找不到報名場次");

  const ref = getAdminDb()
    .collection(EXAM_REGISTRATIONS_COLLECTION)
    .doc(registrationDocId(event.id, input.registrationId));
  const snap = await ref.get();
  if (!snap.exists) throw new ExamRegistrationError(404, "查無此登錄資料");
  const registration = readExamRegistration(snap.id, snap.data() ?? {});
  await ref.delete();

  await invalidateExamRegistrationCaches();
  await logActivity({
    userId: input.actor.uid,
    role: input.actor.role,
    action: "exam_registration_registration_deleted",
    ip: input.ip,
    details: `硬刪除登錄（${event.title}，${registration.studentName}）`,
  });
  return { studentName: registration.studentName };
}

function assertEventAcceptingRegistration(event: ExamEvent): void {
  if (isExamOpen(event)) return;
  if (event.status === "archived") throw new ExamRegistrationError(409, "場次已封存");
  if (event.status === "draft") throw new ExamRegistrationError(409, "場次尚未開放");
  if (effectiveExamStatus(event) === "upcoming") {
    throw new ExamRegistrationError(409, "報名尚未開放");
  }
  throw new ExamRegistrationError(409, "報名已截止");
}

// —— 管理端 ——

export async function listAdminExamEvents(): Promise<{ events: ExamEvent[]; epoch: number }> {
  const { data, epoch } = await cachedListRead(ADMIN_EVENT_LIST_KEY, async () => {
    const snap = await getAdminDb()
      .collection(EXAM_EVENTS_COLLECTION)
      .orderBy("examDate", "desc")
      .limit(ADMIN_EVENT_LIST_LIMIT)
      .get();
    const rows = snap.docs.map((doc) => readExamEvent(doc.id, doc.data()));
    rows.sort((a, b) => b.examDate.localeCompare(a.examDate) || b.updatedAt - a.updatedAt);
    return rows;
  });
  return { events: data, epoch };
}

export async function countAdminExamEvents(): Promise<number> {
  const snap = await getAdminDb().collection(EXAM_EVENTS_COLLECTION).count().get();
  return snap.data().count ?? 0;
}

export async function createExamEvent(
  input: unknown,
  actor: Actor,
  ip?: string
): Promise<ExamEventWriteResult> {
  const draft = readExamEventDraft(input);
  assertDraftDeadline(draft);

  const ref = getAdminDb().collection(EXAM_EVENTS_COLLECTION).doc();
  const now = Date.now();
  const record = {
    ...draft,
    createdBy: { uid: actor.uid, name: actor.name },
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(record);
  const event: ExamEvent = { id: ref.id, ...record };

  await invalidateExamRegistrationCaches();
  await syncExamEventHooks(event, actor, true);
  await logActivity({
    userId: actor.uid,
    role: actor.role,
    action: "exam_registration_event_created",
    ip,
    details: `建立報名場次（${event.title}，狀態=${EXAM_EVENT_STATUS_LABELS[event.status]}，對象=${describeTarget(event)}）`,
  });
  return listAdminExamEvents();
}

export async function updateExamEvent(
  eventId: string,
  patch: unknown,
  actor: Actor,
  ip?: string
): Promise<ExamEventWriteResult> {
  const event = await getExamEvent(eventId);
  if (!event) throw new ExamRegistrationError(404, "找不到報名場次");

  const record = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const draft = readExamEventDraft({ ...examEventToDraft(event), ...record });
  if (!canTransitionExamStatus(event.status, draft.status)) {
    throw new ExamRegistrationError(
      400,
      `狀態不可由「${EXAM_EVENT_STATUS_LABELS[event.status]}」變更為「${EXAM_EVENT_STATUS_LABELS[draft.status]}」`
    );
  }
  assertDraftDeadline(draft);

  const now = Date.now();
  await getAdminDb()
    .collection(EXAM_EVENTS_COLLECTION)
    .doc(eventId)
    .update({ ...draft, updatedAt: now });
  const updated: ExamEvent = { ...event, ...draft, updatedAt: now };

  await invalidateExamRegistrationCaches();
  if (draft.status === "open") {
    await syncExamEventHooks(updated, actor, event.status !== "open");
  }
  await logActivity({
    userId: actor.uid,
    role: actor.role,
    action: "exam_registration_event_updated",
    ip,
    details: `更新報名場次（${updated.title}，狀態 ${EXAM_EVENT_STATUS_LABELS[event.status]}→${
      EXAM_EVENT_STATUS_LABELS[draft.status]
    }，截止 ${formatDateTime(draft.deadline)}）`,
  });
  return listAdminExamEvents();
}

/**
 * 硬刪除場次：連同該場次全部登錄名單一併刪除（對齊 GAS `deletePipeAndSheet`——刪管道連同名單工作表）。
 * 已發佈的公告／行事曆無法自動撤回（宿主 P5 未落地），刪除前由 UI 確認框提醒。
 */
export async function deleteExamEvent(
  eventId: string,
  actor: Actor,
  ip?: string
): Promise<ExamEventWriteResult> {
  const event = await getExamEvent(eventId);
  if (!event) throw new ExamRegistrationError(404, "找不到報名場次");

  // 連動刪除該場次全部登錄（分批 transaction，每批 400 筆）
  const regCol = getAdminDb().collection(EXAM_REGISTRATIONS_COLLECTION);
  let deletedRegs = 0;
  for (;;) {
    const snap = await regCol.where("eventId", "==", eventId).limit(400).get();
    if (snap.empty) break;
    const batch = getAdminDb().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deletedRegs += snap.size;
    if (snap.size < 400) break;
  }

  await getAdminDb().collection(EXAM_EVENTS_COLLECTION).doc(eventId).delete();
  await invalidateExamRegistrationCaches();
  await logActivity({
    userId: actor.uid,
    role: actor.role,
    action: "exam_registration_event_deleted",
    ip,
    details: `刪除報名場次（${event.title}，狀態=${EXAM_EVENT_STATUS_LABELS[event.status]}${
      deletedRegs > 0 ? `，連同刪除 ${deletedRegs} 筆登錄` : "，無登錄"
    }）`,
  });
  return listAdminExamEvents();
}

/** 場次名單＋統計（同一次查詢，1 讀 ≈ 登錄人數；epoch 失效） */
export async function getExamEventRoster(eventId: string): Promise<ExamEventRoster | null> {
  const event = await getExamEvent(eventId);
  if (!event) return null;
  const { data, epoch } = await cachedListRead(
    `${ADMIN_ROSTER_KEY_PREFIX}${eventId}`,
    async () => {
      const [snap, applicableStudents] = await Promise.all([
        getAdminDb()
          .collection(EXAM_REGISTRATIONS_COLLECTION)
          .where("eventId", "==", eventId)
          .limit(ROSTER_LIMIT)
          .get(),
        loadApplicableStudentsCached(event),
      ]);
      const rows = snap.docs.map((doc) => readExamRegistration(doc.id, doc.data()));
      rows.sort(
        (a, b) =>
          a.studentClass.localeCompare(b.studentClass, "zh-Hant") ||
          a.seatNo.localeCompare(b.seatNo) ||
          a.studentName.localeCompare(b.studentName, "zh-Hant")
      );
      const students = buildRosterStudents(rows, applicableStudents);
      return { registrations: rows, students, summary: summarizeRoster(rows, event, applicableStudents.length, students) };
    },
    await cacheTtlMs()
  );
  return { eventId, event, ...data, epoch };
}

interface ApplicableStudent {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  studentId: string;
  className: string;
  seatNo: string;
  rollNo: string;
}

/** 以 `in` 查詢分塊讀取當期名冊條目（每批 10 值，Firestore `in` 上限） */
async function loadPeriodEntriesByInFilter(
  period: SchoolPeriod,
  role: Parameters<typeof rosterCollection>[0],
  field: "classCode" | "grade",
  values: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const base = getAdminDb()
    .collection(rosterCollection(role))
    .where("academicYear", "==", period.academicYear)
    .where("semester", "==", period.semester);
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += 10) {
    chunks.push(values.slice(i, i + 10));
  }
  const snapshots = await Promise.all(
    chunks.map((chunk) => base.where(field, "in", chunk).get())
  );
  const map = new Map<string, Record<string, unknown>>();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const uid = typeof data.uid === "string" ? data.uid : "";
      if (uid) map.set(uid, data);
    }
  }
  return map;
}

async function loadApplicableStudents(event: ExamEvent, classCode?: string): Promise<ApplicableStudent[]> {
  const period = await getCurrentPeriod();
  // 嚴格省流（過濾下推）：
  // - 指定單班 → classCode in [該班]
  // - 場次有指定班級 → classCode in [班級清單]
  // - 僅指定年級（無班級）→ grade in [年級清單]（回傳≈該年級人數，非全校）
  // - 年級與班級皆空 → 理論上不會發生（manifest 要求至少一個年級），退回整期讀取
  let entries: Map<string, Record<string, unknown>>;
  if (classCode !== undefined) {
    entries = await loadPeriodEntriesByInFilter(period, "student", "classCode", [classCode]);
  } else if (event.target.classes.length) {
    entries = await loadPeriodEntriesByInFilter(period, "student", "classCode", event.target.classes);
  } else if (event.target.grades.length) {
    entries = await loadPeriodEntriesByInFilter(period, "student", "grade", event.target.grades);
  } else {
    entries = await loadPeriodEntries(period, "student");
  }
  const students: ApplicableStudent[] = [];
  for (const [uid, entry] of entries) {
    if (!isActiveEntry(entry)) continue;
    const grade = typeof entry.grade === "string" ? entry.grade : "";
    const entryClassCode = typeof entry.classCode === "string" ? entry.classCode : "";
    if (!isTargetMatch(event.target, { grade, classCode: entryClassCode })) continue;
    students.push({
      uid,
      name: typeof entry.name === "string" ? entry.name : "",
      grade,
      classCode: entryClassCode,
      studentId: typeof entry.studentId === "string" ? entry.studentId : "",
      className: typeof entry.className === "string" ? entry.className : entryClassCode,
      seatNo: typeof entry.seatNo === "string" ? entry.seatNo : "",
      rollNo: typeof entry.rollNo === "string" ? entry.rollNo : "",
    });
  }
  return students;
}

const APPLICABLE_STUDENTS_KEY_PREFIX = "admin:exam-registration:applicable:";

/**
 * 場次應對象學生（含年級／班級下推）＋短 TTL 快取：
 * 班級分頁、統計面板、單班名冊共用同一份（同 TTL 內各端點只讀一次 Firestore）。
 * 學生寫入只清本前綴（不 bump epoch）——跨實例延遲上限＝TTL（系統設定 cacheTtlSeconds）。
 */
async function loadApplicableStudentsCached(event: ExamEvent): Promise<ApplicableStudent[]> {
  const { data } = await cachedListRead(
    `${APPLICABLE_STUDENTS_KEY_PREFIX}${event.id}`,
    () => loadApplicableStudents(event)
  );
  return data;
}

function buildRosterStudents(
  registrations: ExamRegistration[],
  applicableStudents: ApplicableStudent[]
): ExamRosterStudent[] {
  const regByUid = new Map(registrations.map((row) => [row.studentUid, row]));
  const seenUids = new Set<string>();
  const students: ExamRosterStudent[] = [];
  for (const student of applicableStudents) {
    seenUids.add(student.uid);
    const reg = regByUid.get(student.uid) ?? null;
    students.push({
      studentUid: student.uid,
      studentClass: student.classCode || reg?.studentClass || "",
      studentGrade: student.grade || reg?.studentGrade || "",
      studentName: student.name || reg?.studentName || "",
      seatNo: student.seatNo || reg?.seatNo || "",
      studentId: student.studentId || reg?.studentId || "",
      studentClassName: student.className || reg?.studentClassName || student.classCode,
      studentRollNo: student.rollNo || reg?.studentRollNo || `${student.classCode}${student.seatNo}`,
      status: reg ? (reg.optOut ? "opt_out" : "registered") : "pending",
      registration: reg,
    });
  }
  for (const reg of registrations) {
    if (seenUids.has(reg.studentUid)) continue;
    students.push({
      studentUid: reg.studentUid,
      studentClass: reg.studentClass,
      studentGrade: reg.studentGrade,
      studentName: reg.studentName,
      seatNo: reg.seatNo,
      studentId: reg.studentId,
      studentClassName: reg.studentClassName || reg.studentClass,
      studentRollNo: reg.studentRollNo || `${reg.studentClass}${reg.seatNo}`,
      status: reg.optOut ? "opt_out" : "registered",
      registration: reg,
    });
  }
  students.sort(
    (a, b) =>
      a.studentClass.localeCompare(b.studentClass, "zh-Hant", { numeric: true }) ||
      a.seatNo.localeCompare(b.seatNo, "zh-Hant", { numeric: true }) ||
      a.studentName.localeCompare(b.studentName, "zh-Hant")
  );
  return students;
}

// —— 延遲載入：班級分頁 / 單班名冊 ——

/** 班級分頁清單（不含登錄明細；應對象學生與統計面板共用快取） */
export async function getExamEventClassTabs(eventId: string): Promise<ExamClassTabs | null> {
  const event = await getExamEvent(eventId);
  if (!event) return null;
  const { data, epoch } = await cachedListRead(
    `${ADMIN_ROSTER_KEY_PREFIX}${eventId}:tabs`,
    async () => {
      const students = await loadApplicableStudentsCached(event);
      const byClass = new Map<string, number>();
      for (const student of students) {
        const code = student.classCode || "__no_class__";
        byClass.set(code, (byClass.get(code) ?? 0) + 1);
      }
      const classTabs = [...byClass.entries()]
        .map(([code, count]) => ({
          key: code,
          label: code === "__no_class__" ? "未填班級" : code,
          count,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hant", { numeric: true }));
      return { classTabs, applicableCount: students.length };
    }
  );
  return { eventId, event, ...data, epoch };
}

/**
 * 單班名冊（點選班級時才讀該班）——
 * 嚴格省流：名冊條目以 classCode 下推、登錄以 studentClass 下推，
 * 都只讀該班（各自 1 筆查詢），不載入其他班級資料。
 */
export async function getExamEventClassRoster(
  eventId: string,
  classCode: string
): Promise<ExamClassRoster | null> {
  const event = await getExamEvent(eventId);
  if (!event) return null;
  const key = classCode || "__no_class__";
  const normalizedClass = key === "__no_class__" ? "" : key;
  const { data, epoch } = await cachedListRead(
    `${ADMIN_ROSTER_KEY_PREFIX}${eventId}:class:${key}`,
    async () => {
      const [classStudents, snap] = await Promise.all([
        loadApplicableStudents(event, normalizedClass),
        getAdminDb()
          .collection(EXAM_REGISTRATIONS_COLLECTION)
          .where("eventId", "==", eventId)
          .where("studentClass", "==", normalizedClass)
          .limit(ROSTER_LIMIT)
          .get(),
      ]);
      const regs = snap.docs.map((doc) => readExamRegistration(doc.id, doc.data()));
      const students = buildRosterStudents(regs, classStudents);
      // 報名方式決定名單提供方式：
      // - 自由報名：只列出「完成報名」者（未完成／不報名不出現在名單）
      // - 必須報名：整班全部列出（含未完成／不報名，供對帳催辦）
      const visibleStudents =
        event.registrationMode === "optional"
          ? students.filter((student) => student.status === "registered")
          : students;
      let registeredCount = 0;
      let optOutCount = 0;
      let archivedCount = 0;
      for (const reg of regs) {
        if (reg.archived) archivedCount += 1;
        if (reg.optOut) optOutCount += 1;
        else registeredCount += 1;
      }
      return {
        students: visibleStudents,
        classSummary: { total: classStudents.length, registeredCount, optOutCount, archivedCount },
      };
    }
  );
  return { classCode: key, ...data, epoch };
}

export interface StaffClassExamRegistration {
  eventId: string;
  title: string;
  status: ExamEvent["status"];
  registrationOpenAt: number;
  deadline: number;
  registrationMode: "required" | "optional";
  students: Array<{
    name: string;
    seatNo: string;
    status: "pending" | "registered" | "opt_out";
    subjects: string[];
  }>;
}

export interface StaffClassExamRegistrationCounts {
  listCount: number;
  registeredCount: number;
}

interface StaffClassStudent {
  uid: string;
  grade: string;
  name: string;
  seatNo: string;
}

interface StaffClassExamContext {
  activeStudents: StaffClassStudent[];
  events: ExamEvent[];
}

function staffClassExamCacheKey(academicYear: number, semester: number, classCode: string): string {
  return `staff:exam-registration:${academicYear}:${semester}:${classCode}`;
}

/** 共用當期導師班級與可報名場次上下文，按 cacheEpoch 快取。 */
async function getStaffClassExamContext(classCode: string): Promise<{
  key: string;
  data: StaffClassExamContext;
}> {
  const normalizedClass = classCode.trim();
  if (!normalizedClass) return { key: "", data: { activeStudents: [], events: [] } };

  const period = await getCurrentPeriod();
  const key = staffClassExamCacheKey(period.academicYear, period.semester, normalizedClass);
  const { data } = await cachedListRead(`${key}:context`, async () => {
    const db = getAdminDb();
    const studentSnap = await db
      .collection(rosterCollection("student"))
      .where("academicYear", "==", period.academicYear)
      .where("semester", "==", period.semester)
      .where("classCode", "==", normalizedClass)
      .limit(ROSTER_LIMIT)
      .get();
    const activeStudents = studentSnap.docs.flatMap((doc) => {
      const entry = doc.data();
      const uid = typeof entry.uid === "string" ? entry.uid : "";
      if (!uid || !isActiveEntry(entry)) return [];
      return [{
        uid,
        grade: typeof entry.grade === "string" ? entry.grade : "",
        name: typeof entry.name === "string" ? entry.name : "",
        seatNo: typeof entry.seatNo === "string" ? entry.seatNo : "",
      }];
    });
    if (activeStudents.length === 0) return { activeStudents: [], events: [] };

    const eventSnap = await db
      .collection(EXAM_EVENTS_COLLECTION)
      .where("status", "in", ["draft", "open", "closed"])
      .limit(ADMIN_EVENT_LIST_LIMIT)
      .get();
    const grades = new Set(activeStudents.map((student) => student.grade).filter(Boolean));
    const events = eventSnap.docs
      .map((doc) => readExamEvent(doc.id, doc.data()))
      .filter((event) =>
        event.target.classes.length > 0
          ? event.target.classes.includes(normalizedClass)
          : [...grades].some((grade) => event.target.grades.includes(grade))
      );

    return {
      activeStudents,
      events,
    };
  });

  return { key, data };
}

function staffVisibleExamEvents(context: StaffClassExamContext): ExamEvent[] {
  return context.events.filter(
    (event) => event.status === "draft" || event.status === "open" || event.status === "closed"
  ).sort((a, b) => a.deadline - b.deadline);
}

function staffEventSummary(event: ExamEvent): StaffClassExamRegistration {
  return {
    eventId: event.id,
    title: event.title,
    status: event.status,
    registrationOpenAt: event.registrationOpenAt,
    deadline: event.deadline,
    registrationMode: event.registrationMode,
    students: [],
  };
}

/** 省流摘要：各場次以 count 聚合取得本班登錄總數，避免先讀取名單明細。 */
export async function countStaffClassExamRegistrations(
  classCode: string
): Promise<Record<string, StaffClassExamRegistrationCounts>> {
  const { key, data: context } = await getStaffClassExamContext(classCode);
  const events = staffVisibleExamEvents(context);
  if (!key || events.length === 0) return {};

  const counts = await Promise.all(
    events.map(async (event) => {
      const countUids = context.activeStudents.map((student) => student.uid);
      const uidChunks = Array.from(
        { length: Math.ceil(countUids.length / 30) },
        (_, index) => countUids.slice(index * 30, (index + 1) * 30)
      );
      const aggregateKey = `${key}:counts-by-mode:${event.id}`;
      const { data } = await cachedListRead(aggregateKey, async () => {
        const aggregateSnaps = await Promise.all(
          uidChunks.map(async (uids) => {
            const registrations = getAdminDb()
              .collection(EXAM_REGISTRATIONS_COLLECTION)
              .where("eventId", "==", event.id)
              .where("studentClass", "==", classCode.trim())
              .where("studentUid", "in", uids);
            const [all, optOut] = await Promise.all([
              registrations.count().get(),
              registrations.where("optOut", "==", true).count().get(),
            ]);
            return {
              registered: all.data().count ?? 0,
              optOut: optOut.data().count ?? 0,
            };
          })
        );
        return aggregateSnaps.reduce(
          (total, result) => ({
            registeredCount: total.registeredCount + result.registered - result.optOut,
          }),
          { registeredCount: 0 }
        );
      });
      const listCount =
        event.registrationMode === "required"
          ? context.activeStudents.length
          : data.registeredCount;
      return [event.id, { listCount, registeredCount: data.registeredCount }] as const;
    })
  );

  return Object.fromEntries(counts);
}

/** 教職員導師只取得當期本人班級的場次；省流時不載入名單資料。 */
export async function listStaffClassExamRegistrations(
  classCode: string,
  includeStudents = false,
  eventId?: string
): Promise<StaffClassExamRegistration[]> {
  const normalizedClass = classCode.trim();
  const { key, data: context } = await getStaffClassExamContext(normalizedClass);
  const events = staffVisibleExamEvents(context).filter((event) => !eventId || event.id === eventId);
  if (events.length === 0) return [];
  if (!includeStudents) return events.map(staffEventSummary);

  const eventIds = events.map((event) => event.id);
  const rosterKey = eventId ? `${key}:roster:${eventId}` : `${key}:roster:${eventIds.join(",")}`;
  const { data } = await cachedListRead(rosterKey, async () => {
    const db = getAdminDb();
    const activeStudentsByUid = new Map(context.activeStudents.map((student) => [student.uid, student]));
    const registrationSnaps = eventId
      ? [
          await db
            .collection(EXAM_REGISTRATIONS_COLLECTION)
            .where("eventId", "==", eventId)
            .where("studentClass", "==", normalizedClass)
            .limit(ROSTER_LIMIT)
            .get(),
        ]
      : await Promise.all(
          Array.from({ length: Math.ceil(eventIds.length / 30) }, (_, index) => {
            const ids = eventIds.slice(index * 30, (index + 1) * 30);
            return db
              .collection(EXAM_REGISTRATIONS_COLLECTION)
              .where("eventId", "in", ids)
              .where("studentClass", "==", normalizedClass)
              .limit(ROSTER_LIMIT)
              .get();
          })
        );
    const registrations = registrationSnaps
      .flatMap((snap) => snap.docs.map((doc) => readExamRegistration(doc.id, doc.data())))
      .filter((registration) => activeStudentsByUid.has(registration.studentUid));
    const registrationsByEvent = new Map<string, ExamRegistration[]>();
    for (const registration of registrations) {
      const rows = registrationsByEvent.get(registration.eventId) ?? [];
      rows.push(registration);
      registrationsByEvent.set(registration.eventId, rows);
    }

    return events
      .flatMap((event) => {
        const rows = registrationsByEvent.get(event.id) ?? [];
        const registrationByUid = new Map(rows.map((registration) => [registration.studentUid, registration]));
        if (event.registrationMode === "required") {
          const students = context.activeStudents
            .map((student) => {
              const registration = registrationByUid.get(student.uid);
              return {
                name: student.name || registration?.studentName || "",
                seatNo: student.seatNo || registration?.seatNo || "",
                status: registration ? (registration.optOut ? "opt_out" as const : "registered" as const) : "pending" as const,
                subjects: registration
                  ? registration.subjectKeys
                      .map((subjectKey) => event.subjects.find((subject) => subject.key === subjectKey)?.label)
                      .filter((label): label is string => Boolean(label))
                  : [],
              };
            })
            .sort(
              (a, b) =>
                a.seatNo.localeCompare(b.seatNo, "zh-Hant", { numeric: true }) ||
                a.name.localeCompare(b.name, "zh-Hant")
            );
          return [{ ...staffEventSummary(event), students }];
        }
        const completedRows = rows.filter((registration) => !registration.optOut);
        return [{
          ...staffEventSummary(event),
          students: completedRows
            .map((registration) => ({
              name: registration.studentName,
              seatNo: registration.seatNo,
              status: "registered" as const,
              subjects: registration.subjectKeys
                .map((key) => event.subjects.find((subject) => subject.key === key)?.label)
                .filter((label): label is string => Boolean(label)),
            }))
            .sort(
              (a, b) =>
                a.seatNo.localeCompare(b.seatNo, "zh-Hant", { numeric: true }) ||
                a.name.localeCompare(b.name, "zh-Hant")
            ),
        }];
      })
  });

  return data;
}

function summarizeRoster(
  rows: ExamRegistration[],
  event: ExamEvent,
  applicableCount: number,
  students: ExamRosterStudent[]
): ExamRosterSummary {
  const bySubject: ExamRosterSummary["bySubject"] = {};
  for (const subject of event.subjects) {
    bySubject[subject.key] = {
      label: subject.label,
      count: 0,
    };
  }
  const byClass: Record<string, number> = {};
  let registeredCount = 0;
  let optOutCount = 0;
  let archivedCount = 0;
  for (const row of rows) {
    if (row.archived) archivedCount += 1;
    if (row.optOut) {
      optOutCount += 1;
    } else {
      registeredCount += 1;
      for (const key of pickValidSubjectKeys(row.subjectKeys, event.subjects)) {
        const entry = bySubject[key];
        if (entry) entry.count += 1;
      }
    }
  }
  for (const student of students) {
    const code = student.studentClass || "__no_class__";
    byClass[code] = (byClass[code] ?? 0) + 1;
  }
  return { applicableCount, total: rows.length, registeredCount, optOutCount, archivedCount, bySubject, byClass };
}

/** 造冊 CSV：讀取名單後組 CSV（含 BOM）；內容直接回給管理端下載 */
export async function buildExamRegistrationCsvForEvent(
  eventId: string,
  classCode?: string
): Promise<{ filename: string; content: string } | null> {
  const roster = await getExamEventRoster(eventId);
  if (!roster) return null;
  const normalizedClassCode = classCode?.trim() ?? "";
  const rows = normalizedClassCode
    ? roster.registrations.filter((row) => row.studentClass === normalizedClassCode)
    : roster.registrations;
  const content = buildExamRegistrationCsv(
    rows,
    roster.event.subjects,
    roster.event.locationOptions
  );
  const safeTitle = roster.event.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  const classSuffix = normalizedClassCode ? `_${normalizedClassCode}` : "";
  return { filename: `造冊_${safeTitle || eventId}${classSuffix}.csv`, content };
}

interface ExamRosterExportRow {
  studentClass: string;
  studentGrade: string;
  studentId: string;
  studentClassName: string;
  studentRollNo: string;
  seatNo: string;
  studentName: string;
  registrationNo: string;
  statusLabel: string;
  subjectsLabel: string;
  optOutReason: string;
  feeLabel: string;
  feeAmount: string;
  locationLabel: string;
  archivedLabel: string;
  updatedLabel: string;
}

function registrationExportRow(
  row: ExamRegistration,
  event: ExamEvent,
  schoolExamCode: string,
  registrationNumberField: ExamRegistrationNumberField,
  rosterEntry?: Record<string, unknown>
): ExamRosterExportRow {
  const labelOf = new Map(event.subjects.map((subject) => [subject.key, subject.label]));
  const studentClass = rosterString(rosterEntry, "classCode") || row.studentClass;
  const studentGrade = rosterString(rosterEntry, "grade") || row.studentGrade;
  const studentId = rosterString(rosterEntry, "studentId") || row.studentId;
  const studentClassName = rosterString(rosterEntry, "className") || row.studentClassName || studentClass;
  const seatNo = rosterString(rosterEntry, "seatNo") || row.seatNo;
  const studentRollNo = rosterString(rosterEntry, "rollNo") || row.studentRollNo || `${studentClass}${seatNo}`;
  const fieldValue = registrationNumberFieldValue(registrationNumberField, {
    studentClass,
    studentGrade,
    studentId,
    studentClassName,
    studentRollNo,
    seatNo,
  });
  return {
    studentClass,
    studentGrade,
    studentId,
    studentClassName,
    studentRollNo,
    seatNo,
    studentName: row.studentName,
    registrationNo: composeExamRegistrationNumber(schoolExamCode, fieldValue),
    statusLabel: row.optOut ? "不報名" : "完成報名",
    subjectsLabel: row.optOut
      ? ""
      : pickValidSubjectKeys(row.subjectKeys, event.subjects)
          .map((key) => labelOf.get(key) ?? key)
          .join("、"),
    optOutReason: row.optOut ? row.optOutReason : "",
    feeLabel: row.optOut ? "" : EXAM_FEE_CODE_LABELS[row.feeCode] ?? row.feeCode,
    feeAmount: row.optOut ? "" : String(row.feeAmount),
    locationLabel: row.optOut ? "" : resolveLocationLabel(event.locationOptions, row.locationCode),
    archivedLabel: row.archived ? "已封存" : "",
    updatedLabel: formatExamRosterDateTime(row.updatedAt),
  };
}

/** 官方報名檔列排序：缺身分證者排最上方，其餘依報名序號由小到大（同號再依班級、座號）。 */
function compareOfficialExportRows(
  a: { nationalId: string; exportRow: ExamRosterExportRow },
  b: { nationalId: string; exportRow: ExamRosterExportRow }
): number {
  return (
    Number(Boolean(a.nationalId)) - Number(Boolean(b.nationalId)) ||
    a.exportRow.registrationNo.localeCompare(b.exportRow.registrationNo, "en", { numeric: true }) ||
    a.exportRow.studentClass.localeCompare(b.exportRow.studentClass, "zh-Hant", { numeric: true }) ||
    a.exportRow.seatNo.localeCompare(b.exportRow.seatNo, "zh-Hant", { numeric: true })
  );
}

function rosterString(entry: Record<string, unknown> | undefined, key: string): string {
  const value = entry?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function registrationNumberFieldValue(
  field: ExamRegistrationNumberField,
  row: Pick<ExamRosterExportRow, "studentClass" | "studentGrade" | "studentId" | "studentClassName" | "studentRollNo" | "seatNo">
): string {
  switch (field) {
    case "rollNo":
      return row.studentRollNo || `${row.studentClass}${row.seatNo}`;
    case "studentId":
      return row.studentId;
    case "grade":
      return row.studentGrade;
    case "classCode":
      return row.studentClass;
    case "className":
      return row.studentClassName || row.studentClass;
    case "seatNo":
      return row.seatNo;
  }
}

/**
 * 名單類型 xlsx 造冊：
 * - all：指定班級內全部應對象學生（含已報名、未報名；未報名者補名冊欄位、狀態「未完成報名」）
 * - registered：指定班級內已完成報名（optOut=false）者
 * - pending：指定班級內未完成報名者（無登錄文件或勾選不報名）
 * from/to 以班級代碼排序（zh-Hant 數值序）取區間，含端點。
 */
export async function buildExamRegistrationXlsxForEvent(
  eventId: string,
  options: {
    scope: ExamRosterExportScope;
    from?: string;
    to?: string;
    schoolExamCode?: string;
    registrationNumberField?: ExamRegistrationNumberField;
  }
): Promise<{ filename: string; buffer: Buffer } | null> {
  const roster = await getExamEventRoster(eventId);
  if (!roster) return null;
  const { scope } = options;
  const from = options.from?.trim() ?? "";
  const to = options.to?.trim() ?? "";
  const schoolExamCode = options.schoolExamCode?.trim() ?? "";
  const registrationNumberField = options.registrationNumberField ?? "rollNo";
  const inRange = (classCode: string): boolean => {
    if (!classCode) return false;
    if (from && classCode.localeCompare(from, "zh-Hant", { numeric: true }) < 0) return false;
    if (to && classCode.localeCompare(to, "zh-Hant", { numeric: true }) > 0) return false;
    return true;
  };

  let rows: ExamRosterExportRow[] = [];
  if (scope === "registered") {
    rows = roster.registrations
      .filter((row) => !row.optOut && inRange(row.studentClass))
      .map((row) => registrationExportRow(row, roster.event, schoolExamCode, registrationNumberField));
  } else {
    // 嚴格省流：應對象學生走共用快取＋年級/班級下推（不整期讀全校名冊）
    const applicableStudents = await loadApplicableStudentsCached(roster.event);
    const regByUid = new Map(roster.registrations.map((row) => [row.studentUid, row]));
    const seenUids = new Set<string>();
    rows = [];
    for (const student of applicableStudents) {
      const { uid, classCode, grade } = student;
      if (!inRange(classCode)) continue;
      seenUids.add(uid);
      const reg = regByUid.get(uid);
      if (reg) {
        if (scope === "pending" && !reg.optOut) continue;
        rows.push(
          registrationExportRow(reg, roster.event, schoolExamCode, registrationNumberField, {
            classCode,
            grade,
            studentId: student.studentId,
            className: student.className,
            seatNo: student.seatNo,
            rollNo: student.rollNo,
          })
        );
      } else {
        // 無登錄文件：all 與 pending 皆列入（狀態「未完成報名」）
        const studentRollNo = student.rollNo || `${classCode}${student.seatNo}`;
        const fieldValue = registrationNumberFieldValue(registrationNumberField, {
          studentClass: classCode,
          studentGrade: grade,
          studentId: student.studentId,
          studentClassName: student.className || classCode,
          studentRollNo,
          seatNo: student.seatNo,
        });
        rows.push({
          studentClass: classCode,
          studentGrade: grade,
          studentId: student.studentId,
          studentClassName: student.className || classCode,
          studentRollNo,
          seatNo: student.seatNo,
          studentName: student.name,
          registrationNo: composeExamRegistrationNumber(schoolExamCode, fieldValue),
          statusLabel: "未完成報名",
          subjectsLabel: "",
          optOutReason: "",
          feeLabel: "",
          feeAmount: "",
          locationLabel: "",
          archivedLabel: "",
          updatedLabel: "",
        });
      }
    }
    // 名單上有登錄、但不在當期名冊（轉出等）：仍納入
    for (const reg of roster.registrations) {
      if (seenUids.has(reg.studentUid) || !inRange(reg.studentClass)) continue;
      if (scope === "pending" && !reg.optOut) continue;
      rows.push(registrationExportRow(reg, roster.event, schoolExamCode, registrationNumberField));
    }
  }

  rows.sort(
    (a, b) =>
      a.studentClass.localeCompare(b.studentClass, "zh-Hant", { numeric: true }) ||
      a.seatNo.localeCompare(b.seatNo, "zh-Hant", { numeric: true }) ||
      a.studentName.localeCompare(b.studentName, "zh-Hant")
  );

  const columns = ["班級", "學號", "座號", "姓名", "報名情形", "選考科目", "不報名原因", "繳費身分", "應繳費用", "考試地點", "資料封存", "登錄時間"];
  if (schoolExamCode) columns.unshift("報名序號");
  const aoa: (string | number)[][] = [
    columns,
    ...rows.map((row) => [
      ...(schoolExamCode ? [row.registrationNo] : []),
      row.studentClass,
      row.studentId,
      row.seatNo,
      row.studentName,
      row.statusLabel,
      row.subjectsLabel,
      row.optOutReason,
      row.feeLabel,
      row.feeAmount,
      row.locationLabel,
      row.archivedLabel,
      row.updatedLabel,
    ]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "名單");
  const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

  const safeTitle = roster.event.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  const rangeSuffix = from || to ? `_${from || "*"}-${to || "*"}` : "";
  const filename = schoolExamCode
    ? `報名資料_${schoolExamCode}_${safeTitle || eventId}${rangeSuffix}.xlsx`
    : `${EXAM_ROSTER_EXPORT_SCOPE_LABELS[scope]}_${safeTitle || eventId}${rangeSuffix}.xlsx`;
  return { filename, buffer };
}

/** 以 uid 批次載入學生證件資料；僅官方報名檔產生時呼叫，絕不回傳至頁面 API。 */
async function loadStudentNationalIds(uids: string[]): Promise<Map<string, string>> {
  const db = getAdminDb();
  const uniqueUids = [...new Set(uids.filter(Boolean))];
  const nationalIds = new Map<string, string>();
  const legacyUids: string[] = [];

  for (let i = 0; i < uniqueUids.length; i += 200) {
    const chunk = uniqueUids.slice(i, i + 200);
    const snapshots = await db.getAll(
      ...chunk.map((uid) => db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION).doc(uid))
    );
    snapshots.forEach((snapshot, index) => {
      const uid = chunk[index];
      if (!snapshot.exists) {
        legacyUids.push(uid);
        return;
      }
      nationalIds.set(
        uid,
        readStudentPersonalIdentityFields(snapshot.data()).nationalId.trim().toUpperCase()
      );
    });
  }

  // 舊版個人資料尚未遷移到獨立身分文件時，依 uid 分批讀歷史記錄並沿用最新非空身分證。
  const legacyUidSet = new Set(legacyUids);
  for (let i = 0; i < legacyUids.length; i += 30) {
    const chunk = legacyUids.slice(i, i + 30);
    const snapshot = await db
      .collection(PERSONAL_INFO_COLLECTION)
      .where("uid", "in", chunk)
      .select("uid", "academicYear", "semester", "nationalId", "fields.nationalId")
      .get();
    const docs = snapshot.docs.filter((doc) => {
      const data = doc.data();
      const academicYear = Number(data.academicYear);
      const semester = Number(data.semester);
      return (
        typeof data.uid === "string" &&
        legacyUidSet.has(data.uid) &&
        Number.isInteger(academicYear) &&
        academicYear > 0 &&
        (semester === 1 || semester === 2)
      );
    }).sort((a, b) => {
      const left = a.data();
      const right = b.data();
      return (
        Number(right.academicYear || 0) - Number(left.academicYear || 0) ||
        Number(right.semester || 0) - Number(left.semester || 0)
      );
    });
    for (const doc of docs) {
      const uid = typeof doc.data().uid === "string" ? doc.data().uid : "";
      if (!legacyUidSet.has(uid) || nationalIds.get(uid)) continue;
      const nationalId = readStudentPersonalIdentityFields(doc.data()).nationalId.trim().toUpperCase();
      if (nationalId) nationalIds.set(uid, nationalId);
    }
  }

  return nationalIds;
}

/** 依正式考試名稱產生官方報名資料檔；英聽、學測與大學術科各用專屬欄位格式。 */
async function buildUniversityArtsOfficialXlsxForEvent(
  anchorRoster: ExamEventRoster,
  options: {
    from?: string;
    to?: string;
    schoolExamCode: string;
    registrationNumberField: ExamRegistrationNumberField;
    ignoreNationalId?: boolean;
  }
): Promise<{ filename: string; buffer: Buffer }> {
  const anchorYear = anchorRoster.event.examDate.slice(0, 4);
  const { events } = await listAdminExamEvents();
  const eventById = new Map<string, ExamEvent>([[anchorRoster.event.id, anchorRoster.event]]);
  for (const event of events) {
    if (
      event.examDate.slice(0, 4) === anchorYear &&
      getUniversityArtsExamGroup(event.title) &&
      !eventById.has(event.id)
    ) {
      eventById.set(event.id, event);
    }
  }
  const relatedEvents = [...eventById.values()];
  const companionEvents = relatedEvents.filter((event) => event.id !== anchorRoster.event.id);
  const registrationSnapshots = await Promise.all(
    companionEvents.map((event) =>
      getAdminDb()
        .collection(EXAM_REGISTRATIONS_COLLECTION)
        .where("eventId", "==", event.id)
        .limit(ROSTER_LIMIT)
        .get()
    )
  );
  const registrations = [
    ...anchorRoster.registrations,
    ...registrationSnapshots.flatMap((snapshot) =>
      snapshot.docs.map((doc) => readExamRegistration(doc.id, doc.data()))
    ),
  ];

  const from = options.from?.trim() ?? "";
  const to = options.to?.trim() ?? "";
  const inRange = (classCode: string): boolean =>
    Boolean(classCode) &&
    (!from || classCode.localeCompare(from, "zh-Hant", { numeric: true }) >= 0) &&
    (!to || classCode.localeCompare(to, "zh-Hant", { numeric: true }) <= 0);
  const groupByEventId = new Map(
    relatedEvents.map((event) => [event.id, getUniversityArtsExamGroup(event.title)] as const)
  );
  const byStudent = new Map<
    string,
    Partial<Record<UniversityArtsExamGroup, { event: ExamEvent; registration: ExamRegistration }>>
  >();
  for (const registration of registrations) {
    if (registration.optOut || !registration.studentUid || !inRange(registration.studentClass)) continue;
    const event = eventById.get(registration.eventId);
    const group = groupByEventId.get(registration.eventId);
    if (!event || !group) continue;
    const groups = byStudent.get(registration.studentUid) ?? {};
    const current = groups[group];
    if (!current || registration.updatedAt >= current.registration.updatedAt) {
      groups[group] = { event, registration };
    }
    byStudent.set(registration.studentUid, groups);
  }

  const students = [...byStudent.entries()].map(([uid, groups]) => {
    const entries = (["music", "art", "sports"] as const)
      .map((group) => groups[group])
      .filter((entry): entry is { event: ExamEvent; registration: ExamRegistration } => Boolean(entry));
    const identityEntry = [...entries].sort(
      (a, b) => b.registration.updatedAt - a.registration.updatedAt
    )[0];
    return { uid, groups, entries, identityEntry };
  }).filter(
    (student): student is typeof student & { identityEntry: { event: ExamEvent; registration: ExamRegistration } } =>
      Boolean(student.identityEntry)
  );

  const nationalIds = await loadStudentNationalIds(students.map((student) => student.uid));
  const missingIds = students.filter((student) => !nationalIds.get(student.uid));
  if (missingIds.length && !options.ignoreNationalId) {
    const sample = missingIds
      .slice(0, 5)
      .map(({ identityEntry }) =>
        `${identityEntry.registration.studentClass} ${identityEntry.registration.studentName}`
      )
      .join("、");
    const remainder = missingIds.length > 5 ? `等 ${missingIds.length} 人` : "";
    throw new ExamRegistrationError(
      400,
      `部分已報名學生尚未填寫身分證資料，無法產生官方報名檔：${sample}${remainder}`
    );
  }

  const schoolExamCode = options.schoolExamCode.trim();
  const studentRows = students.map((student) => ({
    student,
    exportRow: registrationExportRow(
      student.identityEntry.registration,
      anchorRoster.event,
      schoolExamCode,
      options.registrationNumberField
    ),
    nationalId: nationalIds.get(student.uid) ?? "",
  }));
  studentRows.sort(compareOfficialExportRows);

  const aoa: (string | number)[][] = [
    [...UNIVERSITY_ARTS_EXAM_OFFICIAL_HEADERS],
    ...studentRows.map(({ student, exportRow, nationalId }) => {
      const fieldsByGroup: Partial<Record<UniversityArtsExamGroup, string[]>> = {};
      for (const group of ["music", "art", "sports"] as const) {
        const entry = student.groups[group];
        if (!entry) continue;
        fieldsByGroup[group] = universityArtsExamOfficialFields(
          group,
          entry.event.subjects,
          entry.registration.subjectKeys,
          entry.registration.subjectAdvancedOptionCodes,
          entry.registration.locationCode,
          entry.event.locationOptions
        );
      }
      const fields = combineUniversityArtsExamOfficialFields(fieldsByGroup);
      const specialNeeds = [...new Set(
        student.entries.flatMap(({ registration }) => [
          registration.nonAirConditionedRoom ? "非冷氣試場" : "",
          registration.examServiceNote.trim(),
        ].filter(Boolean))
      )].join("；");
      return [exportRow.registrationNo, nationalId, ...fields, specialNeeds];
    }),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "大學術科考試");
  const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const safeTitle = anchorRoster.event.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  return {
    filename: `大學術科考試報名資料_${schoolExamCode}_${safeTitle || anchorRoster.event.id}.xlsx`,
    buffer,
  };
}

export async function buildOfficialExamXlsxForEvent(
  eventId: string,
  options: {
    from?: string;
    to?: string;
    schoolExamCode: string;
    registrationNumberField: ExamRegistrationNumberField;
    ignoreNationalId?: boolean;
  }
): Promise<{ filename: string; buffer: Buffer } | null> {
  const roster = await getExamEventRoster(eventId);
  if (!roster) return null;
  if (getUniversityArtsExamGroup(roster.event.title)) {
    return buildUniversityArtsOfficialXlsxForEvent(roster, options);
  }
  const from = options.from?.trim() ?? "";
  const to = options.to?.trim() ?? "";
  const schoolExamCode = options.schoolExamCode.trim();
  const inRange = (classCode: string): boolean =>
    Boolean(classCode) &&
    (!from || classCode.localeCompare(from, "zh-Hant", { numeric: true }) >= 0) &&
    (!to || classCode.localeCompare(to, "zh-Hant", { numeric: true }) <= 0);
  const registrations = roster.registrations.filter((row) => !row.optOut && inRange(row.studentClass));
  const isEnglishListening = isHighSchoolEnglishListeningExamTitle(roster.event.title);
  const isSubjectAptitude = isSubjectAptitudeExamTitle(roster.event.title);
  const isAcademicAbility = !isEnglishListening && !isSubjectAptitude && isAcademicAbilityExamTitle(roster.event.title);
  const nationalIds = await loadStudentNationalIds(registrations.map((row) => row.studentUid));
  const missingIds = registrations.filter((row) => !nationalIds.get(row.studentUid));
  if (missingIds.length && !options.ignoreNationalId) {
    const sample = missingIds
      .slice(0, 5)
      .map((row) => `${row.studentClass} ${row.studentName}`)
      .join("、");
    const remainder = missingIds.length > 5 ? `等 ${missingIds.length} 人` : "";
    throw new ExamRegistrationError(
      400,
      `部分已報名學生尚未填寫身分證資料，無法產生官方報名檔：${sample}${remainder}`
    );
  }

  const headers = isEnglishListening
    ? [...HIGH_SCHOOL_ENGLISH_LISTENING_EXAM_OFFICIAL_HEADERS]
    : isSubjectAptitude
      ? [...SUBJECT_APTITUDE_EXAM_OFFICIAL_HEADERS]
      : isAcademicAbility
        ? [...ACADEMIC_ABILITY_EXAM_OFFICIAL_HEADERS]
        : genericOfficialExamHeaders(roster.event.subjects);
  const exportRows = registrations.map((row) => ({
    row,
    exportRow: registrationExportRow(row, roster.event, schoolExamCode, options.registrationNumberField),
    nationalId: nationalIds.get(row.studentUid) ?? "",
  }));
  exportRows.sort(compareOfficialExportRows);

  const aoa: (string | number)[][] = [
    headers,
    ...exportRows.map(({ row, exportRow, nationalId }) => {
      const specialNeeds = [
        row.nonAirConditionedRoom ? "非冷氣試場" : "",
        row.examServiceNote.trim(),
      ].filter(Boolean).join("；");
      if (isEnglishListening) {
        return [
          exportRow.registrationNo,
          nationalId,
          row.locationCode,
          specialNeeds,
        ];
      }
      return [
        exportRow.registrationNo,
        nationalId,
        row.locationCode,
        ...(isSubjectAptitude
          ? subjectAptitudeExamSubjectFlags(
              roster.event.subjects,
              row.subjectKeys,
              row.subjectAdvancedOptionCodes
            )
          : isAcademicAbility
            ? academicAbilityExamSubjectFlags(
                roster.event.subjects,
                row.subjectKeys,
                row.subjectAdvancedOptionCodes
              )
            : genericOfficialExamSubjectValues(
                roster.event.subjects,
                row.subjectKeys,
                row.subjectAdvancedOptionCodes
              )),
        specialNeeds,
      ];
    }),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  const officialExamName = isEnglishListening
    ? "高中英語聽力測驗"
    : isSubjectAptitude
      ? "分科測驗"
      : isAcademicAbility
        ? "學科能力測驗"
        : roster.event.title;
  XLSX.utils.book_append_sheet(workbook, worksheet, officialExamName.slice(0, 31));
  const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const safeTitle = roster.event.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  const filename = `${officialExamName}報名資料_${schoolExamCode}_${safeTitle || eventId}.xlsx`;
  return { filename, buffer };
}

/**
 * 掛勾：場次開放時寫入行事曆（upsert，來源鍵＝場次 id，重複儲存只更新不重複）；
 * 公告沒有 upsert，只在狀態轉為「開放」時發送，避免維持開放時重複儲存洗版。
 * M1 只發佈、不撤回（跨模組撤回介面尚未提供）；掛勾失敗不影響儲存結果。
 */
export async function syncExamEventHooks(
  event: ExamEvent,
  actor: Actor,
  publishAnnouncement: boolean
): Promise<void> {
  if (event.status !== "open") return;
  const audience = event.target.classes.length
    ? { roles: ["student"] as UserRole[], classCodes: event.target.classes }
    : schoolWideAudience(["student"]);
  const description = buildEventDescription(event);

  if (publishAnnouncement && event.announcementSync.enabled) {
    try {
      await publishFromModule({
        sourceModule: "examRegistration",
        sourceRef: event.id,
        title: `【報名開放】${event.title}`,
        body: event.announcementSync.body || description,
        authorUid: actor.uid,
        authorName: actor.name,
        authorRole: actor.role,
        audience,
        isPublic: false,
        categoryId: event.announcementSync.categoryId,
      });
    } catch (error) {
      console.error("Exam registration announcement hook error:", error);
    }
  }

  if (!event.calendarSync.enabled) return;
  try {
    await publishScheduleFromModule({
      sourceModule: "examRegistration",
      sourceRef: event.id,
      title: event.title,
      description,
      // 地點：有選項取預設項名稱，否則沿用舊版文字（宿主全天事件僅支援單日，多日以起日入曆、描述帶區間）
      location: event.calendarSync.location ||
        resolveLocationLabel(
          event.locationOptions,
          event.locationOptions.find((option) => option.isDefault)?.code ?? event.locationOptions[0]?.code ?? ""
        ) || event.location || undefined,
      publishUnit: event.calendarSync.publishUnit || undefined,
      categoryId: event.calendarSync.categoryId,
      allDay: true,
      allDayDate: event.examDate,
      audience,
      isPublic: false,
      status: "active",
      createdBy: { uid: actor.uid, name: actor.name, role: actor.role },
    });
  } catch (error) {
    console.error("Exam registration calendar hook error:", error);
  }
}

function assertDraftDeadline(draft: ExamEventDraft): void {
  if (draft.status === "open" && draft.deadline <= Date.now()) {
    throw new ExamRegistrationError(400, "開放報名狀態的截止時間必須晚於現在");
  }
}

function describeTarget(event: ExamEvent): string {
  const grades = event.target.grades.join("、") || "—";
  const classes = event.target.classes.length ? `（${event.target.classes.join("、")}）` : "（全年級）";
  return `${grades} 年級 ${classes}`;
}

function buildEventDescription(event: ExamEvent): string {
  const feeText =
    event.basicFee.standard > 0 || event.basicFee.reduced > 0
      ? `基本費用：一般生 ${event.basicFee.standard} 元／中低收入戶 ${event.basicFee.reduced} 元（低收入戶免繳）`
      : "";
  const windowText = event.registrationOpenAt
    ? `報名期間：${formatDateTime(event.registrationOpenAt)} ~ ${formatDateTime(event.deadline)}`
    : `報名期間：至 ${formatDateTime(event.deadline)}`;
  const locationText = event.locationOptions.length
    ? `考試地點：${event.locationOptions.map((option) => option.label).join("、")}（可選）`
    : event.location
      ? `考試地點：${event.location}`
      : "";
  const advancedOptionText = event.subjects
    .filter((subject) => subject.enableAdvancedOption && (subject.advancedOptions?.length ?? 0) > 0)
    .map((subject) => `${subject.label}（${(subject.advancedOptions ?? []).map((option) => option.label).join("、")}）`)
    .join("；");
  const lines = [
    windowText,
    `考試日期：${formatExamDateRange(event)}`,
    locationText,
    `科目：${event.subjects.map((subject) => subject.label).join("、")}`,
    advancedOptionText ? `進階選項：${advancedOptionText}` : "",
    `對象：${describeTarget(event)}`,
    feeText,
    event.note ? `說明：${event.note}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function formatDateTime(ms: number): string {
  if (!ms) return "—";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}/${value.month}/${value.day} ${value.hour}:${value.minute}`;
}
