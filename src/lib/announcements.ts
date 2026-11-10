import "server-only";
import type { DocumentReference } from "firebase-admin/firestore";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import { cachedRead, cachedSettingDoc, invalidateReadCache } from "@/lib/read-cache";
import { invalidateAdminListCache } from "@/lib/list-cache";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  ANNOUNCEMENTS_COLLECTION,
  ANNOUNCEMENT_REMINDERS_COLLECTION,
  ANNOUNCEMENT_SETTINGS_DOC_ID,
  ANNOUNCEMENT_SURFACES,
  AnnouncementAudience,
  AnnouncementCategory,
  AnnouncementRecord,
  AnnouncementPolicies,
  AnnouncementReminderItem,
  AnnouncementSettings,
  AnnouncementSurface,
  AnnouncementSurfaceItem,
  AnnouncementArchiveItem,
  AnnouncementSurfaces,
  announcementCategoryName,
  announcementToFirestore,
  ANNOUNCEMENT_FALLBACK_CATEGORY_ID,
  audienceClassScoped,
  defaultAnnouncementFallbackCategory,
  defaultAnnouncementSurfaces,
  DEFAULT_ANNOUNCEMENT_CATEGORIES,
  DEFAULT_ANNOUNCEMENT_POLICIES,
  DEFAULT_ANNOUNCEMENT_SETTINGS,
  isAnnouncementReadable,
  isExpiringSoon,
  normalizeSurfaceLimit,
  normalizeSurfaceMethod,
  readAnnouncementRecord,
  readAnnouncementSettings,
  validateAnnouncementInput,
  type AnnouncementInboxItem,
} from "@/types/announcements";
import { UserRole } from "@/types/users";
import { ensureFallbackCategory } from "@/types/category";

/**
 * 公告功能模組（server-only）。
 *
 * 跨模組公告接口協議（其他模組請照此呼叫，勿自開平行集合）：
 * 1. 只寫 `announcements` 集合；
 * 2. `sourceModule` 必填（公告頁自己發文＝"announcements"）；
 * 3. 受眾必須明確（roles＋必要時 classCodes），不可無界；
 * 4. 寫入成功後呼叫 `invalidateAnnouncementsCache()`（本函式已內建）；
 * 5. 更新／撤回走 `updateFromModule`（P5，以 sourceModule+sourceRef 定位）。
 *
 * 讀取：管理端清單直讀＋排序；收件匣走 15 秒 cachedRead，
 * 寫入後以 invalidateReadCache("announcements:") 清本機（跨實例上限＝TTL）。
 */

const INBOX_CACHE_PREFIX = "announcements:inbox:";
const SURFACE_CACHE_PREFIX = "announcements:surface:";
const ARCHIVE_CACHE_PREFIX = "announcements:archive:";
const INBOX_TTL_MS = 15_000;
const ADMIN_LIST_LIMIT = 100;
const INBOX_LIMIT = 50;
/** 顯示位置一次取回的上限（排序後再依設定筆數截斷） */
const SURFACE_FETCH_LIMIT = 30;
/** 公告專頁一次取回的上限（前端再分頁切片，0 額外 Firestore 讀取） */
const ARCHIVE_LIMIT = 100;
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** 真實刪除一張 WriteBatch 的文件上限（留餘裕） */
const DELETE_BATCH_LIMIT = 400;
/** `in` 查詢每批上限（Firestore 上限 30） */
const IN_QUERY_CHUNK = 30;
/** 真實刪除掃描封存／到期公告的單次上限 */
const PURGE_SCAN_LIMIT = 200;

/**
 * 公告原則「強制到期時間下架」：到期時間留空時，
 * 自動補上發布後一個月（已填到期時間者維持原值）。
 */
function resolveExpireAt(
  value: { publishAt: number; expireAt?: number },
  forceExpire: boolean
): number | undefined {
  if (value.expireAt) return value.expireAt;
  if (!forceExpire) return undefined;
  return Math.max(value.publishAt, Date.now()) + ONE_MONTH_MS;
}

/** 讀取公告模組設定（settings/announcements，30 秒快取） */
export async function getAnnouncementSettings(): Promise<AnnouncementSettings> {
  try {
    const raw = await cachedSettingDoc(ANNOUNCEMENT_SETTINGS_DOC_ID, async () => {
      const snap = await getAdminDbRaw()
        .collection("settings")
        .doc(ANNOUNCEMENT_SETTINGS_DOC_ID)
        .get();
      return snap.exists ? (snap.data() ?? null) : null;
    });
    return readAnnouncementSettings(raw);
  } catch {
    return {
      ...DEFAULT_ANNOUNCEMENT_SETTINGS,
      categories: [...DEFAULT_ANNOUNCEMENT_CATEGORIES],
    };
  }
}

