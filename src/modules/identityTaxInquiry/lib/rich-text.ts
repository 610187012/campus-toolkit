/**
 * 富文本白名單淨化（前端與伺服器共用；**不可** import server-only）。
 *
 * 公告內容與行事曆說明改為所見即所得編輯後，輸入端與顯示端都必須經過同一套
 * 白名單：只保留粗體、斜體、底線、刪除線、顏色／底色／字級、段落、清單、引用等
 * 安全標籤；事件屬性、script／iframe、javascript: 與 url() 一律移除。
 * 純文字輸入會被跳脫，因此可安全地以 `dangerouslySetInnerHTML` 呈現。
 */

/** 允許的富文本標籤；其他標籤一律丟棄外殼、保留文字內容 */
const RICH_TEXT_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "span",
  "font",
  "p",
  "div",
  "br",
  "ul",
  "ol",
  "li",
  "blockquote",
]);

/** 需連同內容整段移除的危險元素（含未閉合標籤） */
const RICH_TEXT_DROP_ELEMENTS =
  "script|style|iframe|object|embed|svg|math|template|noscript|title|textarea|select|option|form|link|meta|audio|video|source|picture|canvas";

/** 允許保留的 CSS 屬性（其餘一律丟棄） */
const RICH_TEXT_STYLE_PROPS = new Set([
  "color",
  "background-color",
  "font-family",
  "font-size",
  "text-align",
  "margin-left",
  "padding-left",
]);

