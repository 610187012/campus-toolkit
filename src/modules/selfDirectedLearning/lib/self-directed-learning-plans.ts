import "server-only";
import { getAdminDb } from "@/lib/firebase-admin";
import { getCurrentPeriod } from "@/lib/settings-server";
import { isActiveEntry } from "@/lib/roster";
import { rosterCollection } from "@/types/roster";
import { getRecordWindow } from "./self-directed-learning";
import {
  MAX_PLAN_WEEKS,
  SELF_DIRECTED_LEARNING_LOCKS_COLLECTION,
  SELF_DIRECTED_LEARNING_PLANS_COLLECTION,
  SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION,
  TRASH_RETENTION_DAYS,
  capRichHtmlLength,
  isFormalPlan,
  normalizeWeekNotes,
  periodLabelOf,
  planDocIdOf,
  openStateOf,
  sanitizeRichHtml,
  stripHtmlToText,
  type PlanReview,
  type PlanWeekReview,
  type ReviewScope,
  type SelfDirectedLearningPlan,
  type SelfDirectedLearningSettings,
} from "../types/self-directed-learning";

function plansRef() {
  return getAdminDb().collection(SELF_DIRECTED_LEARNING_PLANS_COLLECTION);
}

/**
 * 「學生＋學期」送審鎖定文件的參照（doc id＝`<學期>_<uid>`，單一文件、免複合索引）。
 * 用途：送出審核與審核結果都在同一份文件上讀寫，讓同一學生同一學期的狀態轉換序列化，
 * 杜絕兩分頁同時送審、兩個審核者同時通過的競態。
 */
function submissionLockRef(period: string, studentUid: string) {
  return getAdminDb()
    .collection(SELF_DIRECTED_LEARNING_LOCKS_COLLECTION)
    .doc(planDocIdOf(period, studentUid));
}

/** 學生視角儀表資料 */
export interface StudentDashboard {
  period: string;
  /** 目前為止的所有計畫（正式與草稿並存；正式＝approved，其餘皆視為草稿） */
  plans: SelfDirectedLearningPlan[];
  /** 各計畫的最新審查意見（key＝plan id） */
  latestReviews: Record<string, PlanReview>;
  /** 現在是否在送審期間 */
  withinWindow: boolean;
}

