#!/usr/bin/env bun
// arxiv-tools.test.mjs — arxiv-tools.ts 离线单元测试
// 运行: bun /home/aaron/project1/pi/.pi/extensions/arxiv-tools.test.mjs
// 零网络请求，全部基于内联 XML 样本常量。

import {
  decodeEntities,
  extractTag,
  extractAll,
  parseEntry,
  parseFeed,
  normalizeArxivId,
} from "/home/aaron/project1/pi/.pi/extensions/arxiv-tools.ts";

// ── 断言工具 ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      期望: ${JSON.stringify(expected)}`);
    console.error(`      实际: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertDeep(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      期望: ${e}`);
    console.error(`      实际: ${a}`);
    failed++;
  }
}

function assertContains(label, actual, substring) {
  if (typeof actual === "string" && actual.includes(substring)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      期望包含: ${JSON.stringify(substring)}`);
    console.error(`      实际: ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── 样本 XML 常量（离线，零网络请求）────────────────────────────────────────────

const SAMPLE_ENTRY_XML = `
<entry>
  <id>http://arxiv.org/abs/2305.06983v2</id>
  <title>Attention Is All You Need &amp; More: A Survey</title>
  <published>2023-05-12T00:00:00Z</published>
  <summary>We propose the transformer architecture&#x2014;a model based solely on attention mechanisms, dispensing with recurrence &lt;and&gt; convolutions.</summary>
  <author><name>Ashish Vaswani</name></author>
  <author><name>Noam Shazeer</name></author>
  <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
  <link rel="alternate" type="text/html" href="http://arxiv.org/abs/2305.06983v2"/>
  <link title="pdf" href="https://arxiv.org/pdf/2305.06983v2" rel="related"/>
</entry>
`;

const SAMPLE_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>42</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>2</opensearch:itemsPerPage>
  ${SAMPLE_ENTRY_XML}
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <title>BERT: Pre-training of Deep Bidirectional Transformers</title>
    <published>2018-10-11T00:00:00Z</published>
    <summary>We introduce BERT.</summary>
    <author><name>Jacob Devlin</name></author>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <link title="pdf" href="https://arxiv.org/pdf/1706.03762v5" rel="related"/>
  </entry>
</feed>`;

// ── 测试组 1：normalizeArxivId — 5 种输入格式 ────────────────────────────────
console.log("\n[1] normalizeArxivId — 5 种输入格式");

assert(
  "裸 ID '2305.06983'",
  normalizeArxivId("2305.06983"),
  "2305.06983",
);
assert(
  "带版本 '2305.06983v2'",
  normalizeArxivId("2305.06983v2"),
  "2305.06983v2",
);
assert(
  "abs URL 'https://arxiv.org/abs/2305.06983'",
  normalizeArxivId("https://arxiv.org/abs/2305.06983"),
  "2305.06983",
);
assert(
  "pdf URL 'https://arxiv.org/pdf/2305.06983.pdf'",
  normalizeArxivId("https://arxiv.org/pdf/2305.06983.pdf"),
  "2305.06983",
);
assert(
  "无协议 abs 'arxiv.org/abs/2305.06983'",
  normalizeArxivId("arxiv.org/abs/2305.06983"),
  "2305.06983",
);

// ── 测试组 2：decodeEntities ──────────────────────────────────────────────────
console.log("\n[2] decodeEntities — 常见实体解码");

assert("&amp; → &", decodeEntities("A &amp; B"), "A & B");
assert("&lt; → <", decodeEntities("a &lt; b"), "a < b");
assert("&gt; → >", decodeEntities("a &gt; b"), "a > b");
assert('&quot; → "', decodeEntities("say &quot;hi&quot;"), 'say "hi"');
assert("&apos; → '", decodeEntities("it&apos;s"), "it's");
assert(
  "&#x2014; → —（em dash hex）",
  decodeEntities("foo&#x2014;bar"),
  "foo—bar",
);
assert(
  "&#8212; → —（em dash decimal）",
  decodeEntities("foo&#8212;bar"),
  "foo—bar",
);

// ── 测试组 3：extractTag / extractAll ─────────────────────────────────────────
console.log("\n[3] extractTag / extractAll");

assert(
  "extractTag <title> 含实体解码",
  extractTag(SAMPLE_ENTRY_XML, "title"),
  "Attention Is All You Need & More: A Survey",
);
assert(
  "extractTag <published> 前 10 字符",
  extractTag(SAMPLE_ENTRY_XML, "published").slice(0, 10),
  "2023-05-12",
);

const authorBlocks = extractAll(SAMPLE_ENTRY_XML, "author");
assert("extractAll <author> 数量", authorBlocks.length, 2);
assertContains("第一个 author block 含 'Vaswani'", authorBlocks[0], "Vaswani");

// ── 测试组 4：parseEntry ──────────────────────────────────────────────────────
console.log("\n[4] parseEntry — 从样本 entry 块提取字段");

const entry = parseEntry(SAMPLE_ENTRY_XML);

assert("arxivId 含版本号", entry.arxivId, "2305.06983v2");
assert(
  "title 含 & 解码正确",
  entry.title,
  "Attention Is All You Need & More: A Survey",
);
assertDeep("authors 数组", entry.authors, ["Ashish Vaswani", "Noam Shazeer"]);
assertDeep("categories 数组", entry.categories, ["cs.LG", "cs.AI"]);
assert("pdfUrl 来自 link title=pdf", entry.pdfUrl, "https://arxiv.org/pdf/2305.06983v2");
assert("published YYYY-MM-DD", entry.published, "2023-05-12");
assertContains("abstract 含 —（&#x2014; 解码）", entry.abstract, "—");
assertContains("abstract 含 <（&lt; 解码）", entry.abstract, "<");

// ── 测试组 5：parseFeed ───────────────────────────────────────────────────────
console.log("\n[5] parseFeed — 从完整 feed 提取 total 与 entries");

const feed = parseFeed(SAMPLE_FEED_XML);

assert("total === 42", feed.total, 42);
assert("entries.length === 2", feed.entries.length, 2);
assert("entries[0].arxivId", feed.entries[0].arxivId, "2305.06983v2");
assert("entries[1].arxivId", feed.entries[1].arxivId, "1706.03762v5");

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log("\n" + "─".repeat(50));
if (failed === 0) {
  console.log(`PASS ${passed}/${total}`);
  process.exit(0);
} else {
  console.error(`FAIL ${failed}/${total} 失败`);
  process.exit(1);
}
