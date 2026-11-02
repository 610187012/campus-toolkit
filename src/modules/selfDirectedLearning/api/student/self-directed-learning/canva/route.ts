import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { requireRole, toAuthResponse } from "@/lib/dal";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { documentTitle } from "../../../../lib/document-export";
import { buildDocumentDocx } from "../../../../lib/document-docx";
import { getSettings } from "../../../../lib/self-directed-learning";
import {
  CANVA_COOKIE, CANVA_HEADERS, CanvaError, assertCanvaOrigin, canvaAuthorization, canvaCookieOptions,
  canvaJob, canvaRequest, parseCanvaExport, sealCanva, unsealCanva,
} from "../../../../lib/canva-export";

async function guard(request: NextRequest): Promise<{ response: NextResponse } | { uid: string }> {
  const limited = enforceRateLimit(request, "self-directed-learning-canva", RATE.SELF_DIRECTED_LEARNING_CANVA.limit, RATE.SELF_DIRECTED_LEARNING_CANVA.windowMs);
  if (limited) return { response: limited };
  const { session, denial } = await requireRole("student");
  if (denial) return { response: toAuthResponse(denial) };
  const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
  if (gate) return { response: gate };
  const settings = await getSettings();
  if (!settings.enabled || !settings.documentExports.canva) {
    throw new CanvaError("學校尚未開放 Canva 匯出服務。", 403);
  }
  return { uid: session.uid };
}

function failure(error: unknown) {
  console.error("selfDirectedLearning Canva operation failed", error instanceof CanvaError ? error.status : "unexpected");
  return NextResponse.json({ success: false, message: error instanceof CanvaError ? error.message : "Canva 匯出失敗，請稍後再試。" },
    { status: error instanceof CanvaError ? error.status : 500, headers: CANVA_HEADERS });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await guard(request);
    if ("response" in auth) return auth.response;
    assertCanvaOrigin(request);
    const op = request.nextUrl.searchParams.get("op");
    if (op === "config") return NextResponse.json({ success: true }, { headers: CANVA_HEADERS });
    if (op === "connection") {
      const state = await unsealCanva(request.cookies.get(CANVA_COOKIE.state)?.value, "state", auth.uid);
      const cookie = request.cookies.get(CANVA_COOKIE.token)?.value;
      if (!cookie) return NextResponse.json({ success: true, ready: false }, { headers: CANVA_HEADERS });
      const token = await unsealCanva(cookie, "token", auth.uid);
      if (token.state === state.state && typeof token.error === "string") throw new CanvaError(token.error);
      return NextResponse.json({ success: true, ready: token.state === state.state }, { headers: CANVA_HEADERS });
    }
    if (op !== "job") throw new CanvaError("Canva 操作無效。");
    const token = await unsealCanva(request.cookies.get(CANVA_COOKIE.token)?.value, "token", auth.uid);
    const job = await unsealCanva(request.cookies.get(CANVA_COOKIE.job)?.value, "job", auth.uid);
    if (typeof job.id !== "string" || typeof token.accessToken !== "string" || job.state !== token.state) {
      throw new CanvaError("Canva 匯入工作已失效，請先查看自己的專案。", 401);
    }
    const result = canvaJob(await canvaRequest(`imports/${encodeURIComponent(job.id)}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    }));
    return NextResponse.json({ success: true, ...result }, { headers: CANVA_HEADERS });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOrigin(request);
    if (csrf) return csrf;
    const auth = await guard(request);
    if ("response" in auth) return auth.response;
    assertCanvaOrigin(request);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 1_000_000) throw new CanvaError("匯出內容過大，請縮減後再試。", 413);
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new CanvaError("匯出請求格式錯誤。"); }
    if (input && typeof input === "object" && "op" in input && input.op === "authorize") {
      if (!("agreed" in input) || input.agreed !== true) throw new CanvaError("請先同意將此次資料傳送至 Canva。");
      const oauth = await canvaAuthorization();
      const response = NextResponse.json({ success: true, url: oauth.url }, { headers: CANVA_HEADERS });
      response.cookies.set(CANVA_COOKIE.state, await sealCanva({ uid: auth.uid, verifier: oauth.verifier, state: oauth.state }, "state"), canvaCookieOptions());
      response.cookies.set(CANVA_COOKIE.token, "", canvaCookieOptions(0));
      response.cookies.set(CANVA_COOKIE.job, "", canvaCookieOptions(0));
      return response;
    }
    const { payload, style } = parseCanvaExport(input);
    const token = await unsealCanva(request.cookies.get(CANVA_COOKIE.token)?.value, "token", auth.uid);
    if (typeof token.accessToken !== "string" || typeof token.state !== "string") throw new CanvaError("Canva 授權已失效，請重新操作。", 401);
    if (request.cookies.has(CANVA_COOKIE.job)) throw new CanvaError("此次匯入已送出，請先查看 Canva 專案，避免重複建立。", 409);
    const file = buildDocumentDocx(payload, style);
    const result = canvaJob(await canvaRequest("imports", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/octet-stream",
        "Import-Metadata": JSON.stringify({ title_base64: Buffer.from([...documentTitle(payload)].slice(0, 50).join("")).toString("base64"), mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
      },
      body: new Uint8Array(file),
    }));
    const response = NextResponse.json({ success: true, ...result }, { headers: CANVA_HEADERS });
    response.cookies.set(CANVA_COOKIE.job, await sealCanva({ uid: auth.uid, id: result.id, state: token.state }, "job"), canvaCookieOptions());
    return response;
  } catch (error) { return failure(error); }
}
