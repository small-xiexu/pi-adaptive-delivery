import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, EditToolInput, ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition, ToolRenderResultOptions, WriteToolInput } from "@earendil-works/pi-coding-agent";
import { createPlanningDocumentTools } from "./planning-documents.ts";
import path from "node:path";
import { getWriterStateRoot, resolveWorkspaceIdentity, type WriterLeaseOwner, type WriterLeaseRecord, type WriterLeaseReference, WriterLeaseManager, type WorkspaceIdentity } from "./workspace.ts";

export const DOCUMENT_EDIT_TOOL = "delivery_document_edit";
export const DOCUMENT_WRITE_TOOL = "delivery_document_write";

type DocumentRenderArgs = { path?: string; file_path?: string; content?: string; edits?: unknown[] };

function documentPath(args: DocumentRenderArgs | undefined, cwd?: string): string {
	const value = args?.file_path ?? args?.path;
	if (typeof value !== "string" || !value.trim()) return "未指定路径";
	if (cwd && path.isAbsolute(value)) {
		const relative = path.relative(cwd, value);
		if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	}
	return value;
}

function documentSummary(args: DocumentRenderArgs | undefined, cwd?: string): string {
	if (Array.isArray(args?.edits)) return `编辑规划文档 · ${documentPath(args, cwd)} · ${args.edits.length} 处变更`;
	return `写入规划文档 · ${documentPath(args, cwd)}`;
}

export const documentRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		return new Text(theme.fg("toolTitle", theme.bold(documentSummary(args as DocumentRenderArgs, context.cwd))), 0, 0);
	},
	renderResult(result, _options: ToolRenderResultOptions, theme, context) {
		const args = context.args as DocumentRenderArgs | undefined;
		if (context.isError || result.isError) {
			const message = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ").trim();
			return new Text(theme.fg("error", `规划文档更新失败：${message || "未取得错误详情"}`), 0, 0);
		}
		const action = Array.isArray(args?.edits) ? "已更新规划文档" : "已写入规划文档";
		return new Text(theme.fg("toolOutput", `${action}：${documentPath(args, context.cwd)}`), 0, 0);
	},
};

export interface SessionBinding {
	cwd: string;
	sessionId: string;
	sessionFile: string;
	lifetime: AbortController;
}

interface DocumentRun extends SessionBinding {
	workspace?: WorkspaceIdentity;
	id: string;
	name: string;
	io: AbortController;
	run?: Promise<AgentToolResult<unknown>>;
	attemptedLease: boolean;
	finished: boolean;
	terminalVerified?: boolean;
	fault?: string;
	call?: SessionEntry;
	lease?: WriterLeaseReference;
	owner?: WriterLeaseOwner;
	leases?: WriterLeaseManager;
	tools?: ReturnType<typeof createPlanningDocumentTools>;
	result?: { content: AgentToolResult<unknown>["content"]; details?: unknown; isError: boolean };
}

// 原生 JSONL 会省略 undefined 字段；私有快照同样按 JSON 表示隔离，不能共享原生可变引用。
export function snapshot<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

export function current(state: SessionBinding, ctx: ExtensionContext): void {
	state.lifetime.signal.throwIfAborted();
	if (ctx.cwd !== state.cwd || ctx.sessionManager.getSessionId() !== state.sessionId
		|| ctx.sessionManager.getSessionFile() !== state.sessionFile) throw new Error("父 writer 的 Session、文件或目录已变化");
}

export async function nativeEntries(state: SessionBinding, ctx: ExtensionContext) {
	current(state, ctx);
	const content = await readFile(state.sessionFile, "utf8");
	current(state, ctx);
	if (!content.endsWith("\n")) throw new Error("原生 Session 记录不完整，不能交接 writer");
	const [header, ...entries] = content.trimEnd().split("\n").map((line) => JSON.parse(line));
	if (header?.type !== "session" || header.id !== state.sessionId) throw new Error("原生 Session 文件归属不符");
	const branch = snapshot(ctx.sessionManager.getBranch());
	current(state, ctx);
	const requireEntry = (entry: SessionEntry) => {
		const disk = entries.filter((row) => row.id === entry.id);
		if (disk.length !== 1 || !isDeepStrictEqual(disk[0], entry)
			|| !branch.some((row) => isDeepStrictEqual(row, entry))) throw new Error("原生执行记录未唯一落盘、已变化或不在当前分支");
	};
	return { entries: entries as SessionEntry[], branch, requireEntry };
}

