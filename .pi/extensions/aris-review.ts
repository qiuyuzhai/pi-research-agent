/**
 * ARIS 对抗评审扩展
 *
 * 架构来源: 整合后的架构.md — 质量层（ARIS 对抗评审）
 * 触发时机: 假设生成后 / 实验结论后 / 最终报告前
 * 机制: 主 agent 输出 → 使用当前模型以 critic system prompt 批判中间产物
 *       → 主 agent 根据 review 决定是否触发 PIVOT
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { Context, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function extractTextContent(content: (TextContent | ThinkingContent | ToolCall)[]): string {
	return content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

export default function arisReviewExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "adversarial_review",
		label: "ARIS Adversarial Review",
		description:
			"Trigger an adversarial review of a hypothesis, finding, or conclusion. " +
			"A critic agent will challenge the claim for logical flaws, missing evidence, " +
			"alternative explanations, and reproducibility issues. " +
			"Call this before committing to a research direction or reporting a result. " +
			"If verdict is CHALLENGED or REFUTED, use research_checkpoint to decide PIVOT/REFINE.",
		parameters: Type.Object({
			claim: Type.String({
				description: "The hypothesis, finding, or conclusion to review. Be precise and complete.",
			}),
			context: Type.Optional(
				Type.String({
					description: "Supporting evidence, methodology, or data. Include all relevant detail.",
				}),
			),
			review_type: Type.Union(
				[
					Type.Literal("hypothesis"),
					Type.Literal("experimental_result"),
					Type.Literal("conclusion"),
					Type.Literal("methodology"),
				],
				{ description: "What kind of claim is being reviewed?" },
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!ctx.model) {
				return {
					content: [{ type: "text", text: "Error: no model available for adversarial review." }],
					details: undefined,
					isError: true,
				};
			}

			const userContent = [
				`REVIEW TYPE: ${params.review_type.toUpperCase()}`,
				"",
				`CLAIM:\n${params.claim}`,
				params.context ? `\nEVIDENCE/CONTEXT:\n${params.context}` : "",
			]
				.filter(Boolean)
				.join("\n");

			const context: Context = {
				systemPrompt: CRITIC_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: userContent,
						timestamp: Date.now(),
					},
				],
			};

			try {
				const result = await completeSimple(ctx.model, context, { signal });

				if (result.stopReason === "error" || result.stopReason === "aborted") {
					return {
						content: [{ type: "text", text: `ARIS review failed: ${result.errorMessage ?? result.stopReason}` }],
						details: undefined,
						isError: true,
					};
				}

				const reviewText = extractTextContent(result.content);
				const hasVerdict = /VERDICT:\s*(VALID|CHALLENGED|REFUTED)/i.test(reviewText);

				const output = [
					"=== ARIS ADVERSARIAL REVIEW ===",
					`Claim type: ${params.review_type}`,
					"",
					reviewText,
					hasVerdict ? "" : "\nNote: No explicit VERDICT found in review.",
				]
					.filter((l) => l !== undefined)
					.join("\n");

				return {
					content: [{ type: "text", text: output }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `ARIS review error: ${err instanceof Error ? err.message : String(err)}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("aris-help", {
		description: "Show ARIS adversarial review usage",
		async handler(_args, ctx) {
			ctx.ui.notify(
				[
					"ARIS Adversarial Review",
					"Tool: adversarial_review(claim, context?, review_type)",
					"",
					"Verdicts:",
					"  VALID     — claim withstands scrutiny",
					"  CHALLENGED — significant gaps, needs more evidence",
					"  REFUTED   — logical flaws, abandon or major revision",
					"",
					"After CHALLENGED/REFUTED: use research_checkpoint to PIVOT or REFINE",
				].join("\n"),
				"info",
			);
		},
	});
}
