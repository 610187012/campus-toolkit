import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, FieldValue } from "@/lib/firebase-admin";
import { hasAdminModule, isSuperAdmin, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { logActivity, getClientIp } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod, getCacheEpoch } from "@/lib/settings-server";
import { cachedListRead, invalidateAdminListCache } from "@/lib/list-cache";
import { deleteStudentPersonalPhotoObjects, personalPhotoObjectPathsForRecord } from "@/lib/personal-info";
import {
  AccountStatus,
  AccountSummary,
  ACTIVE_STATUS,
  ALL_ROLES,
  AccountRecord,
  isAccountStatus,
  isTwoFactorMethod,
  isUserRole,
  lastLoginOf,
  normalizeAccountStatus,
  ROSTER_DELETE_SCOPE_LABELS,
  RosterDeleteScope,
  statusLabel,
  USER_COLLECTION,
  UserRole,
} from "@/types/users";
import { SchoolPeriod } from "@/types/settings";
import {
  PERSONAL_INFO_COLLECTION,
  STUDENT_PERSONAL_IDENTITY_COLLECTION,
} from "@/types/personal-info";
import {
  isRosterRole,
  rosterCollection,
  rosterRoleLabel,
  RosterInput,
  RosterRole,
} from "@/types/roster";
import {
  accountStatusGuard,
  adminAttributeGuard,
  buildAccountRecord,
  buildRosterEntry,
  checkAccountConflictDirect,
  hashRosterPassword,
  linkOrphanEntries,
  rosterEntryId,
  syncEntryIdentity,
  validateAccountInput,
  validateRosterInput,
} from "@/lib/roster";
import { readJsonBody } from "@/lib/http-body";

/** 帳號狀態變更的守門：本人、以及「仍是有效管理員且只剩他一位」都要擋 */
async function assertAccountStatusAllowed(
  uid: string,
  sessionUid: string
): Promise<NextResponse | null> {
  const message = await accountStatusGuard(uid, sessionUid);
  if (!message) return null;
  return NextResponse.json({ success: false, message }, { status: 400 });
}

/** 本學期四張名冊 → 每個 uid 具備的身分（順序固定 ALL_ROLES） */
async function loadRolesByUid(period: SchoolPeriod): Promise<Map<string, UserRole[]>> {
  const db = getAdminDb();
  const snapshots = await Promise.all(
    ALL_ROLES.map((role) =>
      db
        .collection(rosterCollection(role))
        .where("academicYear", "==", period.academicYear)
        .where("semester", "==", period.semester)
        .get()
    )
  );
  const map = new Map<string, UserRole[]>();
  snapshots.forEach((snapshot, index) => {
    const role = ALL_ROLES[index];
    for (const doc of snapshot.docs) {
      const uid = doc.data().uid;
      if (typeof uid !== "string" || !uid) continue;
      const list = map.get(uid) ?? [];
      if (!list.includes(role)) list.push(role);
      map.set(uid, list);
    }
  });
  for (const [uid, list] of map) {
    map.set(uid, ALL_ROLES.filter((role) => list.includes(role)));
  }
  return map;
}

/**
 * 單一帳號在當期具備的身分（mutation 回應組裝 summary 用）：
 * 四個確定性點查（doc id＝uid_學年度_學期），不存在＝0 讀，實際成本約 0～4 讀，
 * 取代整張名冊讀取（926 讀）。語意與 loadRolesByUid 一致（只看條目是否存在）。
 */
async function loadCurrentRolesByUid(uid: string, period: SchoolPeriod): Promise<UserRole[]> {
  const db = getAdminDb();
  const snaps = await Promise.all(
    ALL_ROLES.map((role) => db.collection(rosterCollection(role)).doc(rosterEntryId(uid, period)).get())
  );
  return ALL_ROLES.filter((_, index) => {
    const data = snaps[index].data();
    return snaps[index].exists && data?.uid === uid;
  });
}

/** 使用者帳號文件 → 工作表一列（不含密碼）
 *  第二參數同時接受 Firestore 回傳的 DocumentData 與型別化的 AccountRecord
 *（mutation 路由以寫入前的快照直接組列，免再點查）。 */
function toAccountSummary(
  uid: string,
  data: AccountRecord | Record<string, unknown>,
  roles: UserRole[]
): AccountSummary {
  const src = data as Record<string, unknown>;
  const str = (key: string) => (typeof src[key] === "string" ? (src[key] as string) : "");
  const summary: AccountSummary = {
    uid,
    email: str("email"),
    account: str("account"),
    name: str("name"),
    status: normalizeAccountStatus(src.status),
    roles,
  };
  if (isUserRole(src.preferredRole)) summary.preferredRole = src.preferredRole;
  if (isTwoFactorMethod(src.twoFactor)) summary.twoFactor = src.twoFactor;
  const lastLogin = lastLoginOf(src);
  if (lastLogin) summary.lastLogin = lastLogin;
  if (typeof src.loginCount === "number") summary.loginCount = src.loginCount;
  return summary;
}

