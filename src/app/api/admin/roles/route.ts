import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { logActivity, getClientIp } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { SETTINGS_COLLECTION, SETTINGS_DOC_ID } from "@/lib/settings-server";
import { invalidateReadCache, AUTHZ_CACHE_PREFIX } from "@/lib/read-cache";
import { getRoleEnabled, invalidateRoleSettingsCache } from "@/lib/role-settings";
import { ROLE_LABELS, isUserRole, UserRole } from "@/types/users";
import { RoleEnabledMap, ROLE_ENABLED_FIELD } from "@/types/role-settings";
import { readJsonBody } from "@/lib/http-body";

/** GET：讀取四種身分的現行啟用狀態 */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "role-settings",
      RATE.ROLE_SETTINGS_GET.limit,
      RATE.ROLE_SETTINGS_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    const roles = await getRoleEnabled();
    return NextResponse.json(
      { success: true, roles },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Role settings list error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/** PATCH：啟用／停用單一身分（現行開關，跨學期沿用） */
export async function PATCH(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "role-settings",
      RATE.ROLE_SETTINGS_MUTATE.limit,
      RATE.ROLE_SETTINGS_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("roster");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const role: UserRole | null = isUserRole(body.role) ? body.role : null;
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
    if (!role || enabled === null) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    // 停用管理員＝所有管理員失效，之後無人可回到本頁重新啟用，故一律禁止
    if (role === "admin" && !enabled) {
      return NextResponse.json(
        { success: false, message: "無法停用管理員身分（停用後將無人可管理系統）" },
        { status: 400 }
      );
    }

    const current = await getRoleEnabled();
    const next: RoleEnabledMap = { ...current, [role]: enabled };
    await getAdminDb()
      .collection(SETTINGS_COLLECTION)
      .doc(SETTINGS_DOC_ID)
      .set({ [ROLE_ENABLED_FIELD]: next }, { merge: true });
    invalidateRoleSettingsCache();
    // 身分開關直接影響 verifySession 的 isRoleEnabled 判定：
    // 本機 authz 快取立即清除；跨實例靠 authz TTL（8 秒）自動過期
    invalidateReadCache(AUTHZ_CACHE_PREFIX);

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "role_settings_updated",
      ip: getClientIp(request),
      details: `將${ROLE_LABELS[role]}身分設為「${enabled ? "啟用" : "停用"}」`,
    });

    return NextResponse.json({
      success: true,
      message: `${ROLE_LABELS[role]}已${enabled ? "啟用" : "停用"}`,
      roles: next,
    });
  } catch (error) {
    console.error("Role settings update error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}
