import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { createSession, getSession } from "@/lib/server-session";
import { revokeJti } from "@/lib/revocation";
import { logActivity, getClientIp } from "@/lib/audit";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { getCurrentPeriod, isSystemEnabled } from "@/lib/settings-server";
import { isRoleEnabled } from "@/lib/role-settings";
import { ROLE_LABELS, isAccountActive, USER_COLLECTION, isUserRole } from "@/types/users";
import { getRosterEntry, isActiveEntry, resolveDisplayName } from "@/lib/roster";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

/**
 * 已登入後切換身分。
 * 兩階段驗證屬「使用者帳號」層級、於登入時驗證過一次，故切換身分不重驗。
 * 只能在登入時偵測到的候選身分間切換，並撤銷舊 session（舊 jti 記入黑名單）。
 */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "switch-role",
      RATE.SWITCH_ROLE.limit,
      RATE.SWITCH_ROLE.windowMs
    );
    if (limited) return limited;

    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { success: false, message: "未登入或登入已失效" },
        { status: 401 }
      );
    }

    const parsed = await readJsonBody<{ role?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    if (!isUserRole(body.role)) {
      return NextResponse.json(
        { success: false, message: "參數錯誤" },
        { status: 400 }
      );
    }
    const role = body.role;

    // 只能在登入時偵測到的候選身分間切換
    const candidates = session.candidates?.length
      ? session.candidates
      : [{ role: session.role, id: session.uid }];
    const target = candidates.find((candidate) => candidate.role === role);
    if (!target) {
      return NextResponse.json(
        { success: false, message: "不具備該身分，無法切換" },
        { status: 403 }
      );
    }

    // 系統停用（維護）時僅允許切換至管理員
    if (role !== "admin" && !(await isSystemEnabled())) {
      return NextResponse.json(
        { success: false, message: "系統目前暫停服務，請稍後再試" },
        { status: 503 }
      );
    }

    // 帳號（同一份使用者文件）＋當期該身分名冊都必須存在且有效
    const snap = await getAdminDb()
      .collection(USER_COLLECTION)
      .doc(session.uid)
      .get();
    if (!snap.exists) {
      return NextResponse.json(
        { success: false, message: "身分資料已不存在，請重新登入" },
        { status: 401 }
      );
    }
    const data = snap.data()!;

    if (!isAccountActive(data)) {
      await logActivity({
        userId: session.uid,
        role,
        action: "role_switched",
        ip: getClientIp(request),
        details: `切換至 ${ROLE_LABELS[role]} 失敗：帳號已停用`,
      });
      return NextResponse.json(
        { success: false, message: "帳號已停用，無法切換" },
        { status: 401 }
      );
    }

    const period = await getCurrentPeriod();
    const entry = await getRosterEntry(session.uid, role, period);
    if (!isActiveEntry(entry)) {
      await logActivity({
        userId: session.uid,
        role,
        action: "role_switched",
        ip: getClientIp(request),
        details: `切換至 ${ROLE_LABELS[role]} 失敗：當期名冊無此身分`,
      });
      return NextResponse.json(
        { success: false, message: "身分資料已不存在，請重新登入" },
        { status: 401 }
      );
    }

    // 身分管理停用該學期的身分：不得切換過去
    if (!(await isRoleEnabled(role))) {
      await logActivity({
        userId: session.uid,
        role,
        action: "role_switched",
        ip: getClientIp(request),
        details: `切換至 ${ROLE_LABELS[role]} 失敗：該學期身分已停用`,
      });
      return NextResponse.json(
        { success: false, message: "該身分於本學期已停用，無法切換" },
        { status: 403 }
      );
    }

    const displayName = resolveDisplayName(data, entry);
    const user = {
      uid: session.uid,
      email: typeof data.email === "string" ? data.email : "",
      account: typeof data.account === "string" ? data.account : "",
      displayName,
      role,
      roles: candidates.map((candidate) => candidate.role),
      tokenVersion: typeof data.tokenVersion === "number" ? data.tokenVersion : 1,
    };

    // 目前身分：不重簽 token，避免無謂撤銷
    if (role === session.role) {
      return NextResponse.json({ success: true, user });
    }

    // 撤銷舊 session 後以同一組到期時間重簽
    try {
      await revokeJti(session.jti);
    } catch (error) {
      console.error("Revoke old jti error:", error);
    }

    await createSession({
      uid: user.uid,
      email: user.email,
      account: user.account,
      displayName: user.displayName,
      role,
      candidates,
      tokenVersion: user.tokenVersion,
      lastActivityAt: session.lastActivityAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    });

    await logActivity({
      userId: user.uid,
      role,
      action: "role_switched",
      ip: getClientIp(request),
      details: `由 ${ROLE_LABELS[session.role]} 切換至 ${ROLE_LABELS[role]}`,
    });

    return NextResponse.json({ success: true, user });
  } catch (error) {
    console.error("Switch role error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤，請稍後再試") },
      { status: 500 }
    );
  }
}