function parseAccountBody(body: Record<string, unknown>): {
  uid: string;
  input: Record<string, string>;
  preferredRole: unknown;
} {
  const uid = typeof body.uid === "string" ? body.uid : "";
  return { uid, input: parseStringRecord(body.input), preferredRole: body.preferredRole };
}

function parseStringRecord(raw: unknown): Record<string, string> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {};
}

/** 「同時建立身分」區段：格式或身分無效回 null（呼叫端回 400） */
function parseRosterSection(raw: unknown): { role: RosterRole; input: RosterInput } | null {
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const section = raw as Record<string, unknown>;
  if (!isRosterRole(section.role)) return null;
  return { role: section.role, input: parseStringRecord(section.input) as RosterInput };
}

/** 慣用身分：undefined＝不更動、空字串＝清除、其餘須為合法身分 */
function isValidPreferredRole(value: unknown): boolean {
  return value === undefined || value === "" || isUserRole(value);
}

/** GET：全帳號工作表（不分頁），含每人的具備身分與登入資訊 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "accounts-list",
      RATE.ACCOUNTS_LIST.limit,
      RATE.ACCOUNTS_LIST.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("users");
    if (denial) return toAuthResponse(denial);

    const period = await getCurrentPeriod();
    const db = getAdminDb();
    // 全帳號工作表：一次「全部使用者＋當期四張名冊」的讀取量大，
    // 快取以 cacheEpoch 綁定（跨實例失效，見 list-cache.ts）；TTL 10 分鐘僅為硬上限
    const { data: payload, epoch } = await cachedListRead(
      `admin:accounts-list:${period.academicYear}:${period.semester}`,
      async () => {
        const [usersSnapshot, rolesByUid] = await Promise.all([
          db.collection(USER_COLLECTION).get(),
          loadRolesByUid(period),
        ]);

        const accounts = usersSnapshot.docs.map((doc) =>
          toAccountSummary(doc.id, doc.data(), rolesByUid.get(doc.id) ?? [])
        );
        accounts.sort(
          (a, b) => a.name.localeCompare(b.name, "zh-Hant") || a.account.localeCompare(b.account)
        );
        return { accounts, period };
      }
    );

    return NextResponse.json(
      // cacheEpoch 與快取 key 同源（見 list-cache.ts），前端據此判斷清單是否仍有效
      { success: true, ...payload, cacheEpoch: epoch },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Accounts list error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/**
 * POST：新增使用者帳號；可於同一請求附帶「同時建立身分」，
 * 於寫入帳號後一併建立本學期（目前學年度學期）的身分名冊條目。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "accounts-mutate",
      RATE.ACCOUNTS_MUTATE.limit,
      RATE.ACCOUNTS_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("users");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const { input, preferredRole } = parseAccountBody(body);
    if (!isValidPreferredRole(preferredRole)) {
      return NextResponse.json({ success: false, message: "慣用身分無效" }, { status: 400 });
    }

    // 同時建立身分（選填）：未提供＝只建帳號
    const rawRoster = body.roster;
    let rosterSection: { role: RosterRole; input: RosterInput } | null = null;
    if (rawRoster !== undefined && rawRoster !== null) {
      rosterSection = parseRosterSection(rawRoster);
      if (!rosterSection) {
        return NextResponse.json({ success: false, message: "帳號身分無效" }, { status: 400 });
      }
      // 名冊寫入屬「身分名冊管理」權限：未被指派者只能建立帳號本身
      if (!(await hasAdminModule(session, "roster"))) {
        return NextResponse.json(
          { success: false, message: "需具備「身分名冊管理」權限才能同時建立身分" },
          { status: 403 }
        );
      }
    }

    // 單筆建立不套用密碼強度規則（僅驗證非空白與長度上限），與批次匯入一致
    const result = validateAccountInput(input, {
      requirePassword: true,
      skipPasswordRule: true,
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, message: result.message }, { status: 400 });
    }

    // 名冊欄位驗證：帳號三欄一律以帳號輸入為準（名冊只存展示副本）
    const rosterValidation = rosterSection
      ? validateRosterInput(rosterSection.role, {
          ...rosterSection.input,
          email: result.account.email,
          account: result.account.account,
          name: result.account.name,
        })
      : null;
    if (rosterSection && !rosterValidation?.ok) {
      return NextResponse.json(
        { success: false, message: rosterValidation?.message || "身分資料無效" },
        { status: 400 }
      );
    }

    // 操作者是否為超級管理員（屬性守門與孤兒銜接的超級條目處理共用）
    const isSuper = await isSuperAdmin(session);

    // 屬性層級守門：非超級管理員不得藉「同時建立身分」建立超級管理員
    if (rosterSection && rosterValidation?.ok) {
      const guardMessage = adminAttributeGuard({
        isSuper,
        nextAttribute:
          typeof rosterValidation.roster.attribute === "string"
            ? rosterValidation.roster.attribute
            : null,
        currentAttribute: null,
      });
      if (guardMessage) return toAuthResponse({ status: 403, message: guardMessage });
    }

    const period = rosterSection ? await getCurrentPeriod() : null;
    // 建立身分時一併查同學號（同身分、本學期）；單筆只做精準查詢，不整表建索引（鐵律 3）
    const conflict = await checkAccountConflictDirect(
      result.account,
      rosterValidation?.ok ? rosterValidation.roster : {},
      rosterSection && period ? { role: rosterSection.role, period } : {}
    );
    if (conflict) {
      return NextResponse.json({ success: false, message: conflict }, { status: 409 });
    }

    const record = buildAccountRecord(
      result.account,
      await hashRosterPassword(result.password as string),
      isUserRole(preferredRole) ? preferredRole : undefined
    );
    const docRef = await getAdminDb().collection(USER_COLLECTION).add(record);

    // 自動銜接：同一辨識鍵曾留下孤兒名冊條目（帳號已刪除）時，整批改掛回本帳號
    // （超級條目僅超級管理員可銜接，否則等同授予超級權限）
    const linked = await linkOrphanEntries(
      {
        uid: docRef.id,
        email: result.account.email,
        account: result.account.account,
      },
      isSuper
    );
    const linkedLabel = linked > 0 ? `，已銜接名冊 ${linked} 筆` : "";

    // 本學期身分名冊條目：doc id ＝ uid_學年度_學期，之後可在「身分名冊管理」維護
    // （同身分本學期若為剛銜接的孤兒條目，此處以表單填寫的資料覆寫）
    // 帳號文件已建立，名冊寫入失敗不回滾：改以 partial 回報讓畫面明確提示補建，
    // 快取失效與稽核仍照常執行，避免半成品無紀錄、使用者重試又撞 409
    let rosterFailed = false;
    if (rosterSection && rosterValidation?.ok && period) {
      try {
        await getAdminDb()
          .collection(rosterCollection(rosterSection.role))
          .doc(rosterEntryId(docRef.id, period))
          .set(
            buildRosterEntry(docRef.id, rosterSection.role, period, rosterValidation.roster, {
              email: result.account.email,
              account: result.account.account,
              name: result.account.name,
            })
          );
      } catch (error) {
        rosterFailed = true;
        console.error("Account create roster error:", error);
      }
    }

    const rosterLabel = rosterSection
      ? rosterFailed
        ? `、建立本學期${rosterRoleLabel(rosterSection.role)}身分失敗`
        : `、同時建立本學期${rosterRoleLabel(rosterSection.role)}身分`
      : "";
    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "account_created",
      ip: getClientIp(request),
      details: `建立帳號 ${result.account.account || result.account.email}（${result.account.name}）${rosterLabel}${linkedLabel}`,
    });

    if (rosterFailed && rosterSection) {
      return NextResponse.json({
        success: true,
        partial: true,
        uid: docRef.id,
        summary: toAccountSummary(
          docRef.id,
          record,
          await loadCurrentRolesByUid(docRef.id, period ?? (await getCurrentPeriod()))
        ),
        cacheEpoch: await getCacheEpoch(),
        message: `帳號已建立，但本學期${rosterRoleLabel(rosterSection.role)}身分的名冊條目建立失敗，請至「身分名冊管理」補建`,
      });
    }

    return NextResponse.json({
      success: true,
      uid: docRef.id,
      // 回應即真相：伺服器組裝好的該列（當期身分以 4 個點查取得，含孤兒銜接結果），
      // 前端 patch 清單、不再整表重抓
      summary: toAccountSummary(
        docRef.id,
        record,
        await loadCurrentRolesByUid(docRef.id, period ?? (await getCurrentPeriod()))
      ),
      cacheEpoch: await getCacheEpoch(),
      message: rosterSection
        ? `帳號已建立，並已建立本學期${rosterRoleLabel(rosterSection.role)}身分${linkedLabel}`
        : `帳號已建立，請至「身分名冊管理」指定身分${linkedLabel}`,
    });
  } catch (error) {
    console.error("Account create error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/** PUT：更新帳號（電子郵件／帳號／姓名／密碼／慣用身分），同步本學期名冊展示資料 */
