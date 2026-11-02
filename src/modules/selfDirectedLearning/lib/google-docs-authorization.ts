import { GOOGLE_DRIVE_FILE_SCOPE } from "./document-export";

interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
}

interface GoogleOAuth {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    include_granted_scopes: boolean;
    callback: (response: GoogleTokenResponse) => void;
    error_callback: (error: { type: string }) => void;
  }): { requestAccessToken(config: { prompt: string }): void };
  hasGrantedAllScopes(response: GoogleTokenResponse, scope: string): boolean;
}

export function googleOAuth(): GoogleOAuth | null {
  const candidate: unknown = Reflect.get(window, "google");
  if (!candidate || typeof candidate !== "object" || !("accounts" in candidate)) return null;
  const accounts = candidate.accounts;
  if (!accounts || typeof accounts !== "object" || !("oauth2" in accounts)) return null;
  const oauth = accounts.oauth2;
  if (
    !oauth || typeof oauth !== "object" ||
    !("initTokenClient" in oauth) || typeof oauth.initTokenClient !== "function" ||
    !("hasGrantedAllScopes" in oauth) || typeof oauth.hasGrantedAllScopes !== "function"
  ) return null;
  return oauth as GoogleOAuth;
}

/** 必須直接從點擊事件呼叫；token 僅供本次匯出使用，不儲存、不傳回校內伺服器。 */
export function authorizeGoogleDocs(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const oauth = googleOAuth();
    if (!oauth || !clientId) {
      reject(new Error("Google 授權元件尚未就緒，請稍後再試。"));
      return;
    }
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_FILE_SCOPE,
      include_granted_scopes: false,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error("未完成 Google 授權，沒有匯出文件。"));
        } else if (!oauth.hasGrantedAllScopes(response, GOOGLE_DRIVE_FILE_SCOPE)) {
          reject(new Error("尚未同意建立檔案的權限，沒有匯出文件；請重新操作並同意該項權限。"));
        } else {
          resolve(response.access_token);
        }
      },
      error_callback: (error) => {
        reject(new Error(error.type === "popup_closed"
          ? "已取消 Google 授權，沒有匯出文件。"
          : "Google 授權視窗無法開啟，請允許彈出視窗後重試。"));
      },
    });
    client.requestAccessToken({ prompt: "select_account" });
  });
}
