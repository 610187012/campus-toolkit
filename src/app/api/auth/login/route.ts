import { NextRequest, NextResponse } from "next/server";
import { verifyPassword, hashPassword } from "@/lib/auth";
import {
  createSession,
  setPending2FACookie,
  setPendingRoleCookie,
} from "@/lib/server-session";
import { logActivity, getClientIp } from "@/lib/audit";
import {
  enforceRateLimit,
  enforceAccountRateLimit,
  RATE,
} from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { getCurrentPeriod, isSystemEnabled } from "@/lib/settings-server";
import { invalidateReadCache, AUTHZ_CACHE_PREFIX } from "@/lib/read-cache";
import {
  maskEmail,
  readTwoFactorProfile,
  sendEmailOtp,
  sendLoginNotification,
} from "@/lib/two-factor";
import { isAccountActive, UserRole } from "@/types/users";
import {
  AccountCandidate,
  AccountHit,
  detectRoleCandidates,
  findAccountBy,
  orderRoles,
  preferredRoleAmong,
} from "@/lib/login-candidate";
import { getRosterEntry, resolveDisplayName } from "@/lib/roster";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
/** 全域鎖定門檻：不綁 IP，跨來源累計失敗即鎖，擋 botnet／換 IP 爆破 */
const GLOBAL_LOCK_THRESHOLD = 20;
const GLOBAL_LOCK_DURATION_MS = 60 * 60 * 1000;
const GENERIC_LOGIN_ERROR = "帳號或密碼錯誤";
const SYSTEM_DISABLED_MESSAGE = "系統目前暫停服務，請稍後再試";

// 帳號不存在時也跑一次同成本 bcrypt，消除「有無帳號」的時序差（帳號枚舉）
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("timing-equalization-placeholder", 12);
  }
  return dummyHashPromise;
}

/** 單一密碼驗證：雜湊缺漏／格式錯誤直接不通過，不送進 bcrypt */
async function checkPassword(password: string, data: Record<string, unknown>): Promise<boolean> {
  const hash = typeof data.passwordHash === "string" ? data.passwordHash : "";
  if (!hash || !hash.startsWith("$")) return false;
  return verifyPassword(password, hash);
}

/** 鎖定是否命中目前來源：lockIp 為空＝全域鎖定；全域門檻達標一律視為鎖定 */
function isLockedFor(data: Record<string, unknown>, ip: string): boolean {
  const lockedUntil = typeof data.lockedUntil === "number" ? data.lockedUntil : 0;
  const lockIp = typeof data.lockIp === "string" ? data.lockIp : "";
  const failedAttempts =
    typeof data.failedAttempts === "number" ? data.failedAttempts : 0;
  const lockActive = lockedUntil > Date.now() && (!lockIp || !ip || lockIp === ip);
  const globalLockActive =
    failedAttempts >= GLOBAL_LOCK_THRESHOLD && lockedUntil > Date.now();
  return lockActive || globalLockActive;
}

/**
 * 密碼錯誤：對使用者帳號累加失敗次數。
 * 各身分共用同一份帳號文件，故只有一份計數（與多身分的舊行為一致）。
 */
async function recordLoginFailure(hit: AccountHit, ip: string): Promise<void> {
  const data = hit.data;
  const lockedUntil = typeof data.lockedUntil === "number" ? data.lockedUntil : 0;
  const lockIp = typeof data.lockIp === "string" ? data.lockIp : "";
  const failedAttempts = typeof data.failedAttempts === "number" ? data.failedAttempts : 0;

  // 鎖定已過期：重設計數，讓使用者在冷卻後重新開始
  const lockExpired = lockedUntil > 0 && lockedUntil <= Date.now();
  const baseFailures = lockExpired ? 0 : failedAttempts;
  const newFailCount = baseFailures + 1;

  let lockUntil = 0;
  let nextLockIp = ip;
  if (newFailCount >= GLOBAL_LOCK_THRESHOLD) {
    lockUntil = Date.now() + GLOBAL_LOCK_DURATION_MS;
    nextLockIp = ""; // 全域鎖定：清空 lockIp，對所有來源生效
  } else if (newFailCount >= LOCK_THRESHOLD) {
    const existingLockActive = lockedUntil > Date.now();
    if (!existingLockActive || !lockIp || lockIp === ip) {
      lockUntil = Date.now() + LOCK_DURATION_MS;
      nextLockIp = ip;
    } else {
      // 鎖定綁在其他 IP：保留原鎖定，僅累加計數，避免換 IP 釋放原鎖
      lockUntil = lockedUntil;
      nextLockIp = lockIp;
    }
  } else if (lockExpired) {
    lockUntil = 0;
    nextLockIp = "";
  }

  await hit.ref.update({
    failedAttempts: newFailCount,
    lockedUntil: lockUntil,
    lockIp: lockUntil ? nextLockIp : "",
  });

  // 鎖定寫入會影響 verifySession 的 lockedUntil 檢查：
  // 有設鎖時清本機 authz 快取，讓既有 session 立即套用鎖定（跨實例靠 TTL 8 秒）
  if (lockUntil > 0) {
    invalidateReadCache(AUTHZ_CACHE_PREFIX);
  }

  if (newFailCount >= GLOBAL_LOCK_THRESHOLD) {
    await logActivity({
      userId: hit.id,
      action: "account_locked",
      ip,
      details: `連續失敗 ${GLOBAL_LOCK_THRESHOLD} 次，全域鎖定 ${GLOBAL_LOCK_DURATION_MS / 60_000} 分鐘`,
    });
  } else if (newFailCount === LOCK_THRESHOLD) {
    await logActivity({
      userId: hit.id,
      action: "account_locked",
      ip,
      details: `連續失敗 ${LOCK_THRESHOLD} 次，鎖定 15 分鐘（限來源 ${ip || "未知"}）`,
    });
  }

  await logActivity({
    userId: hit.id,
    action: "login_failed",
    ip,
    details: `密碼錯誤，失敗次數 ${newFailCount}`,
  });
}

