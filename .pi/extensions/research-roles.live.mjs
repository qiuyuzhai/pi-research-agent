#!/usr/bin/env node
// research-roles.live.mjs — research-roles.ts 纯函数 + 状态机断言
// 运行: node /home/aaron/project1/pi/.pi/extensions/research-roles.live.mjs
// 测试范围：ROLES、RESEARCH_TOOLS、transition、isToolAllowed、pickRoleEntry（全部纯函数/纯数据，无 pi-ai value import）

import {
	ROLES,
	RESEARCH_TOOLS,
	transition,
	isToolAllowed,
	pickRoleEntry,
} from "/home/aaron/project1/pi/.pi/extensions/research-roles.ts";

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

// ── Case 1: ROLES 数据完整性 ────────────────────────────────────────────────
section("[Case 1] ROLES — 6 角色完整性与 toolAllowlist 精确值");

const EXPECTED_ROLES = ["coordinator", "planner", "researcher", "coder", "reviewer", "reporter"];
check("恰好 6 个角色", Object.keys(ROLES).length === 6, `got ${Object.keys(ROLES).length}`);
for (const name of EXPECTED_ROLES) {
	check(`ROLES.${name} 存在`, name in ROLES);
	check(`ROLES.${name}.label 非空`, typeof ROLES[name].label === "string" && ROLES[name].label.length > 0);
	check(`ROLES.${name}.mission 非空`, typeof ROLES[name].mission === "string" && ROLES[name].mission.length > 0);
	check(`ROLES.${name}.toolAllowlist 是数组`, Array.isArray(ROLES[name].toolAllowlist));
}

// allowlist 精确内容核验
check("coordinator.toolAllowlist = [research_checkpoint]",
	ROLES.coordinator.toolAllowlist.length === 1 &&
	ROLES.coordinator.toolAllowlist.includes("research_checkpoint"),
	JSON.stringify(ROLES.coordinator.toolAllowlist));

check("planner.toolAllowlist 含 research_checkpoint、save_research_finding、search_arxiv（共 3 项）",
	ROLES.planner.toolAllowlist.length === 3 &&
	ROLES.planner.toolAllowlist.includes("research_checkpoint") &&
	ROLES.planner.toolAllowlist.includes("save_research_finding") &&
	ROLES.planner.toolAllowlist.includes("search_arxiv"),
	JSON.stringify(ROLES.planner.toolAllowlist));

check("researcher.toolAllowlist 含 search_arxiv、fetch_paper、web_search、save_research_finding（共 4 项）",
	ROLES.researcher.toolAllowlist.length === 4 &&
	ROLES.researcher.toolAllowlist.includes("search_arxiv") &&
	ROLES.researcher.toolAllowlist.includes("fetch_paper") &&
	ROLES.researcher.toolAllowlist.includes("web_search") &&
	ROLES.researcher.toolAllowlist.includes("save_research_finding"),
	JSON.stringify(ROLES.researcher.toolAllowlist));

check("coder.toolAllowlist 含 run_python、poll_python、auto_debug_python、kernel_reset、save_experiment（共 5 项）",
	ROLES.coder.toolAllowlist.length === 5 &&
	ROLES.coder.toolAllowlist.includes("run_python") &&
	ROLES.coder.toolAllowlist.includes("poll_python") &&
	ROLES.coder.toolAllowlist.includes("auto_debug_python") &&
	ROLES.coder.toolAllowlist.includes("kernel_reset") &&
	ROLES.coder.toolAllowlist.includes("save_experiment"),
	JSON.stringify(ROLES.coder.toolAllowlist));

check("reviewer.toolAllowlist 含 adversarial_review、save_research_finding（共 2 项）",
	ROLES.reviewer.toolAllowlist.length === 2 &&
	ROLES.reviewer.toolAllowlist.includes("adversarial_review") &&
	ROLES.reviewer.toolAllowlist.includes("save_research_finding"),
	JSON.stringify(ROLES.reviewer.toolAllowlist));

