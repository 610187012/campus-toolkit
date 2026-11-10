import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { checkAdminAttribute, requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { logActivity, getClientIp } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { getCurrentPeriod, getCacheEpoch } from "@/lib/settings-server";
import { cachedListRead, invalidateAdminListCache } from "@/lib/list-cache";
import {
  AccountStatus,
  ACTIVE_STATUS,
  ALL_ROLES,
  isAccountStatus,
  statusLabel,
  USER_COLLECTION,
} from "@/types/users";
import {
  isRosterRole,
  rosterCollection,
  rosterRoleLabel,
  RosterEntry,
  RosterInput,
  RosterRole,
} from "@/types/roster";
import {
  buildRosterEntry,
  checkAccountConflictDirect,
  countOtherActiveAdminsFrom,
  findAccountByKey,
  getRosterEntry,
  isAlreadyExistsError,
  isSuperEntry,
  lastSuperGuard,
  lastSuperGuardFrom,
  loadAdminGuardContext,
  rosterEntryId,
  syncEntryIdentity,
  toRosterMember,
  validateRosterInput,
} from "@/lib/roster";
import { readJsonBody } from "@/lib/http-body";

/** 條目上的管理員屬性字串（無／非字串＝空） */
function attributeOf(entry: Record<string, unknown> | null | undefined): string {
  return entry && typeof entry.attribute === "string" ? entry.attribute : "";
}

function parseRosterBody(body: Record<string, unknown>): {
  role: RosterRole | null;
  uid: string;
  input: RosterInput;
} {
  const role = isRosterRole(body.role) ? body.role : null;
  const uid = typeof body.uid === "string" ? body.uid : "";
  const raw = body.input;
  const input: RosterInput =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as RosterInput)
      : {};
  return { role, uid, input };
}

