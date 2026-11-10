import "server-only";
import type { DocumentReference } from "firebase-admin/firestore";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import { cachedRead, cachedSettingDoc, invalidateReadCache } from "@/lib/read-cache";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  CALENDAR_COLLECTION,
  CALENDAR_REMINDERS_COLLECTION,
  CALENDAR_SETTINGS_DOC_ID,
  CALENDAR_SURFACES,
  AdminCalendarEventRow,
  CalendarAudience,
  CalendarCategory,
  CalendarEventItem,
  CalendarEventRecord,
  CalendarEventStatus,
  CalendarGradeOption,
  CalendarPolicies,
  CalendarReminderItem,
  CalendarSchoolActivity,
  CalendarSettings,
  CalendarEventInput,
  CalendarSurface,
  CalendarSurfaceItem,
  CalendarSurfaces,
  calendarCategoryName,
  calendarEventEnd,
  calendarEventToFirestore,
  calendarEventToItem,
  audienceClassScoped,
  canViewCalendarEvent,
  CALENDAR_FALLBACK_CATEGORY_ID,
  computePublicCalendarEarliestFrom,
  DEFAULT_CALENDAR_CATEGORIES,
  DEFAULT_CALENDAR_POLICIES,
  DEFAULT_CALENDAR_SETTINGS,
  defaultCalendarFallbackCategory,
  defaultCalendarSurfaces,
  isCalendarEventActive,
  isCalendarEventPublicReadable,
  normalizeCalendarSurfaceLimit,
  normalizePublicPastMonths,
  readCalendarEventRecord,
  readCalendarSettings,
  startOfTodayMs,
  validateCalendarInput,
} from "@/types/calendar";
import type { UserRole } from "@/types/users";
import { ensureFallbackCategory } from "@/types/category";
import {
  PERIODS_DOC_ID,
  readSchoolPeriods,
  type SchoolPeriodRow,
} from "@/types/school-periods";
import { CLASSES_DOC_ID, readSchoolClasses } from "@/types/school-classes";

/**
 * 行事曆功能模組（server-only）。
 *
 * 跨模組行程接口協議（其他模組請照此呼叫，勿自開平行集合）：
 * 1. 只寫 `calendarEvents` 集合；校驗失敗拋錯（title 非空、時間合法、閱讀權限非空）；
 * 2. `sourceModule` 必填；有 `sourceRef` 時以 `sourceModule+sourceRef` 定位：
 *    存在→覆寫欄位（updatedAt 遞增），不存在→新建；無 `sourceRef` 每次皆新建；
 * 3. `status: "cancelled"` 預設保留文件（不刪除），供來源模組對帳；
 *    「規則設定」開啟「下架行程真實刪除」時改為連同個人提醒真實刪除；
 * 4. 寫入後內建 `invalidateCalendarCache()`（清 `calendar:` 前綴讀快取）；
 * 5. 取消／過期事件不回給任何讀取端。
 *
 * 讀取：查詢條件全下推（status ＋ audienceRoles ＋ startAt 範圍），
 * 班級受眾於記憶體過濾（量級同公告，避免複合索引）；15 秒 cachedRead。
 */

const LIST_CACHE_PREFIX = "calendar:";
const LIST_TTL_MS = 15_000;
const LIST_LIMIT = 200;
const ADMIN_LIST_LIMIT = 200;
const REMINDER_LIMIT = 50;
/** `getAll` 分塊上限（規範鐵律 4：200 筆／批） */
const GET_ALL_CHUNK = 200;
/** 顯示位置一次取回的上限（記憶體過濾後再截斷；免複合索引策略下需比舊版 30 寬鬆，避免受眾過濾後取不到足量） */
const SURFACE_FETCH_LIMIT = 100;
/** 顯示位置／行程列表的短快取 TTL（寫入後由 `invalidateCalendarCache()` 清前綴） */
const SURFACE_TTL_MS = 15_000;
/** 真實刪除一張 WriteBatch 的文件上限（留餘裕） */
const DELETE_BATCH_LIMIT = 400;
/** `in` 查詢每批上限（Firestore 上限 30） */
const IN_QUERY_CHUNK = 30;
/** 下架原則批次清除「已取消行程」的單次掃描上限 */
const PURGE_SCAN_LIMIT = 200;

/** 讀取行事曆模組設定（settings/calendar，30 秒快取） */
export async function getCalendarSettings(): Promise<CalendarSettings> {  try {
    const raw = await cachedSettingDoc(CALENDAR_SETTINGS_DOC_ID, async () => {
      const snap = await getAdminDbRaw()
        .collection("settings")
        .doc(CALENDAR_SETTINGS_DOC_ID)
        .get();
      return snap.exists ? (snap.data() ?? null) : null;
    });
    return readCalendarSettings(raw);
  } catch {
    return {
      ...DEFAULT_CALENDAR_SETTINGS,
      categories: [...DEFAULT_CALENDAR_CATEGORIES],
    };
  }
}

