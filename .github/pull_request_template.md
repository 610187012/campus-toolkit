## 主程式 PR（僅限信任團隊）

> **外部貢獻者請勿開 PR。**  
> 本專案由信任團隊維護；請 fork 本 repo 自行維護，或將模組投稿到
> [campus-toolkit-marketplace](https://github.com/takan003/campus-toolkit-marketplace)。
> 外部 PR 會被直接關閉。

## 團隊成員填寫

- 變更內容：
- 關聯 issue／討論：
- 是否影響模組公開面（`@/lib`／`@/types`／`@/components`）：
- 是否影響模組安裝鏈／簽章／權限：

## 檢查

- [ ] `npm run lint` 通過
- [ ] `npm run version:bump` 已更新 `src/version.json`
- [ ] 沒有把本機掛載的 `src/modules/*` 或生成物一起 commit
- [ ] 若動到模組公開面，已同步 `module-sdk` 的 snapshots
- [ ] commit 訊息結尾附版本號
