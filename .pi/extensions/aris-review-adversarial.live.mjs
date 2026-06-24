#!/usr/bin/env node
// aris-review-adversarial.live.mjs — FR-8 adversarial_review 对抗评审 mock-model 真实链路测试
//
// 运行(让 tsconfig paths 把 @earendil-works/pi-ai 重定向到 packages/ai/src, 免构建 dist):
//   TSX_TSCONFIG_PATH=/home/aaron/project1/pi/tsconfig.json \
//     node --import tsx /home/aaron/project1/pi/.pi/extensions/aris-review-adversarial.live.mjs
//
// 策略 = 零侵入(绝不改 aris-review.ts 或任何 Pi 源码):
//   - import default arisReviewExtension, 用 mock pi 捕获 adversarial_review.execute
//   - registerApiProvider 注册 DUCK-TYPE mock provider: streamSimple 从队列 shift 一条 mock
//     AssistantMessage 返回 {result: async()=>msg}, completeSimple 只调 .result() 一次即穿透
//     (实证: packages/ai/src/stream.ts:67 completeSimple = streamSimple().result())
//   - aris execute 只读 ctx.model(L71), 不读 ctx.cwd, 无 uv worker, 单次 completeSimple
//   - 反假绿: streamSimple 把收到的 context 推入 captured, 断言 systemPrompt/REVIEW TYPE/CLAIM/
//     EVIDENCE 真被回灌; VERDICT 三态(有/无/小写)区分 Note 分支, 证明 L111 正则真在解析.
//
// 与 FR-3 auto_debug live 互补: 本脚本专注 aris 的 VERDICT 正则判别 + 两条 isError 路径区分.

