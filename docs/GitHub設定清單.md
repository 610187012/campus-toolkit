# GitHub 設定清單（維護者手動）

這份清單是程式碼沒辦法代做的設定。三個 repo 的目標不同，保護強度也不同：

| Repo | 治理模式 | 外部 PR |
|---|---|---|
| `campus-toolkit`（A） | 封閉維護，只有信任團隊可 merge | 不接受；直接關閉 |
| `module-sdk`（B） | 封閉維護，只有信任團隊可 merge | 原則上不接受 |
| `campus-toolkit-marketplace`（C） | PR 審核制，外部可投稿 | 可送 `experimental`，維護者審核後才合併 |

> 公開 repo **無法阻止別人按「New Pull Request」**；能控制的是「只有團隊能 merge」。
> 外部 PR 請直接關閉，並回覆請對方 fork 或投稿 C。

## 一、A `campus-toolkit`

Settings → Branches → Add branch protection rule（`main`）：

- [ ] Require a pull request before merging
- [ ] Require approvals：1
- [ ] Dismiss stale pull request approvals when new commits are pushed
- [ ] Require conversation resolution before merging
- [ ] Require status checks to pass：`CI / verify`
- [ ] Require branches to be up to date before merging
- [ ] Restrict who can push to matching branches：只選信任團隊
- [ ] Do not allow force pushes
- [ ] Do not allow deletions
- [ ] （選用）Require linear history

其他：

- [ ] Settings → General → Pull Requests：保持開啟（團隊需要 PR 審核）
- [ ] Settings → Actions → General → Workflow permissions：Read repository contents
- [ ] Settings → Code security：啟用 Dependabot alerts／security updates
- [ ] Settings → Code security：啟用 Private vulnerability reporting（對應 `SECURITY.md`）
- [ ] `.github/pull_request_template.md` 已加入（外部 PR 會看到「請改為 fork」）

## 二、B `module-sdk`

Settings → Branches → `main`：

- [ ] Require a pull request before merging
- [ ] Require status checks：`CI / test`
- [ ] Restrict who can push：只選信任團隊
- [ ] Do not allow force pushes／deletions

## 三、C `campus-toolkit-marketplace`

Settings → Branches → `main`：

- [ ] Require a pull request before merging
- [ ] Require approvals：1
- [ ] Require status checks：`Validate marketplace index / validate`
- [ ] Require conversation resolution
- [ ] Restrict who can push：只選信任團隊
- [ ] Do not allow force pushes／deletions

其他：

- [ ] Settings → Pages：Source = GitHub Actions（`pages.yml`）
- [ ] Settings → Actions → General → Fork pull request workflows：Require approval for first-time contributors
- [ ] Settings → Code security：啟用 Dependabot alerts／Private vulnerability reporting
- [ ] 外部 PR 的 `status` 只能是 `experimental`（CI 會擋 `official`／`reviewed`）

## 四、標籤與版本

- [ ] A：`v0.xxx` 標籤由維護者在 release commit 建立
- [ ] B：`v1.x` 標籤供市集以 `github:takan003/module-sdk#v1.x` 釘版
- [ ] C：`v1.x` 標籤標記市集治理版本
- [ ] （選用）Settings → Tags → 保護 `v*`，禁止刪除與強制移動

## 五、外部 PR 的處理方式

### A／B

1. 直接關閉 PR。
2. 回覆：

   > 本專案由信任團隊維護，不接受外部 PR。  
   > 請 fork 本 repo 自行維護，或將模組投稿到 campus-toolkit-marketplace。

### C

1. 確認 PR 的 `status` 是 `experimental`、CI 通过。
2. 依 `docs/投稿與審核流程.md` 人審。
3. 通過才由維護者改成 `reviewed`／`official` 並 merge。
4. 不通過就維持 `experimental` 或關閉 PR，並留下原因。

## 六、已加入 repo 的項目

- [x] `.github/CODEOWNERS`（自動指定 `@takan003` 審核）
- [x] `.github/ISSUE_TEMPLATE/`（bug／feature／contact links）
- [x] GitHub Actions 已 pin 到 commit SHA（checkout／setup-node／pages 系列）

## 七、可選

- [ ] 開啟 Discussions（若要讓使用者社群討論）
- [ ] 設定 Dependabot 自動更新 GitHub Actions（更新後仍會是 SHA pin）

