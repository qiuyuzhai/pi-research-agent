/**
 * AutoResearchClaw PIVOT/REFINE/CONTINUE 决策节点
 *
 * 架构来源: 整合后的架构.md — Macro-loop（PIVOT/REFINE）
 * 在关键节点显式问：继续、精炼、还是推翻假设重来？
 * 与 M_I 联动：决策自动写入 episodic memory，防止绕回同一死路。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHECKPOINT_FILE = join(homedir(), ".pi", "research-memory", "checkpoints.jsonl");

type CheckpointDecision = "continue" | "refine" | "pivot";

type CheckpointEntry = {
	id: string;
	timestamp: string;
	direction: string;
	evidence: string;
	decision: CheckpointDecision;
	rationale: string;
	next_action?: string;
	turn_index?: number;
};

const DECISION_ICON: Record<CheckpointDecision, string> = {
	continue: "→ CONTINUE",
	refine: "↻ REFINE",
	pivot: "↑ PIVOT",
};

const DECISION_GUIDANCE: Record<CheckpointDecision, string> = {
	continue:
		"Strong evidence supports current direction. Proceed with deepening experiments.",
	refine:
		"Direction is viable but execution needs adjustment. Keep hypothesis, change methodology.",
	pivot:
		"Current direction is a dead end. Abandon hypothesis, step back to higher-level assumptions.",
};

function ensureCheckpointFile() {
	const dir = join(homedir(), ".pi", "research-memory");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function writeCheckpoint(entry: CheckpointEntry) {
	ensureCheckpointFile();
	appendFileSync(CHECKPOINT_FILE, `${JSON.stringify(entry)}\n`);
}

function generateId(): string {
	return `ck-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function researchCheckpointExtension(pi: ExtensionAPI) {
	let currentTurnIndex = 0;

	pi.on("turn_end", (event) => {
		currentTurnIndex = event.turnIndex;
	});

	pi.registerTool({
		name: "research_checkpoint",
		label: "Research Direction Checkpoint (PIVOT/REFINE/CONTINUE)",
		description:
			"Evaluate the current research direction and make an explicit decision: " +
			"CONTINUE (evidence is strong, keep going), " +
			"REFINE (direction viable but needs adjustment), or " +
			"PIVOT (dead end, abandon hypothesis). " +
			"Call this at major decision points: after adversarial review, after failed experiments, " +
			"or when evidence accumulates. The decision is logged to episodic memory (M_I) " +
			"so future sessions do not repeat the same evaluation.",
		parameters: Type.Object({
			current_direction: Type.String({
				description: "The research direction or hypothesis currently being pursued",
			}),
			evidence_summary: Type.String({
				description:
					"Brief summary of evidence gathered: what worked, what failed, key observations",
			}),
			decision: Type.Union(
				[
					Type.Literal("continue"),
					Type.Literal("refine"),
					Type.Literal("pivot"),
				],
				{
					description:
						"continue: strong evidence, proceed; " +
						"refine: viable direction, fix methodology; " +
						"pivot: dead end, abandon hypothesis",
				},
			),
			rationale: Type.String({
				description: "Why you made this decision. Be specific about the trigger.",
			}),
			next_action: Type.Optional(
				Type.String({
					description:
						"Specific next step: for CONTINUE/REFINE describe what to do next; " +
						"for PIVOT describe the new hypothesis or direction to explore",
				}),
			),
		}),
		async execute(_id, params) {
			const entry: CheckpointEntry = {
				id: generateId(),
				timestamp: new Date().toISOString(),
				direction: params.current_direction,
				evidence: params.evidence_summary,
				decision: params.decision,
				rationale: params.rationale,
				next_action: params.next_action,
				turn_index: currentTurnIndex,
			};

			writeCheckpoint(entry);

			const lines = [
				`CHECKPOINT: ${DECISION_ICON[params.decision]}`,
				`Direction: ${params.current_direction}`,
				`Evidence: ${params.evidence_summary}`,
				`Rationale: ${params.rationale}`,
				`Guidance: ${DECISION_GUIDANCE[params.decision]}`,
			];

			if (params.next_action) {
				lines.push(`Next: ${params.next_action}`);
			}

			if (params.decision === "pivot") {
				lines.push(
					"",
					"ACTION REQUIRED: Use save_research_finding to log this direction as outcome=pivoted " +
						"before starting the new direction. This prevents future sessions from revisiting it.",
				);
			} else if (params.decision === "refine") {
				lines.push(
					"",
					"ACTION REQUIRED: Use save_research_finding to log what specifically needs adjustment " +
						"so the refinement can be tracked across sessions.",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("checkpoint-history", {
		description: "Show recent research checkpoints",
		async handler(_args, ctx) {
			if (!existsSync(CHECKPOINT_FILE)) {
				ctx.ui.notify("No checkpoints recorded yet.", "info");
				return;
			}
			const entries: CheckpointEntry[] = readFileSync(CHECKPOINT_FILE, "utf-8")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => {
					try {
						return JSON.parse(l) as CheckpointEntry;
					} catch {
						return null;
					}
				})
				.filter((e): e is CheckpointEntry => e !== null)
				.slice(-10);

			const lines = [`Last ${entries.length} checkpoint(s):`];
			for (const e of entries) {
				lines.push(`[${e.timestamp.slice(0, 10)}] ${DECISION_ICON[e.decision]}: ${e.direction.slice(0, 60)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
