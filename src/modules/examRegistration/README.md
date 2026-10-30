# 升學考試與模擬考校內報名模組（examRegistration）

> 狀態：M1 完成（期 7 驗收通過）；M2 ②CSV③統計已實作（①名額上限已廢止，v0.1.43），⑤公告撤回卡宿主 P5；M3（報名義務/不報名/繳費/封存）已實作
> 宿主要求：`campus-toolkit` ≥ 0.488（官方報名檔會讀取主程式的學生固定身分資料）

## 定位

校內升學考試與模擬考的**選考科目登錄**：承辦教職員建立報名場次與科目清單、指定對象（年級＋班級），
學生在開放期間勾選要考的科目（可改、可取消，截止後唯讀）；承辦查看每科人數與名單。
報名流程採**單一一般報名**模式（不區分先到先得／審核錄取）。
費用欄位僅作資訊顯示；公告撤回／更新待宿主 P5。

## 功能一覽

1. **學生端**：開放期間勾選選考科目（可改、可取消，截止後唯讀並可下載 PDF）；支援必／選報與不報名原因、繳費身分與費用試算、考試地點、應考服務與自行封存；場次依報名起訖自動顯示未開放／開放／已截止。
1. **教職員與家長**：兼導師唯讀檢視本班各場次完成狀態與名單；家長唯讀查看名冊綁定子女的報名資料。
1. **管理端**：建立場次與科目、指定年級班級、設定考試日期與報名起訖；名單統計、班級區間匯出、官方報名資料檔（學測、分科測驗、英聽、術科與通用格式）；可同步公告與行事曆，並依權限解除封存、刪除登錄或硬刪除場次。

## MVP（M1）範圍

| 頁面/API | 路徑 | 誰可用 |
|---|---|---|
| 學生頁 | `/student/exam-registration` | 學生 |
| 教職員頁 | `/staff/exam-registration` | 當期屬性為「兼導師」且有班級代碼者；必須報名列全班完成狀態、自由報名列已報名學生；適用場次即使無人報名仍顯示，每場卡片預設收合，顯示報名期間並依截止時間排序 |
| 管理頁 | `/admin/exam-registration` | 具 `examRegistration` 權限單位者 |
| API | `/api/exam-registration` | 學生（GET 場次＋我的登錄、POST 登錄、DELETE 取消） |
| API | `/api/staff/exam-registration` | 教職員兼導師（僅當期本人班級，唯讀；`?summary=counts` 取各場 count、`?includeStudents=1&eventId=` 延遲載入單場名單） |
| API | `/api/admin/exam-registration` | 管理員（POST 建立、PATCH 編輯/狀態、GET 名單 `?eventId=`、GET CSV `?eventId=&format=csv`） |

**場次狀態機**：`draft → open → closed → archived`（唯一狀態機；登錄文件有＝已登錄，取消＝刪除）

**四個已拍板決策**：
1. 登錄＝勾選科目（非場次名額審核）
2. 對象指定到**年級＋班級**（伺服端強制過濾）
3. 家長不開放（`provides.parent = false`）
4. 費用僅作資訊顯示

## Firestore 資料模型

`examEvents`（場次，科目內嵌）：
- `title` / `examType`（mock|entrance|other）/ `examDate`（**YYYY-MM-DD 字串**，日期僅日、不涉時區）/ `location` / `note`
- 畫面日期統一顯示為 **`yyyy/mm/dd`**；日期時間顯示為 **`yyyy/mm/dd HH:mm`**（24 小時制），Firestore/API 維持 ISO 日期格式。
- `deadline`：timestamp（之後唯讀；`open` 且過期一律收斂為 `closed`，承辦忘記關也不會誤放行）
- `subjects`：`[{ key, label }]` 內嵌陣列（1～15 項；`key` 在改名／排序時保留，登錄鍵才不失效）；舊資料的 `capacity` 欄位已廢止、一律忽略
- `target`：`{ grades: string[], classes: string[] }`（年級必填、班級選填——兩者都要）
- `fee`：number
- `examMode`：固定 `review`（系統內部保留欄位，前台不再區分報名子模式）
- `status`：`draft|open|closed|archived`（`draft→open⇄closed→archived`，`archived` 不可逆；一般情況以歸檔代替刪除，**無登錄的場次可硬刪除**）
- `createdBy` / `createdAt` / `updatedAt`

