import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createBashTool, truncateHead, type AgentToolResult, type BashToolInput, type ExtensionAPI,
	type ExtensionContext, type RpcSessionState, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { installApprovals } from "./approvals.ts";
import { current, nativeEntries, snapshot, type SessionBinding } from "./parent-writer.ts";
import { CHILD_EXIT, DELEGATION_ENTRY, createChildDialogs, delegateReadOnly, parseReadOnlySession, readyChild, startChild, type ChildRpc, type ChildTask } from "./subagents.ts";
import { createLocalOperations, type ExecutionReference } from "./local-execution.ts";
import { ABNORMAL_STATUS, COMPLETED_STATUS, createTaskProgress, summarizeToolErrors, TOOL_ERROR_GUIDANCE, type ProgressUpdate } from "./progress.ts";
import { createStructuredCommands, type ExecInput } from "./structured.ts";
import { captureCandidate, type CandidateSnapshot, type CandidateScope } from "./candidate.ts";
import { prepareReview } from "./review.ts";
import { createValidationRun, validationPassed, type ValidationProof } from "./validation.ts";
import { getWriterStateRoot, parseWriterLeaseReference, resolveWorkspaceIdentity, WriterLeaseManager,
	type WorkspaceIdentity, type WriterLeaseOwner, type WriterLeaseReference } from "./workspace.ts";

export const DEVELOPMENT_TOOL = "delivery_develop";
export const VALIDATION_TOOL = "delivery_validate";
export const REVIEW_TOOL = "delivery_review";
export const CHILD_ARM = "delivery-child-arm";
export const DEVELOPMENT_ENTRY = "delivery-development";
export const EXECUTION_ENTRY = "delivery-execution";

