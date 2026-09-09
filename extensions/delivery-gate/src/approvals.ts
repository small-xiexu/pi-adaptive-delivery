import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { resolveWorkspaceIdentity } from "./workspace.ts";
import { resolveContainerImage } from "./container.ts";
import { DeliveryPanel, displayText } from "./ui.ts";

export const APPROVAL_TOOL = "delivery_approval";
export const PROPOSAL_ENTRY = "delivery-approval-proposal";
export const APPROVAL_ENTRY = "delivery-approval";

const parameters = Type.Object({
	stage: StringEnum(["documents", "design", "implementation"] as const),
	body: Type.String({ minLength: 1, description: "本阶段完整决策正文，用简短分行说明，不复制全文台账。documents 按相对路径逐行说明用途；design 说明目标、范围、关键风险和验收方向；implementation 说明计划修改的文件、步骤、环境、验收和停止条件，并区分计划文件与工具实际可写目录。工具提供原方案查看入口，无须重复抄写；不以路径或摘要 ID 代替决策内容。" }),
	paths: Type.Array(Type.String({ minLength: 1 }), { description: "documents 为确切 Markdown 路径；design 为空；implementation 为允许修改的文件或目录。路径按 cwd 解析，不是 glob。" }),
	validationCommands: Type.Array(Type.String({ minLength: 1 }), { description: "implementation 的固定本地验收命令；其他阶段为空。本工具不执行命令。" }),
	container: Type.Optional(Type.Object({
		image: Type.String({ minLength: 1, description: "已准备且不含凭据的本地 Linux 镜像，确认时解析并固定到镜像 ID；不拉取。容器命令使用 /bin/sh，不继承宿主 Shell。" }),
		inputs: Type.Array(Type.String({ minLength: 1 }), { description: "额外只读输入文件/目录，必须在 worktree 内且不含凭据；不挂整个工作区、规划文档、Git 或执行记录。可写挂载沿用 paths。" }),
	}, { additionalProperties: false })),
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
	container?: { image: string; inputs: string[] };
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

const titles = { documents: "规划文档编辑授权", design: "方案确认", implementation: "实施确认" };
const actions = { documents: "授权文档编辑", design: "确认方案", implementation: "确认实施" };
const permissions = {
	documents: "仅授权列明的 Markdown 文档编辑，不包含源码修改或实施批准。",
	design: "只确认方案；已有文档授权范围内可编制计划，不包含实施批准。",
	implementation: "仅授权列明范围内的本地开发、自检、验证、审查与返工。提交、推送、PR、发布、部署、生产及其他外部写入不在本次授权内。",
};

function presentation(proposal: Proposal, expanded = false): string {
	const relative = (file: string) => path.relative(proposal.cwd, file) || ".";
	const body = expanded || proposal.body.length <= 600 ? proposal.body : `${proposal.body.slice(0, 600)}\n…完整正文见详情`;
	return `${titles[proposal.stage]}\n工作目录：${proposal.cwd}\n\n${body}\n\n${permissions[proposal.stage]}`
		+ (proposal.paths.length ? `\n\n${proposal.stage === "documents" ? "可编辑文档" : "工具实际可写范围（文件或目录）"}：\n${proposal.paths.map((file) => `• ${relative(file)}`).join("\n")}` : "")
		+ (proposal.container ? `\n\n运行环境：本地 Docker · 禁网 · 1 GiB · 每命令最多 300 秒`
			+ (expanded ? `\n固定镜像：${proposal.container.image}\n额外只读输入：\n${proposal.container.inputs.map((file) => `• ${relative(file)}`).join("\n") || "无"}\n容器 /bin/sh，不继承宿主 Shell；可写挂载沿用上述范围。` : `\n${proposal.container.inputs.length} 项只读输入，${proposal.validationCommands.length} 条固定验收命令（详情可核对）`)
			: proposal.stage === "implementation" ? "\n本次不授权容器命令。" : "")
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
	let documents: Confirmed | undefined;
	let implementation: Confirmed | undefined;
	let pending: AbortController | undefined;
	const invalidateDocuments = () => {
		const previous = documents;
		documents = undefined;
		previous?.controller.abort(new Error("文档授权已失效，停止后续写入"));
	};
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
		invalidateDocuments();
		pending?.abort(new Error("会话发生切换、重载或分支导航，批准请求已失效"));
	};
	pi.on("session_start", invalidate);
	pi.on("session_shutdown", invalidate);
	pi.on("session_tree", invalidate);
	pi.registerEntryRenderer<Proposal>(PROPOSAL_ENTRY, (entry, { expanded }) => new Text(displayText(expanded ? presentation(entry.data!, true)
		: `${titles[entry.data!.stage]} · ${entry.data!.paths.length ? `${entry.data!.paths.length} 项路径 · ` : ""}Ctrl+O 查看完整提案`), 0, 0));
	pi.registerTool({
		name: APPROVAL_TOOL, label: "请求交付批准",
		description: "在父 Pi 的真实 TUI 中请求规划文档编辑授权、方案确认或实施确认。只在用户已准备确认时调用；两次阶段确认分开。模型提供的字段不是批准，RPC/JSON/print 不接受批准。实施可明确申请本地 Docker 镜像与只读输入，不授予宿主 Shell。",
		parameters,
		execute: async (toolCallId, request, signal, _onUpdate, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("批准只接受父 Pi 的真实 TUI 交互；当前模式不接受批准");
			if (pending) throw new Error("已有批准请求等待处理，不并发显示第二个请求");
			if (request.stage === "documents") invalidateDocuments();
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
				const inputs = request.container?.inputs.map((value) => path.resolve(workspace.cwdPath, value)) ?? [];
				if (!request.body.trim() || [...request.paths, ...(request.container?.inputs ?? [])].some((value) => !value.trim()) || request.validationCommands.some((value) => !value.trim())) {
					throw new Error("批准正文、路径或验收命令不能为空白");
				}
				if ([...paths, ...inputs].some((value) => { const relative = path.relative(workspace.workspacePath, value); return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); })) {
					throw new Error("批准路径必须在当前 worktree 内");
				}
				if (request.stage === "design" ? paths.length > 0 : paths.length === 0) throw new Error("方案确认不授予路径权限；文档与实施授权必须列明路径");
				if (request.stage === "documents" && paths.some((value) => path.extname(value).toLowerCase() !== ".md")) throw new Error("规划文档授权只接受确切 Markdown 路径");
				if (request.stage !== "implementation" && request.validationCommands.length) throw new Error("本阶段不授予命令执行权限");
				if (request.stage !== "implementation" && request.container) throw new Error("只有实施阶段可请求容器命令授权");
				const expectedDesign = request.stage === "implementation" ? design : undefined;
				let approvedDesign: Proposal | undefined;
				if (request.stage === "implementation") {
					if (!expectedDesign || expectedDesign.approval.sessionId !== sessionId || expectedDesign.approval.workspaceKey !== workspace.key
						|| expectedDesign.sessionFile !== sessionFile) throw new Error("当前会话与工作区尚无可信方案确认，不能请求实施确认");
					const [entry, body] = await persisted<Approval | Proposal>(ctx, [APPROVAL_ENTRY, expectedDesign.approval.id], [PROPOSAL_ENTRY, expectedDesign.proposal.id]);
					if (!isDeepStrictEqual(entry.data, expectedDesign.approval) || !isDeepStrictEqual(body.data, expectedDesign.proposal)) throw new Error("方案批准记录已变化");
					approvedDesign = expectedDesign.proposal;
				}
				const container = request.container ? { image: await resolveContainerImage(request.container.image, workspace.workspacePath), inputs } : undefined;
				const proposal: Proposal = { id: randomUUID(), sessionId, workspaceKey: workspace.key, cwd: workspace.cwdPath,
					stage: request.stage, body: request.body, paths, validationCommands: [...request.validationCommands],
					...(approvedDesign ? { designApprovalId: expectedDesign!.approval.id } : {}), ...(container ? { container } : {}) };
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
				const choice = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
					const cancel = () => done(undefined);
					operation.addEventListener("abort", cancel, { once: true });
					if (operation.aborted) cancel();
					const panel = new DeliveryPanel(titles[request.stage], presentation(proposal),
						presentation(proposal, true) + (approvedDesign ? `\n\n已确认的方案原文：\n${presentation(approvedDesign, true)}` : ""),
						[accept, "暂不批准"], tui, theme, done, 1);
					return Object.assign(panel, { dispose: () => operation.removeEventListener("abort", cancel) });
				}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
				current();
				if (choice !== accept) return { content: [{ type: "text", text: "本次未批准，权限未扩大；暂停推进，不自动重复请求批准。" }], details: { approved: false }, terminate: true };
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
				if (proposal.stage === "documents") documents = live;
				if (proposal.stage === "implementation") implementation = live;
				return { content: [{ type: "text", text: `${titles[request.stage]}已记录。${request.stage === "documents" ? "后续回合可使用专用文档工具，每次写入仍须核验本轮授权、路径和父 writer。"
					: request.stage === "implementation" ? `用户未要求暂停且没有未决问题时，继续在本轮文档边界和 writer 交接下委派开发，无须额外的“继续”；${container ? "仅按已确认镜像和挂载执行容器命令；固定验收使用本次命令清单。" : "本次不授权容器命令，固定验收不可用。"}独立审查仍需当前候选的可信验收，不开放宿主 Shell。` : "用户未要求暂停且没有未决问题时，继续在已有文档授权内编制实施计划；本次不扩大操作范围，实施仍须独立确认。"}` }],
					details: { approved: true, approvalId: approval.id, proposalId: proposal.id, sessionFile: ctx.sessionManager.getSessionFile() } };
			} finally {
				pending = undefined;
			}
		},
	});
	async function readCurrent(stage: "documents" | "implementation", ctx: ExtensionContext, signal?: AbortSignal) {
		const expected = stage === "documents" ? documents : implementation;
		const expectedDesign = stage === "implementation" ? design : undefined;
		const label = stage === "documents" ? "文档授权" : "实施授权";
		try {
			if (!expected) throw new Error(`本轮没有可核实的${stage === "documents" ? "规划文档授权" : "实施授权"}`);
			const cwd = ctx.cwd;
			const current = () => {
				signal?.throwIfAborted();
				if ((stage === "documents" ? documents : implementation) !== expected) throw new Error(`${label}已失效或被新的请求替换`);
				if (stage === "implementation" && (!expectedDesign || design !== expectedDesign
					|| expected.proposal.designApprovalId !== expectedDesign.approval.id)) throw new Error("实施授权依赖的方案确认已失效");
				if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error(`${label}只供原父 TUI 会话核实`);
				if (ctx.sessionManager.getSessionId() !== expected.approval.sessionId
					|| ctx.sessionManager.getSessionFile() !== expected.sessionFile || ctx.cwd !== cwd) {
					throw new Error(`${label}的 Session、文件或当前目录已变化`);
				}
			};
			current();
			const workspace = await resolveWorkspaceIdentity(cwd);
			current();
			if (workspace.key !== expected.approval.workspaceKey) throw new Error(`${label}不属于当前 worktree`);
			const confirmations = expectedDesign ? [expected, expectedDesign] : [expected];
			const references: [string, string][] = confirmations.flatMap((item) => [[APPROVAL_ENTRY, item.approval.id], [PROPOSAL_ENTRY, item.proposal.id]] as [string, string][]);
			const entries = await persisted<Approval | Proposal>(ctx, ...references);
			current();
			if (confirmations.some((item, index) => !isDeepStrictEqual(entries[index * 2]!.data, item.approval)
				|| !isDeepStrictEqual(entries[index * 2 + 1]!.data, item.proposal))) {
				throw new Error(`${label}与本轮真实确认的正文或来源不一致`);
			}
			return { expected, expectedDesign, workspace };
		} catch (error) {
			if (stage === "documents" && documents === expected) invalidateDocuments();
			if (stage === "implementation" && implementation === expected) invalidateImplementation();
			throw error;
		}
	}
	return {
		// 只核实批准依据，不授予 writer；执行方不能把返回快照缓存为持续有效的权限。
		async readDocumentApproval(ctx: ExtensionContext, signal?: AbortSignal) {
			const { expected, workspace } = await readCurrent("documents", ctx, signal);
			return { approvalId: expected.approval.id, proposalId: expected.proposal.id,
				sessionId: expected.approval.sessionId, workspace, paths: [...expected.proposal.paths], signal: expected.controller.signal };
		},
		async readImplementationApproval(ctx: ExtensionContext, signal?: AbortSignal) {
			const { expected, expectedDesign, workspace } = await readCurrent("implementation", ctx, signal);
			return { approvalId: expected.approval.id, proposalId: expected.proposal.id, designApprovalId: expectedDesign!.approval.id,
				designBody: expectedDesign!.proposal.body, implementationBody: expected.proposal.body,
				sessionId: expected.approval.sessionId, workspace, paths: [...expected.proposal.paths],
				validationCommands: [...expected.proposal.validationCommands], signal: expected.controller.signal,
				...(expected.proposal.container ? { container: structuredClone(expected.proposal.container) } : {}) };
		},
	};
}
