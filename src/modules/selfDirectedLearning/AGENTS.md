# 自主學習計畫模組（C）工作規範

## 專案定位

1. **C「選用功能模組」**：`selfDirectedLearning`（自主學習計畫），本專案位於 `\selfDirectedLearning`。
1. **A「主程式」**：`\campus-toolkit`，C 以模組方式掛載到 A 測試；A 的變更與版控不屬於本專案。
1. 沒有下達指令時，請勿修改或 push 任何專案；測試掛載、dev server 與 lint 等操作在主程式 A 執行，依 A 的 `AGENTS.md`。

## 工作指令

1. **「修改C」**：只在 C 修改；透過 A 已掛載的模組驗證結果，完成後 push C。
1. **「打包C」**：依指示打包並上架 B「模組市集」，完成後 push；**絕不更動或 push A**。

## 貢獻者規範（必讀）

1. 未經本人明確允許，**不得在「Contributors」自行新增任何貢獻者**——包含但不限於
   README 的貢獻者名單、`package.json` 的 `contributors` 欄位、GitHub repo 的
   Contributors 設定，以及 commit／PR 中夾帶的相關異動。
2. 唯一例外：`takan003`（本人帳號）可正常出現於上述位置，無需額外確認。
3. 若不確定某個名單／欄位是否算「Contributors」，先詢問本人再動手。

## 資料庫讀取規範（必讀）

新增或修改任何 Firestore 讀取的程式碼前，先讀主程式 `campus-toolkit/docs/資料庫讀取規範.md`
（六條鐵律：先問要不要讀、過濾下推、精準查詢、禁 N+1 與分塊、同請求復用、
快取＋寫後失效）。改完依該文末檢查清單逐項核對，再走下方流程。

## UI 約定

0. **響應式設計＋CSS 主題（必讀）**：此系統適用於電腦、平板、手機等行動裝置，
   瀏覽器視窗寬度差異大。所有頁面與元件一律採用響應式設計
   （Tailwind 斷點：`sm:` 640px／`md:` 768px／`lg:` 1024px／`xl:` 1280px），
   禁止寫死寬度（如 `w-[800px]`）；表格過寬時以外層
   `overflow-x-auto` 橫向捲動處理，不裁切內容。
   並隨時注意 CSS 主題套用機制（主程式 `docs/主程式模組與功能模組.md` §3.5）：
   色彩一律使用語意 token（`bg-card`、`text-t1/t2/t3`、`text-danger`、
   `border-themed`、`btn-theme`／`btn-danger` 等），
   **禁止寫死色票**（如 `bg-white`、`text-gray-500`、`#333`）、
   **禁止模組自帶 CSS 檔**、CSS 變數取用**不得加 fallback**
   （宿主保證 token 必有值，fallback 會掩蓋缺漏）。
1. **跳出訊息一律用主題化 modal**：禁止使用 `window.confirm`／`window.alert`／
   `window.prompt`。確認、成功、錯誤訊息一律以 `role="dialog"`／`role="alertdialog"`
   ＋`aria-modal="true"` 的 React modal 呈現，樣式套用目前 CSS 主題
   （`bg-card`、`text-t1/t2/t3`、`text-danger`、`border-themed`、`btn-theme`／`btn-danger`）。
   參考實作（主程式）：`src/app/admin/accounts/page.tsx`（確認／刪除確認／成功／部分完成 modal）、
   `src/components/SchoolClassesEditor.tsx`（成功／錯誤 modal）。
2. **省流模式的「顯示列表」按鈕須附有效資料總數**：凡以 `RevealListCard`（或同等
   省流閘門）取代列表的頁面，必須先以 count 聚合端點取得總數，並透過 `summary`
   prop 顯示（如「目前發布中 N 筆」），不得只放一個無資訊的按鈕。
   參考實作（主程式）：`src/app/admin/announcements/page.tsx`（`/api/admin/announcements/count`）、
   `src/app/admin/calendar/page.tsx`、`src/app/admin/roster/page.tsx`。
3. **清單分頁規則**：
   - **無班級前提**的清單／列表（如公告、行事曆、場次）：提供常用分頁功能
     （每頁筆數下拉＋頁碼導覽）。
   - **有班級前提**的清單／列表（如名冊、帳號）：預設以「班級」為分頁單位
     （依班級代碼分組切頁），使用者仍可切換為其他分頁方式。
4. **收合／展開一律用 SVG 箭頭，不用按鈕**：所有「收合／展開」控制
   （卡片、清單、表單、說明面板等）一律以原生 `<details>`／`<summary>`
   實作，圖示統一使用主程式共用元件 `@/components/DisclosureArrow`
   （展開時箭頭自動旋轉）。**禁止**再以 `<button>` 搭配「收合／展開」文字
   或 ▲／▼ 字元切換；`aria-expanded` 由 `<details>` 自帶，必要時以
   `aria-controls` 指向內容區 id。
5. **儲存結果訊息一律用 Toast 浮動訊息**：儲存成功／失敗的反饋統一使用主程式
   `@/components/Toast` 元件，禁止使用全螢幕遮罩 modal 或 inline alert。
   - 引入方式：`import Toast, { type ToastMessage } from "@/components/Toast";`
   - State 定義：`const [toast, setToast] = useState<ToastMessage | null>(null);`
   - JSX 使用：`<Toast message={toast} onClose={() => setToast(null)} />`
   - 觸發方式：`setToast({ kind: "success", text: "已儲存" })` 或
     `setToast({ kind: "error", text: "儲存失敗" })`
   - Toast 元件會在 2 秒後自動消失，樣式使用 CSS 主題配色
     （`--success` 綠底、`--danger` 紅底白字）。
   - 儲存中的過場動畫（BlockingMask）保留不移除，僅移除儲存結果的過場動畫。
   - 其他模組（如 D）若使用自己的 FlashModal，不在此限。

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

1. 在 A 執行 `npm run lint`（eslint + tsc）確認通過（C 沒有自己的 npm 指令）。
1. 功能或修正完成時，更新 `module.json` 的 `author.version`／`releasedAt` 與 `changelog`。
1. commit（訊息結尾附「版本號更新至 0.0.xx」）。
1. `git push`（C 的 `master`）。
