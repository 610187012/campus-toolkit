import "server-only";
import type { DocumentData } from "firebase-admin/firestore";
import { FieldValue, getAdminDbRaw, getAdminStorageBucket } from "@/lib/firebase-admin";
import { cachedSettingDoc, invalidateReadCache } from "@/lib/read-cache";
import { SETTINGS_COLLECTION, readSystemDoc } from "@/lib/settings-server";
import { CLASSES_DOC_ID, readSchoolClasses, type SchoolClassesContext } from "@/types/school-classes";
import { PROFILE_DOC_ID, readSchoolProfile } from "@/types/school-profile";
import { rosterCollection } from "@/types/roster";
import {
  DEFAULT_STUDENT_PERSONAL_INFO_SETTINGS,
  EMPTY_STUDENT_PERSONAL_IDENTITY,
  EMPTY_STUDENT_PERSONAL_INFO,
  EMPTY_STUDENT_PERSONAL_INFO_PHOTOS,
  PERSONAL_INFO_COLLECTION,
  STUDENT_PERSONAL_IDENTITY_COLLECTION,
  STUDENT_PERSONAL_PHOTO_COLLECTION,
  STUDENT_PERSONAL_PHOTO_FIRESTORE_PREFIX,
  STUDENT_PERSONAL_PHOTO_STORED_MAX_BYTES,
  STUDENT_PERSONAL_PHOTO_STORAGE_MAX_BYTES,
  isStudentPersonalInfoTermComplete,
  personalInfoSettingsDocId,
  personalPhotoPointerMatches,
  readStudentPersonalIdentityFields,
  readStudentPersonalInfoRecord,
  readStudentPersonalInfoSettings,
  readStudentPersonalInfoTermFields,
  studentPersonalInfoDocId,
  type StudentPersonalInfoSettings,
  type StudentPersonalInfoEntry,
  type StudentPersonalIdentityFields,
  type StudentPersonalInfoTermFields,
  type StudentPersonalInfoRecord,
  type StudentPersonalPhotoKind,
  type StudentPersonalPhotoMetadata,
  type StudentPersonalInfoTargetOptions,
} from "@/types/personal-info";
import {
  DEFAULT_STUDENT_PERSONAL_PHOTO_STORAGE,
  isStudentPersonalPhotoStorage,
  type SchoolPeriod,
  type StudentPersonalPhotoStorage,
} from "@/types/settings";

export async function getStudentPersonalInfoSettings(
  period: SchoolPeriod
): Promise<StudentPersonalInfoSettings> {
  const docId = personalInfoSettingsDocId(period);
  try {
    const raw = await cachedSettingDoc(docId, async () => {
      const snap = await getAdminDbRaw().collection(SETTINGS_COLLECTION).doc(docId).get();
      return snap.exists ? snap.data() ?? null : null;
    });
    return readStudentPersonalInfoSettings(raw);
  } catch (error) {
    console.error("Student personal info settings read error:", error);
    return { ...DEFAULT_STUDENT_PERSONAL_INFO_SETTINGS };
  }
}

export async function saveStudentPersonalInfoSettings(
  period: SchoolPeriod,
  settings: StudentPersonalInfoSettings
): Promise<void> {
  const docId = personalInfoSettingsDocId(period);
  await getAdminDbRaw().collection(SETTINGS_COLLECTION).doc(docId).set({
    ...settings,
    academicYear: period.academicYear,
    semester: period.semester,
    updatedAt: Date.now(),
  });
  invalidateReadCache(`setting-doc:${docId}`);
}

export async function getStudentPersonalInfoTargetOptions(): Promise<StudentPersonalInfoTargetOptions> {
  try {
    const db = getAdminDbRaw();
    const [classesSnap, profileSnap] = await Promise.all([
      cachedSettingDoc(CLASSES_DOC_ID, () =>
        db.collection(SETTINGS_COLLECTION).doc(CLASSES_DOC_ID).get()
      ),
      cachedSettingDoc(PROFILE_DOC_ID, () =>
        db.collection(SETTINGS_COLLECTION).doc(PROFILE_DOC_ID).get()
      ),
    ]);
    const profile = readSchoolProfile(profileSnap.exists ? profileSnap.data() : null);
    const context: SchoolClassesContext = {
      stages: profile.stages.map(({ stage, years }) => ({ stage, years })),
    };
    const schoolClasses = readSchoolClasses(
      classesSnap.exists ? classesSnap.data() : null,
      context
    );
    return {
      grades: schoolClasses.grades.map((grade) => ({
        value: String(grade.grade),
        label: grade.name,
        classes: grade.classes.map((classRow) => ({
          value: classRow.code,
          label: classRow.name,
        })),
      })),
    };
  } catch (error) {
    console.error("Student personal info target options read error:", error);
    return { grades: [] };
  }
}

