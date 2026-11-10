import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { execFile } from "node:child_process";
import { getAdminDb } from "@/lib/firebase-admin";
import { requireAdminModule, requireModuleInstallAdmin, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import {
  bumpCacheEpoch,
  SETTINGS_COLLECTION,
  SETTINGS_DOC_ID,
} from "@/lib/settings-server";
import { commitMarketplaceModuleUninstall, resolveModuleMarketGithubConfig } from "@/lib/module-market-github";
import {
  getFeatureModuleRoles,
  getFeatureModulesEnabled,
} from "@/lib/feature-modules";
import {
  FEATURE_MODULES_FIELD,
  FEATURE_MODULE_ROLES_FIELD,
  FeatureModulesEnabledMap,
  FeatureModuleRolesMap,
  featureModuleMeta,
} from "@/types/feature-modules";
import { isUserRole, ROLE_LABELS } from "@/types/users";
import { readJsonBody } from "@/lib/http-body";

/** GET：讀取功能模組的總開關與「模組 × 身分」開關（全體管理員，頁面顯示用） */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_GET.limit,
      RATE.FEATURE_MODULES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("modules");
    if (denial) return toAuthResponse(denial);

    const [enabled, roles] = await Promise.all([getFeatureModulesEnabled(), getFeatureModuleRoles()]);
    const canUninstall =
      process.env.NODE_ENV === "development" ||
      (process.env.NODE_ENV === "production" && !!resolveModuleMarketGithubConfig());
    return NextResponse.json(
      { success: true, enabled, roles, canUninstall },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Feature modules list error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/**
 * PATCH：更新功能模組設定（全體管理員，政策修改書決議二），兩種操作：
 * - `{ value, enabled }` → 選用模組總開關（任何已安裝的選用模組皆可切換，預設未啟用）；
 * - `{ value, role, enabled }` → 該模組對單一身分的**顯示與否**（提供功能＝否時不可打開；
 *   管理員欄已退役——role 為 admin 一律拒絕）。
 */
export async function PATCH(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_MUTATE.limit,
      RATE.FEATURE_MODULES_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("modules");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const value = typeof body.value === "string" ? body.value : "";
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
    const meta = value ? featureModuleMeta(value) : undefined;
    if (!meta || enabled === null) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }

    // 「模組 × 身分」顯示開關
    if (body.role !== undefined && body.role !== null) {
      if (!isUserRole(body.role)) {
        return NextResponse.json({ success: false, message: "身分無效" }, { status: 400 });
      }
      const role = body.role;
      // 管理員欄已退役：管理員恆可見所有已啟用模組，不接受逐模組入口開關
      if (role === "admin") {
        return NextResponse.json(
          { success: false, message: "管理員對所有功能模組恆為全權，無需設定功能入口" },
          { status: 400 }
        );
      }
      // 提供功能＝否的身分：顯示強制為關，不接受打開（由模組作者決定，管理端唯讀）
      if (!meta.provides[role] && enabled) {
        return NextResponse.json(
          { success: false, message: `「${meta.label}」未提供給「${ROLE_LABELS[role]}」身分，無法開啟顯示` },
          { status: 400 }
        );
      }
      const nextVisible = meta.provides[role] ? enabled : false;
      const current = await getFeatureModuleRoles();
      const next: FeatureModuleRolesMap = {
        ...current,
        [meta.value]: { ...current[meta.value], [role]: nextVisible },
      };
      await getAdminDb()
        .collection(SETTINGS_COLLECTION)
        .doc(SETTINGS_DOC_ID)
        .set({ [FEATURE_MODULE_ROLES_FIELD]: next }, { merge: true });
      // 清本機設定快取＋遞增跨實例旗標（bumpCacheEpoch 內含失效）：
      // 與系統設定 PUT 一致，讓其他實例的 visibleModules 在重讀旗標後立即採新值
      await bumpCacheEpoch();

      await logActivity({
        userId: session.uid,
        role: "admin",
        action: "feature_module_role_updated",
        ip: getClientIp(request),
        details: `將「${meta.label}」對「${ROLE_LABELS[role]}」身分的顯示設為「${nextVisible ? "顯示" : "隱藏"}」`,
      });

      return NextResponse.json({
        success: true,
        message: `「${meta.label}」對${ROLE_LABELS[role]}身分已${nextVisible ? "顯示" : "隱藏"}`,
        roles: next,
      });
    }

    // 選用模組總開關（任何已安裝的選用模組皆可切換）
    if (meta.kind !== "optional") {
      return NextResponse.json(
        { success: false, message: "內建功能模組一律啟用，無法停用" },
        { status: 400 }
      );
    }

    const current = await getFeatureModulesEnabled();
    const next: FeatureModulesEnabledMap = { ...current, [meta.value]: enabled };
    await getAdminDb()
      .collection(SETTINGS_COLLECTION)
      .doc(SETTINGS_DOC_ID)
      .set({ [FEATURE_MODULES_FIELD]: next }, { merge: true });
    await bumpCacheEpoch();

    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "feature_module_updated",
      ip: getClientIp(request),
      details: `將「${meta.label}」功能模組設為「${enabled ? "啟用" : "停用"}」`,
    });

    return NextResponse.json({
      success: true,
      message: `${meta.label}已${enabled ? "啟用" : "停用"}`,
      enabled: next,
    });
  } catch (error) {
    console.error("Feature modules update error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}

/**
 * DELETE：卸載選用模組（全體管理員，政策修改書決議二）。
 * 執行 `scripts/module-cli.mjs uninstall <value>`（刪資料夾＋lock＋重產生註冊表與轉接檔）。
 * 部署環境走 GitHub 提交管線（刪 src/modules/<value> 與 lock 該列）。
 */
export async function DELETE(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "feature-modules",
      RATE.FEATURE_MODULES_MUTATE.limit,
      RATE.FEATURE_MODULES_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireModuleInstallAdmin();
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const value = typeof body.value === "string" ? body.value : "";
    const confirmedBackup = body.confirmedBackup === true;
    const isProduction = process.env.NODE_ENV === "production";
    const meta = value ? featureModuleMeta(value) : undefined;
    if (!meta) {
      return NextResponse.json({ success: false, message: "請求內容無效" }, { status: 400 });
    }
    if (meta.kind !== "optional") {
      return NextResponse.json(
        { success: false, message: "內建功能模組隨主程式提供，無法卸載" },
        { status: 400 }
      );
    }

    if (isProduction) {
      if (!resolveModuleMarketGithubConfig()) {
        return NextResponse.json(
          {
            success: false,
            message:
              "尚未設定 MODULE_MARKET_GITHUB_TOKEN（或 MODULE_MARKET_GITHUB_REPO / VERCEL_GIT_REPO_OWNER+SLUG）——無法在正式環境自動卸載",
          },
          { status: 503 }
        );
      }
      if (!confirmedBackup) {
        return NextResponse.json(
          {
            success: false,
            message: "卸載前請先完成資料備份，並於確認視窗勾選「我已完成備份」後再執行",
          },
          { status: 400 }
        );
      }

      const committed = await commitMarketplaceModuleUninstall({ moduleId: value });
      await bumpCacheEpoch();
      await logActivity({
        userId: session.uid,
        role: "admin",
        action: "feature_module_updated",
        ip: getClientIp(request),
        details: committed.alreadyUninstalled
          ? `卸載功能模組「${meta.label}」：遠端已無安裝資料（branch: ${committed.branch}）`
          : `卸載功能模組「${meta.label}」：提交至 ${committed.branch}（${committed.commitSha ?? "n/a"}）`,
      });

      return NextResponse.json({
        success: true,
        alreadyUninstalled: committed.alreadyUninstalled,
        message: committed.alreadyUninstalled
          ? `${meta.label}目前未安裝（遠端已是卸載狀態）`
          : `${meta.label}卸載提交已建立，請等待部署完成；資料庫資料預設保留，若需清除請先備份後手動處理`,
        branch: committed.branch,
        commitUrl: committed.commitUrl,
      });
    }

    const cli = path.join(process.cwd(), "scripts", "module-cli.mjs");
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [cli, "uninstall", value],
        { cwd: process.cwd(), timeout: 120_000 },
        (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.trim();
          if (!error) {
            resolve({ code: 0, output });
            return;
          }
          const code = typeof error.code === "number" ? error.code : 1;
          resolve({ code, output });
        }
      );
      child.on("error", () => resolve({ code: 1, output: "無法執行卸載程序" }));
    });

    if (result.code !== 0) {
      const tail = result.output.split("\n").slice(-3).join("；");
      return NextResponse.json(
        { success: false, message: `卸載失敗：${tail}` },
        { status: 500 }
      );
    }

    await bumpCacheEpoch();
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "feature_module_updated",
      ip: getClientIp(request),
      details: `卸載功能模組「${meta.label}」（本機開發）`,
    });

    return NextResponse.json({
      success: true,
      message: `${meta.label}已卸載；Firestore 模組資料預設保留。變更須 commit＋push 後才會部署`,
    });
  } catch (error) {
    console.error("Feature modules uninstall error:", error);
    return NextResponse.json({ success: false, message: serverErrorMessage(error, "系統錯誤") });
  }
}
