#!/usr/bin/env node
// research-kernel.live.mjs — research-kernel.ts TS 封装层真实链路冒烟测试（驱动真实 uv worker）
// 运行: node /home/aaron/project1/pi/.pi/extensions/research-kernel.live.mjs
//
// 与 test-worker.mjs（仅验 worker.py JSON-lines 协议）互补：本脚本验证 TS 层独有逻辑——
// KernelManager 软超时 Promise.race、poll 三分支、mapResult/formatResult/extractCode、
// reset/status/dispose 生命周期，端到端真实执行 Python。

import {
	KernelManager,
	mapResult,
	formatResult,
	extractCode,
} from "/home/aaron/project1/pi/.pi/extensions/research-kernel.ts";

const KERNEL_DIR = "/home/aaron/project1/pi/.pi/research-kernel";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 纯函数段（无需 worker）────────────────────────────────────────────────────
function testPureFunctions() {
	section("[纯函数] mapResult — snake_case → camelCase 契约映射");
	const m = mapResult({
		id: "j1",
		type: "result",
		status: "ok",
		stdout: "hi\n",
		value_repr: "42",
		value_type: "int",
		duration_ms: 12,
	});
	check("id 透传", m.id === "j1");
	check("status ok", m.status === "ok");
	check("stdout 透传", m.stdout === "hi\n");
	check("value_repr → valueRepr", m.valueRepr === "42", m.valueRepr);
	check("value_type → valueType", m.valueType === "int");
	check("duration_ms → durationMs", m.durationMs === 12);

	const me = mapResult({ id: "j2", status: "error", error: "boom", error_type: "ValueError" });
	check("status error", me.status === "error");
	check("error_type → errorType", me.errorType === "ValueError");
	check("缺省 valueType=NoneType", me.valueType === "NoneType");
	check("缺省 durationMs=0", me.durationMs === 0);
	check("缺省 stdout=''", me.stdout === "");

	const mu = mapResult({});
	check("无 status → ok", mu.status === "ok");
	check("无 id → ''", mu.id === "");
	// 契约记录(对抗审查发现): mapResult 把非 'error' 的一切折叠为 'ok' — 有损但符合当前 worker 契约, 显式断言以防静默漂移。
	check("非 error 状态折叠为 ok (有损契约, 显式记录)", mapResult({ status: "running" }).status === "ok");

	section("[纯函数] formatResult — 输出格式化");
	const fOk = formatResult({ id: "", status: "ok", stdout: "hello\n", valueRepr: "42", valueType: "int", durationMs: 5 });
	// 全等断言(替代原 includes 弱断言, 对抗审查发现 false-pass): 若 research-kernel.ts 的 stdout.replace(/\n$/,"") 去尾换行失效,
	// 输出会多一个换行 → 此处失败。原 includes(...)&&!includes("hello\n\n") 对该逻辑恒真, 删掉 replace 仍通过。
	check("ok 全等输出(精确验去尾换行+格式)", fOk === "hello\n=> 42  (int)\n[ok, 5ms]", JSON.stringify(fOk));

	const fEmpty = formatResult({ id: "", status: "ok", stdout: "", valueRepr: "", valueType: "NoneType", durationMs: 1 });
	check("ok 空输出 → '(no output)'", fEmpty.includes("(no output)"), fEmpty);

	const fErr = formatResult({ id: "", status: "error", stdout: "", error: "division by zero", errorType: "ZeroDivisionError", valueRepr: "", valueType: "NoneType", durationMs: 2 });
	check("error 含 错误消息", fErr.includes("division by zero"));
	check("error 含 '[error: ZeroDivisionError, 2ms]'", fErr.includes("[error: ZeroDivisionError, 2ms]"), fErr);

	section("[纯函数] extractCode — 代码围栏提取");
	check("```python 围栏", extractCode("```python\nprint(1)\n```") === "print(1)");
	check("裸 ``` 围栏", extractCode("```\nx = 2\n```") === "x = 2");
	check("无围栏 → trim", extractCode("  y = 3  ") === "y = 3");
	check("围栏前后含文字", extractCode("here:\n```python\nz=4\n```\ndone") === "z=4");

	section("[纯函数] KernelManager.onLine — 协议行解析容错（无需 spawn）");
	const probe = new KernelManager(KERNEL_DIR);
	check("非 JSON 行 → null (容忍 uv 杂质)", probe.onLine("uv: Downloading numpy...") === null);
	check("空行 → null", probe.onLine("") === null);
	const pr = probe.onLine(JSON.stringify({ type: "ready", python: "3.12", packages: {} }));
	check("合法 ready 行 → 返回解析对象", pr?.type === "ready");
	const ghost = probe.onLine(JSON.stringify({ type: "result", id: "ghost", status: "ok" }));
	check("未知 id 的 result → 不抛且 pending 不增", ghost?.type === "result" && probe.status().pending === 0);
}

