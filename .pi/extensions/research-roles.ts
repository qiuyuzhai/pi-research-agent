/**
 * 科研 Agent 角色层扩展（FR-10 / Phase 4 · DeerFlow 角色编排）
 *
 * 架构来源: 整合后的架构.md §7（Meso-loop 即角色容器）+ DeerFlow 6 角色全集。
 * 方案甲: 事件驱动角色状态机 + 显式 Coordinator 决策。
 *
 * Pi 无子 agent 派生，"多受限 Meso-loop 并存"退化为"单主 agent 分时 + 角色态切换"：
 *   - before_agent_start：按当前角色注入 system prompt（与 research-memory 链式叠加，不覆盖）
 *   - tool_call：裁剪非本角色的研究工具（内置工具一律放行，不误伤）
 *   - coordinator_decide 工具：显式转移状态机，工具结果即交接指令（消解 1-turn lag）
 *
 * 状态真相源为模块级 liveState（热路径零 I/O），转移时经 pi.appendEntry 持久化、
 * 首次 before_agent_start 经 hydrate 从 session entries 恢复（支持 resume）。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 角色 / 阶段 / 决策：erasable union 字面量（禁 enum）。
type RoleName = "coordinator" | "planner" | "researcher" | "coder" | "reviewer" | "reporter";
type Phase = "idle" | "hypothesis" | "experiment" | "analysis" | "report" | "done";
type Decision = "proceed" | "refine" | "pivot";

type RoleState = { role: RoleName; phase: Phase; updatedAt: string; note?: string };
type RoleDef = {
	label: string;
	mission: string; // 注入 system prompt 的角色使命与边界
	toolAllowlist: readonly string[]; // 该角色允许的"研究工具"子集（不含内置工具）
	refineTo?: RoleName; // refine 时退回的角色；缺省 = 留当前角色重做（唯 reviewer → coder）
};

// coordinator_decide 全程恒允许，不入 allowlist（见 isToolAllowed）。
const COORDINATOR_DECIDE = "coordinator_decide";

// 12 个自定义研究工具全集（裁剪依据；内置 read/write/edit/bash/grep/find/ls 不在其中）。
export const RESEARCH_TOOLS: Set<string> = new Set([
	"save_research_finding",
	"save_experiment",
	"run_python",
	"poll_python",
	"auto_debug_python",
	"kernel_reset",
	"search_arxiv",
	"fetch_paper",
	"web_search",
	"adversarial_review",
	"research_checkpoint",
	COORDINATOR_DECIDE,
]);

// 角色注册表（6 角色全集）。toolAllowlist 见计划 §3.2。
export const ROLES: Record<RoleName, RoleDef> = {
	coordinator: {
		label: "Coordinator（调度协调）",
		mission:
			"你是 Coordinator（调度协调者）。职责：纵观研究全局，决定下一步交给哪个角色。" +
			"你不亲自做研究、不写代码、不查文献——你只评估进展并通过 coordinator_decide 显式调度。" +
			"在 idle 阶段：理解用户的研究目标，调用 coordinator_decide(proceed) 启动 planner 制定计划。" +
			"在 done 阶段：研究链已闭环，向用户汇总结论；如需新方向，coordinator_decide(pivot) 回到 planner。" +
			"可用研究工具：research_checkpoint（记录重大方向决策）。",
		toolAllowlist: ["research_checkpoint"],
	},
	planner: {
		label: "Planner（研究规划）",
		mission:
			"你是 Planner（研究规划者）。职责：把研究目标拆解为可检验的假设与实验计划。" +
			"先调研已有工作（search_arxiv）确认新颖性，把关键假设与计划用 save_research_finding 落档，" +
			"用 research_checkpoint 标定方向。计划成型后调用 coordinator_decide(proceed) 交给 researcher 深入调研。" +
			"可用研究工具：search_arxiv、save_research_finding、research_checkpoint。",
		toolAllowlist: ["research_checkpoint", "save_research_finding", "search_arxiv"],
	},
	researcher: {
		label: "Researcher（文献调研）",
		mission:
			"你是 Researcher（文献调研者）。职责：围绕假设广泛检索文献与网络证据，提炼方法与对照基线。" +
			"用 search_arxiv / fetch_paper / web_search 收集，用 save_research_finding 沉淀关键发现。" +
			"证据充分后调用 coordinator_decide(proceed) 交给 coder 实现实验。" +
			"可用研究工具：search_arxiv、fetch_paper、web_search、save_research_finding。",
		toolAllowlist: ["search_arxiv", "fetch_paper", "web_search", "save_research_finding"],
	},
	coder: {
		label: "Coder（实验实现）",
		mission:
			"你是 Coder（实验实现者）。职责：把假设落为可运行实验并取得结果。" +
			"用 run_python（持久内核，变量跨调用存活）实现，长任务用 poll_python 取回，失败用 auto_debug_python 自修复，" +
			"需要清空状态用 kernel_reset，成功结果用 save_experiment 归档到 M_E。" +
			"实验有结论后调用 coordinator_decide(proceed) 交给 reviewer 评审。" +
			"可用研究工具：run_python、poll_python、auto_debug_python、kernel_reset、save_experiment。",
		toolAllowlist: ["run_python", "poll_python", "auto_debug_python", "kernel_reset", "save_experiment"],
	},
	reviewer: {
		label: "Reviewer（对抗评审）",
		mission:
			"你是 Reviewer（对抗式评审者）。职责：以最严格标准审查实验与结论的可信度。" +
			"用 adversarial_review 对结果做对抗式拷问，发现的关键缺陷用 save_research_finding 落档。" +
			"评审通过调用 coordinator_decide(proceed) 交给 reporter 撰写报告；" +
			"评审不通过调用 coordinator_decide(refine) 退回 coder 修正；" +
			"若发现假设根本错误调用 coordinator_decide(pivot) 推翻重来。" +
			"可用研究工具：adversarial_review、save_research_finding。",
		toolAllowlist: ["adversarial_review", "save_research_finding"],
		refineTo: "coder", // 评审不过：唯一退回执行环节的角色（reviewer 非执行角色，留原地 refine 为死操作）
	},
	reporter: {
		label: "Reporter（报告撰写）",
		mission:
			"你是 Reporter（报告撰写者）。职责：把已验证的研究成果整理为清晰、可复现的报告。" +
			"可用 fetch_paper 补全引用，用 save_research_finding 沉淀最终结论。" +
			"报告完成后调用 coordinator_decide(proceed) 交回 coordinator 闭环。" +
			"可用研究工具：fetch_paper、save_research_finding。",
		toolAllowlist: ["fetch_paper", "save_research_finding"],
	},
};

// 默认推进链：proceed 时由 cur.role 推进到下一角色（含其默认 phase）。
const PROCEED_NEXT: Record<RoleName, RoleState> = {
	coordinator: { role: "planner", phase: "hypothesis", updatedAt: "" },
	planner: { role: "researcher", phase: "hypothesis", updatedAt: "" },
	researcher: { role: "coder", phase: "experiment", updatedAt: "" },
	coder: { role: "reviewer", phase: "analysis", updatedAt: "" },
	reviewer: { role: "reporter", phase: "report", updatedAt: "" },
	reporter: { role: "coordinator", phase: "done", updatedAt: "" },
	// 注：coordinator/done 后再 proceed 会回到 planner/hypothesis，即"开启新一轮研究循环"；
	// 若意在另起炉灶推翻旧假设，coordinator.mission 引导优先用 pivot（二者目标角色一致，语义侧重不同）。
};

const INITIAL_STATE: RoleState = { role: "coordinator", phase: "idle", updatedAt: "" };

// 合法 Phase 集合（hydrate 校验用；杜绝损坏/旧 schema entry 污染 liveState）。
const VALID_PHASES: Set<string> = new Set<Phase>([
	"idle",
	"hypothesis",
	"experiment",
	"analysis",
	"report",
	"done",
]);

// 校验未知 data 是否为合法 RoleState（role ∈ ROLES、phase ∈ VALID_PHASES）。
function isValidRoleState(data: unknown): data is RoleState {
	if (typeof data !== "object" || data === null) return false;
	const d = data as { role?: unknown; phase?: unknown };
	return (
		typeof d.role === "string" &&
		Object.prototype.hasOwnProperty.call(ROLES, d.role) &&
		typeof d.phase === "string" &&
		VALID_PHASES.has(d.phase)
	);
}

/**
 * 状态机转移（纯函数，便于断言）。
 * - proceed：沿默认推进链前进；target 显式指定则覆盖默认下一角色（Coordinator 显式调度）。
 * - refine：refineTo 缺省 = 留当前角色重做；唯 reviewer 定义 refineTo="coder"（退回执行环节）。
 *           phase 一律取目标角色默认 phase（reviewer refine → coder/experiment；其余归一到自身默认 phase）。
 * - pivot：推翻重来，回 planner/hypothesis。
 * target 在任何 decision 下显式给出都强制覆盖目标角色，phase 取目标角色默认进入的 phase。
 */
