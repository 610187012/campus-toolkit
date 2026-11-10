import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// CSP（含 script-src nonce）由 src/proxy.ts 動態產出；
// 此處僅保留不需 per-request nonce 的固定安全標頭。
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // 阻斷跨來源文件以 window.opener 存取本頁（COOP），
  // 限制本站資源被跨來源嵌入（CORP），並禁止 Flash 等讀取本域 cross-domain policy 檔。
  // Firebase signInWithPopup 需保留 opener 溝通，COOP 必須用 same-origin-allow-popups
  // （same-origin 會在彈窗跨來源導覽時切斷，導致 Google 登入被當成關閉彈窗而靜默失敗）。
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // 沙箱編譯產物不是 import 進程式，而是執行期讀取；明確納入 tracing，
  // 避免 serverless 部署只帶 .next 而漏掉 .module-sandbox。
  outputFileTracingIncludes: {
    "/api/**": [".module-sandbox/**/*"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
