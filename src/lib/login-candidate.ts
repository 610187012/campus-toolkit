import "server-only";
import type { DocumentReference, DocumentData } from "firebase-admin/firestore";
import { getAdminDbRaw } from "@/lib/firebase-admin";
import { getCurrentPeriod } from "@/lib/settings-server";
import { getRosterEntry, isActiveEntry } from "@/lib/roster";
import { getRoleEnabled, isRoleEnabled } from "@/lib/role-settings";
import { ALL_ROLES, isAccountActive, isUserRole, USER_COLLECTION, UserRole } from "@/types/users";

/** 使用者帳號的查詢結果（身分尚未決定；身分來自當期身分名冊） */
export interface AccountHit {
  /** 帳號文件 id（即 uid） */
  id: string;
  ref: DocumentReference;
  data: DocumentData;
}

/** 使用者帳號的一筆候選（身分 × 同一份使用者帳號文件） */
export interface AccountCandidate {
  role: UserRole;
  /** 帳號文件 id（即 uid，所有候選相同） */
  id: string;
  ref: DocumentReference;
  data: DocumentData;
}

/**
 * 依欄位（email／account）查找唯一的使用者帳號。
 * 帳號與電子郵件都全站唯一，故最多只會有一筆。
 */
export async function findAccountBy(
  field: "email" | "account",
  value: string
): Promise<AccountHit | null> {
  const snapshot = await getAdminDbRaw()
    .collection(USER_COLLECTION)
    .where(field, "==", value)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ref: doc.ref, data: doc.data() };
}

/**
 * 身分候選：同一份使用者帳號在「當期」名冊中有效的身分，順序固定 ALL_ROLES。
 * ①帳號狀態有效 ②具備當期（同學年度學期）且狀態有效的身分名冊條目
 * ③該身分於身分開關（settings 的 roleEnabled）中為啟用。
 * adminsOnly（系統維護）時只保留管理員且不套身分停用，與非管理員一律 503 的行為一致，
 * 避免身分開關異常時連管理員都進不去、無從修正。
 */
export async function detectRoleCandidates(
  hit: AccountHit,
  options: { adminsOnly?: boolean } = {}
): Promise<AccountCandidate[]> {
  if (!isAccountActive(hit.data)) return [];
  const period = await getCurrentPeriod();
  const enabled = await getRoleEnabled();
  const roles = ALL_ROLES.filter(
    (role) => (!options.adminsOnly || role === "admin") && enabled[role]
  );
  const entries = await Promise.all(
    roles.map((role) => getRosterEntry(hit.id, role, period))
  );
  const candidates: AccountCandidate[] = [];
  roles.forEach((role, index) => {
    if (isActiveEntry(entries[index])) {
      candidates.push({ role, id: hit.id, ref: hit.ref, data: hit.data });
    }
  });
  return candidates;
}

/**
 * 慣用身分：彙整候選上的 preferredRole（僅承認候選中真實存在的身分），
 * 剛好只有一個選擇才生效；沒有設定或多個互斥設定都回 null（交由選擇步驟處理）。
 */
export function preferredRoleAmong(
  candidates: readonly { role: UserRole; data: DocumentData }[]
): UserRole | null {
  if (candidates.length === 0) return null;
  const roles = new Set(candidates.map((candidate) => candidate.role));
  const preferred = new Set<UserRole>();
  for (const candidate of candidates) {
    const value = candidate.data.preferredRole;
    if (isUserRole(value) && roles.has(value)) preferred.add(value);
  }
  return preferred.size === 1 ? [...preferred][0] : null;
}

/** 多身分選擇回應的身分清單（固定 ALL_ROLES 順序） */
export function orderRoles(roles: UserRole[]): UserRole[] {
  return ALL_ROLES.filter((role) => roles.includes(role));
}

/**
 * 載入「使用者帳號＋當期該身分名冊條目」，並檢查兩層狀態。
 * 帳號不存在／帳號無效／名冊條目不存在或無效都回 null（session 與中途憑證都該失效）。
 */
export async function loadRoleContext(
  uid: string,
  role: UserRole
): Promise<{ account: AccountHit; entry: Record<string, unknown> } | null> {
  const snap = await getAdminDbRaw().collection(USER_COLLECTION).doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  if (!isAccountActive(data)) return null;
  const period = await getCurrentPeriod();
  // 身分開關停用時：session 不得成立
  if (!(await isRoleEnabled(role))) return null;
  const entry = await getRosterEntry(uid, role, period);
  if (!entry || !isActiveEntry(entry)) return null;
  return { account: { id: snap.id, ref: snap.ref, data }, entry };
}