/** 讀取學校課表作息（settings/schoolPeriods，30 秒快取）；行事曆表單與批次匯入共用 */
export async function getSchoolPeriods(): Promise<SchoolPeriodRow[]> {
  try {
    const raw = await cachedSettingDoc(PERIODS_DOC_ID, async () => {
      const snap = await getAdminDbRaw().collection("settings").doc(PERIODS_DOC_ID).get();
      return snap.exists ? snap.data() ?? null : null;
    });
    return readSchoolPeriods(raw).periods;
  } catch {
    return readSchoolPeriods(null).periods;
  }
}

/** 年級／班級候選（學校活動層級用） */
export async function getSchoolClassOptions(): Promise<CalendarGradeOption[]> {
  try {
    const raw = await cachedSettingDoc(CLASSES_DOC_ID, async () => {
      const snap = await getAdminDbRaw().collection("settings").doc(CLASSES_DOC_ID).get();
      return snap.exists ? snap.data() ?? null : null;
    });
    return readSchoolClasses(raw).grades.map((grade) => ({
      grade: grade.name,
      classes: grade.classes.map((row) => ({ code: row.code, name: row.name })),
    }));
  } catch {
    return [];
  }
}

/** 行程／設定變更後：清 `calendar:` 前綴讀快取（含設定文件的 `setting-doc:calendar`） */
export function invalidateCalendarCache(): void {
  invalidateReadCache(LIST_CACHE_PREFIX);
  invalidateReadCache("setting-doc:");
}

export interface PublishScheduleFromModuleInput {
  /** 必填：來源模組代碼（行事曆自己建＝"calendar"） */
  sourceModule: string;
  /** 強烈建議填：來源資料 id，改期／取消靠它定位（同值再次呼叫＝覆寫更新） */
  sourceRef?: string;
  title?: string;
  description?: string;
  location?: string;
  startAt?: number;
  endAt?: number | null;
  allDay?: boolean;
  allDayDate?: string;
  important?: boolean;
  /** 學校活動層級（衝堂比對用；未提供＝沿用現值） */
  schoolActivity?: CalendarSchoolActivity;
  categoryId?: string;
  /** 發佈單位（如：教務處）；缺省＝沿用現值 */
  publishUnit?: string;
  audience?: CalendarAudience;
  /** 閱讀權限「無」＝公開（不需登入）；與身分選項互斥 */
  isPublic?: boolean;
  /** 取消時傳 "cancelled"（保留文件）；預設 "active" */
  status?: CalendarEventStatus;
  createdBy?: { uid: string; name: string; role: UserRole };
  academicYear?: number;
  semester?: 1 | 2;
}

/** 跨模組輸入與既有文件合併（upsert：未提供的欄位沿用現值） */
function mergeScheduleInput(
  existing: CalendarEventRecord | null,
  input: PublishScheduleFromModuleInput
): CalendarEventInput {
  const allDay = input.allDay ?? (existing ? Boolean(existing.allDayDate) : false);
  return {
    title: input.title ?? existing?.title ?? "",
    description: input.description ?? existing?.description,
    location: input.location ?? existing?.location,
    startAt: input.startAt ?? existing?.startAt,
    endAt: input.endAt === undefined ? existing?.endAt ?? null : input.endAt,
    allDay,
    allDayDate: allDay ? (input.allDayDate ?? existing?.allDayDate) : undefined,
    important: input.important ?? existing?.important ?? false,
    schoolActivity: input.schoolActivity ?? existing?.schoolActivity,
    categoryId: input.categoryId ?? existing?.categoryId,
    publishUnit: input.publishUnit ?? existing?.publishUnit,
    audience: input.audience ?? existing?.audience ?? { roles: [], classCodes: [] },
    isPublic: input.isPublic ?? existing?.isPublic ?? false,
    academicYear: input.academicYear ?? existing?.academicYear,
    semester: input.semester ?? existing?.semester,
  };
}

/**
 * 跨模組發佈行程：其他功能模組（空間預約、報名…）在伺服器端直接呼叫。
 * 有 `sourceRef` 時以 `sourceModule+sourceRef` 定位（存在＝覆寫更新）。
 * 校驗失敗拋錯；成功回傳 `{ id, updated }`。
 */
