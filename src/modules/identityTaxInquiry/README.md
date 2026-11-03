# 註冊身分與財稅查調模組（identityTaxInquiry）

> 狀態：0.1.31（可在主程式掛載測試）
> 宿主要求：`campus-toolkit` ≥ 0.558（使用 `requireModulePermission` 子權限閘門）

## 功能

1. **學生端**：每學期於學校開放期間確認註冊身分別（原住民、低收入戶、中低收入戶、身心障礙等，選項由管理端設定）；需要財稅查調時，依查調對象填寫父、母、本人或監護人的身分證字號，不收集查調對象姓名；每次送出確認都須重新閱讀並勾選個人資料授權，可先存草稿（不需同意），截止前可修改，截止後唯讀。
1. **教職員端**：兼導師查看本班確認進度與名冊；具「財稅查調」權限者可跨班，具「查看名冊」權限者可查指定班級；可更新查調狀態（待查調／已查調／免查調）與備註。
1. **管理端**：設定啟用開關、確認開放起訖、身分別選項、需查調身分別、是否必填父母身分證字號與實施說明；查看全校統計與名冊，匯出查調名冊 CSV。
1. **家長端**：唯讀查看綁定子女的註冊身分確認結果與查調狀態；父母身分證字號一律遮蔽。

## 開發者

1. 作者：takan003（<https://github.com/takan003>）
1. 版本：0.1.31（2026-11-02）
1. 授權：MIT

## 安裝後設定

1. 於主程式 `/admin/modules` 找到「註冊身分與財稅查調」並開啟總開關。
1. 至 `/admin/identity-tax-inquiry` 設定確認開放起訖、身分別選項與需查調身分別（預設「低收入戶」「中低收入戶」），並視需要勾選「查調時必填父或母身分證字號」。
1. 指派管理子權限：`configure`（管理規則）、`viewRecords`（查看名冊）、`taxInquiry`（查調作業）、`export`（匯出）。
1. 家長入口依主程式功能模組設定開放；`provides.parent = true`。

## 資料集合（`dataCollections`）

1. `identityTaxInquirySettings`：模組設定（單文件 `default`）。
1. `identityTaxInquiryRecords`：學生每學期確認紀錄（doc id＝`{學年學期}_{uid}`）。
1. `rosterStudents`：唯讀查詢當期名冊（家長子女對應、班級名冊）。

## 複合索引（`firestoreIndexes`）

1. `rosterStudents`：`academicYear` + `semester` + `classCode`。
1. `identityTaxInquiryRecords`：`period` + `classCode`。

## 掛勾需求（`hooks`）

無。本模組不發公告、不寫行事曆。

## 稽核動作

`identity_tax_inquiry_settings_updated`／`identity_tax_inquiry_record_saved`／
`identity_tax_inquiry_record_confirmed`／`identity_tax_inquiry_tax_updated`。

## 本機開發

```bash
git clone <本 repo> identityTaxInquiry
git clone https://github.com/takan003/campus-toolkit.git
cd campus-toolkit && npm install
npm run module:link -- ../identityTaxInquiry --copy --watch   # win32 一律 --copy（E14）
npm run dev
```

改檔後由 `--watch` 同步；`npm run lint` 一律在主程式目錄執行。
實施說明編輯器聚焦後即隱藏提示文字（包含中文組字期間），內容空白且失焦時才恢復提示。

## 個人資料授權

1. 每次「送出確認」皆開啟主題化授權視窗，勾選框預設未勾選；取消、送出失敗或再次送出時，均須重新同意。所有身分別皆適用，不限需要財稅查調者；草稿不需要授權。
1. API 必須收到本次明確同意及目前告知版本；伺服器保存 `personalDataConsent{version,agreedAt}`，時間由伺服器產生，不接受前端時間。舊紀錄不補造同意紀錄，改存草稿會清除該草稿的授權證據；本欄只記錄目前這次確認，並非完整歷次簽署檔案。
1. 查調對象姓名不再接受、回傳或匯出；既有資料中的姓名在下次儲存該紀錄時移除，未批次刪改歷史資料。學生名冊姓名仍保留，供辨識學生；CSV 同時提供父、母、本人與監護人證號欄。

<details>
<summary>授權文字依據與上線前確認事項</summary>

1. 依[個人資料保護法第 3、7、8、9 條](https://law.pdpc.gov.tw/LawContent.aspx?id=FL010627)的權利、同意與告知架構，另參考校園常見的「蒐集個人資料告知事項暨同意書」格式，例如[崑山科技大學公開範本](https://my.ksu.edu.tw/file/bbcode/w3Pages/61059/d8f3ecc3-f67a-4a9c-a35b-1b0889296f41/%E8%B7%A8%E9%99%A2%E7%B3%BB%E5%AD%B8%E5%88%86%E5%AD%B8%E7%A8%8B%E8%92%90%E9%9B%86%E5%80%8B%E4%BA%BA%E8%B3%87%E6%96%99%E5%91%8A%E7%9F%A5%E4%BA%8B%E9%A0%85%E6%9A%A8%E8%92%90%E9%9B%86%E5%90%8C%E6%84%8F%E6%9B%B8.pdf)；本模組採自行撰寫的用途限定文字，不直接套用其他學校的授權範圍。
1. 告知涵蓋蒐集機關、目的、資料類別、利用期間／地區／對象／方式、當事人權利與申請窗口，以及不提供資料的影響；學校名稱取自主程式設定。
1. 涉及他人資料時，送出者須確認已完成當事人告知及合法授權；未成年學生須先請法定代理人閱讀確認。本勾選不代替父母、監護人的獨立簽名或依法要求的授權文件。
1. 目前僅辦理名單登錄與人工查調結果管理，未串接外部財稅查詢 API；勾選不會直接向外部機關查調。
1. 上線前請學校承辦／個資窗口確認實際法源、資料類別、保存期限、雲端資料所在地、權利行使窗口及法定代理人授權程序；此為通用範本，不保證單靠勾選即可滿足所有法定要求。
1. 修改授權告知或同意範圍時，同步更新 `PERSONAL_DATA_CONSENT_VERSION`；後端拒絕舊版本同意，避免舊頁面誤送。

</details>

## 回歸測試

在工作區根目錄執行 `node identityTaxInquiry\scripts\test-identity-tax-inquiry.mjs`，
使用相鄰主程式的 SWC 與 Node.js 內建測試器，不需新增套件、不連線資料庫。
主程式不在相鄰目錄時，於指令最後加上主程式絕對路徑。

## 待定案

1. 是否串接財政部／外部財稅 API（目前為名單與結果登錄、匯出）。
1. 未確認名單是否需自動通知（目前僅顯示於名冊）。
1. 是否需要附件上傳（目前僅備註欄）。
