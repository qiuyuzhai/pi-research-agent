#!/usr/bin/env node
// test-worker.mjs — 协议测试脚本（verifier #2）
// 验证 worker.py 的 JSON-lines 协议双端契约
// 运行: node pi/.pi/research-kernel/test-worker.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "worker.py");
const READY_TIMEOUT_MS = 90_000; // 首次 uv 装包可能需要较长时间

// ── 启动 worker 进程 ───────────────────────────────────────────────────────────
const child = spawn("uv", ["run", "--script", WORKER_PATH], {
  cwd: __dirname,
  stdio: ["pipe", "pipe", "pipe"],
});

// 收集 stderr 用于调试（不作为协议流）
let stderrBuf = "";
child.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString();
});

child.on("error", (err) => {
  console.error("spawn error:", err);
  process.exit(1);
});

// ── 行缓冲 + 消息队列 ─────────────────────────────────────────────────────────
const lines = [];
const waiters = []; // Array<(line: string) => void>

const rl = createInterface({ input: child.stdout });
rl.on("line", (raw) => {
  // 跳过非 JSON 行（uv 进度信息等）
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return;

  if (waiters.length > 0) {
    const resolve = waiters.shift();
    resolve(trimmed);
  } else {
    lines.push(trimmed);
  }
});

/** 等待下一条协议 JSON 行，超时则 reject */
function nextLine(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(resolve);
      if (idx !== -1) waiters.splice(idx, 1);
      reject(new Error(`等待协议行超时（${timeoutMs}ms）。stderr:\n${stderrBuf}`));
    }, timeoutMs);

    if (lines.length > 0) {
      clearTimeout(timer);
      resolve(lines.shift());
      return;
    }
    waiters.push((line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

/** 向 worker stdin 发送一个 JSON job */
function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

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

// ── 主测试流程 ────────────────────────────────────────────────────────────────
async function run() {
  // Step 0: 等待 ready 握手
  console.log("\n[Step 0] 等待 ready 握手（超时 90s，首次 uv 装包）...");
  let readyRaw;
  try {
    readyRaw = await nextLine(READY_TIMEOUT_MS);
  } catch (err) {
    console.error("FATAL: ready 握手失败:", err.message);
    child.kill();
    process.exit(1);
  }
  const ready = JSON.parse(readyRaw);
  assert("ready.type === 'ready'", ready.type, "ready");
  assert("ready.python 存在", typeof ready.python, "string");
  assert("ready.packages 存在", typeof ready.packages, "object");
  console.log(`  信息: python=${ready.python}, packages=${JSON.stringify(ready.packages)}`);

  // Step 1: exec x=1 → ok, value_repr="", value_type="NoneType"
  console.log("\n[Step 1] exec(x = 1) → 赋值语句，期望 value_repr=''");
  send({ id: "j1", type: "exec", code: "x = 1" });
  const r1 = JSON.parse(await nextLine());
  assert("j1.id", r1.id, "j1");
  assert("j1.type", r1.type, "result");
  assert("j1.status", r1.status, "ok");
  assert("j1.value_repr", r1.value_repr, "");
  assert("j1.value_type", r1.value_type, "NoneType");

  // Step 2: exec x+1 → 验有状态持久，期望 value_repr="2"
  console.log("\n[Step 2] exec(x + 1) → 验有状态持久，期望 value_repr='2'");
  send({ id: "j2", type: "exec", code: "x + 1" });
  const r2 = JSON.parse(await nextLine());
  assert("j2.id", r2.id, "j2");
  assert("j2.status", r2.status, "ok");
  assert("j2.value_repr", r2.value_repr, "2");
  assert("j2.value_type", r2.value_type, "int");

  // Step 3: exec print('hi')\n3 → stdout 捕获 + 末行回显
  console.log("\n[Step 3] exec(print('hi')\\n3) → stdout 捕获 + 末行回显");
  send({ id: "j3", type: "exec", code: "print('hi')\n3" });
  const r3 = JSON.parse(await nextLine());
  assert("j3.id", r3.id, "j3");
  assert("j3.status", r3.status, "ok");
  assert("j3.stdout", r3.stdout, "hi\n");
  assert("j3.value_repr", r3.value_repr, "3");

  // Step 4: exec 1/0 → status error, error_type ZeroDivisionError
  console.log("\n[Step 4] exec(1/0) → 期望 status='error', error_type='ZeroDivisionError'");
  send({ id: "j4", type: "exec", code: "1/0" });
  const r4 = JSON.parse(await nextLine());
  assert("j4.id", r4.id, "j4");
  assert("j4.status", r4.status, "error");
  assert("j4.error_type", r4.error_type, "ZeroDivisionError");
  assertContains("j4.error 含 'ZeroDivisionError'", r4.error, "ZeroDivisionError");

  // Step 5: reset → status ok, value_repr="", value_type="NoneType"
  console.log("\n[Step 5] reset → 清空命名空间");
  send({ id: "j5", type: "reset" });
  const r5 = JSON.parse(await nextLine());
  assert("j5.id", r5.id, "j5");
  assert("j5.status", r5.status, "ok");
  assert("j5.value_repr", r5.value_repr, "");
  assert("j5.value_type", r5.value_type, "NoneType");

  // Step 6: exec x → 验 reset 生效，期望 NameError
  console.log("\n[Step 6] exec(x) → 验 reset 生效，期望 error_type='NameError'");
  send({ id: "j6", type: "exec", code: "x" });
  const r6 = JSON.parse(await nextLine());
  assert("j6.id", r6.id, "j6");
  assert("j6.status", r6.status, "error");
  assert("j6.error_type", r6.error_type, "NameError");

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(50));
  console.log(`结果: ${passed} 通过 / ${failed} 失败`);
  if (failed === 0) {
    console.log("ALL PASS");
  } else {
    console.log("FAILED");
    if (stderrBuf) {
      console.error("\nstderr 输出:\n" + stderrBuf);
    }
  }

  child.stdin.end();
  child.kill();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("未捕获异常:", err);
  child.kill();
  process.exit(1);
});