`examRegistrations`（選考登錄，一人一場次一份）：
- **文件 id ＝ `eventId__studentUid`（決定論）**——唯一性由文件 id 直接保證，不需額外查重
- `eventId` / `studentUid` / `studentName` / `studentClass` / `studentGrade` / `studentId` / `seatNo`（寫入時去正規化；學號座號供 CSV 造冊）
- `subjectKeys`：`string[]`（科目被刪除時，舊鍵自動失效）
- `reviewStatus`：保留欄位（歷史資料相容）
- `createdAt` / `updatedAt`

**索引**：`examEvents: status(in)+examDate`、`examEvents: examDate DESC`（管理清單）；
`examRegistrations: eventId+studentUid`（決定論 id）、`studentUid`（我的登錄）——等值查詢不需複合索引。
**未來**若加 `where(status==)+orderBy(examDate)` 類組合查詢，記得在 manifest 補 `firestoreIndexes` 宣告（驗收觀察項）。

**快取與失效**：學生場次清單 `cachedRead` 30 秒（前綴 `exam-registration:`，寫後 `invalidateReadCache`
前綴清除、不 bump epoch）；管理清單 `cachedListRead`（管理端場次增修刪 bump `cacheEpoch` 跨實例失效）。
**管理端名單／統計（roster/tabs/class）快取 TTL 30 秒**：學生寫入（登錄／取消／封存）只清本程序
模組前綴（`exam-registration:`＋`admin:exam-registration:roster:`）、**不 bump epoch**（鐵律 6——
高頻報名不得打爆全站清單快取）；同實例立即失效、跨實例延遲上限 30 秒。export（CSV/xlsx）一律即時查詢不吃快取。

**伺服端把關**：對象過濾（年級/班級）→ 截止鎖（deadline/status）→ 決定論 id upsert/刪除 →
寫後快取失效 → 全部寫操作 `logActivity` 稽核。掛勾（發公告／寫行事曆）在場次 `open` 時觸發，
失敗僅記 log、不影響儲存。

## 權限與掛勾

- 權限單位：`mode:"new"`、`category:"校務資料"`；管理頁/API 走 `requireModulePermission("examRegistration", <子權限>)`
  （主程式 0.558+；管理員恆全權，非管理員由管理員於功能模組管理頁按學期指派）
- 子權限（`managerPermissions`）：`viewRoster`（查看場次與名冊）／`configure`（建立編輯刪除場次）／
  `approve`（審核報名：解除封存、刪除登錄）／`export`（匯出名單）
- 限流：`EXAM_REGISTRATION_LIST`（120/分鐘）、`EXAM_REGISTRATION_MUTATE`（20/分鐘）、`EXAM_REGISTRATION_ADMIN`（60/分鐘）、`EXAM_REGISTRATION_STAFF`（60/分鐘）
- 稽核：`exam_registration_event_created`／`event_updated`／`recorded`／`withdrawn`／`archived`／`unarchived`
- **回寫主程式（掛勾）**：`hooks: ["announcements", "calendar"]`——每場次可分別啟用公告與行事曆同步；
  管理規則可設定公告分類／自訂內容，以及行事曆發佈單位／地點／類型。場次開放時經
  `publishFromModule()` 發系統公告（轉為開放時發送，維持開放編輯不重發）、經 `publishScheduleFromModule()` 把考試日寫進行事曆（upsert）。
  公告內容留空時自動帶入場次資訊；舊場次未保存同步設定時沿用既有自動發佈行為。
  **禁止**直接寫 announcements／collections 平行集合；公告的跨模組撤回介面尚未提供（主程式 P5 候選），
  M1 先只發佈、不撤回。

