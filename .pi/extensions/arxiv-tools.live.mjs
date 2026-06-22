#!/usr/bin/env node
// arxiv-tools.live.mjs — arxiv-tools.ts 真实链路冒烟测试（打真实 export.arxiv.org）
// 运行: node /home/aaron/project1/pi/.pi/extensions/arxiv-tools.live.mjs
// 与 arxiv-tools.test.mjs（离线样本）互补：本脚本验证真实 API 契约 + 解析器在真实数据上的健壮性。
// 尊重 arxiv ~3 req/s 限速，请求间 sleep 1.2s。

import {
	fetchArxiv,
	parseFeed,
	normalizeArxivId,
} from "/home/aaron/project1/pi/.pi/extensions/arxiv-tools.ts";

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	// ── Case 1: search_arxiv 真实链路 ──────────────────────────────────
	console.log("[Case 1] search_arxiv → all:transformer, max_results=3");
	try {
		const sp = new URLSearchParams();
		sp.set("search_query", "all:transformer");
		sp.set("start", "0");
		sp.set("max_results", "3");
		const xml = await fetchArxiv(sp);
		const feed = parseFeed(xml);
		check("feed.total > 0", feed.total > 0, `total=${feed.total}`);
		check("entries 数 = 3", feed.entries.length === 3, `got ${feed.entries.length}`);
		const e = feed.entries[0];
		check("entry.arxivId 非空", !!e?.arxivId, e?.arxivId);
		check("entry.title 非空", !!e?.title && e.title.length > 3, e?.title);
		check("entry.authors 非空", Array.isArray(e?.authors) && e.authors.length > 0, `${e?.authors?.length} authors`);
		check("entry.abstract 非空", !!e?.abstract && e.abstract.length > 20);
		check("entry.published YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(e?.published ?? ""), e?.published);
		check("entry.pdfUrl 是 http", /^https?:\/\//.test(e?.pdfUrl ?? ""), e?.pdfUrl);
		check("entry.categories 非空", Array.isArray(e?.categories) && e.categories.length > 0, e?.categories?.join(","));
	} catch (err) {
		failed++;
		console.log(`  ✗ Case 1 抛异常: ${err?.name} ${err?.message}`);
	}

	await sleep(1200);

	// ── Case 2: fetch_paper 真实链路（经典论文 Attention Is All You Need）──
	console.log("\n[Case 2] fetch_paper → 1706.03762 (Attention Is All You Need)");
	try {
		const id = normalizeArxivId("https://arxiv.org/abs/1706.03762");
		check("normalizeArxivId(url) = 1706.03762", id === "1706.03762", id);
		const sp = new URLSearchParams();
		sp.set("id_list", id);
		const xml = await fetchArxiv(sp);
		const feed = parseFeed(xml);
		check("命中 1 篇", feed.entries.length === 1, `got ${feed.entries.length}`);
		const e = feed.entries[0];
		check("title 含 'Attention'", /attention/i.test(e?.title ?? ""), e?.title);
		check("authors 含 'Vaswani'", (e?.authors ?? []).some((a) => /vaswani/i.test(a)), e?.authors?.join(", "));
		check("arxivId 含 1706.03762", (e?.arxivId ?? "").includes("1706.03762"), e?.arxivId);
		check("abstract 非空", !!e?.abstract && e.abstract.length > 50);
	} catch (err) {
		failed++;
		console.log(`  ✗ Case 2 抛异常: ${err?.name} ${err?.message}`);
	}

	await sleep(1200);

	// ── Case 3: 错误处理（不存在的 id）────────────────────────────────
	console.log("\n[Case 3] fetch_paper → 不存在的 id（0000.00000）应优雅返回空");
	try {
		const sp = new URLSearchParams();
		sp.set("id_list", "0000.00000");
		const xml = await fetchArxiv(sp);
		const feed = parseFeed(xml);
		check("不存在 id → entries 为空（不抛异常）", feed.entries.length === 0, `got ${feed.entries.length}`);
	} catch (err) {
		// arxiv 对非法 id 可能返回 400；fetchArxiv 抛错也是可接受的明确失败
		check("不存在 id → 抛明确错误（可接受）", true, `${err?.message}`);
	}

	console.log("\n" + "─".repeat(50));
	console.log(`真实链路结果: ${passed} 通过 / ${failed} 失败`);
	if (failed > 0) {
		console.log("LIVE FAIL");
		process.exit(1);
	}
	console.log("LIVE ALL PASS");
}

main().catch((err) => {
	console.error("致命错误:", err);
	process.exit(1);
});
