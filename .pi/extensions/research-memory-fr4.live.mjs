#!/usr/bin/env node
// research-memory-fr4.live.mjs — FR-4 实验记忆 M_E mock-provider live 集成测试
//
// 运行(tsconfig paths 把 @earendil-works/pi-ai 重定向到 packages/ai/src, 免构建 dist):
//   TSX_TSCONFIG_PATH=/home/aaron/project1/pi/tsconfig.json \
//     node --import tsx /home/aaron/project1/pi/.pi/extensions/research-memory-fr4.live.mjs
//
// 隔离策略:
//   - HOME 指向临时目录(import research-memory.ts 前设好; 其 MEMORY_DIR=homedir()+/.pi 在模块求值时定)
//   - embedding: 进程内 node:http 桩 server, 按 vocab 词频产出确定可比向量, 设 OPENAI_BASE_URL 指向它
//   - LLM: registerApiProvider DUCK-TYPE mock, streamSimple 出队一条 AssistantMessage, captured[] 反假绿
//   - 经 mock pi 捕获扩展注册的 tools/commands/hooks, 直接 invoke

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

// ── 1. 临时 HOME（必须在 import research-memory.ts 之前）──
const TMP_HOME = mkdtempSync(join(tmpdir(), "fr4-me-"));
process.env.HOME = TMP_HOME;
const M_E_FILE = join(TMP_HOME, ".pi", "research-memory", "experiments.jsonl");

// ── 2. 桩 embedding server：vocab 词频向量（确定、可比 cosine）──
const VOCAB = ["gradient", "descent", "fourier", "transform", "sort", "matrix"];
function fakeEmbed(text) {
  const lower = String(text).toLowerCase();
  return VOCAB.map((w) => lower.split(w).length - 1);
}
const embedServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let input = "";
    try {
      input = JSON.parse(body).input;
    } catch {}
    const text = Array.isArray(input) ? input.join(" ") : String(input);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: fakeEmbed(text), index: 0 }],
        model: "fake-embed",
      }),
    );
  });
});

// ── 3. mock LLM provider（DUCK-TYPE，对标 aris live 范式）──
const { registerApiProvider, unregisterApiProviders } = await import("@earendil-works/pi-ai");
const MOCK_API = "mock-fr4-embed-llm";
const SOURCE_ID = "fr4-me-live";
const mockModel = { api: MOCK_API, provider: MOCK_API };
let llmQueue = [];
const llmCaptured = [];
let llmCallCount = 0;

function baseMsg(extra) {
  return {
    role: "assistant",
    api: MOCK_API,
    provider: MOCK_API,
    model: "mock-fr4-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    ...extra,
  };
}
function extractionMsg(obj) {
  return baseMsg({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(obj) }] });
}
function rawMsg(text) {
  return baseMsg({ stopReason: "stop", content: [{ type: "text", text }] });
}
function stopErrorMsg(reason) {
  return baseMsg({ stopReason: "error", errorMessage: reason, content: [] });
}

registerApiProvider(
  {
    api: MOCK_API,
    // register 要求 stream 存在（被 wrapStream 引用），但 completeSimple 路径只走 streamSimple；给永不调用的桩。
    stream: () => {
      throw new Error("mock.stream should not be called");
    },
    // DUCK-TYPE：streamSimple 返回 {result: async()=>msg}。completeSimple 只调 .result() 一次即穿透
    // （实证 packages/ai/src/stream.ts:72-73 completeSimple = streamSimple().result()），
    // 与 aris-review-adversarial.live.mjs / research-kernel-autodebug.live.mjs 同范式，勿改成 createAssistantMessageEventStream。
    streamSimple: (_model, context, _options) => {
      llmCallCount++;
      llmCaptured.push(context);
      const item = llmQueue.shift();
      if (item === undefined) throw new Error("mock LLM queue exhausted");
      return { result: async () => item };
    },
  },
  SOURCE_ID,
);

// ── 4. import 扩展（HOME 已设好；动态 import 是为了在 HOME 设定后再求值模块，
//        使 MEMORY_DIR=homedir()+/.pi 落到临时 HOME。绝对路径对齐仓库测试惯例）──
const mod = await import("/home/aaron/project1/pi/.pi/extensions/research-memory.ts");
const ext = mod.default;
const { parseKernelResult, buildExtractionContext, parseExtractionResponse, buildEmbedText } = mod;

// ── 5. mock pi 捕获注册物 ──
const tools = {};
const commands = {};
const hooks = {};
const mockPi = {
  registerTool: (def) => {
    tools[def.name] = def;
  },
  registerCommand: (name, def) => {
    commands[name] = def;
  },
  on: (evt, h) => {
    (hooks[evt] ??= []).push(h);
  },
};
ext(mockPi);

// ── 6. mock ctx（钩子/命令用；query_memory.execute 用自己的 signal 参数）──
const notifications = [];
const mockCtx = {
  model: mockModel,
  signal: undefined,
  ui: { notify: (m) => notifications.push(String(m)), confirm: async () => true },
};

