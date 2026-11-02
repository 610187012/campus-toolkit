import type { DocumentStyle } from "./document-export";
import type { PrintPreviewPayload } from "../types/self-directed-learning";

const endpoint = "/api/student/self-directed-learning/canva";

async function request(query: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(`${endpoint}${query}`, {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("success" in data) || data.success !== true || !response.ok) {
    throw new Error(data && typeof data === "object" && "message" in data && typeof data.message === "string"
      ? data.message : "Canva 匯出失敗，請稍後再試。");
  }
  return data;
}

function pause(signal: AbortSignal, ms = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function checkCanvaConfiguration(signal: AbortSignal) {
  await request("?op=config", signal);
}

/** Open synchronously from the click; OAuth credentials never leave HttpOnly cookies. */
export async function exportToCanva(
  payload: PrintPreviewPayload, style: DocumentStyle, signal: AbortSignal, onCreating: () => void
): Promise<string[]> {
  const popup = window.open("about:blank", "_blank", "popup,width=700,height=760");
  if (!popup) throw new Error("無法開啟 Canva 授權視窗，請允許彈出視窗後再試。");
  try {
    const auth = await request("", signal, { op: "authorize", agreed: true });
    if (!("url" in auth) || typeof auth.url !== "string") throw new Error("Canva 授權網址無效。");
    const authUrl = new URL(auth.url);
    if (authUrl.origin !== "https://www.canva.com" || authUrl.pathname !== "/api/oauth/authorize") throw new Error("Canva 授權網址無效。");
    popup.opener = null;
    popup.location.href = authUrl.toString();
    const deadline = Date.now() + 180_000;
    while (true) {
      if (Date.now() > deadline) throw new Error("等候 Canva 授權逾時，請回到此頁重新操作。");
      await pause(signal);
      const state = await request("?op=connection", signal);
      if ("ready" in state && state.ready === true) break;
    }
    popup.close();
    onCreating();
    let job = await request("", signal, { agreed: true, payload, style });
    const importDeadline = Date.now() + 120_000;
    while ("status" in job && job.status === "in_progress") {
      if (Date.now() > importDeadline) {
        throw new Error("Canva 仍在處理，請先到 Canva 查看專案，避免重複匯入。");
      }
      await pause(signal, 2000);
      job = await request("?op=job", signal);
    }
    if (!("status" in job) || job.status !== "success" || !("urls" in job) || !Array.isArray(job.urls) || !job.urls.length) {
      throw new Error("Canva 未回傳設計連結，請先查看自己的專案。");
    }
    const urls: string[] = [];
    for (const link of job.urls) {
      if (typeof link !== "string") throw new Error("Canva 設計連結無效。");
      const url = new URL(link);
      if (url.protocol !== "https:" || url.hostname !== "www.canva.com" || url.username || url.password || url.port) throw new Error("Canva 設計連結無效。");
      urls.push(url.toString());
    }
    return urls;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("已取消 Canva 授權，沒有匯入文件。");
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw new Error("無法確認 Canva 處理結果，請先查看自己的專案，再決定是否重試。");
    }
    throw error;
  } finally { popup.close(); }
}
