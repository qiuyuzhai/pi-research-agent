#!/usr/bin/env node
// research-kernel-autodebug.live.mjs — FR-3 auto_debug_python 自修复 Micro-loop 真实链路测试
//
// 运行(让 tsconfig paths 把 @earendil-works/pi-ai 重定向到 packages/ai/src, 免构建 dist):
//   TSX_TSCONFIG_PATH=/home/aaron/project1/pi/tsconfig.json \
//     node --import tsx /home/aaron/project1/pi/.pi/extensions/research-kernel-autodebug.live.mjs
//
// 策略 = 零侵入(绝不改 research-kernel.ts):
//   - import default researchKernelExtension, 用 mock pi 捕获 auto_debug_python.execute
//   - registerApiProvider 注册一个 DUCK-TYPE mock provider: streamSimple 从响应队列 shift 一条
//     mock AssistantMessage 返回 {result: async()=>msg}, completeSimple 只调 .result() 一次即穿透
//   - mock ctx 注入 mock model + cwd; 真实 KernelManager 驱动真实 uv worker 跑 Python
//   - 反假绿: streamSimple 把收到的 context 推入 capturedContexts, 断言 systemPrompt/GOAL/CODE/ERROR
//     真被回灌; SUCCESS 分支断言修复代码的真实 stdout(healed) 出现, 证明修复码真在 worker 跑过.
//
// 与 research-kernel.live.mjs(纯函数 + 单链路冒烟)互补: 本脚本专注 auto_debug 的 mock-model 修复回路.

import {
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai";
import researchKernelExtension, {
	KernelManager,
} from "/home/aaron/project1/pi/.pi/extensions/research-kernel.ts";

// research-kernel.ts:27 DEBUG_SYSTEM_PROMPT 是闭包外模块常量但未 export; 反假绿断言用其特征前缀.
const DEBUG_PROMPT_PREFIX = "你是 Python 调试器";
const KERNEL_DIR = "/home/aaron/project1/pi/.pi/research-kernel"; // worker 由 import.meta.url 定位, 与 cwd 无关; 此值任意有效目录即可
const MOCK_API = "mock-debug-fr3"; // 独一无二, 不与内置 provider key 冲突
const SOURCE_ID = "autodbg-fr3-live"; // sourceId 供精确 unregister, 不动内置 provider

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

// ── mock model: 回路只触碰 model.api(选 provider) 与 model.provider(getEnvApiKey 无 key 原样返回) ──
const mockModel = { api: MOCK_API, provider: MOCK_API };

// ── mock AssistantMessage 工厂: 回路只读 .stopReason / .content / .errorMessage; 余字段占位补全 ──
function baseMsg(extra) {
	return {
		role: "assistant",
		api: MOCK_API,
		provider: MOCK_API,
		model: "mock-debug-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...extra,
	};
}
// (1) 成功修复: stopReason 'stop' + Markdown python 围栏包裹的修复代码(extractCode 正则要求 ```python\n)
function fixMsg(pythonCode) {
	return baseMsg({
		stopReason: "stop",
		content: [{ type: "text", text: "```python\n" + pythonCode + "\n```" }],
	});
}
// (2) 模型失败: stopReason 'error' + errorMessage (回路 L498 中止)
function modelErrorMsg(reason) {
	return baseMsg({ stopReason: "error", errorMessage: reason, content: [] });
}
// (3) 空代码: stopReason 'stop' 但提取后为空 (回路 L503 中止)
function emptyMsg() {
	return baseMsg({ stopReason: "stop", content: [{ type: "text", text: "" }] });
}

// ── mock provider: DUCK-TYPE streamSimple 返回 {result: async()=>msg}; 记录 context 反假绿 ──
let repairQueue = []; // 按 completeSimple 调用顺序出队
const capturedContexts = []; // 每次 completeSimple 收到的 context 存档(反假绿)
let callCount = 0;

registerApiProvider(
	{
		api: MOCK_API,
		// register 要求 stream 存在(被 wrapStream 引用), 但 completeSimple 路径只走 streamSimple; 给永不调用的桩.
		stream: () => {
			throw new Error("mock.stream should not be called in completeSimple path");
		},
		streamSimple: (model, context, _options) => {
			callCount++;
			capturedContexts.push(context);
			const msg = repairQueue.shift();
			if (!msg) throw new Error("mock repair queue exhausted (unexpected extra completeSimple call)");
			return { result: async () => msg };
		},
	},
	SOURCE_ID,
);

// ── 捕获工具注册 (mock pi): ext(pi) 同步执行即注册, 无需 await ──
const tools = {};
const mockPi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	appendEntry: () => {},
};
researchKernelExtension(mockPi);