check("reporter.toolAllowlist 含 fetch_paper、save_research_finding（共 2 项）",
	ROLES.reporter.toolAllowlist.length === 2 &&
	ROLES.reporter.toolAllowlist.includes("fetch_paper") &&
	ROLES.reporter.toolAllowlist.includes("save_research_finding"),
	JSON.stringify(ROLES.reporter.toolAllowlist));

// reviewer.refineTo 字段：唯一有 refineTo 的角色，其余角色无此字段
check("reviewer.refineTo === 'coder'", ROLES.reviewer.refineTo === "coder", ROLES.reviewer.refineTo);
check("coordinator 无 refineTo", !("refineTo" in ROLES.coordinator));
check("planner 无 refineTo", !("refineTo" in ROLES.planner));
check("researcher 无 refineTo", !("refineTo" in ROLES.researcher));
check("coder 无 refineTo", !("refineTo" in ROLES.coder));
check("reporter 无 refineTo", !("refineTo" in ROLES.reporter));

// ── Case 2: RESEARCH_TOOLS 12 工具名全集 + 扩展真实注册名逐一吻合 ──────────────
section("[Case 2] RESEARCH_TOOLS — 12 工具名精确吻合（防漂移）");

check("RESEARCH_TOOLS 是 Set", RESEARCH_TOOLS instanceof Set);
check("RESEARCH_TOOLS.size === 12", RESEARCH_TOOLS.size === 12, `size=${RESEARCH_TOOLS.size}`);

// 与 6 个扩展真实注册名逐一比对
const EXPECTED_TOOLS = [
	// research-memory
	"save_research_finding",
	"save_experiment",
	// research-kernel
	"run_python",
	"poll_python",
	"auto_debug_python",
	"kernel_reset",
	// arxiv-tools
	"search_arxiv",
	"fetch_paper",
	// web-search
	"web_search",
	// aris-review
	"adversarial_review",
	// research-checkpoint
	"research_checkpoint",
	// 本扩展新增
	"coordinator_decide",
];
for (const tool of EXPECTED_TOOLS) {
	check(`RESEARCH_TOOLS 含 ${tool}`, RESEARCH_TOOLS.has(tool));
}

// ── Case 3: transition — 默认推进链 6 步 proceed 终至 coordinator/done ─────────
section("[Case 3] transition — 默认推进链 6 步 proceed 至 coordinator/done");

// 完整推进链验证
const chain = [
	{ role: "coordinator", phase: "idle" },      // 起始
	{ role: "planner",     phase: "hypothesis" }, // +1
	{ role: "researcher",  phase: "hypothesis" }, // +2
	{ role: "coder",       phase: "experiment" }, // +3
	{ role: "reviewer",    phase: "analysis" },   // +4
	{ role: "reporter",    phase: "report" },     // +5
	{ role: "coordinator", phase: "done" },       // +6（终态）
];

let cur = { role: "coordinator", phase: "idle", updatedAt: new Date().toISOString() };
check("起始态 coordinator/idle", cur.role === "coordinator" && cur.phase === "idle");

for (let i = 0; i < 6; i++) {
	const next = transition(cur, "proceed");
	const expected = chain[i + 1];
	check(
		`proceed 步 ${i + 1}: ${chain[i].role}/${chain[i].phase} → ${expected.role}/${expected.phase}`,
		next.role === expected.role && next.phase === expected.phase,
		`got ${next.role}/${next.phase}`,
	);
	check(`步 ${i + 1} updatedAt 是 ISO 字符串`, typeof next.updatedAt === "string" && next.updatedAt.length > 10);
	cur = next;
}
check("终态 coordinator/done", cur.role === "coordinator" && cur.phase === "done");

// ── Case 4: transition — refine / pivot / target 显式覆盖 ─────────────────────
section("[Case 4] transition — refine / pivot / target 显式覆盖");

// refine 新语义：
//   - 唯一例外 reviewer(refineTo="coder") → coder/experiment
//   - 其余角色：留原 role/phase 重做（无 refineTo）