export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "roster-list",
      RATE.ROSTER_LIST.limit,
      RATE.ROSTER_LIST.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    // 綁定既有帳號：先用電子郵件／帳號查出帳號與其當期具備的身分
    const lookup = request.nextUrl.searchParams.get("lookup");
    if (lookup) {
      const account = await findAccountByKey(lookup);
      if (!account) {
        return NextResponse.json({ success: false, message: "查無此帳號" }, { status: 404 });
      }
      const period = await getCurrentPeriod();
      const entries = await Promise.all(
        ALL_ROLES.map((role) => getRosterEntry(account.uid, role, period))
      );
      const roles = ALL_ROLES.filter((_, index) => entries[index] !== null);
      return NextResponse.json(
        { success: true, account: { ...account, roles } },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const role = request.nextUrl.searchParams.get("role");
    if (!isRosterRole(role)) {
      return NextResponse.json(
        { success: false, message: "帳號身分無效" },
        { status: 400 }
      );
    }

    // 清單＝「當期」該身分名冊條目 join 使用者帳號（每次請求約「當期名冊＋同批使用者」次讀取）
    // 快取以 cacheEpoch 綁定（跨實例失效，見 list-cache.ts）；TTL 10 分鐘僅為硬上限
    const period = await getCurrentPeriod();
    const { data: payload, epoch } = await cachedListRead(
      `admin:roster-list:${role}:${period.academicYear}:${period.semester}`,
      async () => {
        const snapshot = await getAdminDb()
          .collection(rosterCollection(role))
          .where("academicYear", "==", period.academicYear)
          .where("semester", "==", period.semester)
          .get();

        const uids = [
          ...new Set(
            snapshot.docs
              .map((doc) => doc.data().uid)
              .filter((uid): uid is string => typeof uid === "string" && !!uid)
          ),
        ];
        // 使用者帳號分塊讀取（200 筆/批），避免整批 getAll 請求體過大（鐵律 4）
        const accounts = new Map<string, Record<string, unknown>>();
        const db = getAdminDb();
        for (let i = 0; i < uids.length; i += 200) {
          const chunk = uids.slice(i, i + 200);
          const accountDocs = await db.getAll(
            ...chunk.map((uid) => db.collection(USER_COLLECTION).doc(uid))
          );
          for (const doc of accountDocs) {
            if (doc.exists) accounts.set(doc.id, doc.data() ?? {});
          }
        }

        const members = snapshot.docs
          .map((doc) => {
            const entry = doc.data();
            const uid = typeof entry.uid === "string" ? entry.uid : doc.id;
            return toRosterMember(role, uid, accounts.get(uid) ?? null, entry);
          })
          .sort((a, b) =>
            a.name.localeCompare(b.name, "zh-Hant") || a.account.localeCompare(b.account)
          );

        return { members, period };
      }
    );

    return NextResponse.json(
      // cacheEpoch 與快取 key 同源（見 list-cache.ts），前端據此判斷清單是否仍有效
      { success: true, ...payload, cacheEpoch: epoch },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Roster list error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/**
 * POST：在「既有帳號」上建立本期名冊條目（綁定）。
 * 帳號與密碼屬「使用者帳號管理」，本 API 不建立帳號、不處理密碼。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "roster-mutate",
      RATE.ROSTER_MUTATE.limit,
      RATE.ROSTER_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const { role, uid, input } = parseRosterBody(body);
    if (!role) {
      return NextResponse.json({ success: false, message: "帳號身分無效" }, { status: 400 });
    }
    if (!uid) {
      return NextResponse.json({ success: false, message: "請先查詢要綁定的帳號" }, { status: 400 });
    }

    const period = await getCurrentPeriod();

    // 一個帳號最多四種身分（同身分同週期唯一），故只建立名冊條目
    const db = getAdminDb();
    const accountSnap = await db.collection(USER_COLLECTION).doc(uid).get();
    if (!accountSnap.exists) {
      return NextResponse.json({ success: false, message: "查無此帳號" }, { status: 404 });
    }
    const accountData = accountSnap.data() || {};
    const email = typeof accountData.email === "string" ? accountData.email : "";
    const account = typeof accountData.account === "string" ? accountData.account : "";
    const name = typeof accountData.name === "string" ? accountData.name : "";

    // 帳號欄位一律以既有帳號為準（表單只用來辨識，不改帳號層）
    const result = validateRosterInput(role, { ...input, email, account, name });
    if (!result.ok) {
      return NextResponse.json({ success: false, message: result.message }, { status: 400 });
    }

    // 屬性層級守門：非超級管理員不得建立「超級」管理員
    const attrDenial = await checkAdminAttribute(
      session,
      typeof result.roster.attribute === "string" ? result.roster.attribute : null,
      null
    );
    if (attrDenial) return toAuthResponse(attrDenial);

    // 電子郵件／帳號屬既有帳號，只檢查該身分專屬欄位（如學號）是否衝突；
    // 精準查詢（排除本人），不整表建索引（鐵律 3）
    const conflict = await checkAccountConflictDirect(result.account, result.roster, {
      role,
      period,
      excludeUid: uid,
    });
    if (conflict) {
      return NextResponse.json({ success: false, message: conflict }, { status: 409 });
    }

    const entryRef = db.collection(rosterCollection(role)).doc(rosterEntryId(uid, period));
    // 用 create() 一次完成「判存在＋寫入」：已存在即 ALREADY_EXISTS → 409，
    // 免先點查判存在（點查 1 讀；create 撞到＝ 0 讀），同 moveEntriesUid 的做法
    const newEntry = buildRosterEntry(uid, role, period, result.roster, { email, account, name });
    try {
      await entryRef.create(newEntry);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return NextResponse.json(
          { success: false, message: `此帳號本期已具備${rosterRoleLabel(role)}身分` },
          { status: 409 }
        );
      }
      throw error;
    }

    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "roster_created",
      ip: getClientIp(request),
      details: `將${rosterRoleLabel(role)}身分綁定至既有帳號 ${accountData.account || email}（${name}）`,
    });

    return NextResponse.json({
      success: true,
      uid,
      // 回應即真相：伺服器組裝好的該列（0 額外讀取），前端 patch 清單、不再整表重抓
      member: toRosterMember(role, uid, accountData, newEntry),
      cacheEpoch: await getCacheEpoch(),
      message: `${rosterRoleLabel(role)}已建立`,
    });
  } catch (error) {
    console.error("Roster create error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "roster-mutate",
      RATE.ROSTER_MUTATE.limit,
      RATE.ROSTER_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const { role, uid, input } = parseRosterBody(body);
    if (!role || !uid) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    const result = validateRosterInput(role, input);
    if (!result.ok) {
      return NextResponse.json({ success: false, message: result.message }, { status: 400 });
    }

    const ref = getAdminDb().collection(USER_COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ success: false, message: "查無此筆資料" }, { status: 404 });
    }

    const period = await getCurrentPeriod();
    const entryId = rosterEntryId(uid, period);
    const entryRef = getAdminDb().collection(rosterCollection(role)).doc(entryId);
    const entrySnap = await entryRef.get();
    const currentEntry = entrySnap.exists ? entrySnap.data() ?? null : null;

    // 屬性層級守門：非超級管理員不得指定「超級」、不得變更既有超級條目；
    // 另擋「降級最後一位超級管理員」（降級後無人可再指派超級）
    const nextAttribute =
      typeof result.roster.attribute === "string" ? result.roster.attribute : null;
    const attrDenial = await checkAdminAttribute(session, nextAttribute, attributeOf(currentEntry));
    if (attrDenial) return toAuthResponse(attrDenial);
    if (role === "admin" && isSuperEntry(currentEntry) && nextAttribute !== "超級") {
      const lastSuper = await lastSuperGuard(uid);
      if (lastSuper) {
        return NextResponse.json({ success: false, message: lastSuper }, { status: 400 });
      }
    }

    // 精準查重（排除本人），不整表建索引（鐵律 3）
    const conflict = await checkAccountConflictDirect(result.account, result.roster, {
      role,
      period,
      excludeUid: uid,
    });
    if (conflict) {
      return NextResponse.json({ success: false, message: conflict }, { status: 409 });
    }

    // 密碼、慣用身分、帳號狀態屬帳號層，由「使用者帳號管理」工作表維護
    const { account } = result;
    await ref.update({
      email: account.email,
      account: account.account,
      name: account.name,
    });

    // 名稱／信箱／帳號名變更：同步當期四張名冊的展示資料（歷史學期保留當時資料）
    await syncEntryIdentity(uid, period, {
      email: account.email,
      account: account.account,
      name: account.name,
    });

    // 名冊專屬欄位寫入「目前學年度學期」的條目，歷史學期不受影響
    //（是否存在沿用上方已讀的 entrySnap，不重複點查——鐵律 5）
    const updatedAt = Date.now();
    let entryAfter: RosterEntry | Record<string, unknown>;
    if (entrySnap.exists) {
      const patch: Record<string, unknown> = { ...result.roster, updatedAt };
      await entryRef.update(patch);
      entryAfter = { ...(currentEntry ?? {}), ...patch };
    } else {
      entryAfter = buildRosterEntry(uid, role, period, result.roster, {
        email: account.email,
        account: account.account,
        name: account.name,
      });
      await entryRef.set(entryAfter);
    }

    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "roster_updated",
      ip: getClientIp(request),
      details: `更新${rosterRoleLabel(role)} ${account.account || account.email}`,
    });

    return NextResponse.json({
      success: true,
      // 回應即真相：以寫入後的使用者＋條目組裝該列（0 額外讀取），前端 patch 不整表重抓
      member: toRosterMember(
        role,
        uid,
        { ...snap.data(), email: account.email, account: account.account, name: account.name },
        entryAfter
      ),
      cacheEpoch: await getCacheEpoch(),
      message: "資料已更新",
    });
  } catch (error) {
    console.error("Roster update error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/**
 * PATCH：切換「本期該身分」的名冊狀態（有效／無效）。
 * 帳號層狀態（整個帳號能否登入）由「使用者帳號管理」工作表維護。
 */
export async function PATCH(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "roster-mutate",
      RATE.ROSTER_MUTATE.limit,
      RATE.ROSTER_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const role = isRosterRole(body.role) ? body.role : null;
    const uid = typeof body.uid === "string" ? body.uid : "";
    const status: AccountStatus | null = isAccountStatus(body.status) ? body.status : null;
    if (!role || !uid || !status) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    if (status !== ACTIVE_STATUS && uid === session.uid) {
      return NextResponse.json(
        { success: false, message: "無法停用自己使用的本期身分" },
        { status: 400 }
      );
    }

    // 管理員守門（其有效人數、最後一位超級）共用同一份上下文：
    // 整個請求只讀一次「當期管理員名冊＋其帳號」，其後判定全是純計算
    //（鐵律 4／5：同請求內復用，不逐項重載）
    const guardContext =
      status !== ACTIVE_STATUS && role === "admin" ? await loadAdminGuardContext() : null;
    if (guardContext && countOtherActiveAdminsFrom(guardContext, uid) === 0) {
      return NextResponse.json(
        { success: false, message: "無法停用最後一位有效管理員" },
        { status: 400 }
      );
    }

    const period = await getCurrentPeriod();
    const ref = getAdminDb().collection(rosterCollection(role)).doc(rosterEntryId(uid, period));
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ success: false, message: "查無此筆資料" }, { status: 404 });
    }
    const statusEntry = snap.data() || {};

    // 屬性層級守門：非超級管理員不得動超級條目；停用最後一位超級管理員也要擋
    const statusDenial = await checkAdminAttribute(session, null, attributeOf(statusEntry));
    if (statusDenial) return toAuthResponse(statusDenial);
    if (guardContext && isSuperEntry(statusEntry)) {
      const lastSuper = lastSuperGuardFrom(guardContext, uid);
      if (lastSuper) {
        return NextResponse.json({ success: false, message: lastSuper }, { status: 400 });
      }
    }

    const statusUpdatedAt = Date.now();
    await ref.update({ status, updatedAt: statusUpdatedAt });

    const account = (await getAdminDb().collection(USER_COLLECTION).doc(uid).get()).data() || {};
    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "roster_updated",
      ip: getClientIp(request),
      details: `將${rosterRoleLabel(role)}本期身分 ${account.account || uid} 狀態設為「${statusLabel(status)}」`,
    });

    return NextResponse.json({
      success: true,
      // 回應即真相：狀態列直接回傳（0 額外讀取），前端 patch 不整表重抓
      member: toRosterMember(role, uid, account, { ...statusEntry, status, updatedAt: statusUpdatedAt }),
      cacheEpoch: await getCacheEpoch(),
      message: status === ACTIVE_STATUS ? "狀態已恢復為有效" : `狀態已設為「${statusLabel(status)}」`,
    });
  } catch (error) {
    console.error("Account status error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "roster-mutate",
      RATE.ROSTER_MUTATE.limit,
      RATE.ROSTER_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const { role, uid } = parseRosterBody(body);
    if (!role || !uid) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    // 只刪除「本期」名冊條目，帳號與其他學期資料保留（帳號刪除請用帳號工作表）
    if (role === "admin" && uid === session.uid) {
      return NextResponse.json(
        { success: false, message: "無法刪除自己的管理員身分" },
        { status: 400 }
      );
    }

    const period = await getCurrentPeriod();
    const ref = getAdminDb().collection(rosterCollection(role)).doc(rosterEntryId(uid, period));
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ success: false, message: "查無此筆資料" }, { status: 404 });
    }
    const entry = snap.data() || {};

    // 屬性層級守門：非超級管理員不得刪除超級條目；刪除最後一位超級管理員也要擋。
    // 兩項判定共用同一份上下文，整個請求只讀一次（不重複載入整張當期管理員名冊）
    const attrDenial = await checkAdminAttribute(session, null, attributeOf(entry));
    if (attrDenial) return toAuthResponse(attrDenial);
    const guardContext = role === "admin" ? await loadAdminGuardContext() : null;
    if (guardContext && isSuperEntry(entry)) {
      const lastSuper = lastSuperGuardFrom(guardContext, uid);
      if (lastSuper) {
        return NextResponse.json({ success: false, message: lastSuper }, { status: 400 });
      }
    }

    if (guardContext && countOtherActiveAdminsFrom(guardContext, uid) === 0) {
      return NextResponse.json(
        { success: false, message: "無法刪除最後一位有效管理員" },
        { status: 400 }
      );
    }

    await ref.delete();

    const account = (await getAdminDb().collection(USER_COLLECTION).doc(uid).get()).data() || {};
    await invalidateAdminListCache();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "roster_deleted",
      ip: getClientIp(request),
      details: `刪除${rosterRoleLabel(role)} ${account.account || account.email || uid} 的本期名冊資料`,
    });

    return NextResponse.json({
      success: true,
      // 回應帶 uid：前端直接移除該列，不整表重抓
      uid,
      cacheEpoch: await getCacheEpoch(),
      message: `已刪除本期${rosterRoleLabel(role)}名冊資料`,
    });
  } catch (error) {
    console.error("Roster delete error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}
