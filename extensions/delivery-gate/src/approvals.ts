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
	body: Type.String({ minLength: 1, description: "本阶段完整决策正文，用简短分行说明，不复制全文台账。design 说明目标、范围、关键设计、风险和验收方向；有规划文档时先给相对路径和修改摘要，简单任务可直接在正文说明，无须新建文档。implementation 说明计划修改的文件、步骤、环境、验收和停止条件，并区分计划文件与工具实际可写目录。工具提供原方案查看入口，无须重复抄写；不以路径或摘要 ID 代替决策内容。" }),
	paths: Type.Array(Type.String({ minLength: 1 }), { description: "design 列明本任务由父维护的确切规划 Markdown 路径，随确认保护；简单任务没有规划文档时传 []，不得为填参数创建占位文档或遗漏已有需维护的方案/台账。implementation 必须列明允许子修改的文件或目录，不能传空数组。路径按 cwd 解析，不是 glob。" }),
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
	design: "确认后准备实施步骤与验收说明；本次不批准源码开发或命令执行。",
	implementation: "仅授权列明范围内的本地开发、自检、验证、审查与返工。提交、推送、PR、发布、部署、生产及其他外部写入不在本次授权内。",
};

function presentation(proposal: Proposal, expanded = false): string {
	const relative = (file: string) => path.relative(proposal.cwd, file) || ".";
	const body = expanded || proposal.body.length <= 600 ? proposal.body : `${proposal.body.slice(0, 600)}\n…完整正文见详情`;
	return (expanded ? `${titles[proposal.stage]}\n工作目录：${proposal.cwd}\n\n` : "") + permissions[proposal.stage]
		+ (proposal.paths.length ? `\n\n${proposal.stage === "design" ? "规划文档（由父会话维护）" : "工具实际可写范围（文件或目录）"}：\n${proposal.paths.map((file) => `• ${relative(file)}`).join("\n")}` : proposal.stage === "design" ? "\n\n方案保存在会话中，无规划文档。" : "")
		+ (proposal.stage === "implementation" ? "\n\n运行环境：本机，使用当前用户的 Shell、工具链与权限。文件工具按上述范围检查；Shell 的文件、网络和后台进程不受这些路径隔离。"
			+ (expanded ? `\n额外验收输入：\n${proposal.inputs.map((file) => `• ${relative(file)}`).join("\n") || "无"}` : `\n${proposal.inputs.length} 项额外验收输入，${proposal.validationCommands.length} 条固定验收命令（详情可核对）`) : "")
		+ `\n\n${body}`
		+ (expanded && proposal.validationCommands.length ? `\n\n固定验收命令：\n${proposal.validationCommands.map((command, index) => `${index + 1}. ${command}`).join("\n\n")}` : "")
		+ (expanded ? `\n\n提案记录：${proposal.id}${proposal.designApprovalId ? `\n方案批准引用：${proposal.designApprovalId}` : ""}` : "");
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
		: `${titles[entry.data!.stage]} · ${entry.data!.paths.length ? `${entry.data!.paths.length} 项路径 · ` : ""}Ctrl+O 查看完整提案`), 0, 0));
	pi.registerTool({
		name: APPROVAL_TOOL, label: "请求交付批准",
		description: "在父 Pi TUI 分别请求方案和实施确认，RPC/JSON/print 不接受批准。简单任务直接说明正文，design.paths 可为空；需要持续维护的方案/台账沿用已有文档。实施须列明修改范围、步骤、本机环境与固定验收命令；确认后开发子会话可运行本机 Shell，文件工具的路径检查不构成 Shell 隔离。",
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
				const proposal: Proposal = { id: randomUUID(), sessionId, workspaceKey: workspace.key, cwd: workspace.cwdPath,
					stage: request.stage, body: request.body, paths, inputs, validationCommands: [...request.validationCommands],
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
					const panel = request.stage === "design" ? new DesignReviewPanel(presentation(proposal), presentation(proposal, true), tui, theme, done)
						: new DeliveryPanel(titles[request.stage], presentation(proposal),
						presentation(proposal, true) + (approvedDesign ? `\n\n已确认的方案原文：\n${presentation(approvedDesign, true)}` : ""),
						[accept, "暂不批准"], tui, theme, done, 1);
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
		// 只核实批准依据，不授予 writer；执行方不能把返回快照缓存为持续有效的权限。
		async readImplementationApproval(ctx: ExtensionContext, signal?: AbortSignal) {
			const { expected, expectedDesign, workspace } = await readCurrent(ctx, signal);
			return { approvalId: expected.approval.id, proposalId: expected.proposal.id, designApprovalId: expectedDesign!.approval.id,
				designBody: expectedDesign!.proposal.body, implementationBody: expected.proposal.body,
				planningPaths: [...expectedDesign!.proposal.paths],
				sessionId: expected.approval.sessionId, workspace, paths: [...expected.proposal.paths],
				validationCommands: [...expected.proposal.validationCommands], inputs: [...expected.proposal.inputs], signal: expected.controller.signal };
		},
	};
}
