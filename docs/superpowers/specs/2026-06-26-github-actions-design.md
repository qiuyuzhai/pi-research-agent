# GitHub Actions 分层 CI 设计

## 背景

当前仓库已经是 Git 仓库，并配置了远端 `origin=https://github.com/earendil-works/pi.git`。仓库内已有 `.github/workflows/ci.yml`、`.github/workflows/npm-audit.yml` 和 `.github/workflows/build-binaries.yml` 等工作流，因此本次目标不是从零创建 GitHub Actions，而是整理现有 Actions，使其符合项目文档与业界常见的分层 CI 模式。

## 目标

- 使用现有 GitHub 远端，不新建仓库。
- 将日常 PR 质量门禁与发布前验证拆分，避免普通 PR 执行过重的发布流程。
- 保留安全审计为独立定时任务，避免外部审计噪声阻塞普通开发。
- 不在本轮新增 npm trusted publishing、不新增 tag 自动发布逻辑、不执行发布。

## 推荐方案

采用“分层 CI + 手动发布前 smoke”的方案。

### 日常 CI

`.github/workflows/ci.yml` 负责 `pull_request` 和 `push` 到 `main` 的基础质量门禁。流程应包含：

- `actions/checkout`。
- `actions/setup-node`，使用 Node 22，与项目 `package.json` 的 `engines.node >=22.19.0` 保持一致。
- 安装系统依赖，保持当前对 Cairo、Pango、fd、ripgrep 等依赖的支持。
- `npm ci --ignore-scripts`，符合项目供应链约束。
- `npm run check` 或等价 CI 检查命令。
- `./test.sh`，避免直接运行完整 `npm test` 或完整 vitest suite。

`npm run check` 当前包含 `biome check --write`，可能在 CI 中改写工作树。本轮不改 package scripts，改为在 `npm run check` 后执行 `git diff --exit-code`，让 CI 明确捕获任何自动改写。

### 发布前 Smoke

新增 `.github/workflows/release-smoke.yml`，仅使用 `workflow_dispatch` 手动触发。该 workflow 用于 release 前验证，不参与普通 PR 门禁。流程应包含：

- checkout 当前选择的 ref。
- setup Node 22，并启用 npm cache。
- 安装与 CI 相同的系统依赖。
- `npm ci --ignore-scripts`。
- `npm run release:local -- --out /tmp/pi-local-release --force`。
- 对生成的 Node 与 Bun 产物执行非交互式 smoke：`--help`、`--version`、`--list-models`。

交互式 tmux smoke 暂不纳入第一版，避免 workflow 复杂度膨胀。后续若要把完整 release checklist 自动化，可单独设计。

### 安全审计

保留 `.github/workflows/npm-audit.yml` 的定时与手动触发模式。它继续执行生产依赖审计和 registry signature 验证。该 workflow 不应阻塞普通 PR CI。

### 现有 Tag 发布 Workflow

`.github/workflows/build-binaries.yml` 已存在 tag/workflow_dispatch 触发，并包含二进制构建、GitHub Release 上传和 npm publish job。本轮不新增、不扩展、不触发它。若后续要正式启用自动发布，需要单独确认 GitHub Environment `npm-publish`、OIDC trusted publishing、tag 保护、release 权限与失败重跑策略。

## 权限与安全

- 普通 CI 使用最小权限，默认 `contents: read` 或保持无写权限。
- 发布 smoke 不需要写权限。
- npm audit 只需要读取仓库内容。
- 不在 workflow 中引入新的长期 secrets。
- 不在本轮执行 `git push`、tag 创建、GitHub Release 创建或 npm publish。

## 验证策略

本轮实现后进行以下验证：

- 检查 YAML 语法与 workflow 触发条件。
- 检查 `ci.yml` 不再直接运行完整 `npm test`，而是使用项目推荐的 `./test.sh`。
- 检查 `release-smoke.yml` 只由 `workflow_dispatch` 触发。
- 不默认运行 `npm run build` 或完整 `npm test`。
- 若修改了测试文件，才运行对应测试；本轮预期不修改测试文件。

## 回滚策略

所有变更限定在 `.github/workflows/` 与文档/计划文件中。若 CI 配置效果不符合预期，可以通过恢复对应 workflow 文件回退。由于不涉及远端推送、发布、tag 或包版本变更，本地回滚成本低。

## 范围外

- 新建 GitHub 仓库。
- 修改 GitHub 远端。
- 自动创建 GitHub secrets 或 environments。
- npm trusted publishing 配置。
- tag 发布链路重构。
- release 脚本重构。
- package version bump。