export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "login",
      RATE.LOGIN.limit,
      RATE.LOGIN.windowMs
    );
    if (limited) return limited;

    const parsed = await readJsonBody<{ account?: unknown; password?: unknown }>(
      request
    );
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const { account, password } = body;
    const ip = getClientIp(request);

    if (
      typeof account !== "string" ||
      typeof password !== "string" ||
      !account ||
      !password
    ) {
      return NextResponse.json(
        { success: false, message: "請輸入帳號與密碼" },
        { status: 400 }
      );
    }

    const systemEnabled = await isSystemEnabled();
    const input = String(account).toLowerCase().trim();

    // 帳號維度限流：不依賴 IP，擋針對單一帳號的爆破
    const accountLimited = enforceAccountRateLimit(
      "login",
      "any",
      input,
      RATE.LOGIN_ACCOUNT.limit,
      RATE.LOGIN_ACCOUNT.windowMs
    );
    if (accountLimited) return accountLimited;

    const isEmail = input.includes("@");
    const field = isEmail ? "email" : "account";

    // 使用者帳號唯一（身分由當期名冊決定）
    const hit = await findAccountBy(field, input);

    if (!hit) {
      if (!systemEnabled) {
        return NextResponse.json(
          { success: false, message: SYSTEM_DISABLED_MESSAGE },
          { status: 503 }
        );
      }
      await verifyPassword(password, await getDummyHash());
      await logActivity({
        action: "login_failed",
        ip,
        details: `帳號不存在或錯誤：${input}`,
      });
      // 401 + 通用訊息：不證實帳號是否存在（防枚舉）
      return NextResponse.json(
        { success: false, message: GENERIC_LOGIN_ERROR },
        { status: 401 }
      );
    }

    // 鎖定命中目前來源即以通用回覆拒絕（不透露鎖定狀態）
    if (isLockedFor(hit.data, ip)) {
      await logActivity({
        userId: hit.id,
        action: "login_failed",
        ip,
        details: "帳號已鎖定期間嘗試登入",
      });
      return NextResponse.json(
        { success: false, message: GENERIC_LOGIN_ERROR },
        { status: 401 }
      );
    }

    if (!(await checkPassword(password, hit.data))) {
      await recordLoginFailure(hit, ip);
      return NextResponse.json(
        { success: false, message: GENERIC_LOGIN_ERROR },
        { status: 401 }
      );
    }

    // 停用（無效）帳號不得登入。放在密碼驗證成功後才擋，
    // 不會在帳號不存在／密碼錯誤時透露帳號狀態（防枚舉）
    if (!isAccountActive(hit.data)) {
      await logActivity({
        userId: hit.id,
        action: "login_failed",
        ip,
        details: `停用帳號（${typeof hit.data.status === "string" ? hit.data.status : "無效"}）嘗試登入`,
      });
      return NextResponse.json(
        { success: false, message: GENERIC_LOGIN_ERROR },
        { status: 401 }
      );
    }

    // 身分候選：當期名冊中有效的身分；系統停用（維護）時僅管理員可登入
    const candidates = await detectRoleCandidates(hit, { adminsOnly: !systemEnabled });
    if (candidates.length === 0) {
      if (!systemEnabled) {
        return NextResponse.json(
          { success: false, message: SYSTEM_DISABLED_MESSAGE },
          { status: 503 }
        );
      }
      await logActivity({
        userId: hit.id,
        action: "login_failed",
        ip,
        details: "通過帳密驗證，但當期無可用身分（身分名冊無有效條目）",
      });
      return NextResponse.json(
        { success: false, message: GENERIC_LOGIN_ERROR },
        { status: 401 }
      );
    }

    const preferred = preferredRoleAmong(candidates);
    const primary: AccountCandidate = candidates[0];

    const displayName = typeof primary.data.name === "string" ? primary.data.name : "";
    const primaryEmail = typeof primary.data.email === "string" ? primary.data.email : "";
    const primaryAccount =
      typeof primary.data.account === "string" ? primary.data.account : "";

    // 兩階段驗證：登入時驗證一次（設定取自使用者帳號），與要進入的身分無關
    const { method: twoFactorMethod } = readTwoFactorProfile(primary.data);
    if (twoFactorMethod === "email_otp" || twoFactorMethod === "totp") {
      // Email OTP 寄信不可用（SMTP 未設定）時不阻擋登入，避免把自己鎖在門外
      const otpState =
        twoFactorMethod === "email_otp"
          ? await sendEmailOtp({
              ref: primary.ref,
              data: primary.data,
              email: primaryEmail,
              displayName,
              account: primaryAccount,
              role: primary.role,
            })
          : "sent";

      if (otpState !== "smtp") {
        await setPending2FACookie({
          uid: primary.id,
          email: primaryEmail,
          account: primaryAccount,
          displayName,
          role: primary.role,
          candidates,
          preferred,
          method: twoFactorMethod,
          via: "password",
        });
        await logActivity({
          userId: primary.id,
          role: primary.role,
          action: twoFactorMethod === "email_otp" ? "email_otp_sent" : "login",
          ip,
          details:
            twoFactorMethod === "email_otp"
              ? otpState === "cooldown"
                ? "登入請求 Email OTP（120 秒節流內，沿用既有驗證碼）"
                : "登入請求 Email OTP，已寄出驗證碼"
              : "帳密通過，等待 TOTP 驗證",
        });
        return NextResponse.json({
          success: true,
          requires2FA: twoFactorMethod,
          maskedEmail: maskEmail(primaryEmail),
        });
      }

      await logActivity({
        userId: primary.id,
        role: primary.role,
        action: "login",
        ip,
        details: "Email OTP 無法寄出，略過兩階段驗證直接登入",
      });
    }

    // 多身分且未設定慣用身分：帳密已驗證，登入視為成功，交由選擇身分專頁決定要進入的身分
    if (!preferred && candidates.length > 1) {
      await setPendingRoleCookie({
        email: primaryEmail,
        account: primaryAccount,
        displayName,
        via: twoFactorMethod === "email_notify" ? "password+email_notify" : "password",
        candidates,
      });
      return NextResponse.json({
        success: false,
        requiresRoleChoice: orderRoles(candidates.map((candidate) => candidate.role)),
        message: "此帳號具備多個身分，請選擇要登入的身分",
      });
    }

    const role: UserRole = preferred ?? primary.role;

    // 稱謂以「當期該身分名冊的姓名」為準，沒有才退回帳號姓名
    const entry = await getRosterEntry(hit.id, role, await getCurrentPeriod());
    const finalDisplayName = resolveDisplayName(hit.data, entry);

    const now = Date.now();
    const loginRecords = [
      ...((Array.isArray(hit.data.loginRecords) ? hit.data.loginRecords : []) as number[]),
      now,
    ].slice(-50);

    await hit.ref.update({
      failedAttempts: 0,
      lockedUntil: 0,
      lockIp: "",
      lastLoginMethod:
        twoFactorMethod === "email_notify" ? "password+email_notify" : "password",
      loginCount: (hit.data.loginCount || 0) + 1,
      loginRecords,
    });

    const user = {
      uid: hit.id,
      email: primaryEmail,
      account: primaryAccount,
      displayName: finalDisplayName,
      role,
      roles: candidates.map((candidate) => candidate.role),
      tokenVersion:
        typeof hit.data.tokenVersion === "number" ? hit.data.tokenVersion : 1,
      // 首次登入須先改密碼（管理員代設的預設密碼）：登入回應即帶出，遮罩不必等重取 session
      mustChangePassword: hit.data.mustChangePassword === true,
    };

    await createSession({
      uid: user.uid,
      email: user.email,
      account: user.account,
      displayName: user.displayName,
      role,
      candidates,
      tokenVersion: user.tokenVersion,
    });

    if (twoFactorMethod === "email_notify") {
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
      details:
        twoFactorMethod === "email_notify"
          ? "帳密登入成功（已寄送登入通知）"
          : "帳密登入成功",
    });

    return NextResponse.json({ success: true, user });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      {
        success: false,
        message: serverErrorMessage(error, "系統錯誤，請稍後再試"),
      },
      { status: 500 }
    );
  }
}
