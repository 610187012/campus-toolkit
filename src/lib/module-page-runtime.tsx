import "server-only";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { isFeatureModuleEnabled } from "@/lib/module-gate";
import { roleFromPagePath } from "@/lib/module-runtime-policy";
import { runWithModuleContext } from "@/lib/module-context";
import { ROLE_HOME } from "@/types/users";
import ModulePageDenied from "@/components/ModulePageDenied";

type PageComponent = (props: any) => any;

/**
 * 模組頁面的 server-side 閘門（P0-8）。
 *
 * 由 `scripts/build-module-registry.mjs` 產生的 page／layout 轉接檔包住：
 * 1. 先做完整 session 驗證（不是只靠 client-side AdminSectionShell）
 * 2. 依路徑前綴檢查角色（/admin、/student、/parent、/staff）
 * 3. 非管理端頁面檢查功能模組是否已啟用
 *
 * 通過後才呼叫原本的 page／layout，因此 server component 的資料讀取
 * 不會在 client gate 之前發生。
 */
export function withModulePage<T extends PageComponent>(
  moduleValue: string,
  pathname: string,
  Page: T
): T {
  const Gated = async (props: any) => {
    const session = await verifySession();
    if (!session) redirect("/");

    const requiredRole = roleFromPagePath(pathname);
    if (requiredRole && session.role !== requiredRole) {
      redirect(ROLE_HOME[session.role]);
    }

    if (requiredRole !== "admin" && !(await isFeatureModuleEnabled(moduleValue))) {
      return <ModulePageDenied message="此功能尚未啟用，請洽系統管理員。" />;
    }

    // 頁面（server component）也在模組 context 內執行：頁面若呼叫 getAdminDb()，
    // 會自動套用 scopedDb，不再只有 API 受集合限制。
    return runWithModuleContext(
      { moduleValue, pathname, method: "GET" },
      () => Page(props)
    );
  };
  return Gated as T;
}
