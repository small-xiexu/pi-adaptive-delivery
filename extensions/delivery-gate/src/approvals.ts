import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { resolveWorkspaceIdentity } from "./workspace.ts";
import { DeliveryPanel, DesignReviewPanel, displayText, type DesignReviewResult } from "./ui.ts";

export const APPROVAL_TOOL = "delivery_approval";
export const PROPOSAL_ENTRY = "delivery-approval-proposal";
export const APPROVAL_ENTRY = "delivery-approval";

const parameters = Type.Object({
	stage: StringEnum(["design", "implementation"] as const),
	body: Type.String({ minLength: 1, description: "本阶段完整决策正文，用大白话分行说明，不复制全文台账。design 先说明本次要改成什么、范围、关键设计、风险和验收方向；有规划文档时在正文后补充修改摘要，路径由界面详情列出。简单任务直接说明，无须新建文档。implementation 先说明具体步骤、依赖、环境与停止条件；可写范围和固定验收命令由界面按参数列出，无须重复抄写，但须区分计划文件与实际可写目录。工具提供原方案查看入口，不重述相同方案，不以路径或摘要 ID 代替决策内容。" }),
	documentStrategy: StringEnum(["none", "reuse", "new"] as const, { description: "本次规划文档策略：none=不落盘，reuse=复用现有文档，new=新建需求文档。implementation 与已确认的 design 使用相同策略。" }),
	paths: Type.Array(Type.String({ minLength: 1 }), { description: "design 列明本任务由父维护的确切规划 Markdown 路径，随确认保护；简单任务没有规划文档时传 []，不得为填参数创建占位文档或遗漏已有需维护的方案/台账。implementation 必须列明允许子修改的文件或目录，不能传空数组。路径按 cwd 解析，不是 glob。" }),
	technicalPlanPath: Type.Optional(Type.String({ minLength: 1, description: "design 中技术方案 Markdown 的相对路径；必须同时出现在 design.paths 中。无对应文件时省略。implementation 沿用已确认 design 的值。" })),
	implementationPlanPath: Type.Optional(Type.String({ minLength: 1, description: "design 中实施计划 Markdown 的相对路径；必须同时出现在 design.paths 中。无对应文件时省略。implementation 沿用已确认 design 的值。" })),
	validationCommands: Type.Array(Type.String({ minLength: 1 }), { description: "implementation 的固定本地验收命令；其他阶段为空。本工具不执行命令。" }),
	inputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "implementation 中纳入候选指纹的额外源码、配置或测试输入，按 cwd 解析，必须在 worktree 内且不含凭据。不包含整个工作区、规划文档、Git 或执行记录；这是验收范围，不是 Shell 隔离。" })),
}, { additionalProperties: false });

type Request = Static<typeof parameters>;
interface Proposal {
	id: string;
	sessionId: string;
	workspaceKey: string;
	cwd: string;
	stage: Request["stage"];
	body: string;
	documentStrategy: "none" | "reuse" | "new";
	technicalPlanPath?: string;
	implementationPlanPath?: string;
	paths: string[];
	validationCommands: string[];
	designApprovalId?: string;
	inputs: string[];
}
interface Approval {
	id: string;
	proposalId: string;
	sessionId: string;
	workspaceKey: string;
	source: { mode: "tui"; interaction: "custom"; toolCallId: string };
}
interface Confirmed {
	approval: Approval;
	proposal: Proposal;
	sessionFile: string;
	controller: AbortController;
}

const titles = { design: "方案确认", implementation: "实施确认" };
const actions = { design: "确认方案", implementation: "确认实施" };
const permissions = {
	design: "确认后准备实施步骤，暂不修改代码或运行命令。",
	implementation: "确认后在本机开发、验收和返工；Shell 使用你的权限，不受文件路径隔离。\n提交、推送、PR、发布、部署、生产及其他外部写入需另行授权。",
};

const documentStrategyLabels = { none: "不落盘", reuse: "复用现有文档", new: "新建需求文档" } as const;
type DocumentPlan = Pick<Proposal, "documentStrategy" | "technicalPlanPath" | "implementationPlanPath">;