## M2 實作狀態

### ① 每科名額上限 — 已廢止（v0.1.43）

- 名額上限（capacity）機制早已停止使用，v0.1.43 起完整移除：學生端不再顯示 n/m、不再有額滿鎖定與 409 拒絕，管理表單無名額欄位；舊資料的 `capacity` 欄位一律忽略不讀。
- 附帶移除 0.1.42 的 `examEventCounters` 計數器——各科人數聚合隨之廢除，學生端 GET 不再有任何人數讀取。

### ② 造冊 CSV 匯出 — 已實作

- 管理 API `GET /api/admin/exam-registration?eventId=&format=csv` 保留；管理端「查看名單」專頁改由「資料整理」卡片操作：起訖班級＋名單類型（`請選擇報表`／`全部情形名單`／`完成報名名單`／`未完成報名名單`）＋學校升學代碼輸入＋「報名資料檔」按鈕（待實作）。
- 名單類型選單 onChange 即下載 xlsx：`GET ...&format=xlsx&scope=all|registered|pending&from=班級&to=班級`。全部情形＝班級區間內全部應對象學生（含未報名，狀態「未完成報名」）；完成報名＝`optOut=false`；未完成報名＝無登錄或勾選不報名。班級區間以 zh-Hant 數值序含端點。
- 欄位：班級、學號、座號、姓名、選考科目名稱、登錄時間；依 `班級→座號→姓名` 排序。
- 檔頭含 BOM（Excel 直開中文不亂碼）；`Content-Disposition` 用 RFC 5987 UTF-8 檔名；限流沿用 `EXAM_REGISTRATION_ADMIN`。

### ③ 統計資訊 — 已實作

- 場次清單中的統計面板顯示應報名人數（符合目標對象）與完成報名人數。
- 場次清單中的選考科目僅顯示每科報名數字（`n 人`），採表格格線呈現。
- 學生名單改為「查看名單」專頁顯示，並以班級分頁切換。
- 資料用名單 API 的 `summary.bySubject`（含各科人數），不加查詢。

### ④ 報名模式收斂（單一一般報名）— 已實作

- `examEvents.examMode` 固定為 `review`（內部保留欄位），前台僅提供單一一般報名流程。
- 已移除「先到先得 / 審核錄取」切換與相關審核操作入口。

### ⑤ 公告撤回／更新 — 卡宿主 P5

- 等主程式 P5 `publishFromModule` 撤回/更新介面落地後串：
  場次改期→更新公告；`archived`→撤回公告；行事曆同理（`publishScheduleFromModule` 已 upsert，撤回待宿主）。
- 契約先記：目前 `syncExamEventHooks` 只發佈不回頭，M2 前不得繞過掛鉤直寫。

### 場次硬刪除（M2 後補，應需求新增；M3.5 微調連動名單）

- `DELETE /api/admin/exam-registration?id=`：硬刪除場次**連同該場次全部登錄名單一併刪除**（對齊 GAS `deletePipeAndSheet`——刪管道連同名單工作表；分批 400 筆）。
- 稽核 `exam_registration_event_deleted`（details 含連動刪除筆數）；UI 確認框提醒：曾開放的場次，公告與行事曆**不會**自動撤回（P5 前手動封存）。

### 場次清單省流與分頁（M3.5 微調）

- 省流閘門修正：`useDataSaver().ready` 判定前**不得**載入清單（省流模式下白打一發請求），與公告／帳號清單一致；關鍵字搜尋為「省流閘門外」——輸入即載入清單再本機過濾（同公告／行事曆）。
- 標準分頁：純前端切片（每頁 10/20/50/100，預設 20），第一頁／上一頁／頁次／下一頁／最後一頁；篩選條件變動回第一頁；不增加 Firestore 讀取。

## M3 實作狀態

### 報名義務（required／optional）— 已實作

