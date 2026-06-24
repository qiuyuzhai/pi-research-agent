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
assertApprox("平行向量 ≈ 1", cosine([1, 2], [2, 4]), 1);
assertApprox("已知值 [1,1]·[1,0] = 1/√2", cosine([1, 1], [1, 0]), 1 / Math.sqrt(2));
assert("空向量守卫 = 0", cosine([], []), 0);
assert("长度不等守卫 = 0", cosine([1, 2], [1, 2, 3]), 0);
assert("零向量守卫 = 0", cosine([0, 0], [1, 1]), 0);

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