function readPlan(id: string, raw: Record<string, unknown>): SelfDirectedLearningPlan {
  const str = (value: unknown, fallback = "") =>
    typeof value === "string" ? value : fallback;
  const weeks = Array.isArray(raw.weeks)
    ? raw.weeks
        .map((item): SelfDirectedLearningPlan["weeks"][number] | null => {
          if (!item || typeof item !== "object") return null;
          const week = item as Record<string, unknown>;
          const weekNo = typeof week.week === "number" ? week.week : NaN;
          if (!Number.isInteger(weekNo) || weekNo < 1) return null;
          const timing = week.timing === "afterSchool" ? "afterSchool" : "flexible";
          return {
            week: weekNo,
            content: str(week.content),
            venue: str(week.venue),
            timing,
          };
        })
        .filter((week): week is NonNullable<typeof week> => week !== null)
        .sort((a, b) => a.week - b.week)
    : [];
  const status =
    raw.status === "submitted" || raw.status === "approved" || raw.status === "returned"
      ? raw.status
      : "draft";
  const executionRecords = Array.isArray(raw.executionRecords)
    ? raw.executionRecords
        .map((item): SelfDirectedLearningPlan["executionRecords"][number] | null => {
          if (!item || typeof item !== "object") return null;
          const record = item as Record<string, unknown>;
          const weekNo = typeof record.week === "number" ? record.week : NaN;
          if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > MAX_PLAN_WEEKS) return null;
          const note = typeof record.note === "string" ? record.note : "";
          if (!note) return null;
          return { week: weekNo, note };
        })
        .filter((record): record is NonNullable<typeof record> => record !== null)
        .sort((a, b) => a.week - b.week)
    : [];
  return {
    id,
    period: str(raw.period),
    studentUid: str(raw.studentUid),
    studentName: str(raw.studentName),
    grade: str(raw.grade),
    classCode: str(raw.classCode),
    className: str(raw.className),
    topic: str(raw.topic),
    studyGroup: str(raw.studyGroup),
    advisor: str(raw.advisor),
    learningGoals: str(raw.learningGoals),
    weeks,
    executionRecords,
    reflection: str(raw.reflection),
    status,
    deletedAt: typeof raw.deletedAt === "number" ? raw.deletedAt : null,
    submittedAt: typeof raw.submittedAt === "number" ? raw.submittedAt : null,
    firstSubmittedAt:
      typeof raw.firstSubmittedAt === "number"
        ? raw.firstSubmittedAt
        : typeof raw.submittedAt === "number"
          ? raw.submittedAt
          : null,
    selfApprovedAt:
      typeof raw.selfApprovedAt === "number" && raw.selfApprovedAt > 0
        ? raw.selfApprovedAt
        : null,
    // 舊資料沒有此欄位：視為開放家長檢視（維持既有行為）
    parentVisible: raw.parentVisible !== false,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

/** 讀學生目前為止的所有計畫（單一等值查詢，避免複合索引；依更新時間新到舊） */
export async function getStudentPlans(
  studentUid: string,
  limit = 200
): Promise<SelfDirectedLearningPlan[]> {
  const snap = await plansRef().where("studentUid", "==", studentUid).limit(limit).get();
  const plans = readPlansFromSnapshot(snap);
  plans.sort((a, b) => b.updatedAt - a.updatedAt);
  return plans;
}

function readReview(id: string, raw: Record<string, unknown>): PlanReview {
  return {
    id,
    planId: typeof raw.planId === "string" ? raw.planId : "",
    reviewerUid: typeof raw.reviewerUid === "string" ? raw.reviewerUid : "",
    reviewerName: typeof raw.reviewerName === "string" ? raw.reviewerName : "",
    decision: raw.decision === "returned" ? ("returned" as const) : ("approved" as const),
    note: typeof raw.note === "string" ? raw.note : "",
    weekNotes: normalizeWeekNotes(raw.weekNotes),
    reviewedAt: typeof raw.reviewedAt === "number" ? raw.reviewedAt : 0,
  };
}

/** 讀計畫的最新審查意見（where 精準條件＋本機排序，筆數有界） */
export async function getLatestReview(planId: string): Promise<PlanReview | null> {
  const snap = await getAdminDb()
    .collection(SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION)
    .where("planId", "==", planId)
    .limit(20)
    .get();
  if (snap.empty) return null;
  const items = snap.docs.map((doc) =>
    readReview(doc.id, (doc.data() || {}) as Record<string, unknown>)
  );
  items.sort((a, b) => b.reviewedAt - a.reviewedAt);
  return items[0] || null;
}

/** 一次取多筆計畫的最新審查意見（`planId in` 分塊，避免逐筆 N+1） */
export async function getLatestReviews(planIds: string[]): Promise<Record<string, PlanReview>> {
  const unique = [...new Set(planIds.filter((id) => typeof id === "string" && id))];
  const latest: Record<string, PlanReview> = {};
  for (let index = 0; index < unique.length; index += 30) {
    const chunk = unique.slice(index, index + 30);
    const snap = await getAdminDb()
      .collection(SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION)
      .where("planId", "in", chunk)
      .limit(500)
      .get();
    for (const doc of snap.docs) {
      const review = readReview(doc.id, (doc.data() || {}) as Record<string, unknown>);
      if (!review.planId) continue;
      const previous = latest[review.planId];
      if (!previous || review.reviewedAt > previous.reviewedAt) latest[review.planId] = review;
    }
  }
  return latest;
}

export interface StudentIdentityLite {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  className: string;
}

export type SaveAction = "save" | "submit";

export type SavePlanResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/** 新計畫的 doc id：`period_uid_時間亂數`（舊資料仍為 `period_uid`，兩種都相容） */
function newPlanDocId(period: string, studentUid: string, now: number): string {
  return `${planDocIdOf(period, studentUid)}_${now.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * 儲存草稿／送出審核。
 * - 未帶 planId＝新增草稿（不受送審期間限制；送出審核時才檢查期限與件數）。
 * - 帶 planId＝編輯既有草稿（草稿／退回修改可編輯；審核中／已通過不可編輯）。
 * - 同一學期可有多筆草稿，但每學期僅能送審 1 份（第一次送出後只能重送同一份；退回、抽回都算已送審）。
 * - 正式計畫（approved）每學期僅一份；送出審核與審核通過時都會檢查。
 */
export async function saveStudentPlan(input: {
  student: StudentIdentityLite;
  draft: {
    topic: string;
    studyGroup: string;
    advisor: string;
    learningGoals: string;
    weeks: SelfDirectedLearningPlan["weeks"];
  };
  action: SaveAction;
  settings: SelfDirectedLearningSettings;
  /** 編輯既有草稿時帶入；新增計畫不帶 */
  planId?: string | null;
  now?: number;
}): Promise<SavePlanResult> {
  const now = input.now ?? Date.now();
  const currentPeriod = periodLabelOf(await getCurrentPeriod());
  const requestedId = typeof input.planId === "string" ? input.planId.trim() : "";

  let target: SelfDirectedLearningPlan | null = null;
  if (requestedId) {
    const snap = await plansRef().doc(requestedId).get();
    if (!snap.exists) return { ok: false, status: 404, message: "查無此計畫" };
    target = readPlan(requestedId, (snap.data() || {}) as Record<string, unknown>);
    if (target.studentUid !== input.student.uid) {
      return { ok: false, status: 403, message: "無權修改此計畫" };
    }
    if (target.deletedAt) {
      return { ok: false, status: 409, message: "此計畫在垃圾桶，請先還原後再編輯" };
    }
    if (target.status === "approved") {
      return { ok: false, status: 409, message: "計畫已通過審核，不可再修改" };
    }
    if (target.status === "submitted") {
      return { ok: false, status: 409, message: "計畫審核中，請等待審查結果" };
    }
  }

  // 送出審核一律視為「本學期」的計畫（草稿可跨學期保留，送出時歸到目前學期）
  const period =
    input.action === "submit" ? currentPeriod : target?.period || currentPeriod;
  const studentPlans = await getStudentPlans(input.student.uid);
  const approvedElsewhere = studentPlans.find(
    (plan) =>
      plan.period === period &&
      !plan.deletedAt &&
      plan.status === "approved" &&
      plan.id !== requestedId
  );
  if (approvedElsewhere && input.action === "submit") {
    return { ok: false, status: 409, message: "本學期已有通過審核的正式計畫，無法再送出計畫" };
  }

  // 同一學期同時僅能有一件計畫在審核中（可保留多筆草稿）
  const submittedElsewhere = studentPlans.find(
    (plan) =>
      plan.period === period &&
      plan.status === "submitted" &&
      !plan.deletedAt &&
      plan.id !== requestedId
  );
  if (input.action === "submit" && submittedElsewhere) {
    return {
      ok: false,
      status: 409,
      message: "本學期已有計畫在審核中，請等待審查結果或先抽回該計畫後再送出",
    };
  }

  // 每學期僅能送審 1 份：本學期已送審過其他計畫（含已退回、已抽回）時，只能重送同一份
  const everSubmittedElsewhere = studentPlans.find(
    (plan) =>
      plan.period === period &&
      plan.id !== requestedId &&
      (plan.firstSubmittedAt ?? plan.submittedAt) !== null
  );
  if (input.action === "submit" && everSubmittedElsewhere) {
    return {
      ok: false,
      status: 409,
      message: `本學期只能送審 1 份計畫；你已送審過《${
        everSubmittedElsewhere.topic || "未命名計畫"
      }》，請直接修改該計畫後重新送出`,
    };
  }

  // 草稿匣件數上限（含退回修改）：只限制新增，既有草稿仍可編輯／送審
  if (!target && input.action === "save") {
    const draftBoxCount = studentPlans.filter(
      (plan) =>
        !plan.deletedAt &&
        (plan.status === "draft" || plan.status === "returned") &&
        !isFormalPlan(plan)
    ).length;
    if (draftBoxCount >= input.settings.maxDrafts) {
      return {
        ok: false,
        status: 409,
        message: `草稿匣已達上限（${input.settings.maxDrafts} 件），請先刪除不需要的草稿，或請管理員調整上限`,
      };
    }
  }

  // 文件匣件數上限（審核中＋已通過）：只限制送出審核，草稿與自行提升的正式不受影響
  if (input.action === "submit") {
    const documentBoxCount = studentPlans.filter(
      (plan) =>
        !plan.deletedAt &&
        plan.id !== requestedId &&
        (isFormalPlan(plan) || plan.status === "submitted")
    ).length;
    if (documentBoxCount >= input.settings.maxDocumentPlans) {
      return {
        ok: false,
        status: 409,
        message: `文件匣已達上限（${input.settings.maxDocumentPlans} 件，含審核中與已通過），請洽管理員調整上限`,
      };
    }
  }

  if (input.action === "submit") {
    const { openAt, closeAt } = input.settings;
    if (openAt === null || closeAt === null) {
      return { ok: false, status: 400, message: "學校尚未設定送審期間" };
    }
    if (now < openAt) return { ok: false, status: 400, message: "尚未到送審期間" };
    if (now > closeAt) return { ok: false, status: 400, message: "已超過送審期間" };
  }

  const id = target?.id ?? newPlanDocId(period, input.student.uid, now);
  const next: SelfDirectedLearningPlan = {
    id,
    period,
    studentUid: input.student.uid,
    studentName: input.student.name,
    grade: input.student.grade,
    classCode: input.student.classCode,
    className: input.student.className,
    topic: input.draft.topic,
    studyGroup: input.draft.studyGroup,
    advisor: input.draft.advisor,
    learningGoals: input.draft.learningGoals,
    weeks: input.draft.weeks,
    // 成果紀錄與反思不隨草稿／送審變動（保留既有內容）
    executionRecords: target?.executionRecords ?? [],
    reflection: target?.reflection ?? "",
    status: input.action === "submit" ? "submitted" : "draft",
    deletedAt: null,
    submittedAt: input.action === "submit" ? now : target?.submittedAt ?? null,
    // 第一次送審時間不再清除：抽回後仍算「本學期已送審過」
    firstSubmittedAt:
      input.action === "submit" ? target?.firstSubmittedAt ?? now : target?.firstSubmittedAt ?? null,
    selfApprovedAt: target?.selfApprovedAt ?? null,
    // 家長檢視設定不隨草稿／送審變動
    parentVisible: target?.parentVisible ?? true,
    updatedAt: now,
  };

  if (input.action !== "submit") {
    await plansRef().doc(id).set(next, { merge: true });
    return { ok: true, plan: next };
  }
  // 送審：以「學生＋學期」鎖定文件序列化，杜絕兩分頁同時送審的競態
  // （上面的檢查是快速回饋；真正把關在交易內重讀鎖定文件與被鎖定的計畫）
  const lockRef = submissionLockRef(period, input.student.uid);
  const outcome = await getAdminDb().runTransaction(async (tx) => {
    const lockSnap = await tx.get(lockRef);
    const lock = (lockSnap.exists ? lockSnap.data() : null) as Record<string, unknown> | null;
    const lockedSubmittedId =
      typeof lock?.submittedPlanId === "string" ? lock.submittedPlanId : "";
    if (lockedSubmittedId && lockedSubmittedId !== id) {
      const lockedSnap = await tx.get(plansRef().doc(lockedSubmittedId));
      if (lockedSnap.exists) {
        const lockedPlan = readPlan(
          lockedSnap.id,
          (lockedSnap.data() || {}) as Record<string, unknown>
        );
        if (
          lockedPlan.period === period &&
          lockedPlan.status === "submitted" &&
          !lockedPlan.deletedAt
        ) {
          return { kind: "submitted" as const };
        }
      }
    }
    const lockedApprovedId =
      typeof lock?.approvedPlanId === "string" ? lock.approvedPlanId : "";
    if (lockedApprovedId && lockedApprovedId !== id) {
      const approvedSnap = await tx.get(plansRef().doc(lockedApprovedId));
      if (approvedSnap.exists) {
        const approvedPlan = readPlan(
          approvedSnap.id,
          (approvedSnap.data() || {}) as Record<string, unknown>
        );
        if (approvedPlan.period === period && approvedPlan.status === "approved") {
          return { kind: "approved" as const };
        }
      }
    }
    tx.set(plansRef().doc(id), next, { merge: true });
    tx.set(
      lockRef,
      { period, studentUid: input.student.uid, submittedPlanId: id, updatedAt: now },
      { merge: true }
    );
    return { kind: "ok" as const };
  });

  if (outcome.kind === "submitted") {
    return {
      ok: false,
      status: 409,
      message: "本學期已有計畫在審核中，請等待審查結果或先抽回該計畫後再送出",
    };
  }
  if (outcome.kind === "approved") {
    return { ok: false, status: 409, message: "本學期已有正式計畫，無法再送出計畫" };
  }
  return { ok: true, plan: next };
}

export type PlanTrashResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/** 執行成果紀錄單一週的輸入（富文本；空字串＝清除該週） */
export interface ExecutionRecordInput {
  week: number;
  note: string;
}

export type SaveRecordsResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/** 執行成果紀錄的可見文字上限（富文本 HTML 上限 20000 字元） */
const RECORD_PLAIN_LIMIT = 2000;

/**
 * 儲存執行成果紀錄與學習反思心得。
 * - 僅限已通過審核（approved）的計畫：計畫執行後才有成果可寫。
 * - 逐週開放：該週規劃時間（最後一個節次結束）過了才能寫。
 * - 學習反思心得：最後一週時間過了才能寫。
 * - 管理端設定的「計畫成果撰寫截止日」之後一律不可寫。
 */
export async function savePlanRecords(input: {
  planId: string;
  studentUid: string;
  records: ExecutionRecordInput[];
  /** undefined＝不動（例如反思尚未開放時不送） */
  reflection?: string;
  settings: SelfDirectedLearningSettings;
  now?: number;
}): Promise<SaveRecordsResult> {
  const now = input.now ?? Date.now();
  const snap = await plansRef().doc(input.planId).get();
  if (!snap.exists) return { ok: false, status: 404, message: "查無此計畫" };
  const plan = readPlan(input.planId, (snap.data() || {}) as Record<string, unknown>);
  if (plan.studentUid !== input.studentUid) {
    return { ok: false, status: 403, message: "無權修改此計畫" };
  }
  if (plan.deletedAt) {
    return { ok: false, status: 409, message: "此計畫在垃圾桶，無法填寫執行成果" };
  }
  if (!isFormalPlan(plan)) {
    return {
      ok: false,
      status: 409,
      message: "計畫提升為正式或通過審核後才能填寫執行成果紀錄",
    };
  }
  if (plan.period !== periodLabelOf(await getCurrentPeriod())) {
    return { ok: false, status: 409, message: "只能填寫本學期計畫的執行成果紀錄" };
  }
  if (plan.status === "approved" && input.settings.resultDeadlineAt !== null && now > input.settings.resultDeadlineAt) {
    return { ok: false, status: 409, message: "已超過計畫成果撰寫截止時間" };
  }

  const window = await getRecordWindow(plan.grade, plan.classCode);
  const openByWeek = new Map(window.weeks.map((row) => [row.week, row.openAt]));
  const endByWeek = new Map(window.weeks.map((row) => [row.week, row.endAt]));
  const planWeeks = new Set(plan.weeks.map((week) => week.week));
  const records = new Map(plan.executionRecords.map((record) => [record.week, record.note]));

  for (const item of input.records.slice(0, MAX_PLAN_WEEKS)) {
    if (!planWeeks.has(item.week)) {
      return { ok: false, status: 400, message: "週次不在計畫內容內" };
    }
    const openAt = openByWeek.get(item.week) ?? 0;
    if (openAt <= 0 || now < openAt) {
      return {
        ok: false,
        status: 400,
        message: `第 ${item.week} 週時間還沒到，尚不能填寫執行成果紀錄`,
      };
    }
    const sanitized = sanitizeRichHtml(typeof item.note === "string" ? item.note : "");
    const plain = stripHtmlToText(sanitized).trim();
    if (plain.length > RECORD_PLAIN_LIMIT) {
      return {
        ok: false,
        status: 400,
        message: `第 ${item.week} 週執行成果紀錄超過 ${RECORD_PLAIN_LIMIT} 字上限`,
      };
    }
    if (plain) records.set(item.week, capRichHtmlLength(sanitized, 20000));
    else records.delete(item.week);
  }

  let reflection = plan.reflection;
  if (typeof input.reflection === "string") {
    // 學習反思心得：最後一週整週結束（下一週開始）才開放
    const reflectionOpenAt = plan.weeks.reduce(
      (max, week) => Math.max(max, endByWeek.get(week.week) ?? 0),
      0
    );
    if (reflectionOpenAt <= 0 || now < reflectionOpenAt) {
      return {
        ok: false,
        status: 400,
        message: "最後一週時間還沒到，尚不能填寫學習反思心得",
      };
    }
    const sanitized = sanitizeRichHtml(input.reflection);
    const plain = stripHtmlToText(sanitized).trim();
    if (plain.length > RECORD_PLAIN_LIMIT) {
      return {
        ok: false,
        status: 400,
        message: `學習反思心得超過 ${RECORD_PLAIN_LIMIT} 字上限`,
      };
    }
    reflection = plain ? capRichHtmlLength(sanitized, 20000) : "";
  }

  const executionRecords = [...records.entries()]
    .map(([week, note]) => ({ week, note }))
    .sort((a, b) => a.week - b.week);
  await plansRef()
    .doc(plan.id)
    .set({ executionRecords, reflection, updatedAt: now }, { merge: true });
  return {
    ok: true,
    plan: { ...plan, executionRecords, reflection, updatedAt: now },
  };
}

/**
 * 假性刪除／還原：只允許本人操作，且只針對草稿或退回修改的計畫。
 * 審核中與已通過的計畫不可移至垃圾桶，避免正式紀錄消失。
 */
export async function setStudentPlanDeleted(input: {
  planId: string;
  studentUid: string;
  deleted: boolean;
  /** 草稿匣件數上限（還原草稿時檢查；未提供＝不檢查） */
  maxDrafts?: number;
  /** 文件匣件數上限（還原自行提升的正式計畫時檢查；未提供＝不檢查） */
  maxDocumentPlans?: number;
  now?: number;
}): Promise<PlanTrashResult> {
  const snap = await plansRef().doc(input.planId).get();
  if (!snap.exists) return { ok: false, status: 404, message: "查無此計畫" };
  const plan = readPlan(input.planId, (snap.data() || {}) as Record<string, unknown>);
  if (plan.studentUid !== input.studentUid) {
    return { ok: false, status: 403, message: "無權操作此計畫" };
  }
  if (input.deleted) {
    if (plan.status === "submitted" || plan.status === "approved") {
      return {
        ok: false,
        status: 409,
        message: "審核中或已通過的計畫不可移至垃圾桶",
      };
    }
    if (plan.deletedAt) return { ok: true, plan };
  } else if (!plan.deletedAt) {
    return { ok: true, plan };
  }
  if (!input.deleted) {
    const activePlans = await getStudentPlans(plan.studentUid);
    if (isFormalPlan(plan)) {
      if (typeof input.maxDocumentPlans === "number") {
        const documentBoxCount = activePlans.filter(
          (item) => !item.deletedAt && (isFormalPlan(item) || item.status === "submitted")
        ).length;
        if (documentBoxCount >= input.maxDocumentPlans) {
          return {
            ok: false,
            status: 409,
            message: `文件匣已達上限（${input.maxDocumentPlans} 件，含審核中與已通過），請先調整上限或等既有計畫審查結束`,
          };
        }
      }
    } else if (typeof input.maxDrafts === "number") {
      const draftBoxCount = activePlans.filter(
        (item) =>
          !item.deletedAt && (item.status === "draft" || item.status === "returned")
      ).length;
      if (draftBoxCount >= input.maxDrafts) {
        return {
          ok: false,
          status: 409,
          message: `草稿匣已達上限（${input.maxDrafts} 件），請先刪除不需要的草稿，或請管理員調整上限`,
        };
      }
    }
  }
  const now = input.now ?? Date.now();
  const next: SelfDirectedLearningPlan = {
    ...plan,
    deletedAt: input.deleted ? now : null,
    updatedAt: now,
  };
  await plansRef()
    .doc(plan.id)
    .set({ deletedAt: next.deletedAt, updatedAt: now }, { merge: true });
  return { ok: true, plan: next };
}

export type PromotePlanResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/**
 * 學生自行把本學期計畫提升為正式（不必等學校審核通過，即可開始按時寫成果）。
 * - 草稿、審核中、退回修改皆可提升。
 * - 同一學期可有多份自行提升的正式計畫；送審仍限一份，學校審核通過的正式計畫仍以一份為原則。
 * - 學校審核保留；之後被退回不影響已提升的正式狀態。
 */
export async function promoteStudentPlan(input: {
  planId: string;
  studentUid: string;
  /** 文件匣件數上限（草稿／退回提升會新增一件；審核中已在文件匣內，不重複占位） */
  maxDocumentPlans?: number;
}): Promise<PromotePlanResult> {
  const planRef = plansRef().doc(input.planId);
  const snap = await planRef.get();
  if (!snap.exists) return { ok: false, status: 404, message: "查無此計畫" };
  const plan = readPlan(input.planId, (snap.data() || {}) as Record<string, unknown>);
  if (plan.studentUid !== input.studentUid) {
    return { ok: false, status: 403, message: "無權修改此計畫" };
  }
  if (plan.deletedAt) {
    return { ok: false, status: 409, message: "此計畫在垃圾桶，請先還原後再提升" };
  }
  if (isFormalPlan(plan)) return { ok: true, plan };

  const currentPeriod = periodLabelOf(await getCurrentPeriod());
  if (plan.period !== currentPeriod) {
    return { ok: false, status: 409, message: "只能提升本學期的計畫" };
  }

  // 草稿／退回提升會新增一件文件匣；審核中本來就占文件匣，不重複檢查
  if (plan.status !== "submitted" && typeof input.maxDocumentPlans === "number") {
    const plans = await getStudentPlans(plan.studentUid);
    const documentBoxCount = plans.filter(
      (item) =>
        !item.deletedAt &&
        item.id !== plan.id &&
        (isFormalPlan(item) || item.status === "submitted")
    ).length;
    if (documentBoxCount >= input.maxDocumentPlans) {
      return {
        ok: false,
        status: 409,
        message: `文件匣已達上限（${input.maxDocumentPlans} 件，含審核中與已通過），請先調整上限或等既有計畫審查結束`,
      };
    }
  }

  const now = Date.now();
  await planRef.set({ selfApprovedAt: now, updatedAt: now }, { merge: true });
  return { ok: true, plan: { ...plan, selfApprovedAt: now, updatedAt: now } };
}

export type SetParentVisibilityResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/**
 * 學生設定某一份正式計畫是否開放家長檢視。
 * - 僅限本人、且為正式計畫（學校通過或自行提升）。
 * - 垃圾桶中的計畫不可設定（家長端本來就讀不到垃圾桶）。
 */
export async function setStudentPlanParentVisibility(input: {
  planId: string;
  studentUid: string;
  visible: boolean;
}): Promise<SetParentVisibilityResult> {
  const planRef = plansRef().doc(input.planId);
  const snap = await planRef.get();
  if (!snap.exists) return { ok: false, status: 404, message: "查無此計畫" };
  const plan = readPlan(input.planId, (snap.data() || {}) as Record<string, unknown>);
  if (plan.studentUid !== input.studentUid) {
    return { ok: false, status: 403, message: "無權修改此計畫" };
  }
  if (plan.deletedAt) {
    return { ok: false, status: 409, message: "此計畫在垃圾桶，請先還原後再設定" };
  }
  if (!isFormalPlan(plan)) {
    return { ok: false, status: 409, message: "只有正式計畫可以設定家長檢視" };
  }
  if (plan.parentVisible === input.visible) return { ok: true, plan };

  const now = Date.now();
  await planRef.set({ parentVisible: input.visible, updatedAt: now }, { merge: true });
  return { ok: true, plan: { ...plan, parentVisible: input.visible, updatedAt: now } };
}

export type PurgePlanResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/**
 * 永久刪除垃圾桶中的計畫（不可復原）：
 * - 僅限本人、且已移至垃圾桶的草稿／退回修改。
 * - 一併刪除該計畫的審查紀錄與仍指向它的送審鎖定文件。
 */
export async function purgeStudentPlan(input: {
  planId: string;
  studentUid: string;
}): Promise<PurgePlanResult> {
  const planRef = plansRef().doc(input.planId);
  const snap = await planRef.get();
  if (!snap.exists) return { ok: false, status: 404, message: "查無此計畫" };
  const plan = readPlan(input.planId, (snap.data() || {}) as Record<string, unknown>);
  if (plan.studentUid !== input.studentUid) {
    return { ok: false, status: 403, message: "無權刪除此計畫" };
  }
  if (!plan.deletedAt) {
    return { ok: false, status: 409, message: "只能永久刪除垃圾桶中的計畫" };
  }
  if (plan.status === "submitted" || plan.status === "approved") {
    return { ok: false, status: 409, message: "審核中或已通過的計畫不可刪除" };
  }

  const db = getAdminDb();
  // 單次 batch 上限 500；審查紀錄通常很少，保留 400 筆的餘裕
  const reviews = await db
    .collection(SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION)
    .where("planId", "==", plan.id)
    .limit(400)
    .get();
  const batch = db.batch();
  for (const review of reviews.docs) batch.delete(review.ref);

  const lockRef = submissionLockRef(plan.period, plan.studentUid);
  const lockSnap = await lockRef.get();
  const lock = (lockSnap.exists ? lockSnap.data() : null) as Record<string, unknown> | null;
  if (lock && lock.submittedPlanId === plan.id) batch.delete(lockRef);

  batch.delete(planRef);
  await batch.commit();
  return { ok: true, plan };
}

/** 垃圾桶保留天數：學生進入頁面時，超過此天數的廢棄計畫會永久刪除（與前端共用同一常數） */
export { TRASH_RETENTION_DAYS };

/**
 * 自動清除學生垃圾桶中超過保留天數的計畫（含審查紀錄）。
 * 只處理草稿／退回修改；審核中與已通過的計畫不可在垃圾桶，遇到也跳過。
 * 回傳實際清除的計畫數。
 */
export async function purgeExpiredStudentTrash(input: {
  studentUid: string;
  now?: number;
}): Promise<number> {
  const now = input.now ?? Date.now();
  const cutoff = now - TRASH_RETENTION_DAYS * 86_400_000;
  const plans = await getStudentPlans(input.studentUid, 1000);
  const expired = plans.filter(
    (plan) =>
      plan.deletedAt !== null &&
      plan.deletedAt <= cutoff &&
      plan.status !== "submitted" &&
      plan.status !== "approved"
  );
  if (expired.length === 0) return 0;

  const db = getAdminDb();
  const ids = expired.map((plan) => plan.id);
  let batch = db.batch();
  let operations = 0;
  const commitIfNeeded = async () => {
    if (operations >= 450) {
      await batch.commit();
      batch = db.batch();
      operations = 0;
    }
  };

  // 審查紀錄以 planId in [...] 分批查（Firestore in 上限 30），避免逐筆查詢
  for (let index = 0; index < ids.length; index += 30) {
    const chunk = ids.slice(index, index + 30);
    const reviews = await db
      .collection(SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION)
      .where("planId", "in", chunk)
      .limit(400)
      .get();
    for (const review of reviews.docs) {
      batch.delete(review.ref);
      operations += 1;
      await commitIfNeeded();
    }
  }

  for (const plan of expired) {
    batch.delete(plansRef().doc(plan.id));
    operations += 1;
    await commitIfNeeded();
  }
  if (operations > 0) await batch.commit();
  return expired.length;
}

export type WithdrawPlanResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/**
 * 學生抽回審核中的計畫（限送審期間、限本學期）：
 * 抽回後回到草稿狀態，可修改後重新送出。
 * 以 transaction 重讀確認仍是 submitted，避免與審核人員同時處理。
 */
export async function withdrawStudentPlan(input: {
  planId: string;
  studentUid: string;
  /** 目前學期識別（只允許抽回本學期的計畫） */
  period: string;
  settings: SelfDirectedLearningSettings;
  now?: number;
}): Promise<WithdrawPlanResult> {
  const now = input.now ?? Date.now();
  if (openStateOf(input.settings, now) !== "open") {
    return { ok: false, status: 400, message: "目前非送審期間，無法抽回計畫" };
  }
  const db = getAdminDb();
  const planRef = plansRef().doc(input.planId);
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(planRef);
    if (!snap.exists) return { kind: "missing" as const };
    const plan = readPlan(planRef.id, (snap.data() || {}) as Record<string, unknown>);
    if (plan.studentUid !== input.studentUid) return { kind: "forbidden" as const };
    if (plan.deletedAt) return { kind: "deleted" as const };
    if (plan.status !== "submitted") return { kind: "badStatus" as const };
    if (plan.period !== input.period) return { kind: "wrongPeriod" as const };
    const next: SelfDirectedLearningPlan = {
      ...plan,
      status: "draft",
      submittedAt: null,
      updatedAt: now,
    };
    // 送審鎖定文件同步清除，讓同一學期可以再送另一件
    const lockRef = submissionLockRef(plan.period, plan.studentUid);
    const lockSnap = await tx.get(lockRef);
    const lock = (lockSnap.exists ? lockSnap.data() : null) as Record<string, unknown> | null;
    tx.set(planRef, { status: "draft", submittedAt: null, updatedAt: now }, { merge: true });
    if (lock && lock.submittedPlanId === plan.id) {
      tx.set(lockRef, { submittedPlanId: null, updatedAt: now }, { merge: true });
    }
    return { kind: "ok" as const, plan: next };
  });

  switch (outcome.kind) {
    case "missing":
      return { ok: false, status: 404, message: "查無此計畫" };
    case "forbidden":
      return { ok: false, status: 403, message: "無權操作此計畫" };
    case "deleted":
      return { ok: false, status: 409, message: "此計畫在垃圾桶，無法抽回" };
    case "badStatus":
      return { ok: false, status: 409, message: "只有審核中的計畫可以抽回修改" };
    case "wrongPeriod":
      return { ok: false, status: 409, message: "只能抽回本學期的計畫" };
    default:
      return { ok: true, plan: outcome.plan };
  }
}

/* ——— 教職員端：審核佇列與全班瀏覽 ——— */

function readPlansFromSnapshot(snap: {
  docs: { id: string; data: () => Record<string, unknown> | undefined }[];
}): SelfDirectedLearningPlan[] {
  return snap.docs
    .map((doc) => readPlan(doc.id, (doc.data() || {}) as Record<string, unknown>))
    .filter((plan) => plan.id);
}

/** 待審核佇列（當期 submitted；雙 equality 條件、limit 有界） */
export async function listSubmittedPlans(
  period: string,
  limit = 100
): Promise<SelfDirectedLearningPlan[]> {
  const snap = await plansRef()
    .where("period", "==", period)
    .where("status", "==", "submitted")
    .limit(limit)
    .get();
  const plans = readPlansFromSnapshot(snap);
  plans.sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
  return plans.filter((plan) => !plan.deletedAt);
}

/**
 * 依審查範圍載入待審計畫（省流）：
 * - 班級：每個指定班級各下一筆等值查詢（不掃全校）。
 * - 個人（例外）：以計畫 doc id（period_uid）精準 getAll，只讀指定學生的計畫。
 * - 兩者同時指定時取聯集去重；未限制＝沿用既有全校待審查詢。
 */
export async function listSubmittedPlansForScope(
  period: string,
  scope: ReviewScope,
  limit = 100
): Promise<SelfDirectedLearningPlan[]> {
  if (scope.all) return listSubmittedPlans(period, limit);

  const merged = new Map<string, SelfDirectedLearningPlan>();

  const classCodes = [...new Set(scope.classCodes)];
  if (classCodes.length > 0) {
    const snaps = await Promise.all(
      classCodes.map((classCode) =>
        plansRef()
          .where("period", "==", period)
          .where("status", "==", "submitted")
          .where("classCode", "==", classCode)
          .limit(limit)
          .get()
      )
    );
    for (const snap of snaps) {
      for (const plan of readPlansFromSnapshot(snap)) {
        if (!plan.deletedAt) merged.set(plan.id, plan);
      }
    }
  }

  const uids = [...new Set(scope.studentUids)];
  for (let index = 0; index < uids.length; index += 30) {
    const chunk = uids.slice(index, index + 30);
    // 同一學生可能有數筆草稿／正式計畫，改用 studentUid 等值查詢（單一欄位索引）
    const snap = await plansRef().where("studentUid", "in", chunk).limit(300).get();
    for (const plan of readPlansFromSnapshot(snap)) {
      if (plan.period === period && plan.status === "submitted" && !plan.deletedAt) {
        merged.set(plan.id, plan);
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0))
    .slice(0, limit);
}

/** 計畫是否落在審查範圍內 */
export function planInReviewScope(plan: SelfDirectedLearningPlan, scope: ReviewScope): boolean {
  if (scope.all) return true;
  return scope.classCodes.includes(plan.classCode) || scope.studentUids.includes(plan.studentUid);
}

/**
 * 待審件數（省流模式的輕量總數）：以 Firestore count 聚合計算，不載入任何計畫內容。
 * - 全校／僅班級／僅個人：各以 `count()` 精準計算（`in` 30 值／批）。
 * - 班級與個人同時指定：涉及聯集去重，改用既有待審清單（上限 100 筆）計數。
 * 審核中的計畫不可移至垃圾桶，故不必再過濾 `deletedAt`。
 */
export async function countSubmittedPlansForScope(
  period: string,
  scope: ReviewScope
): Promise<number> {
  if (scope.all) {
    const snap = await plansRef()
      .where("period", "==", period)
      .where("status", "==", "submitted")
      .count()
      .get();
    return snap.data().count;
  }

  const classCodes = [...new Set(scope.classCodes)];
  const studentUids = [...new Set(scope.studentUids)];
  if (classCodes.length > 0 && studentUids.length > 0) {
    return (await listSubmittedPlansForScope(period, scope)).length;
  }

  let total = 0;
  for (let index = 0; index < classCodes.length; index += 30) {
    const snap = await plansRef()
      .where("period", "==", period)
      .where("status", "==", "submitted")
      .where("classCode", "in", classCodes.slice(index, index + 30))
      .count()
      .get();
    total += snap.data().count;
  }
  for (let index = 0; index < studentUids.length; index += 30) {
    const snap = await plansRef()
      .where("period", "==", period)
      .where("status", "==", "submitted")
      .where("studentUid", "in", studentUids.slice(index, index + 30))
      .count()
      .get();
    total += snap.data().count;
  }
  return total;
}

/** 兼導師瀏覽全班（當期＋班級代碼，limit 有界） */
export async function listClassPlans(
  period: string,
  classCode: string,
  limit = 100
): Promise<SelfDirectedLearningPlan[]> {
  const snap = await plansRef()
    .where("period", "==", period)
    .where("classCode", "==", classCode)
    .limit(limit)
    .get();
  const plans = readPlansFromSnapshot(snap).filter((plan) => !plan.deletedAt);
  plans.sort((a, b) => a.studentName.localeCompare(b.studentName, "zh-Hant"));
  return plans;
}

export type ApplyReviewResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 403 | 404 | 409; message: string };

/** 產生審核紀錄文件 id（避免依賴 `.doc()` 無參數自動 id；主程式計讀 Proxy 不支援） */
function newReviewDocId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 套用審核結果（transaction：僅 submitted 可審，寫 review＋更新狀態）。
 * 審核不受送審期間限制。
 */
export async function applyReview(input: {
  planId: string;
  action: "approve" | "return";
  note: string;
  /** 逐週審查意見（富文本；可留空） */
  weekNotes?: PlanWeekReview[];
  reviewerUid: string;
  reviewerName: string;
  /** 審查範圍；未提供＝全校（管理員或未設定範圍的審核人員） */
  scope?: ReviewScope;
}): Promise<ApplyReviewResult> {
  const db = getAdminDb();
  const planRef = plansRef().doc(input.planId);
  // 主程式 Firestore 計讀／計寫 Proxy 會把 `doc()` 的無參數呼叫轉成 `doc(undefined)`，
  // 造成 documentPath 驗證失敗；這裡自行產生合法 id，確保審核可送出。
  const reviewRef = db
    .collection(SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION)
    .doc(newReviewDocId());

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(planRef);
    if (!snap.exists) return { kind: "missing" as const };
    const current = readPlan(planRef.id, (snap.data() || {}) as Record<string, unknown>);
    if (input.scope && !planInReviewScope(current, input.scope)) {
      return { kind: "outOfScope" as const };
    }
    if (current.deletedAt) return { kind: "badStatus" as const };
    if (current.status !== "submitted") return { kind: "badStatus" as const };

    // 「學生＋學期」鎖定文件：與送審共用同一份文件，讓狀態轉換序列化
    const lockRef = submissionLockRef(current.period, current.studentUid);
    const lockSnap = await tx.get(lockRef);
    const lock = (lockSnap.exists ? lockSnap.data() : null) as Record<string, unknown> | null;

    if (input.action === "approve") {
      // 同一學生同一學期僅能有一份正式計畫：先查鎖定文件，再掃描既有計畫（相容沒有鎖定文件的舊資料）
      const lockedApprovedId =
        typeof lock?.approvedPlanId === "string" ? lock.approvedPlanId : "";
      if (lockedApprovedId && lockedApprovedId !== current.id) {
        const lockedSnap = await tx.get(plansRef().doc(lockedApprovedId));
        if (lockedSnap.exists) {
          const lockedPlan = readPlan(
            lockedSnap.id,
            (lockedSnap.data() || {}) as Record<string, unknown>
          );
          if (lockedPlan.period === current.period && lockedPlan.status === "approved") {
            return { kind: "conflict" as const };
          }
        }
      }
      const approvedSnap = await tx.get(
        plansRef().where("studentUid", "==", current.studentUid).limit(50)
      );
      const conflict = approvedSnap.docs.some((doc) => {
        if (doc.id === current.id) return false;
        const data = (doc.data() || {}) as Record<string, unknown>;
        return data.period === current.period && !data.deletedAt && data.status === "approved";
      });
      if (conflict) return { kind: "conflict" as const };
    }
    const now = Date.now();
    const status: SelfDirectedLearningPlan["status"] =
      input.action === "approve" ? "approved" : "returned";
    tx.set(planRef, { status, updatedAt: now }, { merge: true });
    tx.set(reviewRef, {
      planId: input.planId,
      reviewerUid: input.reviewerUid,
      reviewerName: input.reviewerName,
      decision: input.action === "approve" ? "approved" : "returned",
      note: input.note,
      weekNotes: input.weekNotes ?? [],
      reviewedAt: now,
    });
    // 鎖定文件同步：通過＝記下正式計畫並清掉審核中；退回＝清掉審核中
    if (input.action === "approve") {
      tx.set(
        lockRef,
        {
          period: current.period,
          studentUid: current.studentUid,
          approvedPlanId: current.id,
          submittedPlanId: null,
          updatedAt: now,
        },
        { merge: true }
      );
    } else if (lock && lock.submittedPlanId === current.id) {
      tx.set(lockRef, { submittedPlanId: null, updatedAt: now }, { merge: true });
    }
    return {
      kind: "ok" as const,
      plan: { ...current, status, updatedAt: now },
    };
  });

  if (outcome.kind === "missing") {
    return { ok: false, status: 404, message: "查無此計畫" };
  }
  if (outcome.kind === "outOfScope") {
    return { ok: false, status: 403, message: "此計畫不在你的審查對象範圍內" };
  }
  if (outcome.kind === "badStatus") {
    return { ok: false, status: 409, message: "此計畫不在待審核狀態" };
  }
  if (outcome.kind === "conflict") {
    return { ok: false, status: 409, message: "此學生本學期已有正式計畫，無法再通過" };
  }
  return { ok: true, plan: outcome.plan };
}

/* ——— 家長端：子女關聯 ——— */

export interface LinkedChild {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  className: string;
}

/**
 * 家長→子女：以家長名冊條目的學號＋學期等值條件下推（1 筆查詢），
 * 唯一有效匹配才回傳（照宿主 linkedStudentIdentityForParent 省流模式）。
 */
export async function linkedChildForParent(
  parentEntry: Record<string, unknown>
): Promise<LinkedChild | null> {
  const studentId = typeof parentEntry.studentId === "string" ? parentEntry.studentId.trim() : "";
  if (!studentId) return null;
  const expectedGrade = typeof parentEntry.grade === "string" ? parentEntry.grade.trim() : "";
  const expectedClass = typeof parentEntry.classCode === "string" ? parentEntry.classCode.trim() : "";
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
    if (
      !uid ||
      (expectedGrade && grade !== expectedGrade) ||
      (expectedClass && classCode !== expectedClass)
    ) {
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
