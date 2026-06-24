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
import { completeSimple } from "@earendil-works/pi-ai";
import type { Context, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codeHash, cosine, embed, hybridScore, resolveEmbeddingProvider } from "./_lib/embedding.ts";

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
	// ——— 现有字段，保留不动 ———
	id: string;
	timestamp: string;
	title: string;
	description: string;
	code?: string;
	parameters?: Record<string, unknown>;
	result?: string;
	outcome: ExperimentOutcome;
	tags: string[];

	// ——— FR-4 新增（全部可选 → 老 jsonl 零迁移可读）———
	source?: "auto" | "manual";
	stdout?: string;
	durationMs?: number;
	key_metrics?: Record<string, number | string>;
	is_best?: boolean;
	codeHash?: string;
	embedding?: number[];
	embeddingModel?: string;
	embeddingDim?: number;
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

// 全量覆盖重写 M_E（mark_best / reembed 用；保持每行一条 JSON）。
function rewriteExperiments(entries: ExperimentEntry[]) {
	ensureDir();
	writeFileSync(M_E_FILE, entries.length ? `${entries.map((e) => JSON.stringify(e)).join("\n")}\n` : "");
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── FR-4: embedding 源文本 —— 从已存字段重组，换模型时 /memory-reembed 可重算，无需另存 ──
export function buildEmbedText(
	e: Pick<ExperimentEntry, "title" | "description" | "key_metrics" | "tags">,
): string {
	const parts: string[] = [e.title, e.description];
	if (e.key_metrics && Object.keys(e.key_metrics).length > 0) {
		parts.push(
			Object.entries(e.key_metrics)
				.map(([k, v]) => `${k}=${v}`)
				.join(", "),
		);
	}
	if (e.tags && e.tags.length > 0) parts.push(e.tags.join(", "));
	return parts.filter((p) => p && p.trim()).join(". ");
}

// ── FR-4: 解析 run_python 的 tool_result 文本（research-kernel.ts formatResult 输出）──
// 返回 null = RUNNING / 不可解析 → 跳过归档。
export interface KernelOutcome {
	outcome: ExperimentOutcome;
	stdout: string;
	durationMs?: number;
}

export function parseKernelResult(text: string, isError: boolean): KernelOutcome | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("RUNNING:") || trimmed.startsWith("STILL RUNNING:")) return null;
	if (isError) {
		// kernel 级异常（worker 不可用等）→ inconclusive，全文当 stdout
		return { outcome: "inconclusive", stdout: trimmed };
	}
	const lines = trimmed.split("\n");
	const last = lines[lines.length - 1];
	const ok = last.match(/^\[ok,\s*(\d+)ms\]$/);
	const err = last.match(/^\[error:\s*[^,]+,\s*(\d+)ms\]$/);
	if (ok) {
		return { outcome: "success", stdout: lines.slice(0, -1).join("\n").trim(), durationMs: Number(ok[1]) };
	}
	if (err) {
		return { outcome: "failure", stdout: lines.slice(0, -1).join("\n").trim(), durationMs: Number(err[1]) };
	}
	// 无 [ok/error] 标记（理论不该出现）→ inconclusive
	return { outcome: "inconclusive", stdout: trimmed };
}

// ── FR-4: LLM 抽取（一次 completeSimple 同时产出 summary + key_metrics + title + tags）──
const EXTRACTION_SYSTEM_PROMPT = `You extract structured metadata from a Python experiment run. Given CODE and OUTPUT, respond with ONLY a single JSON object (no markdown fences, no prose) of shape:
{"title": string, "summary": string, "key_metrics": {<name>: number|string, ...}, "tags": string[]}
- title: <= 8 words naming what the experiment does.
- summary: one sentence on what happened / what the result means.
- key_metrics: numeric or short scalar results parsed from OUTPUT (loss, accuracy, runtime, p_value, ...). Empty object if none.
- tags: 2-5 lowercase keywords (method / domain).`;

const EXTRACTION_CLIP = 4000;

export function buildExtractionContext(code: string, stdout: string): Context {
	const clip = (s: string) => (s.length > EXTRACTION_CLIP ? `${s.slice(0, EXTRACTION_CLIP)}\n...[truncated]` : s);
	return {
		systemPrompt: EXTRACTION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: `CODE:\n${clip(code)}\n\nOUTPUT:\n${clip(stdout)}`,
				timestamp: Date.now(),
			},
		],
	};
}

