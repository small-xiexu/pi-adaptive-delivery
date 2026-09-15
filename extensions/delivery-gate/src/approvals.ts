import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { resolveWorkspaceIdentity } from "./workspace.ts";
import { DesignReviewPanel, displayText, type DesignReviewResult } from "./ui.ts";

export const APPROVAL_TOOL = "delivery_approval";
export const PROPOSAL_ENTRY = "delivery-approval-proposal";
export const APPROVAL_ENTRY = "delivery-approval";

const parameters = Type.Object({
	stage: StringEnum(["design"] as const),
	body: Type.String({ minLength: 1, description: "完整技术方案：说明目标、业务与数据行为、范围、关键设计、风险和验收标准；结尾另起一行“本次假设：”，列出未经确认且不成立就要改方案的推断（最多 3 条），没有写“无”。确认同时授权开始实施，不提交第二份实施确认。" }),
	documentStrategy: StringEnum(["none", "reuse", "new"] as const, { description: "none=方案留在会话；reuse=复用现有文档；new=新建需求文档。实施计划由 AI 内部维护。" }),
	paths: Type.Array(Type.String({ minLength: 1 }), { description: "父维护的确切规划 Markdown 路径，供子任务保护；无文档传 []，不得遗漏已有需维护的方案或台账。不是开发范围。" }),
	technicalPlanPath: Type.Optional(Type.String({ description: "技术方案 Markdown 路径，须在 paths 中；无对应文件时省略。" })),
	implementationPlanPath: Type.Optional(Type.String({ description: "AI 内部实施台账 Markdown 路径，须在 paths 中；可在确认后创建。无文档时省略。" })),
}, { additionalProperties: false });
type Request = Static<typeof parameters>;
interface Proposal extends Request { id: string; sessionId: string; workspaceKey: string; cwd: string; }
interface Approval { id: string; proposalId: string; sessionId: string; workspaceKey: string; source: { mode: "tui"; interaction: "custom"; toolCallId: string }; }
interface Confirmed { approval: Approval; proposal: Proposal; sessionFile: string; controller: AbortController; }

const action = "确认方案并开始实施";
const permission = "确认后 AI 自行维护实施计划，开始本机开发、检查、按需审查和返工。Shell 沿用 Pi 权限。\n提交、推送、PR、发布、部署及其他外部写入需另行授权。";
export const executionInstruction = "方案已由用户确认并授权开始实施。请自行拆解并维护内部计划：简单任务保存在会话中，复杂任务沿用项目唯一台账，记录待完成、进行中、已完成、阻塞、返工及检查证据。简单任务由父 Pi 直接修改并运行项目已有检查；复杂任务按需调用 delivery_develop，必要时调用 delivery_review，每次调用提供当前 paths 和 inputs。不再请求实施确认；文件数量、步骤、顺序、检查命令调整和范围内返工无需重新批准。只有业务目标、数据行为、对外接口、验收标准或未覆盖的重大外部风险变化时，暂停受影响工作并重新确认方案。完成后核对实际差异和检查结果再交付。";

