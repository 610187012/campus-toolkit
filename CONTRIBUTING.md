# 貢獻指南（campus-toolkit）

## 主程式採封閉維護

`campus-toolkit`（A）由 **takan003 與信任團隊**維護。

- 只有團隊成員可以開 PR／merge 到 `main`。
- **主程式不接受外部 PR**；外部 PR 會被關閉。
- 其他人可以 **fork** 本 repo、同步上游更新，並在自己的 fork 自由修改。

## 想改主程式怎麼辦？

1. **回報問題**：開 GitHub Issue（請勿在公開 issue 貼出可利用的攻擊細節）。
2. **安全漏洞**：依 [`SECURITY.md`](SECURITY.md) 使用 GitHub 私人安全回報。
3. **自己想改**：fork 本 repo，在 fork 內維護；這是設計上的自架路徑。
4. **團隊成員**：開 branch → PR → CI → 至少一位團隊成員審核 → merge。

`main` 應設定 branch protection 與 required status checks（見
[`docs/GitHub設定清單.md`](docs/GitHub設定清單.md)）。

## 想開發模組怎麼辦？

模組與主程式分開治理：

1. **正式上架**：投稿到
   [`campus-toolkit-marketplace`](https://github.com/takan003/campus-toolkit-marketplace)。
   外部 PR 只能送 `experimental`；維護者審核後才會改成 `reviewed`／`official`。
2. **自用模組**：把模組放進自己 fork 的 `src/modules/`，用
   `npm run module:link -- <路徑> --copy --watch` 或手動複製。
   local 模組不受市集規範，由 fork 主人自行承擔。
3. **自己的模組 repo**：你可以自行接受網友的 PR、決定自己的版本節奏；
   那是你與你的使用者之間的關係，不屬於本專案治理。

模組開發工具見 [`module-sdk`](https://github.com/takan003/module-sdk)。

## 團隊成員的開發流程

1. `npm run lint`（ESLint＋tsc）
2. `npm run version:bump`
3. commit（訊息結尾附版本號）
4. push 並開 PR
5. CI 通過、審核通過後 merge

## 授權

本專案為 [MIT](LICENSE)。
