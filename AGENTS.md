<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 工作環境與流程協議（必讀）

### 專案路徑

| 代號 | 路徑 | 說明 |
|------|------|------|
| **A** | `\campus-toolkit` | A「主程式」 |
| **B** | `\module-sdk` | B「模組 SDK」 |
| **C** | `\campus-toolkit-marketplace` | C「模組市集」 |
| **D** | （暫留，未指定） | D「主題市集」（暫留代號，未納入本 workspace） |
| **E** | `\selfDirectedLearning` | E「選用功能模組」（自主學習計畫） |
| **F** | `\examRegistration` | F「選用功能模組」（升學與模擬考校內報名） |
| **G** | `\identityTaxInquiry` | G「選用功能模組」（註冊身分與財稅查調） |

### 名詞解釋

七支程式**沒有下達指令時，請勿修改與 push**。

| 代號 | 名稱 | 說明 |
|------|------|------|
| **A** | 主程式 | 本機測試用的主程式，用來掛載 E、F、G「選用功能模組」 |
| **B** | 模組 SDK | 由 A 與 E／F／G 衍生的契約工具（manifest schema、靜態檢查、型別快照）；用於撰寫新模組與打包前檢查，**不是規則來源** |
| **C** | 模組市集 | 選用功能模組打包後上架的市集 |
| **D** | 主題市集 | 暫留代號；本 workspace 目前沒有這個專案，相關操作先不執行 |
| **E** | 選用功能模組 | `selfDirectedLearning` 自主學習計畫 |
| **F** | 選用功能模組 | `examRegistration` 升學與模擬考校內報名（已上架維護） |
| **G** | 選用功能模組 | `identityTaxInquiry` 註冊身分與財稅查調 |

E、F、G 又稱「外掛」、「外掛功能」；維護時流程相同，只是對指定的模組專案操作。

**契約權威順序**：A 與 E／F／G 的實際可運作為準；B 是衍生工具，B 與 E／F／G 衝突時修改 B，不是修改 E／F／G。

### 工作指令

**「啟動」指令**，標準配置流程：

1. 將 A、B、E、F、G 的遠端程式 pull 後強制覆蓋本地（C 不 pull，保留本地市集狀態；
   D 為暫留代號，尚未納入 workspace，不執行 pull）。覆蓋前先確認沒有要保留的未提交
   變更；覆蓋後各專案視需要執行 `npm install`。
1. 先停 A 的 dev server，將 E、F、G 逐支以複製＋監聽模式掛載進 A：
   `npm run module:link -- <模組專案路徑> --copy --watch`
   （E14：掛載／解除前必須停 dev server，掛完再啟動）。
1. 啟動 A 的本地伺服器（`npm run dev`）測試；E／F／G 的 `--watch` 程序須常駐，
   才能持續同步。

<details open>
<summary>本機外掛掛載方法（E14 鐵律，掛不上去先看這裡）</summary>

1. 掛載一律用複製＋監聽：`npm run module:link -- <模組專案路徑> --copy --watch`；
   完成後確認 `module.lock.json` 的 `source` 為 `link-copy:`（若為 `link:` 即掛錯）。
   win32 預設 link 是 junction，會被 Turbopack 判為 project root 外的無效 symlink，
   全站 Build Error（`Module not found`＋`Symlink ... is invalid`）——此為 E14，不可用
1. 掛載／解除前先停 dev server：運行中的 dev server 會重生成
   `.next/dev/types/validator.ts` 滯留引用，使驗證鏈的 `npm run lint` 誤判失敗；
   掛完再啟動
1. 已掛載時不可直接重掛（報 `src/modules/<value> 已存在`）：先
   `npm run module:uninstall -- <value>`，再以複製＋監聽模式重掛
1. `--watch` 程序須常駐：改 E／F／G 後 300ms 內整棵同步到 `src/modules/<value>`，
   動到 module.json 自動重跑掃描器；程序消失（如重開機）就重跑掛載指令
1. 驗證：模組 API 路由回 401（未登入）而非 Build Error，dev log 無
   `Module not found`／`is invalid` 即成功

</details>

### module-sdk（B）使用時機

