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

  // 启动桩 embedding server 并指向它（resolveEmbeddingProvider 在 CALL 时读 env）
  await new Promise((r) => embedServer.listen(0, "127.0.0.1", r));
  const embedPort = embedServer.address().port;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${embedPort}/v1`;
  process.env.EMBEDDING_MODEL = "fake-embed";
  delete process.env.OPENAI_API_KEY;

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

  // ───────────────────────────────────────────────────────────────────────────
  // S3: 自动归档成功实验（钩子 → LLM 抽取 → embed → 写 jsonl）
  // ───────────────────────────────────────────────────────────────────────────
  section("[S3] tool_result 钩子自动归档成功实验 + embedding");
  {
    clearME();
    llmQueue = [extractionMsg({ title: "GD demo", summary: "gradient descent converged", key_metrics: { loss: 0.12 }, tags: ["gradient", "descent"] })];
    llmCallCount = 0;
    llmCaptured.length = 0;
    const code = "for i in range(100): w -= lr * grad  # gradient descent";
    await fireToolResult({ code, text: "step 99 loss=0.12\n=> None  (NoneType)\n[ok, 88ms]" });
    const rows = readME();
    check("写入 1 条", rows.length === 1, `len=${rows.length}`);
    const e = rows[0];
    check("source=auto", e?.source === "auto", JSON.stringify(e?.source));
    check("outcome=success", e?.outcome === "success", JSON.stringify(e?.outcome));
    check("title 来自 LLM", e?.title === "GD demo", JSON.stringify(e?.title));
    check("key_metrics.loss=0.12", e?.key_metrics?.loss === 0.12, JSON.stringify(e?.key_metrics));
    check("durationMs=88", e?.durationMs === 88, JSON.stringify(e?.durationMs));
    check("codeHash 非空", typeof e?.codeHash === "string" && e.codeHash.length > 0, "");
    check("embedding 已写入(dim=6)", Array.isArray(e?.embedding) && e.embedding.length === 6, JSON.stringify(e?.embedding));
    check("embeddingModel=fake-embed", e?.embeddingModel === "fake-embed", JSON.stringify(e?.embeddingModel));
    // 反假绿：LLM 真被调用且收到 CODE/OUTPUT
    check("LLM 被调用 1 次", llmCallCount === 1, `count=${llmCallCount}`);
    check("反假绿: 抽取 ctx 含 code 原文", (llmCaptured[0]?.messages?.[0]?.content ?? "").includes("gradient descent"), "");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S4: 精确去重（同 codeHash 第二次 → 不重复写）
  // ───────────────────────────────────────────────────────────────────────────
  section("[S4] 同代码二次归档去重");
  {
    clearME();
    llmQueue = [extractionMsg({ title: "dup", summary: "s", key_metrics: {}, tags: [] }), extractionMsg({ title: "dup2", summary: "s2", key_metrics: {}, tags: [] })];
    const code = "print('same code')";
    await fireToolResult({ code, text: "same code\n[ok, 5ms]" });
    await fireToolResult({ code, text: "same code\n[ok, 6ms]" });
    check("去重后仅 1 条", readME().length === 1, `len=${readME().length}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S5: 失败实验也归档（outcome=failure）
  // ───────────────────────────────────────────────────────────────────────────
  section("[S5] 失败实验归档");
  {
    clearME();
    llmQueue = [extractionMsg({ title: "boom", summary: "raised ValueError", key_metrics: {}, tags: ["bug"] })];
    await fireToolResult({ code: "raise ValueError('x')", text: "Traceback...\nValueError: x\n[error: ValueError, 12ms]" });
    const rows = readME();
    check("写入 1 条", rows.length === 1, `len=${rows.length}`);
    check("outcome=failure", rows[0]?.outcome === "failure", JSON.stringify(rows[0]?.outcome));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S6: RUNNING / 非 run_python 不归档
  // ───────────────────────────────────────────────────────────────────────────
  section("[S6] RUNNING 与非 run_python 跳过");
  {
    clearME();
    llmQueue = [];
    await fireToolResult({ code: "x=1", text: "RUNNING: job did not finish within 60s.\njob_id=job-9" });
    check("RUNNING → 不归档", readME().length === 0, `len=${readME().length}`);
    await fireToolResult({ code: "x=1", text: "x\n[ok, 1ms]", toolName: "web_search" });
    check("非 run_python → 不归档", readME().length === 0, `len=${readME().length}`);

    // ⑥ 钩子内部异常被吞掉，绝不向上抛（run_python 结果照常返回 agent）
    clearME();
    const evilCtx = {
      get model() {
        throw new Error("boom");
      },
      signal: undefined,
    };
    let threw = false;
    try {
      await fireToolResult({ code: "y=1", text: "y\n[ok, 1ms]", ctx: evilCtx });
    } catch {
      threw = true;
    }
    check("钩子吞掉内部异常（不抛）", threw === false, "");
    check("异常路径未写入 M_E", readME().length === 0, `len=${readME().length}`);
  }

  // 辅助：直接造一条 M_E 记录（绕过钩子，用于检索/降级场景）
  function seedEntry(e) {
    writeFileSync(M_E_FILE, (readME().concat([e])).map((x) => JSON.stringify(x)).join("\n") + "\n");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S7: query_memory 语义 hybrid 排序（关键词打平，语义决定顺序）
  // ───────────────────────────────────────────────────────────────────────────
  section("[S7] query_memory 语义 hybrid 排序");
  {
    clearME();
    // 两条都含关键词 "gradient"（kw 打平=1）；向量不同 → 仅语义能决定排序。
    // 故意先 seed 语义较弱的 mix：语义失效时稳定排序会把 mix 排前 → 供 Task 14 反假绿。
    seedEntry({ id: "exp-mix", timestamp: "t", title: "mixed gradient sort", description: "gradient plus sorting", outcome: "success", tags: ["gradient"], source: "auto", code: "mix()", embedding: [1, 0, 0, 0, 1, 0], embeddingModel: "fake-embed", embeddingDim: 6 });
    seedEntry({ id: "exp-grad", timestamp: "t", title: "gradient specialist", description: "pure gradient work", outcome: "success", tags: ["gradient"], source: "auto", code: "grad()", embedding: [2, 0, 0, 0, 0, 0], embeddingModel: "fake-embed", embeddingDim: 6 });
    // 查询 "gradient" → 桩向量 [1,0,0,0,0,0]：cos(grad)=1.0 > cos(mix)=0.707；kw 两者都=1
    const res = await tools["query_memory"].execute("c", { query: "gradient", limit: 5 }, undefined, () => {}, mockCtx);
    const text = res?.content?.[0]?.text ?? "";
    const gradPos = text.indexOf("gradient specialist");
    const mixPos = text.indexOf("mixed gradient sort");
    check("两条都命中", gradPos !== -1 && mixPos !== -1, text);
    check("语义更贴近的 specialist 排在 mix 之前", gradPos < mixPos, `grad=${gradPos} mix=${mixPos}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S8: provider 不可用（待激活态）→ 退纯关键词，仍可检索
  // ───────────────────────────────────────────────────────────────────────────
  section("[S8] provider 未配置 → 关键词降级");
  {
    clearME();
    seedEntry({ id: "exp-fft", timestamp: "t", title: "fourier transform run", description: "spectral via fourier", outcome: "success", tags: ["fourier"], source: "auto", code: "fft()" });
    const savedBase = process.env.OPENAI_BASE_URL;
    const savedModel = process.env.EMBEDDING_MODEL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    const res = await tools["query_memory"].execute("c", { query: "fourier", limit: 5 }, undefined, () => {}, mockCtx);
    const text = res?.content?.[0]?.text ?? "";
    check("无 provider 仍按关键词命中 fourier", text.includes("fourier transform run"), text);
    process.env.OPENAI_BASE_URL = savedBase;
    process.env.EMBEDDING_MODEL = savedModel;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S9: 维度/模型不匹配 → 该条跳过语义分（不崩），仍可关键词命中
  // ───────────────────────────────────────────────────────────────────────────
  section("[S9] 向量维度不匹配不崩");
  {
    clearME();
    seedEntry({ id: "exp-mm", timestamp: "t", title: "matrix mismatch", description: "old vector dim 3", outcome: "success", tags: ["matrix"], source: "auto", embedding: [1, 2, 3], embeddingModel: "old-model", embeddingDim: 3, code: "m()" });
    const res = await tools["query_memory"].execute("c", { query: "matrix", limit: 5 }, undefined, () => {}, mockCtx);
    const text = res?.content?.[0]?.text ?? "";
    check("维度不匹配条目仍关键词命中（无异常）", text.includes("matrix mismatch"), text);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // S10: LLM 抽取失败（stopReason error）→ 仍归档，key_metrics 空
  // ───────────────────────────────────────────────────────────────────────────
  section("[S10] LLM 抽取失败不阻断归档");
  {
    clearME();
    llmQueue = [stopErrorMsg("model-down")];
    await fireToolResult({ code: "compute_sort([3,1,2])", text: "sorted=[1,2,3]\n[ok, 7ms]" });
    const rows = readME();
    check("仍写入 1 条", rows.length === 1, `len=${rows.length}`);
    check("outcome=success", rows[0]?.outcome === "success", "");
    check("key_metrics 空/缺省", !rows[0]?.key_metrics || Object.keys(rows[0].key_metrics).length === 0, JSON.stringify(rows[0]?.key_metrics));
    check("description 回退为 stdout 首行", (rows[0]?.description ?? "").includes("sorted=[1,2,3]"), JSON.stringify(rows[0]?.description));
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
