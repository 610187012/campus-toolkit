import "server-only";
import { getAdminDb } from "@/lib/firebase-admin";
import type { GeneratedActivityAction } from "@/lib/activity-actions.generated";

export type ActivityAction =
  | "login"
  | "login_failed"
  | "account_locked"
  | "logout"
  | "password_changed"
  | "password_reset_requested"
  | "password_reset_completed"
  | "password_reset_failed"
  | "settings_change"
  | "admin_created"
  | "admin_updated"
  | "admin_deleted"
  | "account_created"
  | "account_updated"
  | "account_deleted"
  | "account_batch"
  | "two_factor_changed"
  | "two_factor_verified"
  | "two_factor_failed"
  | "role_switched"
  | "email_otp_sent"
  | "roster_created"
  | "roster_updated"
  | "roster_deleted"
  | "roster_imported"
  | "roster_batch"
  | "roster_linked"
  | "role_settings_updated"
  | "feature_module_updated"
  | "feature_module_role_updated"
  | "theme_market_installed"
  | "theme_market_published"
  | "theme_submitted"
  | "theme_preferences_updated"
  | "school_org_updated"
  | "school_profile_updated"
  | "school_semesters_updated"
  | "school_classes_updated"
  | "school_codes_updated"
  | "school_spaces_updated"
  | "school_periods_updated"
  | "announcements_created"
  | "announcements_updated"
  | "announcements_archived"
  | "announcements_deleted"
  | "announcements_staff_posted"
  | "announcements_settings_updated"
  | "personal_info_settings_updated"
  | "postal_codes_updated"
  | "student_personal_photo_updated"
  | "student_personal_info_updated"
  | "student_personal_info_batch_updated"
  | "calendar_created"
  | "calendar_updated"
  | "calendar_cancelled"
  | "calendar_deleted"
  | "calendar_settings_updated"
  /** 選用模組 manifest（auditActions）自動併入【期 0 批次 2】；空表時為 never */
  | GeneratedActivityAction;

export interface ActivityEntry {
  userId?: string;
  role?: string;
  action: ActivityAction;
  ip?: string;
  details?: string;
}

/**
 * 取得客戶端 IP。
 * 只信任平台提供的 request.ip，或明確部署在可信反向代理後時的 proxy header。
 * 直接以 next start 暴露時，x-real-ip / x-forwarded-for 皆可由客戶端偽造，一律不採信，
 * 避免攻擊者輪換偽造 IP 繞過限流與帳號鎖定。
 */
export function getClientIp(request: {
  headers: { get(name: string): string | null };
  ip?: string;
}): string {
  if (typeof request.ip === "string" && request.ip.trim()) {
    return request.ip.trim();
  }

  const trustProxy =
    process.env.VERCEL === "1" ||
    Boolean(process.env.K_SERVICE) ||
    process.env.TRUST_PROXY === "true";
  if (!trustProxy) return "";

  const real = request.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "";
}

export async function logActivity(entry: ActivityEntry): Promise<void> {
  try {
    await getAdminDb().collection("activityLog").add({
      userId: entry.userId || "",
      role: entry.role || "",
      action: entry.action,
      timestamp: Date.now(),
      ip: entry.ip || "",
      details: entry.details || "",
    });
  } catch (error) {
    console.error("Activity log error:", error);
  }
}