/** 公告變更後：清收件匣／顯示位置／公告專頁快取＋管理端清單（epoch） */
export function invalidateAnnouncementsCache(): void {
  invalidateReadCache(INBOX_CACHE_PREFIX);
  invalidateReadCache(SURFACE_CACHE_PREFIX);
  invalidateReadCache(ARCHIVE_CACHE_PREFIX);
  // 管理端清單若日後改用 cachedListRead，epoch 遞增會一併涵蓋；
  // 目前管理清單直讀＋短 TTL，此呼叫同步清 settings 相關無害
  void invalidateAdminListCache();
}

export interface PublishFromModuleInput {
  sourceModule: string;
  sourceRef?: string;
  title: string;
  body: string;
  authorUid: string;
  authorName: string;
  authorRole: UserRole;
  audience: AnnouncementAudience;
  /** 閱讀權限＝「無」（公開，不需登入可見） */
  isPublic?: boolean;
  categoryId?: string;
  publishAt?: number;
  expireAt?: number | null;
  pinned?: boolean;
}

/**
 * 跨模組發佈公告：其他功能模組（補修、行事曆…）在伺服器端直接呼叫。
 * 校驗失敗拋錯；成功回傳新公告 id。
 */
export async function publishFromModule(input: PublishFromModuleInput): Promise<{ id: string }> {
  const sourceModule = typeof input.sourceModule === "string" ? input.sourceModule.trim() : "";
  if (!sourceModule) {
    throw new Error("publishFromModule: sourceModule 必填");
  }
  const validation = validateAnnouncementInput({
    title: input.title,
    body: input.body,
    categoryId: input.categoryId,
    audience: input.audience,
    isPublic: input.isPublic,
    publishAt: input.publishAt,
    expireAt: input.expireAt ?? null,
    pinned: input.pinned,
  });
  if (!validation.ok) {
    throw new Error(`publishFromModule: ${validation.message}`);
  }

  const period = await getCurrentPeriod();
  const settings = await getAnnouncementSettings();
  const now = Date.now();
  const record: Omit<AnnouncementRecord, "id"> = {
    title: validation.value.title,
    body: validation.value.body,
    categoryId: validation.value.categoryId,
    sourceModule,
    sourceRef: input.sourceRef,
    authorUid: input.authorUid,
    authorName: input.authorName,
    authorRole: input.authorRole,
    audience: validation.value.audience,
    isPublic: validation.value.isPublic,
    status: "published",
    publishAt: validation.value.publishAt,
    expireAt: resolveExpireAt(validation.value, settings.policies.forceExpire),
    academicYear: period.academicYear,
    semester: period.semester === 2 ? 2 : 1,
    pinned: settings.policies.enablePinned && validation.value.pinned,
    createdAt: now,
    updatedAt: now,
  };

  const ref = await getAdminDbRaw()
    .collection(ANNOUNCEMENTS_COLLECTION)
    .add(announcementToFirestore(record));
  invalidateAnnouncementsCache();
  return { id: ref.id };
}

export interface CreateAnnouncementInput extends PublishFromModuleInput {
  /** 管理端可覆寫狀態；教職員發佈固定 published */
  status?: "published" | "archived";
}

/** 管理端／教職員建立公告（內部共用） */
export async function createAnnouncement(input: CreateAnnouncementInput): Promise<{ id: string }> {
  return publishFromModule(input);
}