- `examEvents.registrationMode: "required" | "optional"`（缺省 `optional`，舊資料相容）；管理表單「報名義務」選單。
- `required`：學生頁警示條「本場次為**必須報名**，不參加請勾選不報名並說明原因」。
- `optional`：勾不報名一律 400「自由報名場次不需勾選不報名——不登錄即可」。

### 不報名登錄（optOut）— 已實作

- 登錄文件 `optOut: boolean`（缺省 false）＋`optOutReason: string`（上限 200 字，必填）。
- `optOut=true` 為合法狀態：不算已報名、不計費用；名單「報名情形」欄顯示「不報名」。
- `bySubject` 統計一律排除 optOut。
- 稽核 `details` 含 `optOut`/`optOutReason`。

### 繳費身分與費用試算 — 已實作

- 場次 `basicFee: { standard, reduced }`（取代 M1 的 flat `fee`，舊資料回退 `{standard: fee, reduced: 0}`）。
- 科目 `feeStandard`/`feeReduced`（缺省 0）。
- 登錄文件 `feeCode: "1" | "2" | "3"`、`feeAmount: number`（試算快照，封存後不隨費率變動）。
- 費率規則：`1` 一般生＝基本費 standard＋科目 feeStandard；`2` 低收入戶＝免繳 0；`3` 中低收入戶＝基本費 reduced＋科目 feeReduced。
- 學生頁繳費身分 radio（顯示順序 1、3、2）＋動態應繳費用預覽。
- 名單/CSV 顯示繳費身分與應繳費用。

### 資料封存（archived）— 已實作

- 登錄文件 `archived: boolean`（缺省 false）＋`archivedAt: number`。
- 承辦建立場次時可在「管理規則」勾選啟用學生自行封存（新場次預設關閉；舊場次未保存設定時延續原有開放行為）。
- 學生自我封存 `PATCH /api/exam-registration { eventId }`（冪等；稽核 `exam_registration_archived`）。
- 封存後 upsert／withdraw 一律 409「資料已封存，無法修改/取消——請聯繫承辦解除封存」。
- 承辦解除 `PATCH /api/admin/exam-registration { id, registrationId, unarchive: true }`（稽核 `exam_registration_unarchived`）。
- 名單/CSV「資料封存」欄；名單統計列新增已封存數。

### 列印版面（另存 PDF）— 已實作

- 學生頁「下載為PDF」→ `RegistrationPrintSheet`（`hidden print:block`＋`print:hidden` 包螢幕 UI）＋`window.print()`，由瀏覽器另存 PDF——不引函式庫（【E10】）。
- 列印版面以 `afterprint` 事件卸載（＋2 分鐘兜底）——手機列印為非同步，`print()` 後立即卸版面會印成空白。
- 未封存**且場次開放學生自行封存**時才先 ConfirmModal 提醒；承辦關閉自行封存時直接列印（學生無封存鈕可按，提醒反造成困擾）。

### 稽核動作（7 個）

`exam_registration_event_created` / `event_updated` / `event_deleted` / `recorded` / `withdrawn` / `archived` / `unarchived`

### M3 實測結果（2026-10-11）

| # | 動作 | 預期 | 結果 |
|---|---|---|---|
| 1 | 建 required 場次（basicFee 30/15＋科目費 100/50、150/75） | 建立成功、`registrationMode=required` | ✅ |
| 2 | 學生 GET | 場次可見、新欄位齊全；舊場次向後相容 | ✅ |
| 3 | optOut＋原因 | 成功、feeAmount=0 | ✅ |
| 4 | optOut 無原因 | 400「勾選不報名時，請說明原因」 | ✅ |
| 5 | feeCode=1（國文+數學） | feeAmount=280（30+100+150） | ✅ |
| 6 | feeCode=3 | feeAmount=140（15+50+75） | ✅ |
| 7 | feeCode=2 | feeAmount=0 | ✅ |
| 8 | 學生封存 | archived=true | ✅ |
| 9 | 封存後 upsert | 409「資料已封存…」 | ✅ |
| 10 | 封存後 withdraw | 409 | ✅ |
| 11 | 重複封存 | 幂等 no-op success | ✅ |
| 12 | 承辦解除封存 | archived=false；其後 upsert 正常 | ✅ |
| 13 | optional 場次 optOut | 400「自由報名場次不需勾選不報名…」 | ✅ |
| 14 | 名單統計 | 應報名/完成報名與各科人數統計正確 | ✅ |
| 15 | CSV | 11 欄含報名情形/不報名原因/繳費身分/應繳費用/資料封存 | ✅ |
| 16 | 測試資料清理 | withdraw→硬刪場次；preferredRole 還原 | ✅ |

