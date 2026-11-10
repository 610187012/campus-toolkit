import { NextRequest, NextResponse } from "next/server";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { serverErrorMessage } from "@/lib/api-error";
import { getAppHostingUsage } from "@/lib/usage-apphosting";
import { getFirebaseUsage } from "@/lib/usage-firebase";
import { getReadStatsSnapshot, resetReadStats } from "@/lib/read-stats";
import type { ReadStatsDiag } from "@/lib/read-stats";
import type { StatsResponse, UsageSection } from "@/types/usage";
import { readJsonBody } from "@/lib/http-body";

/**
 * 統計儀表板：App Hosting（Cloud Run／Cloud Build）與 Firebase（Firestore）用量，
 * 以及端點級讀取統計（read-stats，本實例進程內累計、不寫 Firestore）。
 *
 * 權限：`stats` 是 superOnly 權限模組（`adminModulesOf` 只會把它給超級管理員），
 * 因此 `requireAdminModule("stats")` 即等同僅超級管理員可讀。
 * 兩個外部來源各自抓取、互不阻斷（一個失敗仍回另一個），結果於伺服器端快取 5 分鐘。
 *
 * POST：`{ action: "reset-read-stats" }` 清空本實例的端點讀取統計（開發除錯用）。
 */

/** 金鑰未設定時，附上「本實例實際看到什麼」的診斷與設定引導（避免只說『尚未設定』卻看不出來源） */
function appendRuntimeEnvHint<T extends UsageSection>(section: T, diag: ReadStatsDiag): T {
  if (section.ok || section.configured) return section;
  const sa = diag.serviceAccountKey.set
    ? `已設定（${diag.serviceAccountKey.len} 字元）但無法使用（多為格式或權限問題）`
    : "未設定——該變數尚未注入這個伺服器實例";
  const runtime = diag.kService ? "App Hosting 執行環境" : "一般伺服器環境";
  const diagBlock = `【本實例執行環境偵測】
FIREBASE_SERVICE_ACCOUNT_KEY＝${sa}（NODE_ENV=${diag.nodeEnv}・${runtime}）。
環境變數保存後不會自動生效——必須「重新部署」（最新部署時間須晚於變數保存時間），並確認設在提供本網址的同一個 backend。

設定方式：
1. Firebase Console → 專案設定 → 服務帳號 → 「產生新的私鑰」下載 JSON（整段私鑰）
2. App Hosting Console → backend → 環境變數 → 新增 FIREBASE_SERVICE_ACCOUNT_KEY，值＝整段 JSON（或先 base64 編碼再貼，程式兩種格式都接受）
3. 重新部署後回本頁按「重新整理」`;
  return {
    ...section,
    hint: section.hint ? `${section.hint}\n\n${diagBlock}` : diagBlock,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { denial } = await requireAdminModule("stats");
    if (denial) return toAuthResponse(denial);

    const limited = enforceRateLimit(
      request,
      "admin-stats-usage",
      RATE.ADMIN_USAGE_GET.limit,
      RATE.ADMIN_USAGE_GET.windowMs
    );
    if (limited) return limited;

    const readStats = getReadStatsSnapshot();
    const [appHostingRaw, firebaseRaw] = await Promise.all([
      getAppHostingUsage(),
      getFirebaseUsage(),
    ]);
    const appHosting = appendRuntimeEnvHint(appHostingRaw, readStats.diag);
    const firebase = appendRuntimeEnvHint(firebaseRaw, readStats.diag);

    const body: StatsResponse = {
      success: true,
      appHosting,
      firebase,
      readStats,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Stats usage error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const { denial } = await requireAdminModule("stats");
    if (denial) return toAuthResponse(denial);

    const limited = enforceRateLimit(
      request,
      "admin-stats-usage",
      RATE.ADMIN_USAGE_GET.limit,
      RATE.ADMIN_USAGE_GET.windowMs
    );
    if (limited) return limited;

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (!body || typeof body !== "object" || (body as { action?: unknown }).action !== "reset-read-stats") {
      return NextResponse.json({ success: false, message: "無效的操作" }, { status: 400 });
    }
    resetReadStats();
    return NextResponse.json(
      { success: true, message: "已重設本實例讀取統計", readStats: getReadStatsSnapshot() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Stats read-stats reset error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤") },
      { status: 500 }
    );
  }
}