/** 管理端列表的一列（僅回必要欄位；不回個資內容，避免整班資料外洩到列表） */
export interface StudentPersonalInfoListRow {
  uid: string;
  studentId: string;
  name: string;
  classCode: string;
  /** none＝本期尚無文件；incomplete＝有文件但學期欄位未填妥；complete＝學期欄位全填 */
  status: "none" | "incomplete" | "complete";
  /** 本期文件的最後更新時間（epoch ms；無文件為 null） */
  updatedAt: number | null;
}

/**
 * 統計本期已建立個人資料文件的數量（省流模式的輕量總數）。
 * 使用 Firestore count 聚合：每個計數僅 1 次讀取、不載入任何文件內容。
 */
export async function countStudentPersonalInfoByTerm(period: SchoolPeriod): Promise<number> {
  const snap = await getAdminDbRaw()
    .collection(PERSONAL_INFO_COLLECTION)
    .where("academicYear", "==", period.academicYear)
    .where("semester", "==", period.semester)
    .count()
    .get();
  return snap.data().count;
}

/**
 * 依班級代碼載入本期學生個人資料列表（管理端用）。
 *
 * 讀取範圍嚴格限定於該班（鐵律 2 過濾下推）：名冊以
 * academicYear＋semester＋classCode 三個等值條件下推，回傳筆數≈該班人數而非全校；
 * 個人資料文件以本班 uid 逐一點查（點查不存在＝0 讀），200 筆／批（鐵律 4）。
 * 回傳前依學號排序；不含聯絡方式等個資內容，僅回填寫狀態與更新時間。
 */
export async function loadStudentPersonalInfoClassList(
  period: SchoolPeriod,
  classCode: string
): Promise<StudentPersonalInfoListRow[]> {
  if (!classCode) return [];
  const db = getAdminDbRaw();
  const rosterSnap = await db
    .collection(rosterCollection("student"))
    .where("academicYear", "==", period.academicYear)
    .where("semester", "==", period.semester)
    .where("classCode", "==", classCode)
    .get();

  const entries = rosterSnap.docs
    .map((doc) => doc.data())
    .filter((entry) => {
      // 條目有效（缺 status 視為有效）；同 lib/roster.ts isActiveEntry 語意
      const status = typeof entry.status === "string" ? entry.status : "有效";
      return status === "有效";
    })
    .sort((a, b) =>
      String(a.studentId ?? "").localeCompare(String(b.studentId ?? ""), "zh-Hant")
    );

  const uids = entries
    .map((entry) => (typeof entry.uid === "string" ? entry.uid : ""))
    .filter(Boolean);
  const infoByUid = new Map<string, DocumentData>();
  for (let offset = 0; offset < uids.length; offset += 200) {
    const chunk = uids.slice(offset, offset + 200);
    const snaps = await db.getAll(
      ...chunk.map((uid) => db.collection(PERSONAL_INFO_COLLECTION).doc(studentPersonalInfoDocId(uid, period)))
    );
    for (let index = 0; index < snaps.length; index += 1) {
      if (snaps[index].exists) infoByUid.set(chunk[index], snaps[index].data() ?? {});
    }
  }

  return entries.map((entry) => {
    const uid = typeof entry.uid === "string" ? entry.uid : "";
    const info = infoByUid.get(uid);
    const termFields = info ? readStudentPersonalInfoTermFields(info) : null;
    const status: StudentPersonalInfoListRow["status"] = !info
      ? "none"
      : isStudentPersonalInfoTermComplete(termFields!)
        ? "complete"
        : "incomplete";
    const updatedAt = info && typeof info.updatedAt === "number" ? info.updatedAt : null;
    return {
      uid,
      studentId: typeof entry.studentId === "string" ? entry.studentId : "",
      name: typeof entry.name === "string" ? entry.name : "",
      classCode: typeof entry.classCode === "string" ? entry.classCode : "",
      status,
      updatedAt,
    };
  });
}