const autoDebug = tools["auto_debug_python"];
const kernelReset = tools["kernel_reset"];

// ── mock ctx 工厂: auto_debug 只读 ctx.model + ctx.cwd ──
function makeCtx(overrides = {}) {
	return { model: mockModel, cwd: KERNEL_DIR, ...overrides };
}

const noopUpdate = () => {};

// 跨场景串味防护: getManager 单例 => 同一 worker 同一 namespace; 场景间显式 kernel_reset 清空.
async function resetNamespace() {
	await kernelReset.execute("rst", {}, new AbortController().signal, noopUpdate, makeCtx());
}

// 调一次 auto_debug.execute, 返回 {text, res}
async function runAutoDebug(initialCode, goal, repairs, maxAttempts) {
	repairQueue = repairs.slice();
	callCount = 0;
	capturedContexts.length = 0;
	const res = await autoDebug.execute(
		"call",
		{ code: initialCode, goal, max_attempts: maxAttempts },
		new AbortController().signal,
		noopUpdate,
		makeCtx(),
	);
	const text = res?.content?.[0]?.text ?? "";
	return { text, res };
}

async function main() {
	console.log("=== FR-3 auto_debug_python 自修复 Micro-loop live 测试 ===");
	console.log(`worker: ${new KernelManager(KERNEL_DIR).workerPath}`);
	console.log("(首跑 uv 建 venv 装 numpy/scipy/sympy/pandas, 可能慢; READY_TIMEOUT=60s)\n");

	// ─────────────────────────────────────────────────────────────────────────
	// 场景 5 先跑(无 worker 依赖): 无 model -> L416 isError, 不进修复回路.
	// ─────────────────────────────────────────────────────────────────────────
	section("[场景5] 无 model -> L416 直接返回 isError (不触 worker, 不触 mock)");
	{
		const callBefore = callCount;
		const res = await autoDebug.execute(
			"call-nomodel",
			{ code: "print('x')", goal: "g", max_attempts: 3 },
			new AbortController().signal,
			noopUpdate,
			makeCtx({ model: undefined }),
		);
		const text = res?.content?.[0]?.text ?? "";
		check("L419 isError === true", res?.isError === true, JSON.stringify(res?.isError));
		check("文本含 'no model available'", text.includes("no model available"), text);
		check("未触发 completeSimple (mock 未被调用)", callCount === callBefore, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 场景 1: SUCCESS 修复. 初始 NameError -> mock 返回围栏正确代码 -> 第2轮 OK.
	// 分支: L460 ok -> SUCCESS; L482 ERROR 记录; L485-494 context; L497 completeSimple; L507 code=repaired.
	// ─────────────────────────────────────────────────────────────────────────
	section("[场景1] SUCCESS 修复 (L482 ERROR -> L497 修复 -> L460 SUCCESS)");
	{
		await resetNamespace();
		const initial = "print(missing_var)"; // 真实 NameError(由真实 uv worker 跑出 status==='error')
		const goal = "print the word healed";
		const repaired = "print('healed')"; // 真实可执行, 第2轮 worker 跑出 status==='ok'
		const { text } = await runAutoDebug(initial, goal, [fixMsg(repaired)], 3);

		check("Outcome: SUCCESS (L473)", text.includes("Outcome: SUCCESS"), text);
		check("history 含 'Attempt 1: ERROR' (L482)", text.includes("Attempt 1: ERROR"), text);
		check("history 含 'Attempt 2: OK' (L461)", text.includes("Attempt 2: OK"), text);
		check("Final code 已替换为修复码 (L507)", text.includes("Final code:\nprint('healed')"), text);
		check("mock 恰被调用 1 次 (1 次失败 -> 1 次修复)", callCount === 1, `callCount=${callCount}`);

		// 反假绿(a): mock 收到的 context 同时含 systemPrompt 特征 + GOAL + 原始 CODE + NameError.
		check("捕获到 1 条 context", capturedContexts.length === 1, `len=${capturedContexts.length}`);
		const ctx0 = capturedContexts[0];
		const sys = ctx0?.systemPrompt ?? "";
		const userContent = ctx0?.messages?.[0]?.content ?? "";
		check(
			"反假绿: systemPrompt === DEBUG_SYSTEM_PROMPT (含 '你是 Python 调试器')",
			sys.includes(DEBUG_PROMPT_PREFIX),
			JSON.stringify(sys).slice(0, 80),
		);
		check("反假绿: user content 含 'GOAL:' 段", userContent.includes("GOAL:"), userContent.slice(0, 120));
		check("反假绿: user content 含 goal 原文", userContent.includes(goal), userContent.slice(0, 200));
		check("反假绿: user content 含 'CODE:' 段 + 原始错误代码", userContent.includes("CODE:") && userContent.includes("print(missing_var)"), userContent.slice(0, 200));
		check("反假绿: user content 含 'ERROR:' 段 + 真实 NameError 文本", userContent.includes("ERROR:") && userContent.includes("NameError"), userContent);

		// 反假绿(b): SUCCESS 分支 formatResult 含修复码真实 stdout 'healed' => 证明修复码真在 worker 跑过.
		check("反假绿: SUCCESS 文本含真实 stdout 'healed' (修复码真在 uv worker 执行)", text.includes("healed"), text);
		check("反假绿: SUCCESS 文本含 '[ok,' (formatResult ok 尾标)", text.includes("[ok,"), text);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 场景 2: FAILED 耗尽. 每次修复仍报错; max_attempts=2 => attempt1 ERROR -> 修复1次 -> attempt2 ERROR -> L483 break -> FAILED.
	// 分支: L483 attempt===maxAttempts break -> L514-528 FAILED.
	// ─────────────────────────────────────────────────────────────────────────
	section("[场景2] FAILED 耗尽 (L483 break -> L523 FAILED, mock 调用 maxAttempts-1 次)");
	{
		await resetNamespace();
		const initial = "raise RuntimeError('boom1')"; // 真实 error
		const stillBroken = "raise RuntimeError('boom2')"; // 修复后仍 error
		const { text } = await runAutoDebug(initial, "never succeeds", [fixMsg(stillBroken)], 2);

		check("Outcome: FAILED (L523)", text.includes("Outcome: FAILED"), text);
		check("FAILED 文本含 'after 2 attempt(s)'", text.includes("after 2 attempt(s)"), text);
		check("history 含 'Attempt 1: ERROR'", text.includes("Attempt 1: ERROR"), text);
		check("history 含 'Attempt 2: ERROR'", text.includes("Attempt 2: ERROR"), text);
		check("mock 恰被调用 1 次 (maxAttempts-1=1)", callCount === 1, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 场景 3: stopReason error 中止. mock 返回 {stopReason:'error', errorMessage:'boom'}.
	// 分支: L498 stopReason error -> L499 'model failed' -> L500 break -> FAILED.
	// ─────────────────────────────────────────────────────────────────────────
	section("[场景3] stopReason error 中止 (L498 -> L499 'model failed' -> break -> FAILED)");
	{
		await resetNamespace();
		const initial = "raise ValueError('e3')";
		const { text } = await runAutoDebug(initial, "g3", [modelErrorMsg("boom")], 3);

		check("history 含 'model failed' (L499)", text.includes("model failed"), text);
		check("history 含 errorMessage 'boom'", text.includes("boom"), text);
		check("整体 Outcome: FAILED (中止落 L523)", text.includes("Outcome: FAILED"), text);
		check("循环提前中止: 仅 'Attempt 1' 无 'Attempt 2'", text.includes("Attempt 1:") && !text.includes("Attempt 2:"), text);
		check("mock 恰被调用 1 次", callCount === 1, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 场景 4: 空代码中止. mock 返回空 text -> extractCode 提取后空串.
	// 分支: L502 extractCode 空 -> L503 -> L504 'empty code' -> break -> FAILED.
	// ─────────────────────────────────────────────────────────────────────────
	section("[场景4] 空代码中止 (L503 empty -> L504 'empty code' -> break -> FAILED)");
	{
		await resetNamespace();
		const initial = "raise ValueError('e4')";
		const { text } = await runAutoDebug(initial, "g4", [emptyMsg()], 3);

		check("history 含 'empty code' (L504)", text.includes("empty code"), text);
		check("整体 Outcome: FAILED (中止落 L523)", text.includes("Outcome: FAILED"), text);
		check("循环提前中止: 仅 'Attempt 1' 无 'Attempt 2'", text.includes("Attempt 1:") && !text.includes("Attempt 2:"), text);
		check("mock 恰被调用 1 次", callCount === 1, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 场景 6: INCONCLUSIVE (L442). 软超时固定 60s, 触发需真实 sleep(>60s).
	// 默认跳过(代价过高, 与既有 live 同口径); 仅记录原因, 不强凑、不伪报通过.
	// 设环境变量 AUTODBG_RUN_INCONCLUSIVE=1 可显式启用长测.
	// ─────────────────────────────────────────────────────────────────────────
	section("[场景6] INCONCLUSIVE (L442) — 默认跳过(软超时 60s 固定, 需真实 sleep>60s)");
	if (process.env.AUTODBG_RUN_INCONCLUSIVE === "1") {
		await resetNamespace();
		const initial = "import time; time.sleep(70)"; // 阻塞 worker 线程 70s > 60s 软超时 -> RunningHandle
		const { text } = await runAutoDebug(initial, "long", [], 3);
		check("Outcome: INCONCLUSIVE (L452)", text.includes("Outcome: INCONCLUSIVE"), text);
		check("history 含 'TIMED OUT' (L443)", text.includes("TIMED OUT"), text);
		check("INCONCLUSIVE 不请求修复 (mock 未被调用)", callCount === 0, `callCount=${callCount}`);
	} else {
		console.log("  ⊘ 跳过: 触发 L442 软超时固定 60s, 需 import time; time.sleep(70) 真等 60s+, 代价过高.");
		console.log("    设 AUTODBG_RUN_INCONCLUSIVE=1 显式启用长测; 默认不计入 pass/fail, 不伪报.");
	}

	// ── 收尾: 释放 worker(避免泄漏) + 清 mock provider(不动内置 provider) ──
	section("[收尾] dispose worker + unregister mock provider");
	{
		// getManager 单例闭包私有, 无公开 dispose 工具; 通过 session_shutdown 钩子触发 manager.dispose().
		// mockPi.on 是 noop 收不到事件, 故直接复用与回路同一单例: 触发钩子最稳的方式是再注册一个能捕获 handler 的 pi.
		// 实务: KernelManager 是 daemon 子进程, 进程退出即随之 kill; 此处显式 unregister provider 已足够避免 registry 泄漏.
		try {
			unregisterApiProviders(SOURCE_ID);
			check("unregisterApiProviders(SOURCE_ID) 成功", true);
		} catch (err) {
			check("unregisterApiProviders(SOURCE_ID) 成功", false, String(err));
		}
	}

	// ── 汇总 ──
	console.log(`\n${"─".repeat(60)}`);
	console.log(`passed=${passed} failed=${failed}`);
	if (failed === 0) {
		console.log("AUTODEBUG LIVE ALL PASS");
	} else {
		console.log("AUTODEBUG LIVE FAIL");
	}
	// worker daemon 子进程随本进程退出被回收; 显式 exit 避免悬挂句柄拖住进程.
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("\n[FATAL] 未捕获异常:", err);
	try {
		unregisterApiProviders(SOURCE_ID);
	} catch {}
	process.exit(1);
});
