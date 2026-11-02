import { documentFilename, type DocumentStyle } from "./document-export";
import type { PrintPreviewPayload } from "../types/self-directed-learning";

export async function downloadWordDocument(payload: PrintPreviewPayload, style: DocumentStyle, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/student/self-directed-learning/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, style }),
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error("selfDirectedLearning Word download connection failed");
    throw new Error("無法連線至校內 Word 下載服務，請確認網站仍可連線，再按「下載 Word（.docx）」重試。");
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => {
      throw new Error("Word 匯出服務暫時無法回應，請稍後再試。");
    });
    throw new Error(data && typeof data === "object" && "message" in data && typeof data.message === "string"
      ? data.message : "Word 匯出失敗，請稍後再試。");
  }
  if (response.headers.get("Content-Type")?.split(";")[0] !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    throw new Error("未收到有效的 Word 文件，請重新登入後再試。");
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("Word 文件內容為空，請稍後再試。");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = documentFilename(payload);
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the URL alive long enough for browsers to begin reading the download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
