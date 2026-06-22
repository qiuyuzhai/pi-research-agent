/**
 * EvoScientist 双记忆模块
 *
 * M_I (Episodic Memory): 研究方向轨迹，含失败方向，跨 session 增长
 * M_E (Experiment Memory): 代码轨迹、执行结果、最优实现，跨 session 增长
 *
 * 存储位置: ~/.pi/research-memory/{episodic,experiments}.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MEMORY_DIR = join(homedir(), ".pi", "research-memory");
const M_I_FILE = join(MEMORY_DIR, "episodic.jsonl");
const M_E_FILE = join(MEMORY_DIR, "experiments.jsonl");

const MAX_INJECT_EPISODIC = 8;
const MAX_INJECT_EXPERIMENTS = 4;
const RELEVANCE_TERMS_LIMIT = 5;

type EpisodicType = "hypothesis" | "direction" | "finding" | "failure";
type EpisodicOutcome = "success" | "failure" | "ongoing" | "pivoted";

type EpisodicEntry = {
	id: string;
	timestamp: string;
	type: EpisodicType;
	content: string;
	tags: string[];
	outcome: EpisodicOutcome;
};

type ExperimentOutcome = "success" | "failure" | "inconclusive";

type ExperimentEntry = {
	id: string;
	timestamp: string;
	title: string;
	description: string;
	code?: string;
	parameters?: Record<string, unknown>;
	result?: string;
	outcome: ExperimentOutcome;
	tags: string[];
};

function ensureDir() {
	if (!existsSync(MEMORY_DIR)) {
		mkdirSync(MEMORY_DIR, { recursive: true });
	}
}

function loadEntries<T>(filePath: string): T[] {
	if (!existsSync(filePath)) return [];
	const lines = readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim());
	const entries: T[] = [];
	for (const line of lines) {
		try {
			entries.push(JSON.parse(line) as T);
		} catch {
			// skip malformed lines
		}
	}
	return entries;
}

function writeEntry(filePath: string, entry: unknown) {
	ensureDir();
	appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function scoreRelevance<T extends { content?: string; description?: string; title?: string; tags?: string[] }>(
	entry: T,
	terms: string[],
): number {
	const text = [entry.content, entry.description, entry.title, ...(entry.tags ?? [])].join(" ").toLowerCase();
	return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

function selectRelevant<T extends { content?: string; description?: string; title?: string; tags?: string[] }>(
	entries: T[],
	query: string,
	limit: number,
): T[] {
	if (!query.trim() || entries.length === 0) return entries.slice(-limit);

	const terms = query
		.toLowerCase()
		.split(/\W+/)
		.filter((t) => t.length > 2)
		.slice(0, RELEVANCE_TERMS_LIMIT);

	if (terms.length === 0) return entries.slice(-limit);

	return entries
		.map((e) => ({ entry: e, score: scoreRelevance(e, terms) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ entry }) => entry);
}

function buildMemoryContext(query: string): string {
	const episodic = loadEntries<EpisodicEntry>(M_I_FILE);
	const experiments = loadEntries<ExperimentEntry>(M_E_FILE);

	if (episodic.length === 0 && experiments.length === 0) return "";

	const relevantEpisodic = selectRelevant(episodic, query, MAX_INJECT_EPISODIC);
	const relevantExperiments = selectRelevant(experiments, query, MAX_INJECT_EXPERIMENTS);

	const lines: string[] = ["<research_memory>"];

	if (relevantEpisodic.length > 0) {
		lines.push("## M_I: Episodic Memory (Research Directions)");
		for (const e of relevantEpisodic) {
			lines.push(`- [${e.type}/${e.outcome}] ${e.content}${e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""}`);
		}
	}

	if (relevantExperiments.length > 0) {
		lines.push("## M_E: Experiment Memory");
		for (const e of relevantExperiments) {
			lines.push(`- [${e.outcome}] **${e.title}**: ${e.description}`);
			if (e.result) lines.push(`  → ${e.result}`);
		}
	}

	lines.push("</research_memory>");
	return lines.join("\n");
}

export default function researchMemoryExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const ctx = buildMemoryContext(event.prompt.slice(0, 300));
		if (!ctx) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${ctx}`,
		};
	});

	pi.registerTool({
		name: "save_research_finding",
		label: "Save Research Finding (M_I)",
		description:
			"Save a research hypothesis, direction, finding, or failure to long-term episodic memory (M_I). " +
			"Call this proactively whenever you: reach a conclusion, discover a direction is a dead end, " +
			"validate or invalidate a hypothesis. Memories persist across sessions.",
		parameters: Type.Object({
			type: Type.Union(
				[
					Type.Literal("hypothesis"),
					Type.Literal("direction"),
					Type.Literal("finding"),
					Type.Literal("failure"),
				],
				{ description: "Type: hypothesis (to test), direction (research path), finding (validated), failure (dead end)" },
			),
			content: Type.String({ description: "The finding to save. Be specific and self-contained." }),
			outcome: Type.Union(
				[
					Type.Literal("success"),
					Type.Literal("failure"),
					Type.Literal("ongoing"),
					Type.Literal("pivoted"),
				],
				{ description: "Current status of this direction" },
			),
			tags: Type.Array(Type.String(), { description: "Keywords for future retrieval (topic, method, domain)" }),
		}),
		async execute(_id, params) {
			const entry: EpisodicEntry = {
				id: generateId("ep"),
				timestamp: new Date().toISOString(),
				type: params.type,
				content: params.content,
				outcome: params.outcome,
				tags: params.tags,
			};
			writeEntry(M_I_FILE, entry);
			return {
				content: [{ type: "text", text: `[M_I] Saved ${entry.type}/${entry.outcome}: ${entry.content.slice(0, 80)}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "save_experiment",
		label: "Save Experiment Result (M_E)",
		description:
			"Save an experiment result (code, parameters, output) to long-term experiment memory (M_E). " +
			"Call after running any computation, simulation, or analysis so the results persist across sessions " +
			"and can be reused or compared in future work.",
		parameters: Type.Object({
			title: Type.String({ description: "Short descriptive title" }),
			description: Type.String({ description: "What was tested or computed" }),
			code: Type.Optional(Type.String({ description: "The key code snippet that was run" })),
			parameters: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), { description: "Key parameters (hyperparams, config, inputs)" }),
			),
			result: Type.Optional(Type.String({ description: "Key quantitative or qualitative results" })),
			outcome: Type.Union(
				[Type.Literal("success"), Type.Literal("failure"), Type.Literal("inconclusive")],
				{ description: "Was the experiment successful?" },
			),
			tags: Type.Array(Type.String(), { description: "Keywords for future retrieval" }),
		}),
		async execute(_id, params) {
			const entry: ExperimentEntry = {
				id: generateId("exp"),
				timestamp: new Date().toISOString(),
				title: params.title,
				description: params.description,
				code: params.code,
				parameters: params.parameters,
				result: params.result,
				outcome: params.outcome,
				tags: params.tags,
			};
			writeEntry(M_E_FILE, entry);
			return {
				content: [{ type: "text", text: `[M_E] Saved [${entry.outcome}] ${entry.title}` }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("memory-search", {
		description: "Search research memories. Usage: /memory-search <keywords>",
		async handler(query, ctx) {
			if (!query.trim()) {
				ctx.ui.notify("/memory-search requires keywords", "warning");
				return;
			}
			const episodic = loadEntries<EpisodicEntry>(M_I_FILE);
			const experiments = loadEntries<ExperimentEntry>(M_E_FILE);
			const matchedEp = selectRelevant(episodic, query, 5);
			const matchedEx = selectRelevant(experiments, query, 3);

			const lines = [`Search: "${query}" → ${matchedEp.length} M_I + ${matchedEx.length} M_E`];
			for (const e of matchedEp) {
				lines.push(`[M_I/${e.type}/${e.outcome}] ${e.content.slice(0, 100)}`);
			}
			for (const e of matchedEx) {
				lines.push(`[M_E/${e.outcome}] ${e.title}: ${e.description.slice(0, 80)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("memory-stats", {
		description: "Show research memory statistics",
		async handler(_args, ctx) {
			const episodic = loadEntries<EpisodicEntry>(M_I_FILE);
			const experiments = loadEntries<ExperimentEntry>(M_E_FILE);
			const epOutcomes = episodic.reduce(
				(acc, e) => {
					acc[e.outcome] = (acc[e.outcome] ?? 0) + 1;
					return acc;
				},
				{} as Record<string, number>,
			);
			const lines = [
				`Research Memory (${MEMORY_DIR})`,
				`M_I (episodic): ${episodic.length} entries — ${JSON.stringify(epOutcomes)}`,
				`M_E (experiments): ${experiments.length} entries`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("memory-clear-experiments", {
		description: "Clear all experiment memory (M_E). Irreversible.",
		async handler(_args, ctx) {
			const confirmed = await ctx.ui.confirm(
				"Clear Experiment Memory",
				`Delete all ${loadEntries<ExperimentEntry>(M_E_FILE).length} experiment entries from M_E?`,
			);
			if (!confirmed) return;
			writeFileSync(M_E_FILE, "");
			ctx.ui.notify("M_E cleared.", "info");
		},
	});
}