### 待拍板（已依設計稿預設實作，調整處）

| # | 問題 | 目前實作 |
|---|---|---|
| 1 | 名額上限要「每科」還是「場次總額」？ | 已廢止（v0.1.43），不再適用 |
| 2 | 額滿時是否保留「候補佇列」？ | 已廢止（v0.1.43），不再適用 |
| 3 | 高峰期是否需要更細的名單篩選（例如班級／是否封存）？ | 目前先用關鍵字搜尋 |
| 4 | CSV 要不要含家長聯絡資料？ | 不含（M1 名冊未存，需另接，另立需求） |
| 5 | CSV 要不要額外加註進階選項代碼？ | 目前輸出顯示名稱（不含代碼） |

## M3.6 實作狀態（三項精緻化，2026-10-11）

### 考試日期起訖 — 已實作

- `examEvents.examEndDate: string`（YYYY-MM-DD；`""`＝單日，舊資料相容）；管理表單「考試日期」起日＋訖日（訖日 min=起日，留空＝單日）。
- `formatExamDateRange()`：單日原樣、多日 `起 ~ 訖`（對齊 GAS `renderPipeInfo` 考程顯示）；學生卡片、清單、名單、列印表、公告描述一律改用。
- 行事曆宿主全天事件僅支援單日：多日以**起日**入曆（已知限制），描述內帶區間。

### 報名開放時間起訖 — 已實作

- `examEvents.registrationOpenAt: number`（epoch ms；`0`＝轉開放即可報，舊資料相容）＋既有 `deadline`（關閉）。
- `effectiveExamStatus` 三態（對齊 GAS `_checkTimeWindow`）：`upcoming`（未到開放）／`open`／`closed`（已過截止）；`StudentExamEvent.status` 收斂為 `"upcoming" | "open" | "closed"`。
- 學生端 upcoming：唯讀（表單停用、無送出鈕）、徽章顯示「MM/DD HH:mm 開放」；伺服端 upsert 同步 409「報名尚未開放」（即使承辦未轉狀態也不誤放行）。
- 驗證：`registrationOpenAt < deadline`（表單與 `parseExamEventDraft` 雙層）；管理表單「報名開放」datetime-local（留空＝轉開放即可報）；清單「報名期間」欄顯示起訖。

### 考試地點選項（僅升學考試）— 已實作

- `examEvents.locationOptions: ExamLocationOption[]`（`{ code, label, isDefault? }`；**無數量上限**，code ≤20 唯一、label ≤40；對齊 GAS 管道「試場」欄 `代碼,名稱[,預設]`）。
- 僅 `examType="entrance"` 顯示管理器；`mock`/`other` 伺服端 `parseExamEventDraft` 強制 `locationOptions=[]`。
- 管理表單提供 **單筆新增**（代碼＋名稱）與 **批次新增**（每行 `代碼,考區名稱`）兩種建置方式，會合併到同一份清單並檢查重複代碼；可在清單中指定任一筆為「預設」並用上下箭頭調整順序。
- `isDefault`：最多一項（多標保留第一、其餘清除）；未標＝第一項為預設。
- 登錄 `locationCode: string`：學生單選下拉（預設項自動選中）；場次有選項時必選（空值取預設項；無對應 400）；optOut 恆空。無選項＝不出下拉、顯示「試場由主辦單位分配」。
- 展示一律反查名稱：名單新增「試場」欄（有選項才出現）、CSV 輸出**名稱非代碼**、列印表與封存摘要、公告描述、行事曆地點（取預設項名稱）。