// reviewer(analysis) refine → coder/experiment（refineTo="coder"，退回执行环节）
const inReviewer = { role: "reviewer", phase: "analysis", updatedAt: "" };
const refined3 = transition(inReviewer, "refine");
check("reviewer(analysis) refine → coder/experiment（refineTo=coder）",
	refined3.role === "coder" && refined3.phase === "experiment",
	`got ${refined3.role}/${refined3.phase}`);

// 其余角色 refine 留原地（无 refineTo）
const inCoder = { role: "coder", phase: "experiment", updatedAt: "" };
const refined2 = transition(inCoder, "refine");
check("coder(experiment) refine → coder/experiment（留原地，无 refineTo）",
	refined2.role === "coder" && refined2.phase === "experiment",
	`got ${refined2.role}/${refined2.phase}`);

const inResearcher = { role: "researcher", phase: "hypothesis", updatedAt: "" };
const refined1 = transition(inResearcher, "refine");
check("researcher(hypothesis) refine → researcher/hypothesis（留原地，无 refineTo）",
	refined1.role === "researcher" && refined1.phase === "hypothesis",
	`got ${refined1.role}/${refined1.phase}`);

const inPlanner = { role: "planner", phase: "hypothesis", updatedAt: "" };
const refined5 = transition(inPlanner, "refine");
check("planner(hypothesis) refine → planner/hypothesis（留原地，无 refineTo）",
	refined5.role === "planner" && refined5.phase === "hypothesis",
	`got ${refined5.role}/${refined5.phase}`);

const inReporter = { role: "reporter", phase: "report", updatedAt: "" };
const refined6 = transition(inReporter, "refine");
check("reporter(report) refine → reporter/report（留原地，无 refineTo）",
	refined6.role === "reporter" && refined6.phase === "report",
	`got ${refined6.role}/${refined6.phase}`);

const inCoordinator = { role: "coordinator", phase: "idle", updatedAt: "" };
const refined4 = transition(inCoordinator, "refine");
check("coordinator(idle) refine → coordinator/idle（留原地，无 refineTo）",
	refined4.role === "coordinator" && refined4.phase === "idle",
	`got ${refined4.role}/${refined4.phase}`);

// pivot: 恒回 planner/hypothesis
for (const roleName of EXPECTED_ROLES) {
	const state = { role: roleName, phase: "idle", updatedAt: "" };
	const pivoted = transition(state, "pivot");
	check(`${roleName} pivot → planner/hypothesis`,
		pivoted.role === "planner" && pivoted.phase === "hypothesis",
		`got ${pivoted.role}/${pivoted.phase}`);
}

// target 显式覆盖（任意 decision 均生效）
const withTarget = transition(inReviewer, "proceed", "coder");
check("reviewer proceed target=coder → coder/experiment",
	withTarget.role === "coder" && withTarget.phase === "experiment",
	`got ${withTarget.role}/${withTarget.phase}`);

const withTargetCoord = transition(inCoder, "refine", "coordinator");
check("coder refine target=coordinator → coordinator/idle",
	withTargetCoord.role === "coordinator" && withTargetCoord.phase === "idle",
	`got ${withTargetCoord.role}/${withTargetCoord.phase}`);

const withTargetReporter = transition(inCoordinator, "pivot", "reporter");
check("coordinator pivot target=reporter → reporter/report",
	withTargetReporter.role === "reporter" && withTargetReporter.phase === "report",
	`got ${withTargetReporter.role}/${withTargetReporter.phase}`);

// target 覆盖所有角色默认 phase 核验
const targetPhaseMap = {
	coordinator: "idle",
	planner: "hypothesis",
	researcher: "hypothesis",
	coder: "experiment",
	reviewer: "analysis",
	reporter: "report",
};
for (const [targetRole, expectedPhase] of Object.entries(targetPhaseMap)) {
	const s = transition(inCoordinator, "proceed", targetRole);
	check(`target=${targetRole} → phase=${expectedPhase}`,
		s.role === targetRole && s.phase === expectedPhase,
		`got ${s.role}/${s.phase}`);
}