async function resolvePlan(request: Request, cwd: string) {
	const paths = request.paths.map((value) => path.resolve(cwd, value));
	const technicalPlanPath = request.technicalPlanPath?.trim() ? path.resolve(cwd, request.technicalPlanPath) : undefined;
	const implementationPlanPath = request.implementationPlanPath?.trim() ? path.resolve(cwd, request.implementationPlanPath) : undefined;
	if (request.documentStrategy === "none" && (paths.length || technicalPlanPath || implementationPlanPath)) throw new Error("不落盘任务的规划路径必须为空");
	if (request.documentStrategy !== "none" && !paths.length) throw new Error("落盘任务必须列明规划 Markdown 路径");
	if (request.documentStrategy !== "none" && !technicalPlanPath && !implementationPlanPath) throw new Error("落盘任务须明确技术方案或实施计划的实际路径；单份合并文档可使用同一路径");
	for (const file of [technicalPlanPath, implementationPlanPath].filter(Boolean)) if (!paths.includes(file!)) throw new Error("技术方案和实施计划路径必须同时列在规划 paths 中");
	for (const target of paths) {
		if (path.extname(target).toLowerCase() !== ".md") throw new Error("规划文档只接受确切 Markdown 路径");
		// 技术方案必须先可查阅；内部台账可以在确认后由父写入。
		if (target === implementationPlanPath && target !== technicalPlanPath) continue;
		let info;
		try { info = await lstat(target); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`规划文档尚未写入：${path.relative(cwd, target)}。先用 delivery_document_write 落盘（或改用 documentStrategy: "none"），再提交本次确认。`);
			throw error;
		}
		if (info.isSymbolicLink() || !info.isFile() || info.size === 0) throw new Error(`规划文档不是可查阅的普通 Markdown 文件：${path.relative(cwd, target)}`);
	}
	return { paths, technicalPlanPath, implementationPlanPath };
}

function presentation(proposal: Proposal, expanded = false): string {
	const relative = (file?: string) => file ? path.relative(proposal.cwd, file) || "." : "无";
	const documents = proposal.documentStrategy === "none" ? "文档策略：不落盘（方案保存在本次会话，项目里不新增文档）" : `文档策略：${proposal.documentStrategy === "reuse" ? "复用现有文档" : "新建需求文档"}\n技术方案：${relative(proposal.technicalPlanPath)}\n内部实施台账：${relative(proposal.implementationPlanPath)}（由 AI 维护）`;
	return `${documents}\n\n${proposal.body}` + (expanded ? `\n\n维护的规划文档：\n${proposal.paths.map((file) => `• ${relative(file)}`).join("\n") || "方案保存在会话中，无须规划文档。"}\n\n${permission}\n\n工作目录：${proposal.cwd}\n提案记录：${proposal.id}` : "");
}

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
		if (!original || !isDeepStrictEqual(original, entry)) throw new Error("批准记录已变化或未完整落盘");
		return entry;
	});
}

