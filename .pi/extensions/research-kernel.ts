/**
 * 科研 Agent 执行层扩展
 *
 * 架构来源: 整合后的架构.md — 执行层（Jupyter 持久内核）+ Micro-loop（自诊断）
 * 方案 A: uv 持久 Python worker + 有状态命名空间 + 软超时异步轮询 + 错误自修复 Micro-loop。
 *
 * 与 worker.py 经 JSON-lines 协议强耦合（双端字段契约见 research-execution-layer.md §3）。
 * 记忆归档复用 research-memory.ts 的 save_experiment（SRP）；本层不直接写 M_E。
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { completeSimple } from "@earendil-works/pi-ai";
import type { Context, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// uv 首次运行需建缓存 venv 并装包，握手超时给足。
const READY_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_WAIT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const DEBUG_SYSTEM_PROMPT = `你是 Python 调试器。给定 目标(GOAL) + 代码(CODE) + 报错 traceback(ERROR)，只输出修正后的完整可执行代码，禁止任何解释、禁止 markdown 围栏以外的文字。`;

type JobStatus = "running" | "ok" | "error";

type JobResult = {
	id: string;
	status: JobStatus;
	stdout: string;
	valueRepr: string;
	valueType: string;
	error?: string;
	errorType?: string;
	durationMs: number;
};

type RunningHandle = { running: true; id: string };

type ReadyInfo = {
	python: string;
	packages: Record<string, string>;
};

// worker 协议输出行的原始形态（snake_case，与 worker.py 一致）。
type ProtocolLine = {
	id?: string;
	type?: string;
	status?: string;
	stdout?: string;
	value_repr?: string;
	value_type?: string;
	error?: string;
	error_type?: string;
	duration_ms?: number;
	python?: string;
	packages?: Record<string, string>;
};

// 挂起 job: reader 永不阻塞，结果到达即 settle 并缓存，供 poll 取回。
type PendingJob = {
	resolve: (result: JobResult) => void;
	settled: boolean;
	result?: JobResult;
};

function resolveWorkerPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "research-kernel", "worker.py");
}

function extractTextContent(content: (TextContent | ThinkingContent | ToolCall)[]): string {
	return content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

// 从模型回复提取代码: 优先 ```python``` / ``` 围栏，无围栏则取裸文本 trim。
export function extractCode(text: string): string {
	const fenced = text.match(/```(?:python)?\s*\n([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	return text.trim();
}

export function mapResult(line: ProtocolLine): JobResult {
	return {
		id: line.id ?? "",
		status: line.status === "error" ? "error" : "ok",
		stdout: line.stdout ?? "",
		valueRepr: line.value_repr ?? "",
		valueType: line.value_type ?? "NoneType",
		error: line.error,
		errorType: line.error_type,
		durationMs: line.duration_ms ?? 0,
	};
}

export function formatResult(result: JobResult): string {
	const lines: string[] = [];
	if (result.status === "ok") {
		if (result.stdout) lines.push(result.stdout.replace(/\n$/, ""));
		if (result.valueRepr) lines.push(`=> ${result.valueRepr}  (${result.valueType})`);
		if (lines.length === 0) lines.push("(no output)");
		lines.push(`[ok, ${result.durationMs}ms]`);
	} else {
		if (result.stdout) lines.push(result.stdout.replace(/\n$/, ""));
		lines.push(result.error ?? "(unknown error)");
		lines.push(`[error: ${result.errorType ?? "Error"}, ${result.durationMs}ms]`);
	}
	return lines.join("\n");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
		}
	});
}

export class KernelManager {
	child: ChildProcessWithoutNullStreams | null = null;
	pending = new Map<string, PendingJob>();
	readyPromise: Promise<ReadyInfo> | null = null;
	jobCounter = 0;
	jobsRun = 0;
	stderrBuffer = "";
	readonly workerPath: string;
	readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
		this.workerPath = resolveWorkerPath();
	}

	ensureStarted(): Promise<ReadyInfo> {
		if (this.readyPromise) return this.readyPromise;

		this.readyPromise = new Promise<ReadyInfo>((resolve, reject) => {
			const child = spawn("uv", ["run", "--script", this.workerPath], {
				cwd: this.cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;

			const timer = setTimeout(() => {
				reject(new Error(`worker ready timeout after ${READY_TIMEOUT_MS}ms; stderr:\n${this.stderrBuffer}`));
			}, READY_TIMEOUT_MS);

			const rl = createInterface({ input: child.stdout });
			rl.on("line", (line) => {
				const parsed = this.onLine(line);
				if (parsed && parsed.type === "ready") {
					clearTimeout(timer);
					resolve({ python: parsed.python ?? "", packages: parsed.packages ?? {} });
				}
			});

			child.stderr.on("data", (chunk: Buffer) => {
				this.stderrBuffer += chunk.toString();
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.on("exit", (code) => {
				clearTimeout(timer);
				// 子进程退出: 标记所有未结算 job 为 error，避免调用方永久挂起。
				this.failAllPending(`worker exited with code ${code}`);
				this.child = null;
			});
		});

		return this.readyPromise;
	}

	async exec(code: string, signal?: AbortSignal, softTimeoutMs = DEFAULT_EXEC_TIMEOUT_MS): Promise<JobResult | RunningHandle> {
		await this.ensureStarted();
		const child = this.child;
		if (!child) throw new Error("worker not available");

		const id = `job-${++this.jobCounter}`;
		const deferred = this.registerPending(id);
		child.stdin.write(`${JSON.stringify({ id, type: "exec", code })}\n`);

		const timeout = delay(softTimeoutMs, signal).then((): RunningHandle => ({ running: true, id }));
		return Promise.race([deferred, timeout]);
	}

	async poll(id: string, waitMs = DEFAULT_POLL_WAIT_MS, signal?: AbortSignal): Promise<JobResult | RunningHandle> {
		const job = this.pending.get(id);
		if (!job) {
			// 未知 id: 可能已被取走或从未存在。
			return { running: true, id };
		}
		if (job.settled && job.result) return job.result;

		const deferred = new Promise<JobResult>((resolve) => {
			const prev = job.resolve;
			job.resolve = (result) => {
				prev(result);
				resolve(result);
			};
		});
		const timeout = delay(waitMs, signal).then((): RunningHandle => ({ running: true, id }));
		return Promise.race([deferred, timeout]);
	}

	async reset(signal?: AbortSignal): Promise<JobResult> {
		await this.ensureStarted();
		const child = this.child;
		if (!child) throw new Error("worker not available");

		const id = `job-${++this.jobCounter}`;
		const deferred = this.registerPending(id);
		child.stdin.write(`${JSON.stringify({ id, type: "reset" })}\n`);

		const timeout = delay(READY_TIMEOUT_MS, signal).then((): JobResult => ({
			id,
			status: "error",
			stdout: "",
			error: "reset timeout",
			errorType: "TimeoutError",
			valueRepr: "",
			valueType: "NoneType",
			durationMs: READY_TIMEOUT_MS,
		}));
		return Promise.race([deferred, timeout]);
	}

	registerPending(id: string): Promise<JobResult> {
		return new Promise<JobResult>((resolve) => {
			this.pending.set(id, { resolve, settled: false });
		});
	}

	onLine(line: string): ProtocolLine | null {
		let parsed: ProtocolLine;
		try {
			parsed = JSON.parse(line) as ProtocolLine;
		} catch {
			return null; // 容忍 uv/warning 杂质行
		}

		if (parsed.type === "result" && parsed.id) {
			const job = this.pending.get(parsed.id);
			if (job && !job.settled) {
				const result = mapResult(parsed);
				job.settled = true;
				job.result = result;
				this.jobsRun++;
				job.resolve(result);
			}
		}
		return parsed;
	}

	failAllPending(reason: string): void {
		for (const [id, job] of this.pending) {
			if (!job.settled) {
				const result: JobResult = {
					id,
					status: "error",
					stdout: "",
					error: reason,
					errorType: "WorkerExited",
					valueRepr: "",
					valueType: "NoneType",
					durationMs: 0,
				};
				job.settled = true;
				job.result = result;
				job.resolve(result);
			}
		}
	}

	status(): { alive: boolean; jobsRun: number; pending: number } {
		let pendingCount = 0;
		for (const job of this.pending.values()) {
			if (!job.settled) pendingCount++;
		}
		return {
			alive: this.child !== null && !this.child.killed,
			jobsRun: this.jobsRun,
			pending: pendingCount,
		};
	}

	dispose(): void {
		if (this.child) {
			this.child.kill();
			this.child = null;
		}
		this.readyPromise = null;
	}
}

export default function researchKernelExtension(pi: ExtensionAPI) {
	let manager: KernelManager | null = null;

	// 延迟初始化: 首个工具 execute 时用 ctx.cwd 构造，确保 cwd 准确。
	function getManager(cwd: string): KernelManager {
		if (!manager) manager = new KernelManager(cwd);
		return manager;
	}

	pi.registerTool({
		name: "run_python",
		label: "Run Python (Persistent Kernel)",
		description:
			"Execute Python code in a persistent, stateful kernel (variables and imports survive across calls). " +
			"Pre-loaded scientific stack: numpy, scipy, sympy, pandas. " +
			"The last expression is echoed Jupyter-style (value_repr). " +
			"If execution exceeds timeout_s the job keeps running in the background — you get a job_id; " +
			"retrieve the result later with poll_python. Use kernel_reset to clear state.",
		parameters: Type.Object({
			code: Type.String({ description: "Python source to execute. Last bare expression is echoed back." }),
			timeout_s: Type.Optional(
				Type.Number({ description: "Soft timeout in seconds (default 60). On timeout returns a job_id, does not kill the job." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const mgr = getManager(ctx.cwd);
			const softTimeoutMs = (params.timeout_s ?? 60) * 1000;
			try {
				const outcome = await mgr.exec(params.code, signal, softTimeoutMs);
				if ("running" in outcome) {
					return {
						content: [
							{
								type: "text",
								text: `RUNNING: job did not finish within ${params.timeout_s ?? 60}s.\njob_id=${outcome.id}\nUse poll_python(job_id="${outcome.id}") to retrieve the result.`,
							},
						],
						details: undefined,
					};
				}
				return { content: [{ type: "text", text: formatResult(outcome) }], details: undefined };
			} catch (err) {
				return {
					content: [{ type: "text", text: `Kernel error: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "poll_python",
		label: "Poll Python Job",
		description:
			"Retrieve the result of a long-running run_python job by its job_id. " +
			"If the job is finished, returns its output; otherwise reports it is still running.",
		parameters: Type.Object({
			job_id: Type.String({ description: "The job_id returned by run_python when it timed out." }),
			wait_s: Type.Optional(
				Type.Number({ description: "Max seconds to wait for completion before returning (default 10)." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const mgr = getManager(ctx.cwd);
			const waitMs = (params.wait_s ?? 10) * 1000;
			try {
				const outcome = await mgr.poll(params.job_id, waitMs, signal);
				if ("running" in outcome) {
					return {
						content: [
							{
								type: "text",
								text: `STILL RUNNING: job ${params.job_id} has not finished. Poll again with poll_python.`,
							},
						],
						details: undefined,
					};
				}
				return { content: [{ type: "text", text: formatResult(outcome) }], details: undefined };
			} catch (err) {
				return {
					content: [{ type: "text", text: `Poll error: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "auto_debug_python",
		label: "Auto-Debug Python (Self-healing Micro-loop)",
		description:
			"Run Python code and, on error, automatically repair it via the model and retry — a self-diagnosing Micro-loop. " +
			"Provide the goal so the repair model knows the intent. Loops until success or max_attempts. " +
			"Returns the attempt history, the final code, and the outcome. " +
			"On success, consider save_experiment to archive the result to M_E (not done automatically).",
		parameters: Type.Object({
			code: Type.String({ description: "Initial Python code to run and repair if it fails." }),
			goal: Type.String({ description: "What the code is supposed to achieve. Guides the repair model." }),
			max_attempts: Type.Optional(
				Type.Number({ description: "Max run+repair attempts (default 3)." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!ctx.model) {
				return {
					content: [{ type: "text", text: "Error: no model available for auto_debug_python repair loop." }],
					isError: true,
					details: undefined,
				};
			}
			const mgr = getManager(ctx.cwd);
			const maxAttempts = params.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
			const model = ctx.model;

			let code = params.code;
			const history: string[] = [];

			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				let outcome: JobResult | RunningHandle;
				try {
					outcome = await mgr.exec(code, signal);
				} catch (err) {
					return {
						content: [{ type: "text", text: `Kernel error during attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}` }],
						isError: true,
						details: undefined,
					};
				}

				if ("running" in outcome) {
					history.push(`Attempt ${attempt}: TIMED OUT (job_id=${outcome.id}), aborting Micro-loop.`);
					return {
						content: [
							{
								type: "text",
								text: [
									...history,
									"",
									`Final code:\n${code}`,
									`Outcome: INCONCLUSIVE — job still running as ${outcome.id}, retrieve with poll_python.`,
								].join("\n"),
							},
						],
						details: undefined,
					};
				}

				if (outcome.status === "ok") {
					history.push(`Attempt ${attempt}: OK (${outcome.durationMs}ms)`);
					return {
						content: [
							{
								type: "text",
								text: [
									...history,
									"",
									`Final code:\n${code}`,
									"",
									formatResult(outcome),
									"",
									"Outcome: SUCCESS. Consider save_experiment to archive this result to M_E.",
								].join("\n"),
							},
						],
						details: undefined,
					};
				}

				// 失败: 记录并请求模型修复（除非已是最后一次尝试）。
				history.push(`Attempt ${attempt}: ERROR ${outcome.errorType ?? "Error"}`);
				if (attempt === maxAttempts) break;

				const context: Context = {
					systemPrompt: DEBUG_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: `GOAL:\n${params.goal}\n\nCODE:\n${code}\n\nERROR:\n${outcome.error ?? outcome.errorType ?? "unknown error"}`,
							timestamp: Date.now(),
						},
					],
				};

				try {
					const repair = await completeSimple(model, context, { signal });
					if (repair.stopReason === "error" || repair.stopReason === "aborted") {
						history.push(`Repair ${attempt}: model failed (${repair.errorMessage ?? repair.stopReason}), aborting.`);
						break;
					}
					const repaired = extractCode(extractTextContent(repair.content));
					if (!repaired) {
						history.push(`Repair ${attempt}: model returned empty code, aborting.`);
						break;
					}
					code = repaired;
				} catch (err) {
					history.push(`Repair ${attempt}: error ${err instanceof Error ? err.message : String(err)}, aborting.`);
					break;
				}
			}

			return {
				content: [
					{
						type: "text",
						text: [
							...history,
							"",
							`Final code:\n${code}`,
							"",
							`Outcome: FAILED after ${maxAttempts} attempt(s). Manual intervention or research_checkpoint (PIVOT) advised.`,
						].join("\n"),
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "kernel_reset",
		label: "Reset Python Kernel",
		description:
			"Clear the persistent kernel namespace (all variables and imports). " +
			"Use to start a clean computation without restarting the worker process.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const mgr = getManager(ctx.cwd);
			try {
				const result = await mgr.reset(signal);
				if (result.status === "error") {
					return {
						content: [{ type: "text", text: `Reset failed: ${result.error ?? result.errorType ?? "unknown"}` }],
						isError: true,
						details: undefined,
					};
				}
				return { content: [{ type: "text", text: "Kernel namespace cleared. All variables and imports removed." }], details: undefined };
			} catch (err) {
				return {
					content: [{ type: "text", text: `Reset error: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	pi.registerCommand("kernel-status", {
		description: "Show Python kernel status: alive, jobs run, pending jobs",
		async handler(_args, ctx) {
			if (!manager) {
				ctx.ui.notify("Kernel not started yet (no run_python call so far).", "info");
				return;
			}
			const s = manager.status();
			ctx.ui.notify(
				[
					"Python Kernel Status",
					`Alive: ${s.alive}`,
					`Jobs run: ${s.jobsRun}`,
					`Pending: ${s.pending}`,
					`Worker: ${manager.workerPath}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("kernel-restart", {
		description: "Restart the Python kernel worker (disposes state, respawns)",
		async handler(_args, ctx) {
			const mgr = getManager(ctx.cwd);
			mgr.dispose();
			try {
				const ready = await mgr.ensureStarted();
				ctx.ui.notify(
					`Kernel restarted. Python ${ready.python}, packages: ${Object.keys(ready.packages).join(", ")}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Kernel restart failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.on("session_shutdown", () => {
		manager?.dispose();
	});
}