function documentSummary(proposal: Proposal): string {
	const relative = (file?: string) => file ? path.relative(proposal.cwd, file) || "." : "无";
	const labeled = new Set([proposal.technicalPlanPath, proposal.implementationPlanPath].filter(Boolean));
	const extra = proposal.stage === "design" ? proposal.paths.filter((file) => !labeled.has(file)) : [];
	return `文档策略：${documentStrategyLabels[proposal.documentStrategy]}\n技术方案：${relative(proposal.technicalPlanPath)}\n实施计划：${relative(proposal.implementationPlanPath)}`
		+ (extra.length ? `\n其他规划文档：\n${extra.map((file) => `• ${relative(file)}`).join("\n")}` : "");
}

function resolveDocumentPlan(request: Request, cwd: string, expected?: Proposal): DocumentPlan {
	if (request.stage === "implementation") {
		if (!expected || request.documentStrategy !== expected.documentStrategy) throw new Error("实施文档策略必须沿用已确认方案");
		for (const [name, value] of [["technicalPlanPath", request.technicalPlanPath], ["implementationPlanPath", request.implementationPlanPath]] as const) {
			if (value !== undefined && path.resolve(cwd, value) !== expected[name]) throw new Error("实施规划路径必须沿用已确认方案");
		}
		return { documentStrategy: expected.documentStrategy, technicalPlanPath: expected.technicalPlanPath, implementationPlanPath: expected.implementationPlanPath };
	}
	const resolvedPaths = request.paths.map((value) => path.resolve(cwd, value));
	if (request.documentStrategy === "none" && resolvedPaths.length) throw new Error("不落盘任务的规划路径必须为空");
	if (request.documentStrategy !== "none" && !resolvedPaths.length) throw new Error("落盘任务必须列明规划 Markdown 路径");
	const plan = {
		documentStrategy: request.documentStrategy,
		technicalPlanPath: request.technicalPlanPath ? path.resolve(cwd, request.technicalPlanPath) : undefined,
		implementationPlanPath: request.implementationPlanPath ? path.resolve(cwd, request.implementationPlanPath) : undefined,
	};
	for (const value of [plan.technicalPlanPath, plan.implementationPlanPath].filter((item): item is string => Boolean(item))) {
		if (!resolvedPaths.includes(value)) throw new Error("技术方案和实施计划路径必须同时列在规划 paths 中");
	}
	return plan;
}

function presentation(proposal: Proposal, expanded = false): string {
	const relative = (file: string) => path.relative(proposal.cwd, file) || ".";
	const files = (paths: string[]) => paths.map((file) => `• ${relative(file)}`).join("\n") || "无";
	let content = `${documentSummary(proposal)}\n\n${proposal.body}`;
	if (proposal.stage === "implementation") {
		content += `\n\n允许修改（文件或目录）：\n${files(proposal.paths)}`
			+ `\n\n验收时依次运行：\n${proposal.validationCommands.map((command, index) => `${index + 1}. ${command}`).join("\n") || "未提供固定命令，不能完成交付验收。"}`;
		if (!expanded && proposal.inputs.length) content += `\n\n另有 ${proposal.inputs.length} 项文件纳入验收核对，Ctrl+O 查看清单。`;
	}
	if (expanded) content += (proposal.stage === "design" ? `\n\n维护的规划文档：\n${proposal.paths.length ? files(proposal.paths) : "方案保存在会话中，无须规划文档。"}`
		: `\n\n额外验收输入：\n${files(proposal.inputs)}\n\n运行环境：本机，父子沿用 Pi 已启用的工具与权限检查。修改范围是任务约定及候选验收范围，普通文件、Shell、联网和插件工具不由交付包额外拦截。`)
		+ `\n\n${permissions[proposal.stage]}\n\n工作目录：${proposal.cwd}\n提案记录：${proposal.id}${proposal.designApprovalId ? `\n方案批准引用：${proposal.designApprovalId}` : ""}`;
	return content;
}