/** 更新公告（僅改可編輯欄位；id 固定）。回傳 `deleted=true` 表示因下架原則被真實刪除 */
export async function updateAnnouncement(
  id: string,
  patch: {
    title?: string;
    body?: string;
    categoryId?: string;
    audience?: AnnouncementAudience;
    isPublic?: boolean;
    publishAt?: number;
    expireAt?: number | null;
    pinned?: boolean;
    status?: "published" | "archived";
  }
): Promise<{ deleted: boolean }> {
  const db = getAdminDbRaw();
  const ref = db.collection(ANNOUNCEMENTS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("查無此公告");
  const current = readAnnouncementRecord(id, snap.data());
  if (!current) throw new Error("公告資料毀損");

  const settings = await getAnnouncementSettings();
  const validation = validateAnnouncementInput({
    title: patch.title ?? current.title,
    body: patch.body ?? current.body,
    categoryId: patch.categoryId ?? current.categoryId,
    audience: patch.audience ?? current.audience,
    isPublic: patch.isPublic === undefined ? current.isPublic : patch.isPublic,
    publishAt: patch.publishAt ?? current.publishAt,
    expireAt: patch.expireAt === undefined ? (current.expireAt ?? null) : patch.expireAt,
    pinned: settings.policies.enablePinned && (patch.pinned ?? current.pinned),
    academicYear: current.academicYear,
    semester: current.semester,
  });
  if (!validation.ok) throw new Error(validation.message);

  const next: Omit<AnnouncementRecord, "id"> = {
    ...current,
    title: validation.value.title,
    body: validation.value.body,
    categoryId: validation.value.categoryId,
    audience: validation.value.audience,
    isPublic: validation.value.isPublic,
    publishAt: validation.value.publishAt,
    expireAt: resolveExpireAt(validation.value, settings.policies.forceExpire),
    pinned: validation.value.pinned,
    status: patch.status ?? current.status,
    updatedAt: Date.now(),
  };
  // 下架原則＝真實刪除：封存的公告連同個人提醒直接刪除（不可恢復）
  if (next.status === "archived" && settings.policies.hardDeleteExpired) {
    await hardDeleteAnnouncement(id);
    invalidateAnnouncementsCache();
    return { deleted: true };
  }
  await ref.update(announcementToFirestore(next));
  invalidateAnnouncementsCache();
  return { deleted: false };
}

/** 封存公告。回傳 `deleted=true` 表示因下架原則被真實刪除 */
export async function archiveAnnouncement(id: string): Promise<{ deleted: boolean }> {
  return updateAnnouncement(id, { status: "archived" });
}

export interface UpdateFromModuleInput {
  sourceModule: string;
  sourceRef: string;
  title?: string;
  body?: string;
  categoryId?: string;
  audience?: AnnouncementAudience;
  isPublic?: boolean;
  publishAt?: number;
  expireAt?: number | null;
  pinned?: boolean;
  /** archived ＝ 撤回（下架但保留文件供對帳）；published ＝ （重新）上架 */
  status?: "published" | "archived";
}

/**
 * P5 跨模組更新／撤回公告：以 sourceModule+sourceRef 定位並更新。
 * 查無對應公告時回 { updated: 0 }（未發佈過是合法狀態，不拋錯——
 * 讓來源端可在「可能從未發佈」時安全呼叫）。
 * status: "archived" 即撤回語意；若系統「下架即真實刪除」原則開啟，
 * 由 updateAnnouncement 內建轉為硬刪除（含個人提醒）。
 */
export async function updateFromModule(
  input: UpdateFromModuleInput
): Promise<{ updated: number }> {
  const sourceModule = typeof input.sourceModule === "string" ? input.sourceModule.trim() : "";
  if (!sourceModule) {
    throw new Error("updateFromModule: sourceModule 必填");
  }
  const sourceRef = typeof input.sourceRef === "string" ? input.sourceRef.trim() : "";
  if (!sourceRef) {
    throw new Error("updateFromModule: sourceRef 必填（更新／撤回需可定位來源）");
  }

  const snap = await getAdminDbRaw()
    .collection(ANNOUNCEMENTS_COLLECTION)
    .where("sourceModule", "==", sourceModule)
    .where("sourceRef", "==", sourceRef)
    .get();
  if (snap.empty) return { updated: 0 };

  const patch = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
    ...(input.audience !== undefined ? { audience: input.audience } : {}),
    ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
    ...(input.publishAt !== undefined ? { publishAt: input.publishAt } : {}),
    ...(input.expireAt !== undefined ? { expireAt: input.expireAt } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };

  let updated = 0;
  for (const doc of snap.docs) {
    await updateAnnouncement(doc.id, patch);
    updated += 1;
  }
  return { updated };
}

/**
 * 無條件真實刪除單則公告及其所有個人提醒文件（管理端「刪除」鈕）。
 * 不看「下架公告真實刪除」原則，一律硬刪除（不可恢復）。
 */
export async function deleteAnnouncementHard(id: string): Promise<void> {
  await hardDeleteAnnouncement(id);
  invalidateAnnouncementsCache();
}

/** 批次上限：單次請求最多處理的公告數（頁面勾選範圍） */
const BATCH_IDS_MAX = 200;

/**
 * 批次封存（管理端勾選後批次作業）。
 * 原則「下架公告真實刪除」開啟時改為連同個人提醒硬刪除。
 * 回傳實際封存與真實刪除的筆數（查無者略過）。
 */
export async function batchArchiveAnnouncements(
  ids: string[]
): Promise<{ archived: number; deleted: number }> {
  const unique = [...new Set(ids)].slice(0, BATCH_IDS_MAX);
  if (unique.length === 0) return { archived: 0, deleted: 0 };
  const settings = await getAnnouncementSettings();
  if (settings.policies.hardDeleteExpired) {
    const deleted = await batchDeleteAnnouncementsHard(unique);
    return { archived: 0, deleted };
  }
  const db = getAdminDbRaw();
  // getAll 分塊 200：先確認存在再批次 update（update 對不存在的文件會使整批失敗）
  const existing: string[] = [];
  for (let i = 0; i < unique.length; i += 200) {
    const snaps = await db.getAll(
      ...unique.slice(i, i + 200).map((id) => db.collection(ANNOUNCEMENTS_COLLECTION).doc(id))
    );
    snaps.forEach((snap) => {
      if (snap.exists) existing.push(snap.id);
    });
  }
  if (existing.length > 0) {
    const now = Date.now();
    const batch = db.batch();
    existing.forEach((id) => {
      batch.update(db.collection(ANNOUNCEMENTS_COLLECTION).doc(id), {
        status: "archived",
        updatedAt: now,
      });
    });
    await batch.commit();
    invalidateAnnouncementsCache();
  }
  return { archived: existing.length, deleted: 0 };
}

/**
 * 無條件批次真實刪除公告及其所有個人提醒文件（管理端批次「刪除」）。
 * 不看「下架公告真實刪除」原則；刪除不存在的文件為無害空操作。
 */
export async function batchDeleteAnnouncementsHard(ids: string[]): Promise<number> {
  const unique = [...new Set(ids)].slice(0, BATCH_IDS_MAX);
  if (unique.length === 0) return 0;
  const db = getAdminDbRaw();
  const reminderIds: string[] = [];
  for (let i = 0; i < unique.length; i += IN_QUERY_CHUNK) {
    const snap = await db
      .collection(ANNOUNCEMENT_REMINDERS_COLLECTION)
      .where("announcementId", "in", unique.slice(i, i + IN_QUERY_CHUNK))
      .get();
    snap.docs.forEach((doc) => reminderIds.push(doc.id));
  }
  const refs = [
    ...unique.map((id) => db.collection(ANNOUNCEMENTS_COLLECTION).doc(id)),
    ...reminderIds.map((rid) => db.collection(ANNOUNCEMENT_REMINDERS_COLLECTION).doc(rid)),
  ];
  await deleteInBatches(db, refs);
  invalidateAnnouncementsCache();
  return unique.length;
}

/** 真實刪除單則公告及其所有個人提醒文件（下架原則＝真實刪除時使用） */
async function hardDeleteAnnouncement(id: string): Promise<void> {
  const db = getAdminDbRaw();
  const remSnap = await db
    .collection(ANNOUNCEMENT_REMINDERS_COLLECTION)
    .where("announcementId", "==", id)
    .get();
  const refs = [
    db.collection(ANNOUNCEMENTS_COLLECTION).doc(id),
    ...remSnap.docs.map((doc) => db.collection(ANNOUNCEMENT_REMINDERS_COLLECTION).doc(doc.id)),
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
 * 公告原則「下架公告真實刪除」的批次清除：
 * 掃描封存與已到期的公告，連同個人提醒一併刪除。
 * 皆為單欄位等值／範圍查詢（status、expireAt），不需複合索引；
 * 由管理端清單載入時呼叫（settings.policies.hardDeleteExpired=true 才會執行）。
 */
export async function purgeDownAnnouncements(): Promise<number> {
  const db = getAdminDbRaw();
  const now = Date.now();
  const ids = new Set<string>();
  const archived = await db
    .collection(ANNOUNCEMENTS_COLLECTION)
    .where("status", "==", "archived")
    .limit(PURGE_SCAN_LIMIT)
    .get();
  archived.docs.forEach((doc) => ids.add(doc.id));
  const expired = await db
    .collection(ANNOUNCEMENTS_COLLECTION)
    .where("expireAt", "<=", now)
    .limit(PURGE_SCAN_LIMIT)
    .get();
  expired.docs.forEach((doc) => ids.add(doc.id));
  if (ids.size === 0) return 0;

  // 個人提醒：announcementId 等值查詢（`in` 每批 30 筆）
  const idList = [...ids];
  const reminderIds: string[] = [];
  for (let i = 0; i < idList.length; i += IN_QUERY_CHUNK) {
    const snap = await db
      .collection(ANNOUNCEMENT_REMINDERS_COLLECTION)
      .where("announcementId", "in", idList.slice(i, i + IN_QUERY_CHUNK))
      .get();
    snap.docs.forEach((doc) => reminderIds.push(doc.id));
  }

  const refs = [
    ...idList.map((id) => db.collection(ANNOUNCEMENTS_COLLECTION).doc(id)),
    ...reminderIds.map((rid) => db.collection(ANNOUNCEMENT_REMINDERS_COLLECTION).doc(rid)),
  ];
  await deleteInBatches(db, refs);
  invalidateAnnouncementsCache();
  return ids.size;
}

export interface AdminAnnouncementRow extends AnnouncementRecord {
  categoryName: string;
}

/** 管理端清單（含封存；不做受眾過濾） */
export async function listAdminAnnouncements(
  options?: { includeArchived?: boolean }
): Promise<AdminAnnouncementRow[]> {
  const settings = await getAnnouncementSettings();
  const snap = await getAdminDbRaw()
    .collection(ANNOUNCEMENTS_COLLECTION)
    .limit(ADMIN_LIST_LIMIT)
    .get();
  const rows: AdminAnnouncementRow[] = [];
  for (const doc of snap.docs) {
    const record = readAnnouncementRecord(doc.id, doc.data());
    if (!record) continue;
    if (!options?.includeArchived && record.status === "archived") continue;
    rows.push({
      ...record,
      categoryName: announcementCategoryName(settings, record.categoryId),
    });
  }
  rows.sort((a, b) => b.publishAt - a.publishAt || b.createdAt - a.createdAt);
  return rows;
}

/**
 * 公告狀態統計（省流模式的輕量數據）：使用 Firestore count 聚合查詢——
 * 每個計數僅計 1 次讀取（不載入任何文件內容），遠比載入整份清單省流。
 * 回傳「發布中（未下架）」與「已封存」兩筆；其他狀態（草稿等）不計。
 */
export async function countAnnouncementsByStatus(): Promise<{
  published: number;
  archived: number;
}> {
  const col = getAdminDbRaw().collection(ANNOUNCEMENTS_COLLECTION);
  const [publishedSnap, archivedSnap] = await Promise.all([
    col.where("status", "==", "published").count().get(),
    col.where("status", "==", "archived").count().get(),
  ]);
  return {
    published: publishedSnap.data().count,
    archived: archivedSnap.data().count,
  };
}

export interface InboxQuery {
  role: UserRole;
  classCode?: string | null;
}

/**
 * 角色收件匣：僅下推 `publishAt` 單欄位排序（**免複合索引**，與行事曆同策略——
 * 舊版 status＋audienceRoles 需複合索引，開發專案缺索引時整頁 500）；
 * 狀態／受眾／班級／到期於記憶體過濾（量級以 INBOX_LIMIT 有界，鐵律 3）。
 */
export async function listInboxAnnouncements(
  query: InboxQuery
): Promise<AnnouncementInboxItem[]> {
  const { role, classCode } = query;
  const cacheKey = `${INBOX_CACHE_PREFIX}${role}:${classCode || "*"}`;
  return cachedRead(cacheKey, INBOX_TTL_MS, async () => {
    const settings = await getAnnouncementSettings();
    const snap = await getAdminDbRaw()
      .collection(ANNOUNCEMENTS_COLLECTION)
      .orderBy("publishAt", "desc")
      .limit(INBOX_LIMIT)
      .get();
    const now = Date.now();
    // 置頂原則關閉時：不論資料庫中 pinned 值，一律視為未置頂
    const enablePinned = settings.policies.enablePinned;
    const items: AnnouncementInboxItem[] = [];
    for (const doc of snap.docs) {
      const record = readAnnouncementRecord(doc.id, doc.data());
      if (!record) continue;
      if (!isAnnouncementReadable(record, now)) continue;
      if (!record.audience.roles.includes(role)) continue;
      const scoped = audienceClassScoped(record.audience);
      if (scoped) {
        if (!classCode) continue;
        if (!record.audience.classCodes.includes(classCode)) continue;
      }
      items.push({
        id: record.id,
        title: record.title,
        body: record.body,
        categoryId: record.categoryId,
        categoryName: announcementCategoryName(settings, record.categoryId),
        sourceModule: record.sourceModule,
        authorName: record.authorName,
        authorRole: record.authorRole,
        audienceRoles: record.audience.roles,
        classScoped: scoped,
        classCodes: record.audience.classCodes,
        isPublic: record.isPublic === true,
        publishAt: record.publishAt,
        expireAt: record.expireAt,
        pinned: enablePinned && record.pinned === true,
        expiringSoon: isExpiringSoon(record, now),
      });
    }
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.publishAt - a.publishAt;
    });
    return items;
  });
}

/** 讀取單則公告（管理端編輯用） */
export interface SurfaceQuery {
  surface: AnnouncementSurface;
  /** null＝未登入（僅 `login` 顯示位置允許；只取閱讀權限＝「無」的公告） */
  role: UserRole | null;
  classCode?: string | null;
}

/**
 * 顯示位置（系統首頁登入表單上方／四種身分功能首頁）的公告。
 *
 * 查詢策略：僅下推 `publishAt` 單欄位排序（**免複合索引**）；
 * 公開判定／受眾（含管理員豁免）／班級／到期於記憶體過濾（量級有界，鐵律 3）；
 * 15 秒 cachedRead，寫入後由 `invalidateAnnouncementsCache()` 清前綴失效。
 */
export async function listSurfaceAnnouncements(
  query: SurfaceQuery,
  limit: number
): Promise<AnnouncementSurfaceItem[]> {
  const { surface, role, classCode } = query;
  const take = normalizeSurfaceLimit(limit);
  const cacheKey = `${SURFACE_CACHE_PREFIX}${surface}:${role ?? "guest"}:${classCode || "*"}:${take}`;
  return cachedRead(cacheKey, INBOX_TTL_MS, async () => {
    const settings = await getAnnouncementSettings();
    const snap = await getAdminDbRaw()
      .collection(ANNOUNCEMENTS_COLLECTION)
      .orderBy("publishAt", "desc")
      .limit(SURFACE_FETCH_LIMIT)
      .get();
    const now = Date.now();
    // 置頂原則關閉時：不論資料庫中 pinned 值，一律視為未置頂
    const enablePinned = settings.policies.enablePinned;
    const items: AnnouncementSurfaceItem[] = [];
    for (const doc of snap.docs) {
      const record = readAnnouncementRecord(doc.id, doc.data());
      if (!record) continue;
      if (!isAnnouncementReadable(record, now)) continue;
      // 受眾（記憶體）：未登入只看公開；一般身分看含其角色者；管理員看全部
      if (!role) {
        if (!record.isPublic) continue;
      } else if (role !== "admin") {
        if (!record.audience.roles.includes(role)) continue;
      }
      if (audienceClassScoped(record.audience)) {
        if (!classCode || !record.audience.classCodes.includes(classCode)) continue;
      }
      items.push({
        id: record.id,
        title: record.title,
        body: record.body,
        categoryId: record.categoryId,
        categoryName: announcementCategoryName(settings, record.categoryId),
        sourceModule: record.sourceModule,
        authorName: record.authorName,
        publishAt: record.publishAt,
        expireAt: record.expireAt,
        pinned: enablePinned && record.pinned === true,
        isPublic: record.isPublic === true,
      });
    }
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.publishAt - a.publishAt;
    });
    return items.slice(0, take);
  });
}

