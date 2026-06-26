[根目录](../../CLAUDE.md) > [packages](../) > **agent**

# packages/agent

## 变更记录 (Changelog)

- 2026-06-23T10:28:45+08:00：初始化模块扫描文档；记录职责、入口、接口、依赖、测试与缺口。

## 模块职责

`packages/agent` 发布为 `@earendil-works/pi-agent-core`，提供通用 agent runtime：状态管理、agent loop、工具执行、事件流、transport/proxy 抽象、harness、session、memory repo、compaction、skills 与 prompt template 机制。

## 入口与启动

- 库入口：`src/index.ts`，导出 `agent.ts`、`agent-loop.ts`、harness、compaction、messages、prompt templates、session repo、skills、system prompt、proxy 与 types。
- Node 子入口：`src/node.ts`，通过 package exports `./node` 暴露。
- 构建命令：`npm run build` 执行 `tsgo -p tsconfig.build.json`。

## 对外接口

`package.json` exports 暴露：

- `.`：主 runtime API。
- `./node`：Node 环境相关能力。
- `./package.json`：包元数据。

README 展示的核心用法是创建 `Agent`，传入 `initialState` 与 `getModel(...)`，订阅事件流并调用 `agent.prompt(...)`。核心概念包括 `AgentMessage` 与 LLM message 转换、`transformContext()`、`convertToLlm()`、工具调用事件序列和多轮 loop。

## 关键依赖与配置

- 运行依赖：`@earendil-works/pi-ai`、`ignore`、`typebox`、`yaml`。
- 测试/构建依赖：`typescript`、`vitest`、`@vitest/coverage-v8`。
- 配置文件：`package.json`、`tsconfig.build.json`、`vitest.config.ts`、`vitest.harness.config.ts`。
- Node 要求：`>=22.19.0`。

## 数据模型

未发现数据库 schema。核心持久化/数据结构集中在：

- `src/types.ts` 与 `src/harness/types.ts`：Agent、工具、事件、harness 类型。
- `src/harness/messages.ts`：消息表示与转换。
- `src/harness/session/*.ts`：session、jsonl repo、memory repo/storage、uuid 与 repo utils。
- `src/harness/compaction/*.ts`：上下文压缩、摘要与 branch summarization 数据流。

## 测试与质量

- 包级测试：`npm run test` 执行 `vitest --run`。
- harness 测试：`npm run test:harness` 使用 `vitest.harness.config.ts`。
- 覆盖率：`npm run coverage:harness`。
- 测试目录：`test/`，覆盖 agent loop、agent 基础行为、harness、compaction、session、storage、skills、prompt templates、system prompt、resource formatting 与 e2e。

## 常见问题 (FAQ)

- 如何观察 Agent 输出？订阅 `agent.subscribe(...)` 的事件流，处理 `message_update`、tool execution 与 turn/agent 生命周期事件。
- 如何做上下文裁剪？查看 `src/harness/compaction/compaction.ts` 与 `DEFAULT_COMPACTION_SETTINGS`。
- 如何接入 session 存储？查看 `src/harness/session/jsonl-repo.ts`、`memory-repo.ts` 与 `session.ts`。

## 相关文件清单

- `package.json`
- `README.md`
- `src/index.ts`
- `src/agent.ts`
- `src/agent-loop.ts`
- `src/harness/agent-harness.ts`
- `src/harness/types.ts`
- `src/harness/messages.ts`
- `src/harness/system-prompt.ts`
- `src/harness/compaction/`
- `src/harness/session/`
- `src/harness/skills.ts`
- `src/proxy.ts`
- `test/`

## 扫描缺口

本次仅读取 README 与聚合入口，未逐行深读 `agent-loop.ts`、`agent.ts`、harness/session/compaction 的实现细节。建议后续补扫 `src/agent-loop.ts`、`src/harness/agent-harness.ts`、`src/harness/session/**` 与 `test/harness/**`。
