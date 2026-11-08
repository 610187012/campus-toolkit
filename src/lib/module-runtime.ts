import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import {
  isMutatingMethod,
  needsModuleGate,
  roleFromApiPath,
  runtimeRateLimit,
} from "@/lib/module-runtime-policy";

/**
 * 模組 API 的宿主 runtime wrapper（P0-8）。
 *
 * 由 `scripts/build-module-registry.mjs` 產生的薄轉接檔自動包住每個 HTTP handler，
 * 不論模組程式碼有沒有寫齊，宿主都會在執行期強制：
 *
 * 1. 宿主層 rate limit（每模組×路由×IP 的安全上限）
 * 2. 寫入方法的 CSRF 同源檢查（POST／PUT／PATCH／DELETE）
 * 3. 登入驗證（`verifySession`：jti、tokenVersion、名冊、角色開關、閒置逾時）
 * 4. 路徑角色（`/api/admin/*`→admin、`/api/student/*`→student…）
 * 5. 非管理端（student／parent／staff）的「功能模組已啟用」閘門
 *
 * 模組自己的 `requireRole`／`assertSameOrigin`／`enforceRateLimit` 仍會執行，
 * 這裡是第二道防線；同時提供 `AsyncLocalStorage` 的模組上下文供後續功能使用。
 */

export interface ModuleRuntimeContext {
  moduleValue: string;
  pathname: string;
  method: string;
}

const storage = new AsyncLocalStorage<ModuleRuntimeContext>();

/** 目前請求所屬模組（不在模組 API 內時回 null） */
export function currentModuleValue(): string | null {
  return storage.getStore()?.moduleValue ?? null;
}

export function currentModuleContext(): ModuleRuntimeContext | null {
  return storage.getStore() ?? null;
}

export function runWithModuleContext<T>(context: ModuleRuntimeContext, fn: () => T): T {
  return storage.run(context, fn);
}

type RouteHandler = (request: NextRequest, context?: unknown) => Promise<Response> | Response;

function runtimeError(status: number, message: string): NextResponse {
  return NextResponse.json({ success: false, message }, { status });
}

/**
 * 包裝單一 HTTP handler。
 * @param moduleValue 模組代碼（寫入 runtime context 與限流桶）
 * @param handler 模組原本的 handler
 */
export function withModuleRuntime<T extends RouteHandler>(moduleValue: string, handler: T): T {
  const wrapped = async (request: NextRequest, context?: unknown): Promise<Response> => {
    const pathname = request.nextUrl.pathname;
    const method = request.method.toUpperCase();

    // 1) 宿主層安全上限
    const limited = enforceRateLimit(
      request,
      `module-runtime:${moduleValue}:${pathname}`,
      runtimeRateLimit(method),
      60_000
    );
    if (limited) return limited;

    // 2) CSRF（寫入方法）
    if (isMutatingMethod(method)) {
      const denied = assertSameOrigin(request);
      if (denied) return denied;
    }

    // 3) 登入驗證（完整 session 驗證，不只 JWT）
    let session;
    try {
      session = await verifySession();
    } catch {
      return runtimeError(401, "未登入或登入已失效");
    }
    if (!session) return runtimeError(401, "未登入或登入已失效");

    // 4) 路徑角色
    const requiredRole = roleFromApiPath(pathname);
    if (requiredRole && session.role !== requiredRole) {
      return runtimeError(403, "權限不足");
    }

    // 5) 非管理端：功能模組必須已啟用
    if (needsModuleGate(pathname)) {
      const gate = await requireFeatureModuleEnabled(moduleValue, session);
      if (gate) return gate;
    }

    return runWithModuleContext({ moduleValue, pathname, method }, () =>
      handler(request, context)
    );
  };
  return wrapped as T;
}
