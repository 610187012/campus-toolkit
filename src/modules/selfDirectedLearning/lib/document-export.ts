import { sanitizeRichHtml, type DocumentExportPlatform, type PrintPreviewPayload } from "../types/self-directed-learning";

export async function checkDocumentExportAllowed(platform: DocumentExportPlatform, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/student/self-directed-learning/exports?platform=${platform}`, { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok || data.success !== true) {
    throw new Error(typeof data.message === "string" ? data.message : "無法確認匯出服務設定，請稍後再試。");
  }
}

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DOCS_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";

export const DOCUMENT_STYLES = {
  basic: { label: "基本款", description: "接近網頁內容，保留基本標題與表格，不加裝飾配色。" },
  formal: { label: "清爽正式", description: "深藍標題、淺藍表頭與適度留白，適合正式計畫。" },
  monochrome: { label: "黑白簡約", description: "黑白文字、灰階表頭與清楚框線，適合列印。" },
  portfolio: { label: "作品集", description: "深綠主題、柔和分區與較多留白，凸顯學習歷程。" },
} as const;
export type DocumentStyle = keyof typeof DOCUMENT_STYLES;

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function richText(value: string): string {
  return sanitizeRichHtml(value).replace(/\r?\n/g, "<br>");
}

export function documentTitle(payload: PrintPreviewPayload): string {
  return `自主學習計畫－${payload.topic.trim() || "未命名"}－${payload.period}`.slice(0, 200);
}

export function documentFilename(payload: PrintPreviewPayload): string {
  const name = [...documentTitle(payload)].slice(0, 100).join("")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\ud800-\udfff]/gu, "_").replace(/[. ]+$/g, "");
  return `${name}.docx`;
}

/** 外部編輯副本只含學生主動匯出的內容，不含帳號、審查意見或系統內部識別碼。 */
export function buildDocumentHtml(payload: PrintPreviewPayload, style: DocumentStyle = "formal"): string {
  // 匯出文件使用固定紙本文字配色與 inline 樣式，不依賴校內網站主題或外部字型。
  const palettes = {
    basic: { accent: "#000000", text: "#000000", muted: "#000000", border: "#000000", fill: "#ffffff", week: "#ffffff" },
    formal: { accent: "#17365d", text: "#243247", muted: "#526780", border: "#c9d8e8", fill: "#eaf0f7", week: "#f5f8fc" },
    monochrome: { accent: "#000000", text: "#000000", muted: "#444444", border: "#777777", fill: "#eeeeee", week: "#ffffff" },
    portfolio: { accent: "#245448", text: "#263d36", muted: "#516d62", border: "#b9d1c5", fill: "#e8f2ec", week: "#f3f8f5" },
  };
  const palette = palettes[style];
  const basic = style === "basic";
  const spacious = style === "portfolio";
  const sectionStyle = `color:${palette.accent};font-size:${basic ? 14 : 15}pt;font-weight:bold;margin:${basic ? 14 : spacious ? 28 : 22}pt 0 10pt;${basic ? "" : `padding-bottom:5pt;border-bottom:1pt solid ${palette.border};`}page-break-after:avoid`;
  const subheadingStyle = `color:${palette.accent};font-size:11pt;font-weight:bold;margin:12pt 0 6pt;page-break-after:avoid`;
  const cellStyle = `border:1pt solid ${palette.border};padding:${basic ? 5 : spacious ? 12 : 9}pt;vertical-align:top;line-height:1.6`;
  const headerStyle = `${cellStyle};${basic ? "" : `background-color:${palette.fill};`}color:${palette.accent};font-weight:bold;text-align:left`;
  const metadataStyle = basic ? "margin:0 0 8pt" : `background-color:${palette.fill};padding:10pt 12pt;margin:0 0 4pt`;
  const rows = payload.weeks.map((week) => {
    const record = payload.layout === "integrated" && week.record
      ? `<h3 style="${subheadingStyle}">執行成果紀錄</h3>${richText(week.record)}`
      : "";
    return `<tr><td style="${cellStyle};width:16%;${basic ? "" : `background-color:${palette.week}`}"><b>第 ${week.week} 週</b><br>${week.timing === "afterSchool" ? "課餘" : "彈性學習"}</td><td style="${cellStyle};width:64%">${richText(week.content)}${record}</td><td style="${cellStyle};width:20%">${escapeText(week.venue)}</td></tr>`;
  }).join("");
  const records = payload.layout === "separate"
    ? payload.weeks.filter((week) => week.record).map((week) =>
        `<h3 style="${subheadingStyle}">第 ${week.week} 週</h3>${richText(week.record)}`
      ).join("")
    : "";
  const source = payload.source === "draft"
    ? "草稿副本"
    : payload.formalByStudent ? "學生自行提升之正式計畫副本" : "學校審核通過之計畫副本";
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${escapeText(documentTitle(payload))}</title></head><body style="font-family:'Microsoft JhengHei','Noto Sans TC',Arial,sans-serif;font-size:11pt;line-height:${spacious ? 1.8 : 1.65};color:${palette.text}">
<p style="color:${palette.muted};font-size:10pt;margin:0 0 6pt">${escapeText(payload.period)} 學期・${source}</p>
<h1 style="color:${palette.accent};font-size:${basic ? 20 : spacious ? 28 : 24}pt;font-weight:bold;line-height:1.3;margin:0 0 8pt;page-break-after:avoid">自主學習計畫</h1>
<p style="color:${palette.accent};font-size:${basic ? 14 : 16}pt;font-weight:bold;line-height:1.5;margin:0 0 ${spacious ? 24 : 18}pt;page-break-after:avoid">${escapeText(payload.topic || "未命名計畫")}</p>
<p style="${metadataStyle}"><b>學生：</b>${escapeText(payload.studentName)}　<b>班級：</b>${escapeText(payload.className)}</p>
<p style="${metadataStyle}"><b>學群：</b>${escapeText(payload.studyGroup)}　<b>指導老師：</b>${escapeText(payload.advisor || "未指定")}</p>
<h2 style="${sectionStyle}">學習目標</h2>${richText(payload.learningGoals)}
<h2 style="${sectionStyle}">逐週學習安排</h2>
<table border="1" cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:10.5pt"><thead><tr><th scope="col" style="${headerStyle};width:16%">週次</th><th scope="col" style="${headerStyle};width:64%">學習安排</th><th scope="col" style="${headerStyle};width:20%">場地</th></tr></thead><tbody>${rows}</tbody></table>
${records ? `<h2 style="${sectionStyle}">執行成果紀錄</h2>${records}` : ""}
${payload.reflection ? `<h2 style="${sectionStyle}">學習反思心得</h2>${richText(payload.reflection)}` : ""}
<p style="color:${palette.muted};font-size:9pt;line-height:1.5;margin-top:24pt;${basic ? "" : `padding-top:8pt;border-top:1pt solid ${palette.border}`}">本文件為匯出當下的編輯副本；外部修改不會同步或覆蓋校內計畫。</p>
</body></html>`;
}

