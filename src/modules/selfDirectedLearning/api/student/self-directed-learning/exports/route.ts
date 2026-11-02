import { NextRequest, NextResponse } from "next/server";
import { requireRole, toAuthResponse } from "@/lib/dal";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getSettings } from "../../../../lib/self-directed-learning";
import { DOCUMENT_EXPORT_LABELS } from "../../../../types/self-directed-learning";
import { assertSameOrigin } from "@/lib/csrf";
import { buildDocumentDocx } from "../../../../lib/document-docx";
import { DocumentExportInputError, parseDocumentExport } from "../../../../lib/document-export-input";
import { documentFilename } from "../../../../lib/document-export";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(request, "self-directed-learning-exports", RATE.SELF_DIRECTED_LEARNING_LIST.limit, RATE.SELF_DIRECTED_LEARNING_LIST.windowMs);
    if (limited) return limited;
    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);
    const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
    if (gate) return gate;
    const settings = await getSettings();
    const platform = request.nextUrl.searchParams.get("platform");
    if (platform !== "googleDocs" && platform !== "canva" && platform !== "word") {
      return NextResponse.json({ success: false, message: "匯出平台無效。" }, { status: 400, headers });
    }
    if (!settings.enabled || !settings.documentExports[platform]) {
      return NextResponse.json({ success: false, message: `學校尚未開放 ${DOCUMENT_EXPORT_LABELS[platform]} 匯出服務。` }, { status: 403, headers });
    }
    return NextResponse.json({ success: true }, { headers });
  } catch (error) {
    console.error("selfDirectedLearning export settings GET error:", error);
    return NextResponse.json({ success: false, message: "無法確認匯出服務設定，請稍後再試。" }, { status: 500, headers });
  }

}

export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOrigin(request);
    if (csrf) return csrf;
    const limited = enforceRateLimit(request, "self-directed-learning-word", RATE.SELF_DIRECTED_LEARNING_STUDENT.limit, RATE.SELF_DIRECTED_LEARNING_STUDENT.windowMs);
    if (limited) return limited;
    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);
    const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
    if (gate) return gate;
    const settings = await getSettings();
    if (!settings.enabled || !settings.documentExports.word) {
      return NextResponse.json({ success: false, message: "學校尚未開放 Word 匯出服務。" }, { status: 403, headers });
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 1_000_000) {
      return NextResponse.json({ success: false, message: "匯出內容過大，請縮減後再試。" }, { status: 413, headers });
    }
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new DocumentExportInputError("匯出請求格式錯誤。"); }
    const { payload, style } = parseDocumentExport(input);
    return new NextResponse(new Uint8Array(buildDocumentDocx(payload, style)), {
      headers: {
        ...headers,
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="self-directed-learning.docx"; filename*=UTF-8''${encodeURIComponent(documentFilename(payload))}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("selfDirectedLearning Word export failed", error instanceof DocumentExportInputError ? "invalid input" : "unexpected");
    return NextResponse.json({
      success: false, message: error instanceof DocumentExportInputError ? error.message : "Word 匯出失敗，請稍後再試。",
    }, { status: error instanceof DocumentExportInputError ? 400 : 500, headers });
  }
}