export function transition(cur: RoleState, decision: Decision, target?: RoleName): RoleState {
	const now = new Date().toISOString();

	// 显式 target 优先：覆盖默认目标角色，phase 取该角色默认进入的 phase（Coordinator 显式调度）。
	if (target) {
		return { role: target, phase: defaultPhaseOf(target), updatedAt: now };
	}

	if (decision === "pivot") {
		return { role: "planner", phase: "hypothesis", updatedAt: now };
	}

	if (decision === "refine") {
		// refineTo 缺省 = self（留当前角色重做）；唯 reviewer→coder。
		// phase 一律取目标角色默认 phase：reviewer→coder/experiment；其余角色归一到自身默认 phase
		// （正常态等价"留 phase"，畸形 phase 输入则归一，更健壮）。
		const back = ROLES[cur.role].refineTo ?? cur.role;
		return { role: back, phase: defaultPhaseOf(back), updatedAt: now };
	}

	// proceed：沿默认推进链。
	const next = PROCEED_NEXT[cur.role];
	return { role: next.role, phase: next.phase, updatedAt: now };
}

// 目标角色默认进入的 phase（推进链中该角色作为"下一角色"时携带的 phase）。
// 注：coordinator 经 target 显式跳转恒入 idle（重置为待调度态），与 reporter proceed 自然到达的
// coordinator/done 是两种有意区分的入口——前者"重启调度"，后者"研究闭环完成"。
function defaultPhaseOf(role: RoleName): Phase {
	if (role === "coordinator") return "idle";
	for (const from of Object.keys(PROCEED_NEXT) as RoleName[]) {
		if (PROCEED_NEXT[from].role === role) return PROCEED_NEXT[from].phase;
	}
	return "hypothesis";
}

