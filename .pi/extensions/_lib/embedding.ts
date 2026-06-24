/**
 * FR-4 实验记忆 M_E — 纯函数层（向量数学 + embedding provider）
 *
 * 裸子目录 _lib/ 无 index.ts → Pi 加载器完全无视（loader.ts:478-508 已核实），
 * 但可被兄弟扩展 import。本文件不 import pi-ai 运行时值，故可被 bun 离线单测。
 *
 * embedding 走 OpenAI 兼容端点 POST {baseURL}/embeddings（原生 fetch，零新增依赖，
 * 对标 web-search.ts 的 resolveProvider 范式）。
 */

export interface EmbeddingProvider {
	baseURL: string;
	apiKey: string;
	model: string;
}

export interface EmbedResult {
	vector: number[];
	model: string;
	dim: number;
}

export interface HybridWeights {
	kw: number;
	sem: number;
	bestBoost: number;
}

export const DEFAULT_WEIGHTS: HybridWeights = { kw: 0.5, sem: 0.5, bestBoost: 0.25 };

const EMBED_TIMEOUT_MS = 5000;

export function resolveEmbeddingProvider(): EmbeddingProvider | null {
	throw new Error("not implemented: resolveEmbeddingProvider");
}

export function normalizeEmbeddingResponse(_json: unknown): number[] | null {
	throw new Error("not implemented: normalizeEmbeddingResponse");
}

export async function embed(
	_text: string,
	_provider: EmbeddingProvider,
	_signal?: AbortSignal,
): Promise<EmbedResult | null> {
	throw new Error("not implemented: embed");
}

export function cosine(a: number[], b: number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / Math.sqrt(na * nb);
}

export function hybridScore(
	kwScoreNorm: number,
	semScore: number | null,
	isBest: boolean,
	weights: HybridWeights = DEFAULT_WEIGHTS,
): number {
	// semScore === null（无可比向量）→ 退纯关键词；否则按权重线性融合。
	const base =
		semScore === null ? kwScoreNorm : weights.kw * kwScoreNorm + weights.sem * semScore;
	return base + (isBest ? weights.bestBoost : 0);
}

export function codeHash(code: string): string {
	// 规范化：统一换行 → 去每行行尾空白 → 折叠连续空行 → 整体 trim。
	// 刻意保留行首缩进（Python 语义性），避免把不同程序误判为重复。
	const normalized = code
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
	// DJB2 哈希，确定性、无依赖。
	let h = 5381;
	for (let i = 0; i < normalized.length; i++) {
		h = ((h << 5) + h + normalized.charCodeAt(i)) >>> 0;
	}
	return h.toString(16);
}

// EMBED_TIMEOUT_MS 在 embed 实现后引用；此处显式 void 防 unused（实现 embed 时移除）。
void EMBED_TIMEOUT_MS;
