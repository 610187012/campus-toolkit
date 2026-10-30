"use client";

import {
  WEEKDAY_LABELS,
  type PlanTiming,
  type PrintPreviewPayload,
  type PrintPreviewWeek,
} from "../types/self-directed-learning";
import { Fragment } from "react";
import { RichTextContent } from "./rich-text-editor";

/** 表格內的時段短標籤（與計畫表週次欄一致） */
const TIMING_SHORT_LABELS: Record<PlanTiming, string> = {
  flexible: "彈性學習",
  afterSchool: "課餘",
};

/** 學期識別（如 115-1）轉為易讀文字 */
function periodText(period: string): string {
  const [year, semester] = period.split("-");
  if (!year || !semester) return period || "—";
  return `${year} 學年度第 ${semester} 學期`;
}

function monthDayText(date: string): string {
  const [, month, day] = date.split("-");
  if (!month || !day) return date;
  return `${Number(month)}/${Number(day)}`;
}

function formatGeneratedAt(epoch: number): string {
  const date = new Date(epoch);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function blockedNamesOf(week: PrintPreviewWeek): string {
  return [
    ...new Set(
      week.slots
        .map((slot) => slot.blockedBy)
        .filter((name): name is string => Boolean(name))
    ),
  ].join("、");
}

/** 週次欄內容：週次、時段、日期與節次（主表與成果紀錄表共用） */
function WeekInfo({ week }: { week: PrintPreviewWeek }) {
  return (
    <>
      <div className="sdl-print-week">第 {week.week} 週</div>
      <div className="sdl-print-timing">
        {TIMING_SHORT_LABELS[week.timing] ?? week.timing}
      </div>
      {week.slots.length === 0 ? (
        <div className="sdl-print-slots">—</div>
      ) : (
        week.slots.map((slot) => (
          <div key={`${slot.date}-${slot.day}`} className="sdl-print-slots">
            <div>
              {monthDayText(slot.date)} {WEEKDAY_LABELS[slot.day - 1]}
            </div>
            <div>
              {slot.periods.length > 0 ? slot.periods.join("、") : "—"}
              {slot.blockedBy && <span>（{slot.blockedBy}）</span>}
            </div>
          </div>
        ))
      )}
    </>
  );
}

/**
 * 紙張樣式：列印預覽刻意固定為白底黑字（與螢幕主題無關），
 * 確保深色主題下預覽與實際列印仍是紙張閱讀的樣子。
 */
const PRINT_SHEET_STYLES = `
.sdl-print-sheet {
  background: #ffffff;
  color: #111827;
  width: 100%;
  max-width: 210mm;
  margin: 0 auto;
  padding: 12mm 10mm;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.sdl-print-sheet h1 {
  margin: 0 0 2px;
  text-align: center;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.sdl-print-sub {
  margin: 0 0 14px;
  text-align: center;
  font-size: 12px;
  color: #4b5563;
}
.sdl-print-meta,
.sdl-print-weeks {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.sdl-print-meta {
  margin-bottom: 12px;
}
.sdl-print-meta th,
.sdl-print-meta td,
.sdl-print-weeks th,
.sdl-print-weeks td {
  border: 1px solid #9ca3af;
  padding: 4px 6px;
  text-align: left;
  vertical-align: top;
  word-break: break-word;
}
.sdl-print-meta th,
.sdl-print-weeks th {
  background: #e5e7eb;
  font-weight: 600;
}
.sdl-print-weeks th {
  text-align: center;
  vertical-align: middle;
}
.sdl-print-meta th {
  width: 14%;
  white-space: nowrap;
  text-align: center;
  vertical-align: middle;
}
.sdl-print-weeks thead {
  display: table-header-group;
}
.sdl-print-weeks tr {
  break-inside: avoid;
  page-break-inside: avoid;
}
.sdl-print-week {
  font-weight: 600;
  white-space: nowrap;
}
.sdl-print-weeks td.sdl-print-week-cell {
  vertical-align: middle;
}
.sdl-print-timing {
  margin-top: 2px;
  font-size: 11px;
  color: #374151;
}
.sdl-print-weeks th.sdl-print-record-title-cell {
  background: #f3f4f6;
}
.sdl-print-record-body {
  font-size: 12px;
}
.sdl-print-slots {
  margin-top: 2px;
  font-size: 11px;
  color: #374151;
}
.sdl-print-blocked {
  margin: 0;
  color: #b91c1c;
  font-weight: 600;
}
.sdl-print-note {
  margin: 2px 0 0;
  color: #4b5563;
  font-size: 11px;
}
.sdl-print-sheet p {
  margin: 2px 0;
}
.sdl-print-sheet ul,
.sdl-print-sheet ol {
  margin: 2px 0;
  padding-left: 1.4em;
}
.sdl-print-sheet li {
  margin: 1px 0;
}
.sdl-print-sheet blockquote {
  margin: 4px 0;
  padding-left: 8px;
  border-left: 3px solid #9ca3af !important;
  color: #374151 !important;
}
.sdl-print-footer {
  margin-top: 12px;
  font-size: 10px;
  color: #6b7280;
  text-align: right;
}
.sdl-print-section {
  margin: 14px 0 4px;
  font-size: 14px;
  font-weight: 700;
}
.sdl-print-reflection {
  border: 1px solid #9ca3af;
  padding: 6px 8px;
  font-size: 12px;
}
@media print {
  @page {
    size: A4;
    margin: 14mm;
  }
  /* 列印輸出只保留紙張內容：按鈕、SVG 浮動圖示與任何陰影都不輸出 */
  button,
  svg {
    display: none !important;
  }
  * {
    box-shadow: none !important;
  }
  html,
  body {
    background: #ffffff !important;
  }
  /* 只輸出紙張：紙張以外的元素（含瀏覽器擴充套件注入的浮動按鈕、
     陰影與固定定位面板）一律隱藏，避免被帶進 PDF。
     使用 visibility 而非 display，避免影響紙張版面。 */
  :where(body:has(.sdl-print-sheet)) * {
    visibility: hidden !important;
  }
  .sdl-print-sheet,
  .sdl-print-sheet * {
    visibility: visible !important;
  }
  .sdl-print-page {
    padding: 0 !important;
    background: #ffffff !important;
  }
  .sdl-print-toolbar {
    display: none !important;
  }
  .sdl-print-sheet {
    max-width: none;
    width: auto;
    margin: 0;
    padding: 0;
    box-shadow: none !important;
  }
}
`;

export function PrintPreviewSheet({ payload }: { payload: PrintPreviewPayload }) {
  const layout = payload.layout;
  return (
    <div className="sdl-print-sheet">
      <style>{PRINT_SHEET_STYLES}</style>

      <h1>自主學習計畫</h1>
      <p className="sdl-print-sub">{periodText(payload.period)}</p>

      <table className="sdl-print-meta">
        <tbody>
          <tr>
            <th scope="row">學生</th>
            <td>{payload.studentName || "—"}</td>
            <th scope="row">班級</th>
            <td>{payload.className || "—"}</td>
          </tr>
          <tr>
            <th scope="row">主題</th>
            <td colSpan={3}>{payload.topic || "—"}</td>
          </tr>
          <tr>
            <th scope="row">學群</th>
            <td>{payload.studyGroup || "—"}</td>
            <th scope="row">指導老師</th>
            <td>{payload.advisor || "未指定"}</td>
          </tr>
          <tr>
            <th scope="row">學習目標</th>
            <td colSpan={3}>
              <RichTextContent html={payload.learningGoals || ""} className="text-xs" />
            </td>
          </tr>
        </tbody>
      </table>

      <table className="sdl-print-weeks">
        <thead>
          <tr>
            <th scope="col" style={{ width: "22%" }}>
              週次／日期／節次
            </th>
            <th scope="col">學習安排</th>
            <th scope="col" style={{ width: "16%" }}>
              場地
            </th>
          </tr>
        </thead>
        <tbody>
          {payload.weeks.map((week) => {
            const blockedNames = blockedNamesOf(week);
            const showRecord = layout === "integrated" && Boolean(week.record);
            return (
              <Fragment key={week.week}>
                <tr>
                  <td className="sdl-print-week-cell" rowSpan={showRecord ? 3 : 1}>
                    <WeekInfo week={week} />
                  </td>
                  <td>
                    {week.blocked ? (
                      <>
                        <p className="sdl-print-blocked">{blockedNames || "學校活動"}</p>
                        <p className="sdl-print-note">
                          本週彈性學習時間為學校活動，不提供撰寫。
                        </p>
                        {week.content && (
                          <RichTextContent html={week.content} className="text-sm" />
                        )}
                      </>
                    ) : (
                      <RichTextContent html={week.content} className="text-sm" />
                    )}
                  </td>
                  <td>{week.venue || "—"}</td>
                </tr>
                {showRecord && (
                  <>
                    <tr>
                      <th colSpan={2} className="sdl-print-record-title-cell">
                        執行成果紀錄
                      </th>
                    </tr>
                    <tr>
                      <td colSpan={2} className="sdl-print-record-body">
                        <RichTextContent html={week.record} className="text-sm" />
                      </td>
                    </tr>
                  </>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {layout === "separate" && payload.weeks.some((week) => week.record) && (
        <>
          <h2 className="sdl-print-section">執行成果紀錄</h2>
          <table className="sdl-print-weeks">
            <thead>
              <tr>
                <th scope="col" style={{ width: "22%" }}>
                  週次／日期／節次
                </th>
                <th scope="col">執行成果</th>
              </tr>
            </thead>
            <tbody>
              {payload.weeks
                .filter((week) => week.record)
                .map((week) => (
                  <tr key={`record-${week.week}`}>
                    <td className="sdl-print-week-cell">
                      <WeekInfo week={week} />
                    </td>
                    <td>
                      <RichTextContent html={week.record} className="text-sm" />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      {payload.reflection && (
        <>
          <h2 className="sdl-print-section">學習反思心得</h2>
          <div className="sdl-print-reflection">
            <RichTextContent html={payload.reflection} className="text-sm" />
          </div>
        </>
      )}

      <p className="sdl-print-footer">
        {payload.source === "approved"
          ? payload.formalByStudent
            ? "已提升為正式計畫的內容與執行成果紀錄"
            : "已通過的計畫內容與執行成果紀錄"
          : "本預覽為目前編輯內容（含尚未儲存的變更）"}
        ｜產生時間：{formatGeneratedAt(payload.generatedAt)}
      </p>
    </div>
  );
}