// ── 断言工具 ──
let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

// ── M_E jsonl 读写工具 ──
function readME() {
  if (!existsSync(M_E_FILE)) return [];
  return readFileSync(M_E_FILE, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
function clearME() {
  if (existsSync(M_E_FILE)) writeFileSync(M_E_FILE, "");
}

// ── 触发 tool_result 自动归档钩子 ──
async function fireToolResult({ code, text, isError = false, toolName = "run_python", ctx = mockCtx }) {
  const handler = hooks["tool_result"][0];
  return handler(
    {
      type: "tool_result",
      toolName,
      toolCallId: "tc1",
      input: { code },
      content: [{ type: "text", text }],
      isError,
      details: undefined,
    },
    ctx,
  );
}

function cleanupAndExit() {
  try {
    unregisterApiProviders(SOURCE_ID);
  } catch {}
  embedServer.close();
  console.log(`\n${"─".repeat(60)}`);
  console.log(`passed=${passed} failed=${failed}`);
  console.log(failed === 0 ? "FR-4 LIVE ALL PASS" : "FR-4 LIVE FAIL");
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  console.log("=== FR-4 实验记忆 M_E mock-provider live 测试 ===");
  console.log(`(HOME=${TMP_HOME}; 零真实 embedding 模型 / 零真实 LLM)\n`);

  // ───────────────────────────────────────────────────────────────────────────
  // S1: parseKernelResult 纯解析（formatResult 文本 → outcome/stdout/durationMs）
  // ───────────────────────────────────────────────────────────────────────────
  section("[S1] parseKernelResult 纯解析");
  {
    const ok = parseKernelResult("hello world\n=> 42  (int)\n[ok, 123ms]", false);
    check("ok: outcome=success", ok?.outcome === "success", JSON.stringify(ok));
    check("ok: durationMs=123", ok?.durationMs === 123, JSON.stringify(ok));
    check("ok: stdout 去掉标记行", ok?.stdout === "hello world\n=> 42  (int)", JSON.stringify(ok?.stdout));

    const err = parseKernelResult("partial out\nValueError: boom\n[error: ValueError, 45ms]", false);
    check("err: outcome=failure", err?.outcome === "failure", JSON.stringify(err));
    check("err: durationMs=45", err?.durationMs === 45, JSON.stringify(err));

    const running = parseKernelResult("RUNNING: job did not finish within 60s.\njob_id=job-1", false);
    check("RUNNING → null（跳过归档）", running === null, JSON.stringify(running));

    const kernelErr = parseKernelResult("Kernel error: worker not available", true);
    check("isError=true → inconclusive", kernelErr?.outcome === "inconclusive", JSON.stringify(kernelErr));

    check("空文本 → null", parseKernelResult("   ", false) === null, "");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S2: buildExtractionContext / parseExtractionResponse 纯逻辑
  // ───────────────────────────────────────────────────────────────────────────
  section("[S2] LLM 抽取上下文构造 + 响应解析");
  {
    const ctx = buildExtractionContext("print(loss)", "loss=0.23");
    check("ctx.systemPrompt 非空", typeof ctx.systemPrompt === "string" && ctx.systemPrompt.length > 0, "");
    const user = ctx.messages?.[0]?.content ?? "";
    check("user content 含 CODE 原文", user.includes("print(loss)"), user.slice(0, 120));
    check("user content 含 OUTPUT 原文", user.includes("loss=0.23"), user.slice(0, 120));
    check("messages[0].role=user", ctx.messages?.[0]?.role === "user", "");

    const parsed = parseExtractionResponse(
      '```json\n{"title":"GD test","summary":"loss converged","key_metrics":{"loss":0.23},"tags":["optim"]}\n```',
    );
    check("解析带围栏 JSON：title", parsed?.title === "GD test", JSON.stringify(parsed));
    check("解析：key_metrics.loss=0.23", parsed?.key_metrics?.loss === 0.23, JSON.stringify(parsed));
    check("解析：tags", JSON.stringify(parsed?.tags) === JSON.stringify(["optim"]), JSON.stringify(parsed));

    const bare = parseExtractionResponse('prefix {"title":"X","key_metrics":{"acc":0.9}} suffix');
    check("解析裸 JSON（前后有杂质）：title=X", bare?.title === "X", JSON.stringify(bare));

    check("非 JSON → null", parseExtractionResponse("totally not json") === null, "");
    const dropped = parseExtractionResponse('{"key_metrics":{"good":1,"bad":[1,2]}}');
    check("key_metrics 仅留 number|string", JSON.stringify(dropped?.key_metrics) === JSON.stringify({ good: 1 }), JSON.stringify(dropped));
  }

  cleanupAndExit();
}

main().catch((err) => {
  console.error("\n[FATAL] 未捕获异常:", err);
  try {
    unregisterApiProviders(SOURCE_ID);
  } catch {}
  try {
    embedServer.close();
  } catch {}
  process.exit(1);
});