const RICH_TEXT_SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.%,\s]+\)|[a-z]{3,20})$/i;
const RICH_TEXT_SAFE_FONT_SIZE =
  /^(\d+(\.\d+)?(px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large)$/i;
const RICH_TEXT_SAFE_FONT_FAMILY = /^[A-Za-z0-9\s,"'_.\-\u4e00-\u9fff]+$/;
const RICH_TEXT_SAFE_SPACING = /^-?\d+(\.\d+)?(px|pt|em|rem|%)$/i;
const RICH_TEXT_SAFE_ALIGN = /^(left|right|center|justify)$/i;

/** 是否為允許的 CSS 值（避免 url()、expression 等危險構造） */
function isSafeRichStyleValue(property: string, value: string): boolean {
  switch (property) {
    case "color":
    case "background-color":
      return RICH_TEXT_SAFE_COLOR.test(value);
    case "font-size":
      return RICH_TEXT_SAFE_FONT_SIZE.test(value);
    case "font-family":
      return value.length <= 120 && RICH_TEXT_SAFE_FONT_FAMILY.test(value);
    case "text-align":
      return RICH_TEXT_SAFE_ALIGN.test(value);
    case "margin-left":
    case "padding-left":
      return RICH_TEXT_SAFE_SPACING.test(value);
    default:
      return false;
  }
}

/** 過濾單一 style 屬性的宣告，只留白名單內且值安全的樣式 */
function sanitizeRichStyle(raw: string): string | null {
  const declarations: string[] = [];
  for (const part of raw.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (!property || !value || !RICH_TEXT_STYLE_PROPS.has(property)) continue;
    if (/url\s*\(|expression|javascript:|@import|[<>\\]/i.test(value)) continue;
    if (!isSafeRichStyleValue(property, value)) continue;
    declarations.push(`${property}:${value}`);
  }
  return declarations.length > 0 ? declarations.join(";") : null;
}

/** 保留合法實體（如 &nbsp;、&amp;），其餘 < > & 一律跳脫，避免純文字被當成標籤 */
function escapeRichText(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const amp = text.indexOf("&", index);
    if (amp < 0) {
      output += text.slice(index).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      break;
    }
    output += text.slice(index, amp).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const rest = text.slice(amp);
    const entity = rest.match(/^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/);
    if (entity) {
      output += entity[0];
      index = amp + entity[0].length;
    } else {
      output += "&amp;";
      index = amp + 1;
    }
  }
  return output;
}

/** 解析並重建標籤屬性：只留白名單屬性，事件屬性與危險樣式一律丟棄 */
function sanitizeRichAttributes(tag: string, raw: string): string {
  const attributes: string[] = [];
  const pattern =
    /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name.startsWith("on")) continue;
    if (name === "style") {
      const style = sanitizeRichStyle(value);
      if (style) {
        attributes.push(`style="${style.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
      }
      continue;
    }
    if (
      (tag === "p" || tag === "div" || tag === "blockquote" || tag === "li") &&
      name === "align" &&
      RICH_TEXT_SAFE_ALIGN.test(value)
    ) {
      attributes.push(`align="${value.toLowerCase()}"`);
      continue;
    }
    if (tag !== "font") continue;
    if (name === "size" && /^[1-7]$/.test(value)) {
      attributes.push(`size="${value}"`);
    } else if (name === "color" && RICH_TEXT_SAFE_COLOR.test(value)) {
      attributes.push(`color="${value}"`);
    } else if (name === "bgcolor" && RICH_TEXT_SAFE_COLOR.test(value)) {
      attributes.push(`bgcolor="${value}"`);
    } else if (name === "face" && value.length <= 120 && RICH_TEXT_SAFE_FONT_FAMILY.test(value)) {
      attributes.push(`face="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
    }
  }
  return attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
}

/**
 * 富文本白名單淨化：只留安全標籤（粗體、斜體、底線、刪除線、顏色／底色／字級、
 * 段落、清單、引用等）與安全屬性；移除 script／iframe／事件屬性／javascript:／url()。
 * 純文字輸入會被跳脫，因此可安全地以 `dangerouslySetInnerHTML` 呈現。
 */
export function sanitizeRichHtml(input: string): string {
  if (typeof input !== "string" || !input) return "";
  let html = input.replace(/<!--[\s\S]*?-->/g, "").replace(/<![^>]*>/g, "");
  // 先整段移除危險元素（含內容），再移除殘留的未閉合標籤
  html = html.replace(
    new RegExp(`<(${RICH_TEXT_DROP_ELEMENTS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"),
    ""
  );
  html = html.replace(new RegExp(`<\\/?(?:${RICH_TEXT_DROP_ELEMENTS})\\b[^>]*>`, "gi"), "");

  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>/g;
  let output = "";
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    output += escapeRichText(html.slice(index, match.index));
    index = pattern.lastIndex;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (!RICH_TEXT_TAGS.has(tag)) continue;
    if (tag === "br") {
      if (!closing) output += "<br>";
      continue;
    }
    if (closing) {
      output += `</${tag}>`;
      continue;
    }
    output += `<${tag}${sanitizeRichAttributes(tag, match[3] ?? "")}>`;
  }
  output += escapeRichText(html.slice(index));
  return output;
}

function decodeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * 取得富文本的可見純文字：`<br>`、`</p>`、`</div>`、`</li>` 視為換行，
 * 其餘標籤剝除，並還原常見實體（`&nbsp;`、`&amp;`、`&lt;`、`&gt;`）。
 * 用於必填判空、字數計算與舊版純文字內容顯示。
 */
export function stripHtmlToText(input: string): string {
  if (typeof input !== "string" || !input) return "";
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, code: string) => decodeCodePoint(Number(code), match))
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16), match)
    )
    .replace(/&amp;/gi, "&")
    .replace(/\r\n?/g, "\n");
}

/** 依長度上限截斷富文本：切在最後一個完整標籤邊界，避免留下破損標籤 */
export function capRichHtmlLength(html: string, maxLength: number): string {
  if (html.length <= maxLength) return html;
  const sliced = html.slice(0, maxLength);
  const boundary = sliced.lastIndexOf(">");
  if (boundary < 0) return "";
  return sanitizeRichHtml(sliced.slice(0, boundary + 1));
}

/**
 * 多行富文本欄位的正規化：先白名單淨化，再限制 HTML 長度。
 * 純文字（舊資料或跨模組寫入）保持原樣，由顯示端以換行呈現。
 */
export function normalizeRichHtmlField(value: unknown, maxHtml: number): string {
  if (typeof value !== "string" || !value) return "";
  return capRichHtmlLength(sanitizeRichHtml(value.trim()), maxHtml).trim();
}