/**
 * 工具是否对当前角色放行（纯函数）。
 * - coordinator_decide：恒允许（任何角色可请求 Coordinator 决策/交接）。
 * - ∈ RESEARCH_TOOLS 且 ∉ 当前角色 allowlist → false（硬阻断）。
 * - ∉ RESEARCH_TOOLS（内置工具）→ true（放行，不误伤）。
 */
export function isToolAllowed(role: RoleName, toolName: string): boolean {
	if (toolName === COORDINATOR_DECIDE) return true;
	if (!RESEARCH_TOOLS.has(toolName)) return true;
	return ROLES[role].toolAllowlist.includes(toolName);
}

/**
 * 从 session entries 提取最后一条 role_state 数据（纯函数，hydrate 辅助）。
 * 过滤 type==="custom" && customType==="role_state"，取最后一条 .data；
 * 经 isValidRoleState 校验合法性——损坏/旧 schema/被截断的 data 一律返回 null（调用方安全降级 coordinator/idle）。
 */
export function pickRoleEntry(entries: readonly { type: string; customType?: string; data?: unknown }[]): RoleState | null {
	const states = entries.filter(
		(e): e is { type: "custom"; customType: "role_state"; data?: unknown } =>
			e.type === "custom" && e.customType === "role_state",
	);
	const last = states.at(-1);
	return isValidRoleState(last?.data) ? last.data : null;
}

// 模块级热路径真相源（每次 before_agent_start / tool_call 读，零 I/O）。
let liveState: RoleState = { ...INITIAL_STATE, updatedAt: new Date().toISOString() };
// hydrate 守卫：同会话仅首次实读 entries（保热路径零 I/O，§3.5 约束）；
// 跨会话由 session_start 重置（见下），使新会话首个 before_agent_start 重新 hydrate，消除串味。
let hydrated = false;

// 构建注入到 system prompt 的角色片段（当前角色 mission + phase + 交接指令）。
function buildRolePrompt(state: RoleState): string {
	const def = ROLES[state.role];
	const lines = [
		"<research_role>",
		`# 当前角色：${def.label}　|　阶段：${state.phase}`,
		def.mission,
		"",
		"重要：你只能使用上述本角色的研究工具；内置工具（读写文件、运行命令等）不受限。" +
			"完成本角色职责后，必须调用 coordinator_decide 交接（proceed 推进 / refine 退回重做 / pivot 推翻重来），" +
			"不要越权调用其他角色的研究工具。",
	];
	if (state.note) lines.push(`备注：${state.note}`);
	lines.push("</research_role>");
	return lines.join("\n");
}

