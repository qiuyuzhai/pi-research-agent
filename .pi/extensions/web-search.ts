/**
 * Web Search 扩展
 *
 * 后端：Tavily（主）+ Brave（备），运行时读 env key，无 key 明确报错，不降级。
 * 零新增 npm 依赖——Node v24 原生 fetch。
 *
 * API 字段已通过 WebSearch 核实（2025-01）：
 *
 * Tavily:
 *   POST https://api.tavily.com/search
 *   Auth: Authorization: Bearer <key>  （非 body 字段）
 *   Body: { query: string, max_results?: number, search_depth?: string }
 *   Response: { results: Array<{ title: string, url: string, content: string, score: number }> }
 *
 * Brave:
 *   GET https://api.search.brave.com/res/v1/web/search
 *   Auth: X-Subscription-Token: <key>
 *   Params: q=<query>&count=<n>
 *   Response: { web: { results: Array<{ title: string, url: string, description: string }> } }
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 核心类型 ──────────────────────────────────────────────────────────────────

type SearchResult = {
	title: string;
	snippet: string;
	url: string;
};

type Provider = "tavily" | "brave";

type ResolvedProvider = {
	provider: Provider;
	key: string;
};

// ── Provider 解析 ─────────────────────────────────────────────────────────────

/**
 * 解析当前可用的搜索后端。
 * - WEB_SEARCH_PROVIDER 可显式指定 tavily / brave，但对应 key 仍需存在。
 * - 自动探测顺序：TAVILY_API_KEY → BRAVE_API_KEY。
 * - 都无 key → null（调用方负责报错）。
 */
export function resolveProvider(): ResolvedProvider | null {
	const explicit = process.env["WEB_SEARCH_PROVIDER"];

	if (explicit === "tavily") {
		const key = process.env["TAVILY_API_KEY"];
		return key ? { provider: "tavily", key } : null;
	}

	if (explicit === "brave") {
		const key = process.env["BRAVE_API_KEY"];
		return key ? { provider: "brave", key } : null;
	}

	// 自动探测
	const tavilyKey = process.env["TAVILY_API_KEY"];
	if (tavilyKey) return { provider: "tavily", key: tavilyKey };

	const braveKey = process.env["BRAVE_API_KEY"];
	if (braveKey) return { provider: "brave", key: braveKey };

	return null;
}

// ── 响应归一化 ────────────────────────────────────────────────────────────────

/**
 * 归一化 Tavily 响应 JSON → SearchResult[]
 * 核实字段：results[].{ title, url, content }
 */
export function normalizeTavily(json: unknown): SearchResult[] {
	if (
		typeof json !== "object" ||
		json === null ||
		!Array.isArray((json as Record<string, unknown>)["results"])
	) {
		return [];
	}

	const raw = (json as Record<string, unknown>)["results"] as unknown[];

	return raw.flatMap((item) => {
		if (typeof item !== "object" || item === null) return [];
		const r = item as Record<string, unknown>;
		const title = typeof r["title"] === "string" ? r["title"] : "";
		const url = typeof r["url"] === "string" ? r["url"] : "";
		const snippet = typeof r["content"] === "string" ? r["content"] : "";
		if (!url) return [];
		return [{ title, snippet, url }];
	});
}

/**
 * 归一化 Brave 响应 JSON → SearchResult[]
 * 核实字段：web.results[].{ title, url, description }
 */
export function normalizeBrave(json: unknown): SearchResult[] {
	if (typeof json !== "object" || json === null) return [];

	const web = (json as Record<string, unknown>)["web"];
	if (typeof web !== "object" || web === null) return [];

	const results = (web as Record<string, unknown>)["results"];
	if (!Array.isArray(results)) return [];

	return results.flatMap((item) => {
		if (typeof item !== "object" || item === null) return [];
		const r = item as Record<string, unknown>;
		const title = typeof r["title"] === "string" ? r["title"] : "";
		const url = typeof r["url"] === "string" ? r["url"] : "";
		const snippet = typeof r["description"] === "string" ? r["description"] : "";
		if (!url) return [];
		return [{ title, snippet, url }];
	});
}