/** 讀取單則公告（管理端編輯用） */
export interface ArchiveQuery {
  /** null＝未登入（只取閱讀權限＝「無」的公開公告） */
  role: UserRole | null;
  classCode?: string | null;
}

/**
 * 公告專頁（`/announcements`）：5 處顯示位置共用的「全部公告」清單。
 *
 * 查詢策略：僅下推 `publishAt` 單欄位排序（**免複合索引**）；
 * 公開判定／受眾（含管理員豁免）／班級／到期於記憶體過濾；單次 `limit(ARCHIVE_LIMIT)`
 * 為有界查詢（鐵律 3），前端以共用分頁元件切片，翻頁不增加任何 Firestore 讀取；
 * 15 秒 cachedRead，寫入後由 `invalidateAnnouncementsCache()` 清前綴失效。
 */
export async function listArchiveAnnouncements(
  query: ArchiveQuery
): Promise<AnnouncementArchiveItem[]> {
  const { role, classCode } = query;
  const cacheKey = `${ARCHIVE_CACHE_PREFIX}${role ?? "guest"}:${classCode || "*"}`;
  return cachedRead(cacheKey, INBOX_TTL_MS, async () => {
    const settings = await getAnnouncementSettings();
    const snap = await getAdminDbRaw()
      .collection(ANNOUNCEMENTS_COLLECTION)
      .orderBy("publishAt", "desc")
      .limit(ARCHIVE_LIMIT)
      .get();
    const now = Date.now();
    // 置頂原則關閉時：不論資料庫中 pinned 值，一律視為未置頂
    const enablePinned = settings.policies.enablePinned;
    const items: AnnouncementArchiveItem[] = [];
    for (const doc of snap.docs) {
      const record = readAnnouncementRecord(doc.id, doc.data());
      if (!record) continue;
      if (!isAnnouncementReadable(record, now)) continue;
      // 受眾（記憶體）：未登入只看公開；一般身分看含其角色者；管理員看全部
      if (!role) {
        if (!record.isPublic) continue;
      } else if (role !== "admin") {
        if (!record.audience.roles.includes(role)) continue;
      }
      const scoped = audienceClassScoped(record.audience);
      if (scoped) {
        if (!classCode) continue;
        if (!record.audience.classCodes.includes(classCode)) continue;
      }
      items.push({
        id: record.id,
        title: record.title,
        body: record.body,
        categoryId: record.categoryId,
        categoryName: announcementCategoryName(settings, record.categoryId),
        sourceModule: record.sourceModule,
        authorName: record.authorName,
        publishAt: record.publishAt,
        expireAt: record.expireAt,
        pinned: enablePinned && record.pinned === true,
        isPublic: record.isPublic === true,
        classScoped: scoped,
      });
    }
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.publishAt - a.publishAt;
    });
    return items;
  });
}

