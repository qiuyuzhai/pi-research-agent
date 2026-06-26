[根目录](../../CLAUDE.md) > [packages](../) > **coding-agent**

# packages/coding-agent

## 变更记录 (Changelog)

- 2026-06-23T10:28:45+08:00：初始化模块扫描文档；记录职责、入口、接口、依赖、测试与缺口。

## 模块职责

`packages/coding-agent` 发布为 `@earendil-works/pi-coding-agent`，是面向用户的 Pi CLI 与 SDK。它组合 `pi-ai`、`pi-agent-core` 与 `pi-tui`，提供交互式 coding agent、print/json/rpc/sdk 多模式、内置 read/write/edit/bash/find/grep/ls 工具、session 管理、配置、认证、扩展、skills、prompt templates、主题与导出 HTML。

## 入口与启动

- Node CLI：`src/cli.ts`，设置 `process.title`、`PI_CODING_AGENT`，配置 HTTP dispatcher，然后调用 `main(process.argv.slice(2))`。
- Bun CLI：`src/bun/cli.ts`，用于编译 binary 路径。
- 主流程：`src/main.ts`。
- SDK/库入口：`src/index.ts`。
- 构建命令：`npm run build` 执行 `tsgo -p tsconfig.build.json` 并复制主题、图片、HTML export 资源。
- binary 构建：`npm run build:binary` 会先构建依赖包，再用 Bun compile 生成 `dist/pi` 并复制 binary assets。

## 启动控制流

`src/cli.ts` 是 Node 入口 shim，负责设置 `process.title`、`PI_CODING_AGENT=true`、屏蔽 warning、配置 HTTP dispatcher，然后调用 `main(argv.slice(2))`。`src/main.ts` 的控制流大致为：处理 offline 与 Windows 自更新清理；用 `handlePackageCommand` / `handleConfigCommand` 短路 package/config 子命令；`parseArgs` 后处理 `--version` / `--export`；通过 `resolveAppMode` 判定 app mode；非 interactive 且非纯 metadata 命令时接管 stdout；校验 fork/session-id 冲突并运行 migrations；解析 sessionDir 并创建 SessionManager；构造 `createRuntime` 工厂和 `AgentSessionRuntime`；在 runtime 就绪后输出 `--help` / `--list-models`；读取 piped stdin 并准备 initial message；最后分发到 rpc、interactive 或 print/json 模式。

## 运行模式

`AppMode` 有 `interactive`、`print`、`json`、`rpc` 四种。判定优先级是 `--mode rpc`、`--mode json`、`--print` 或 stdin/stdout 非 TTY 时进入 print，否则进入 interactive。需要注意 CLI `Mode` 类型只有 `text/json/rpc` 三值，`json` 实际是 print mode 的输出子模式，由 `runPrintMode` 内部通过 `text/json` 分支处理。

三种主运行形态共享 `AgentSessionRuntime.setRebindSession(rebindSession)` 编排骨架。`rebindSession` 内会 `session.bindExtensions({ mode, commandContextActions })` 并订阅 session 事件，`commandContextActions` 统一暴露 `waitForIdle`、`newSession`、`fork`、`navigateTree`、`switchSession`、`reload` 等动作，使 `/new`、`/resume`、`/fork`、import 在 interactive/print/rpc 中行为一致。runtime 在 `switchSession`、`newSession`、`fork`、`importFromJsonl` 时遵循 teardown → createRuntime → apply → finishSessionReplacement → rebind 生命周期。

## 模式实现要点

- `src/modes/print-mode.ts`：单发模式。text 输出只取最后一条 assistant text；error/aborted 输出 stderr 并 exit 1。json 输出逐事件 `JSON.stringify`，包含 header。
- `src/modes/rpc/rpc-mode.ts`：JSONL over stdin/stdout 的 headless 模式，命令入口集中在 `handleCommand` switch；RPC 版 `ExtensionUIContext` 把 select/confirm/input/editor 映射为 pending request/response，TUI widget/header/footer/theme 多为 no-op；包含 stdout 背压与 SIGTERM/SIGHUP 优雅关闭。
- `src/modes/interactive/interactive-mode.ts`：TUI 模式核心，单文件体量约 5.7k 行。构造时创建 `TUI(new ProcessTerminal())`、固定 Container 布局栈、`KeybindingsManager` 与 `CustomEditor`；`init()` 负责工具可用性、布局装配、`ui.start()`、主题/git 监听与 session rebind；`run()` 进入 `getUserInput → session.prompt` 主循环。

## 工具体系

`src/core/tools/` 采用 definition-first 设计。每个内置工具通过 `create<Name>ToolDefinition(cwd, options)` 产出 `ToolDefinition`，再由 `wrapToolDefinition` 适配为 agent runtime 消费的 `AgentTool`。UI 渲染元数据如 `renderCall`、`renderResult`、`promptSnippet`、`promptGuidelines` 跟随 definition，而 runtime 只依赖工具执行子集。

内置工具集有三套预设：`createCodingTools` 提供 read/bash/edit/write，`createReadOnlyTools` 提供 read/grep/find/ls，`createAllTools` 提供 7 个全集。新增内置工具时，需要同步更新工具实现、`ToolName` 联合类型、`allToolNames` 与对应工具集函数。

