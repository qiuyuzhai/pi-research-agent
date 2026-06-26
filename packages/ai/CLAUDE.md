[根目录](../../CLAUDE.md) > [packages](../) > **ai**

# packages/ai

## 变更记录 (Changelog)

- 2026-06-23T10:28:45+08:00：初始化模块扫描文档；记录职责、入口、接口、依赖、测试与缺口。

## 模块职责

`packages/ai` 发布为 `@earendil-works/pi-ai`，负责把多家 LLM Provider、模型元数据、流式输出、工具调用、OAuth、图片生成与上下文资源抽象成统一 TypeScript API。该模块是 `agent` 与 `coding-agent` 的模型访问底座。

## 入口与启动

- 库入口：`src/index.ts`，集中导出 registry、模型、图片、stream、types、OAuth 类型与工具函数。
- CLI 入口：`src/cli.ts`，通过 package bin 暴露为 `pi-ai`。
- 构建入口：`npm run build`，先执行 `scripts/generate-models.ts` 与 `scripts/generate-image-models.ts`，再运行 `tsgo -p tsconfig.build.json`。
- 生成文件：`src/models.generated.ts` 与 `src/image-models.generated.ts` 来自脚本生成，不应直接手改。

## 对外接口

`package.json` exports 暴露主入口和多个 provider 子路径：`./anthropic`、`./google`、`./google-vertex`、`./mistral`、`./openai-responses`、`./openai-completions`、`./openai-codex-responses`、`./azure-openai-responses`、`./oauth` 与 `./bedrock-provider`。

README 显示主要 API 包括：`getModel`、`stream`、`complete`、`Context`、`Tool`、TypeBox re-export、工具调用事件、图片输入/生成、thinking/reasoning、stop reasons、abort handling、Provider/Model 查询和跨 Provider handoff。

## 关键依赖与配置

- 运行依赖：`@anthropic-ai/sdk`、`openai`、`@google/genai`、`@mistralai/mistralai`、`@aws-sdk/client-bedrock-runtime`、`typebox`、`partial-json` 与 HTTP proxy agent。
- Node 要求：`>=22.19.0`。
- 配置文件：`package.json`、`tsconfig.build.json`。
- 根级质量约束：Biome、TypeScript native preview、pin deps、relative import 与 shrinkwrap 检查。

## 数据模型

未发现传统数据库 schema。核心数据模型集中在 TypeScript 类型与 TypeBox schema：`src/types.ts`、`src/models.ts`、`src/api-registry.ts`、`src/images-api-registry.ts`、Provider options 类型与 OAuth 类型。

## 测试与质量

- 测试目录：`test/`。
- 测试命令：包级 `npm run test` 执行 `vitest --run`。
- 测试覆盖方向包括 Provider payload 转换、OAuth、Bedrock、Anthropic SSE/thinking/cache、Google tool routing、context overflow、abort、faux provider 与 cross-provider handoff。
- 注意：部分 e2e/smoke 测试可能需要真实 provider 环境变量，常规验证应优先运行具体测试文件或根级 `./test.sh`。

## 常见问题 (FAQ)

- 模型列表怎么更新？修改 `scripts/generate-models.ts` 或相关生成逻辑后运行生成脚本，不直接编辑 `src/models.generated.ts`。
- 新增 Provider 放哪里？通常在 `src/providers/` 新增实现，并在 `src/providers/register-builtins.ts` 或相应 registry 中接入。
- 浏览器是否可用？README 有 browser usage 章节；需要注意 Node-only 环境变量与 SDK 差异。

## 相关文件清单

- `package.json`
- `README.md`
- `src/index.ts`
- `src/stream.ts`
- `src/types.ts`
- `src/models.ts`
- `src/api-registry.ts`
- `src/providers/register-builtins.ts`
- `src/providers/anthropic.ts`
- `src/providers/openai-responses.ts`
- `src/providers/google.ts`
- `src/providers/amazon-bedrock.ts`
- `src/utils/oauth/`
- `scripts/generate-models.ts`
- `scripts/generate-image-models.ts`
- `test/`

## 扫描缺口

Provider 具体实现、OAuth 页面/设备码流程、图片生成 registry、事件流边界行为与 e2e 测试条件未完整深读。建议后续优先补扫 `src/providers/**`、`src/utils/oauth/**`、`src/images*.ts` 与关键 Provider 测试。
