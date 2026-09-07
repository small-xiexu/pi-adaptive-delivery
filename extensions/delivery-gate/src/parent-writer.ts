import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { AgentToolResult, EditToolInput, ExtensionAPI, ExtensionContext, SessionEntry, WriteToolInput } from "@earendil-works/pi-coding-agent";
import type { installApprovals } from "./approvals.ts";
import { createPlanningDocumentTools } from "./planning-documents.ts";
import path from "node:path";
import { getWriterStateRoot, type WriterLeaseOwner, type WriterLeaseReference, WriterLeaseManager } from "./workspace.ts";

export const DOCUMENT_EDIT_TOOL = "delivery_document_edit";
export const DOCUMENT_WRITE_TOOL = "delivery_document_write";

export interface SessionBinding {
	cwd: string;
	sessionId: string;
	sessionFile: string;
	lifetime: AbortController;
}

interface DocumentRun extends SessionBinding {
	id: string;
	name: string;
	run?: Promise<AgentToolResult<unknown>>;
	attemptedLease: boolean;
	finished: boolean;
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
export function createParentDocumentWriter(pi: ExtensionAPI, approvals: Pick<ReturnType<typeof installApprovals>, "readDocumentApproval">) {
	let active: DocumentRun | undefined;
	let stopped = false;
	let finishing: Promise<void> | undefined;
	let shutdownSettled: (() => void) | undefined;

	async function execute(kind: "edit" | "write", id: string, input: EditToolInput | WriteToolInput,
		signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
		if (stopped || active) throw new Error("父文档 writer 尚未完成终态核验或已关闭，未开始新的写入");
		signal?.throwIfAborted();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("没有持久 Session，未取得父 writer");
		const state: DocumentRun = { id, name: kind === "edit" ? DOCUMENT_EDIT_TOOL : DOCUMENT_WRITE_TOOL,
			cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionFile, lifetime: new AbortController(),
			attemptedLease: false, finished: false };
		active = state;
		const operation = signal ? AbortSignal.any([signal, state.lifetime.signal]) : state.lifetime.signal;
		state.run = Promise.resolve().then(async () => {
			try {
				const grant = await approvals.readDocumentApproval(ctx, operation);
				current(state, ctx);
				const before = await nativeEntries(state, ctx);
				const call = before.branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
				if (!call || call.type !== "message" || call.message.role !== "assistant"
					|| call.message.content.filter((part) => part.type === "toolCall" && part.id === id && part.name === state.name
						&& isDeepStrictEqual(snapshot(part.arguments), snapshot(input))).length !== 1) throw new Error("未找到当前文档操作的原生工具调用");
				before.requireEntry(call);
				if (before.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id)) {
					throw new Error("文档工具调用已有结果，不能重放取得 writer");
				}
				state.call = call;
				const stateRoot = await getWriterStateRoot(grant.workspace);
				state.leases = new WriterLeaseManager(stateRoot);
				current(state, ctx);
				operation.throwIfAborted();
				grant.signal.throwIfAborted();
				state.attemptedLease = true;
				const acquired = await state.leases.acquire(grant.workspace, { kind: "parent", sessionId: state.sessionId, pid: process.pid, runId: id });
				if (!acquired.ok) { state.attemptedLease = false; throw new Error(acquired.reason); }
				state.lease = { ...acquired.reference };
				state.owner = { ...acquired.record.owner };
				state.tools = createPlanningDocumentTools({ ...grant, lease: state.lease, leases: state.leases, owner: state.owner,
					authorize: async () => {
						current(state, ctx);
						const latest = await approvals.readDocumentApproval(ctx, operation);
						current(state, ctx);
						if (latest.approvalId !== grant.approvalId) throw new Error("本次文档授权已被替换");
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

	async function finish(ctx: ExtensionContext): Promise<void> {
		const state = active;
		if (!state || !state.finished || state.fault) return;
		try {
			if (!state.lease || !state.owner || !state.leases || !state.call || !state.result) throw new Error("父 writer 获取或执行状态不明");
			if (state.tools?.cleanupFailed) throw new Error("文档句柄清理失败");
			await state.leases.releaseParent(state.lease, state.owner, async () => {
				const records = await nativeEntries(state, ctx);
				records.requireEntry(state.call!);
				const results = records.entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"
					&& entry.message.toolCallId === state.id);
				const result = results[0];
				if (results.length !== 1 || !result || result.type !== "message" || result.message.role !== "toolResult"
					|| result.message.toolName !== state.name || !isDeepStrictEqual(snapshot({ content: result.message.content,
						details: result.message.details, isError: result.message.isError }), state.result)) throw new Error("文档工具终态未唯一落盘或与实际执行不符");
				records.requireEntry(result);
				if (records.branch.findIndex((entry) => entry.id === result.id) <= records.branch.findIndex((entry) => entry.id === state.call!.id)) {
					throw new Error("文档工具终态不在本次调用之后");
				}
				current(state, ctx);
			}, state.lifetime.signal);
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
		const settled = !ctx.isIdle() ? new Promise<void>((resolve) => { shutdownSettled = resolve; }) : undefined;
		if (settled) ctx.abort();
		await Promise.allSettled([state.run, finishing, settled]);
		shutdownSettled = undefined;
		state.lifetime.abort(new Error("父会话正在关闭或重载"));
		if (active) ctx.ui.notify("父文档操作已停止；终态交接未完成，保持关闭，不自动恢复。", "warning");
	});
	return {
		get pending() { return active !== undefined; },
		edit: (id: string, input: EditToolInput, signal: AbortSignal | undefined, ctx: ExtensionContext) => execute("edit", id, input, signal, ctx),
		write: (id: string, input: WriteToolInput, signal: AbortSignal | undefined, ctx: ExtensionContext) => execute("write", id, input, signal, ctx),
	};
}