/** 讀取單則公告（管理端編輯用） */
export async function getAnnouncement(id: string): Promise<AnnouncementRecord | null> {
  const snap = await getAdminDbRaw().collection(ANNOUNCEMENTS_COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return readAnnouncementRecord(id, snap.data());
}

/** 儲存模組設定（管理端；整份覆寫 settings/announcements） */
export async function saveAnnouncementSettings(input: {
  categories?: AnnouncementCategory[];
  defaultRemindersEnabled?: boolean;
  surfaces?: Partial<AnnouncementSurfaces>;
  policies?: Partial<AnnouncementPolicies>;
}): Promise<AnnouncementSettings> {
  const current = await getAnnouncementSettings();
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
  const safe = base.length > 0 ? base : [...DEFAULT_ANNOUNCEMENT_CATEGORIES];
  // 後備分類「其他」不可被刪除：即使管理端刪掉也補回並強制啟用
  const categories = ensureFallbackCategory(
    safe,
    ANNOUNCEMENT_FALLBACK_CATEGORY_ID,
    () => defaultAnnouncementFallbackCategory(safe.length)
  );
  // 顯示位置：逐 key 套用；未提供的 key 沿用現值（缺欄位時退回預設）
  const surfaces: AnnouncementSurfaces = {
    ...defaultAnnouncementSurfaces(),
    ...current.surfaces,
  };
  if (input.surfaces && typeof input.surfaces === "object") {
    for (const key of ANNOUNCEMENT_SURFACES) {
      const patch = input.surfaces[key];
      if (!patch || typeof patch !== "object") continue;
      surfaces[key] = {
        enabled: patch.enabled !== false,
        method: normalizeSurfaceMethod(patch.method),
        limit: normalizeSurfaceLimit(patch.limit),
      };
    }
  }
  // 公告原則：逐 key 套用；未提供的欄位沿用現值（缺欄位時退回預設）
  const policies: AnnouncementPolicies = {
    ...DEFAULT_ANNOUNCEMENT_POLICIES,
    ...current.policies,
  };
  if (input.policies && typeof input.policies === "object") {
    const patch = input.policies;
    if (typeof patch.enablePinned === "boolean") policies.enablePinned = patch.enablePinned;
    if (typeof patch.forceExpire === "boolean") policies.forceExpire = patch.forceExpire;
    if (typeof patch.hardDeleteExpired === "boolean") {
      policies.hardDeleteExpired = patch.hardDeleteExpired;
    }
  }
  const next: AnnouncementSettings = {
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
    .doc(ANNOUNCEMENT_SETTINGS_DOC_ID)
    .set(next, { merge: false });
  // 設定快取失效（cachedSettingDoc key＝setting-doc:announcements）
  invalidateReadCache("setting-doc:");
  invalidateAnnouncementsCache();
  return next;
}

const REMINDER_LIMIT = 50;

function reminderDocId(announcementId: string, uid: string): string {
  return `${announcementId}_${uid}`;
}

/**
 * 切換個人公告提醒：已設定則取消，未設定則建立。
 * 回傳 `reminded=true` 表示目前為「已設定」。
 */
export async function toggleAnnouncementReminder(
  uid: string,
  announcementId: string
): Promise<{ reminded: boolean }> {
  if (!uid || !announcementId) {
    throw new Error("缺少使用者或公告識別");
  }
  const ann = await getAnnouncement(announcementId);
  if (!ann || !isAnnouncementReadable(ann)) {
    throw new Error("公告不存在或已無法提醒");
  }
  const db = getAdminDbRaw();
  const ref = db
    .collection(ANNOUNCEMENT_REMINDERS_COLLECTION)
    .doc(reminderDocId(announcementId, uid));
  const snap = await ref.get();
  if (snap.exists) {
    await ref.delete();
    return { reminded: false };
  }
  await ref.set({
    announcementId,
    uid,
    createdAt: Date.now(),
  });
  return { reminded: true };
}

/** 使用者已設定提醒的公告 id 清單（不做跨請求快取：提醒變動頻繁） */
export async function listMyReminderIds(uid: string): Promise<string[]> {
  if (!uid) return [];
  const snap = await getAdminDbRaw()
    .collection(ANNOUNCEMENT_REMINDERS_COLLECTION)
    .where("uid", "==", uid)
    .limit(REMINDER_LIMIT)
    .get();
  return snap.docs.map((doc) => doc.data().announcementId).filter((id): id is string => !!id);
}

/**
 * 個人提醒列表（首頁鈴鐺／提醒區）：
 * 讀提醒文件 → 批次讀公告（getAll）→ 確認仍可閱讀（發布中、未過期、受眾涵蓋身分＋班級）。
 */
export async function listMyReminders(
  uid: string,
  role: UserRole,
  classCode?: string | null
): Promise<AnnouncementReminderItem[]> {
  if (!uid) return [];
  const settings = await getAnnouncementSettings();
  const snap = await getAdminDbRaw()
    .collection(ANNOUNCEMENT_REMINDERS_COLLECTION)
    .where("uid", "==", uid)
    .limit(REMINDER_LIMIT)
    .get();
  const reminderRows = snap.docs.map((doc) => {
    const data = doc.data();
    return {
      announcementId: typeof data.announcementId === "string" ? data.announcementId : "",
      createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    };
  });
  const ids = [...new Set(reminderRows.map((row) => row.announcementId).filter(Boolean))];
  if (ids.length === 0) return [];

  const db = getAdminDbRaw();
  const snaps = await db.getAll(
    ...ids.map((id) => db.collection(ANNOUNCEMENTS_COLLECTION).doc(id))
  );
  const annMap = new Map<string, AnnouncementRecord>();
  snaps.forEach((snapItem, index) => {
    if (!snapItem.exists) return;
    const record = readAnnouncementRecord(ids[index], snapItem.data());
    if (record) annMap.set(ids[index], record);
  });

  const now = Date.now();
  const items: AnnouncementReminderItem[] = [];
  for (const row of reminderRows) {
    const ann = annMap.get(row.announcementId);
    if (!ann || !isAnnouncementReadable(ann, now)) continue;
    if (!ann.audience.roles.includes(role)) continue;
    if (audienceClassScoped(ann.audience)) {
      if (!classCode || !ann.audience.classCodes.includes(classCode)) continue;
    }
    items.push({
      announcementId: ann.id,
      title: ann.title,
      body: ann.body,
      categoryName: announcementCategoryName(settings, ann.categoryId),
      authorName: ann.authorName,
      publishAt: ann.publishAt,
      expireAt: ann.expireAt,
      expiringSoon: isExpiringSoon(ann, now),
      classScoped: audienceClassScoped(ann.audience),
      createdAt: row.createdAt,
    });
  }
  items.sort((a, b) => b.publishAt - a.publishAt);
  return items;
}
