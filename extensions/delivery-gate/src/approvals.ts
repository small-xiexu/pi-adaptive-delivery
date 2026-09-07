import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { resolveWorkspaceIdentity } from "./workspace.ts";

export const APPROVAL_TOOL = "delivery_approval";
export const PROPOSAL_ENTRY = "delivery-approval-proposal";
export const APPROVAL_ENTRY = "delivery-approval";

const parameters = Type.Object({
	stage: StringEnum(["documents", "design", "implementation"] as const),
	body: Type.String({ minLength: 1, description: "本任务待确认的完整正文，不是全文台账或摘要 ID。实施阶段应包含计划、验证方式与停止条件。" }),
	paths: Type.Array(Type.String({ minLength: 1 }), { description: "documents 为确切 Markdown 路径；design 为空；implementation 为允许修改的文件或目录。路径按 cwd 解析，不是 glob。" }),
	validationCommands: Type.Array(Type.String({ minLength: 1 }), { description: "implementation 的固定本地验收命令；其他阶段为空。本工具不执行命令。" }),
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
}
interface Approval {
	id: string;
	proposalId: string;
	sessionId: string;
	workspaceKey: string;
	source: { mode: "tui"; interaction: "select"; toolCallId: string };
}

const titles = { documents: "规划文档编辑授权", design: "方案确认", implementation: "实施确认" };
const permissions = {
	documents: "仅授权列明的 Markdown 文档编辑，不包含源码修改或实施批准。",
	design: "只确认方案；已有文档授权范围内可编制计划，不包含实施批准。",
	implementation: "仅授权列明范围内的本地开发、自检、验证、审查与返工。提交、推送、PR、发布、部署、生产及其他外部写入不在本次授权内。",
};

function presentation(proposal: Proposal): string {
	return `${titles[proposal.stage]} [${proposal.id}]\n工作目录：${JSON.stringify(proposal.cwd)}\n\n${proposal.body}\n\n`
		+ `操作边界：${permissions[proposal.stage]}\n路径：${JSON.stringify(proposal.paths)}\n验收命令：${JSON.stringify(proposal.validationCommands)}`
		+ (proposal.designApprovalId ? `\n方案批准引用：${proposal.designApprovalId}` : "")
		+ "\n当前版本仅记录批准，所有文件写入仍关闭。";
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
	let design: Approval | undefined;
	let documents: { approval: Approval; proposal: Proposal; sessionFile: string; controller: AbortController } | undefined;
	let pending: AbortController | undefined;
	const invalidateDocuments = () => {
		const previous = documents;
		documents = undefined;
		previous?.controller.abort(new Error("文档授权已失效，停止后续写入"));
	};
	const invalidate = () => {
		design = undefined;
		invalidateDocuments();
		pending?.abort(new Error("会话发生切换、重载或分支导航，批准请求已失效"));
	};
	pi.on("session_start", invalidate);
	pi.on("session_shutdown", invalidate);
	pi.on("session_tree", invalidate);
	pi.registerEntryRenderer<Proposal>(PROPOSAL_ENTRY, (entry) => new Text(presentation(entry.data!), 0, 0));
	pi.registerTool({
		name: APPROVAL_TOOL, label: "请求交付批准",
		description: "在父 Pi 的真实 TUI 中请求规划文档编辑授权、方案确认或实施确认。只在用户已准备确认时调用；两次阶段确认分开。模型提供的正文和字段不是批准，RPC/JSON/print 不接受批准。当前只记录原生 Session 证据，不开放文件写入。",
		parameters,
		execute: async (toolCallId, request, signal, _onUpdate, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("批准只接受父 Pi 的真实 TUI 交互；当前模式不接受批准");
			if (pending) throw new Error("已有批准请求等待处理，不并发显示第二个请求");
			if (request.stage === "documents") invalidateDocuments();
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
				if (!request.body.trim() || request.paths.some((value) => !value.trim()) || request.validationCommands.some((value) => !value.trim())) {
					throw new Error("批准正文、路径或验收命令不能为空白");
				}
				if (paths.some((value) => { const relative = path.relative(workspace.workspacePath, value); return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); })) {
					throw new Error("批准路径必须在当前 worktree 内");
				}
				if (request.stage === "design" ? paths.length > 0 : paths.length === 0) throw new Error("方案确认不授予路径权限；文档与实施授权必须列明路径");
				if (request.stage === "documents" && paths.some((value) => path.extname(value).toLowerCase() !== ".md")) throw new Error("规划文档授权只接受确切 Markdown 路径");
				if (request.stage !== "implementation" && request.validationCommands.length) throw new Error("本阶段不授予命令执行权限");
				let approvedDesign: Proposal | undefined;
				if (request.stage === "implementation") {
					if (!design || design.sessionId !== sessionId || design.workspaceKey !== workspace.key) throw new Error("当前会话与工作区尚无可信方案确认，不能请求实施确认");
					const [entry] = await persisted<Approval>(ctx, [APPROVAL_ENTRY, design.id]);
					if (!isDeepStrictEqual(entry.data, design)) throw new Error("方案批准记录已变化");
					approvedDesign = (await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, design.proposalId]))[0]!.data;
					if (!approvedDesign || approvedDesign.stage !== "design" || approvedDesign.sessionId !== sessionId || approvedDesign.workspaceKey !== workspace.key) throw new Error("方案批准正文归属不符");
				}
				const proposal: Proposal = { id: randomUUID(), sessionId, workspaceKey: workspace.key, cwd: workspace.cwdPath,
					stage: request.stage, body: request.body, paths, validationCommands: [...request.validationCommands],
					...(approvedDesign ? { designApprovalId: design!.id } : {}) };
				const current = () => {
					operation.throwIfAborted();
					if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sessionFile || ctx.cwd !== cwd) {
						throw new Error("确认期间会话、Session 文件或目录已变化");
					}
				};
				current();
				// 实施确认重新展示已批准的方案正文；不用活动文档内容替换原批准依据。
				if (approvedDesign) ctx.ui.notify(presentation(approvedDesign), "info");
				pi.appendEntry(PROPOSAL_ENTRY, structuredClone(proposal));
				const [displayed] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]);
				if (!isDeepStrictEqual(displayed.data, proposal)) throw new Error("展示正文与持久记录不一致");
				current();
				const accept = `确认${titles[request.stage]}`;
				const choice = await ctx.ui.select(`${titles[request.stage]} [${proposal.id}]`, ["暂不批准", accept], { signal: operation });
				current();
				if (choice !== accept) return { content: [{ type: "text", text: "本次未批准，权限未扩大；暂停推进，不自动重复请求批准。" }], details: { approved: false }, terminate: true };
				// 用户等待期间正文可能被外部改动；确认的是刚才展示的正文，不是后来替换的文件。
				const [confirmed] = await persisted<Proposal>(ctx, [PROPOSAL_ENTRY, proposal.id]);
				if (!isDeepStrictEqual(confirmed.data, proposal)) throw new Error("确认正文与原展示正文不一致");
				if (approvedDesign) {
					await persisted(ctx, [APPROVAL_ENTRY, proposal.designApprovalId!], [PROPOSAL_ENTRY, approvedDesign.id]);
				}
				current();
				const approval: Approval = { id: randomUUID(), proposalId: proposal.id, sessionId, workspaceKey: workspace.key,
					source: { mode: "tui", interaction: "select", toolCallId } };
				pi.appendEntry(APPROVAL_ENTRY, structuredClone(approval));
				const [saved] = await persisted<Approval>(ctx, [APPROVAL_ENTRY, approval.id]);
				if (!isDeepStrictEqual(saved.data, approval)) throw new Error("确认记录与持久记录不一致");
				current();
				if (proposal.stage === "design") design = approval;
				if (proposal.stage === "documents") documents = { approval, proposal, sessionFile: sessionFile!, controller: new AbortController() };
				return { content: [{ type: "text", text: `${titles[request.stage]}已记录。当前版本仍不开放文件写入。` }],
					details: { approved: true, approvalId: approval.id, proposalId: proposal.id, sessionFile: ctx.sessionManager.getSessionFile() } };
			} finally {
				pending = undefined;
			}
		},
	});
	return {
		// 只核实批准依据，不授予 writer；执行方不能把返回快照缓存为持续有效的权限。
		async readDocumentApproval(ctx: ExtensionContext, signal?: AbortSignal) {
			const expected = documents;
			try {
				if (!expected) throw new Error("本轮没有可核实的规划文档授权");
				const cwd = ctx.cwd;
				const current = () => {
					signal?.throwIfAborted();
					if (documents !== expected) throw new Error("文档授权已失效或被新的请求替换");
					if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("文档授权只供原父 TUI 会话核实");
					if (ctx.sessionManager.getSessionId() !== expected.approval.sessionId
						|| ctx.sessionManager.getSessionFile() !== expected.sessionFile || ctx.cwd !== cwd) {
						throw new Error("文档授权的 Session、文件或当前目录已变化");
					}
				};
				current();
				const workspace = await resolveWorkspaceIdentity(cwd);
				current();
				if (workspace.key !== expected.approval.workspaceKey) throw new Error("文档授权不属于当前 worktree");
				const [approval, proposal] = await persisted<Approval | Proposal>(ctx,
					[APPROVAL_ENTRY, expected.approval.id], [PROPOSAL_ENTRY, expected.proposal.id]);
				current();
				if (!isDeepStrictEqual(approval.data, expected.approval) || !isDeepStrictEqual(proposal.data, expected.proposal)) {
					throw new Error("文档授权与本轮真实确认的正文或来源不一致");
				}
				return { approvalId: expected.approval.id, proposalId: expected.proposal.id,
					sessionId: expected.approval.sessionId, workspace, paths: [...expected.proposal.paths], signal: expected.controller.signal };
			} catch (error) {
				if (documents === expected) invalidateDocuments();
				throw error;
			}
		},
	};
}
