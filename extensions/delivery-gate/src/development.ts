import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { truncateHead, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type RpcSessionState, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { installApprovals } from "./approvals.ts";
import { current, nativeEntries, snapshot, type SessionBinding } from "./parent-writer.ts";
import { CHILD_EXIT, DELEGATION_ENTRY, createChildDialogs, delegateReadOnly, parseReadOnlySession, readyChild, startChild, type ChildRpc, type ChildTask } from "./subagents.ts";
import { ABNORMAL_STATUS, COMPLETED_STATUS, createTaskProgress, summarizeToolErrors, TOOL_ERROR_GUIDANCE, type ProgressUpdate } from "./progress.ts";
import { captureCandidate, type CandidateSnapshot, type CandidateScope } from "./candidate.ts";
import { prepareReview } from "./review.ts";
import { getWriterStateRoot, parseWriterLeaseReference, resolveWorkspaceIdentity, WriterLeaseManager, type WorkspaceIdentity, type WriterLeaseOwner, type WriterLeaseReference } from "./workspace.ts";

export const DEVELOPMENT_TOOL = "delivery_develop";
export const REVIEW_TOOL = "delivery_review";
export const CHILD_ARM = "delivery-child-arm";
export const DEVELOPMENT_ENTRY = "delivery-development";

interface ChildGrant {
	lease: WriterLeaseReference;
	owner: WriterLeaseOwner;
	parent: WriterLeaseOwner;
	paths: string[];
	protectedPaths: string[];
	inputs: string[];
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createChildDevelopment() {
	let prepared: { workspace: WorkspaceIdentity; gitDir: string; leases: WriterLeaseManager; owner: WriterLeaseOwner } | undefined;
	let armed = false;
	let stopped = false;
	const lifetime = new AbortController();
	return {
		async ready(runId: string, ctx: ExtensionContext) {
			if (prepared || !runId || stopped) throw new Error("子 writer 已准备、已关闭或执行 ID 缺失");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			const stateRoot = await getWriterStateRoot(workspace);
			const leases = new WriterLeaseManager(stateRoot);
			const owner: WriterLeaseOwner = { kind: "child", sessionId: ctx.sessionManager.getSessionId(), pid: process.pid, processToken: leases.processToken, runId };
			prepared = { workspace, gitDir: path.dirname(stateRoot), leases, owner };
			return { ...owner };
		},
		async arm(value: unknown, ctx: ExtensionContext) {
			if (!prepared || armed || stopped || ctx.mode !== "rpc") throw new Error("子 writer 尚未准备、已接收交接或模式不符");
			const grant = snapshot(value) as ChildGrant;
			const lease = parseWriterLeaseReference(grant?.lease);
			if (!lease || !isDeepStrictEqual(grant.owner, prepared.owner) || !Array.isArray(grant.paths) || !grant.paths.length || !Array.isArray(grant.protectedPaths) || !grant.protectedPaths.length || [...grant.paths, ...grant.protectedPaths].some((item) => typeof item !== "string" || !path.isAbsolute(item))) throw new Error("子 writer 的交接范围或身份无效");
			const record = await prepared.leases.read(prepared.workspace.key);
			if (!record || record.leaseId !== lease.leaseId || lease.workspaceKey !== prepared.workspace.key || !isDeepStrictEqual(record.owner, prepared.owner) || !isDeepStrictEqual(record.coordinator, grant.parent)) throw new Error("父 writer 尚未真实交接给本子会话");
			if (!Array.isArray(grant.inputs) || grant.inputs.some((item) => typeof item !== "string" || !path.isAbsolute(item))) throw new Error("审查输入范围无效");
			if (!ctx.sessionManager.getSessionFile()) throw new Error("子 Session 不持久化，未开放文件写入");
			armed = true;
		},
		async finish(ctx: ExtensionContext) {
			stopped = true;
			lifetime.abort(new Error("子会话正在关闭"));
			if (!prepared) throw new Error("子 writer 尚未准备");
			const file = ctx.sessionManager.getSessionFile();
			if (!file) throw new Error("子 Session 文件缺失");
			let content: string;
			try { content = await readFile(file, "utf8"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return { owner: { ...prepared.owner }, clean: true }; throw error; }
			if (!content.endsWith("\n")) throw new Error("子 Session 记录不完整");
			const rows = content.trimEnd().split("\n").map((line) => JSON.parse(line));
			if (rows[0]?.id !== prepared.owner.sessionId || !isDeepStrictEqual(rows.slice(1), snapshot(ctx.sessionManager.getEntries()))) throw new Error("子执行记录尚未完整落盘");
			return { owner: { ...prepared.owner }, clean: true, historyDigest: digest(rows) };
		},
	};
}

interface DevelopmentRun extends SessionBinding {
	progress?: ReturnType<typeof createTaskProgress>;
	id: string;
	name: string;
	finished: boolean;
	attemptedLease: boolean;
	call?: SessionEntry;
	lease?: WriterLeaseReference;
	owner?: WriterLeaseOwner;
	parent?: WriterLeaseOwner;
	leases?: WriterLeaseManager;
	child?: RpcSessionState;
	rpc?: ChildRpc;
	childTerminal?: string;
	taskSent?: boolean;
	approvalId?: string;
	designApprovalId?: string;
	readonlyReference?: Record<string, unknown>;
	readonlyStarted?: boolean;
	readonlyTerminal?: string;
	review?: { result: Awaited<ReturnType<typeof delegateReadOnly>>; artifact: Awaited<ReturnType<typeof prepareReview>>; candidate: CandidateSnapshot };
	problem?: unknown;
	fault?: string;
	run?: Promise<AgentToolResult<unknown>>;
	result?: { content: AgentToolResult<unknown>["content"]; details?: unknown; isError: boolean };
}

async function childTerminal(state: DevelopmentRun) {
	const { rpc, child, owner } = state;
	if (!rpc || rpc.exit?.code !== 0 || rpc.exit.signal !== null || rpc.failure || rpc.openTools.size) throw new Error("子 Pi 或工具终态未知，保留 writer");
	if (!state.taskSent && owner?.kind === "parent") return { digest: digest({ pid: rpc.process.pid, exit: rpc.exit, taskSent: false }), last: undefined };
	if (!child?.sessionFile || !owner) throw new Error("子 Pi 或工具终态未知，保留 writer");
	let content: string;
	try { content = await readFile(child.sessionFile, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !state.taskSent) return { digest: digest({ owner, exit: rpc.exit, taskSent: false }), last: undefined }; throw error; }
	if (!content.endsWith("\n")) throw new Error("子执行记录不完整");
	const rows = content.trimEnd().split("\n").map((line) => JSON.parse(line));
	const exits = rows.filter((row) => row.type === "custom" && row.customType === CHILD_EXIT);
	const exit = exits[0];
	if (rows[0]?.id !== child.sessionId || exits.length !== 1 || exit.data?.pid !== rpc.process.pid || exit.data?.sessionId !== child.sessionId || exit.data?.development?.clean !== true || !isDeepStrictEqual(exit.data.development.owner, owner) || exit.data.development.historyDigest !== digest(rows.slice(0, rows.indexOf(exit))) || rows.slice(rows.indexOf(exit) + 1).some((row) => row.type === "message")) throw new Error("子 writer 的持久收尾记录不符");
	const last = rows.findLast((row) => row.type === "message" && row.message?.role === "assistant")?.message;
	return { digest: digest(rows), last, toolNotes: summarizeToolErrors(rows) };
}

async function readonlyTerminal(state: DevelopmentRun) {
	const reference = state.readonlyReference!;
	const exit = reference.exit as { code: number | null; signal: string | null } | undefined;
	if (reference.phase !== "ended" || reference.status === "unknown" || exit?.code !== 0 || exit.signal !== null) throw new Error("审查子 Pi 的实际终态未知，保留 writer");
	if (!state.readonlyStarted) return digest(reference);
	if (typeof reference.sessionFile !== "string" || typeof reference.sessionId !== "string") throw new Error("审查子 Session 引用缺失，保留 writer");
	return digest(parseReadOnlySession(await readFile(reference.sessionFile, "utf8"), reference.sessionId, reference.pid as number));
}

export async function verifyRecordedResult(state: DevelopmentRun, ctx: ExtensionContext) {
	if ((state.rpc || state.owner?.kind === "child") && (!state.childTerminal || (await childTerminal(state)).digest !== state.childTerminal)) throw new Error("子执行终态已变化");
	if (state.readonlyReference?.pid && (!state.readonlyTerminal || await readonlyTerminal(state) !== state.readonlyTerminal)) throw new Error("审查子执行终态已变化或未知");
	const records = await nativeEntries(state, ctx);
	records.requireEntry(state.call!);
	const matches = records.entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === state.id);
	const result = matches[0];
	if (matches.length !== 1 || !result || result.type !== "message" || result.message.role !== "toolResult" || result.message.toolName !== state.name || !isDeepStrictEqual(snapshot({ content: result.message.content, details: result.message.details, isError: result.message.isError }), state.result)) throw new Error("父交付工具终态未唯一落盘或与实际结果不符");
	records.requireEntry(result);
	if (records.branch.findIndex((row) => row.id === result.id) <= records.branch.findIndex((row) => row.id === state.call!.id)) throw new Error("父交付工具终态不在本次调用之后");
}

export function createDevelopmentDelegator(pi: ExtensionAPI, approvals: ReturnType<typeof installApprovals>) {
	let active: DevelopmentRun | undefined;
	let stopped = false;
	let finishing: Promise<void> | undefined;
	let shutdownSettled: (() => void) | undefined;
	pi.on("tool_result", (event) => {
		const state = active;
		if (!state?.finished || !state.result?.isError || event.toolCallId !== state.id || event.toolName !== state.name) return;
		if (!isDeepStrictEqual({ content: event.content, details: event.details, isError: event.isError }, state.result)) return;
		const progress = state.progress?.snapshot();
		if (!progress?.endedAt) return;
		const details = { ...(state.result.details as Record<string, unknown> | undefined), progress };
		state.result = snapshot({ ...state.result, details });
		return { details };
	});

	async function execute(name: string, input: ChildTask, signal: AbortSignal | undefined, ctx: ExtensionContext, update: ProgressUpdate): Promise<AgentToolResult<unknown>> {
		if (active || stopped) throw new Error("交付 writer 尚未完成交接或已关闭，未启动新任务");
		signal?.throwIfAborted();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("没有持久父 Session，未启动交付任务");
		const state: DevelopmentRun = { id: input.id, name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionFile, lifetime: new AbortController(), finished: false, attemptedLease: false };
		active = state;
		const progress = state.progress = createTaskProgress(input.id, name === REVIEW_TOOL ? "审查" : "开发", input.task, update);
		progress.phase("准备中");
		const operation = signal ? AbortSignal.any([signal, state.lifetime.signal]) : state.lifetime.signal;
		state.run = Promise.resolve().then(async () => {
			let executionSignal = operation;
			let dialogs: ReturnType<typeof createChildDialogs> | undefined;
			try {
				const grant = await approvals.readImplementationApproval(ctx, operation);
				state.approvalId = grant.approvalId;
				state.designApprovalId = grant.designApprovalId;
				const running = executionSignal = AbortSignal.any([operation, grant.signal]);
				const records = await nativeEntries(state, ctx);
				const call = records.branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
				const toolCalls = call?.type === "message" && call.message.role === "assistant" ? call.message.content.filter((part: any) => part.type === "toolCall" && part.id === input.id && part.name === name && isDeepStrictEqual(snapshot(part.arguments), snapshot(input.toolInput))) : [];
				if (!call || call.type !== "message" || call.message.role !== "assistant" || toolCalls.length !== 1) throw new Error("本次交付工具调用未核实");
				records.requireEntry(call);
				if (records.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === input.id)) throw new Error("交付工具调用已有终态，不能重放");
				state.call = call;
				const stateRoot = await getWriterStateRoot(grant.workspace);
				state.leases = new WriterLeaseManager(stateRoot);
				current(state, ctx);
				running.throwIfAborted();
				state.attemptedLease = true;
				const acquired = await state.leases.acquire(grant.workspace, { kind: "parent", sessionId: state.sessionId, pid: process.pid, runId: input.id });
				if (!acquired.ok) { state.attemptedLease = false; throw new Error(acquired.reason); }
				state.lease = { ...acquired.reference };
				state.owner = { ...acquired.record.owner };
				const parent = state.parent = { ...state.owner };
				if (name === REVIEW_TOOL) {
					const scope: CandidateScope = { workspace: grant.workspace, readPaths: grant.inputs, writePaths: grant.paths, protectedPaths: [...grant.planningPaths, sessionFile, path.dirname(stateRoot)] };
					const candidate = await captureCandidate(scope, running);
					const artifact = await prepareReview(scope, candidate);
					const reviewTask = [
						"独立验收和代码审查。对照原始目标、批准要求、当前代码和实际差异判断是否完成。",
						"主动识别项目已有的测试、编译、lint 或其他适合本任务的检查并实际运行，记录命令和真实结果；没有运行不能声称通过。",
						"沿用父 Pi 的全部普通工具和权限，按任务需要检查、修改并报告结果；不批准、不继续委派。",
						`已批准方案：${grant.designBody}`,
						`已批准实施说明：${grant.implementationBody}`,
						`候选：${candidate.digest}`,
						`代码路径：${JSON.stringify(grant.paths)}`,
						`额外审查输入：${JSON.stringify(grant.inputs)}`,
						`审查证据：${JSON.stringify({ reviewDirectory: artifact.directory, diffFile: artifact.diffFile })}`,
						`差异基线：${artifact.baseHead ?? "无 HEAD，空基线"}；before/after 为原始 Git blob/当前文件副本。`,
						`审查重点：${input.task}`,
					].join("\n\n");
					const result = await delegateReadOnly({ ...input, readPaths: [...(input.readPaths ?? []), artifact.directory], task: reviewTask }, running,
						(data) => { if (data.phase === "started") state.readonlyStarted = true; state.readonlyReference = snapshot({ ...data, approvalId: grant.approvalId, designApprovalId: grant.designApprovalId, reviewDirectory: artifact.directory }); pi.appendEntry(DELEGATION_ENTRY, state.readonlyReference); }, update, ctx, progress, "review");
					const finalCandidate = await captureCandidate(scope, running);
					const finalArtifact = finalCandidate.digest === candidate.digest ? artifact : await prepareReview(scope, finalCandidate);
					state.review = { result, artifact: finalArtifact, candidate: finalCandidate };
				} else {
					const rpc = state.rpc = await startChild(input, "development");
					const interrupt = new AbortController();
					const childSignal = AbortSignal.any([running, interrupt.signal]);
					dialogs = createChildDialogs(rpc, ctx, childSignal, interrupt);
					rpc.onEvent = (event) => { progress.event(event); dialogs!.handle(event); };
					const { state: child, data } = await readyChild(rpc, input, childSignal, (value) => { state.child = value; });
					progress.agent({ provider: child.model!.provider, id: child.model!.id, thinking: child.thinkingLevel, reason: input.selectionReason });
					if (data.owner?.pid !== rpc.process.pid || data.owner?.sessionId !== child.sessionId || data.owner?.runId !== input.id) throw new Error("子 writer 身份未核实");
					const childOwner = snapshot(data.owner) as WriterLeaseOwner;
					await state.leases.handoff(state.lease, parent, childOwner, async () => { const latest = await approvals.readImplementationApproval(ctx, childSignal); if (latest.approvalId !== grant.approvalId) throw new Error("实施授权已变化"); current(state, ctx); }, childSignal);
					state.owner = childOwner;
					await rpc.control(CHILD_ARM, input.entryPath, childSignal, JSON.stringify({ lease: state.lease, owner: state.owner!, parent, paths: grant.paths, inputs: grant.inputs, protectedPaths: [...grant.planningPaths, sessionFile] } satisfies ChildGrant));
					pi.appendEntry(DEVELOPMENT_ENTRY, { id: input.id, phase: "started", lease: state.lease, childSessionFile: child.sessionFile, approvalId: grant.approvalId, designApprovalId: grant.designApprovalId, agent: progress.snapshot().agent });
					state.taskSent = true;
					progress.phase("运行中", "开发子任务已接收 writer", child.sessionFile);
					const developmentTask = [
						"开发子任务。沿用父 Pi 原有工具和权限，完成批准范围内的实现；必要时主动运行项目测试或编译检查，但不要把自检当成独立审查。",
						"不要修改父规划文档，不继续委派，不执行未授权的外部写入。",
						`本机工作目录：${input.cwd}`,
						`已批准开发路径：${JSON.stringify(grant.paths)}`,
						`额外审查输入：${JSON.stringify(grant.inputs)}`,
						`已批准方案：${grant.designBody}`,
						`已批准实施说明：${grant.implementationBody}`,
						`本次任务：${input.task}`,
					].join("\n\n");
					await Promise.all([rpc.waitSettled(childSignal), rpc.request({ type: "prompt", message: developmentTask }, childSignal)]);
				}
			} catch (error) { state.problem = error; }
			progress.phase(executionSignal.aborted ? "正在取消" : "核对收尾中");
			try { await dialogs?.close(); } catch (error) { state.problem ??= error; }
			try {
				if (state.rpc) await state.rpc.stop(input.entryPath);
				if (state.rpc) { const terminal = await childTerminal(state); state.childTerminal = terminal.digest; if (!state.problem && terminal.last?.stopReason !== "stop") state.problem = new Error("子模型没有正常完成的持久终态"); }
				if (state.readonlyReference?.pid) state.readonlyTerminal = await readonlyTerminal(state);
			} catch (error) { state.problem = new Error(`交付任务收尾失败：${String(error)}`, { cause: state.problem ?? error }); }
			if (executionSignal.aborted) state.problem ??= executionSignal.reason;
			try {
				if (state.problem) throw state.problem;
				if (state.review) {
					const review = state.review;
					progress.end(COMPLETED_STATUS);
					const result = { content: [{ type: "text" as const, text: [`独立验收和审查已结束，发现仍由父会话裁决，不等于自动交付通过：`, review.result.text, `候选：${review.candidate.digest}`, `审查原始记录：${review.result.sessionFile}`, `审查制品：${review.artifact.directory}`, `实际差异：${review.artifact.diffFile}`].join("\n") }], details: { candidate: review.candidate, reviewSessionFile: review.result.sessionFile, diffFile: review.artifact.diffFile, pid: review.result.pid, progress: progress.snapshot() } };
					state.result = snapshot({ ...result, isError: false });
					return result;
				}
				const terminal = await childTerminal(state);
				const text = ((terminal.last as any)?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
				progress.end(COMPLETED_STATUS);
				const result = { content: [{ type: "text" as const, text: `${state.rpc!.toolError ? `${TOOL_ERROR_GUIDANCE}\n${terminal.toolNotes?.text ?? "请查看原始子 Session 的工具返回。"}\n\n` : ""}开发子任务已结束，仍需父 Pi 核对实际变更和审查结果：\n${truncateHead(text).content}\n子会话：${state.child!.sessionFile}` }], details: { childSessionFile: state.child!.sessionFile, childSessionId: state.child!.sessionId, pid: state.rpc!.process.pid, progress: progress.snapshot() } };
				state.result = snapshot({ ...result, isError: false });
				return result;
			} catch (error) {
				const completed = Boolean(state.taskSent && state.childTerminal) || Boolean(state.readonlyStarted && state.readonlyTerminal);
				progress.end(completed ? COMPLETED_STATUS : ABNORMAL_STATUS);
				const childSession = state.child?.sessionFile ?? state.readonlyReference?.sessionFile;
				const text = (error instanceof Error ? error.message : String(error)) + (typeof childSession === "string" ? `\n原始子 Session：${childSession}` : "\n子 Session 引用尚未取得。") + (typeof state.readonlyReference?.reviewDirectory === "string" ? `\n审查制品：${state.readonlyReference.reviewDirectory}` : "") + (state.child && !state.taskSent ? "\n子任务尚未发送，Session 文件可能尚未生成。" : "") + (state.rpc || state.readonlyReference?.pid ? `\n子收尾核验：${state.childTerminal || state.readonlyTerminal ? "已取得证明，交接时仍须复核。" : "未取得证明，保持关闭。"}` : "") + `\n父 Session：${state.sessionFile}\n本次工具调用：${state.id}` + (state.lease ? "\n父 writer 尚待本次工具结果落盘后核验交接；此失败结果不证明已交回，可用 /delivery-status 核对现场。" : "");
				const failure = new Error(text, { cause: error });
				state.result = { content: [{ type: "text", text }], details: {}, isError: true };
				throw failure;
			} finally { state.finished = true; if (!state.attemptedLease && active === state) active = undefined; }
		});
		return state.run;
	}

	async function finish(ctx: ExtensionContext) {
		const state = active;
		if (!state?.finished || state.fault) return;
		try {
			if (!state.lease || !state.owner || !state.parent || !state.leases || !state.result || !state.call) throw new Error("交付 writer 获取或执行状态未知");
			const verify = () => verifyRecordedResult(state, ctx);
			if (state.owner.kind === "child") await state.leases.releaseChild(state.lease, state.owner, state.parent, verify, state.lifetime.signal);
			else await state.leases.releaseParent(state.lease, state.owner, verify, state.lifetime.signal);
			active = undefined;
		} catch (error) { state.fault = String(error); ctx.ui.notify(`交付 writer 未交回，保持关闭：${state.fault}`, "error"); }
	}
	const settle = async (_event: unknown, ctx: ExtensionContext) => { if (finishing) return finishing; finishing = finish(ctx); try { await finishing; } finally { finishing = undefined; } };
	pi.on("turn_end", settle);
	pi.on("agent_settled", async (event, ctx) => { try { await settle(event, ctx); } finally { shutdownSettled?.(); } });
	const preventSwitch = () => active ? { cancel: true } : undefined;
	pi.on("session_before_switch", preventSwitch);
	pi.on("session_before_fork", preventSwitch);
	pi.on("session_before_tree", preventSwitch);
	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		const settled = active && !ctx.isIdle() ? new Promise<void>((resolve) => { shutdownSettled = resolve; }) : undefined;
		if (settled) ctx.abort();
		await Promise.allSettled([active?.run, finishing, settled]);
		shutdownSettled = undefined;
		active?.lifetime.abort(new Error("父会话正在关闭或重载"));
		if (active) ctx.ui.notify("交付操作已停止；交接未完成，保持关闭，不自动恢复。", "warning");
	});
	return {
		execute: (input: ChildTask, signal: AbortSignal | undefined, ctx: ExtensionContext, update: ProgressUpdate) => execute(DEVELOPMENT_TOOL, input, signal, ctx, update),
		review: (input: ChildTask, signal: AbortSignal | undefined, ctx: ExtensionContext, update: ProgressUpdate) => execute(REVIEW_TOOL, input, signal, ctx, update),
		get progress() { return active?.progress?.snapshot(); },
		get pending() { return active !== undefined; },
	};
}