// 只读取 Pi 的原生文件。内存条目即使可见，也不能证明 appendEntry 已经落盘。
async function persisted<T>(ctx: ExtensionContext, ...references: [customType: string, id: string][]): Promise<CustomEntry<T>[]> {
	const file = ctx.sessionManager.getSessionFile();
	if (!file) throw new Error("当前 Session 不持久化，不能记录批准");
	const content = await readFile(file, "utf8");
	if (!content.endsWith("\n")) throw new Error("Session 记录不完整，批准不可用");
	const rows = content.trimEnd().split("\n").map((line) => JSON.parse(line));
	if (rows[0]?.type !== "session" || rows[0]?.id !== ctx.sessionManager.getSessionId()) throw new Error("Session 文件归属不符");
	const branch = ctx.sessionManager.getBranch();
	return references.map(([customType, id]) => {
		const matches = rows.filter((row) => row.type === "custom" && row.customType === customType && row.data?.id === id);
		if (matches.length !== 1) throw new Error("批准相关条目未唯一落盘");
		const entry = matches[0] as CustomEntry<T>;
		const original = branch.find((row) => row.id === entry.id);
		if (!original) throw new Error("批准相关条目不在当前分支");
		if (!isDeepStrictEqual(original, entry)) throw new Error("批准记录已变化或未完整落盘");
		return entry;
	});
}

