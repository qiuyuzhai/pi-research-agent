#!/usr/bin/env bun
// embedding.test.mjs — _lib/embedding.ts 离线单元测试（零网络）
// 运行: bun /home/aaron/project1/pi/.pi/extensions/_lib/embedding.test.mjs

import {
  cosine,
  hybridScore,
  codeHash,
  normalizeEmbeddingResponse,
  resolveEmbeddingProvider,
} from "/home/aaron/project1/pi/.pi/extensions/_lib/embedding.ts";

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

function assertApprox(label, actual, expected, eps = 1e-9) {
  if (typeof actual === "number" && Math.abs(actual - expected) <= eps) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      期望≈: ${expected}`);
    console.error(`      实际: ${actual}`);
    failed++;
  }
}

function assertTrue(label, cond) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function withEnv(overrides, fn) {
  const keys = ["OPENAI_BASE_URL", "EMBEDDING_MODEL", "OPENAI_API_KEY"];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── [1] cosine ──────────────────────────────────────────────────────────────
console.log("\n[1] cosine");
assert("正交向量 = 0", cosine([1, 0], [0, 1]), 0);
assert("同向量 = 1", cosine([1, 2, 3], [1, 2, 3]), 1);
assert("平行向量 = 1", cosine([1, 2], [2, 4]), 1);
assertApprox("已知值 [1,1]·[1,0] = 1/√2", cosine([1, 1], [1, 0]), 1 / Math.sqrt(2));
assert("空向量守卫 = 0", cosine([], []), 0);
assert("长度不等守卫 = 0", cosine([1, 2], [1, 2, 3]), 0);
assert("零向量守卫 = 0", cosine([0, 0], [1, 1]), 0);

// ── [2] hybridScore ──────────────────────────────────────────────────────────
console.log("\n[2] hybridScore");
// semScore=null → 纯关键词（kwNorm 原样），无 boost
assert("sem=null, 非best → kwNorm 原样", hybridScore(0.6, null, false), 0.6);
// semScore=null + is_best → + bestBoost(0.25)
assert("sem=null, best → +0.25", hybridScore(0.6, null, true), 0.85);
// 融合：0.5*0.4 + 0.5*0.8 = 0.6
assertApprox("融合 kw=0.4 sem=0.8 → 0.6", hybridScore(0.4, 0.8, false), 0.6);
// 融合 + best
assertApprox("融合 + best → 0.85", hybridScore(0.4, 0.8, true), 0.85);
// 自定义权重
assert(
  "自定义权重 kw=1 sem=0 → 纯 kw",
  hybridScore(0.7, 0.9, false, { kw: 1, sem: 0, bestBoost: 0 }),
  0.7,
);

// ── [3] codeHash ─────────────────────────────────────────────────────────────
console.log("\n[3] codeHash");
assert("确定性：同输入同 hash", codeHash("x = 1\ny = 2"), codeHash("x = 1\ny = 2"));
assert(
  "行尾空白不影响",
  codeHash("x = 1  \ny = 2\t"),
  codeHash("x = 1\ny = 2"),
);
assert(
  "空行折叠不影响",
  codeHash("x = 1\n\n\ny = 2"),
  codeHash("x = 1\ny = 2"),
);
assertTrue("不同代码 → 不同 hash", codeHash("x = 1") !== codeHash("x = 2"));
// 行首缩进是 Python 语义 → 必须区分（刻意偏离 spec 字面）
assertTrue(
  "行首缩进有意义（不同 hash）",
  codeHash("if x:\n    y = 1") !== codeHash("if x:\ny = 1"),
);
assertTrue("hash 是非空字符串", typeof codeHash("x=1") === "string" && codeHash("x=1").length > 0);

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