// 仅协调本轮父文档操作；不注册工具、不授予批准、不从旧记录恢复 writer，也不管理外部进程。
export function createParentDocumentWriter(pi: ExtensionAPI, recoverResidual?: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<void>) {
	let starting = false;
	let active: DocumentRun | undefined;
	let stopped = false;
	let finishing: Promise<void> | undefined;
	let shutdownSettled: (() => void) | undefined;

	async function execute(kind: "edit" | "write", id: string, input: EditToolInput | WriteToolInput,
		signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
		if (stopped || starting || (active && (!active.fault || !recoverResidual))) throw new Error("父文档 writer 尚未完成终态核验或已关闭，未开始新的写入");
		starting = true;
		try { return await executeStarted(kind, id, input, signal, ctx); }
		finally { starting = false; }
	}

	async function executeStarted(kind: "edit" | "write", id: string, input: EditToolInput | WriteToolInput,
		signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
		if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("默认 Markdown 编辑只供父 Pi TUI 使用");
		signal?.throwIfAborted();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("没有持久 Session，未取得父 writer");
		const state: DocumentRun = { id, name: kind === "edit" ? DOCUMENT_EDIT_TOOL : DOCUMENT_WRITE_TOOL,
			cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionFile, lifetime: new AbortController(),
			io: new AbortController(), attemptedLease: false, finished: false };
		const workspace = state.workspace = await resolveWorkspaceIdentity(ctx.cwd);
		const target = path.resolve(workspace.cwdPath, input.path.startsWith("@") ? input.path.slice(1) : input.path);
		const before = await nativeEntries(state, ctx);
		const call = before.branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!call || call.type !== "message" || call.message.role !== "assistant"
			|| call.message.content.filter((part) => part.type === "toolCall" && part.id === id && part.name === state.name
				&& isDeepStrictEqual(snapshot(part.arguments), snapshot(input))).length !== 1) throw new Error("未找到当前文档操作的原生工具调用");
		before.requireEntry(call);
		if (before.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id)) throw new Error("文档工具调用已有结果，不能重放取得 writer");
		await recoverResidual?.(ctx, signal);
		current(state, ctx);
		signal?.throwIfAborted();
		if (stopped || active) throw new Error("父文档 writer 尚未完成终态核验或已关闭，未开始新的写入");
		active = state;
		const operation = AbortSignal.any([state.io.signal, state.lifetime.signal, ...(signal ? [signal] : [])]);
		state.run = Promise.resolve().then(async () => {
			try {
				state.call = call;
				const stateRoot = await getWriterStateRoot(workspace);
				state.leases = new WriterLeaseManager(stateRoot);
				current(state, ctx);
				operation.throwIfAborted();
				state.attemptedLease = true;
				const acquired = await state.leases.acquire(workspace, { kind: "parent", sessionId: state.sessionId, pid: process.pid, runId: id });
				if (!acquired.ok) { state.attemptedLease = false; throw new Error(acquired.reason); }
				state.lease = { ...acquired.reference };
				state.owner = { ...acquired.record.owner };
				state.tools = createPlanningDocumentTools({ workspace, paths: [target], signal: operation, lease: state.lease, leases: state.leases, owner: state.owner,
					authorize: async () => {
						current(state, ctx);
						if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("默认 Markdown 编辑只供父 Pi TUI 使用");
						const records = await nativeEntries(state, ctx);
						records.requireEntry(state.call!);
					} }, [path.dirname(stateRoot), sessionFile]);
				const result = kind === "edit" ? await state.tools.edit(id, input as EditToolInput, operation)
					: await state.tools.write(id, input as WriteToolInput, operation);
				state.result = snapshot({ content: result.content, details: result.details, isError: false });
				return result;
			} catch (error) {
				state.result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
				throw error;
			} finally {
				state.finished = true;
				if (!state.attemptedLease && active === state) active = undefined;
			}
		});
		return state.run;
	}

	async function verifyResult(state: DocumentRun, ctx: ExtensionContext): Promise<void> {
		if (state.tools?.cleanupFailed) throw new Error("文档句柄清理失败");
		const records = await nativeEntries(state, ctx);
		records.requireEntry(state.call!);
		const results = records.entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === state.id);
		const result = results[0];
		if (results.length !== 1 || !result || result.type !== "message" || result.message.role !== "toolResult"
			|| result.message.toolName !== state.name || !isDeepStrictEqual(snapshot({ content: result.message.content,
				details: result.message.details, isError: result.message.isError }), state.result)) throw new Error("文档工具终态未唯一落盘或与实际执行不符");
		records.requireEntry(result);
		if (records.branch.findIndex((entry) => entry.id === result.id) <= records.branch.findIndex((entry) => entry.id === state.call!.id)) throw new Error("文档工具终态不在本次调用之后");
		current(state, ctx);
	}

	async function finish(ctx: ExtensionContext): Promise<void> {
		const state = active;
		if (!state || !state.finished || state.fault) return;
		try {
			if (!state.lease || !state.owner || !state.leases || !state.call || !state.result) throw new Error("父 writer 获取或执行状态不明");
			if (state.tools?.cleanupFailed) throw new Error("文档句柄清理失败");
			const verify = async () => {
				await verifyResult(state, ctx);
				state.terminalVerified = true;
			};
			await state.leases.releaseParent(state.lease, state.owner, verify, state.lifetime.signal);
			if (active === state) active = undefined;
		} catch (error) {
			state.fault = String(error);
			ctx.ui.notify(`父 writer 未交回，保持关闭：${state.fault}`, "error");
		}
	}

	const settle = async (_event: unknown, ctx: ExtensionContext) => {
		if (finishing) return finishing;
		finishing = finish(ctx);
		try { await finishing; } finally { finishing = undefined; }
	};
	pi.on("turn_end", settle);
	// 原生持久化失败时可能没有 turn_end；最终停止时仍要核验并明确关闭，不能把事件当成功。
	pi.on("agent_settled", async (event, ctx) => {
		try { await settle(event, ctx); } finally { shutdownSettled?.(); }
	});
	const preventSwitch = () => active ? { cancel: true } : undefined;
	pi.on("session_before_switch", preventSwitch);
	pi.on("session_before_fork", preventSwitch);
	pi.on("session_before_tree", preventSwitch);
	const invalidate = () => { active?.lifetime.abort(new Error("父 writer 的会话生命周期已变化")); };
	pi.on("session_start", invalidate);
	pi.on("session_tree", invalidate);
	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		const state = active;
		if (!state) return;
		// 先取消 I/O，原生终态仍可在会话关闭前核实并交回 writer。
		state.io.abort(new Error("父会话正在关闭或重载，停止文档操作"));
		const settled = !ctx.isIdle() ? new Promise<void>((resolve) => { shutdownSettled = resolve; }) : undefined;
		if (settled) ctx.abort();
		await Promise.allSettled([state.run, finishing, settled]);
		shutdownSettled = undefined;
		state.lifetime.abort(new Error("父会话正在关闭或重载"));
		if (active) ctx.ui.notify("父文档操作已停止；终态交接未完成，保持关闭，不自动恢复。", "warning");
	});
	return {
		get pending() { return active !== undefined; },
		// 只接受本实例已核验的终态；恢复前重新读取原生结果和完整归属。
		async verifyRecovery(ctx: ExtensionContext, workspace: WorkspaceIdentity, record?: WriterLeaseRecord) {
			const state = active;
			if (stopped || !state?.finished || !state.fault || !state.terminalVerified || !state.lease
				|| !isDeepStrictEqual(state.workspace, workspace) || state.lease.workspaceKey !== workspace.key
				|| (record && (state.lease.leaseId !== record.leaseId || !isDeepStrictEqual(record.workspace, workspace)
					|| !isDeepStrictEqual(record.owner, state.owner) || record.coordinator !== undefined))) {
				throw new Error("上次文档操作的结束状态与当前占用记录不一致，暂未清理。");
			}
			await verifyResult(state, ctx);
			if (active !== state) throw new Error("恢复期间文档运行态已变化，未清理。");
			return { runId: state.id, leaseId: state.lease.leaseId };
		},
		reconcileAfterUnlock(workspaceKey: string, leaseId: string): void {
			if (!active?.finished || !active.fault || !active.terminalVerified || active.lease?.workspaceKey !== workspaceKey || active.lease.leaseId !== leaseId) throw new Error("文档运行态已变化，未复位。");
			active = undefined;
		},
		// 已结束且未自动收尾的失败是终态记录，不是仍在途的写入。
		get fault() { return active?.fault; },
		edit: (id: string, input: EditToolInput, signal: AbortSignal | undefined, ctx: ExtensionContext) => execute("edit", id, input, signal, ctx),
		write: (id: string, input: WriteToolInput, signal: AbortSignal | undefined, ctx: ExtensionContext) => execute("write", id, input, signal, ctx),
	};
}
