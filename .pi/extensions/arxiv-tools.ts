/**
 * arXiv 工具扩展
 *
 * 提供两个工具：search_arxiv（全文检索）和 fetch_paper（按 ID 抓取元数据）。
 * 共享一套 Atom XML 正则解析辅助函数（DRY），全部具名 export 供离线测试。
 * 零新增 npm 依赖，使用 Node v24 原生 fetch。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

type ParsedEntry = {
	arxivId: string;
	title: string;
	authors: string[];
	abstract: string;
	published: string;
	categories: string[];
	pdfUrl: string;
};

type ParsedFeed = {
	total: number;
	entries: ParsedEntry[];
};

// ---------------------------------------------------------------------------
// 辅助函数（具名 export，供离线单元测试）
// ---------------------------------------------------------------------------

/** 解码常见 XML/HTML 实体（arXiv title/summary 中大量出现）。*/
export function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

/** 提取单个 XML 标签的文本内容，trim 并解码实体。*/
export function extractTag(xml: string, tag: string): string {
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
	const m = xml.match(re);
	return m ? decodeEntities(m[1].trim()) : "";
}

/** 提取所有匹配标签的文本内容列表。*/
export function extractAll(xml: string, tag: string): string[] {
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
	const results: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		results.push(decodeEntities(m[1].trim()));
	}
	return results;
}

/**
 * 从单个 <entry> XML 块解析结构化论文元数据。
 * - arxivId 从 <id>http://arxiv.org/abs/XXXXv1</id> 提取尾段
 * - authors 从多个 <author><name>..</name></author>
 * - categories 从多个 <category term="cs.AI"/>
 * - pdfUrl 优先从 <link title="pdf" href=".."/>，否则由 arxivId 构造
 */
export function parseEntry(entryXml: string): ParsedEntry {
	// arxivId: 取 <id> 末段，去除版本号后的路径
	const rawId = extractTag(entryXml, "id");
	const arxivId = rawId.replace(/^.*\/abs\//, "").replace(/^.*\/pdf\//, "").replace(/\.pdf$/, "");

	const title = extractTag(entryXml, "title").replace(/\s+/g, " ");
	const abstract = extractTag(entryXml, "summary").replace(/\s+/g, " ");
	const published = extractTag(entryXml, "published").slice(0, 10); // YYYY-MM-DD

	// authors: 多个 <author><name>...</name></author>
	const authorBlocks = extractAll(entryXml, "author");
	const authors = authorBlocks.map((block) => extractTag(block, "name")).filter(Boolean);

	// categories: <category term="cs.AI" scheme="..."/>
	const categoryRe = /<category[^>]+term="([^"]+)"/gi;
	const categories: string[] = [];
	let cm: RegExpExecArray | null;
	while ((cm = categoryRe.exec(entryXml)) !== null) {
		categories.push(cm[1]);
	}

	// pdfUrl: 优先 <link title="pdf" href="..."/>
	const pdfLinkRe = /<link[^>]+title="pdf"[^>]+href="([^"]+)"/i;
	const pdfLinkRe2 = /<link[^>]+href="([^"]+)"[^>]+title="pdf"/i;
	const pdfMatch = entryXml.match(pdfLinkRe) ?? entryXml.match(pdfLinkRe2);
	const pdfUrl = pdfMatch ? pdfMatch[1] : `https://arxiv.org/pdf/${arxivId}`;

	return { arxivId, title, authors, abstract, published, categories, pdfUrl };
}

/**
 * 从完整 Atom feed XML 解析总结果数和论文列表。
 * - total 取 <opensearch:totalResults>
 * - entries 以 /<entry>...</entry>/g 切分后逐一 parseEntry
 */
export function parseFeed(xml: string): ParsedFeed {
	const totalStr = extractTag(xml, "opensearch:totalResults");
	const total = totalStr ? parseInt(totalStr, 10) : 0;

	const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
	const entries: ParsedEntry[] = [];
	let m: RegExpExecArray | null;
	while ((m = entryRe.exec(xml)) !== null) {
		entries.push(parseEntry(m[1]));
	}

	return { total, entries };
}