1. **撰寫新模組時**：在 B 執行
   `node bin/module-check.mjs <模組路徑> --host-version <A 的 src/version.json 版本>`，
   做 manifest、import、依賴、集合宣告的早期自檢；manifest 與公開面寫法以 B 的
   `module.schema.json`／`snapshots/` 為參考。
1. **打包模組前**：以 A 的 `npm run module:check -- <模組路徑>` 零 error 為 gate；
   再跑 B 的 `module:check` 作為契約對齊檢查。B 若尚未全綠，列為 B 的待修項，
   **不阻擋 E／F／G 打包**；B 對齊 E／F／G 後才把 B check 升為 gate。
1. B 只負責契約與靜態檢查，**不負責安裝、掛載或啟動**；實際執行與型別最終判定仍在 A。
   B 的 snapshots／allowlist 以 A 與 E／F／G 為生成來源與 golden tests；B 驗不過 E／F／G
   是 B 要修，不是 E／F／G 要改。

**「修改E」／「修改F」／「修改G」指令**，實施流程（對指定模組專案操作）：

1. 只在指定的模組專案中修改，修改後同步到 A 已掛載的模組測試結果。
1. 將該模組專案 push 至遠端。

**「打包」指令**，實施流程（將指定模組上架到 C「模組市集」）：

1. 指定要打包的模組（E／F／G，或未來新模組），確認 `module.json` 的
   `author.version` 與 `changelog[0].version` 一致，`changelog[0].notes` 最多 3 點。
1. 打包前檢查：A 的 `npm run module:check -- <模組路徑>` 零 error 才繼續；
   B 的 `module:check` 同步執行並記錄落差，B 未對齊前不阻擋 E／F／G。
1. 在 C 執行 `npm run publish:push -- <模組專案路徑>`；腳本會把
   `changelog[0].notes` 寫入 C 的 `releaseNotes`、產生只保留最新版的
   `releases/notes.txt`，並 commit＋push C。C 平時不參與「啟動」的 pull，
   打包前請先確認 C 的本地狀態與遠端分支正確。
1. 完成後 push 指定模組專案（E／F／G）本身。
1. **絕不更動或 push 到 A「主程式」**；也不要把本機 A 的掛載產物 push 上去。

**「修改A」指令**，實施流程：

1. 請針對 A「主程式」進行修改。
1. 修改完成後 push A「主程式」，請勿將本機掛載安裝的選用功能模組 push 上去。

### 貢獻者規範（必讀）

1. 未經本人明確允許，**不得在「Contributors」自行新增任何貢獻者**——包含但不限於
   README 的貢獻者名單、`package.json` 的 `contributors` 欄位、GitHub repo 的
   Contributors 設定，以及 commit／PR 中夾帶的相關異動。
2. 唯一例外：`takan003`（本人帳號）可正常出現於上述位置，無需額外確認。
3. 若不確定某個名單／欄位是否算「Contributors」，先詢問本人再動手。

### 線上市集安裝的鐵律（必讀）

線上市集安裝／更新／移除外掛時，**系統會自動 commit + push 到該部署所連結的 GitHub repo**
（production 的持久化機制，讓模組撐過重新部署）。因此：

- **只有連著「各校自己的 fork」的線上站，才可以用線上市集安裝**——裝出來的 commit
  進自己的 fork，正是設計意圖。
- **絕不可對連著上游（takan003/campus-toolkit）的線上站按市集安裝**——模組會被
  commit 進上游，所有 fork 都會被迫附帶（違反「上游＝乾淨模板」的架構）。
- 本機開發一律用 `module:link`（產物已 gitignore，不會進 git），與線上安裝互不相干。
- 誤裝進上游時的補救：`git revert <該 commit>` 後 push 即可，**不需要重建任何 fork 或部署**；
  各校 fork 自行安裝的模組不受影響（同步後 git 會保留他們自己的安裝）。
- production 自動安裝／卸載的 commit 會一併更新 `src/version.json`，commit 前檢查
  lock ↔ 目錄一致性；全量 `npm run lint`（eslint＋tsc）由 CI 執行，部署平台應等待
  required status checks。

### 模組信任模型與上架政策（B+）

