/**
 * 模組安裝／卸載的指定管理員政策（P0-7）。
 *
 * 背景：管理員「超級／一般」屬性已退役（政策修改書決議二），
 * 所有有效管理員在 `modules` 權限下都能安裝／卸載模組。
 * 但安裝／卸載會觸發 GitHub 提交（production）或本機檔案變更，
 * 屬高風險操作，因此提供一個**選填**的環境變數限縮：
 *
 *   MODULE_MARKET_INSTALL_ADMINS=uid1,admin@school.edu,uid3
 *
 * - 未設定（或空白）＝維持原政策：所有具 `modules` 權限的管理員皆可。
 * - 有設定＝只有清單內的 uid 或 email 可安裝／卸載。
 * - 比對不分大小寫、忽略空白與重複值。
 *
 * 本檔刻意保持零依賴（純函式），供 `dal.ts` 與測試腳本共用。
 */

/** 解析逗號／分號／空白分隔的 uid 或 email 清單 */
export function parseModuleInstallAdmins(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const value = part.trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * 判斷 session 是否在允許清單內。
 * 清單為空＝不限制（回 true）；清單非空時，uid 或 email 任一命中即可。
 */
export function matchesModuleInstallAdmin(
  session: { uid?: string | null; email?: string | null },
  allowlist: readonly string[]
): boolean {
  if (allowlist.length === 0) return true;
  const uid = typeof session.uid === "string" ? session.uid.trim().toLowerCase() : "";
  const email = typeof session.email === "string" ? session.email.trim().toLowerCase() : "";
  return (uid !== "" && allowlist.includes(uid)) || (email !== "" && allowlist.includes(email));
}