export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "accounts-mutate",
      RATE.ACCOUNTS_MUTATE.limit,
      RATE.ACCOUNTS_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("users");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const { uid, input, preferredRole } = parseAccountBody(body);
    if (!uid) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }
    if (!isValidPreferredRole(preferredRole)) {
      return NextResponse.json({ success: false, message: "慣用身分無效" }, { status: 400 });
    }

    // 單筆編輯填入新密碼時同樣不套用強度規則（留空＝不變更）
    const result = validateAccountInput(input, {
      requirePassword: false,
      skipPasswordRule: true,
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, message: result.message }, { status: 400 });
    }

    const ref = getAdminDb().collection(USER_COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ success: false, message: "查無此筆資料" }, { status: 404 });
    }

    // 精準查重（排除自己），不整表建索引（鐵律 3）
    const conflict = await checkAccountConflictDirect(result.account, {}, { excludeUid: uid });
    if (conflict) {
      return NextResponse.json({ success: false, message: conflict }, { status: 409 });
    }

    const { account, password } = result;
    const currentData = snap.data() || {};
    const prevEmail = typeof currentData.email === "string" ? currentData.email : "";
    const prevAccount = typeof currentData.account === "string" ? currentData.account : "";
    const identityChanged = prevEmail !== account.email || prevAccount !== account.account;
    const updateData: Record<string, unknown> = {
      email: account.email,
      account: account.account,
      name: account.name,
    };
    if (password) {
      const current = snap.data() || {};
      updateData.passwordHash = await hashRosterPassword(password);
      // 重設密碼即失效該帳號既有 session（文件沒有 tokenVersion 時視為 1）
      const currentVersion = typeof current.tokenVersion === "number" ? current.tokenVersion : 1;
      updateData.tokenVersion = currentVersion + 1;
      updateData.failedAttempts = 0;
      updateData.lockedUntil = 0;
      updateData.lockIp = "";
      // 管理員代設的預設密碼：對方下次登入須先由本人修改
      updateData.mustChangePassword = true;
    }
    // 慣用身分：空字串＝清除（多身分登入時改回每次詢問）
    if (preferredRole !== undefined) {
      updateData.preferredRole = isUserRole(preferredRole) ? preferredRole : FieldValue.delete();
    }

    await ref.update(updateData);

    const period = await getCurrentPeriod();
    // 名稱／信箱／帳號名變更：同步本學期四張名冊的展示資料（歷史學期不受影響）
    await syncEntryIdentity(uid, period, {
      email: account.email,
      account: account.account,
      name: account.name,
    });

    // 辨識鍵變更：把同辨識鍵的孤兒名冊條目（帳號已刪除）銜接回本帳號
    // （超級條目僅超級管理員可銜接，否則等同授予超級權限）
    const linked = identityChanged
      ? await linkOrphanEntries(
          { uid, email: account.email, account: account.account },
          await isSuperAdmin(session)
        )
      : 0;
    const linkedLabel = linked > 0 ? `，已銜接名冊 ${linked} 筆` : "";

    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "account_updated",
      ip: getClientIp(request),
      details: `更新帳號 ${account.account || account.email}${
        password ? "（密碼已重設）" : ""
      }${preferredRole !== undefined ? "（慣用身分已更新）" : ""}${linkedLabel}`,
    });

    // 回應即真相：以寫入後的資料組裝該列（0 額外讀取＋當期身分 4 點查），前端 patch 不整表重抓
    const accountAfter: Record<string, unknown> = {
      ...currentData,
      email: account.email,
      account: account.account,
      name: account.name,
    };
    if (preferredRole !== undefined) {
      if (isUserRole(preferredRole)) accountAfter.preferredRole = preferredRole;
      else delete accountAfter.preferredRole;
    }
    return NextResponse.json({
      success: true,
      summary: toAccountSummary(uid, accountAfter, await loadCurrentRolesByUid(uid, period)),
      cacheEpoch: await getCacheEpoch(),
      message: `帳號已更新${linkedLabel}`,
    });
  } catch (error) {
    console.error("Account update error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/** PATCH：帳號狀態（有效／無效），擋整個帳號能否登入 */
export async function PATCH(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "accounts-mutate",
      RATE.ACCOUNTS_MUTATE.limit,
      RATE.ACCOUNTS_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("users");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const uid = typeof body.uid === "string" ? body.uid : "";
    const status: AccountStatus | null = isAccountStatus(body.status) ? body.status : null;
    if (!uid || !status) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    const guard = await assertAccountStatusAllowed(uid, session.uid);
    if (guard) return guard;

    const ref = getAdminDb().collection(USER_COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ success: false, message: "查無此筆資料" }, { status: 404 });
    }
    await ref.update({ status });

    const account = snap.data() || {};
    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "account_updated",
      ip: getClientIp(request),
      details: `將帳號 ${account.account || uid} 狀態設為「${statusLabel(status)}」`,
    });

    return NextResponse.json({
      success: true,
      // 回應即真相：狀態列直接回傳，前端 patch 不整表重抓
      summary: toAccountSummary(
        uid,
        { ...account, status },
        await loadCurrentRolesByUid(uid, await getCurrentPeriod())
      ),
      cacheEpoch: await getCacheEpoch(),
      message: status === ACTIVE_STATUS ? "狀態已恢復為有效" : `狀態已設為「${statusLabel(status)}」`,
    });
  } catch (error) {
    console.error("Account status error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/**
 * DELETE：刪除使用者帳號，名冊條目依 `rosterScope` 處理：
 * `all`＝連動刪除所有學期（預設）、`current`＝只刪本學期、`none`＝保留名冊條目。
 */
export async function DELETE(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "accounts-mutate",
      RATE.ACCOUNTS_MUTATE.limit,
      RATE.ACCOUNTS_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("users");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const uid = typeof body.uid === "string" ? body.uid : "";
    if (!uid) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }
    const scopeRaw = typeof body.rosterScope === "string" ? body.rosterScope : "";
    const rosterScope: RosterDeleteScope =
      scopeRaw === "current" || scopeRaw === "none" ? scopeRaw : "all";

    const guard = await assertAccountStatusAllowed(uid, session.uid);
    if (guard) {
      // 刪除的守門訊息與停用不同
      return NextResponse.json(
        { success: false, message: "無法刪除自己或最後一位有效管理員" },
        { status: 400 }
      );
    }

    const db = getAdminDb();
    const ref = db.collection(USER_COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ success: false, message: "查無此筆資料" }, { status: 404 });
    }
    const target = snap.data() || {};

    await ref.delete();

    // 名冊條目：預設清掉四張名冊中所有學年度學期的條目，可改為只刪本學期或完全保留
    const scopeLabel = ROSTER_DELETE_SCOPE_LABELS[rosterScope];
    let deletes = 0;
    if (rosterScope !== "none") {
      const collections = ["rosterStudents", "rosterParents", "rosterStaff", "rosterAdmins"];
      const period = rosterScope === "current" ? await getCurrentPeriod() : null;
      const snaps = await Promise.all(
        collections.map((name) => db.collection(name).where("uid", "==", uid).get())
      );
      const batch = db.batch();
      for (const entrySnap of snaps) {
        for (const doc of entrySnap.docs) {
          const entry = doc.data();
          if (
            period &&
            (entry.academicYear !== period.academicYear || entry.semester !== period.semester)
          ) {
            continue;
          }
          batch.delete(doc.ref);
          deletes += 1;
        }
      }
      const personalInfoCollection = db.collection(PERSONAL_INFO_COLLECTION);
      const personalInfoQuery = period
        ? personalInfoCollection
            .where("uid", "==", uid)
            .where("academicYear", "==", period.academicYear)
            .where("semester", "==", period.semester)
        : personalInfoCollection.where("uid", "==", uid);
      const personalInfo = await personalInfoQuery.get();
      const photoObjectPaths: string[] = [];
      for (const doc of personalInfo.docs) {
        photoObjectPaths.push(...personalPhotoObjectPathsForRecord(uid, period ?? {
          academicYear: Number(doc.data().academicYear),
          semester: Number(doc.data().semester),
        }, doc.data()));
        batch.delete(doc.ref);
        deletes += 1;
      }
      if (rosterScope === "all") {
        batch.delete(db.collection(STUDENT_PERSONAL_IDENTITY_COLLECTION).doc(uid));
        deletes += 1;
      }
      if (deletes > 0) await batch.commit();
      await deleteStudentPersonalPhotoObjects(photoObjectPaths);
    }

    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "account_deleted",
      ip: getClientIp(request),
      details: `刪除帳號 ${target.account || target.email || uid}（${scopeLabel}）`,
    });

    return NextResponse.json({
      success: true,
      // 回應帶 uid：前端直接移除該列，不整表重抓
      uid,
      cacheEpoch: await getCacheEpoch(),
      message: `帳號已刪除（${scopeLabel}）`,
    });
  } catch (error) {
    console.error("Account delete error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}