1. **主程式 A** 由 takan003／信任團隊維護；外部模組不得直接 push A，也不得把未審核模組裝進 production。
1. **E／F／G** 是官方範例模組，由信任團隊維護；仍須走 A／B 的 `module:check`、lint、版本與 changelog 流程。
1. 第三方模組採**「開放投稿、審核上架」**：任何人都可以在自己的 repo 撰寫，但投稿到 C 後必須通過最低限度安全審核，才可標為「已審核社群」。
1. **兩層信任**：`module.lock.json.source` 以 `market:` 開頭者屬市集模組，受上述審核與安裝檢查約束；`link-copy:`／`copy:`／其他 local 來源屬 fork 主人自用模組，**不受市集規範**，主人自行承擔。手動把資料夾放進 `src/modules` 也屬於 local。
1. 市集狀態固定三種：
   - **官方**：信任團隊維護，可直接使用。
   - **已審核社群**：外部作者，通過掃描＋人審＋簽章綁定，學校可安裝。
   - **實驗**：未審核，只供測試，不建議 production 安裝。
1. **未審核模組不得進入 production（限市集模組）**；若未來要「不審查也能上架」，必須先做 v2 隔離執行，不能直接放寬。local 自用模組不適用此條。
1. **安裝／卸載模組**需 `modules` 權限；屬性分級已退役，預設全體管理員皆可。高風險環境可用 `MODULE_MARKET_INSTALL_ADMINS`（逗號分隔 uid／email）限縮，未設定時不限制。
1. **核心個資集合對模組唯讀**（名冊四表＋學生個人資料三表）；模組自有集合須在 `dataCollections` 宣告，設施集合（公告／行事曆）一律走掛勾函式。v2 以 `scopedDb` 在 runtime 執行；`getAdminDb` 仍為 v1 相容路徑。
1. 目前模組仍是 in-process、具伺服器權限；審查與簽章只降低風險，**不是沙箱**。文件與市集頁必須如實揭露。

<details>
<summary>最低限度審核清單</summary>

1. 是否只 import 公開面？有無 `getAdminDb`／`getAdminAuth` 等越權使用？
1. 是否只存取 manifest 宣告的集合？有無碰 `users`／`settings`／`activityLog`／`revokedJTIs`？
1. 是否有外部網路請求？目的地是否合理、是否會外傳個資？
1. 是否讀取 `process.env`／金鑰／token？
1. API 是否有 auth／CSRF／rate limit／module gate？管理頁是否有 `AdminSectionShell`？
1. 是否有混淆、動態載入、隱藏檔或無法理解的程式碼？
1. 簽章公鑰是否已綁定作者？版本／changelog 是否一致？

</details>

> C 已有 `status`、`keys.json` 作者公鑰信任清單與投稿／審核流程；`reviewed` 會驗證簽章。公鑰輪替／撤銷流程已文件化，後續維護。

## 資料庫讀取規範（必讀）

新增或修改任何 Firestore 讀取的程式碼前，先讀 `docs/資料庫讀取規範.md`
（六條鐵律：先問要不要讀、過濾下推、精準查詢、禁 N+1 與分塊、同請求復用、
快取＋寫後失效）。改完依該文末檢查清單逐項核對，再走下方流程。

## UI 約定

0. **響應式設計＋CSS 主題（必讀）**：此系統適用於電腦、平板、手機等行動裝置，
   瀏覽器視窗寬度差異大。所有頁面與元件一律採用響應式設計
   （Tailwind 斷點：`sm:` 640px／`md:` 768px／`lg:` 1024px／`xl:` 1280px），
   禁止寫死寬度（如 `w-[800px]`）；表格過寬時以外層
   `overflow-x-auto` 橫向捲動處理，不裁切內容。
   並隨時注意 CSS 主題套用機制（詳見 `docs/主程式模組與功能模組.md` §3.5）：
   色彩一律使用語意 token（`bg-card`、`text-t1/t2/t3`、`text-danger`、
   `border-themed`、`btn-theme`／`btn-danger` 等），
   **禁止寫死色票**（如 `bg-white`、`text-gray-500`、`#333`）、
   **禁止模組自帶 CSS 檔**、CSS 變數取用**不得加 fallback**
   （宿主保證 token 必有值，fallback 會掩蓋缺漏）。