// ── 搜索后端 ──────────────────────────────────────────────────────────────────

async function searchTavily(
	query: string,
	numResults: number,
	key: string,
	signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
	// POST https://api.tavily.com/search
	// Auth: Authorization: Bearer <key>
	// Body: { query, max_results, search_depth }
	const localTimeout = AbortSignal.timeout(15_000);
	const combinedSignal =
		signal !== undefined
			? AbortSignal.any([localTimeout, signal])
			: localTimeout;

	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({
			query,
			max_results: numResults,
			search_depth: "basic",
		}),
		signal: combinedSignal,
	});

	if (!response.ok) {
		throw new Error(`Tavily request failed: HTTP ${response.status}`);
	}

	const json: unknown = await response.json();
	return normalizeTavily(json);
}

async function searchBrave(
	query: string,
	numResults: number,
	key: string,
	signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
	// GET https://api.search.brave.com/res/v1/web/search
	// Auth: X-Subscription-Token: <key>
	// Params: q, count
	const localTimeout = AbortSignal.timeout(15_000);
	const combinedSignal =
		signal !== undefined
			? AbortSignal.any([localTimeout, signal])
			: localTimeout;

	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(numResults));

	const response = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": key,
		},
		signal: combinedSignal,
	});

	if (!response.ok) {
		throw new Error(`Brave request failed: HTTP ${response.status}`);
	}

	const json: unknown = await response.json();
	return normalizeBrave(json);
}

// ── 结果格式化 ────────────────────────────────────────────────────────────────

function formatResults(results: SearchResult[], provider: Provider): string {
	if (results.length === 0) {
		return `No results found. Source: ${provider}`;
	}

	const lines = results.map(
		(r, i) =>
			`[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`,
	);

	lines.push(`\nSource: ${provider}`);
	return lines.join("\n\n");
}

// ── 扩展入口 ──────────────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for current information. Uses Tavily (primary) or Brave (fallback) based on available API keys. " +
			"Set TAVILY_API_KEY or BRAVE_API_KEY in the environment. " +
			"Optionally set WEB_SEARCH_PROVIDER=tavily|brave to force a specific backend.",
		parameters: Type.Object({
			query: Type.String({ description: "Web search query" }),
			num_results: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 20,
					description: "Number of results to return (default 10)",
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, _ctx) {
			const resolved = resolveProvider();

			if (!resolved) {
				return {
					content: [
						{
							type: "text",
							text: "No web search backend configured. Set TAVILY_API_KEY or BRAVE_API_KEY (optionally WEB_SEARCH_PROVIDER=tavily|brave).",
						},
					],
					details: undefined,
					isError: true,
				};
			}

			const numResults = params.num_results ?? 10;

			try {
				let results: SearchResult[];

				if (resolved.provider === "tavily") {
					results = await searchTavily(
						params.query,
						numResults,
						resolved.key,
						signal,
					);
				} else {
					results = await searchBrave(
						params.query,
						numResults,
						resolved.key,
						signal,
					);
				}

				return {
					content: [
						{
							type: "text",
							text: formatResults(results, resolved.provider),
						},
					],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Web search error (${resolved.provider}): ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("websearch-status", {
		description: "Show web search backend configuration and active provider",
		async handler(_args, ctx) {
			const tavilyKey = process.env["TAVILY_API_KEY"];
			const braveKey = process.env["BRAVE_API_KEY"];
			const explicitProvider = process.env["WEB_SEARCH_PROVIDER"];
			const resolved = resolveProvider();

			const lines = [
				"Web Search Status",
				`TAVILY_API_KEY:      ${tavilyKey ? "set" : "not set"}`,
				`BRAVE_API_KEY:       ${braveKey ? "set" : "not set"}`,
				`WEB_SEARCH_PROVIDER: ${explicitProvider ?? "(not set, auto-detect)"}`,
				`Active backend:      ${resolved ? resolved.provider : "none — no API key configured"}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