export interface Extraction {
	title?: string;
	summary?: string;
	key_metrics?: Record<string, number | string>;
	tags?: string[];
}

// 容错解析 LLM 文本（可能带 ```json``` 围栏或前后杂质）；失败返 null。
export function parseExtractionResponse(text: string): Extraction | null {
	const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	const raw = (fenced ? fenced[1] : text).trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof obj !== "object" || obj === null) return null;
	const o = obj as Record<string, unknown>;
	const out: Extraction = {};
	if (typeof o["title"] === "string") out.title = o["title"];
	if (typeof o["summary"] === "string") out.summary = o["summary"];
	if (o["key_metrics"] && typeof o["key_metrics"] === "object" && !Array.isArray(o["key_metrics"])) {
		const m: Record<string, number | string> = {};
		for (const [k, v] of Object.entries(o["key_metrics"] as Record<string, unknown>)) {
			if (typeof v === "number" || typeof v === "string") m[k] = v;
		}
		out.key_metrics = m;
	}
	if (Array.isArray(o["tags"])) out.tags = (o["tags"] as unknown[]).filter((t): t is string => typeof t === "string");
	return out;
}

// ── FR-4: 通用超时包装（绝不抛；超时/失败返回 fallback）──
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		if (typeof (timer as { unref?: () => void }).unref === "function") {
			(timer as { unref?: () => void }).unref?.();
		}
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			},
		);
	});
}

const ARCHIVE_TIMEOUT_MS = 5000;

// 自动归档单条实验。embed/LLM 失败或超时绝不抛；同 codeHash 已存在则跳过（返回 null）。
export async function archiveExperiment(
	code: string,
	parsed: KernelOutcome,
	model: ExtensionContext["model"],
	signal: AbortSignal | undefined,
): Promise<ExperimentEntry | null> {
	const hash = codeHash(code);
	const existing = loadEntries<ExperimentEntry>(M_E_FILE);
	if (existing.some((e) => e.codeHash === hash)) return null;

	// (1) LLM 抽取（带超时，绝不阻断）
	let extraction: Extraction | null = null;
	if (model) {
		extraction = await withTimeout(
			(async (): Promise<Extraction | null> => {
				try {
					const res = await completeSimple(model, buildExtractionContext(code, parsed.stdout), { signal });
					if (res.stopReason === "error" || res.stopReason === "aborted") return null;
					const txt = res.content
						.filter((b): b is TextContent => b.type === "text")
						.map((b) => b.text)
						.join("\n");
					return parseExtractionResponse(txt);
				} catch {
					return null;
				}
			})(),
			ARCHIVE_TIMEOUT_MS,
			null,
		);
	}

	const title = extraction?.title?.trim() || `Experiment ${new Date().toISOString().slice(0, 19)}`;
	const description =
		extraction?.summary?.trim() || parsed.stdout.split("\n")[0]?.slice(0, 120) || "(no output)";
	const tags = extraction?.tags ?? [];
	const key_metrics = extraction?.key_metrics;

	// (2) embedding（embed 内置 5s 超时，绝不抛）
	let embedding: number[] | undefined;
	let embeddingModel: string | undefined;
	let embeddingDim: number | undefined;
	const provider = resolveEmbeddingProvider();
	if (provider) {
		const r = await embed(buildEmbedText({ title, description, key_metrics, tags }), provider, signal);
		if (r) {
			embedding = r.vector;
			embeddingModel = r.model;
			embeddingDim = r.dim;
		}
	}

	const entry: ExperimentEntry = {
		id: generateId("exp"),
		timestamp: new Date().toISOString(),
		title,
		description,
		code,
		result: extraction?.summary,
		outcome: parsed.outcome,
		tags,
		source: "auto",
		stdout: parsed.stdout.slice(0, EXTRACTION_CLIP),
		durationMs: parsed.durationMs,
		key_metrics,
		codeHash: hash,
		embedding,
		embeddingModel,
		embeddingDim,
	};
	writeEntry(M_E_FILE, entry);
	return entry;
}