1. **跳出訊息一律用主題化 modal**：禁止使用 `window.confirm`／`window.alert`／
   `window.prompt`。確認、成功、錯誤訊息一律以 `role="dialog"`／`role="alertdialog"`
   ＋`aria-modal="true"` 的 React modal 呈現，樣式套用目前 CSS 主題
   （`bg-card`、`text-t1/t2/t3`、`text-danger`、`border-themed`、`btn-theme`／`btn-danger`）。
   參考實作：`src/app/admin/accounts/page.tsx`（確認／刪除確認／成功／部分完成 modal）、
   `src/components/SchoolClassesEditor.tsx`（成功／錯誤 modal）。
2. **省流模式的「顯示列表」按鈕須附有效資料總數**：凡以 `RevealListCard`（或同等
   省流閘門）取代列表的頁面，必須先以 count 聚合端點取得總數，並透過 `summary`
   prop 顯示（如「目前發布中 N 筆」），不得只放一個無資訊的按鈕。
   參考實作：`src/app/admin/announcements/page.tsx`（`/api/admin/announcements/count`）、
   `src/app/admin/calendar/page.tsx`、`src/app/admin/roster/page.tsx`。
3. **清單分頁規則**：
   - **無班級前提**的清單／列表（如公告、行事曆、場次）：提供常用分頁功能
     （每頁筆數下拉＋頁碼導覽）。
   - **有班級前提**的清單／列表（如名冊、帳號）：預設以「班級」為分頁單位
     （依班級代碼分組切頁），使用者仍可切換為其他分頁方式。
4. **收合／展開一律用 SVG 箭頭，不用按鈕**：所有「收合／展開」控制
   （卡片、清單、表單、說明面板等）一律以原生 `<details>`／`<summary>`
   實作，圖示統一使用共用元件 `src/components/DisclosureArrow.tsx`
   （展開時箭頭自動旋轉）。**禁止**再以 `<button>` 搭配「收合／展開」文字
   或 ▲／▼ 字元切換；`aria-expanded` 由 `<details>` 自帶，必要時以
   `aria-controls` 指向內容區 id。
5. **儲存結果訊息一律用 Toast 浮動訊息**：儲存成功／失敗的反饋統一使用
   `src/components/Toast.tsx` 元件，禁止使用全螢幕遮罩 modal 或 inline alert。
   - 引入方式：`import Toast, { type ToastMessage } from "@/components/Toast";`
   - State 定義：`const [toast, setToast] = useState<ToastMessage | null>(null);`
   - JSX 使用：`<Toast message={toast} onClose={() => setToast(null)} />`
   - 觸發方式：`setToast({ kind: "success", text: "已儲存" })` 或
     `setToast({ kind: "error", text: "儲存失敗" })`
   - Toast 元件會在 2 秒後自動消失，樣式使用 CSS 主題配色
     （`--success` 綠底、`--danger` 紅底白字）。
   - 儲存中的過場動畫（BlockingMask）保留不移除，僅移除儲存結果的過場動畫。
   - **不適用於選用功能模組**（如 `examRegistration`（F）使用自己的 FlashModal）。

## 說明文字格式（必讀）

本檔與 `docs/*.md` 內的**說明**（操作步驟、規範條列、注意事項、背景解說）一律遵守下列兩條：

1. 條列一律自動編號，超過一行時第二行起縮排
   - 有序說明的每個項目都寫 `1.`，由渲染器自動編號，改內容時不必重排號碼；
   - 同一項超過一行時，第二行起縮排 3 個空格，與第一行文字左緣對齊，不可頂格貼齊編號。

2. 說明分列超過 3 點時改為收合／展開
   - 1–3 點：直接列出，不收合；
   - 4–5 點：包 `<details>` 並加 `open`，**預設展開**；
   - 6 點以上：包 `<details>` 不加 `open`，**預設收合**。
   - `<summary>` 寫該說明的短標題，其後空一行再接條列（Markdown 才解析得到）；
     收合區內的條列仍依第 1 條自動編號與縮排。

## 修改完成後的流程

1. `npm run lint`（eslint + tsc）確認通過
2. `npm run version:bump`（即 `node scripts/version.js`：依 commit 數 +1 寫入 `src/version.json`；
   `dev`/`build` **不**重算，版本號一律以已 commit 的檔案為準，各部署環境顯示才會一致）
3. commit（訊息結尾附「版本號更新至 0.xxx」）
4. `git push`
