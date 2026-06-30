#!/usr/bin/env bun
// fr2-tools.integration.test.mjs — FR-2 工具 execute 层与 M_I 归档闭环离线测试
// 运行: bun /home/aaron/project1/pi/.pi/extensions/fr2-tools.integration.test.mjs
// 零真实网络请求：通过 stub globalThis.fetch 验证 arXiv / Tavily / Brave 工具行为。

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function assert(label, condition, extra = "") {
	if (condition) {
		console.log(`  ✓ ${label}${extra ? ` ${extra}` : ""}`);
		passed++;
	} else {
		console.error(`  ✗ ${label}${extra ? ` ${extra}` : ""}`);
		failed++;
	}
}

function assertContains(label, actual, substring) {
	assert(
		label,
		typeof actual === "string" && actual.includes(substring),
		`→ 期望包含 ${JSON.stringify(substring)}，实际 ${JSON.stringify(actual)}`,
	);
}

function assertEqual(label, actual, expected) {
	assert(
		label,
		actual === expected,
		`→ 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
	);
}

function captureExtension(extension) {
	const tools = {};
	const commands = {};
	const hooks = {};
	const pi = {
		registerTool: (def) => {
			tools[def.name] = def;
		},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
		on: (event, handler) => {
			(hooks[event] ??= []).push(handler);
		},
	};
	extension(pi);
	return { tools, commands, hooks };
}

function textOf(result) {
	return result.content.map((block) => block.text ?? "").join("\n");
}

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <title>Attention Is All You Need</title>
    <published>2017-06-12T00:00:00Z</published>
    <summary>We introduce the Transformer architecture.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <link title="pdf" href="https://arxiv.org/pdf/1706.03762v5" rel="related"/>
  </entry>
</feed>`;

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
</feed>`;

function responseOk(body) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		text: async () => body,
		json: async () => JSON.parse(body),
	};
}

function responseJson(json) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		text: async () => JSON.stringify(json),
		json: async () => json,
	};
}

function responseError(status, statusText) {
	return {
		ok: false,
		status,
		statusText,
		text: async () => "",
		json: async () => ({}),
	};
}

function withFetch(stub, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			globalThis.fetch = original;
		});
}

function withEnv(overrides, fn) {
	const keys = ["TAVILY_API_KEY", "BRAVE_API_KEY", "WEB_SEARCH_PROVIDER"];
	const saved = {};
	for (const key of keys) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			for (const key of keys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		});
}

console.log("\n[1] arXiv 工具注册与 execute 层");
const { default: arxivExtension } = await import("/home/aaron/project1/pi/.pi/extensions/arxiv-tools.ts");
const arxiv = captureExtension(arxivExtension);
assert("注册 search_arxiv", Boolean(arxiv.tools.search_arxiv));
assert("注册 fetch_paper", Boolean(arxiv.tools.fetch_paper));

await withFetch(
	async (url) => {
		assertContains("search_arxiv 请求 search_query", String(url), "search_query=all%3Atransformer");
		assertContains("search_arxiv 请求 max_results", String(url), "max_results=1");
		return responseOk(SAMPLE_FEED);
	},
	async () => {
		const result = await arxiv.tools.search_arxiv.execute("call-1", {
			query: "all:transformer",
			max_results: 1,
		});
		const text = textOf(result);
		assert("search_arxiv 成功路径非错误", result.isError !== true);
		assertContains("search_arxiv 输出 total", text, "Total available: 1");
		assertContains("search_arxiv 输出论文标题", text, "Attention Is All You Need");
		assertContains("search_arxiv 输出 arXiv ID", text, "1706.03762v5");
	},
);

await withFetch(
	async () => responseOk(EMPTY_FEED),
	async () => {
		const result = await arxiv.tools.search_arxiv.execute("call-2", {
			query: "all:no-such-paper",
		});
		assert("search_arxiv 空结果不是工具错误", result.isError !== true);
		assertContains("search_arxiv 空结果说明", textOf(result), "No results found");
	},
);

await withFetch(
	async (url) => {
		assertContains("fetch_paper 请求 id_list", String(url), "id_list=1706.03762");
		return responseOk(SAMPLE_FEED);
	},
	async () => {
		const result = await arxiv.tools.fetch_paper.execute("call-3", {
			id_or_url: "https://arxiv.org/abs/1706.03762",
		});
		const text = textOf(result);
		assert("fetch_paper 成功路径非错误", result.isError !== true);
		assertContains("fetch_paper 输出完整摘要", text, "We introduce the Transformer architecture.");
		assertContains("fetch_paper 输出 PDF", text, "https://arxiv.org/pdf/1706.03762v5");
	},
);

await withFetch(
	async () => responseError(503, "Service Unavailable"),
	async () => {
		const result = await arxiv.tools.fetch_paper.execute("call-4", {
			id_or_url: "1706.03762",
		});
		assert("fetch_paper HTTP 错误标记 isError", result.isError === true);
		assertContains("fetch_paper HTTP 错误信息", textOf(result), "arXiv API returned HTTP 503");
	},
);

console.log("\n[2] web_search 工具注册与 execute 层");
const { default: webSearchExtension } = await import("/home/aaron/project1/pi/.pi/extensions/web-search.ts");
const web = captureExtension(webSearchExtension);
assert("注册 web_search", Boolean(web.tools.web_search));

await withEnv({}, async () => {
	const result = await web.tools.web_search.execute("call-5", { query: "transformer" });
	assert("web_search 无 key 标记 isError", result.isError === true);
	assertContains("web_search 无 key 提示", textOf(result), "No web search backend configured");
});

await withEnv({ TAVILY_API_KEY: "tavily-test-key" }, async () => {
	await withFetch(
		async (url, init) => {
			assertEqual("Tavily URL", String(url), "https://api.tavily.com/search");
			assertEqual("Tavily method", init.method, "POST");
			assertEqual("Tavily authorization", init.headers.Authorization, "Bearer tavily-test-key");
			const body = JSON.parse(init.body);
			assertEqual("Tavily body query", body.query, "recent transformer survey");
			assertEqual("Tavily body max_results", body.max_results, 2);
			return responseJson({
				results: [{ title: "Tavily Result", url: "https://example.com/t", content: "Tavily snippet" }],
			});
		},
		async () => {
			const result = await web.tools.web_search.execute("call-6", {
				query: "recent transformer survey",
				num_results: 2,
			});
			const text = textOf(result);
			assert("web_search Tavily 成功路径非错误", result.isError !== true);
			assertContains("web_search Tavily 输出标题", text, "Tavily Result");
			assertContains("web_search Tavily 输出 source", text, "Source: tavily");
		},
	);
});

await withEnv({ BRAVE_API_KEY: "brave-test-key" }, async () => {
	await withFetch(
		async (url, init) => {
			const parsed = new URL(String(url));
			assertEqual("Brave host", parsed.host, "api.search.brave.com");
			assertEqual("Brave query", parsed.searchParams.get("q"), "recent transformer survey");
			assertEqual("Brave count", parsed.searchParams.get("count"), "3");
			assertEqual("Brave method", init.method, "GET");
			assertEqual("Brave token", init.headers["X-Subscription-Token"], "brave-test-key");
			return responseJson({
				web: { results: [{ title: "Brave Result", url: "https://example.com/b", description: "Brave snippet" }] },
			});
		},
		async () => {
			const result = await web.tools.web_search.execute("call-7", {
				query: "recent transformer survey",
				num_results: 3,
			});
			const text = textOf(result);
			assert("web_search Brave 成功路径非错误", result.isError !== true);
			assertContains("web_search Brave 输出标题", text, "Brave Result");
			assertContains("web_search Brave 输出 source", text, "Source: brave");
		},
	);
});

await withEnv({ TAVILY_API_KEY: "tavily-test-key" }, async () => {
	await withFetch(
		async () => responseError(429, "Too Many Requests"),
		async () => {
			const result = await web.tools.web_search.execute("call-8", { query: "rate limited" });
			assert("web_search HTTP 错误标记 isError", result.isError === true);
			assertContains("web_search HTTP 错误信息", textOf(result), "Tavily request failed: HTTP 429");
		},
	);
});

console.log("\n[3] save_research_finding → M_I 写入闭环");
const tmpMemoryDir = mkdtempSync(join(tmpdir(), "fr2-mi-"));
process.env.PI_RESEARCH_MEMORY_DIR = tmpMemoryDir;
const { default: researchMemoryExtension } = await import(
	`/home/aaron/project1/pi/.pi/extensions/research-memory.ts?fr2=${Date.now()}`
);
const memory = captureExtension(researchMemoryExtension);
assert("注册 save_research_finding", Boolean(memory.tools.save_research_finding));
const saveResult = await memory.tools.save_research_finding.execute("call-9", {
	type: "finding",
	content: "Transformer attention baselines should be compared before proposing a new sequence model.",
	outcome: "success",
	tags: ["transformer", "baseline", "attention"],
});
assert("save_research_finding 成功路径非错误", saveResult.isError !== true);
assertContains("save_research_finding 返回 M_I 提示", textOf(saveResult), "[M_I] Saved finding/success");
const episodicPath = join(tmpMemoryDir, "episodic.jsonl");
const savedLine = readFileSync(episodicPath, "utf-8").trim();
const saved = JSON.parse(savedLine);
assert("M_I 文件写入 id", typeof saved.id === "string" && saved.id.startsWith("ep-"));
assertEqual("M_I type", saved.type, "finding");
assertEqual("M_I outcome", saved.outcome, "success");
assertEqual(
	"M_I content",
	saved.content,
	"Transformer attention baselines should be compared before proposing a new sequence model.",
);
assertEqual("M_I tags", JSON.stringify(saved.tags), JSON.stringify(["transformer", "baseline", "attention"]));

console.log("\n" + "─".repeat(56));
const total = passed + failed;
if (failed === 0) {
	console.log(`FR-2 integration PASS ${passed}/${total}`);
	process.exit(0);
} else {
	console.error(`FR-2 integration FAIL ${failed}/${total}`);
	process.exit(1);
}