工具执行统一签名为 `execute(toolCallId, params, signal, onUpdate, ctx)`，返回 `{ content, details }`。所有工具都绑定 cwd，路径经 `resolveToCwd` 解析；各工具通过 `<Tool>Operations` 接口注入读写、glob、exec 等操作，因此可替换为 SSH/远程后端而不是硬编码本地文件系统。错误处理约定是失败时抛出面向模型的可执行 `Error`，例如续读 offset、sed fallback、编辑匹配失败原因与修复建议。

并发与截断集中复用共享基础设施：`file-mutation-queue.ts` 按文件 realpath 串行化 write/edit，同文件排队、异文件并行；`truncate.ts` 统一 2000 行 / 50KB 双限制；`output-accumulator.ts` 支持 bash 超限输出落临时文件并给出续读指引。`grep` 依赖 `rg`，`find` 依赖 `fd`，运行期通过 ensureTool 按需保障，离线或受限环境可能直接报错。

权限边界需要特别注意：工具实现自身不做 trust/审批/沙箱校验，`bash`、`write`、`edit` 的授权与拦截依赖外层 `tool_call` 扩展事件、trust-manager 与会话运行时策略。评审工具改动时应按这条边界检查，不要把安全假设放进工具层。

## 对外接口

- bin：`pi` 指向 `dist/cli.js`。
- package exports：`.` 指向 `dist/index.js` 与 `dist/index.d.ts`。
- 用户模式：README 描述交互模式、print/JSON、RPC、SDK embedding。
- 扩展接口：`src/core/extensions/*` 与 `examples/extensions/**` 提供 TypeScript extension、skills、prompt templates、themes 与 pi packages 的扩展路径。
- 工具接口：`src/core/tools/*` 包含文件读取、写入、编辑、bash、查找、grep、ls、路径处理、输出截断与 mutation queue。

## 关键依赖与配置

- 内部依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`。
- 运行依赖：`chalk`、`cross-spawn`、`diff`、`glob`、`highlight.js`、`ignore`、`jiti`、`minimatch`、`proper-lockfile`、`semver`、`typebox`、`undici`、`yaml`、`@silvia-odwyer/photon-node`。
- 可选依赖：`@mariozechner/clipboard`。
- 配置文件：`package.json`、`tsconfig.build.json`、`tsconfig.examples.json`、`.gitignore`、`docs/docs.json`。
- package `piConfig.configDir` 为 `.pi`。

## 数据模型

未发现传统数据库 schema。核心状态与持久化包括：

- Session：`src/core/session-manager.ts`、`src/core/agent-session*.ts`、`src/core/session-cwd.ts`。
- 配置/信任/认证：`settings-manager.ts`、`trust-manager.ts`、`project-trust.ts`、`auth-storage.ts`。
- 消息与 compaction：`messages.ts`、`core/compaction/**`。
- 扩展与资源：`extensions/**`、`resource-loader.ts`、`skills.ts`、`prompt-templates.ts`。
- 主题与静态资源：`src/modes/interactive/theme/*.json`、`assets/*.png`。

## 测试与质量

- 包级测试：`npm run test` 执行 `vitest --run`。
- 根规则要求：不要直接运行完整 vitest suite；常规非 e2e 使用根级 `./test.sh`，或从包根运行具体测试文件。
- 测试目录：`test/`，覆盖 agent session、compaction、extensions、export HTML、工具、配置、交互模式、RPC、SDK、package manager、settings、session selector 与回归测试。
- `test/suite/` 使用 faux provider 和 harness，适合 issue-specific regression。

## 常见问题 (FAQ)

- 如何启动源码交互模式？从仓库根运行 `./pi-test.sh`。
- 新增内置工具放哪里？通常在 `src/core/tools/` 增加实现，并通过工具索引与 session runtime 接入。
- 新增扩展示例放哪里？放在 `examples/extensions/`，复杂示例可有自己的 `package.json`。
- 如何避免真实 Provider 调用？测试使用 faux provider，尤其是 `test/suite/harness.ts`。
- 如何生成发布产物？普通包构建用 `npm run build`；binary 用 `npm run build:binary`；发布 shrinkwrap 用 `npm run shrinkwrap`。

## 相关文件清单

- `package.json`
- `README.md`
- `src/cli.ts`
- `src/main.ts`
- `src/index.ts`
- `src/config.ts`
- `src/cli/`
- `src/core/agent-session.ts`
- `src/core/agent-session-runtime.ts`
- `src/core/tools/`
- `src/core/extensions/`
- `src/core/settings-manager.ts`
- `src/core/session-manager.ts`
- `src/modes/`
- `docs/`
- `examples/extensions/`
- `test/`
- `test/suite/`

## 扫描缺口

该模块文件最多，本次只做入口、package、README 与目录级扫描，未完整读取 `src/main.ts`、各 mode、tools、extensions、settings/session 细节和文档站内容。建议后续优先补扫 `src/main.ts`、`src/modes/**`、`src/core/tools/**`、`src/core/extensions/**`、`src/core/settings-manager.ts` 与 `test/suite/**`。
