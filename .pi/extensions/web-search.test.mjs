#!/usr/bin/env bun
// web-search.test.mjs — web-search.ts 离线单元测试
// 运行: bun /home/aaron/project1/pi/.pi/extensions/web-search.test.mjs
// 零网络请求：resolveProvider 用 process.env mock，normalize* 用内联 JSON。

import {
  resolveProvider,
  normalizeTavily,
  normalizeBrave,
} from "/home/aaron/project1/pi/.pi/extensions/web-search.ts";

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

// ── env 保存/恢复工具 ─────────────────────────────────────────────────────────
function withEnv(overrides, fn) {
  const saved = {};
  const keys = ["TAVILY_API_KEY", "BRAVE_API_KEY", "WEB_SEARCH_PROVIDER"];

  // 保存原始值并应用覆盖
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  try {
    return fn();
  } finally {
    // 恢复原始值
    for (const k of keys) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

// ── 测试组 1：resolveProvider — 分支逻辑 ──────────────────────────────────────
console.log("\n[1] resolveProvider — env 分支");

// 仅 TAVILY_API_KEY
withEnv({ TAVILY_API_KEY: "tvly-test-key" }, () => {
  const r = resolveProvider();
  assert("仅 TAVILY: provider === 'tavily'", r?.provider, "tavily");
  assert("仅 TAVILY: key 正确", r?.key, "tvly-test-key");
});

// 仅 BRAVE_API_KEY
withEnv({ BRAVE_API_KEY: "brave-test-key" }, () => {
  const r = resolveProvider();
  assert("仅 BRAVE: provider === 'brave'", r?.provider, "brave");
  assert("仅 BRAVE: key 正确", r?.key, "brave-test-key");
});

// 两者都有：自动探测优先 Tavily
withEnv({ TAVILY_API_KEY: "tvly-test-key", BRAVE_API_KEY: "brave-test-key" }, () => {
  const r = resolveProvider();
  assert("两者都有: 自动探测选 tavily", r?.provider, "tavily");
});

// 都无
withEnv({}, () => {
  const r = resolveProvider();
  assert("都无 key: 返回 null", r, null);
});

// WEB_SEARCH_PROVIDER=tavily 显式覆盖（key 存在）
withEnv({ WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "tvly-override" }, () => {
  const r = resolveProvider();
  assert("显式 tavily 覆盖: provider", r?.provider, "tavily");
  assert("显式 tavily 覆盖: key", r?.key, "tvly-override");
});

// WEB_SEARCH_PROVIDER=brave 显式覆盖（key 存在）
withEnv({ WEB_SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "brave-override" }, () => {
  const r = resolveProvider();
  assert("显式 brave 覆盖: provider", r?.provider, "brave");
  assert("显式 brave 覆盖: key", r?.key, "brave-override");
});

// WEB_SEARCH_PROVIDER=tavily 但 key 不存在 → null
withEnv({ WEB_SEARCH_PROVIDER: "tavily" }, () => {
  const r = resolveProvider();
  assert("显式 tavily 但无 key: 返回 null", r, null);
});

// WEB_SEARCH_PROVIDER=brave 但 key 不存在 → null
withEnv({ WEB_SEARCH_PROVIDER: "brave" }, () => {
  const r = resolveProvider();
  assert("显式 brave 但无 key: 返回 null", r, null);
});

// ── 测试组 2：normalizeTavily — mock JSON ────────────────────────────────────
console.log("\n[2] normalizeTavily — SearchResult[] 字段正确");

const TAVILY_MOCK = {
  results: [
    { title: "Result One", url: "https://example.com/1", content: "Snippet one", score: 0.9 },
    { title: "Result Two", url: "https://example.com/2", content: "Snippet two", score: 0.8 },
  ],
};

const tavilyResults = normalizeTavily(TAVILY_MOCK);
assert("normalizeTavily: 长度", tavilyResults.length, 2);
assertDeep("normalizeTavily: 第一条字段", tavilyResults[0], {
  title: "Result One",
  snippet: "Snippet one",
  url: "https://example.com/1",
});
assertDeep("normalizeTavily: 第二条字段", tavilyResults[1], {
  title: "Result Two",
  snippet: "Snippet two",
  url: "https://example.com/2",
});

// content 字段映射到 snippet（而非 description）
assert("normalizeTavily: content → snippet", tavilyResults[0].snippet, "Snippet one");

// 无 url 的条目被过滤
const tavilyWithMissing = normalizeTavily({
  results: [
    { title: "No URL", url: "", content: "x" },
    { title: "OK", url: "https://ok.com", content: "ok" },
  ],
});
assert("normalizeTavily: 无 url 条目被过滤", tavilyWithMissing.length, 1);

// 格式异常输入返回 []
assertDeep("normalizeTavily: null → []", normalizeTavily(null), []);
assertDeep("normalizeTavily: string → []", normalizeTavily("bad"), []);
assertDeep("normalizeTavily: 无 results 字段 → []", normalizeTavily({}), []);

// ── 测试组 3：normalizeBrave — mock JSON ─────────────────────────────────────
console.log("\n[3] normalizeBrave — SearchResult[] 字段正确");

const BRAVE_MOCK = {
  web: {
    results: [
      { title: "Brave Result One", url: "https://brave.com/1", description: "Brave snippet one" },
      { title: "Brave Result Two", url: "https://brave.com/2", description: "Brave snippet two" },
    ],
  },
};

const braveResults = normalizeBrave(BRAVE_MOCK);
assert("normalizeBrave: 长度", braveResults.length, 2);
assertDeep("normalizeBrave: 第一条字段", braveResults[0], {
  title: "Brave Result One",
  snippet: "Brave snippet one",
  url: "https://brave.com/1",
});

// description 字段映射到 snippet（而非 content）
assert("normalizeBrave: description → snippet", braveResults[0].snippet, "Brave snippet one");

// 无 url 的条目被过滤
const braveWithMissing = normalizeBrave({
  web: {
    results: [
      { title: "No URL", url: "", description: "x" },
      { title: "OK", url: "https://ok.com", description: "ok" },
    ],
  },
});
assert("normalizeBrave: 无 url 条目被过滤", braveWithMissing.length, 1);

// 格式异常输入返回 []
assertDeep("normalizeBrave: null → []", normalizeBrave(null), []);
assertDeep("normalizeBrave: 无 web 字段 → []", normalizeBrave({}), []);
assertDeep("normalizeBrave: web 无 results → []", normalizeBrave({ web: {} }), []);

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
