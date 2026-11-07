# 安全性政策（campus-toolkit）

## 回報漏洞

請**不要**開公開 issue 或在討論區貼出可重現攻擊的細節。請使用 GitHub 的私人安全回報：

<https://github.com/takan003/campus-toolkit/security/advisories/new>

回報時請附上：

1. 受影響版本（`src/version.json`）與部署方式（Vercel／Firebase App Hosting／自架）
2. 重現步驟或最小範例
3. 影響範圍（例如：未授權讀取、權限提升、個資外洩、任意程式碼執行）
4. 是否涉及真實學校資料；若是，請勿夾帶個資

修復前請勿公開細節；確認後會盡快回覆與修正。

## 支援版本

僅支援最新 `main` 與最近一個已部署版本。舊版請先升級再回報。

## 範圍

- 主程式 API、session／2FA、權限判定、CSRF／rate limit
- 模組安裝鏈（下載、簽章、掃描、GitHub 提交）
- 內建管理端頁面與資料存取邊界

## 不在範圍

- **fork 主人自行修改的 local 模組**（`link-copy:`／`copy:`／手動放入 `src/modules`）：
  屬該 fork 的自管範圍，請向該 fork 維護者回報
- 自架環境變數設定錯誤（例如未關閉 `ALLOW_BOOTSTRAP_ADMIN`）
- 第三方套件本身的 advisory（請回報上游；本專案會定期更新）

## 已知邊界

模組仍是 **in-process、具伺服器權限**，不是沙箱；簽章、掃描與人審只能降低上架前風險。
完整信任模型與上架政策見 [`AGENTS.md`](AGENTS.md)，
模組架構見 [`docs/主程式模組與功能模組.md`](docs/主程式模組與功能模組.md)。