/**
 * 规范化 arXiv ID，支持以下格式：
 * - '2305.06983'
 * - '2305.06983v2'
 * - 'arxiv.org/abs/2305.06983'
 * - 'https://arxiv.org/abs/2305.06983'
 * - 'https://arxiv.org/pdf/2305.06983.pdf'
 * 返回裸 ID（如 '2305.06983' 或 '2305.06983v2'）。
 */
export function normalizeArxivId(idOrUrl: string): string {
	const s = idOrUrl.trim();
	// 含 /abs/ 或 /pdf/ 的 URL
	const urlMatch = s.match(/(?:abs|pdf)\/([^\s/?#]+)/);
	if (urlMatch) {
		return urlMatch[1].replace(/\.pdf$/, "");
	}
	// 裸 ID（含可选版本号）
	const bareMatch = s.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/);
	if (bareMatch) {
		return bareMatch[1];
	}
	// 兜底：原样返回，让 API 报错
	return s;
}

/**
 * 请求 arXiv API，返回原始 XML 文本。
 * 合并外部 AbortSignal 与本地超时 signal，任一触发即取消。
 */
export async function fetchArxiv(
	searchParams: URLSearchParams,
	signal?: AbortSignal,
	timeoutMs = 30_000,
): Promise<string> {
	const url = `https://export.arxiv.org/api/query?${searchParams.toString()}`;

	const timeoutController = new AbortController();
	const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

	const signals = [timeoutController.signal, signal].filter((s): s is AbortSignal => s !== undefined);
	const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

	try {
		const res = await fetch(url, { signal: combinedSignal });
		if (!res.ok) {
			throw new Error(`arXiv API returned HTTP ${res.status}: ${res.statusText}`);
		}
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// 格式化辅助（仅扩展内部使用）
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return `${s.slice(0, maxLen)}…`;
}

function formatAuthors(authors: string[], max = 6): string {
	if (authors.length <= max) return authors.join(", ");
	return `${authors.slice(0, max).join(", ")} et al.`;
}

function formatEntryFull(entry: ParsedEntry, idx?: number): string {
	const prefix = idx !== undefined ? `[${idx}] ` : "";
	const lines = [
		`${prefix}${entry.title}`,
		`ID: ${entry.arxivId}  |  Published: ${entry.published}`,
		`Authors: ${formatAuthors(entry.authors)}`,
		`Categories: ${entry.categories.join(", ") || "(none)"}`,
		`Abstract: ${entry.abstract}`,
		`Links: https://arxiv.org/abs/${entry.arxivId}  |  PDF: ${entry.pdfUrl}`,
	];
	return lines.join("\n");
}

function formatEntrySearch(entry: ParsedEntry, idx: number): string {
	const lines = [
		`[${idx}] ${entry.title}`,
		`ID: ${entry.arxivId}  |  Published: ${entry.published}`,
		`Authors: ${formatAuthors(entry.authors)}`,
		`Categories: ${entry.categories.join(", ") || "(none)"}`,
		`Abstract: ${truncate(entry.abstract, 300)}`,
		`Links: https://arxiv.org/abs/${entry.arxivId}  |  PDF: ${entry.pdfUrl}`,
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 扩展工厂（default export，Pi 加载入口）
// ---------------------------------------------------------------------------

export default function arxivToolsExtension(pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// 工具: search_arxiv
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "search_arxiv",
		label: "Search arXiv",
		description:
			"Search arXiv papers via the public API. " +
			"Supports field-qualified queries: 'cat:cs.AI', 'au:Bengio', 'ti:transformer', 'all:diffusion model'. " +
			"Returns metadata for up to max_results papers (default 20). " +
			"Use fetch_paper to retrieve full metadata for a specific paper.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"arXiv search query. Examples: 'cat:cs.AI', 'au:Bengio', 'ti:transformer', 'all:diffusion'.",
			}),
			max_results: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 100,
					description: "Number of results to return (default 20, max 100).",
				}),
			),
			sort_by: Type.Optional(
				Type.Union([Type.Literal("submittedDate"), Type.Literal("relevance")], {
					description: "Sort criterion (default: relevance).",
				}),
			),
			sort_order: Type.Optional(
				Type.Union([Type.Literal("ascending"), Type.Literal("descending")], {
					description: "Sort direction (default: descending).",
				}),
			),
		}),
		async execute(_id, params, signal) {
			const searchParams = new URLSearchParams();
			searchParams.set("search_query", params.query);
			searchParams.set("start", "0");
			searchParams.set("max_results", String(params.max_results ?? 20));
			if (params.sort_by) searchParams.set("sortBy", params.sort_by);
			if (params.sort_order) searchParams.set("sortOrder", params.sort_order);

			try {
				const xml = await fetchArxiv(searchParams, signal);
				const feed = parseFeed(xml);

				if (feed.entries.length === 0) {
					return {
						content: [{ type: "text", text: `No results found for query: ${params.query}` }],
						details: undefined,
					};
				}

				const header = `Total available: ${feed.total}  |  Showing: ${feed.entries.length}  |  Query: ${params.query}`;
				const body = feed.entries.map((e, i) => formatEntrySearch(e, i + 1)).join("\n\n---\n\n");

				return {
					content: [{ type: "text", text: `${header}\n\n${body}` }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `search_arxiv error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	// ------------------------------------------------------------------
	// 工具: fetch_paper
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "fetch_paper",
		label: "Fetch arXiv Paper",
		description:
			"Fetch full metadata for a specific arXiv paper by ID or URL. " +
			"Accepts formats: '2305.06983', '2305.06983v2', 'https://arxiv.org/abs/2305.06983', 'https://arxiv.org/pdf/2305.06983.pdf'. " +
			"Returns title, authors, abstract (full), categories, published date, and links.",
		parameters: Type.Object({
			id_or_url: Type.String({
				description: "arXiv paper ID or URL (abs or pdf).",
			}),
			include_fulltext: Type.Optional(
				Type.Boolean({
					description: "Placeholder: full-text extraction not implemented in MVP (default false).",
				}),
			),
		}),
		async execute(_id, params, signal) {
			const arxivId = normalizeArxivId(params.id_or_url);

			const searchParams = new URLSearchParams();
			searchParams.set("id_list", arxivId);

			try {
				const xml = await fetchArxiv(searchParams, signal);
				const feed = parseFeed(xml);

				if (feed.entries.length === 0) {
					return {
						content: [{ type: "text", text: `Paper not found: ${arxivId}` }],
						isError: true,
						details: undefined,
					};
				}

				const entry = feed.entries[0];
				const lines = [formatEntryFull(entry)];

				if (params.include_fulltext === true) {
					lines.push(
						"\n(note: full-text extraction not implemented in MVP; abstract only)",
					);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `fetch_paper error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	// ------------------------------------------------------------------
	// 命令: arxiv-help
	// ------------------------------------------------------------------
	pi.registerCommand("arxiv-help", {
		description: "Show arXiv tools usage and query syntax",
		async handler(_args, ctx) {
			ctx.ui.notify(
				[
					"arXiv Tools",
					"",
					"Tools:",
					"  search_arxiv(query, max_results?, sort_by?, sort_order?)",
					"    Search arXiv by query string. Returns metadata for up to 100 papers.",
					"",
					"  fetch_paper(id_or_url, include_fulltext?)",
					"    Fetch full metadata for one paper by ID or URL.",
					"",
					"Query syntax (Lucene-style, field-qualified):",
					"  cat:cs.AI        — by arXiv category",
					"  au:Bengio        — by author name",
					"  ti:transformer   — terms in title",
					"  abs:diffusion    — terms in abstract",
					"  all:CLIP vision  — all fields",
					"  ti:attention AND cat:cs.LG  — boolean AND",
					"",
					"ID formats accepted by fetch_paper:",
					"  2305.06983  |  2305.06983v2",
					"  https://arxiv.org/abs/2305.06983",
					"  https://arxiv.org/pdf/2305.06983.pdf",
				].join("\n"),
				"info",
			);
		},
	});
}