export async function getStudentPersonalInfo(
  uid: string,
  period: SchoolPeriod
): Promise<StudentPersonalInfoRecord> {
  const snap = await getAdminDbRaw()
    .collection(PERSONAL_INFO_COLLECTION)
    .doc(studentPersonalInfoDocId(uid, period))
    .get();
  return snap.exists
    ? readStudentPersonalInfoRecord(snap.data())
    : { fields: { ...EMPTY_STUDENT_PERSONAL_INFO }, photos: { ...EMPTY_STUDENT_PERSONAL_INFO_PHOTOS } };
}

/** 依登入者 uid 取得已填寫的各學期個人資料（有界於單一使用者，不載入全校資料）。 */
export async function getStudentPersonalInfoEntries(uid: string): Promise<StudentPersonalInfoEntry[]> {
  const snapshot = await getAdminDbRaw()
    .collection(PERSONAL_INFO_COLLECTION)
    .where("uid", "==", uid)
    .get();
  return snapshot.docs
    .map((doc) => {
      const raw = doc.data();
      const academicYear = Number(raw.academicYear);
      const semester = Number(raw.semester);
      if (
        raw.uid !== uid ||
        !Number.isInteger(academicYear) ||
        academicYear <= 0 ||
        (semester !== 1 && semester !== 2)
      ) {
        return null;
      }
      const record = readStudentPersonalInfoRecord(raw);
      return {
        fields: readStudentPersonalInfoTermFields(raw),
        photos: record.photos,
        legacyIdentity: readStudentPersonalIdentityFields(raw),
        academicYear,
        semester,
      } satisfies StudentPersonalInfoEntry;
    })
    .filter((entry): entry is StudentPersonalInfoEntry => entry !== null)
    .sort((a, b) => b.academicYear - a.academicYear || b.semester - a.semester);
}

/** 身分識別資料以 uid 為鍵跨學期保存；缺少新文件時從最新舊期名冊資料相容讀取。 */
export async function getStudentPersonalIdentity(
  uid: string,
  legacyEntries: StudentPersonalInfoEntry[]
): Promise<StudentPersonalIdentityFields> {
  const snapshot = await getAdminDbRaw()
    .collection(STUDENT_PERSONAL_IDENTITY_COLLECTION)
    .doc(uid)
    .get();
  if (snapshot.exists) return readStudentPersonalIdentityFields(snapshot.data());

  return legacyStudentPersonalIdentity(legacyEntries);
}

export function legacyStudentPersonalIdentity(
  legacyEntries: { legacyIdentity: StudentPersonalIdentityFields }[]
): StudentPersonalIdentityFields {
  const identity = { ...EMPTY_STUDENT_PERSONAL_IDENTITY };
  for (const entry of legacyEntries) {
    for (const key of Object.keys(identity) as (keyof StudentPersonalIdentityFields)[]) {
      if (!identity[key] && entry.legacyIdentity[key]) identity[key] = entry.legacyIdentity[key];
    }
  }
  return identity;
}

export async function saveStudentPersonalIdentity(
  uid: string,
  fields: StudentPersonalIdentityFields
): Promise<void> {
  await getAdminDbRaw()
    .collection(STUDENT_PERSONAL_IDENTITY_COLLECTION)
    .doc(uid)
    .set({ uid, ...fields, updatedAt: Date.now() });
}