export default function researchRolesExtension(pi: ExtensionAPI) {
	// 每会话首次从 session entries 恢复角色态（hydrated 守卫保后续 turn 零 I/O）：
	// 经 pickRoleEntry（含 isValidRoleState 校验）取最后一条合法 role_state；
	// 无任何合法态（全新会话/损坏 data）则显式降级 coordinator/idle——避免切到无 role_state 新会话时残留旧态。
	// 跨会话由 session_start handler 重置 hydrated，使每个新会话重新 hydrate。
	function hydrate(ctx: { sessionManager: { getEntries(): readonly unknown[] } }): void {
		if (hydrated) return;
		hydrated = true;
		const entries = ctx.sessionManager.getEntries() as { type: string; customType?: string; data?: unknown }[];
		liveState = pickRoleEntry(entries) ?? { ...INITIAL_STATE, updatedAt: new Date().toISOString() };
	}

	// 转移并持久化：更新模块级真相源 + 经闭包 pi.appendEntry 写入 session（不入 LLM）。
	function applyTransition(next: RoleState): RoleState {
		liveState = next;
		pi.appendEntry("role_state", liveState);
		return liveState;
	}

	// 会话进入（startup/reload/new/resume/fork）时重置守卫，使新会话首个 before_agent_start 重新 hydrate，
	// 消除跨会话串味（types.ts:546-549 SessionStartEvent；无条件重置覆盖全部 reason，不依赖 reason 分支）。
	pi.on("session_start", () => {
		hydrated = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		hydrate(ctx); // 每会话首次实读恢复角色态，后续 turn 由 hydrated 守卫零 I/O。
		// 链式注入：保留既有 systemPrompt（含 research-memory 注入），追加本角色片段。
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildRolePrompt(liveState)}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		hydrate(ctx); // 守卫下同会话仅首次实读；保证 resume 后首个动作即 tool_call 时也已恢复。
		if (isToolAllowed(liveState.role, event.toolName)) return;
		return {
			block: true,
			reason:
				`当前角色「${ROLES[liveState.role].label}」（阶段 ${liveState.phase}）不可使用工具「${event.toolName}」。` +
				`请先调用 coordinator_decide 切换到有权使用该工具的角色，再重试。`,
		};
	});

	pi.registerTool({
		name: COORDINATOR_DECIDE,
		label: "Coordinator Decide (Role Transition)",
		description:
			"Explicitly transition the research role state machine. Call this to hand off between roles: " +
			"proceed (advance to the next role in the chain), refine (redo current work; reviewer's refine sends it " +
			"back to coder to fix the experiment), or pivot (abandon hypothesis, go back to planner). " +
			"Optionally set target to override the next role explicitly (Coordinator-driven scheduling). " +
			"The tool result returns the new role's mission and available tools — act on it immediately; " +
			"the next turn's system prompt will formalize the switch.",
		parameters: Type.Object({
			decision: Type.Union(
				[Type.Literal("proceed"), Type.Literal("refine"), Type.Literal("pivot")],
				{
					description:
						"proceed: advance to next role; refine: redo current work (reviewer→coder); pivot: abandon, back to planner",
				},
			),
			rationale: Type.String({
				description: "Why this transition. Be specific about what was accomplished or what triggered the decision.",
			}),
			target: Type.Optional(
				Type.Union(
					[
						Type.Literal("coordinator"),
						Type.Literal("planner"),
						Type.Literal("researcher"),
						Type.Literal("coder"),
						Type.Literal("reviewer"),
						Type.Literal("reporter"),
					],
					{ description: "Optional: explicitly override the next role (Coordinator scheduling)." },
				),
			),
			evidence: Type.Optional(
				Type.String({ description: "Optional: key evidence or artifacts supporting this decision." }),
			),
		}),
		async execute(_id, params) {
			const prev = liveState;
			const next = applyTransition(transition(prev, params.decision, params.target));
			const def = ROLES[next.role];

			const lines = [
				`ROLE TRANSITION: ${ROLES[prev.role].label}（${prev.phase}）→ ${def.label}（${next.phase}）`,
				`Decision: ${params.decision}${params.target ? ` (target=${params.target})` : ""}`,
				`Rationale: ${params.rationale}`,
			];
			if (params.evidence) lines.push(`Evidence: ${params.evidence}`);
			lines.push(
				"",
				"=== 你现在的角色 ===",
				def.mission,
				"",
				`可用研究工具：${def.toolAllowlist.length > 0 ? def.toolAllowlist.join("、") : "（无，仅内置工具）"}` +
					"（coordinator_decide 全程可用）。立即以新角色身份继续；下一 turn 的 system prompt 会正式固化此切换。",
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("role-status", {
		description: "Show current research role and phase",
		async handler(_args, ctx) {
			hydrate(ctx); // 守卫下同会话仅首次实读；显示当前角色态。
			const def = ROLES[liveState.role];
			const lines = [
				`Research Role: ${def.label}`,
				`Phase: ${liveState.phase}`,
				`Updated: ${liveState.updatedAt}`,
				`Allowed research tools: ${def.toolAllowlist.length > 0 ? def.toolAllowlist.join(", ") : "(none)"} (+ coordinator_decide)`,
			];
			if (liveState.note) lines.push(`Note: ${liveState.note}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("role-reset", {
		description: "Reset research role state to coordinator/idle",
		async handler(_args, ctx) {
			applyTransition({ role: "coordinator", phase: "idle", updatedAt: new Date().toISOString() });
			ctx.ui.notify("Role reset to coordinator/idle.", "info");
		},
	});
}