// ── FR-4: hybrid 検索 M_E（関键词永远在线作基线，语义作增强）──
export async function hybridSearchExperiments(
	query: string,
	limit: number,
	signal: AbortSignal | undefined,
): Promise<ExperimentEntry[]> {
	const experiments = loadEntries<ExperimentEntry>(M_E_FILE);
	if (experiments.length === 0) return [];

	const terms = query
		.toLowerCase()
		.split(/\W+/)
		.filter((t) => t.length > 2)
		.slice(0, RELEVANCE_TERMS_LIMIT);
	const maxKw = Math.max(1, terms.length);

	// 查询向量（provider 不可用 / 失败 → null → 退纯关键词）
	let queryVec: number[] | null = null;
	let queryModel: string | null = null;
	const provider = resolveEmbeddingProvider();
	if (provider) {
		const r = await embed(query, provider, signal);
		if (r) {
			queryVec = r.vector;
			queryModel = r.model;
		}
	}

	const scored = experiments.map((e) => {
		const kwNorm = terms.length === 0 ? 0 : scoreRelevance(e, terms) / maxKw;
		let sem: number | null = null;
		// 仅当查询向量存在且条目向量同模型同维度才算语义分（防 cosine 崩）
		if (queryVec && e.embedding && e.embeddingModel === queryModel && e.embeddingDim === queryVec.length) {
			sem = cosine(queryVec, e.embedding);
		}
		return { entry: e, score: hybridScore(kwNorm, sem, e.is_best === true) };
	});

	const hits = scored
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ entry }) => entry);

	// 查询无有效 term 且无语义命中时，回退最近 limit 条（与 selectRelevant 行为一致）
	if (hits.length === 0 && terms.length === 0) return experiments.slice(-limit);
	return hits;
}

function formatExperimentHits(hits: ExperimentEntry[]): string {
	const blocks = hits.map((e, i) => {
		const lines = [`[${i + 1}] ${e.is_best ? "★ " : ""}[${e.outcome}] ${e.title}`, `    ${e.description}`];
		if (e.key_metrics && Object.keys(e.key_metrics).length > 0) {
			lines.push(`    metrics: ${Object.entries(e.key_metrics).map(([k, v]) => `${k}=${v}`).join(", ")}`);
		}
		lines.push(`    id: ${e.id}`);
		if (e.code) lines.push(`    code:\n${e.code.split("\n").map((l) => `      ${l}`).join("\n")}`);
		return lines.join("\n");
	});
	return blocks.join("\n\n");
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

	// ── FR-4: run_python 完成后自动归档到 M_E（全程 try/catch，绝不阻断/弄崩工具结果）──
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.toolName !== "run_python") return;
			const code = typeof event.input["code"] === "string" ? (event.input["code"] as string) : undefined;
			if (!code) return;
			const text = event.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			const parsed = parseKernelResult(text, event.isError);
			if (!parsed) return;
			await archiveExperiment(code, parsed, ctx.model, ctx.signal);
		} catch {
			// 自动归档绝不能拖崩 run_python 结果；吞掉一切异常。
		}
		// 不修改 tool_result（归档是纯副作用）→ 返回 undefined
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

	pi.registerTool({
		name: "query_memory",
		label: "Query Experiment Memory (M_E, semantic)",
		description:
			"Search past experiments by meaning (semantic + keyword hybrid). Returns the most relevant archived " +
			"experiments with their code and key metrics. Best implementations (★) are prioritized. " +
			"Call before re-running similar work to reuse or compare prior results.",
		parameters: Type.Object({
			query: Type.String({ description: "What you're looking for (natural language)." }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 5)." })),
		}),
		async execute(_id, params, signal) {
			const limit = params.limit ?? 5;
			const hits = await hybridSearchExperiments(params.query, limit, signal);
			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `No matching experiments in M_E for: "${params.query}"` }],
					details: undefined,
				};
			}
			return { content: [{ type: "text", text: formatExperimentHits(hits) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "mark_best_experiment",
		label: "Mark Best Experiment (M_E)",
		description:
			"Mark an archived experiment as a best / reference implementation by its id (from query_memory). " +
			"Best experiments are prioritized (★) in query_memory results. Multiple experiments may be marked best.",
		parameters: Type.Object({
			id: Type.String({ description: "The experiment id to mark as best." }),
		}),
		async execute(_id, params) {
			const experiments = loadEntries<ExperimentEntry>(M_E_FILE);
			const target = experiments.find((e) => e.id === params.id);
			if (!target) {
				return {
					content: [{ type: "text", text: `No experiment with id=${params.id} in M_E.` }],
					details: undefined,
					isError: true,
				};
			}
			target.is_best = true;
			rewriteExperiments(experiments);
			return { content: [{ type: "text", text: `Marked best: ${target.title} (${target.id})` }], details: undefined };
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