### 科目進階選項（管理端）— 已實作

- `examEvents.subjects[].enableAdvancedOption?: boolean`：管理表單在「科目名稱」與「一般生」之間新增 checkbox 欄位「進階選項」。
- `examEvents.subjects[].advancedOptions?: ExamAdvancedOption[]`（`{ code, label }`；code ≤20 唯一、label ≤40），**每一科各自維護自己的進階選項**。
- 管理表單提供每科專屬的 **單筆新增**（代碼＋名稱）與 **批次新增**（每行 `代碼,進階選項`）兩種建置方式，重複代碼會擋下。
- 當某一科勾選「進階選項」時，該科儲存前必須至少新增 1 筆進階選項（前後端雙層驗證）。
- 學生端以「科目名稱」清單呈現：第一個固定選項為空值 `不報考`；若該科有進階選項，後續列出各進階選項；若無進階選項，維持 `報考` checkbox。

### 備註自動編號（管理表單）— 已實作

- 場次「備註（選填）」支援多行輸入：按 Enter 斷行後，儲存時會自動整理為 `1. ...`、`2. ...`、`3. ...` 編號格式（空行會略過）。

### 省流模式條目數提示（管理表單）— 已實作

- 場次清單在省流模式未展開時，會先顯示目前場次總筆數（輕量 `summary=count` 查詢），避免看不到清單時無法判斷是否已有資料。
- 場次清單統計顯示樣式已對齊行事曆（顯示在省流提示區塊中、位於「顯示場次列表」按鈕上方）。

### 場次清單版型整理（管理表單）— 已實作

- 「場次」欄僅顯示場次名稱；「重要日期」欄整併為「考試日期」與「報名日期」兩行（有起訖時上下兩行，單日僅顯示一行）；「操作」欄以每行兩按鈕並列，按鈕文字縮小顯示。

### 學生頁版型對齊（帳號、身分與安全管理）— 已實作

- 學生端報名頁改為與「帳號、身分與安全管理」一致的版型骨架：系統標題區、頁首/頁尾返回與登出按鈕、底部廣告區（`sponsorAdEnabled`）與版權區（`copyrightNotice`）。
- 學生端場次卡片的「必須報名」徽章改用 danger 套色（`text-danger` / `border-danger`），與一般「自由報名」視覺明確區隔。
- 報名卡片移除冗長說明；「考試地點／繳費身分／選考科目」改為左右兩欄（左標題、右操作內容）版型。
- 「考試日期」「報名期間」在起訖皆有值時改為上下兩行；新增「應考服務」欄位（非冷氣試場勾選＋特殊需求文字）。

### CSV 欄位（11 → 12）

`班級,學號,座號,姓名,報名情形,選考科目,不報名原因,繳費身分,應繳費用,考試地點,資料封存,登錄時間`（「考試地點」在應繳費用後；無選項或 optOut 為空）。

### 學科能力測驗官方報名資料檔

「報名資料檔」依官方表頭匯出 `報名序號,身分證,考試地區,國文,英文,數學A,數學B,社會,自然,特殊應考需求`：

- 報名序號＝學校升學代碼＋所選學生名冊欄位（預設班號）；舊登錄沒有班號時以班級代碼＋座號補組。
- 身分證取學生固定個人資料；舊格式資料會沿用主程式相容讀法。仍缺證號的已報名學生預設阻止匯出並列出班級與姓名；勾選「忽略身分證」可照常匯出。匯出的列一律缺證號者置頂、其餘按報名序號由小到大排序。
- 考試地區輸出學生所選地點代碼；選考科目輸出 `1`／`0`，數學進階選項可對應數學 A／B；特殊應考需求合併非冷氣試場與學生填寫的需求文字。
- 官方檔只匯出完成報名者；起訖班級仍作為匯出範圍。校內報表的名單類型匯出維持原格式。

