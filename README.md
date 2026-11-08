# 數位校園工具箱

[![CI](https://github.com/takan003/campus-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/takan003/campus-toolkit/actions/workflows/ci.yml)

整合校園資訊、身分入口與管理功能的校園工具平台。以角色（學生／家長／教職員／管理員）分流首頁，支援帳號密碼與 Google 登入、CSS 主題切換、管理後台與排行榜等，並具備：

- **兩步驟驗證**（TOTP 通行碼 + Email 驗證碼）
- **忘記密碼信件**（SMTP 寄送重設連結）
- **首次登入強制修改密碼**（管理員代設的預設密碼，登入後須先由本人修改才能繼續使用）
- **身分名冊／使用者帳號批次作業**（Excel 匯入、匯出與範本下載）
- **操作紀錄**（管理後台可查核帳號與設定異動）
- **贊助廣告開關**（管理後台可一鍵關閉，預設關閉）

歡迎感興趣的使用者 fork 自架。**不想打指令就按下方「一鍵部署」**；想自己動手，請先完成「環境變數」與「首次啟動」流程，缺金鑰無法運作。

> **部署平台**：目前主力部署於 Vercel，同時測試 Firebase App Hosting（同 repo、同 Firestore 資料庫，雙平台並行）。Fork 者使用 Vercel 路線不受影響。

## 一鍵部署（給不想碰終端機的人）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftakan003%2Fcampus-toolkit&env=NEXT_PUBLIC_FIREBASE_API_KEY,NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,NEXT_PUBLIC_FIREBASE_PROJECT_ID,NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,NEXT_PUBLIC_FIREBASE_APP_ID,SESSION_SECRET,FIREBASE_SERVICE_ACCOUNT_KEY,ALLOW_BOOTSTRAP_ADMIN&envDefaults=%7B%22ALLOW_BOOTSTRAP_ADMIN%22%3A%22true%22%7D&envDescription=Firebase%20%E6%AC%84%E4%BD%8D%E8%87%AA%E4%BD%A0%E7%9A%84%20Console%20%E8%A4%87%E8%A3%BD%EF%BC%9BSESSION_SECRET%20%E6%98%AF%E5%94%AF%E4%B8%80%E9%9C%80%E8%87%AA%E8%A1%8C%E7%94%A2%E7%94%9F%E7%9A%84%E6%AC%84%E4%BD%8D%EF%BC%88%E4%BA%82%E6%95%B8%EF%BC%8C%E8%87%B3%E5%B0%91%2032%20%E5%AD%97%E5%85%83%EF%BC%89%EF%BC%9BALLOW_BOOTSTRAP_ADMIN%20%E5%BB%BA%E5%AE%8C%E7%AE%A1%E7%90%86%E5%93%A1%E5%BE%8C%E6%94%B9%E7%82%BA%20false%E3%80%82%E8%A6%8F%E5%89%87%E8%A6%8B%20README%E3%80%8C%E7%92%B0%E5%A2%83%E8%AE%8A%E6%95%B8%E3%80%8D%E3%80%82&envLink=https%3A%2F%2Fgithub.com%2Ftakan003%2Fcampus-toolkit%2Fblob%2Fmain%2FREADME.md%23%E7%92%B0%E5%A2%83%E8%AE%8A%E6%95%B8&project-name=campus-toolkit&repository-name=campus-toolkit)

按下去之後，Vercel 會**自動把程式碼複製到你的 GitHub 帳號**、開好專案，並出現一張表單要你貼 9 個環境變數（欄位說明與取得方式就在表單旁，連到本 README）。填完按 Deploy 就上線了。

**這條路砍掉了**：Fork、clone、`npm install`、`cp .env.example`、編輯 `.env.local`、`npm run dev`、Vercel Import、手動抄環境變數到 Vercel —— 終端機一行指令都不用打。

### 按按鈕之前：先備妥 Firebase（沒辦法省）

按鈕只負責「搬程式＋上線」，**Firebase 那間機房還是得自己開**，因為表單要填的值都出自那裡。照下方「架設流程總覽」的**第 1 步**與**第 3 步**做完（約 10 分鐘），手上有這 9 個值就能按：

- 6 個 `NEXT_PUBLIC_*`（Firebase Web 應用程式設定）
- `SESSION_SECRET`（**唯一要自己產生、不是去哪裡找的欄位**。至少 32 字元；macOS／Linux：`openssl rand -base64 32`，Windows PowerShell：`[Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')`）
- `FIREBASE_SERVICE_ACCOUNT_KEY`（服務帳號私鑰，整段 JSON）
- `ALLOW_BOOTSTRAP_ADMIN`（已預填 `true`，不用動）

### 按按鈕之後：還有 4 件事

1. **建首位管理員**：開你的網址 `/setup`（線上直接建，不需要本機）。建完登入。
2. **立刻關掉建管開關**：Vercel 專案 → Settings → Environment Variables → 把 `ALLOW_BOOTSTRAP_ADMIN` 改為 `false` → Redeploy。**這步不要拖**，否則任何人開你的網址 `/setup` 都能搶建管理員。
3. **Firebase 授權網域**：Firebase Console → Authentication → 設定 → 授權的網域，加上你的 Vercel 網址，否則 Google 登入會被擋。
4. **Firestore 規則**：把本 repo 的 `firestore.rules` 貼進 Firebase Console → Firestore → 規則 後發布（見「Firebase 專案設定」第 5 點）。

其餘（SMTP 寄信、`APP_BASE_URL`、`TRUST_PROXY`）都是選填，之後隨時到 Vercel 的 Environment Variables 補即可。

### 出狀況了？三種常見問題與修法

這三種都是實際跑一鍵部署會遇到的。先認症狀，再照修法走。

#### ① 複製程式時說「repo 已存在」

```text
A repository named "campus-toolkit" already exists. Choose a different name.
```

**原因**：你的 GitHub 上已經有同名 repo —— 多半是先前 fork 過，或按鈕流程做到一半中斷、再按一次時殘留下來的。

**修法**：回到表單最上方的 **Repository Name** 欄，改成別的名字（例如 `campus-toolkit-school`）；`Project Name` 若也顯示重複，一併改掉。改完再按 Deploy，不會影響任何設定。

#### ② 按下 Deploy 後畫面變成 404

```text
https://vercel.com/%2Fnew%2Fcontinue%3FloginReturn%3D...
```

**原因**：走 GitHub 登入回跳時，流程的狀態掉了。**重新整理救不回來**（會一直卡在同一頁）。

**修法**：**再按一次本 README 的「Deploy with Vercel」按鈕**。此時你已經登入，會直接回到表單，不必重走登入流程。

#### ③ 網站上線了，但同事看到的是 Vercel 登入頁

**原因**：Vercel 給專案兩種網址，開放程度不同：

| 網址長相 | 誰看得到 |
|---|---|
| `你的專案名.vercel.app` | **所有人** —— 這才是正式網址 |
| `你的專案名-xxxxxxx-團隊.vercel.app` | 只有團隊成員；外人會被導去登入 Vercel |

**修法**：對外一律分享**上面那一種**。到 Vercel 專案頁的 `Domains` 區塊複製，別從部署紀錄裡拿。

> 想在本機跑、想改程式碼、或想先測過再上線？往下看完整的手動流程。

## 架設流程總覽（手動路徑，給第一次自架的人）

把整件事想成「辦好帳號 → 把程式搬回家 → 填設定 → 開張 → 上線」，大約是這樣：

### 第 1 步：開設 3 種帳號（都免費）

| 帳號 | 用途（白話） |
|------|----------------|
| [GitHub](https://github.com/) | 存放程式碼；按 Fork 把本專案複製到你自己的帳號下 |
| [Firebase](https://console.firebase.google.com/) | 當「資料庫＋Google 登入」的後台；所有帳號、設定都存在這裡 |
| [Vercel](https://vercel.com/) | 當「網站主機」；把 GitHub 上的程式自動架成網站（只在本機跑的話可以先跳過） |

走「一鍵部署」也一樣要開這 3 個帳號 —— 差別只在第 2、4、7 步由 Vercel 代勞。

### 第 2 步：把程式搬到自己名下

> 走上方「一鍵部署」的話，**這步整個跳過**（Vercel 會自動把程式複製到你帳號）。

1. 開啟本專案頁面，按 **Fork**，選自己的 GitHub 帳號。
2. 在電腦上把 fork 出來的 repo clone 下來，執行 `npm install`。
   （macOS／Linux 用 `cp .env.example .env.local`；Windows 命令提示字元請用 `copy .env.example .env.local`。）

### 第 3 步：去 Firebase 開一間「虛擬機房」

1. Firebase Console → **新增專案**（名字隨意）。
2. **建立 Firestore 資料庫**：左側 Build → Firestore database → **Create database** → 選位置（建議離使用者近的，**建好就不能改**）→ 選 **不開放瀏覽器存取**的模式（Production mode，新版介面叫 Restrictive）→ 建立。
   ⚠️ **新專案不會自動有資料庫** —— 漏這步的話，服務帳號私鑰照樣下載得到、部署也照樣成功，但任何資料讀寫都會失敗。
   資料結構**不用另外建立**：Firestore 是結構自由的，程式用到哪個集合，第一次寫入時會自動長出來（`users`、四張身分名冊、`settings` 等），首筆由 `/setup` 建首位管理員時寫入。完整清單見下方「Firebase 專案設定 → Firestore 資料結構」。
3. **（選做）建立 Firebase Storage bucket**：證件照**預設存 Firestore，不建立 bucket 也照樣能運作**。
   若想改用 Firebase Storage，左側 Build → Storage → **Get started** → 選位置 → 建立。
   ⚠️ **2026/02/03 起 Cloud Storage for Firebase 一律要求綁定 Blaze（隨用隨付）方案**，Spark（免費）方案無法建立或存取 bucket。Blaze 在免費額度內帳單仍為 $0，但必須綁定信用卡。
   ⚠️ **免費額度只存在於美國三區** `us-central1`／`us-east1`／`us-west1`（5 GB 儲存、100 GB 流量／月）。選亞洲等其他區域＝沒有任何免費額度，**建好就不能改**。
   新專案的 bucket 名稱為 `你的專案ID.firebasestorage.app`，填進 `.env.local` 的 `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`；
   然後到 **系統設定 → 省錢專區 → 學生證件照儲存位置** 改選「Firebase Storage」。
4. 啟用 **Google 登入**（Authentication → Sign-in method → Google）。
5. 新增 **Web 應用程式**，複製一串設定（API Key 等 6 個 `NEXT_PUBLIC_*`）。
6. 下載**服務帳號私鑰**（專案設定 → 服務帳號 → 產生新的私鑰）。此服務帳號須能讀寫上面的 bucket：Firebase 預設服務帳號已具專案編輯者權限（涵蓋 Storage Object Admin），通常不需另外設；若自行新建服務帳號，請額外授予 **Storage Object Admin**。
7. 把 Firestore 安全規則設成本 repo 的 `firestore.rules`（預設不給瀏覽器直接讀寫，比較安全）。
   ⚠️ 本 repo 的 `.firebaserc` 還綁著原作者的專案 ID，執行 `firebase deploy` 前請先改成你的專案，或直接在 Console 貼上規則（見下方「Firebase 專案設定」第 5 點）。

### 第 4 步：填環境變數（把第 3 步拿到的東西貼進去）

```bash
cp .env.example .env.local
```

編輯 `.env.local`，至少填好：

- Firebase 的 6 個 `NEXT_PUBLIC_*`（第 3 步）
- `SESSION_SECRET`（亂數字串，**至少 32 字元**；macOS／Linux 用 `openssl rand -base64 32`，Windows PowerShell 用 `[Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')`）
- `FIREBASE_SERVICE_ACCOUNT_KEY`（第 3 步下載的私鑰，整段 JSON 貼上）
- `ALLOW_BOOTSTRAP_ADMIN=true`（**只**為了建立第一個管理員，之後要改回 false）
- `SMTP_*` + `APP_BASE_URL`（**建議**：不填的話「忘記密碼」與 Email 驗證碼信件無法寄出，其他功能不受影響）

欄位細節見下方「環境變數」。

### 第 5 步：本機跑起來、開出第一個管理員

```bash
npm run dev
```

瀏覽器開 `http://localhost:3000/setup` → 填資料建立**管理員** → 回首頁用這組帳號登入。  
成功後把 `ALLOW_BOOTSTRAP_ADMIN` 改回 `false` 並重啟，避免日後有人免驗證建管。

### 第 6 步（可選）：補一點測試資料

專案根目錄執行 `node scripts/reset-users-roster.mjs`，會備份並重建使用者帳號（`users`）與四份身分名冊（`rosterStudents` / `rosterParents` / `rosterStaff` / `rosterAdmins`），種入一組測試帳號與範本資料。

### 第 7 步：上線到 Vercel

> 不想手動 Import 的話，回到上方「一鍵部署」按鈕即可，Vercel 會接手這一步（含環境變數表單）。

1. 回 GitHub，到 Vercel **Import** 你 fork 的 repo。
2. 把 `.env.local` 裡的變數全部抄到 Vercel 的 Environment Variables。
3. Deploy，拿到網址就能開玩。  
   （若 Google 登入被擋，去 Firebase → Authentication → 設定 → **授權的網域** 加上你的網址。）

### 一張圖看完

手動路徑：

```text
開 3 個帳號 ── Fork 到 GitHub ── clone + npm install
       │                                │
       ▼                                ▼
  Firebase 建專案                 填 .env.local
  （Google 登入、私鑰、            （設定 + session 金鑰）
   Firestore 規則、                       │
   Storage bucket）                      ▼
        │                                └──────────────► npm run dev → /setup 建管理員
                                         │
                                         ▼
                              （可選）種子測試帳號
                                         │
                                         ▼
                              Vercel Import → 填環境變數 → 上線
```

一鍵部署路徑（第 2、4、5、7 步合而為一）：

```text
開 3 個帳號 ── Firebase 建專案（第 1、3 步）
                    │
                    ▼
            按 Deploy to Vercel → 貼 9 個環境變數 → Deploy
                    │
                    ▼
            網址 /setup 建管理員 → 關 ALLOW_BOOTSTRAP_ADMIN
                    │
                    ▼
            Firebase 授權網域 + Firestore 規則 → 完成
```

以下為較細的技術說明與指令。

## 技術架構

| 項目 | 技術 |
|------|------|
| 前端框架 | Next.js 16+（App Router） |
| 語言 | TypeScript |
| 樣式 | Tailwind CSS 4 |
| 認證 | Firebase Authentication（Google）＋ 自建帳號密碼（bcrypt） |
| 資料庫 | Cloud Firestore（一律由伺服端 Admin SDK 存取） |
| Session | JWT（`jose`，HS256）＋ HttpOnly Cookie |
| 部署 | Vercel（本機亦可 `next start`） |

## 需求

- Node.js 20.9+（建議 LTS；Next.js 16 的最低要求）
- npm
- 一組自己的 [Firebase](https://console.firebase.google.com/) 專案
- （上線）Vercel 帳號

## 快速開始

```bash
# 1. 安裝依賴
npm install

# 2. 建立環境變數（Windows 命令提示字元改用 copy .env.example .env.local）
cp .env.example .env.local
# 編輯 .env.local，欄位說明見下一節

# 3. 啟動開發伺服器
npm run dev
```

瀏覽器開啟 `http://localhost:3000`。金鑰齊全前，登入與後台 API 會失敗，屬預期行為。

## 環境變數

完整欄位請對照 [`.env.example`](.env.example)。複製到 `.env.local`（或 `.env`）後填入：

### Firebase 前端設定（公開設定，會出現在瀏覽器）

於 Firebase Console → 專案設定 → 你的 Web 應用程式取得：

| 變數 | 說明 |
|------|------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Web API Key |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | 例如 `your-project.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | 專案 ID |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | 選填 | **僅在「學生證件照儲存位置」選 Firebase Storage 時需要**，例如 `your-project.firebasestorage.app`；各 fork 請設定自己的 bucket。預設存 Firestore，留空即可 |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Sender ID |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Web App ID |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | （選填）Google 登入的 Web client ID；設定後已授權者登入不跳彈窗，且須把網站網域加到該 OAuth 用戶端的「已授權的 JavaScript 來源」 |

個人證件照**預設存在 Firestore**（免費 Spark 方案即可用，單張上限 900 KB；上傳前瀏覽器會自動縮圖並移除 EXIF）。
改用 Firebase Storage 時，照片透過 Firebase Admin SDK 寫入上述 bucket，`FIREBASE_SERVICE_ACCOUNT_KEY` 對應的服務帳號需有該 bucket 的物件讀寫與刪除權限（例如 `Storage Object Admin`）；Firebase 預設服務帳號已具專案編輯者權限，通常不需另外設。
照片不設公開存取，各 fork 請使用自己的 Firebase 專案與 bucket。

### 伺服端機密（切勿提交到 Git、切勿加上 `NEXT_PUBLIC_` 前綴）

| 變數 | 必填 | 說明 |
|------|------|------|
| `SESSION_SECRET` | 是 | 簽 session JWT 用，**至少 32 字元**。**唯一要自行產生的欄位**——不來自 Firebase、不來自 Vercel，沒有「去哪裡找」這回事。macOS／Linux：`openssl rand -base64 32`；Windows PowerShell：`[Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')`。⚠️ **不足 32 字元時部署仍會成功、`/setup` 也能建管，但一登入就 500** |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | 是 | Firebase 服務帳號金鑰。Console → 專案設定 → 服務帳號 → 產生新的私鑰；可貼**整段 JSON 字串**或其 **base64** |
| `ALLOW_BOOTSTRAP_ADMIN` | 首次啟動 | 僅在建立「第一個管理員」時設為 `true`，建完請改回 `false` |

### 寄信 SMTP（忘記密碼、Email 驗證碼用）

不填也能登入與使用主要功能，但**「忘記密碼」會直接回 503**、Email 驗證碼信寄不出去。設定步驟（以學校 Google Workspace 專用信箱為例）見 [`.env.example`](.env.example) 內的詳細註解。

| 變數 | 必填 | 說明 |
|------|------|------|
| `SMTP_HOST` | 建議 | SMTP 位址，Gmail 為 `smtp.gmail.com` |
| `SMTP_PORT` | 否 | 預設 `465`（`SMTP_SECURE=true` 時）或 `587` |
| `SMTP_USER` | 建議 | 寄信帳號 |
| `SMTP_PASS` | 建議 | 應用程式密碼（**不可**用一般登入密碼，Google 已停用基本驗證） |
| `SMTP_FROM` | 否 | 寄件者顯示名稱與地址，例：`數位校園工具箱 <noreply@school.edu.tw>` |

### 其他

| 變數 | 必填 | 說明 |
|------|------|------|
| `APP_BASE_URL` | 正式環境建議 | 站台對外網址，用於信件中的重設連結。未設定時改用請求來源，Host 遭偽造可能使連結指向攻擊者網域 |
| `TRUST_PROXY` | 否 | 僅在可信反向代理／平台（如 Vercel，自動 `VERCEL=1`）覆寫 forwarding header 時設 `true`；直接 `next start` 暴露請維持不設 |

### 統計儀表板（`/admin/stats`，僅超級管理員）

不設定也能使用，只是儀表板會改顯示「設定指引」卡而非實際用量。App Hosting（Cloud Run／Cloud Build）與 Firestore 用量皆走 Cloud Monitoring，共用同一個服務帳號，**需具 `roles/monitoring.viewer`**，否則儀表板會顯示授予指令：

```bash
gcloud projects add-iam-policy-binding <專案ID> \
  --member="serviceAccount:<FIREBASE_SERVICE_ACCOUNT_KEY 內的 client_email>" \
  --role="roles/monitoring.viewer"
```

上述指令**不必安裝 gcloud**：在瀏覽器開 [Google Cloud Console](https://console.cloud.google.com/home/dashboard?project=<專案ID>)（不是 Firebase Console）→ 點右上角「**>_**」圖示啟動 **Cloud Shell** → 貼上指令按 Enter 即可。若指令要求選擇條件（`Please specify a condition`），輸入 `2`（＝None，無條件）後按 Enter。

也可在 **Google Cloud Console**（不是 Firebase Console 的服務帳號頁）→ 左側「IAM」→ 找到該服務帳號 → 編輯 → 新增角色 → 搜尋 **Monitoring Viewer**（角色 ID `roles/monitoring.viewer`，位於 Monitoring／Cloud Monitoring 分類；Console 顯示名稱不是「Cloud Monitoring Viewer」）→ 儲存。授予角色需專案 **Owner**。

## Firebase 專案設定

1. **建立專案**：Firebase Console 新增專案（Analytics 可關）。
2. **啟用 Google 登入**：Authentication → Sign-in method → 啟用 **Google**，並**關閉** Email/Password、匿名等其他登入方式（伺服端只接受 `sign_in_provider === "google.com"` 且 `email_verified` 的 token）。
3. **建立 Web 應用程式**：專案設定 → 一般 → 新增 Web 應用，將設定貼入 `.env.local` 的 `NEXT_PUBLIC_*`。
4. **服務帳號金鑰**：專案設定 → 服務帳號 → 產生新的私鑰（下載 JSON），整段貼入 `FIREBASE_SERVICE_ACCOUNT_KEY`（或先 base64 編碼再貼）。
5. **部署 Firestore 規則**：本 repo 的 [`firestore.rules`](firestore.rules) 預設**拒絕所有客戶端讀寫**（資料只走伺服端 Admin SDK），請部署：

   ```bash
   firebase deploy --only firestore:rules
   ```

   ⚠️ 執行前請先確認 `.firebaserc` 的 `default` 已改成**你自己的** Firebase 專案 ID（fork 後仍是原作者的 `campus-toolkit-e77e4`，不改會因無權限而失敗）。也可以不裝 Firebase CLI，直接在 Console → Firestore → 規則 貼上相同內容後發布。

### Firestore 資料結構（9 個集合）

Firestore 是結構自由的，**集合不用預先建立** —— 程式第一次寫入某個集合時，它才會出現。本程式會用到的全部集合：

| 集合 | 用途 | 誰寫第一筆 |
|------|------|-----------|
| `users` | 帳號（電子郵件、密碼雜湊、身分、可開的模組） | `/setup` 建首位管理員 |
| `rosterAdmins` | 管理員名冊 | 同上（同一次請求一起寫） |
| `rosterStudents` | 學生名冊 | 後台 Excel 匯入 |
| `rosterParents` | 家長名冊 | 同上 |
| `rosterStaff` | 教職員名冊 | 同上 |
| `settings`（文件 `system`／`school`／`schoolProfile`／`schoolClasses`／`schoolCodes`／`spaces`） | 系統設定、單位層級、校務基本資料、年段班級設定、各式代碼表、樓層空間設定 | 後台首次存設定；**沒存之前讀程式內建的預設值**（代碼表＝內建官方清單） |
| `activityLog` | 後台操作紀錄 | 第一次後台操作 |
| `revokedJTIs` | 已登出／失效的登入權杖 | 第一次登出或改密碼 |
| `passwordResetTokens` | 忘記密碼的重設權杖 | 第一次使用忘記密碼 |

**空資料庫就是預期狀態**，分身專案不必先補任何資料：

- 每個集合讀到空的都有回退 —— `settings` 回 `defaultSettings`、名冊頁顯示「目前沒有資料」。
- `/setup` 讀空的管理員名冊會判定「可建首任管理員」，**空庫正是它的啟動條件**。
- **索引也不用建** —— `firebase.json` 沒有 indexes 段，所有查詢都是單一欄位排序（Firestore 自動索引），沒有需要手動建立的複合索引。

## 首次啟動（建立管理員）

1. 確認 `.env.local` 已設 `ALLOW_BOOTSTRAP_ADMIN=true`，且 `SESSION_SECRET`、`FIREBASE_SERVICE_ACCOUNT_KEY` 已填。
2. 啟動 `npm run dev`，開啟 **`/setup`**，建立第一個管理員帳號（密碼至少 8 碼）。
3. 成功後登入首頁，再把 `ALLOW_BOOTSTRAP_ADMIN` 改為 `false`（或移除）並重啟，避免資料庫被清空後可免驗證建管。

### 疑難排解：管理員建好了，但一登入就 500

症狀長這樣：

```text
部署成功 → 網站開得出來 → /setup 顯示可建立 → 管理員建立成功 → 按「登入」→ 500 系統錯誤
```

原因：`SESSION_SECRET` **不足 32 字元**（或根本沒設）。它只在「簽登入 cookie」那一刻才被檢查（`src/lib/session-token.ts`），部署與 `/setup` 全程不碰它——所以**前面每步都對，問題只在最後一步爆出來**。這很容易被誤判成 Firebase 設錯或部署壞了。

解法：換一組 **≥32 字元**的 `SESSION_SECRET` → Redeploy。**管理員資料不會掉**（存在 Firestore，與這個金鑰無關），補好後直接登入即可。

### （選用）種子角色資料

專案根目錄執行：

```bash
node scripts/reset-users-roster.mjs
```

會先將 `users`、`rosterStudents`、`rosterParents`、`rosterStaff`、`rosterAdmins` 匯出到 `backups/` 備份，再清空重建並種入測試帳號與範本資料（當期名冊）。此指令**直接連線 Firestore**（需 `FIREBASE_SERVICE_ACCOUNT_KEY`），不會經過 HTTP，因此不提供 API 端點。

## 常用指令

| 指令 | 說明 |
|------|------|
| `npm run dev` | 開發伺服器（版本號直接讀已 commit 的 `src/version.json`，不自動重算） |
| `npm run build` | 生產建置 |
| `npm start` | 執行生產建置 |
| `npm run lint` | ESLint 檢查 + TypeScript 型別檢查（`tsc --noEmit`） |
| `npm run typecheck` | 只跑 TypeScript 型別檢查 |
| `npm run version:bump` | 更新版本號（**僅開發機 commit 前執行**；`dev`/`build` 不會重算） |

## 專案結構

```
campus-toolkit/
├── public/                 # 靜態資源（含 ads.txt）
├── scripts/
│   └── version.js          # 開發機 commit 前更新 version.json（npm run version:bump）
├── src/
│   ├── app/                # App Router 頁面與 API
│   │   ├── api/            # REST API（auth、admin、account、settings、排行榜…）
│   │   ├── admin/          # 管理後台
│   │   ├── student|parent|staff/  # 各角色首頁與帳號頁
│   │   └── setup/          # 首次建立管理員
│   ├── components/         # UI 元件
│   ├── contexts/           # React Context（主題等）
│   ├── data/               # 內建種子資料（群別／科別官方代碼表）
│   ├── lib/                # Firebase、session、驗證、rate limit…
│   ├── styles/             # 全域樣式與主題 CSS 變數
│   ├── types/              # TypeScript 型別
│   └── proxy.ts            # 路由保護（角色頁 Session 檢查）
├── docs/                   # 資料模型與身分名冊／帳號批次範例檔（xlsx）
├── firestore.rules         # Firestore 安全規則（預設全拒絕）
├── next.config.ts          # CSP／安全標頭等
└── .env.example            # 環境變數範本
```

## 部署（Vercel）

兩條路都可以：上方「一鍵部署」按鈕（Vercel 代勞前三項），或手動：

1. Import Git Repo 至 Vercel。
2. 在專案 **Environment Variables** 加入與 `.env.local` 相同的變數（機密變數勿用 `NEXT_PUBLIC_`）。
3. Deploy。Framework 預設 Next.js 即可。
4. **授權網域不會自動加入**：若 Google 登入被擋，請到 Firebase Authentication → 設定 → **授權的網域** 手動加上你的網址（Vercel 的 `*.vercel.app` 與自訂網域都要補）。
5. 若是用按鈕部署：建完首位管理員後，把 `ALLOW_BOOTSTRAP_ADMIN` 改回 `false` 並 Redeploy。

## 安全注意事項

- **漏洞回報請勿開公開 issue**；請依 [`SECURITY.md`](SECURITY.md) 使用 GitHub 私人安全回報。
- **`.env`、`.env.local`、服務帳號 JSON 一律已被 `.gitignore` 排除，請勿強制加入版本庫。**
- 機密只放本機環境變數與 Vercel 環境變數。
- `FIREBASE_SERVICE_ACCOUNT_KEY`、`SESSION_SECRET` 洩漏時請立刻於 Firebase 重產生私鑰並更換 session secret（所有 session 會失效）。
- Firestore 規則維持伺服端全權管理；勿對客戶端開放讀寫，除非你清楚資料面風險。
- 管理員首任建立後務必關閉 `ALLOW_BOOTSTRAP_ADMIN`。

## 關於廣告（AdSense）

全站廣告區預設**關閉**。要開啟或關閉：管理後台 → **系統設定 → 外觀與顯示 → 贊助廣告**（僅超級管理員可改），改完立即生效，不需重新部署。

- **想完全不放廣告**：維持預設「隱藏」即可，AdSense script 根本不會載入。
- **想放自己的廣告**：程式碼中的廣告帳號硬編在 [`src/components/AdSense.tsx`](src/components/AdSense.tsx)（`ca-pub-...` 與版位 `slot`），`public/ads.txt` 也指向同一帳號。請把這兩處改成你自己的 AdSense 帳號與版位，再把開關打開；若未更換就開啟，刊登的是**原作者**的廣告帳號。

## 貢獻與開發流程

**主程式採封閉維護**：只有 takan003 與信任團隊可以開 PR／merge；**不接受外部 PR**。
其他人可以 fork 本 repo 自行維護，或把模組投稿到模組市集。詳見
[`CONTRIBUTING.md`](CONTRIBUTING.md)。

團隊成員的 commit 規範如下（詳見 [`AGENTS.md`](AGENTS.md)）：

1. `npm run lint`（ESLint + tsc）確認通過。
2. `npm run version:bump` — 依 commit 數將版本號 +1，寫入 `src/version.json`（`dev`/`build` 不重算，
   各環境一律讀這份已 commit 的檔案，本機與分支部署的版本號才會一致）。
3. commit，訊息結尾附上版本號，例：`…（版本號更新至 0.232）`。
4. `git push` 並開 PR。

CI（`.github/workflows/ci.yml`）會跑 `npm run lint` 與模組測試；維護者請在 GitHub
**Settings → Branches** 把 `CI / verify` 設為 required status check。完整設定見
[`docs/GitHub設定清單.md`](docs/GitHub設定清單.md)。

## 文件

- [`docs/資料模型.md`](docs/資料模型.md) — 資料模型
- [`docs/`](docs/) — 身分名冊／使用者帳號批次範例檔（xlsx）與版面截圖
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 主程式封閉維護與模組開發入口
- [`SECURITY.md`](SECURITY.md) — 漏洞回報方式與安全邊界
- [`AGENTS.md`](AGENTS.md) — 模組信任模型（B+）、開發流程與 UI 規範
- [`docs/GitHub設定清單.md`](docs/GitHub設定清單.md) — branch protection／required checks 等手動設定
- [module-sdk](https://github.com/takan003/module-sdk) — 模組開發 SDK（`module:check`／影子 tsc）
- [campus-toolkit-marketplace](https://github.com/takan003/campus-toolkit-marketplace) — 模組市集

## 授權

[MIT](LICENSE)
