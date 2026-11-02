"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import type { ToastMessage } from "@/components/Toast";
import { authorizeGoogleDocs, googleOAuth } from "../lib/google-docs-authorization";
import { checkDocumentExportAllowed, createGoogleDocument, DOCUMENT_STYLES, type DocumentStyle } from "../lib/document-export";
import { checkCanvaConfiguration, exportToCanva } from "../lib/canva-client";
import { downloadWordDocument } from "../lib/word-client";
import { DOCUMENT_EXPORT_LABELS, type DocumentExportPlatform, type DocumentExportServices, type PrintPreviewPayload } from "../types/self-directed-learning";

export default function DocumentExportControls({
  getPayload,
  onToast,
  services,
}: {
  getPayload: () => PrintPreviewPayload;
  onToast: (message: ToastMessage) => void;
  services: DocumentExportServices;
}) {
  const [payload, setPayload] = useState<PrintPreviewPayload | null>(null);
  const [ready, setReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<"authorizing" | "creating" | null>(null);
  const [documentUrl, setDocumentUrl] = useState("");
  const [error, setError] = useState("");
  const [documentStyle, setDocumentStyle] = useState<DocumentStyle>("formal");
  const [platform, setPlatform] = useState<DocumentExportPlatform>("googleDocs");
  const [downloaded, setDownloaded] = useState(false);
  const [canvaReady, setCanvaReady] = useState(false);
  const [serviceReady, setServiceReady] = useState(false);
  const [canvaUrls, setCanvaUrls] = useState<string[]>([]);
  const operationRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const clientId = (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "").trim();
  const selectedPlatform = services[platform] ? platform : services.googleDocs ? "googleDocs" : services.canva ? "canva" : "word";
  const available = services.googleDocs || services.canva || services.word;
  const isCanva = selectedPlatform === "canva";
  const isWord = selectedPlatform === "word";
  const platformName = DOCUMENT_EXPORT_LABELS[selectedPlatform];
  const completed = downloaded || Boolean(documentUrl) || canvaUrls.length > 0;

  useEffect(() => () => operationRef.current?.abort(), []);

  useEffect(() => {
    if (!payload) return;
    if (selectedPlatform === "word") {
      setServiceReady(true);
      return;
    }
    const controller = new AbortController();
    setServiceReady(false);
    void checkDocumentExportAllowed(selectedPlatform, controller.signal).then(() => setServiceReady(true)).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : "無法確認匯出服務設定，請稍後再試。");
      }
    });
    return () => controller.abort();
  }, [payload, selectedPlatform]);

  useEffect(() => {
    if (!payload || !isCanva || !serviceReady) return;
    const controller = new AbortController();
    setCanvaReady(false);
    void checkCanvaConfiguration(controller.signal).then(() => setCanvaReady(true)).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.error("selfDirectedLearning Canva configuration unavailable");
        setError(error instanceof Error ? error.message : "無法確認 Canva 設定，請稍後再試。");
      }
    });
    return () => controller.abort();
  }, [payload, isCanva, serviceReady]);

  useEffect(() => {
    if (!payload) return;
    const dialog = dialogRef.current;
    dialog?.showModal();
    if (googleOAuth()) setReady(true);
    return () => dialog?.close();
  }, [payload]);

  const close = () => {
    if (isCanva && busy === "authorizing") {
      operationRef.current?.abort();
      return;
    }
    if (!busy) setPayload(null);
  };

  const start = () => {
    if (!available) return;
    setServiceReady(false);
    setAgreed(false);
    setError("");
    setDocumentUrl("");
    setCanvaUrls([]);
    setDownloaded(false);
    setPayload(getPayload());
  };

  const exportDocument = async () => {
    if (!payload || (!isWord && !agreed) || !available || !serviceReady || busy || operationRef.current ||
      (!isWord && (isCanva ? !canvaReady : !clientId || !ready || scriptFailed))) return;
    const controller = new AbortController();
    operationRef.current = controller;
    setError("");
    setBusy(isWord ? "creating" : "authorizing");
    try {
      if (isWord) {
        await downloadWordDocument(payload, documentStyle, controller.signal);
        setDownloaded(true);
        onToast({ kind: "success", text: "已送出 Word 下載，請查看瀏覽器下載項目。" });
      } else if (isCanva) {
        setCanvaUrls(await exportToCanva(payload, documentStyle, controller.signal, () => setBusy("creating")));
        onToast({ kind: "success", text: "Canva 匯入完成，請按「開啟 Canva 設計」開始編輯。" });
      } else {
        const token = await authorizeGoogleDocs(clientId);
        setBusy("creating");
        await checkDocumentExportAllowed("googleDocs", controller.signal);
        const url = await createGoogleDocument(payload, token, documentStyle);
        setDocumentUrl(url);
        onToast({ kind: "success", text: "已建立 Google 文件，請按「開啟 Google 文件」開始編輯。" });
      }
    } catch (error) {
      console.error("selfDirectedLearning document export failed", selectedPlatform);
      const message = error instanceof Error ? error.message : "文件匯出失敗，請稍後再試。";
      setError(message);
      setAgreed(false);
      onToast({ kind: "error", text: message });
    } finally {
      operationRef.current = null;
      setBusy(null);
    }
  };

  if (!available) return null;

  return (
    <>
      <label className="text-t2 flex items-center gap-2 text-xs">
        匯出格式／平台
        <select
          aria-label="匯出格式／平台"
          value={selectedPlatform}
          disabled={Boolean(payload)}
          onChange={(event) => {
            if (event.target.value === "googleDocs" || event.target.value === "canva" || event.target.value === "word") setPlatform(event.target.value);
          }}
          className="input-theme rounded px-2 py-2 text-xs"
        >
          {services.googleDocs && <option value="googleDocs">Google Docs</option>}
          {services.canva && <option value="canva">Canva</option>}
          {services.word && <option value="word">Word（.docx）</option>}
        </select>
      </label>
      <button type="button" className="btn-theme rounded px-4 py-2 text-xs" onClick={start}>
        匯出
      </button>
      {payload && (
        <dialog
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`匯出至 ${platformName}`}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          className="border-themed bg-card text-t1 max-w-xl overflow-y-auto rounded-lg border p-4 shadow-lg"
          style={{ margin: "auto", width: "calc(100% - 2rem)", maxHeight: "85dvh" }}
        >
          <h2 className="text-lg font-semibold">匯出至 {platformName}</h2>
          <p className="text-t2 mt-2 break-words text-sm">{payload.topic || "未命名計畫"}</p>
          <label className="text-t2 mt-3 flex flex-wrap items-center gap-2 text-sm">
            文件風格
            <select
              aria-label="文件風格"
              className="input-theme rounded px-2 py-2 text-sm"
              value={documentStyle}
              disabled={Boolean(busy) || completed}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "basic" || value === "formal" || value === "monochrome" || value === "portfolio") {
                  setDocumentStyle(value);
                }
              }}
            >
              {Object.entries(DOCUMENT_STYLES).map(([value, option]) => (
                <option key={value} value={value}>{option.label}</option>
              ))}
            </select>
          </label>
          <p className="text-t3 mt-2 text-xs">{DOCUMENT_STYLES[documentStyle].description}</p>
          <p className="text-t2 mt-2 text-sm">
            將此刻的學生姓名、班級、計畫、逐週成果及心得（包含畫面中尚未儲存的內容），
            {isWord ? "產生可編輯的 Word（.docx）檔案，下載到你的裝置，不傳送至 Google 或 Canva。" : `建立為你選擇的 ${isCanva ? "Canva" : "Google"} 帳號中的可編輯副本。請選擇自己的帳號。`}
            不會自動公開分享，也不會把修改同步回校內。
          </p>
          <p className="text-t3 mt-2 text-xs">
            {isWord ? "不需外部帳號授權；由校內網站即時產生，不另存匯出內容。下載後請妥善保管個人資料，可使用 Microsoft Word 或相容軟體開啟。" : isCanva ? "透過 Canva 官方授權，以文件匯入方式建立設計；基本文字格式保留，字型、清單與表格可能由 Canva 重新排版。授權視窗若未完成，可按取消後重試。" : "僅要求此應用程式建立／開啟之檔案的存取權，不讀取整個雲端硬碟。"}
            每次操作會建立新副本，文字格式、表格或分頁可能與列印預覽略有不同。
          </p>
          {serviceReady && !isWord && !isCanva && (!clientId ? (
            <p role="alert" className="text-danger mt-3 text-sm">
              尚未設定 NEXT_PUBLIC_GOOGLE_CLIENT_ID，請由學校管理員完成 Google OAuth 與 Drive API 設定。
            </p>
          ) : !documentUrl && (
            <Script
              id="sdl-google-docs-identity"
              src="https://accounts.google.com/gsi/client"
              onReady={() => {
                const available = Boolean(googleOAuth());
                setReady(available);
                setScriptFailed(!available);
              }}
              onError={() => {
                setScriptFailed(true);
                setReady(false);
              }}
            />
          ))}
          {!isWord && !isCanva && scriptFailed && (
            <p role="alert" className="text-danger mt-3 text-sm">
              無法載入 Google 授權元件，請檢查網路或內容阻擋設定，重新整理後再試。
            </p>
          )}
          {error && <p role="alert" className="text-danger mt-3 text-sm">{error}</p>}
          {downloaded && <p role="status" className="text-t2 mt-3 text-sm">已送出 Word 下載，請查看瀏覽器下載項目；若瀏覽器詢問儲存位置，請自行選擇。</p>}
          {!completed && !isWord && (
            <label className="border-themed mt-3 flex items-start gap-2 rounded border p-3 text-sm">
              <input
                type="checkbox"
                checked={agreed}
                disabled={Boolean(busy)}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>我同意將上述資料傳送至本人選擇的 {isCanva ? "Canva" : "Google"} 帳號，建立此次{isCanva ? "設計" : "文件"}副本。</span>
            </label>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" disabled={Boolean(busy) && !(isCanva && busy === "authorizing")} className="btn-theme rounded px-4 py-2 text-sm disabled:opacity-50" onClick={close}>
              {completed ? "關閉" : "取消"}
            </button>
            {canvaUrls.length > 0 ? canvaUrls.map((url, index) => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="btn-primary rounded px-4 py-2 text-sm">
                開啟 Canva 設計{canvaUrls.length > 1 ? ` ${index + 1}` : ""}
              </a>
            )) : documentUrl ? (
              <a href={documentUrl} target="_blank" rel="noopener noreferrer" className="btn-primary rounded px-4 py-2 text-sm">
                開啟 Google 文件
              </a>
            ) : !downloaded && (
              <button
                type="button"
                className="btn-primary rounded px-4 py-2 text-sm disabled:opacity-50"
                disabled={!serviceReady || (!isWord && ((isCanva ? !canvaReady : !clientId || !ready || scriptFailed) || !agreed)) || Boolean(busy)}
                onClick={() => void exportDocument()}
              >
                {busy === "authorizing" ? `等待 ${isCanva ? "Canva" : "Google"} 授權…` : busy === "creating" ? (isWord ? "產生 Word 中…" : isCanva ? "Canva 匯入中…" : "建立文件中…") : !serviceReady ? (error ? "暫時無法匯出" : "檢查匯出服務中…") : isWord ? "下載 Word（.docx）" : isCanva ? (canvaReady ? "授權 Canva 並匯入" : error ? "Canva 暫時無法匯出" : "檢查 Canva 設定中…") : ready ? "選擇 Google 帳號並建立" : "載入 Google 授權元件…"}
              </button>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