export function installApprovals(pi: ExtensionAPI) {
	let design: Confirmed | undefined;
	let pending: AbortController | undefined;
	let continuation: string | undefined;
	const invalidateDesign = () => { design?.controller.abort(new Error("方案确认已失效，停止后续开发")); design = undefined; continuation = undefined; };
	const invalidate = () => { invalidateDesign(); pending?.abort(new Error("会话发生切换、重载或分支导航，批准请求已失效")); };
	pi.on("session_start", invalidate);
	pi.on("session_shutdown", invalidate);
	pi.on("session_tree", invalidate);
	pi.on("tool_call", (event) => { if (event.toolName !== APPROVAL_TOOL) continuation = undefined; });
	pi.on("agent_settled", (_event, ctx) => {
		const approvalId = continuation;
		continuation = undefined;
		if (!approvalId || design?.approval.id !== approvalId || ctx.mode !== "tui" || !ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		pi.sendMessage({ customType: "delivery-continuation", content: executionInstruction, display: false, details: { stage: "design", approvalId } }, { deliverAs: "followUp", triggerTurn: true });
	});
	pi.registerCommand("delivery-resume", {
		description: "继续当前会话尚未确认的方案审阅，不恢复旧权限或自动开始实施",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("方案审阅需要父 Pi TUI。", "warning"); return; }
			if (pending || !ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("当前仍有任务或消息待处理，请结束后再恢复方案审阅。", "warning"); return; }
			const controller = new AbortController(); pending = controller;
			const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile(), cwd = ctx.cwd;
			const branch = structuredClone(ctx.sessionManager.getBranch());
			try {
				const latest = branch.findLast((row): row is CustomEntry<Proposal> => row.type === "custom" && row.customType === PROPOSAL_ENTRY && (row.data as Proposal)?.stage === "design");
				if (!latest?.data || branch.some((row) => row.type === "custom" && row.customType === APPROVAL_ENTRY && (row.data as Approval)?.proposalId === latest.data!.id)) { ctx.ui.notify("没有可恢复的方案审阅。请重新整理方案并提交 design 提案。", "info"); return; }
				const proposal = structuredClone(latest.data), workspace = await resolveWorkspaceIdentity(cwd), [saved] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]);
				controller.signal.throwIfAborted();
				if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sessionFile || ctx.cwd !== cwd || !isDeepStrictEqual(ctx.sessionManager.getBranch(), branch) || !isDeepStrictEqual(saved.data, proposal) || proposal.workspaceKey !== workspace.key || proposal.sessionId !== sessionId || proposal.cwd !== workspace.cwdPath) throw new Error("方案审阅记录或会话归属已变化");
				if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("当前已有任务或消息待处理");
				pi.sendUserMessage(`继续审阅当前会话的方案。先读取 adaptive-delivery Skill，${proposal.paths.length ? `读取最新方案文件和已有台账（规划文档：${JSON.stringify(proposal.paths)}），` : "本任务没有规划文档，以会话中的方案正文为起点，"}核对已有修改意见及现场，再形成新的 design 审阅提案。以下只是历史提案，不能直接当作当前结论或批准依据。\n\n${proposal.body}\n\n本次只恢复方案审阅，不确认方案或自动进入开发；旧批准仍须重新取得。`, { expandPromptTemplates: false });
			} catch (error) { ctx.ui.notify(`无法恢复方案审阅：${error instanceof Error ? error.message : String(error)}`, "error"); }
			finally { if (pending === controller) pending = undefined; }
		},
	});
	pi.registerEntryRenderer<Proposal>(PROPOSAL_ENTRY, (entry, { expanded }) => new Text(displayText(expanded ? presentation(entry.data!, true) : "方案确认提案已保存"), 0, 0));
	pi.registerTool({
		name: APPROVAL_TOOL, label: "确认方案并开始实施",
		description: "只在父 Pi TUI 请求一次技术方案确认，同时授权本机实施。RPC/JSON/print 不接受批准。内部计划、文件范围、步骤和检查方式由 AI 持续维护，不另设实施确认。普通工具沿用 Pi 权限，不提供文件或网络隔离。",
		parameters,
		execute: async (toolCallId, request, signal, _onUpdate, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("批准只接受父 Pi 的真实 TUI 交互；当前模式不接受批准");
			if (pending) throw new Error("已有批准请求等待处理，不并发显示第二个请求");
			if (request.stage !== "design") throw new Error("只接受方案确认；实施计划由 AI 内部维护，Markdown 编辑无需单独授权");
			invalidateDesign();
			const controller = new AbortController(), operation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal; pending = controller;
			try {
				operation.throwIfAborted();
				const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile(), cwd = ctx.cwd, workspace = await resolveWorkspaceIdentity(cwd);
				if (!request.body.trim() || request.paths.some((value) => !value.trim())) throw new Error("批准正文或路径不能为空白");
				if (request.paths.some((value) => { const relative = path.relative(workspace.workspacePath, path.resolve(workspace.cwdPath, value)); return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); })) throw new Error("批准路径必须在当前 worktree 内");
				const plan = await resolvePlan(request, workspace.cwdPath);
				const proposal: Proposal = { stage: "design", body: request.body, documentStrategy: request.documentStrategy, paths: plan.paths,
					...(plan.technicalPlanPath ? { technicalPlanPath: plan.technicalPlanPath } : {}), ...(plan.implementationPlanPath ? { implementationPlanPath: plan.implementationPlanPath } : {}),
					id: randomUUID(), sessionId, workspaceKey: workspace.key, cwd: workspace.cwdPath };
				const current = () => { operation.throwIfAborted(); if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sessionFile || ctx.cwd !== cwd) throw new Error("确认期间会话、Session 文件或目录已变化"); };
				current(); pi.appendEntry(PROPOSAL_ENTRY, structuredClone(proposal));
				const [displayed] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]);
				if (!isDeepStrictEqual(displayed.data, proposal)) throw new Error("展示正文与持久记录不一致"); current();
				const choice = await ctx.ui.custom<DesignReviewResult>((tui, theme, _keys, done) => {
					const cancel = () => done(undefined); operation.addEventListener("abort", cancel, { once: true }); if (operation.aborted) cancel();
					return Object.assign(new DesignReviewPanel(presentation(proposal), presentation(proposal, true), tui, theme, done, permission, { acceptLabel: action }), { dispose: () => operation.removeEventListener("abort", cancel) });
				});
				current(); const [confirmed] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]); if (!isDeepStrictEqual(confirmed.data, proposal)) throw new Error("确认正文与原展示正文不一致");
				if (typeof choice === "object" && choice.feedback.trim()) return { content: [{ type: "text", text: `用户对本次方案的修改意见：\n${choice.feedback}\n\n尚未确认方案。请修订同一份方案后重新提交 design 提案；不要进入实施或开发。` }], details: { approved: false, proposalId: proposal.id, feedback: choice.feedback } };
				if (choice !== action) return { content: [{ type: "text", text: "方案审阅已暂停，方案正文与已发送意见保留。用户可输入继续看方案、直接提出意见，或用 /delivery-resume 恢复；现在停止推进，不自动重问。" }], details: { approved: false, proposalId: proposal.id, paused: true }, terminate: true };
				const approval: Approval = { id: randomUUID(), proposalId: proposal.id, sessionId, workspaceKey: workspace.key, source: { mode: "tui", interaction: "custom", toolCallId } }; pi.appendEntry(APPROVAL_ENTRY, structuredClone(approval));
				const [saved] = await persisted<Approval>(ctx, [APPROVAL_ENTRY, approval.id]); if (!isDeepStrictEqual(saved.data, approval)) throw new Error("确认记录与持久记录不一致"); current();
				design = { approval, proposal, sessionFile: sessionFile!, controller: new AbortController() }; continuation = approval.id;
				return { content: [{ type: "text", text: executionInstruction }], details: { approved: true, approvalId: approval.id, proposalId: proposal.id, sessionFile } };
			} finally { pending = undefined; }
		},
	});
	return {
		get pending() { return pending !== undefined; },
		get confirmedStage() { return design ? "design" as const : undefined; },
		async readApproval(ctx: ExtensionContext, signal?: AbortSignal) {
			const expected = design;
			try {
				if (!expected) throw new Error("本轮没有可核实的方案实施授权"); const cwd = ctx.cwd;
				const current = () => { signal?.throwIfAborted(); if (design !== expected) throw new Error("方案授权已失效或被新的请求替换"); if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("方案授权只供原父 TUI 会话核实"); if (ctx.sessionManager.getSessionId() !== expected.approval.sessionId || ctx.sessionManager.getSessionFile() !== expected.sessionFile || ctx.cwd !== cwd) throw new Error("方案授权的 Session、文件或当前目录已变化"); };
				current(); const workspace = await resolveWorkspaceIdentity(cwd); current(); if (workspace.key !== expected.approval.workspaceKey) throw new Error("方案授权不属于当前 worktree");
				const [approval, proposal] = await persisted<Approval | Proposal>(ctx, [APPROVAL_ENTRY, expected.approval.id], [PROPOSAL_ENTRY, expected.proposal.id]); current();
				if (!isDeepStrictEqual(approval.data, expected.approval) || !isDeepStrictEqual(proposal.data, expected.proposal)) throw new Error("方案授权与本轮真实确认的正文或来源不一致");
				return { approvalId: expected.approval.id, proposalId: expected.proposal.id, designBody: expected.proposal.body, documentStrategy: expected.proposal.documentStrategy, technicalPlanPath: expected.proposal.technicalPlanPath, implementationPlanPath: expected.proposal.implementationPlanPath, planningPaths: [...expected.proposal.paths], sessionId: expected.approval.sessionId, workspace, signal: expected.controller.signal };
			} catch (error) { if (design === expected) invalidateDesign(); throw error; }
		},
	};
}