// ── Case 5: isToolAllowed — allowlist + coordinator_decide + 内置工具放行 ──────
section("[Case 5] isToolAllowed — allowlist / coordinator_decide 恒允许 / 内置工具放行");

// coder 可用 run_python，不可 search_arxiv
check("isToolAllowed(coder, run_python) === true", isToolAllowed("coder", "run_python") === true);
check("isToolAllowed(coder, search_arxiv) === false", isToolAllowed("coder", "search_arxiv") === false);
check("isToolAllowed(coder, adversarial_review) === false", isToolAllowed("coder", "adversarial_review") === false);

// coordinator 只有 research_checkpoint
check("isToolAllowed(coordinator, research_checkpoint) === true", isToolAllowed("coordinator", "research_checkpoint") === true);
check("isToolAllowed(coordinator, search_arxiv) === false", isToolAllowed("coordinator", "search_arxiv") === false);
check("isToolAllowed(coordinator, run_python) === false", isToolAllowed("coordinator", "run_python") === false);

// coordinator_decide 对任何角色恒允许
for (const roleName of EXPECTED_ROLES) {
	check(`isToolAllowed(${roleName}, coordinator_decide) === true`,
		isToolAllowed(roleName, "coordinator_decide") === true);
}

// 内置工具（不在 RESEARCH_TOOLS）任何角色放行
const builtinTools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
for (const tool of builtinTools) {
	for (const roleName of EXPECTED_ROLES) {
		check(`isToolAllowed(${roleName}, ${tool}) === true（内置工具放行）`,
			isToolAllowed(roleName, tool) === true);
	}
}

// researcher 可用的工具精确验证
check("isToolAllowed(researcher, search_arxiv) === true", isToolAllowed("researcher", "search_arxiv") === true);
check("isToolAllowed(researcher, fetch_paper) === true", isToolAllowed("researcher", "fetch_paper") === true);
check("isToolAllowed(researcher, web_search) === true", isToolAllowed("researcher", "web_search") === true);
check("isToolAllowed(researcher, save_research_finding) === true", isToolAllowed("researcher", "save_research_finding") === true);
check("isToolAllowed(researcher, run_python) === false", isToolAllowed("researcher", "run_python") === false);
check("isToolAllowed(researcher, adversarial_review) === false", isToolAllowed("researcher", "adversarial_review") === false);

// reviewer 精确验证
check("isToolAllowed(reviewer, adversarial_review) === true", isToolAllowed("reviewer", "adversarial_review") === true);
check("isToolAllowed(reviewer, save_research_finding) === true", isToolAllowed("reviewer", "save_research_finding") === true);
check("isToolAllowed(reviewer, run_python) === false", isToolAllowed("reviewer", "run_python") === false);
check("isToolAllowed(reviewer, search_arxiv) === false", isToolAllowed("reviewer", "search_arxiv") === false);

// ── Case 6: pickRoleEntry — 最后一条 / 空 entries → null / 混入其他类型不干扰 ──
section("[Case 6] pickRoleEntry — 最后一条 role_state / 空 entries / 类型混入");

// 空 entries → null
check("pickRoleEntry([]) === null", pickRoleEntry([]) === null);

// 无 role_state → null
const noMatch = [
	{ type: "text", customType: undefined, data: { role: "coder" } },
	{ type: "custom", customType: "other_type", data: { role: "coder" } },
];
check("pickRoleEntry(无 role_state) === null", pickRoleEntry(noMatch) === null);

// 单条 role_state
const single = [
	{ type: "custom", customType: "role_state", data: { role: "planner", phase: "hypothesis", updatedAt: "t1" } },
];
const s1 = pickRoleEntry(single);
check("pickRoleEntry(单条) → data.role === planner", s1?.role === "planner", JSON.stringify(s1));
check("pickRoleEntry(单条) → data.phase === hypothesis", s1?.phase === "hypothesis");

