"use client";

import { useEffect, useState } from "react";
import {
  PRINT_PREVIEW_DATA,
  PRINT_PREVIEW_READY,
  type PrintPreviewPayload,
} from "../../../types/self-directed-learning";
import { PrintPreviewSheet } from "../../../components/print-preview";

function isPreviewPayload(value: unknown): value is PrintPreviewPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.period !== "string" ||
    typeof payload.studentName !== "string" ||
    typeof payload.className !== "string" ||
    typeof payload.topic !== "string" ||
    typeof payload.studyGroup !== "string" ||
    typeof payload.advisor !== "string" ||
    typeof payload.generatedAt !== "number" ||
    (payload.reflection !== undefined && typeof payload.reflection !== "string") ||
    (payload.source !== undefined && payload.source !== "draft" && payload.source !== "approved") ||
    (payload.formalByStudent !== undefined && typeof payload.formalByStudent !== "boolean") ||
    (payload.layout !== "separate" && payload.layout !== "integrated") ||
    !Array.isArray(payload.weeks)
  ) {
    return false;
  }
  return payload.weeks.every((item) => {
    if (!item || typeof item !== "object") return false;
    const week = item as Record<string, unknown>;
    if (
      typeof week.week !== "number" ||
      (week.timing !== "flexible" && week.timing !== "afterSchool") ||
      typeof week.content !== "string" ||
      typeof week.venue !== "string" ||
      typeof week.blocked !== "boolean" ||
      (week.record !== undefined && typeof week.record !== "string") ||
      !Array.isArray(week.slots)
    ) {
      return false;
    }
    return week.slots.every((slot) => {
      if (!slot || typeof slot !== "object") return false;
      const entry = slot as Record<string, unknown>;
      return (
        typeof entry.date === "string" &&
        typeof entry.day === "number" &&
        Array.isArray(entry.periods) &&
        (entry.blockedBy === null || typeof entry.blockedBy === "string")
      );
    });
  });
}

/** 學生端列印預覽：由「撰寫計畫」頁以新分頁開啟，透過 postMessage 取得目前編輯內容 */
export default function SelfDirectedLearningPrintPage() {
  const [payload, setPayload] = useState<PrintPreviewPayload | null>(null);
  const [hasOpener, setHasOpener] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    document.title = "自主學習計畫－列印預覽";
    setHasOpener(Boolean(window.opener));

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!window.opener || event.source !== window.opener) return;
      if (!event.data || event.data.type !== PRINT_PREVIEW_DATA) return;
      if (!isPreviewPayload(event.data.payload)) {
        setError("預覽資料格式錯誤，請回到撰寫頁面重新開啟。");
        return;
      }
      setPayload(event.data.payload);
      setError("");
    };

    window.addEventListener("message", handleMessage);
    try {
      window.opener?.postMessage({ type: PRINT_PREVIEW_READY }, window.location.origin);
    } catch {
      // 跨來源或瀏覽器限制時忽略，頁面會顯示重新開啟的提示
    }

    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <div className="sdl-print-page bg-page min-h-screen p-4 md:p-8">
      <div
        className="sdl-print-toolbar border-themed bg-card sticky top-0 z-10 mx-auto mb-4 flex flex-wrap items-center justify-between gap-3 border px-4 py-2 shadow-sm"
        style={{ maxWidth: "210mm" }}
      >
        <div>
          <p className="text-t1 text-sm font-medium">列印預覽</p>
          <p className="text-t3 text-xs">
            此頁顯示要列印的計畫內容與執行成果紀錄；按「列印」可預覽或輸出。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            disabled={!payload}
            onClick={() => window.print()}
          >
            列印
          </button>
          <button
            type="button"
            className="btn-theme px-4 py-2 text-sm"
            onClick={() => window.close()}
          >
            關閉
          </button>
        </div>
      </div>

      {payload ? (
        <PrintPreviewSheet payload={payload} />
      ) : (
        <div
          className="border-themed bg-card mx-auto border p-6 text-center"
          style={{ maxWidth: "210mm" }}
        >
          <p className="text-t1 text-sm font-medium">
            {error ||
              (hasOpener === false
                ? "此頁需從「撰寫計畫」頁面開啟"
                : "正在取得編輯內容…")}
          </p>
          <p className="text-t3 mt-2 text-xs">
            請回到學生端「自主學習計畫」，用「預覽列印（計畫與成果）」重新開啟；
            撰寫計畫時也可從左側列印圖示開啟。
          </p>
          <a
            href="/student/self-directed-learning"
            className="btn-theme mt-4 inline-block px-4 py-2 text-sm"
          >
            回到自主學習計畫
          </a>
        </div>
      )}
    </div>
  );
}