export function buildGoogleDocsUpload(payload: PrintPreviewPayload, boundary: string, style: DocumentStyle = "formal"): Blob {
  const metadata = JSON.stringify({
    name: documentTitle(payload),
    mimeType: "application/vnd.google-apps.document",
  });
  return new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${buildDocumentHtml(payload, style)}\r\n`,
    `--${boundary}--\r\n`,
  ], { type: `multipart/related; boundary=${boundary}` });
}

function googleRejection(body: string): string {
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return "Google 拒絕建立文件，請洽學校管理員確認設定。";
  }
  const failure = result && typeof result === "object" && "error" in result ? result.error : null;
  const codes: string[] = [];
  if (failure && typeof failure === "object") {
    const groups: unknown[] = [
      "errors" in failure ? failure.errors : null,
      "details" in failure ? failure.details : null,
    ];
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const item of group) {
        if (item && typeof item === "object" && "reason" in item &&
          typeof item.reason === "string" && /^[A-Za-z0-9_]+$/.test(item.reason)) {
          codes.push(item.reason);
        }
      }
    }
  }
  if (codes.some((code) => ["accessNotConfigured", "SERVICE_DISABLED"].includes(code))) {
    return "尚未啟用 Google Drive API，請管理員啟用後稍候再試。";
  }
  if (codes.includes("storageQuotaExceeded")) {
    return "Google 雲端硬碟空間不足，請清理空間後再試。";
  }
  if (codes.some((code) => ["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"].includes(code))) {
    return "Google 檔案權限不足，請重新授權並同意建立檔案。";
  }
  if (codes.includes("domainPolicy")) {
    return "學校限制此應用程式使用 Google Drive，請洽管理員。";
  }
  if (codes.some((code) => ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"].includes(code))) {
    return "Google 使用量已達限制，請稍後再試。";
  }
  return "Google 拒絕建立文件，請洽學校管理員確認設定。";
}

export async function createGoogleDocument(
  payload: PrintPreviewPayload,
  accessToken: string,
  style: DocumentStyle = "formal"
): Promise<string> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(GOOGLE_DOCS_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: buildGoogleDocsUpload(payload, `sdl-${crypto.randomUUID()}`, style),
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("Google 授權已失效，請重新授權後匯出。");
      if (response.status === 403) {
        throw new Error(googleRejection(await response.text()));
      }
      if (response.status === 429) throw new Error("Google 請求過於頻繁，請稍後再試。");
      throw new Error(`Google 文件建立失敗（HTTP ${response.status}），請先確認雲端硬碟是否已有副本，再決定是否重試。`);
    }
    const result: unknown = await response.json();
    if (
      !result || typeof result !== "object" || !("id" in result) ||
      typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)
    ) {
      throw new Error("Google 未回傳有效文件連結；文件可能已建立，請先檢查自己的雲端硬碟，避免重複匯出。");
    }
    return `https://docs.google.com/document/d/${result.id}/edit`;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("建立文件逾時，請先檢查 Google 雲端硬碟是否已有副本，避免重複匯出。");
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw new Error("無法確認 Google 文件建立結果，請檢查網路並先查看自己的雲端硬碟，再決定是否重試。");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
