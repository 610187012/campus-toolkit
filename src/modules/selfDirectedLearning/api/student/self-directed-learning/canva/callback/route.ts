import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/dal";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getSettings } from "../../../../../lib/self-directed-learning";
import {
  CANVA_COOKIE, CANVA_HEADERS, CANVA_SCOPE, CANVA_TTL, CanvaError,
  assertCanvaOrigin, canvaConfig, canvaCookieOptions, canvaRequest, object, sealCanva, unsealCanva,
} from "../../../../../lib/canva-export";

function resultPage(message: string, status = 200) {
  return new NextResponse(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canva 授權</title><body><h1>Canva 授權</h1><p>${message}</p><p>請回到原本的自主學習計畫視窗；可以關閉本視窗。</p></body></html>`, {
    status, headers: { ...CANVA_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

export async function GET(request: NextRequest) {
  let verified: { uid: string; state: string } | null = null;
  try {
    const limited = enforceRateLimit(request, "self-directed-learning-canva-callback", RATE.SELF_DIRECTED_LEARNING_CANVA.limit, RATE.SELF_DIRECTED_LEARNING_CANVA.windowMs);
    if (limited) return limited;
    const { session, denial } = await requireRole("student");
    if (denial) throw new CanvaError("登入已失效，請回原頁重新登入後操作。", denial.status);
    const gate = await requireFeatureModuleEnabled("selfDirectedLearning", session);
    if (gate) throw new CanvaError("目前無法使用此模組。", 403);
    const settings = await getSettings();
    if (!settings.enabled || !settings.documentExports.canva) {
      throw new CanvaError("學校尚未開放 Canva 匯出服務。", 403);
    }
    const saved = await unsealCanva(request.cookies.get(CANVA_COOKIE.state)?.value, "state", session.uid);
    if (!saved.state || saved.state !== request.nextUrl.searchParams.get("state") || typeof saved.verifier !== "string") {
      throw new CanvaError("授權驗證不符，請回原頁重新操作。");
    }
    if (typeof saved.state !== "string") throw new CanvaError("授權驗證不符，請回原頁重新操作。");
    verified = { uid: session.uid, state: saved.state };
    if (request.nextUrl.searchParams.has("error")) throw new CanvaError("未完成 Canva 授權，沒有匯入文件。");
    const code = request.nextUrl.searchParams.get("code");
    if (!code || code.length > 4096) throw new CanvaError("未收到 Canva 授權碼，請重新操作。");
    const config = canvaConfig();
    assertCanvaOrigin(request);
    const token = object(await canvaRequest("oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: saved.verifier, redirect_uri: config.redirect }),
    }));
    if (typeof token.access_token !== "string" || !token.access_token || typeof token.expires_in !== "number" ||
      token.expires_in < 30 || (typeof token.scope === "string" && !token.scope.split(" ").includes(CANVA_SCOPE))) {
      throw new CanvaError("Canva 授權內容無效或缺少匯入權限，請重新操作。");
    }
    const ttl = Math.min(CANVA_TTL, Math.floor(token.expires_in));
    const response = resultPage("Canva 授權完成，原視窗將繼續匯入文件。");
    response.cookies.set(CANVA_COOKIE.token, await sealCanva({ uid: session.uid, state: saved.state, accessToken: token.access_token }, "token", ttl), canvaCookieOptions(ttl));
    return response;
  } catch (error) {
    console.error("selfDirectedLearning Canva callback failed", error instanceof CanvaError ? error.status : "unexpected");
    const message = error instanceof CanvaError ? error.message : "Canva 授權失敗，請稍後再試。";
    const response = resultPage(message, error instanceof CanvaError ? error.status : 500);
    if (verified) {
      response.cookies.set(CANVA_COOKIE.token, await sealCanva({ ...verified, error: message }, "token"), canvaCookieOptions());
    }
    return response;
  }
}