import {
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai";
import arisReviewExtension from "/home/aaron/project1/pi/.pi/extensions/aris-review.ts";

// aris-review.ts:15 CRITIC_SYSTEM_PROMPT 是模块常量但未 export; 反假绿断言用其特征前缀 + 完整原文.
// 逐字对齐 aris-review.ts:15-31 (用于精确比对 captured[0].systemPrompt)。
const CRITIC_SYSTEM_PROMPT = `You are an adversarial scientific reviewer (ARIS — Adversarial Research and Integrity System).

Your sole purpose: find flaws in the provided claim/hypothesis/conclusion.

For each review, you MUST:
1. Identify specific logical flaws or gaps in reasoning
2. List unwarranted assumptions explicitly
3. Demand missing evidence or controls
4. Propose the most compelling alternative explanation
5. Check reproducibility: is this claim testable?
6. Deliver a final verdict: VALID / CHALLENGED / REFUTED

Rules:
- Be specific, not vague. Name the exact flaw.
- Do not hedge. If it looks wrong, say it's wrong.
- Do not summarize the claim back; go straight to critique.
- End with: VERDICT: VALID | CHALLENGED | REFUTED and one-line justification.`;
// 特征串(即便源码后续微调首句保持不变, 仍能命中) — aris-review.ts:15。
const CRITIC_PROMPT_FEATURE = "adversarial scientific reviewer (ARIS";

const MOCK_API = "mock-aris-fr8"; // 独一无二, 不与内置 provider key 冲突
const SOURCE_ID = "aris-fr8-live"; // sourceId 供精确 unregister, 不动内置 provider

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

// ── mock model: 回路只触碰 model.api(选 provider, wrapStreamSimple 校验严格相等) 与
//    model.provider(withEnvApiKey -> getEnvApiKey 无 key 原样返回 undefined => 零 env 零网络) ──
const mockModel = { api: MOCK_API, provider: MOCK_API };

// ── mock AssistantMessage 工厂: aris 只读 .stopReason / .content / .errorMessage; 余字段占位补全 ──
function baseMsg(extra) {
	return {
		role: "assistant",
		api: MOCK_API,
		provider: MOCK_API,
		model: "mock-aris-model",
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
// (1) 成功评审: stopReason 'stop' + 一段批判文本(extractTextContent 取 type==='text' 拼接)
function reviewMsg(text) {
	return baseMsg({
		stopReason: "stop",
		content: [{ type: "text", text }],
	});
}
// (2) 模型失败(stopReason 分支): stopReason 'error' + errorMessage -> L102 "ARIS review failed: ..."
function stopErrorMsg(reason) {
	return baseMsg({ stopReason: "error", errorMessage: reason, content: [] });
}

// ── mock provider: DUCK-TYPE streamSimple 返回 {result: async()=>msg}; 记录 context 反假绿 ──
//    特殊: 某些场景需让 result() 自身抛异常(走 aris 最外层 catch, L127) -> 用 thrower 哨兵实现.
let queue = []; // 按 completeSimple 调用顺序出队; 元素为 msg 或 {__throw: Error}
const captured = []; // 每次 streamSimple 收到的 context 存档(反假绿)
let callCount = 0;

registerApiProvider(
	{
		api: MOCK_API,
		// register 要求 stream 存在(wrapStream 引用), 但 completeSimple 只走 streamSimple; 给永不调用的桩.
		stream: () => {
			throw new Error("mock.stream should not be called in completeSimple path");
		},
		streamSimple: (_model, context, _options) => {
			callCount++;
			captured.push(context);
			const item = queue.shift();
			if (item === undefined) {
				throw new Error("mock queue exhausted (unexpected extra completeSimple call)");
			}
			// result() 抛异常分支: completeSimple 内 await s.result() 把异常上抛 -> aris 最外层 catch.
			if (item && item.__throw instanceof Error) {
				return {
					result: async () => {
						throw item.__throw;
					},
				};
			}
			return { result: async () => item };
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
arisReviewExtension(mockPi);

const adversarialReview = tools["adversarial_review"];

const noopUpdate = () => {};

// 调一次 adversarial_review.execute, 返回 {text, res}。queueItems 入队 mock 返回; ctxOverrides 覆盖 ctx。
async function runReview(params, queueItems, ctxOverrides) {
	queue = queueItems.slice();
	callCount = 0;
	captured.length = 0;
	const ctx = ctxOverrides === undefined ? { model: mockModel } : ctxOverrides;
	const res = await adversarialReview.execute(
		"call",
		params,
		new AbortController().signal,
		noopUpdate,
		ctx,
	);
	const text = res?.content?.[0]?.text ?? "";
	return { text, res };
}

async function main() {
	console.log("=== FR-8 adversarial_review 对抗评审 mock-model live 测试 ===");
	console.log("(零 env 零网络: getEnvApiKey(mock-api) 返回 undefined; 单次 completeSimple, 无 uv worker)\n");

	if (typeof adversarialReview?.execute !== "function") {
		console.error("[FATAL] adversarial_review 工具未注册或无 execute; 终止.");
		unregisterApiProviders(SOURCE_ID);
		process.exit(1);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// S1: 无 model. ctx 不含 model -> L71 早退 isError, 不触链路.
	// ─────────────────────────────────────────────────────────────────────────
	section("[S1] 无 model -> L71 早退 isError (不触 completeSimple, callCount===0)");
	{
		const { text, res } = await runReview(
			{ claim: "irrelevant", review_type: "hypothesis" },
			[reviewMsg("should never be consumed")], // 入队但因早退不会被取
			{}, // ctx 无 model
		);
		check("res.isError === true", res?.isError === true, JSON.stringify(res?.isError));
		check("文本含 'no model available'", text.includes("no model available"), text);
		check("未触发 completeSimple (callCount===0)", callCount === 0, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// S2: VERDICT REFUTED 主路径 + 反假绿(核心). review_type=conclusion, 带 context 字段.
	//     分支: L100 completeSimple -> L102 非 error -> L110 extractText -> L111 正则命中 ->
	//           L118 hasVerdict true => 不追加 Note.
	// ─────────────────────────────────────────────────────────────────────────
	section("[S2] VERDICT REFUTED 主路径 + 反假绿回灌 (callCount===1)");
	{
		const claimText = "Transformer attention is causally interpretable end to end.";
		const contextText = "Ablation on 3 heads; n=12; no control group; single seed.";
		const reviewText = [
			"The claim conflates correlation in attention weights with causal mechanism.",
			"Unwarranted assumption: head ablation isolates a single circuit.",
			"Missing control: no randomized-seed baseline; n=12 underpowered.",
			"Alternative: observed effect is a confound of layernorm scaling.",
			"VERDICT: REFUTED — causal claim unsupported by the presented ablation.",
		].join("\n");

		const { text, res } = await runReview(
			{ claim: claimText, context: contextText, review_type: "conclusion" },
			[reviewMsg(reviewText)],
			undefined, // 默认 {model: mockModel}
		);

		// (a) 标题段
		check("(a) 输出含 '=== ARIS ADVERSARIAL REVIEW ===' 标题段", text.includes("=== ARIS ADVERSARIAL REVIEW ==="), text.slice(0, 80));
		// (b) mock reviewText 原文片段
		check("(b) 含 mock reviewText 原文片段 ('conflates correlation')", text.includes("conflates correlation"), text);
		// (c) VERDICT: REFUTED
		check("(c) 含 'VERDICT: REFUTED'", text.includes("VERDICT: REFUTED"), text);
		// (d) Note 不出现
		check("(d) 不含 'No explicit VERDICT found' (hasVerdict 真 => 无 Note)", !text.includes("No explicit VERDICT found"), text);
		// 非 isError
		check("主路径 res.isError 非真(undefined)", !res?.isError, JSON.stringify(res?.isError));

		// 反假绿回灌: captured[0] 证明 mock 确经 aris-review.ts 真实链路被调用, 非测试自洽.
		check("捕获到 1 条 context", captured.length === 1, `len=${captured.length}`);
		const ctx0 = captured[0];
		const sys = ctx0?.systemPrompt ?? "";
		const userContent = ctx0?.messages?.[0]?.content ?? "";
		check(
			"反假绿: systemPrompt 严格等于 CRITIC_SYSTEM_PROMPT",
			sys === CRITIC_SYSTEM_PROMPT,
			JSON.stringify(sys).slice(0, 100),
		);
		check(
			"反假绿: systemPrompt 含特征串 'adversarial scientific reviewer (ARIS'",
			sys.includes(CRITIC_PROMPT_FEATURE),
			JSON.stringify(sys).slice(0, 100),
		);
		check("反假绿: messages[0].role === 'user'", ctx0?.messages?.[0]?.role === "user", JSON.stringify(ctx0?.messages?.[0]?.role));
		// REVIEW TYPE 大写 => 证明 review_type.toUpperCase() (L80) 生效
		check(
			"反假绿: user content 含 'REVIEW TYPE: CONCLUSION' (toUpperCase 生效)",
			userContent.includes("REVIEW TYPE: CONCLUSION"),
			userContent.slice(0, 120),
		);
		check("反假绿: user content 含 'CLAIM:' 段", userContent.includes("CLAIM:"), userContent.slice(0, 200));
		check("反假绿: user content 含 claim 原文", userContent.includes(claimText), userContent.slice(0, 300));
		check("反假绿: user content 含 'EVIDENCE/CONTEXT:' 段", userContent.includes("EVIDENCE/CONTEXT:"), userContent);
		check("反假绿: user content 含 context 原文", userContent.includes(contextText), userContent);
		// 调用次数
		check("反假绿: callCount === 1", callCount === 1, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// S3: 无 VERDICT. mock 返回完全不含 VERDICT 字样 -> L111 正则不命中 -> L118 追加 Note.
	// ─────────────────────────────────────────────────────────────────────────
	section("[S3] 无 VERDICT -> Note 分支 (L118 追加, callCount===1)");
	{
		const reviewText = "This review wanders without committing to any decision or label whatsoever.";
		const { text, res } = await runReview(
			{ claim: "some claim", review_type: "hypothesis" },
			[reviewMsg(reviewText)],
			undefined,
		);
		check("含 mock reviewText 原文片段", text.includes("wanders without committing"), text);
		check("含 'Note: No explicit VERDICT found in review.'", text.includes("Note: No explicit VERDICT found in review."), text);
		check("主路径 res.isError 非真", !res?.isError, JSON.stringify(res?.isError));
		check("callCount === 1", callCount === 1, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// S4: 小写 verdict. mock 返回含 "verdict: challenged" -> L111 正则 /i 命中 -> 不加 Note.
	//     若正则漏 /i, 这里会误判无 verdict 而加 Note -> 转红, 故是 /i 真生效的判别点.
	// ─────────────────────────────────────────────────────────────────────────
	section("[S4] 小写 'verdict: challenged' -> 不加 Note (证明 L111 正则 /i 真生效, callCount===1)");
	{
		const reviewText = "The methodology has gaps in sampling.\nverdict: challenged — needs a control arm.";
		const { text, res } = await runReview(
			{ claim: "lowercase claim", review_type: "methodology" },
			[reviewMsg(reviewText)],
			undefined,
		);
		check("含 mock reviewText 原文片段 ('verdict: challenged')", text.includes("verdict: challenged"), text);
		check("不含 'No explicit VERDICT found' (/i 命中小写 => 无 Note)", !text.includes("No explicit VERDICT found"), text);
		check("主路径 res.isError 非真", !res?.isError, JSON.stringify(res?.isError));
		check("callCount === 1", callCount === 1, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// S5: stopReason error. mock 返回 {stopReason:'error', errorMessage:'model-boom', content:[]}.
	//     分支: L102 stopReason==='error' -> L104 "ARIS review failed: model-boom" -> isError.
	// ─────────────────────────────────────────────────────────────────────────
	section("[S5] stopReason error -> L104 'ARIS review failed: model-boom' (stopReason 路径)");
	{
		const { text, res } = await runReview(
			{ claim: "c5", review_type: "experimental_result" },
			[stopErrorMsg("model-boom")],
			undefined,
		);
		check("res.isError === true", res?.isError === true, JSON.stringify(res?.isError));
		check("文本含 'ARIS review failed: model-boom'", text.includes("ARIS review failed: model-boom"), text);
		// 判别力: 是 'review failed' 前缀而非 'review error' 前缀
		check("文本不含 'ARIS review error' (区分 catch 路径)", !text.includes("ARIS review error"), text);
		check("callCount === 1", callCount === 1, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// S6: result() 抛异常. mock streamSimple 返回 {result: async()=>{throw Error('network-down')}}.
	//     分支: completeSimple 内 await s.result() 上抛 -> aris L127 最外层 catch ->
	//           L129 "ARIS review error: network-down" -> isError. 与 S5 是两条不同 isError 路径.
	// ─────────────────────────────────────────────────────────────────────────
	section("[S6] result() 抛异常 -> L129 'ARIS review error: network-down' (最外层 catch 路径)");
	{
		const { text, res } = await runReview(
			{ claim: "c6", review_type: "conclusion" },
			[{ __throw: new Error("network-down") }],
			undefined,
		);
		check("res.isError === true", res?.isError === true, JSON.stringify(res?.isError));
		check("文本含 'ARIS review error: network-down'", text.includes("ARIS review error: network-down"), text);
		// 判别力: 是 'review error' 前缀而非 'review failed' 前缀 (与 S5 区分两条路径)
		check("文本不含 'ARIS review failed' (区分 stopReason 路径)", !text.includes("ARIS review failed"), text);
		check("callCount === 1", callCount === 1, `callCount=${callCount}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// S7: 无 context 字段. mock 任意成功返回 -> L83 三元假分支 => user content 不应出现 EVIDENCE/CONTEXT.
	// ─────────────────────────────────────────────────────────────────────────
	section("[S7] 无 context 字段 -> user content 不含 EVIDENCE/CONTEXT (L83 可选拼接, callCount===1)");
	{
		const { res } = await runReview(
			{ claim: "claim without context", review_type: "hypothesis" }, // 无 context 字段
			[reviewMsg("Some critique.\nVERDICT: VALID — fine.")],
			undefined,
		);
		check("捕获到 1 条 context", captured.length === 1, `len=${captured.length}`);
		const userContent = captured[0]?.messages?.[0]?.content ?? "";
		check("user content 含 'CLAIM:' 段(基线拼接仍在)", userContent.includes("CLAIM:"), userContent.slice(0, 200));
		check("user content 含 claim 原文", userContent.includes("claim without context"), userContent.slice(0, 200));
		check("反假绿: user content 不含 'EVIDENCE/CONTEXT'", !userContent.includes("EVIDENCE/CONTEXT"), userContent);
		check("主路径 res.isError 非真", !res?.isError, JSON.stringify(res?.isError));
		check("callCount === 1", callCount === 1, `callCount=${callCount}`);
	}

	// ── 收尾: 清 mock provider(精确 unregister, 不动内置 provider) ──
	section("[收尾] unregister mock provider (不动内置 provider)");
	{
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
		console.log("ARIS LIVE ALL PASS");
	} else {
		console.log("ARIS LIVE FAIL");
	}
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("\n[FATAL] 未捕获异常:", err);
	try {
		unregisterApiProviders(SOURCE_ID);
	} catch {}
	process.exit(1);
});
