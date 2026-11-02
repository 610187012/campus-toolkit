import { DOCUMENT_STYLES, type DocumentStyle } from "./document-export";
import type { PrintPreviewPayload } from "../types/self-directed-learning";

export class DocumentExportInputError extends Error {}

export function parseDocumentExport(value: unknown): { payload: PrintPreviewPayload; style: DocumentStyle } {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const input = object(value);
  const p = object(input.payload);
  const text = (value: unknown, max: number) => {
    if (typeof value !== "string" || value.length > max) throw new DocumentExportInputError("匯出內容格式或長度不符，請重新操作。");
    return value;
  };
  if (typeof input.style !== "string" || !Object.hasOwn(DOCUMENT_STYLES, input.style)) {
    throw new DocumentExportInputError("文件風格無效。");
  }
  if (!["draft", "approved"].includes(String(p.source)) || !["separate", "integrated"].includes(String(p.layout)) ||
    !Array.isArray(p.weeks) || p.weeks.length > 53) throw new DocumentExportInputError("匯出內容格式不符，請重新操作。");
  return {
    style: input.style as DocumentStyle,
    payload: {
      period: text(p.period, 100), studentName: text(p.studentName, 200), className: text(p.className, 200),
      topic: text(p.topic, 1000), studyGroup: text(p.studyGroup, 200), advisor: text(p.advisor, 200),
      learningGoals: text(p.learningGoals, 100_000), reflection: text(p.reflection, 100_000),
      source: p.source === "draft" ? "draft" : "approved",
      layout: p.layout === "separate" ? "separate" : "integrated",
      formalByStudent: p.formalByStudent === true, generatedAt: Date.now(),
      weeks: p.weeks.map((value) => {
        const week = object(value);
        if (typeof week.week !== "number" || !Number.isInteger(week.week) || week.week < 1 || week.week > 53 ||
          !["flexible", "afterSchool"].includes(String(week.timing))) throw new DocumentExportInputError("匯出週次格式不符。");
        return {
          week: week.week, timing: week.timing === "afterSchool" ? "afterSchool" : "flexible",
          content: text(week.content, 100_000), venue: text(week.venue, 1000),
          record: text(week.record, 100_000), slots: [], blocked: false,
        };
      }),
    },
  };
}