// 多条 role_state → 取最后一条
const multi = [
	{ type: "custom", customType: "role_state", data: { role: "planner", phase: "hypothesis", updatedAt: "t1" } },
	{ type: "text", customType: undefined, data: null }, // 中间插入其他类型
	{ type: "custom", customType: "role_state", data: { role: "coder", phase: "experiment", updatedAt: "t2" } },
	{ type: "custom", customType: "role_state", data: { role: "reviewer", phase: "analysis", updatedAt: "t3" } },
];
const s2 = pickRoleEntry(multi);
check("pickRoleEntry(多条) → 最后一条 data.role === reviewer", s2?.role === "reviewer", JSON.stringify(s2));
check("pickRoleEntry(多条) → 最后一条 data.phase === analysis", s2?.phase === "analysis");
check("pickRoleEntry(多条) → updatedAt === t3", s2?.updatedAt === "t3");

// data 为 undefined → 返回 null（而非 undefined）
const withUndefined = [
	{ type: "custom", customType: "role_state", data: undefined },
];
check("pickRoleEntry(data=undefined) === null", pickRoleEntry(withUndefined) === null);

// 混入多种 type，只取 role_state
const mixed = [
	{ type: "text", data: { role: "coordinator" } },
	{ type: "custom", customType: "checkpoint", data: { role: "coder" } },
	{ type: "custom", customType: "role_state", data: { role: "reporter", phase: "report", updatedAt: "t5" } },
	{ type: "tool_call", customType: "role_state", data: { role: "planner" } }, // type 非 custom，不匹配
];
const s3 = pickRoleEntry(mixed);
check("pickRoleEntry(混入类型) → 唯一 role_state data.role === reporter", s3?.role === "reporter", JSON.stringify(s3));

// ── Case 6b: pickRoleEntry — isValidRoleState 合法性校验（损坏 entry 安全降级）──
section("[Case 6b] pickRoleEntry — isValidRoleState 合法性校验");

// 合法 entry：正常返回
const validEntry = [{ type: "custom", customType: "role_state", data: { role: "coder", phase: "experiment", updatedAt: "t1" } }];
const sv = pickRoleEntry(validEntry);
check("合法 entry → 返回 data 对象（非 null）", sv !== null && sv.role === "coder" && sv.phase === "experiment", JSON.stringify(sv));

// role 非法 → null
const badRole = [{ type: "custom", customType: "role_state", data: { role: "bogus", phase: "experiment" } }];
check("role='bogus' → null", pickRoleEntry(badRole) === null);

// phase 非法 → null
const badPhase = [{ type: "custom", customType: "role_state", data: { role: "coder", phase: "bogus" } }];
check("phase='bogus' → null", pickRoleEntry(badPhase) === null);

// data 为 null → null
const nullData = [{ type: "custom", customType: "role_state", data: null }];
check("data=null → null", pickRoleEntry(nullData) === null);

// 无 data 字段 → null
const noData = [{ type: "custom", customType: "role_state" }];
check("无 data 字段 → null", pickRoleEntry(noData) === null);

// data 为字符串（截断损坏）→ null
const strData = [{ type: "custom", customType: "role_state", data: "截断的字符串" }];
check("data='截断的字符串' → null", pickRoleEntry(strData) === null);

// 多条混合：[合法A, 损坏B(role 非法)] → 取最后一条 B 后校验失败 → null（非回退到 A）
const mixedValid = [
	{ type: "custom", customType: "role_state", data: { role: "planner", phase: "hypothesis", updatedAt: "t1" } },
	{ type: "custom", customType: "role_state", data: { role: "bogus", phase: "experiment" } },
];
check("[合法A, 损坏B] → 取最后一条 B → null（不回退到 A）", pickRoleEntry(mixedValid) === null);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
console.log(`纯函数断言结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
	console.log("LIVE FAIL");
	process.exit(1);
}
console.log("LIVE ALL PASS");
process.exit(0);