interface ChildGrant {
	lease: WriterLeaseReference;
	owner: WriterLeaseOwner;
	parent: WriterLeaseOwner;
	paths: string[];
	protectedPaths: string[];
	inputs: string[];
	validation?: { commands: string[]; before: CandidateSnapshot };
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createChildDevelopment(pi: Pick<ExtensionAPI, "appendEntry">) {
	let prepared: { workspace: WorkspaceIdentity; gitDir: string; leases: WriterLeaseManager; owner: WriterLeaseOwner } | undefined;
	let armed = false;
	let local: ReturnType<typeof createLocalOperations> | undefined;
	let structured: ReturnType<typeof createStructuredCommands> | undefined;
	let commandScope: CandidateScope | undefined;
	let beforeCommand: ((reference: ExecutionReference, id: string, name: string) => Promise<void>) | undefined;
	let validation: Awaited<ReturnType<typeof createValidationRun>> | undefined;
	let commandId: string | undefined;
	let active = 0;
	let executed = false;
	let stopped = false;
	const lifetime = new AbortController();
	return {
		async ready(runId: string, ctx: ExtensionContext) {
			if (prepared || !runId || stopped) throw new Error("子 writer 已准备、已关闭或执行 ID 缺失");
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			const stateRoot = await getWriterStateRoot(workspace);
			const leases = new WriterLeaseManager(stateRoot);
			const owner: WriterLeaseOwner = { kind: "child", sessionId: ctx.sessionManager.getSessionId(), pid: process.pid,
				processToken: leases.processToken, runId };
			prepared = { workspace, gitDir: path.dirname(stateRoot), leases, owner };
			return { ...owner };
		},
		async arm(value: unknown, ctx: ExtensionContext) {
			if (!prepared || armed || stopped || ctx.mode !== "rpc") throw new Error("子 writer 尚未准备、已接收交接或模式不符");
			const grant = snapshot(value) as ChildGrant;
			const lease = parseWriterLeaseReference(grant?.lease);
			if (!lease || !isDeepStrictEqual(grant.owner, prepared.owner)
				|| !Array.isArray(grant.paths) || !grant.paths.length || !Array.isArray(grant.protectedPaths) || !grant.protectedPaths.length
				|| [...grant.paths, ...grant.protectedPaths].some((item) => typeof item !== "string" || !path.isAbsolute(item))) throw new Error("子 writer 的交接范围或身份无效");
			const record = await prepared.leases.read(prepared.workspace.key);
			if (!record || record.leaseId !== lease.leaseId || lease.workspaceKey !== prepared.workspace.key
				|| !isDeepStrictEqual(record.owner, prepared.owner) || !isDeepStrictEqual(record.coordinator, grant.parent)) throw new Error("父 writer 尚未真实交接给本子会话");
			const owner = { ...prepared.owner };
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("子 Session 不持久化，未开放文件写入");
			if (!Array.isArray(grant.inputs) || grant.inputs.some((item) => typeof item !== "string" || !path.isAbsolute(item))) throw new Error("验收输入范围无效");
			const protectedPaths = [...grant.protectedPaths, sessionFile, prepared.gitDir];
			if (grant.validation && (!Array.isArray(grant.validation.commands) || !grant.validation.before)) throw new Error("固定验收缺少命令清单或准备候选");
			if (!grant.validation) { armed = true; return; }
			{
				commandScope = { workspace: prepared.workspace, readPaths: grant.inputs, writePaths: grant.paths, protectedPaths };
				beforeCommand = async (reference, callId, name) => {
					const binding = { cwd: ctx.cwd, sessionId: owner.sessionId, sessionFile, lifetime };
					current(binding, ctx);
					const record = await prepared!.leases.read(prepared!.workspace.key);
					if (!record || record.leaseId !== lease.leaseId || !isDeepStrictEqual(record.owner, owner)) throw new Error("本机执行前子 writer 已失效");
					const records = await nativeEntries(binding, ctx);
					const call = records.branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
					if (!callId || !call || call.type !== "message" || call.message.role !== "assistant"
						|| !call.message.content.some((part) => part.type === "toolCall" && part.id === callId && part.name === name)) throw new Error("本次本机工具调用未核实");
					records.requireEntry(call);
					pi.appendEntry(EXECUTION_ENTRY, { ...reference, toolCallId: callId });
					const saved = await nativeEntries(binding, ctx);
					const entry = saved.branch.findLast((row) => row.type === "custom" && row.customType === EXECUTION_ENTRY);
					if (!entry || entry.type !== "custom" || !isDeepStrictEqual(entry.data, { ...reference, toolCallId: callId })) throw new Error("本机执行引用未核实");
					saved.requireEntry(entry);
				};
				local = createLocalOperations(prepared.workspace.cwdPath, (reference) => beforeCommand!(reference, commandId!, "bash"));
			}
			validation = await createValidationRun(commandScope, grant.validation.commands, grant.validation.before);
			armed = true;
		},
		async execute(id: string, input: BashToolInput, signal?: AbortSignal, update?: (result: AgentToolResult<unknown>) => void) {
			if (!armed || !validation || stopped) throw new Error("本子会话未取得固定验收交接，未执行验收命令");
			if (active || structured?.active || structured?.cleanupFailed || local?.active) throw new Error("子 writer 尚有执行或收尾未知，未开始新操作");
			executed = true;
			active++;
			try {
				commandId = id;
				const operation = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
				const invoke = () => createBashTool(prepared!.workspace.cwdPath, { operations: local!.operations, exposeSessionEnvironment: false })
					.execute(id, input, operation, update);
				const result = await validation.execute(id, input, invoke, () => local!.lastExecution);
				return { ...result, details: { ...result.details, execution: local!.lastExecution } };
			} finally { commandId = undefined; active--; }
		},
		async executeStructured(id: string, input: ExecInput, packageRoot: string, signal?: AbortSignal, update?: (result: AgentToolResult<unknown>) => void) {
			if (!armed || !validation || stopped || !commandScope || !beforeCommand) throw new Error("Structured 固定验收需要本轮交接");
			if (active || local?.active || structured?.cleanupFailed) throw new Error("子 writer 尚有原生调用或收尾未知");
			if (input.tty || input.login || input.shell
				|| input.workdir && path.resolve(prepared!.workspace.cwdPath, input.workdir) !== prepared!.workspace.cwdPath) throw new Error("固定验收仅使用原工作目录与默认 Shell，不接收交互或其他 Shell");
			structured ??= createStructuredCommands(packageRoot, prepared!.workspace.cwdPath, beforeCommand);
			const operation = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
			executed = true;
			active++;
			try {
				const invoke = () => structured!.exec(id, input, operation, update);
				return await validation.execute(id, { command: input.cmd }, invoke, () => structured!.lastExecution);
			} finally { active--; }
		},
		async finish(ctx: ExtensionContext) {
			stopped = true;
			lifetime.abort(new Error("子会话正在关闭"));
			if (!prepared || active || local?.active) throw new Error("子 writer 的执行或句柄清理尚未核实");
			const structuredClose = await structured?.finish();
			const file = ctx.sessionManager.getSessionFile();
			if (!file) throw new Error("子 Session 文件缺失");
			let content: string;
			try { content = await readFile(file, "utf8"); }
			catch (error) {
				// Pi 在首条模型消息前可以尚未创建 Session；不能用于已执行或已有消息的路径。
				if ((error as NodeJS.ErrnoException).code === "ENOENT" && !executed
					&& !ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return { owner: { ...prepared.owner }, clean: true };
				throw error;
			}
			if (!content.endsWith("\n")) throw new Error("子 Session 记录不完整");
			const rows = content.trimEnd().split("\n").map((line) => JSON.parse(line));
			if (rows[0]?.id !== prepared.owner.sessionId || !isDeepStrictEqual(rows.slice(1), snapshot(ctx.sessionManager.getEntries()))) throw new Error("子执行记录尚未完整落盘");
			return { owner: { ...prepared.owner }, clean: true, historyDigest: digest(rows), ...(structuredClose ? { structured: structuredClose } : {}), ...(validation ? { validation: await validation.finish() } : {}) };
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
	validation?: ValidationProof;
	reviewValidation?: DevelopmentRun;
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
	// 握手失败时 writer 仍属于父；只核实已启动进程的关闭，不要求尚未发送任务的模型记录。
	if (!state.taskSent && owner?.kind === "parent") return { digest: digest({ pid: rpc.process.pid, exit: rpc.exit, taskSent: false }), last: undefined, validation: undefined };
	if (!child?.sessionFile || !owner) throw new Error("子 Pi 或工具终态未知，保留 writer");
	let content: string;
	try { content = await readFile(child.sessionFile, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !state.taskSent) {
			return { digest: digest({ owner, exit: rpc.exit, taskSent: false }), last: undefined, validation: undefined };
		}
		throw error;
	}
	if (!content.endsWith("\n")) throw new Error("子执行记录不完整");
	const rows = content.trimEnd().split("\n").map((line) => JSON.parse(line));
	const exits = rows.filter((row) => row.type === "custom" && row.customType === CHILD_EXIT);
	const exit = exits[0];
	if (rows[0]?.id !== child.sessionId || exits.length !== 1 || exit.data?.pid !== rpc.process.pid
		|| exit.data?.sessionId !== child.sessionId || exit.data?.development?.clean !== true
		|| !isDeepStrictEqual(exit.data.development.owner, owner)
		|| exit.data.development.structured !== undefined && (exit.data.development.structured?.clean !== true || typeof exit.data.development.structured?.incomplete !== "boolean")
		|| exit.data.development.historyDigest !== digest(rows.slice(0, rows.indexOf(exit)))
		|| rows.slice(rows.indexOf(exit) + 1).some((row) => row.type === "message")) throw new Error("子 writer 的持久收尾记录不符");
	const last = rows.findLast((row) => row.type === "message" && row.message?.role === "assistant")?.message;
	return { digest: digest(rows), last, toolNotes: summarizeToolErrors(rows), incompleteCommand: exit.data.development.structured?.incomplete === true, validation: exit.data.development.validation as ValidationProof | undefined };
}

async function readonlyTerminal(state: DevelopmentRun) {
	const reference = state.readonlyReference!;
	const exit = reference.exit as { code: number | null; signal: string | null } | undefined;
	if (reference.phase !== "ended" || reference.status === "unknown" || exit?.code !== 0 || exit.signal !== null) throw new Error("审查子 Pi 的实际终态未知，保留 writer");
	// READY 之前未发任务的正常退出，不要求 Pi 尚未创建的模型 Session 文件。
	if (!state.readonlyStarted) return digest(reference);
	if (typeof reference.sessionFile !== "string" || typeof reference.sessionId !== "string") throw new Error("审查子 Session 引用缺失，保留 writer");
	const content = await readFile(reference.sessionFile, "utf8");
	const rows = parseReadOnlySession(content, reference.sessionId, reference.pid as number);
	return digest(rows);
}

export async function verifyRecordedResult(state: DevelopmentRun, ctx: ExtensionContext) {
	if ((state.rpc || state.owner?.kind === "child") && (!state.childTerminal || (await childTerminal(state)).digest !== state.childTerminal)) throw new Error("子执行终态已变化");
	if (state.readonlyReference?.pid && (!state.readonlyTerminal || await readonlyTerminal(state) !== state.readonlyTerminal)) throw new Error("审查子执行终态已变化或未知");
	const records = await nativeEntries(state, ctx);
	records.requireEntry(state.call!);
	const matches = records.entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === state.id);
	const result = matches[0];
	if (matches.length !== 1 || !result || result.type !== "message" || result.message.role !== "toolResult"
		|| result.message.toolName !== state.name || !isDeepStrictEqual(snapshot({ content: result.message.content, details: result.message.details, isError: result.message.isError }), state.result)) throw new Error("父开发工具终态未唯一落盘或与实际结果不符");
	records.requireEntry(result);
	if (records.branch.findIndex((row) => row.id === result.id) <= records.branch.findIndex((row) => row.id === state.call!.id)) throw new Error("父开发工具终态不在本次调用之后");
	if (state.reviewValidation) await verifyRecordedResult(state.reviewValidation, ctx);
}

// 只管理一次前台开发委派；批准仍在原父 TUI，子角色没有批准或恢复入口。
export function createDevelopmentDelegator(pi: ExtensionAPI, approvals: ReturnType<typeof installApprovals>) {
	let active: DevelopmentRun | undefined;
	let validated: DevelopmentRun | undefined;
	let stopped = false;
	let finishing: Promise<void> | undefined;
	let shutdownSettled: (() => void) | undefined;
	pi.on("tool_result", (event) => {
		const state = active;
		if (!state?.finished || !state.result?.isError || event.toolCallId !== state.id || event.toolName !== state.name) return;
		if (!isDeepStrictEqual({ content: event.content, details: event.details, isError: event.isError }, state.result)) return;
		const progress = state.progress?.snapshot();
		if (!progress?.endedAt) return;
		const details = { progress };
		state.result = snapshot({ ...state.result, details });
		return { details };
	});
	async function execute(name: string, input: ChildTask, signal: AbortSignal | undefined, ctx: ExtensionContext,
		update: ProgressUpdate): Promise<AgentToolResult<unknown>> {
		if (active || stopped) throw new Error("开发 writer 尚未完成交接或已关闭，未启动新任务");
		signal?.throwIfAborted();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("没有持久父 Session，未委派开发");
		const state: DevelopmentRun = { id: input.id, name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionFile,
			lifetime: new AbortController(), finished: false, attemptedLease: false };
		active = state;
		const progress = state.progress = createTaskProgress(input.id, name === REVIEW_TOOL ? "审查" : name === VALIDATION_TOOL ? "验收" : "开发", input.task, update);
		progress.phase("准备中");
		if (name === VALIDATION_TOOL) validated = undefined;
		const operation = signal ? AbortSignal.any([signal, state.lifetime.signal]) : state.lifetime.signal;
		state.run = Promise.resolve().then(async () => {
			let executionSignal = operation;
			let dialogs: ReturnType<typeof createChildDialogs> | undefined;
			let validationCommands: string[] | undefined;
			let validationBefore: CandidateSnapshot | undefined;
			try {
				const grant = await approvals.readImplementationApproval(ctx, operation);
				state.approvalId = grant.approvalId;
				state.designApprovalId = grant.designApprovalId;
				if (name === VALIDATION_TOOL) {
					if (!grant.validationCommands.length) throw new Error("固定验收缺少验收命令，未运行");
					validationCommands = [...grant.validationCommands];
				}
				const running = executionSignal = AbortSignal.any([operation, grant.signal]);
				if (name === VALIDATION_TOOL) {
					if (input.environment.structured && input.environment.structured.version !== "3.0.29") throw new Error("固定验收目前仅支持 pi-codex-conversion 3.0.29；普通工具仍沿用原插件");
					const commandTool = input.environment.structured ? "exec_command" : "bash";
					if (!input.environment.tools.some((tool) => tool.name === commandTool)) throw new Error(`父 Pi 未启用 ${commandTool}，不能运行固定验收`);
					if (!input.environment.structured && pi.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.source !== "builtin") throw new Error("固定验收需要原生 bash 或已支持的 Structured 执行器；普通工具仍沿用 Pi，未启动验收");
				}
				const records = await nativeEntries(state, ctx);
				const call = records.branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
				if (!call || call.type !== "message" || call.message.role !== "assistant"
					|| call.message.content.filter((part) => part.type === "toolCall" && part.id === input.id && part.name === name
						&& isDeepStrictEqual(snapshot(part.arguments), snapshot(input.toolInput))).length !== 1) throw new Error("本次开发工具调用未核实");
				records.requireEntry(call);
				if (records.entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === input.id)) throw new Error("开发工具调用已有终态，不能重放");
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
					if (!validated?.validation?.after || validated.approvalId !== grant.approvalId || validated.designApprovalId !== grant.designApprovalId) throw new Error("没有本轮已交回 writer 的可信验收，不开始候选审查");
					const validation = validated;
					const scope = { workspace: grant.workspace, readPaths: grant.inputs,
						writePaths: grant.paths, protectedPaths: [...grant.planningPaths, sessionFile, path.dirname(stateRoot)] };
					let candidate: CandidateSnapshot;
					try {
						await verifyRecordedResult(validation, ctx);
						candidate = await captureCandidate(scope, grant.validationCommands, running);
						if (candidate.digest !== validation.validation!.after!.digest) throw new Error("实际候选已变化，旧验收证据失效；修复后重新验收");
					} catch (error) { validated = undefined; throw error; }
					const artifact = await prepareReview(scope, candidate);
					const result = await delegateReadOnly({ ...input, readPaths: [...(input.readPaths ?? []), artifact.directory, validation.child!.sessionFile!], task: `独立候选代码审查。对照原始目标和批准要求读取当前代码、实际差异与原始验收记录，不只看实现者总结。发现由父会话裁决，不批准、不修改或继续委派。\n`
						+ `已批准方案：\n${grant.designBody}\n\n已批准实施计划：\n${grant.implementationBody}\n\n候选：${candidate.digest}\n`
						+ `代码路径：${JSON.stringify(grant.paths)}\n额外验收输入：${JSON.stringify(grant.inputs)}\n固定验收命令：${JSON.stringify(grant.validationCommands)}\n`
						+ `审查证据：${JSON.stringify({ reviewDirectory: artifact.directory, diffFile: artifact.diffFile, validationSessionFile: validation.child!.sessionFile })}\n`
						+ `差异基线：${artifact.baseHead ?? "无 HEAD，空基线"}；before/after 为原始 Git blob/当前文件副本。差异覆盖全部可写候选和 Git 常规列出的输入，忽略的只读依赖按原路径核对。\n重点：${input.task}` }, running,
						(data) => {
							if (data.phase === "started") state.readonlyStarted = true;
							const reference = { ...data, approvalId: grant.approvalId, designApprovalId: grant.designApprovalId, reviewDirectory: artifact.directory };
							state.readonlyReference = snapshot(reference);
							pi.appendEntry(DELEGATION_ENTRY, reference);
						}, update, ctx, progress);
					if ((await captureCandidate(scope, grant.validationCommands, running)).digest !== candidate.digest) {
						validated = undefined;
						throw new Error("审查期间候选发生变化，不形成同候选审查证据");
					}
					try { await verifyRecordedResult(validation, ctx); }
					catch (error) {
						validated = undefined;
						throw new Error(`审查期间原验收证据已变化，重新验收后才可审查：${String(error)}`, { cause: error });
					}
					state.reviewValidation = validation;
					state.review = { result, artifact, candidate };
				} else {
					if (validationCommands) validationBefore = await captureCandidate({ workspace: grant.workspace,
						readPaths: grant.inputs, writePaths: grant.paths, protectedPaths: [...grant.planningPaths, sessionFile, path.dirname(stateRoot)] }, validationCommands, running);
					const rpc = state.rpc = await startChild(input, "development");
					const interrupt = new AbortController();
					const childSignal = AbortSignal.any([running, interrupt.signal]);
					dialogs = createChildDialogs(rpc, ctx, childSignal, interrupt);
					rpc.onEvent = (event) => {
						progress.event(event);
						dialogs!.handle(event);
					};
					const { state: child, data } = await readyChild(rpc, input, childSignal, (value) => { state.child = value; });
					progress.agent({ provider: child.model!.provider, id: child.model!.id, thinking: child.thinkingLevel, reason: input.selectionReason });
					if (data.owner?.pid !== rpc.process.pid || data.owner?.sessionId !== child.sessionId || data.owner?.runId !== input.id) throw new Error("子 writer 身份未核实");
					const childOwner = snapshot(data.owner) as WriterLeaseOwner;
					await state.leases.handoff(state.lease, parent, childOwner, async () => {
						const latest = await approvals.readImplementationApproval(ctx, childSignal);
						if (latest.approvalId !== grant.approvalId) throw new Error("实施授权已变化");
						current(state, ctx);
					}, childSignal);
					state.owner = childOwner;
					await rpc.control(CHILD_ARM, input.entryPath, childSignal, JSON.stringify({ lease: state.lease, owner: state.owner!, parent,
						paths: grant.paths, inputs: grant.inputs, protectedPaths: [...grant.planningPaths, sessionFile],
						...(validationCommands ? { validation: { commands: validationCommands, before: validationBefore! } } : {}) } satisfies ChildGrant));
					pi.appendEntry(DEVELOPMENT_ENTRY, { id: input.id, phase: "started", lease: state.lease, childSessionFile: child.sessionFile,
						approvalId: grant.approvalId, designApprovalId: grant.designApprovalId, agent: progress.snapshot().agent });
					state.taskSent = true;
					progress.phase("运行中", "子任务已接收 writer", child.sessionFile);
					await Promise.all([rpc.waitSettled(childSignal), rpc.request({ type: "prompt", message:
						(validationCommands ? `固定候选验收。严格按下列固定验收命令顺序逐条调用 ${input.environment.structured ? "exec_command" : "bash"}，不替换命令、不编辑文件，失败后停止。验收调用等待真实退出，不使用 tty/write_stdin。不得用文字或手工模拟结果代替执行。\n`
							: "开发子任务。沿用父 Pi 原有工具和权限，遵守本任务批准范围，不修改父规划文档，不继续委派。\n")
						+ `本机开发，工作目录 ${input.cwd}，使用本机已有工具链与当前用户权限。正常联网检索和查阅资料可直接使用原工具；安装依赖、外部写入或后台服务仍须遵守用户授权。额外验收输入 ${JSON.stringify(grant.inputs)}。\n`
						+ `\n已批准开发路径：${JSON.stringify(grant.paths)}\n固定验收命令：${JSON.stringify(grant.validationCommands)}\n`
						+ `\n已批准方案：\n${grant.designBody}\n\n已批准实施计划：\n${grant.implementationBody}\n\n本次任务：\n${input.task}` }, childSignal)]);
				}
			} catch (error) { state.problem = error; }
			progress.phase(executionSignal.aborted ? "正在取消" : "核对收尾中");
			try { await dialogs?.close(); }
			catch (error) { state.problem ??= error; }
			try {
				if (state.rpc) await state.rpc.stop(input.entryPath);
				if (state.rpc) {
					const terminal = await childTerminal(state);
					state.childTerminal = terminal.digest;
					if (terminal.incompleteCommand) state.problem ??= new Error("Structured 子命令未通过原生工具交回最终退出结果；已停止命令，不能作为成功任务");
					if (!state.problem && terminal.last?.stopReason !== "stop") state.problem = new Error("子模型没有正常完成的持久终态");
				}
				if (state.readonlyReference?.pid) state.readonlyTerminal = await readonlyTerminal(state);
			} catch (error) { state.problem = new Error(`开发收尾失败：${String(error)}`, { cause: state.problem ?? error }); }
			if (executionSignal.aborted) state.problem ??= executionSignal.reason;
			try {
				if (state.problem) throw state.problem;
				if (state.review) {
					const review = state.review;
					progress.end(COMPLETED_STATUS);
					const result = { content: [{ type: "text" as const, text: `独立审查已结束，发现仍由父会话裁决，不等于审查通过：\n${review.result.text}\n候选：${review.candidate.digest}\n审查原始记录：${review.result.sessionFile}\n审查制品：${review.artifact.directory}\n实际差异：${review.artifact.diffFile}` }],
						details: { candidate: review.candidate, reviewSessionFile: review.result.sessionFile, diffFile: review.artifact.diffFile, pid: review.result.pid, progress: progress.snapshot() } };
					state.result = snapshot({ ...result, isError: false });
					return result;
				}
				const terminal = await childTerminal(state);
				if (validationCommands && (!terminal.validation || !isDeepStrictEqual(terminal.validation.commands, validationCommands)
					|| !isDeepStrictEqual(terminal.validation.before, validationBefore) || !validationPassed(terminal.validation))) {
					throw new Error(`固定验收未通过：命令未完整通过或候选已变化。原始证据：${state.child!.sessionFile}`);
				}
				if (validationCommands) state.validation = snapshot(terminal.validation!);
				const text = terminal.last.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
				progress.end(COMPLETED_STATUS);
				const result = { content: [{ type: "text" as const, text: `${state.rpc!.toolError ? `${TOOL_ERROR_GUIDANCE}\n${terminal.toolNotes?.text ?? "请查看原始子 Session 的工具返回。"}\n\n` : ""}${validationCommands ? "固定验收已通过，结论只属于本次候选，不代替独立审查" : "开发子任务已结束，仍须核对实际文件与验证结果"}：\n${truncateHead(text).content}\n子会话：${state.child!.sessionFile}` }],
					details: { childSessionFile: state.child!.sessionFile, childSessionId: state.child!.sessionId, pid: state.rpc!.process.pid, progress: progress.snapshot(),
						...(validationCommands ? { validation: terminal.validation } : {}) } };
				state.result = snapshot({ ...result, isError: false });
				return result;
			} catch (error) {
				progress.end(state.childTerminal || state.readonlyTerminal ? COMPLETED_STATUS : ABNORMAL_STATUS);
				const childSession = state.child?.sessionFile ?? state.readonlyReference?.sessionFile;
				const text = (error instanceof Error ? error.message : String(error))
					+ (typeof childSession === "string" ? `\n原始子 Session：${childSession}` : "\n子 Session 引用尚未取得。")
					+ (typeof state.readonlyReference?.reviewDirectory === "string" ? `\n审查制品：${state.readonlyReference.reviewDirectory}` : "")
					+ (state.child && !state.taskSent ? "\n子任务尚未发送，Session 文件可能尚未生成。" : "")
					+ (state.rpc || state.readonlyReference?.pid ? `\n子收尾核验：${state.childTerminal || state.readonlyTerminal ? "已取得证明，交接时仍须复核。" : "未取得证明，保持关闭。"}` : "")
					+ `\n父 Session：${state.sessionFile}\n本次工具调用：${state.id}`
					+ (state.lease ? "\n父 writer 尚待本次工具结果落盘后核验交接；此失败结果不证明已交回，可用 /delivery-status 核对现场。" : "");
				const failure = new Error(text, { cause: error });
				state.result = { content: [{ type: "text", text }], details: {}, isError: true };
				throw failure;
			} finally {
				state.finished = true;
				if (!state.attemptedLease && active === state) active = undefined;
			}
		});
		return state.run;
	}
	async function finish(ctx: ExtensionContext) {
		const state = active;
		if (!state?.finished || state.fault) return;
		try {
			if (!state.lease || !state.owner || !state.parent || !state.leases || !state.result || !state.call) throw new Error("开发 writer 获取或执行状态未知");
			const verify = () => verifyRecordedResult(state, ctx);
			if (state.owner.kind === "child") await state.leases.releaseChild(state.lease, state.owner, state.parent, verify, state.lifetime.signal);
			else await state.leases.releaseParent(state.lease, state.owner, verify, state.lifetime.signal);
			if (state.name === VALIDATION_TOOL && state.validation && !state.result.isError) validated = state;
			active = undefined;
		} catch (error) { validated = undefined; state.fault = String(error); ctx.ui.notify(`开发 writer 未交回，保持关闭：${state.fault}`, "error"); }
	}
	const settle = async (_event: unknown, ctx: ExtensionContext) => {
		if (finishing) return finishing;
		finishing = finish(ctx);
		try { await finishing; } finally { finishing = undefined; }
	};
	pi.on("turn_end", settle);
	pi.on("agent_settled", async (event, ctx) => {
		try { await settle(event, ctx); } finally { shutdownSettled?.(); }
	});
	const preventSwitch = () => active ? { cancel: true } : undefined;
	pi.on("session_before_switch", preventSwitch);
	pi.on("session_before_fork", preventSwitch);
	pi.on("session_before_tree", preventSwitch);
	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		validated = undefined;
		// reload 本身不等待父回合；必须保留旧处理器直到原生终态与交接完成。
		const settled = active && !ctx.isIdle() ? new Promise<void>((resolve) => { shutdownSettled = resolve; }) : undefined;
		if (settled) ctx.abort();
		await Promise.allSettled([active?.run, finishing, settled]);
		shutdownSettled = undefined;
		active?.lifetime.abort(new Error("父会话正在关闭或重载"));
		if (active) ctx.ui.notify("开发操作已停止；交接未完成，保持关闭，不自动恢复。", "warning");
	});
	return { execute: (input: ChildTask, signal: AbortSignal | undefined, ctx: ExtensionContext, update: ProgressUpdate) => execute(DEVELOPMENT_TOOL, input, signal, ctx, update),
		validate: (input: ChildTask, signal: AbortSignal | undefined, ctx: ExtensionContext, update: ProgressUpdate) => execute(VALIDATION_TOOL, input, signal, ctx, update),
		review: (input: ChildTask, signal: AbortSignal | undefined, ctx: ExtensionContext, update: ProgressUpdate) => execute(REVIEW_TOOL, input, signal, ctx, update),
		get progress() { return active?.progress?.snapshot(); },
		get pending() { return active !== undefined; } };
}