// ── 真实驱动段（spawn 真实 uv worker）──────────────────────────────────────────
async function testLiveKernel() {
	section("[真实驱动] KernelManager.ensureStarted — spawn uv worker + ready 握手");
	const mgr = new KernelManager(KERNEL_DIR);
	let ready;
	try {
		ready = await mgr.ensureStarted();
	} catch (err) {
		check("ensureStarted 握手成功", false, err?.message);
		return mgr;
	}
	check("ready.python 非空", typeof ready.python === "string" && ready.python.length > 0, ready.python);
	check("ready.packages 是对象", !!ready.packages && typeof ready.packages === "object");
	check("packages 含 numpy", "numpy" in (ready.packages ?? {}), Object.keys(ready.packages ?? {}).join(","));

	section("[真实驱动] exec — 有状态命名空间 + stdout + 末行回显 + 错误");
	const r1 = await mgr.exec("x = 1");
	check("exec(x=1) 非 RunningHandle", !("running" in r1));
	check("exec(x=1) status ok", r1.status === "ok");
	check("exec(x=1) valueRepr '' (赋值语句)", r1.valueRepr === "", r1.valueRepr);

	const r2 = await mgr.exec("x + 1");
	check("exec(x+1) valueRepr '2' (状态持久)", r2.valueRepr === "2", r2.valueRepr);
	check("exec(x+1) valueType int", r2.valueType === "int");

	const r3 = await mgr.exec("print('hi')\n3");
	check("exec print → stdout 'hi\\n'", r3.stdout === "hi\n", JSON.stringify(r3.stdout));
	check("exec print → valueRepr '3'", r3.valueRepr === "3");

	const r4 = await mgr.exec("1/0");
	check("exec 1/0 → status error", r4.status === "error");
	check("exec 1/0 → errorType ZeroDivisionError", r4.errorType === "ZeroDivisionError", r4.errorType);

	section("[真实驱动] exec 软超时 Promise.race → RunningHandle（TS 层独有）");
	const slow = await mgr.exec("import time; time.sleep(3)", undefined, 500);
	check("软超时(500ms) → RunningHandle", "running" in slow && slow.running === true, JSON.stringify(slow));
	const slowId = slow.id;
	check("RunningHandle.id 形如 job-N", typeof slowId === "string" && slowId.startsWith("job-"), slowId);
	// 关键不变量(对抗审查发现): 软超时落败不删 pending, 后台 job 须滞留供 poll 取回, 否则结果永久丢失。
	check("软超时后 job 滞留 pending(>=1)", mgr.status().pending >= 1, String(mgr.status().pending));

	section("[真实驱动] poll — 取回后台 job / 未知 id");
	const polled = await mgr.poll(slowId, 6000);
	check("poll 取回完成 job 非 running (re-wait 分支)", !("running" in polled), JSON.stringify(polled));
	check("poll 取回 status ok", polled?.status === "ok", JSON.stringify(polled));
	// 缓存命中支(对抗审查发现): job 已 settled 后再 poll 同一 id, 应立即同步命中 job.result, 不再 race。
	const polledCached = await mgr.poll(slowId, 100);
	check("poll 缓存命中 → 立即返回同一 result(settled 分支)", !("running" in polledCached) && polledCached?.status === "ok", JSON.stringify(polledCached));
	const unknown = await mgr.poll("job-nonexistent", 100);
	check("poll 未知 id → RunningHandle", "running" in unknown, JSON.stringify(unknown));

	section("[真实驱动] reset — 清空命名空间");
	const rst = await mgr.reset();
	check("reset status ok", rst.status === "ok", JSON.stringify(rst));
	const afterReset = await mgr.exec("x");
	check("reset 后 exec(x) → status error", afterReset.status === "error");
	check("reset 后 exec(x) → NameError (验 reset 生效)", afterReset.errorType === "NameError", afterReset.errorType);

	section("[真实驱动] ensureStarted 幂等（不重复 spawn）");
	const p1 = mgr.ensureStarted();
	const p2 = mgr.ensureStarted();
	check("ensureStarted 幂等(同一 readyPromise 引用)", p1 === p2);
	await p2; // 已 resolved, 仅消解 promise

	section("[真实驱动] status / dispose 生命周期");
	const st = mgr.status();
	check("status.alive true", st.alive === true);
	check("status.jobsRun > 0", st.jobsRun > 0, String(st.jobsRun));
	check("status.pending === 0", st.pending === 0, String(st.pending));

	mgr.dispose();
	const st2 = mgr.status();
	check("dispose 后 alive false", st2.alive === false);

	section("[真实驱动] failAllPending — worker 崩溃容错（未结算 job 标 error 而非永久挂起）");
	const mgr2 = new KernelManager(KERNEL_DIR);
	try {
		await mgr2.ensureStarted();
		// softTimeout 给大值确保 exec 走 deferred(不软超时); sleep 长确保 kill 时该 job 仍未结算。
		const inflight = mgr2.exec("import time; time.sleep(30)", undefined, 60_000);
		await sleep(400); // 让 worker 进入 sleep, job 注册到 pending
		check("kill 前 in-flight job 滞留 pending(>=1)", mgr2.status().pending >= 1, String(mgr2.status().pending));
		mgr2.child?.kill("SIGKILL"); // 模拟 worker 崩溃
		const crashed = await inflight; // failAllPending 应使其 resolve, 而非永久挂起
		check("worker 崩溃 → in-flight exec resolve(未挂起)", !("running" in crashed), JSON.stringify(crashed));
		check("worker 崩溃 → status error", crashed.status === "error", JSON.stringify(crashed));
		check("worker 崩溃 → errorType WorkerExited", crashed.errorType === "WorkerExited", crashed.errorType);
	} catch (err) {
		check("failAllPending 用例无异常", false, err?.message);
	} finally {
		mgr2.dispose();
	}

	return mgr;
}

async function main() {
	testPureFunctions();
	let mgr;
	try {
		mgr = await testLiveKernel();
	} catch (err) {
		failed++;
		console.log(`  ✗ 真实驱动段抛异常: ${err?.name} ${err?.message}`);
	} finally {
		try {
			mgr?.dispose?.();
		} catch {}
	}

	console.log(`\n${"─".repeat(52)}`);
	console.log(`TS 层真实链路结果: ${passed} 通过 / ${failed} 失败`);
	if (failed > 0) {
		console.log("LIVE FAIL");
		process.exit(1);
	}
	console.log("LIVE ALL PASS");
	process.exit(0);
}

main().catch((err) => {
	console.error("致命错误:", err);
	process.exit(1);
});
