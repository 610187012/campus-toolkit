/**
 * 模組 API runtime wrapper 的純政策（P0-8）。
 * 零依賴，供 `module-runtime.ts` 與測試共用。
 */

export type RuntimeRole = "student" | "parent" | "staff" | "admin";

const ROLE_PREFIXES: Array<{ prefix: string; role: RuntimeRole }> = [
  { prefix: "/api/admin/", role: "admin" },
  { prefix: "/api/student/", role: "student" },
  { prefix: "/api/parent/", role: "parent" },
  { prefix: "/api/staff/", role: "staff" },
];

const PAGE_ROLE_PREFIXES: Array<{ prefix: string; role: RuntimeRole }> = [
  { prefix: "/admin", role: "admin" },
  { prefix: "/student", role: "student" },
  { prefix: "/parent", role: "parent" },
  { prefix: "/staff", role: "staff" },
];

/** 由頁面路徑前綴推導必要角色；無前綴回 null（僅要求登入） */
export function roleFromPagePath(pathname: string): RuntimeRole | null {
  for (const item of PAGE_ROLE_PREFIXES) {
    if (pathname === item.prefix || pathname.startsWith(`${item.prefix}/`)) {
      return item.role;
    }
  }
  return null;
}

/** 由 API 路徑前綴推導必要角色；無前綴回 null（僅要求登入） */
export function roleFromApiPath(pathname: string): RuntimeRole | null {
  for (const item of ROLE_PREFIXES) {
    if (pathname === item.prefix.slice(0, -1) || pathname.startsWith(item.prefix)) {
      return item.role;
    }
  }
  return null;
}

/** 是否套用「功能模組啟用」閘門（與 build-time 規則一致：student／parent／staff） */
export function needsModuleGate(pathname: string): boolean {
  return /^\/api\/(student|parent|staff)\//.test(pathname);
}

/** 寫入方法需要 CSRF 同源檢查 */
export function isMutatingMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE";
}

/** 宿主層安全上限（每分鐘、每個模組×路由×IP）；模組自己的限流通常更嚴 */
export function runtimeRateLimit(method: string): number {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD" || upper === "OPTIONS" ? 240 : 120;
}

/** 未知角色字串轉為 RuntimeRole（避免把任意字串當角色） */
export function isRuntimeRole(value: unknown): value is RuntimeRole {
  return value === "student" || value === "parent" || value === "staff" || value === "admin";
}