export async function saveStudentPersonalInfo(
  uid: string,
  period: SchoolPeriod,
  fields: StudentPersonalInfoTermFields
): Promise<void> {
  const db = getAdminDbRaw();
  const personalInfoRef = db.collection(PERSONAL_INFO_COLLECTION).doc(studentPersonalInfoDocId(uid, period));
  const identityRef = db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION).doc(uid);
  await db.runTransaction(async (transaction) => {
    const identitySnapshot = await transaction.get(identityRef);
    if (!identitySnapshot.exists) {
      const historySnapshot = await transaction.get(
        db.collection(PERSONAL_INFO_COLLECTION).where("uid", "==", uid)
      );
      const legacyEntries = historySnapshot.docs
        .map((doc) => {
          const data = doc.data();
          return {
            academicYear: Number(data.academicYear),
            semester: Number(data.semester),
            legacyIdentity: readStudentPersonalIdentityFields(data),
            uid: data.uid,
          };
        })
        .filter((entry) =>
          entry.uid === uid &&
          Number.isInteger(entry.academicYear) &&
          entry.academicYear > 0 &&
          (entry.semester === 1 || entry.semester === 2)
        )
        .sort((a, b) => b.academicYear - a.academicYear || b.semester - a.semester);
      const identityToMigrate = legacyStudentPersonalIdentity(legacyEntries);
      if (Object.values(identityToMigrate).some(Boolean)) {
        transaction.set(identityRef, { uid, ...identityToMigrate, updatedAt: Date.now() });
      }
    }
    transaction.set(personalInfoRef, {
      uid,
      academicYear: period.academicYear,
      semester: period.semester,
      fields: {
        ...fields,
        gender: FieldValue.delete(),
        idType: FieldValue.delete(),
        nationalId: FieldValue.delete(),
        birthday: FieldValue.delete(),
      },
      updatedAt: Date.now(),
    }, { merge: true });
  });
}

/** 讀取系統設定的「證件照儲存後端」；讀不到時回免費方案可用的 Firestore。 */
export async function getStudentPersonalPhotoStorage(): Promise<StudentPersonalPhotoStorage> {
  try {
    const value = (await readSystemDoc())?.studentPersonalPhotoStorage;
    return isStudentPersonalPhotoStorage(value) ? value : DEFAULT_STUDENT_PERSONAL_PHOTO_STORAGE;
  } catch (error) {
    console.error("Student personal photo storage setting read error:", error);
    return DEFAULT_STUDENT_PERSONAL_PHOTO_STORAGE;
  }
}

/** 各後端的實存上限：Firestore 受單一文件 1 MiB 限制，Storage 沿用 5 MB。 */
export function studentPersonalPhotoBackendLimit(backend: StudentPersonalPhotoStorage): number {
  return backend === "firestore"
    ? STUDENT_PERSONAL_PHOTO_STORED_MAX_BYTES
    : STUDENT_PERSONAL_PHOTO_STORAGE_MAX_BYTES;
}

export function studentPersonalInfoPhotoObjectPathPrefix(
  uid: string,
  period: SchoolPeriod,
  kind: StudentPersonalPhotoKind
): string {
  return `student-personal-info/${uid}/${period.academicYear}_${period.semester}/${kind}/`;
}

function studentPersonalPhotoDocId(
  uid: string,
  period: SchoolPeriod,
  kind: StudentPersonalPhotoKind
): string {
  return `${uid}_${period.academicYear}_${period.semester}_${kind}`;
}

/** Firestore 後端的指標：`firestore:` + 與物件路徑同形狀，讓前綴檢查可共用兩種後端。 */
function studentPersonalPhotoFirestorePointer(
  uid: string,
  period: SchoolPeriod,
  kind: StudentPersonalPhotoKind
): string {
  return `${STUDENT_PERSONAL_PHOTO_FIRESTORE_PREFIX}${studentPersonalInfoPhotoObjectPathPrefix(
    uid,
    period,
    kind
  )}${Date.now()}-${crypto.randomUUID()}.jpg`;
}

