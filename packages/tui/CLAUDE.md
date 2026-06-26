[根目录](../../CLAUDE.md) > [packages](../) > **tui**

# packages/tui

## 变更记录 (Changelog)

- 2026-06-23T10:28:45+08:00：初始化模块扫描文档；记录职责、入口、接口、依赖、测试与缺口。

## 模块职责

`packages/tui` 发布为 `@earendil-works/pi-tui`，提供终端 UI 框架：差分渲染、同步输出、组件系统、overlay、键盘输入解析、编辑器、选择列表、Markdown 渲染、终端图片和宽度处理。`coding-agent` 的交互式模式依赖该模块构建界面。

## 入口与启动

- 库入口：`src/index.ts`，集中导出 TUI 容器、组件、autocomplete、keybindings、keyboard parsing、terminal、terminal image、颜色、stdin buffer 与工具函数。
- 核心渲染：`src/tui.ts`。
- 构建命令：`npm run build` 执行 `tsgo -p tsconfig.build.json`。
- 测试命令：`npm run test` 执行 `node --test test/*.test.ts`。

## 对外接口

`src/index.ts` 暴露的主要 API：

- 容器与焦点：`TUI`、`Container`、`Component`、`Focusable`、`OverlayHandle`、`OverlayOptions`。
- 组件：`Text`、`TruncatedText`、`Input`、`Editor`、`Markdown`、`Loader`、`CancellableLoader`、`SelectList`、`SettingsList`、`Spacer`、`Image`、`Box`。
- 输入与快捷键：`parseKey`、`matchesKey`、`KeybindingsManager`、`getKeybindings`、`setKeybindings`。
- 终端能力：`ProcessTerminal`、`Terminal`、Kitty/iTerm 图片协议、OSC 颜色解析、可见宽度与 ANSI wrap。

## 关键依赖与配置

- 运行依赖：`get-east-asian-width`、`marked`。
- 开发依赖：`@xterm/headless`、`chalk`。
- 原生资产：`native/darwin` 与 `native/win32` 下有 C 源码与预编译 `.node` 文件，用于平台相关终端能力。
- 配置文件：`package.json`、`tsconfig.build.json`、`vitest.config.ts`。

## 数据模型

未发现数据库 schema。数据结构主要是 TypeScript interface/type：组件接口、主题接口、keybinding 定义、terminal capabilities、image dimensions、overlay options 与 stdin buffer events。

## 测试与质量

测试集中在 `test/`，覆盖 autocomplete、Markdown、输入框、editor、keybindings、terminal、terminal image、fuzzy、select-list、truncated text、CJK/emoji/区域指示符宽度、overlay、wrap/truncate、stdin buffer 与多个回归场景。

## 常见问题 (FAQ)

- 如何新增组件？参考 `src/components/*` 的 `Component` 接口实现，并通过 `src/index.ts` 统一导出。
- 如何处理快捷键？优先通过 keybinding 配置与 `matchesKey`，不要硬编码按键判断。
- 如何处理窄终端和宽字符？使用 `visibleWidth`、`truncateToWidth`、`wrapTextWithAnsi` 与现有 width 测试覆盖。

## 相关文件清单

- `package.json`
- `README.md`
- `src/index.ts`
- `src/tui.ts`
- `src/terminal.ts`
- `src/terminal-image.ts`
- `src/keys.ts`
- `src/keybindings.ts`
- `src/components/editor.ts`
- `src/components/markdown.ts`
- `src/components/select-list.ts`
- `src/components/image.ts`
- `src/utils.ts`
- `native/`
- `test/`

## 扫描缺口

本次未逐行深读差分渲染算法、overlay 布局、图片协议编码与 native 模块边界。建议后续补扫 `src/tui.ts`、`src/terminal-image.ts`、`src/components/editor.ts` 与相关回归测试。
