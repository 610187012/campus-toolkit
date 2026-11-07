"use client";

import { ReactNode } from "react";
import AdminSectionShell from "@/components/AdminSectionShell";

/**
 * 「功能模組管理」共用外殼（標題、權限閘門、頁尾）。
 * 本頁展示產品層級的功能模組（內建／選用列表、總開關與各身分開關）。
 * 「功能模組管理」是管理員權限模組；屬性分級已退役，全體管理員皆可進入。
 * 安裝／卸載另由 `requireModuleInstallAdmin()` 守門，可用
 * MODULE_MARKET_INSTALL_ADMINS 限縮（未設定＝全體管理員）。
 */
export default function ModulesLayout({ children }: { children: ReactNode }) {
  return (
    <AdminSectionShell
      moduleKey="modules"
      title="功能模組管理"
      description="系統的功能模組架構：內建與選用的分類、選用模組的總開關，以及每個模組對四種身分的開關。"
      deniedMessage="「功能模組管理」需管理員權限。若顯示此訊息但您是管理員，代表權限資料讀取失敗，請重新整理。"
    >
      {children}
    </AdminSectionShell>
  );
}