/** 由 `firestore:student-personal-info/{uid}/{y}_{s}/{kind}/{檔名}` 還原照片文件 ID。 */
function firestorePointerToPhotoDocId(pointer: string): string | null {
  if (!pointer.startsWith(STUDENT_PERSONAL_PHOTO_FIRESTORE_PREFIX)) return null;
  const parts = pointer.slice(STUDENT_PERSONAL_PHOTO_FIRESTORE_PREFIX.length).split("/");
  if (parts.length !== 5 || parts[0] !== "student-personal-info") return null;
  const [, uid, period, kind, fileName] = parts;
  if (!uid || !period || !kind || !fileName) return null;
  if (!/^\d+_\d+$/.test(period)) return null;
  if (kind !== "admission" && kind !== "graduation") return null;
  if (/[.#\[\]]/.test(uid)) return null;
  return `${uid}_${period}_${kind}`;
}

function assertFirebaseStorageConfigured(): void {
  if (!process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim()) {
    throw new Error(
      "尚未建立 Firebase Storage bucket，無法存入 Firebase Storage。請到「系統設定 → 省錢專區」把證件照儲存改為 Firestore，或先完成 bucket 建立。"
    );
  }
}

async function writeStudentPersonalPhotoBytes(
  uid: string,
  period: SchoolPeriod,
  kind: StudentPersonalPhotoKind,
  metadata: StudentPersonalPhotoMetadata,
  bytes: Buffer
): Promise<void> {
  if (metadata.backend === "firestore") {
    await getAdminDbRaw()
      .collection(STUDENT_PERSONAL_PHOTO_COLLECTION)
      .doc(studentPersonalPhotoDocId(uid, period, kind))
      .set({
        uid,
        academicYear: period.academicYear,
        semester: period.semester,
        kind,
        pointer: metadata.objectPath,
        bytes: Buffer.from(bytes),
        contentType: metadata.contentType,
        updatedAt: metadata.updatedAt,
      });
    return;
  }
  assertFirebaseStorageConfigured();
  await getAdminStorageBucket().file(metadata.objectPath).save(bytes, {
    resumable: false,
    metadata: { contentType: metadata.contentType, cacheControl: "private, no-store" },
  });
}

async function removeStudentPersonalPhotoBytes(
  metadata: Pick<StudentPersonalPhotoMetadata, "objectPath" | "backend">
): Promise<void> {
  if (metadata.backend === "firestore") {
    const docId = firestorePointerToPhotoDocId(metadata.objectPath);
    if (!docId) return;
    await getAdminDbRaw().collection(STUDENT_PERSONAL_PHOTO_COLLECTION).doc(docId).delete();
    return;
  }
  if (
    !metadata.objectPath.startsWith("student-personal-info/") ||
    metadata.objectPath.includes("..")
  ) {
    return;
  }
  await getAdminStorageBucket()
    .file(metadata.objectPath)
    .delete({ ignoreNotFound: true });
}

/** 讀取照片本體，後端依 metadata.backend 決定（舊照片仍讀得到）。 */
export async function readStudentPersonalPhotoBytes(
  metadata: StudentPersonalPhotoMetadata
): Promise<Buffer> {
  if (metadata.backend === "firestore") {
    const docId = firestorePointerToPhotoDocId(metadata.objectPath);
    if (!docId) throw new Error("證件照指標無效");
    const snap = await getAdminDbRaw().collection(STUDENT_PERSONAL_PHOTO_COLLECTION).doc(docId).get();
    const bytes = snap.exists
      ? ((snap.data()?.bytes as Uint8Array | undefined) ?? null)
      : null;
    if (!bytes || bytes.length === 0) throw new Error("證件照檔案不存在");
    return Buffer.from(bytes);
  }
  assertFirebaseStorageConfigured();
  const [contents] = await getAdminStorageBucket().file(metadata.objectPath).download();
  return contents;
}

export async function saveStudentPersonalPhoto(
  uid: string,
  period: SchoolPeriod,
  kind: StudentPersonalPhotoKind,
  bytes: Buffer,
  contentType: StudentPersonalPhotoMetadata["contentType"]
): Promise<StudentPersonalPhotoMetadata> {
  const current = await getStudentPersonalInfo(uid, period);
  const backend = await getStudentPersonalPhotoStorage();
  const limit = studentPersonalPhotoBackendLimit(backend);
  if (bytes.length > limit) {
    throw new Error(
      backend === "firestore"
        ? `證件照超過 Firestore 的 ${Math.round(limit / 1024)} KB 上限，請改用解析度較低的照片`
        : `證件照超過 ${Math.round(limit / 1024 / 1024)} MB 上限`
    );
  }

  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
  const objectPath =
    backend === "firestore"
      ? studentPersonalPhotoFirestorePointer(uid, period, kind)
      : `${studentPersonalInfoPhotoObjectPathPrefix(uid, period, kind)}${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const metadata: StudentPersonalPhotoMetadata = {
    objectPath,
    backend,
    contentType,
    updatedAt: Date.now(),
  };

  await writeStudentPersonalPhotoBytes(uid, period, kind, metadata, bytes);

  try {
    await getAdminDbRaw()
      .collection(PERSONAL_INFO_COLLECTION)
      .doc(studentPersonalInfoDocId(uid, period))
      .set({
        uid,
        academicYear: period.academicYear,
        semester: period.semester,
        photos: { [kind]: metadata },
        updatedAt: metadata.updatedAt,
      }, { merge: true });
  } catch (error) {
    await removeStudentPersonalPhotoBytes(metadata).catch(() => undefined);
    throw error;
  }

  const old = current.photos[kind];
  const prefix = studentPersonalInfoPhotoObjectPathPrefix(uid, period, kind);
  if (
    old &&
    old.objectPath !== metadata.objectPath &&
    personalPhotoPointerMatches(old.objectPath, prefix)
  ) {
    await removeStudentPersonalPhotoBytes(old).catch(() => {
      console.error("Unable to remove replaced personal photo");
    });
  }
  return metadata;
}

export function personalPhotoObjectPathsForRecord(
  uid: string,
  period: SchoolPeriod,
  raw: unknown
): string[] {
  const record = readStudentPersonalInfoRecord(raw);
  const paths: string[] = [];
  for (const kind of Object.keys(record.photos) as StudentPersonalPhotoKind[]) {
    const objectPath = record.photos[kind]?.objectPath;
    if (objectPath && personalPhotoPointerMatches(objectPath, studentPersonalInfoPhotoObjectPathPrefix(uid, period, kind))) {
      paths.push(objectPath);
    }
  }
  return paths;
}

export async function deleteStudentPersonalPhotoObjects(objectPaths: string[]): Promise<void> {
  const unique = [...new Set(objectPaths)];
  const firestorePointers = unique.filter((pointer) =>
    pointer.startsWith(STUDENT_PERSONAL_PHOTO_FIRESTORE_PREFIX)
  );
  const storagePaths = unique.filter(
    (objectPath) =>
      !objectPath.startsWith(STUDENT_PERSONAL_PHOTO_FIRESTORE_PREFIX) &&
      objectPath.startsWith("student-personal-info/") &&
      !objectPath.includes("..")
  );

  if (firestorePointers.length > 0) {
    try {
      const ids = [
        ...new Set(
          firestorePointers
            .map(firestorePointerToPhotoDocId)
            .filter((docId): docId is string => Boolean(docId))
        ),
      ];
      if (ids.length > 0) {
        const db = getAdminDbRaw();
        const batch = db.batch();
        for (const docId of ids) {
          batch.delete(db.collection(STUDENT_PERSONAL_PHOTO_COLLECTION).doc(docId));
        }
        await batch.commit();
      }
    } catch {
      console.error("Unable to clean up personal photos from firestore");
    }
  }

  if (storagePaths.length === 0) return;
  try {
    const bucket = getAdminStorageBucket();
    for (let offset = 0; offset < storagePaths.length; offset += 100) {
      await Promise.all(
        storagePaths.slice(offset, offset + 100).map((objectPath) =>
          bucket.file(objectPath).delete({ ignoreNotFound: true }).catch(() => {
            console.error("Unable to remove personal photo from storage");
          })
        )
      );
    }
  } catch {
    console.error("Unable to clean up personal photos from storage");
  }
}

export function taipeiDateString(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function taipeiDateTimeString(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function isStudentPersonalInfoOpen(
  settings: StudentPersonalInfoSettings,
  now = taipeiDateTimeString()
): boolean {
  return (
    settings.enabled &&
    Boolean(settings.startDate) &&
    Boolean(settings.endDate) &&
    now >= settings.startDate &&
    now <= settings.endDate
  );
}

export function studentPersonalInfoAvailabilityMessage(
  settings: StudentPersonalInfoSettings,
  now = taipeiDateTimeString()
): string {
  if (!settings.enabled) return "本學期個人資料填寫尚未開放。";
  if (!settings.startDate || !settings.endDate) return "管理員尚未設定完整的填寫起訖日期。";
  const start = settings.startDate.replace("T", " ");
  const end = settings.endDate.replace("T", " ");
  if (now < settings.startDate) return `填寫期間將於 ${start} 開放。`;
  if (now > settings.endDate) return `填寫期限已於 ${end} 結束。`;
  return `開放填寫至 ${end}。`;
}
