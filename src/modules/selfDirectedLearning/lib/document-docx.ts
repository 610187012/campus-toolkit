import { sanitizeRichHtml, stripHtmlToText, type PrintPreviewPayload } from "../types/self-directed-learning";
import type { DocumentStyle } from "./document-export";

function xml(value: string): string {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function paragraph(text: string, style = ""): string {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function rich(value: string): string {
  const tokens = sanitizeRichHtml(value).match(/<[^>]+>|[^<]+/g) ?? [];
  const active = new Map<string, number>();
  const tags: Record<string, string> = { b: "b", strong: "b", i: "i", em: "i", u: "u", s: "strike", strike: "strike", del: "strike" };
  let runs = "";
  let output = "";
  const flush = () => {
    if (runs) output += `<w:p>${runs}</w:p>`;
    runs = "";
  };
  for (const token of tokens) {
    if (token.startsWith("<")) {
      const match = /^<(\/?)([a-z0-9]+)/i.exec(token);
      if (!match) continue;
      const [, closing, tag] = match;
      if (tags[tag]) active.set(tags[tag], Math.max(0, (active.get(tags[tag]) ?? 0) + (closing ? -1 : 1)));
      if (tag === "br") runs += "<w:r><w:br/></w:r>";
      if (["p", "div", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) flush();
      if (tag === "li" && !closing) runs += '<w:r><w:t xml:space="preserve">• </w:t></w:r>';
    } else {
      const properties = [...active].filter(([, count]) => count > 0).map(([name]) => `<w:${name}/>`).join("");
      const text = stripHtmlToText(token);
      const segments = text.split("\n");
      for (let i = 0; i < segments.length; i++) {
        if (i) runs += "<w:r><w:br/></w:r>";
        runs += `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${xml(segments[i])}</w:t></w:r>`;
      }
    }
  }
  flush();
  return output || "<w:p/>";
}

/** Minimal uncompressed ZIP/OPC package; uses no host-private or optional dependencies. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [filename, value] of Object.entries(entries)) {
    const name = Buffer.from(filename);
    const data = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

export function buildDocumentDocx(payload: PrintPreviewPayload, style: DocumentStyle): Buffer {
  const palette = {
    basic: { accent: "000000", fill: "FFFFFF", border: "000000" },
    formal: { accent: "17365D", fill: "EAF0F7", border: "C9D8E8" },
    monochrome: { accent: "000000", fill: "EEEEEE", border: "777777" },
    portfolio: { accent: "245448", fill: "E8F2EC", border: "B9D1C5" },
  }[style];
  const cell = (content: string, width: number, header = false) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? `<w:shd w:fill="${palette.fill}"/>` : ""}</w:tcPr>${content}</w:tc>`;
  const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(paragraph("週次", "Heading2"), 1400, true)}${cell(paragraph("學習安排", "Heading2"), 5800, true)}${cell(paragraph("場地", "Heading2"), 1800, true)}</w:tr>`;
  const rows = payload.weeks.map((week) => `<w:tr>${cell(paragraph(`第 ${week.week} 週`) + paragraph(week.timing === "afterSchool" ? "課餘" : "彈性學習"), 1400)}${cell(rich(week.content) + (payload.layout === "integrated" && week.record ? paragraph("執行成果紀錄", "Heading2") + rich(week.record) : ""), 5800)}${cell(paragraph(week.venue), 1800)}</w:tr>`).join("");
  const records = payload.layout === "separate" ? payload.weeks.filter((week) => week.record).map((week) => paragraph(`第 ${week.week} 週`, "Heading2") + rich(week.record)).join("") : "";
  const source = payload.source === "draft" ? "草稿副本" : payload.formalByStudent ? "學生自行提升之正式計畫副本" : "學校審核通過之計畫副本";
  const body = [
    paragraph(`${payload.period} 學期・${source}`),
    paragraph("自主學習計畫", "Title"), paragraph(payload.topic || "未命名計畫", "Heading1"),
    paragraph(`學生：${payload.studentName}　班級：${payload.className}`),
    paragraph(`學群：${payload.studyGroup}　指導老師：${payload.advisor || "未指定"}`),
    paragraph("學習目標", "Heading1"), rich(payload.learningGoals),
    paragraph("逐週學習安排", "Heading1"),
    `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="6" w:color="${palette.border}"/>`).join("")}</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="1400"/><w:gridCol w:w="5800"/><w:gridCol w:w="1800"/></w:tblGrid>${header}${rows}</w:tbl>`,
    records ? paragraph("執行成果紀錄", "Heading1") + records : "",
    payload.reflection ? paragraph("學習反思心得", "Heading1") + rich(payload.reflection) : "",
    paragraph("本文件為匯出當下的編輯副本；外部修改不會同步或覆蓋校內計畫。"),
  ].join("");
  return zip({
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft JhengHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="${style === "portfolio" ? 380 : 330}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${[["Title", style === "portfolio" ? 56 : 44], ["Heading1", 30], ["Heading2", 24]].map(([name, size]) => `<w:style w:type="paragraph" w:styleId="${name}"><w:name w:val="${name}"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="140"/></w:pPr><w:rPr><w:b/><w:color w:val="${palette.accent}"/><w:sz w:val="${size}"/></w:rPr></w:style>`).join("")}</w:styles>`,
  });
}