## M1 驗收指引（期 7 輕量驗收）

### 前置與啟用

```bash
git clone https://github.com/takan003/examRegistration.git
git clone https://github.com/takan003/campus-toolkit.git && cd campus-toolkit && npm install
npm run module:link -- ../examRegistration --copy   # win32 一律 --copy（E14）
npm run dev
```

1. `/admin/modules` → 找到「升學考試與模擬考校內報名」→ **開總開關**（預設未啟用 fail-safe；入口卡與首頁卡片隨之出現）。
2. 權限：名冊 `attribute＝超級` 自動全開；其他身分需名冊條目 `modules` 含 `examRegistration`（無權限＝頁面 403、API 403「權限不足」）。
3. 測試帳號 `takan003@gms.hlgs.hlc.edu.tw`／`111zzzZZZ`（四身分，超級）。**其名冊＝3 年 301**——建場次時對象年級選 3、班級填 301，學生端才看得到。
4. 教職員首頁顯示模組卡；兼導師且當期有班級代碼時，只能檢視該班目前開放且已有登錄的場次。一般管理者仍由被指派的管理模組入口管理全校資料。

### 劇本（每步的預期）

| # | 動作 | 預期 |
|---|---|---|
| 1 | 管理頁建場次（科目 ≥2、對象 3／301） | 存為**草稿**；稽核 `event_created`；**不**發公告/行事曆 |
| 2 | 狀態「開放報名」 | 公告**恰 1 則**（【報名開放】…）、行事曆**恰 1 筆**（考試日，allDay）；再按一次開放**不會**再發 |
| 3 | 學生頁勾 2 科送出 | 顯示「已登錄 2 項」；再改勾 1 科→「已更新你的選考科目」 |
| 4 | 空勾選／亂填科目 key | 400「請至少勾選一個科目」／「勾選的科目與本場次不符」 |
| 5 | 管理端看名單（`?eventId=`） | 該生登錄科目與 byClass/bySubject 統計正確 |
| 6 | 狀態「已封存」→ 學生再送 | 409「報名已截止」；已勾科目唯讀保留；取消也 409 |
| 7 | 學生「取消報名」（須先重開） | 刪除登錄文件；清單回「尚未登錄」 |
| 8 | 稽核 | `event_created` 1、`event_updated` 依操作數、`recorded`＝登錄次數、`withdrawn`＝取消次數 |
| 9 | 無權限帳號打 API／頁 | 403；未啟用時入口卡不顯示 |

### 已知事項

- **P4 啟用閘**：學生端 API 接 `requireFeatureModuleEnabled`（主程式 0.390+）——模組停用後 API 回 403「尚未啟用」；
  管理端 API 刻意不接（停用時管理員仍需配置）。超級 bypass 由宿主處理。
- session 閒置約 60 分鐘即失效，驗收中途逾時請重新登入（非 bug）。
- 公告**沒有** API 刪除（主程式 405），重發/刪除走公告管理頁；行事曆為 upsert（同 `sourceRef` 不會疊床）。
- `open → open`（重送開放）不發公告；只有**轉為**開放才發佈一次。
- 測試殘留已於驗收後清理（issue #1 #5/#6：場次封存、兩則公告封存、行事曆取消，全走 App 路徑留稽核）。
  再測試請自建場次；測試資料建議加 `dev_` 前綴或改用 Emulator——兩台 dev 共用正式 Firestore。

## 在另一台電腦開發

```bash
git clone <本 repo> examRegistration
git clone https://github.com/takan003/campus-toolkit.git
cd campus-toolkit && npm install
# .env.local（8 個值見 campus-toolkit/.env.example）
npm run module:link -- ../examRegistration --copy
npm run dev
```

win32：junction 被 Turbopack 擋住（E14），一律用 `--copy`；改檔後重跑一次同步。
模組資料夾**勿放** `.git`/`node_modules`/`.next` 之外的宿主依賴——零新依賴是協議【E10】。
