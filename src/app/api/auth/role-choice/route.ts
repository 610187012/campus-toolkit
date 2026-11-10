import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  clearPendingRoleCookie,
  createSession,
  getPendingRolePayload,
} from "@/lib/server-session";
import { logActivity, getClientIp } from "@/lib/audit";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { getCurrentPeriod, isSystemEnabled } from "@/lib/settings-server";
import { isRoleEnabled } from "@/lib/role-settings";
import { ROLE_LABELS, isAccountActive, USER_COLLECTION, isUserRole } from "@/types/users";
import { orderRoles } from "@/lib/login-candidate";
import { getRosterEntry, isActiveEntry, resolveDisplayName } from "@/lib/roster";
import { sendLoginNotification } from "@/lib/two-factor";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

const EXPIRED_MESSAGE = "驗證階段已過期，請重新登入";

function expired() {
  return NextResponse.json(
    { success: false, message: EXPIRED_MESSAGE },
    { status: 401 }
  );
}

/** GET：選擇身分頁初始化（信箱、稱謂、可選身分） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "role-choice",
      RATE.ROLE_CHOICE.limit,
      RATE.ROLE_CHOICE.windowMs
    );
    if (limited) return limited;

    const pending = await getPendingRolePayload();
    if (!pending) return expired();

    return NextResponse.json(
      {
        success: true,
        email: pending.email,
        account: pending.account,
        displayName: pending.displayName,
        roles: orderRoles(pending.candidates.map((candidate) => candidate.role)),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Role choice status error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

/** POST：確認要進入的身分，建立該身分的 session（不再重新驗證） */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "role-choice",
      RATE.ROLE_CHOICE.limit,
      RATE.ROLE_CHOICE.windowMs
    );
    if (limited) return limited;

    const pending = await getPendingRolePayload();
    if (!pending) return expired();

    const parsed = await readJsonBody<{ role?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // 只能選擇中途憑證內的身分（不可自行指定任一 uid／身分）
    if (!isUserRole(body.role)) return expired();
    const role = body.role;
    const target = pending.candidates.find((candidate) => candidate.role === role);
    if (!target) return expired();

    // 系統停用（維護）時僅管理員可完成登入（與帳密登入一致）
    if (role !== "admin" && !(await isSystemEnabled())) {
      await clearPendingRoleCookie();
      return NextResponse.json(
        { success: false, message: "系統目前暫停服務，請稍後再試" },
        { status: 503 }
      );
    }

    const snap = await getAdminDb()
      .collection(USER_COLLECTION)
      .doc(target.id)
      .get();
    if (!snap.exists) return expired();
    const data = snap.data()!;

    // 選擇期間被停用：不得建立 session
    if (!isAccountActive(data)) {
      await clearPendingRoleCookie();
      await logActivity({
        userId: target.id,
        role,
        action: "login_failed",
        ip: getClientIp(request),
        details: "選擇登入身分時帳號已停用，拒絕登入",
      });
      return NextResponse.json(
        { success: false, message: "帳號已停用，無法登入" },
        { status: 401 }
      );
    }

    // 當期名冊中該身分已不存在或無效：中途憑證作廢
    const period = await getCurrentPeriod();
    const entry = await getRosterEntry(target.id, role, period);
    if (!isActiveEntry(entry)) {
      await clearPendingRoleCookie();
      return expired();
    }

    // 選擇期間該身分被身分管理停用：中途憑證作廢
    if (!(await isRoleEnabled(role))) {
      await clearPendingRoleCookie();
      return expired();
    }

    await clearPendingRoleCookie();

    const ip = getClientIp(request);
    const now = Date.now();
    const loginRecords = [
      ...((Array.isArray(data.loginRecords) ? data.loginRecords : []) as number[]),
      now,
    ].slice(-50);

    await snap.ref.update({
      failedAttempts: 0,
      lockedUntil: 0,
      lockIp: "",
      lastLoginMethod: pending.via,
      loginCount: (data.loginCount || 0) + 1,
      loginRecords,
    });

    const displayName = resolveDisplayName(data, entry);
    const user = {
      uid: target.id,
      email: typeof data.email === "string" ? data.email : "",
      account: typeof data.account === "string" ? data.account : "",
      displayName,
      role,
      roles: pending.candidates.map((candidate) => candidate.role),
      tokenVersion: typeof data.tokenVersion === "number" ? data.tokenVersion : 1,
    };

    await createSession({
      uid: user.uid,
      email: user.email,
      account: user.account,
      displayName: user.displayName,
      role,
      candidates: pending.candidates,
      tokenVersion: user.tokenVersion,
    });

    if (pending.via.includes("email_notify")) {
      await sendLoginNotification({
        email: user.email,
        displayName: user.displayName,
        account: user.account,
        role,
      });
    }

    await logActivity({
      userId: user.uid,
      role,
      action: "login",
      ip,
      details: `選擇登入身分成功（${ROLE_LABELS[role]}）`,
    });

    // 首次登入須先改密碼（管理員代設的預設密碼）：回應即帶出，遮罩不必等重取 session
    return NextResponse.json({
      success: true,
      user: { ...user, mustChangePassword: data.mustChangePassword === true },
    });
  } catch (error) {
    console.error("Role choice error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤，請稍後再試") },
      { status: 500 }
    );
  }
}