export async function publishScheduleFromModule(
  input: PublishScheduleFromModuleInput
): Promise<{ id: string; updated: boolean }> {
  const sourceModule = typeof input.sourceModule === "string" ? input.sourceModule.trim() : "";
  if (!sourceModule) {
    throw new Error("publishScheduleFromModule: sourceModule 必填");
  }

  const db = getAdminDbRaw();
  const col = db.collection(CALENDAR_COLLECTION);
  const sourceRef = typeof input.sourceRef === "string" ? input.sourceRef.trim() : "";

  let existing: CalendarEventRecord | null = null;
  let targetRef: DocumentReference | null = null;
  if (sourceRef) {
    const snap = await col
      .where("sourceModule", "==", sourceModule)
      .where("sourceRef", "==", sourceRef)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      existing = readCalendarEventRecord(doc.id, doc.data());
      targetRef = doc.ref;
    }
  }

  const validation = validateCalendarInput(mergeScheduleInput(existing, input));
  if (!validation.ok) {
    throw new Error(`publishScheduleFromModule: ${validation.message}`);
  }

  const period = await getCurrentPeriod();
  const now = Date.now();
  const status: CalendarEventStatus = input.status === "cancelled" ? "cancelled" : "active";
  const record: Omit<CalendarEventRecord, "id"> = {
    title: validation.value.title,
    description: validation.value.description,
    location: validation.value.location,
    startAt: validation.value.startAt,
    endAt: validation.value.endAt,
    allDayDate: validation.value.allDayDate,
    important: validation.value.important,
    schoolActivity: validation.value.schoolActivity,
    categoryId: validation.value.categoryId,
    publishUnit: validation.value.publishUnit,
    sourceModule,
    sourceRef: sourceRef || undefined,
    audience: validation.value.audience,
    isPublic: validation.value.isPublic,
    status,
    createdBy:
      input.createdBy ??
      existing?.createdBy ?? { uid: "", name: sourceModule, role: "admin" as UserRole },
    academicYear: validation.value.academicYear ?? period.academicYear,
    semester: validation.value.semester ?? (period.semester === 2 ? 2 : 1),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const data = calendarEventToFirestore(record);
  const id = targetRef
    ? (await targetRef.set(data, { merge: false }), targetRef.id)
    : (await col.add(data)).id;
  invalidateCalendarCache();
  return { id, updated: targetRef !== null };
}

export interface CreateCalendarEventInput
  extends Omit<PublishScheduleFromModuleInput, "sourceModule" | "audience" | "title"> {
  sourceModule?: string;
  audience: CalendarAudience;
  title: string;
}

/** 管理端／教職員建立行程（無 sourceRef 時每次皆新建） */
export async function createCalendarEvent(
  input: CreateCalendarEventInput
): Promise<{ id: string; updated: boolean }> {
  return publishScheduleFromModule({ ...input, sourceModule: input.sourceModule || "calendar" });
}

/**
 * 更新行程（僅改可編輯欄位；id、來源與建立者固定）。回傳 `deleted=true` 表示因下架原則被真實刪除。
 * `allowHardDelete=false` 時即使「下架行程真實刪除」開啟也只做軟取消（供只有行程管理權、
 * 沒有刪除權的被指派者使用，避免以取消名義永久刪除）。
 */