export function installApprovals(pi: ExtensionAPI) {
	// 只记住本次运行亲自完成的确认；与原生条目不共享可变对象，也不从历史恢复。
	let design: Confirmed | undefined;
	let implementation: Confirmed | undefined;
	let pending: AbortController | undefined;
	const invalidateImplementation = () => {
		const previous = implementation;
		implementation = undefined;
		previous?.controller.abort(new Error("实施授权已失效，停止后续开发"));
	};
	const invalidateDesign = () => {
		design?.controller.abort(new Error("方案确认已失效"));
		design = undefined;
		invalidateImplementation();
	};
	const invalidate = () => {
		invalidateDesign();
		pending?.abort(new Error("会话发生切换、重载或分支导航，批准请求已失效"));
	};
	pi.on("session_start", invalidate);
	pi.on("session_shutdown", invalidate);
	pi.on("session_tree", invalidate);
	pi.registerCommand("delivery-resume", {
		description: "继续当前会话尚未确认的方案审阅，不恢复旧权限或开始实施",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("方案审阅需要父 Pi TUI。", "warning"); return; }
			if (pending || !ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("当前仍有任务或消息待处理，请结束后再恢复方案审阅。", "warning"); return; }
			const controller = new AbortController();
			pending = controller;
			const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile(), cwd = ctx.cwd;
			const branch = structuredClone(ctx.sessionManager.getBranch());
			try {
				const latest = branch.findLast((row): row is CustomEntry<Proposal> => row.type === "custom" && row.customType === PROPOSAL_ENTRY && (row.data as Proposal)?.stage === "design");
				if (!latest?.data || branch.some((row) => row.type === "custom" && row.customType === APPROVAL_ENTRY && (row.data as Approval)?.proposalId === latest.data!.id)) {
					ctx.ui.notify("当前分支没有待恢复的方案审阅。", "info"); return;
				}
				const proposal = structuredClone(latest.data);
				const workspace = await resolveWorkspaceIdentity(cwd);
				const [saved] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]);
				controller.signal.throwIfAborted();
				if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sessionFile || ctx.cwd !== cwd
					|| !isDeepStrictEqual(ctx.sessionManager.getBranch(), branch) || !isDeepStrictEqual(saved.data, proposal)
					|| proposal.workspaceKey !== workspace.key || proposal.sessionId !== sessionId || proposal.cwd !== workspace.cwdPath) throw new Error("方案审阅记录或会话归属已变化");
				if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("当前已有任务或消息待处理");
				pi.sendUserMessage(`继续审阅当前会话的方案。先读取 adaptive-delivery Skill，${proposal.paths.length ? `读取最新方案文件和已有台账（规划文档：${JSON.stringify(proposal.paths)}），` : "本任务没有规划文档，以会话中的方案正文为起点，"}核对已有修改意见及现场，再形成新的 design 审阅提案。有文档时说明路径与修改摘要；无文档时直接修订会话正文，无须补建文件。以下仅是定位上次讨论的历史提案，不能直接当作当前结论或批准依据。\n\n${proposal.body}\n\n本次只恢复方案审阅，不确认方案或实施；不要自动进入开发。需要编辑 Markdown 时使用父文档工具并保留用户改动；旧方案和实施批准仍须重新取得。`, { expandPromptTemplates: false });
			} catch (error) {
				ctx.ui.notify(`无法恢复方案审阅：${error instanceof Error ? error.message : String(error)}`, "error");
			} finally { if (pending === controller) pending = undefined; }
		},
	});
	pi.registerEntryRenderer<Proposal>(PROPOSAL_ENTRY, (entry, { expanded }) => new Text(displayText(expanded ? presentation(entry.data!, true)
		: `${titles[entry.data!.stage]}提案已保存`), 0, 0));
	pi.registerTool({
		name: APPROVAL_TOOL, label: "请求交付批准",
		description: "在父 Pi TUI 分别请求方案和实施确认，RPC/JSON/print 不接受批准。简单任务直接说明正文，design.paths 可为空；需要持续维护的方案/台账沿用已有文档。实施须列明约定修改范围、步骤、本机环境与固定验收命令。确认管理本 Package 的交付入口，普通工具沿用 Pi 权限，不提供文件或网络隔离。",
		parameters,
		execute: async (toolCallId, request, signal, _onUpdate, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("批准只接受父 Pi 的真实 TUI 交互；当前模式不接受批准");
			if (pending) throw new Error("已有批准请求等待处理，不并发显示第二个请求");
			if (request.stage !== "design" && request.stage !== "implementation") throw new Error("只接受方案或实施确认；Markdown 编辑无需单独授权");
			if (request.stage === "design") invalidateDesign();
			if (request.stage === "implementation") invalidateImplementation();
			const controller = new AbortController();
			pending = controller;
			const operation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			try {
				operation.throwIfAborted();
				const sessionId = ctx.sessionManager.getSessionId();
				const sessionFile = ctx.sessionManager.getSessionFile();
				const cwd = ctx.cwd;
				const workspace = await resolveWorkspaceIdentity(cwd);
				const paths = request.paths.map((value) => path.resolve(workspace.cwdPath, value));
				const inputs = request.inputs?.map((value) => path.resolve(workspace.cwdPath, value)) ?? [];
				if (!request.body.trim() || [...request.paths, ...(request.inputs ?? [])].some((value) => !value.trim()) || request.validationCommands.some((value) => !value.trim())) {
					throw new Error("批准正文、路径或验收命令不能为空白");
				}
				if ([...paths, ...inputs].some((value) => { const relative = path.relative(workspace.workspacePath, value); return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); })) {
					throw new Error("批准路径必须在当前 worktree 内");
				}
				if (request.stage === "implementation" && !paths.length) throw new Error("实施须列明开发路径");
				if (request.stage === "design" && paths.some((value) => path.extname(value).toLowerCase() !== ".md")) throw new Error("规划文档只接受确切 Markdown 路径");
				if (request.stage !== "implementation" && request.validationCommands.length) throw new Error("本阶段不授予命令执行权限");
				if (request.stage !== "implementation" && inputs.length) throw new Error("只有实施阶段可声明额外验收输入");
				const expectedDesign = request.stage === "implementation" ? design : undefined;
				let approvedDesign: Proposal | undefined;
				if (request.stage === "implementation") {
					if (!expectedDesign || expectedDesign.approval.sessionId !== sessionId || expectedDesign.approval.workspaceKey !== workspace.key
						|| expectedDesign.sessionFile !== sessionFile) throw new Error("当前会话与工作区尚无可信方案确认，不能请求实施确认");
					const [entry, body] = await persisted<Approval | Proposal>(ctx, [APPROVAL_ENTRY, expectedDesign.approval.id], [PROPOSAL_ENTRY, expectedDesign.proposal.id]);
					if (!isDeepStrictEqual(entry.data, expectedDesign.approval) || !isDeepStrictEqual(body.data, expectedDesign.proposal)) throw new Error("方案批准记录已变化");
					approvedDesign = expectedDesign.proposal;
				}
				const documentPlan = resolveDocumentPlan(request, workspace.cwdPath, approvedDesign ?? expectedDesign?.proposal);
				const proposal: Proposal = { id: randomUUID(), sessionId, workspaceKey: workspace.key, cwd: workspace.cwdPath,
					stage: request.stage, body: request.body, documentStrategy: documentPlan.documentStrategy,
					...(documentPlan.technicalPlanPath ? { technicalPlanPath: documentPlan.technicalPlanPath } : {}),
					...(documentPlan.implementationPlanPath ? { implementationPlanPath: documentPlan.implementationPlanPath } : {}),
					paths, inputs, validationCommands: [...request.validationCommands],
					...(approvedDesign ? { designApprovalId: expectedDesign!.approval.id } : {}) };
				const current = () => {
					operation.throwIfAborted();
					if (expectedDesign && design !== expectedDesign) throw new Error("本次实施所依赖的方案确认已失效");
					if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sessionFile || ctx.cwd !== cwd) {
						throw new Error("确认期间会话、Session 文件或目录已变化");
					}
				};
				current();
				pi.appendEntry(PROPOSAL_ENTRY, structuredClone(proposal));
				const [displayed] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]);
				if (!isDeepStrictEqual(displayed.data, proposal)) throw new Error("展示正文与持久记录不一致");
				current();
				const accept = actions[request.stage];
				const choice = await ctx.ui.custom<string | DesignReviewResult>((tui, theme, _keys, done) => {
					const cancel = () => done(undefined);
					operation.addEventListener("abort", cancel, { once: true });
					if (operation.aborted) cancel();
					const panel = request.stage === "design" ? new DesignReviewPanel(presentation(proposal), presentation(proposal, true), tui, theme, done, permissions.design)
						: new DeliveryPanel(titles[request.stage], presentation(proposal),
						presentation(proposal, true) + (approvedDesign ? `\n\n已确认的方案原文：\n${presentation(approvedDesign, true)}` : ""),
						[accept, "暂不批准"], tui, theme, done, 1, permissions.implementation);
					return Object.assign(panel, { dispose: () => operation.removeEventListener("abort", cancel) });
				});
				current();
				if (request.stage === "design" && typeof choice === "object" && choice.feedback.trim()) {
					const [saved] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]);
					if (!isDeepStrictEqual(saved.data, proposal)) throw new Error("反馈对应的方案正文已变化");
					current();
					return { content: [{ type: "text", text: `用户对本次方案的修改意见：\n${choice.feedback}\n\n尚未确认方案。${proposal.paths.length ? "先读最新方案并修订同一份文件，Markdown 编辑无需额外授权" : "结合会话中的方案正文、最新意见和现场直接修订说明，无须补建规划文件"}；需澄清时一次只问一个关键问题。说明修改与未采纳原因，再发起新的 design 审阅提案，继续等待意见或明确批准。不要进入实施计划或开发。` }],
						details: { approved: false, proposalId: proposal.id, feedback: choice.feedback } };
				}
				if (choice !== accept) return { content: [{ type: "text", text: request.stage === "design"
					? "方案审阅已暂停，方案正文与已发送意见保留。用户可输入继续看方案、直接提出意见，或用 /delivery-resume 恢复；现在停止推进，不自动重问。"
					: "本次未批准，权限未扩大；暂停推进，不自动重复请求批准。" }], details: { approved: false, proposalId: proposal.id, ...(request.stage === "design" ? { paused: true } : {}) }, terminate: true };
				// 用户等待期间正文可能被外部改动；确认的是刚才展示的正文，不是后来替换的文件。
				const [confirmed] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]);
				if (!isDeepStrictEqual(confirmed.data, proposal)) throw new Error("确认正文与原展示正文不一致");
				if (approvedDesign) {
					const [savedDesign, savedBody] = await persisted<Approval | Proposal>(ctx, [APPROVAL_ENTRY, proposal.designApprovalId!], [PROPOSAL_ENTRY, approvedDesign.id]);
					if (!isDeepStrictEqual(savedDesign.data, expectedDesign!.approval) || !isDeepStrictEqual(savedBody.data, approvedDesign)) throw new Error("方案批准记录已变化");
				}
				current();
				const approval: Approval = { id: randomUUID(), proposalId: proposal.id, sessionId, workspaceKey: workspace.key,
					source: { mode: "tui", interaction: "custom", toolCallId } };
				pi.appendEntry(APPROVAL_ENTRY, structuredClone(approval));
				const [saved] = await persisted<Approval>(ctx, [APPROVAL_ENTRY, approval.id]);
				if (!isDeepStrictEqual(saved.data, approval)) throw new Error("确认记录与持久记录不一致");
				current();
				const live = { approval, proposal, sessionFile: sessionFile!, controller: new AbortController() };
				if (proposal.stage === "design") design = live;
				if (proposal.stage === "implementation") implementation = live;
				return { content: [{ type: "text", text: `${titles[request.stage]}已记录。${request.stage === "implementation" ? "用户未要求暂停且没有未决问题时，继续在本轮已批准范围和 writer 交接下委派本机开发，无须额外的“继续”。固定验收使用本次命令清单；独立审查仍需当前候选的可信验收。" : `用户未要求暂停且没有未决问题时，继续准备实施步骤与验收说明；${proposal.paths.length ? "按需维护已有规划文档" : "简单任务直接在会话中说明，无须补建技术方案或实施计划文件"}，实施仍须独立确认。`}` }],
					details: { approved: true, approvalId: approval.id, proposalId: proposal.id, sessionFile: ctx.sessionManager.getSessionFile() } };
			} finally {
				pending = undefined;
			}
		},
	});
	async function readCurrent(ctx: ExtensionContext, signal?: AbortSignal) {
		const expected = implementation;
		const expectedDesign = design;
		try {
			if (!expected) throw new Error("本轮没有可核实的实施授权");
			const cwd = ctx.cwd;
			const current = () => {
				signal?.throwIfAborted();
				if (implementation !== expected) throw new Error("实施授权已失效或被新的请求替换");
				if (!expectedDesign || design !== expectedDesign
					|| expected.proposal.designApprovalId !== expectedDesign.approval.id) throw new Error("实施授权依赖的方案确认已失效");
				if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("实施授权只供原父 TUI 会话核实");
				if (ctx.sessionManager.getSessionId() !== expected.approval.sessionId
					|| ctx.sessionManager.getSessionFile() !== expected.sessionFile || ctx.cwd !== cwd) {
					throw new Error("实施授权的 Session、文件或当前目录已变化");
				}
			};
			current();
			const workspace = await resolveWorkspaceIdentity(cwd);
			current();
			if (workspace.key !== expected.approval.workspaceKey) throw new Error("实施授权不属于当前 worktree");
			const confirmations = [expected, expectedDesign!];
			const references: [string, string][] = confirmations.flatMap((item) => [[APPROVAL_ENTRY, item.approval.id], [PROPOSAL_ENTRY, item.proposal.id]] as [string, string][]);
			const entries = await persisted<Approval | Proposal>(ctx, ...references);
			current();
			if (confirmations.some((item, index) => !isDeepStrictEqual(entries[index * 2]!.data, item.approval)
				|| !isDeepStrictEqual(entries[index * 2 + 1]!.data, item.proposal))) {
				throw new Error("实施授权与本轮真实确认的正文或来源不一致");
			}
			return { expected, expectedDesign, workspace };
		} catch (error) {
			if (implementation === expected) invalidateImplementation();
			throw error;
		}
	}
	return {
		get pending() { return pending !== undefined; },
		// 仅供界面说明本次运行已记录的确认；执行仍须调用原有持久核验。
		get confirmedStage() { return implementation ? "implementation" as const : design ? "design" as const : undefined; },
		// 只核实批准依据，不授予 writer；执行方不能把返回快照缓存为持续有效的权限。
		async readImplementationApproval(ctx: ExtensionContext, signal?: AbortSignal) {
			const { expected, expectedDesign, workspace } = await readCurrent(ctx, signal);
			return { approvalId: expected.approval.id, proposalId: expected.proposal.id, designApprovalId: expectedDesign!.approval.id,
				designBody: expectedDesign!.proposal.body, implementationBody: expected.proposal.body,
				documentStrategy: expectedDesign!.proposal.documentStrategy,
				technicalPlanPath: expectedDesign!.proposal.technicalPlanPath,
				implementationPlanPath: expectedDesign!.proposal.implementationPlanPath,
				planningPaths: [...expectedDesign!.proposal.paths],
				sessionId: expected.approval.sessionId, workspace, paths: [...expected.proposal.paths],
				validationCommands: [...expected.proposal.validationCommands], inputs: [...expected.proposal.inputs], signal: expected.controller.signal };
		},
	};
}