export async function updateCalendarEvent(
  id: string,
  patch: PublishScheduleFromModuleInput,
  options?: { allowHardDelete?: boolean }
): Promise<{ deleted: boolean }> {
  const db = getAdminDbRaw();
  const ref = db.collection(CALENDAR_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("查無此行程");
  const current = readCalendarEventRecord(id, snap.data());
  if (!current) throw new Error("行程資料毀損");

  const validation = validateCalendarInput(mergeScheduleInput(current, patch));
  if (!validation.ok) throw new Error(validation.message);

  const now = Date.now();
  const next: Omit<CalendarEventRecord, "id"> = {
    ...current,
    title: validation.value.title,
    description: validation.value.description,
    location: validation.value.location,
    startAt: validation.value.startAt,
    endAt: validation.value.endAt,
    allDayDate: validation.value.allDayDate,
    important: validation.value.important,
    schoolActivity: validation.value.schoolActivity,
    categoryId: validation.value.categoryId,
    publishUnit: validation.value.publishUnit,
    audience: validation.value.audience,
    isPublic: validation.value.isPublic,
    status: patch.status === "cancelled" ? "cancelled" : patch.status === "active" ? "active" : current.status,
    academicYear: validation.value.academicYear ?? current.academicYear,
    semester: validation.value.semester ?? current.semester,
    updatedAt: now,
  };
  // 下架原則＝真實刪除：取消的行程連同個人提醒直接刪除（不可恢復）
  if (next.status === "cancelled" && options?.allowHardDelete !== false) {
    const settings = await getCalendarSettings();
    if (settings.policies.hardDeleteCancelled) {
      await hardDeleteCalendarEvent(id);
      invalidateCalendarCache();
      return { deleted: true };
    }
  }
  await ref.set(calendarEventToFirestore(next), { merge: false });
  invalidateCalendarCache();
  return { deleted: false };
}

/** 取消行程。回傳 `deleted=true` 表示因下架原則被真實刪除 */
export async function cancelCalendarEvent(
  id: string,
  options?: { allowHardDelete?: boolean }
): Promise<{ deleted: boolean }> {
  return updateCalendarEvent(id, { sourceModule: "calendar", status: "cancelled" }, options);
}

/**
 * 無條件真實刪除單則行程及其所有個人提醒文件（管理端「刪除」鈕）。
 * 不看「下架行程真實刪除」原則，一律硬刪除（不可恢復）。
 */
export async function deleteCalendarEventHard(id: string): Promise<void> {
  await hardDeleteCalendarEvent(id);
  invalidateCalendarCache();
}

/** 批次上限：單次請求最多處理的行程數（頁面勾選範圍） */
const BATCH_IDS_MAX = 200;

/**
 * 批次取消（管理端勾選後批次作業）。
 * 原則「下架行程真實刪除」開啟時改為連同個人提醒硬刪除。
 * 回傳實際取消與真實刪除的筆數（查無者略過）。
 */
export async function batchCancelCalendarEvents(
  ids: string[],
  options?: { allowHardDelete?: boolean }
): Promise<{ cancelled: number; deleted: number }> {
  const unique = [...new Set(ids)].slice(0, BATCH_IDS_MAX);
  if (unique.length === 0) return { cancelled: 0, deleted: 0 };
  const settings = await getCalendarSettings();
  if (settings.policies.hardDeleteCancelled && options?.allowHardDelete !== false) {
    const deleted = await batchDeleteCalendarEventsHard(unique);
    return { cancelled: 0, deleted };
  }
  const db = getAdminDbRaw();
  // getAll 分塊 200：先確認存在再批次更新（update 對不存在的文件會使整批失敗）
  const existing: string[] = [];
  for (let i = 0; i < unique.length; i += 200) {
    const snaps = await db.getAll(
      ...unique.slice(i, i + 200).map((id) => db.collection(CALENDAR_COLLECTION).doc(id))
    );
    snaps.forEach((snap) => {
      if (snap.exists) existing.push(snap.id);
    });
  }
  if (existing.length > 0) {
    const now = Date.now();
    const batch = db.batch();
    existing.forEach((id) => {
      batch.update(db.collection(CALENDAR_COLLECTION).doc(id), {
        status: "cancelled",
        updatedAt: now,
      });
    });
    await batch.commit();
    invalidateCalendarCache();
  }
  return { cancelled: existing.length, deleted: 0 };
}

/**
 * 無條件批次真實刪除行程及其所有個人提醒文件（管理端批次「刪除」）。
 * 不看「下架行程真實刪除」原則；刪除不存在的文件為無害空操作。
 */
export async function batchDeleteCalendarEventsHard(ids: string[]): Promise<number> {
  const unique = [...new Set(ids)].slice(0, BATCH_IDS_MAX);
  if (unique.length === 0) return 0;
  const db = getAdminDbRaw();
  const reminderIds: string[] = [];
  for (let i = 0; i < unique.length; i += IN_QUERY_CHUNK) {
    const remSnap = await db
      .collection(CALENDAR_REMINDERS_COLLECTION)
      .where("eventId", "in", unique.slice(i, i + IN_QUERY_CHUNK))
      .get();
    remSnap.docs.forEach((doc) => reminderIds.push(doc.id));
  }
  const refs = [
    ...unique.map((id) => db.collection(CALENDAR_COLLECTION).doc(id)),
    ...reminderIds.map((rid) => db.collection(CALENDAR_REMINDERS_COLLECTION).doc(rid)),
  ];
  await deleteInBatches(db, refs);
  invalidateCalendarCache();
  return unique.length;
}

/** 真實刪除單則行程及其所有個人提醒文件（下架原則＝真實刪除時使用） */
async function hardDeleteCalendarEvent(id: string): Promise<void> {
  const db = getAdminDbRaw();
  const remSnap = await db
    .collection(CALENDAR_REMINDERS_COLLECTION)
    .where("eventId", "==", id)
    .get();
  const refs = [
    db.collection(CALENDAR_COLLECTION).doc(id),
    ...remSnap.docs.map((doc) => db.collection(CALENDAR_REMINDERS_COLLECTION).doc(doc.id)),
  ];
  await deleteInBatches(db, refs);
}

async function deleteInBatches(db: ReturnType<typeof getAdminDbRaw>, refs: DocumentReference[]) {
  for (let i = 0; i < refs.length; i += DELETE_BATCH_LIMIT) {
    const batch = db.batch();
    refs.slice(i, i + DELETE_BATCH_LIMIT).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

/**
 * 行程原則「下架行程真實刪除」的批次清除：
 * 掃描已取消的行程，連同個人提醒一併刪除。
 * 單欄位等值查詢＋`limit`（鐵律 2、3），個人提醒以 `in` 30 值／批（鐵律 4）；
 * 由管理端清單載入時呼叫（policies.hardDeleteCancelled=true 才會執行）。
 */
export async function purgeDownCalendarEvents(): Promise<number> {
  const db = getAdminDbRaw();
  const snap = await db
    .collection(CALENDAR_COLLECTION)
    .where("status", "==", "cancelled")
    .limit(PURGE_SCAN_LIMIT)
    .get();
  const ids = snap.docs.map((doc) => doc.id);
  if (ids.length === 0) return 0;

  const reminderIds: string[] = [];
  for (let i = 0; i < ids.length; i += IN_QUERY_CHUNK) {
    const remSnap = await db
      .collection(CALENDAR_REMINDERS_COLLECTION)
      .where("eventId", "in", ids.slice(i, i + IN_QUERY_CHUNK))
      .get();
    remSnap.docs.forEach((doc) => reminderIds.push(doc.id));
  }

  const refs = [
    ...ids.map((id) => db.collection(CALENDAR_COLLECTION).doc(id)),
    ...reminderIds.map((rid) => db.collection(CALENDAR_REMINDERS_COLLECTION).doc(rid)),
  ];
  await deleteInBatches(db, refs);
  invalidateCalendarCache();
  return ids.length;
}

/** 是否可由該身分編輯：管理員＝全部；教職員＝僅自己建立的 */
export function canEditCalendarEvent(
  record: CalendarEventRecord,
  session: { uid: string; role: UserRole }
): boolean {
  if (session.role === "admin") return true;
  if (session.role !== "staff") return false;
  return record.createdBy.uid === session.uid;
}

/** 讀取單則行程（管理端編輯用） */
export async function getCalendarEvent(id: string): Promise<CalendarEventRecord | null> {
  const snap = await getAdminDbRaw().collection(CALENDAR_COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return readCalendarEventRecord(id, snap.data());
}

/**
 * 管理端清單（含已取消；不做受眾過濾）。
 * `orderBy("startAt","desc")` 為單欄位排序，走自動索引、不需複合索引。
 */
export async function listAdminCalendarEvents(): Promise<AdminCalendarEventRow[]> {
  const settings = await getCalendarSettings();
  const snap = await getAdminDbRaw()
    .collection(CALENDAR_COLLECTION)
    .orderBy("startAt", "desc")
    .limit(ADMIN_LIST_LIMIT)
    .get();
  const rows: AdminCalendarEventRow[] = [];
  for (const doc of snap.docs) {
    const record = readCalendarEventRecord(doc.id, doc.data());
    if (!record) continue;
    rows.push({ ...record, categoryName: calendarCategoryName(settings, record.categoryId) });
  }
  rows.sort((a, b) => b.startAt - a.startAt || b.createdAt - a.createdAt);
  return rows;
}

/**
 * 行程狀態統計（省流模式的輕量數據）：Firestore count 聚合——
 * 每個計數僅 1 次讀取（不載入文件內容），比載入整份清單省流。
 * 回傳「顯示中（active，未取消）」與「已取消」兩筆。
 */
export async function countCalendarEventsByStatus(): Promise<{
  active: number;
  cancelled: number;
}> {
  const col = getAdminDbRaw().collection(CALENDAR_COLLECTION);
  const [activeSnap, cancelledSnap] = await Promise.all([
    col.where("status", "==", "active").count().get(),
    col.where("status", "==", "cancelled").count().get(),
  ]);
  return {
    active: activeSnap.data().count,
    cancelled: cancelledSnap.data().count,
  };
}

export interface CalendarListQuery {
  /** null＝未登入公開模式（只回閱讀權限「無」且不限班級的公開行程） */
  role: UserRole | null;
  classCode?: string | null;
  /** 顯示起點（epoch ms）；預設今日零時 */
  from?: number;
}

/**
 * 各身分行程列表：僅下推 `startAt` 單欄位（**免複合索引**，與顯示區／管理端清單
 * 同策略——舊版下推 status＋audienceRoles 需複合索引，開發專案缺索引時整頁 500）；
 * status／受眾與班級於記憶體過濾（量級以 LIST_LIMIT 有界，鐵律 3）。
 * `role: null`＝未登入公開模式：只回 `isCalendarEventPublicReadable` 的行程。
 * 15 秒 cachedRead，寫入後由 `invalidateCalendarCache()` 清前綴失效。
 */
export async function listCalendarEvents(
  query: CalendarListQuery
): Promise<CalendarEventItem[]> {
  const { role, classCode } = query;
  const from = typeof query.from === "number" && query.from > 0 ? query.from : startOfTodayMs();
  const cacheKey = `${LIST_CACHE_PREFIX}${role ?? "public"}:${classCode || "*"}:${from}`;
  return cachedRead(cacheKey, LIST_TTL_MS, async () => {
    const settings = await getCalendarSettings();
    const snap = await getAdminDbRaw()
      .collection(CALENDAR_COLLECTION)
      .where("startAt", ">=", from)
      .orderBy("startAt")
      .limit(LIST_LIMIT)
      .get();
    const now = Date.now();
    const items: CalendarEventItem[] = [];
    for (const doc of snap.docs) {
      const record = readCalendarEventRecord(doc.id, doc.data());
      if (!record) continue;
      if (!isCalendarEventActive(record, now)) continue;
      if (role === null) {
        if (!isCalendarEventPublicReadable(record)) continue;
      } else if (!canViewCalendarEvent(record.audience, role, classCode)) {
        continue;
      }
      items.push(calendarEventToItem(record, calendarCategoryName(settings, record.categoryId)));
    }
    items.sort((a, b) => a.startAt - b.startAt || a.createdAt - b.createdAt);
    return items;
  });
}

export interface CalendarSurfaceQuery {
  surface: CalendarSurface;
  /** null＝未登入（僅 `login` 顯示位置允許；只取閱讀權限「無」的公開行程） */
  role: UserRole | null;
  classCode?: string | null;
}

/**
 * 顯示位置（系統首頁登入表單上方／四種身分功能首頁）的行程：
 * 尚未結束的行程中，依開始時間取最近的前 `limit` 則（該位置「顯示筆數」設定，
 * 預設 5；前端以上下箭頭逐則翻頁）。
 *
 * 查詢策略（與管理端清單一致）：僅下推 `startAt` 單欄位（走自動索引、**免複合索引**，
 * 任何 Firestore 專案開箱即用——曾因開發專案缺複合索引導致四個顯示區全掛）；
 * status／尚未結束／受眾（含管理員豁免、未登入公開判定）全在記憶體過濾，
 * 量級以 SURFACE_FETCH_LIMIT 有界（鐵律 3），15 秒 `cachedRead` 摊平讀取成本
 * （寫入後由 `invalidateCalendarCache()` 清 `calendar:` 前綴失效）。
 * 管理員比照提醒列表與管理端清單：不受受眾限制（校務視角）。
 */
export async function listSurfaceCalendarEvents(
  query: CalendarSurfaceQuery,
  limit: number = 1
): Promise<CalendarSurfaceItem[]> {
  const { surface, role, classCode } = query;
  const take = Math.min(Math.max(Math.round(limit) || 1, 1), 20);
  const from = startOfTodayMs();
  const cacheKey = `${LIST_CACHE_PREFIX}surface:${surface}:${role ?? "guest"}:${
    classCode || "*"
  }:${take}`;
  return cachedRead(cacheKey, SURFACE_TTL_MS, async () => {
    const settings = await getCalendarSettings();
    const isAdmin = role === "admin";
    const snap = await getAdminDbRaw()
      .collection(CALENDAR_COLLECTION)
      .where("startAt", ">=", from)
      .orderBy("startAt")
      .limit(SURFACE_FETCH_LIMIT)
      .get();
    const now = Date.now();
    const records: CalendarEventRecord[] = [];
    for (const doc of snap.docs) {
      const record = readCalendarEventRecord(doc.id, doc.data());
      if (!record) continue;
      if (!isCalendarEventActive(record, now)) continue;
      // 顯示「尚未結束」的行程（進行中與未來皆可）
      if (calendarEventEnd(record) < now) continue;
      if (role) {
        if (!isAdmin && !canViewCalendarEvent(record.audience, role, classCode)) continue;
      } else {
        // 未登入（系統首頁）：只顯示閱讀權限「無」（isPublic）的公開行程
        if (!isCalendarEventPublicReadable(record)) continue;
      }
      records.push(record);
    }
    records.sort((a, b) => a.startAt - b.startAt || a.createdAt - b.createdAt);
    return records.slice(0, take).map((record) => ({
      id: record.id,
      title: record.title,
      startAt: record.startAt,
      endAt: record.endAt,
      allDayDate: record.allDayDate,
      important: record.important,
      categoryId: record.categoryId,
      categoryName: calendarCategoryName(settings, record.categoryId),
      sourceModule: record.sourceModule,
      publishUnit: record.publishUnit,
    }));
  });
}

/**
 * 公開行事曆頁（未登入可瀏覽）：僅以 startAt 單欄位查詢（免複合索引），
 * 狀態與公開性記憶體過濾（量級以 SURFACE_FETCH_LIMIT 有界，鐵律 3）。
 * 15 秒 cachedRead，寫入後由 invalidateCalendarCache() 清前綴失效。
 */
export async function listPublicCalendarEvents(limit: number = 20): Promise<CalendarSurfaceItem[]> {
  const take = Math.min(Math.max(Math.round(limit) || 1, 1), 20);
  const cacheKey = `${LIST_CACHE_PREFIX}public:upcoming:${take}`;
  return cachedRead(cacheKey, SURFACE_TTL_MS, async () => {
    const settings = await getCalendarSettings();
    const from = startOfTodayMs();
    const snap = await getAdminDbRaw()
      .collection(CALENDAR_COLLECTION)
      .where("startAt", ">=", from)
      .orderBy("startAt")
      .limit(SURFACE_FETCH_LIMIT)
      .get();
    const now = Date.now();
    const records: CalendarEventRecord[] = [];
    for (const doc of snap.docs) {
      const record = readCalendarEventRecord(doc.id, doc.data());
      if (!record) continue;
      if (!isCalendarEventActive(record, now)) continue;
      if (calendarEventEnd(record) < now) continue;
      if (!isCalendarEventPublicReadable(record)) continue;
      records.push(record);
    }
    records.sort((a, b) => a.startAt - b.startAt || a.createdAt - b.createdAt);
    return records.slice(0, take).map((record) => ({
      id: record.id,
      title: record.title,
      startAt: record.startAt,
      endAt: record.endAt,
      allDayDate: record.allDayDate,
      important: record.important,
      categoryId: record.categoryId,
      categoryName: calendarCategoryName(settings, record.categoryId),
      sourceModule: record.sourceModule,
      publishUnit: record.publishUnit,
    }));
  });
}

/**
 * 公開行事曆專頁：區間查詢（startAt 單欄位範圍，免複合索引）。
 * 狀態＝active，於記憶體過濾；`viewerIsAdmin`＝檢視者為管理員時放行全部行程
 * （比照管理端視角——管理員在檢視頁也應看得到僅限管理員的行程），否則只回公開行程。
 * 取量以 limit 有界（≤200，鐵律 3）。同日同區間 cachedRead（15 秒），
 * 寫入後由 invalidateCalendarCache() 清前綴失效。
 */
export async function listPublicCalendarEventsInRange(
  fromMs: number,
  toMs: number,
  limit: number = 200,
  viewerIsAdmin = false
): Promise<CalendarSurfaceItem[]> {
  const take = Math.min(Math.max(Math.round(limit) || 1, 1), 200);
  const dayBucket = Math.floor(fromMs / 86_400_000);
  const cacheKey = `${LIST_CACHE_PREFIX}public:range:${dayBucket}:${toMs}:${take}:${
    viewerIsAdmin ? "admin" : "guest"
  }`;
  return cachedRead(cacheKey, SURFACE_TTL_MS, async () => {
    const settings = await getCalendarSettings();
    // 回溯限制【管理員設定 policies.publicPastMonths】：起點鉗制在允許的最早月初
    const earliestFrom = computePublicCalendarEarliestFrom(settings.policies.publicPastMonths ?? 1);
    const effectiveFrom = Math.max(fromMs, earliestFrom);
    const snap = await getAdminDbRaw()
      .collection(CALENDAR_COLLECTION)
      .where("startAt", ">=", effectiveFrom)
      .where("startAt", "<=", toMs)
      .orderBy("startAt")
      .limit(take)
      .get();
    const records: CalendarEventRecord[] = [];
    for (const doc of snap.docs) {
      const record = readCalendarEventRecord(doc.id, doc.data());
      if (!record) continue;
      if (record.status !== "active") continue;
      if (!viewerIsAdmin && !isCalendarEventPublicReadable(record)) continue;
      if (calendarEventEnd(record) < effectiveFrom) continue;
      records.push(record);
    }
    records.sort((a, b) => a.startAt - b.startAt || a.createdAt - b.createdAt);
    return records.slice(0, take).map((record) => ({
      id: record.id,
      title: record.title,
      startAt: record.startAt,
      endAt: record.endAt,
      allDayDate: record.allDayDate,
      allDay: typeof record.allDayDate === "string" && record.allDayDate !== "",
      location: record.location,
      important: record.important,
      categoryId: record.categoryId,
      categoryName: calendarCategoryName(settings, record.categoryId),
      sourceModule: record.sourceModule,
      publishUnit: record.publishUnit,
    }));
  });
}

/**
 * 儲存模組設定（管理端；整份覆寫 settings/calendar） */
export async function saveCalendarSettings(input: {
  categories?: CalendarCategory[];
  defaultRemindersEnabled?: boolean;
  surfaces?: Partial<CalendarSurfaces>;
  policies?: Partial<CalendarPolicies>;
}): Promise<CalendarSettings> {
  const current = await getCalendarSettings();
  const base = Array.isArray(input.categories)
    ? input.categories
        .map((item, index) => ({
          id: typeof item.id === "string" ? item.id.trim().slice(0, 64) : "",
          name: typeof item.name === "string" ? item.name.trim().slice(0, 64) : "",
          sortOrder: typeof item.sortOrder === "number" ? item.sortOrder : index,
          enabled: item.enabled !== false,
        }))
        .filter((item) => item.id && item.name)
    : current.categories;
  const safe = base.length > 0 ? base : [...DEFAULT_CALENDAR_CATEGORIES];
  // 後備類型「其他」不可被刪除：即使管理端刪掉也補回並強制啟用
  const categories = ensureFallbackCategory(safe, CALENDAR_FALLBACK_CATEGORY_ID, () =>
    defaultCalendarFallbackCategory(safe.length)
  );
  // 顯示位置：逐 key 套用；未提供的 key 沿用現值（缺欄位時退回預設）
  const surfaces: CalendarSurfaces = {
    ...defaultCalendarSurfaces(),
    ...current.surfaces,
  };
  if (input.surfaces && typeof input.surfaces === "object") {
    for (const key of CALENDAR_SURFACES) {
      const patch = input.surfaces[key];
      if (!patch || typeof patch !== "object") continue;
      surfaces[key] = {
        enabled: patch.enabled !== false,
        limit: normalizeCalendarSurfaceLimit(patch.limit),
      };
    }
  }
  // 行程原則：逐 key 套用；未提供的欄位沿用現值（缺欄位時退回預設）
  const policies: CalendarPolicies = {
    ...DEFAULT_CALENDAR_POLICIES,
    ...current.policies,
  };
  if (input.policies && typeof input.policies === "object") {
    const patch = input.policies;
    if (typeof patch.hardDeleteCancelled === "boolean") {
      policies.hardDeleteCancelled = patch.hardDeleteCancelled;
    }
    if (typeof patch.publicPastMonths === "number") {
      policies.publicPastMonths = normalizePublicPastMonths(patch.publicPastMonths);
    }
  }
  const next: CalendarSettings = {
    categories,
    defaultRemindersEnabled:
      typeof input.defaultRemindersEnabled === "boolean"
        ? input.defaultRemindersEnabled
        : current.defaultRemindersEnabled,
    surfaces,
    policies,
  };
  await getAdminDbRaw()
    .collection("settings")
    .doc(CALENDAR_SETTINGS_DOC_ID)
    .set(next, { merge: false });
  invalidateCalendarCache();
  return next;
}

function reminderDocId(eventId: string, uid: string): string {
  return `${eventId}_${uid}`;
}

/**
 * 切換個人行程提醒：已設定則取消，未設定則建立。
 * 回傳 `reminded=true` 表示目前為「已設定」（非推播，開啟頁面才更新）。
 */
export async function toggleCalendarReminder(
  uid: string,
  eventId: string
): Promise<{ reminded: boolean }> {
  if (!uid || !eventId) throw new Error("缺少使用者或行程識別");
  const event = await getCalendarEvent(eventId);
  if (!event || !isCalendarEventActive(event)) {
    throw new Error("行程不存在或已無法提醒");
  }
  const db = getAdminDbRaw();
  const ref = db.collection(CALENDAR_REMINDERS_COLLECTION).doc(reminderDocId(eventId, uid));
  const snap = await ref.get();
  if (snap.exists) {
    await ref.delete();
    return { reminded: false };
  }
  await ref.set({ eventId, uid, createdAt: Date.now() });
  return { reminded: true };
}

/** 使用者已設定提醒的行程 id 清單（不做跨請求快取：提醒變動頻繁） */
export async function listMyCalendarReminderIds(uid: string): Promise<string[]> {
  if (!uid) return [];
  const snap = await getAdminDbRaw()
    .collection(CALENDAR_REMINDERS_COLLECTION)
    .where("uid", "==", uid)
    .limit(REMINDER_LIMIT)
    .get();
  return snap.docs.map((doc) => doc.data().eventId).filter((id): id is string => !!id);
}

/**
 * 個人提醒列表（鈴鐺／提醒區）：
 * 讀提醒文件 → 分塊批次讀行程（200／批，鐵律 4）→ 確認仍 active 且受眾涵蓋身分＋班級。
 */
export async function listMyCalendarReminders(
  uid: string,
  role: UserRole,
  classCode?: string | null
): Promise<CalendarReminderItem[]> {
  if (!uid) return [];
  const settings = await getCalendarSettings();
  const snap = await getAdminDbRaw()
    .collection(CALENDAR_REMINDERS_COLLECTION)
    .where("uid", "==", uid)
    .limit(REMINDER_LIMIT)
    .get();
  const reminderRows = snap.docs.map((doc) => {
    const data = doc.data();
    return {
      eventId: typeof data.eventId === "string" ? data.eventId : "",
      createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    };
  });
  const ids = [...new Set(reminderRows.map((row) => row.eventId).filter(Boolean))];
  if (ids.length === 0) return [];

  const db = getAdminDbRaw();
  const eventMap = new Map<string, CalendarEventRecord>();
  for (let i = 0; i < ids.length; i += GET_ALL_CHUNK) {
    const chunk = ids.slice(i, i + GET_ALL_CHUNK);
    const snaps = await db.getAll(
      ...chunk.map((eventId) => db.collection(CALENDAR_COLLECTION).doc(eventId))
    );
    snaps.forEach((item, index) => {
      if (!item.exists) return;
      const record = readCalendarEventRecord(chunk[index], item.data());
      if (record) eventMap.set(chunk[index], record);
    });
  }

  const now = Date.now();
  const items: CalendarReminderItem[] = [];
  for (const row of reminderRows) {
    const event = eventMap.get(row.eventId);
    if (!event || !isCalendarEventActive(event, now)) continue;
    if (role !== "admin" && !canViewCalendarEvent(event.audience, role, classCode)) continue;
    items.push({
      eventId: event.id,
      title: event.title,
      description: event.description,
      location: event.location,
      startAt: event.startAt,
      endAt: event.endAt,
      allDayDate: event.allDayDate,
      important: event.important,
      categoryName: calendarCategoryName(settings, event.categoryId),
      classScoped: audienceClassScoped(event.audience),
      createdAt: row.createdAt,
    });
  }
  items.sort((a, b) => a.startAt - b.startAt);
  return items;
}
