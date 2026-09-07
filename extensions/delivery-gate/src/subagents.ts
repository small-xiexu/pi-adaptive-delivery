import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { truncateHead, type BuildSystemPromptOptions, type ExtensionContext, type RpcCommand, type RpcExtensionUIResponse, type RpcSessionState, type SessionEntry, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { resolveWorkspaceIdentity } from "./workspace.ts";

export const CHILD_ENV = "PI_ADAPTIVE_DELIVERY_CHILD";
export const DELEGATE_TOOL = "delivery_readonly";
export const CHILD_READY = "delivery-child-ready";
export const CHILD_EXIT = "delivery-child-exit";
export const CHILD_STOP = "delivery-child-stop";
export const DELEGATION_ENTRY = "delivery-delegation";

type Packet = { type: string; [key: string]: any };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

export interface ReadOnlyEnvironment {
	tools: { name: string; digest: string }[];
	instructions: string;
	rules: string;
	skills: string;
}

// 只核对 Pi 已加载的基础输入，不重新发现资源，也不将规则正文复制到握手记录。
export function snapshotReadOnlyEnvironment(options: BuildSystemPromptOptions, tools: ToolInfo[]): ReadOnlyEnvironment {
	const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	return {
		tools: tools.map((tool) => ({ name: tool.name, digest: digest(tool) })).sort((a, b) => a.name.localeCompare(b.name)),
		instructions: digest([options.customPrompt ?? null, options.appendSystemPrompt ?? null]),
		rules: digest(options.contextFiles ?? []),
		skills: digest(options.skills ?? []),
	};
}

export function assertReadOnlyEnvironment(expected: ReadOnlyEnvironment, actual?: ReadOnlyEnvironment): void {
	if (JSON.stringify(expected.tools) !== JSON.stringify(actual?.tools)) {
		throw new Error(`只读工具定义或来源未对齐：需要 ${expected.tools.map((tool) => tool.name).join(",")}；实际 ${JSON.stringify(actual?.tools)}。未发送任务`);
	}
	if (expected.instructions !== actual?.instructions) throw new Error("基础指令未对齐；请按配置提供子任务所需指令。未发送任务");
	if (expected.rules !== actual?.rules) throw new Error("项目或全局规则未对齐；请核对配置与已加载内容。未发送任务");
	if (expected.skills !== actual?.skills) throw new Error("Skills 目录、来源或描述未对齐；请按配置提供子任务所需 Skill。未发送任务");
}

// 仅服务一次前台委派：不实现模型循环、后台调度或完整 RPC 客户端。
export class ChildRpc {
	readonly closed: Promise<Exit>;
	exit?: Exit;
	failure?: Error;
	settled = false;
	toolError = false;
	readonly openTools = new Set<string>();
	onEvent: (packet: Packet) => void = () => {};
	private pending = new Map<string, { command: string; finish: (error?: Error, data?: unknown) => void }>();
	private waiters = new Set<() => void>();

	constructor(readonly process: ChildProcessWithoutNullStreams) {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		process.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line || this.failure) continue;
				try { this.receive(JSON.parse(line)); }
				catch (error) { this.fail(new Error("子 Pi 协议或事件处理失败", { cause: error })); }
			}
		});
		// 不将插件的原始 stderr 自动暴露给父模型；退出码与协议错误仍显式报告。
		process.stderr.resume();
		process.on("error", (error) => this.fail(error));
		process.stdin.on("error", (error) => this.fail(error));
		this.closed = new Promise((resolve) => {
			process.once("close", (code, signal) => {
				this.exit = { code, signal };
				buffer += decoder.end();
				if (buffer.trim()) this.fail(new Error("子 Pi 输出在 JSONL 记录结束前断开"));
				for (const item of this.pending.values()) item.finish(new Error(`子 Pi 提前退出：${code}/${signal}`));
				this.wake();
				resolve(this.exit);
			});
		});
	}

	private receive(value: unknown): void {
		if (!value || typeof value !== "object" || typeof (value as Packet).type !== "string") {
			throw new Error("缺少 RPC 消息类型");
		}
		const packet = value as Packet;
		if (packet.type === "response") {
			const item = this.pending.get(packet.id);
			if (!item) return; // 迟到或关联 ID 不匹配的响应不能完成当前请求。
			if (packet.command !== item.command || typeof packet.success !== "boolean") throw new Error("RPC 响应不匹配");
			item.finish(packet.success ? undefined : new Error(`Pi ${item.command} 拒绝：${String(packet.error)}`), packet.data);
			return;
		}
		if (packet.type === "agent_start") this.settled = false;
		if (packet.type === "agent_settled") this.settled = true;
		if (packet.type === "tool_execution_start") {
			if (typeof packet.toolCallId !== "string" || this.openTools.has(packet.toolCallId)) throw new Error("工具开始事件无效");
			this.openTools.add(packet.toolCallId);
		}
		if (packet.type === "tool_execution_end") {
			if (!this.openTools.delete(packet.toolCallId) || typeof packet.isError !== "boolean") throw new Error("工具终态无对应开始事件");
			this.toolError ||= packet.isError;
		}
		if (packet.type === "extension_error") throw new Error(`子扩展事件失败：${String(packet.event)}`);
		this.onEvent(packet);
		this.wake();
	}

	private wake(): void { for (const listener of this.waiters) listener(); }
	private fail(error: Error): void {
		this.failure ??= error;
		for (const item of this.pending.values()) item.finish(this.failure);
		this.wake();
	}

	request<T = unknown>(command: RpcCommand, signal?: AbortSignal): Promise<T> {
		return new Promise((resolve, reject) => {
			if (this.failure || this.exit || signal?.aborted) {
				reject(this.failure ?? signal?.reason ?? new Error("子 Pi 已关闭"));
				return;
			}
			const id = randomUUID();
			const finish = (error?: Error, data?: unknown) => {
				clearTimeout(timer);
				this.pending.delete(id);
				signal?.removeEventListener("abort", abort);
				if (error) reject(error); else resolve(data as T);
			};
			const abort = () => finish(signal?.reason ?? new Error("委派已取消"));
			const timer = setTimeout(() => finish(new Error(`等待 Pi ${command.type} 响应超时`)), 15_000);
			this.pending.set(id, { command: command.type, finish });
			signal?.addEventListener("abort", abort, { once: true });
			try { this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`); }
			catch (error) { finish(new Error("子 Pi 输入连接不可写", { cause: error })); }
		});
	}

	waitSettled(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const check = () => {
				const error = this.failure ?? (signal.aborted ? signal.reason : this.exit ? new Error("未收到稳定终态即退出") : undefined);
				if (!error && !this.settled) return;
				this.waiters.delete(check);
				signal.removeEventListener("abort", check);
				if (error) reject(error); else resolve();
			};
			this.waiters.add(check);
			signal.addEventListener("abort", check, { once: true });
			check();
		});
	}

	respondDialog(response: RpcExtensionUIResponse): void {
		if (this.failure || this.exit) throw this.failure ?? new Error("子 Pi 已关闭，不能发送交互回复");
		this.process.stdin.write(`${JSON.stringify(response)}\n`);
	}

	async control(name: string, entryPath: string, signal?: AbortSignal, args = ""): Promise<void> {
		const { commands } = await this.request<{ commands: { name: string; sourceInfo: { path?: string } }[] }>({ type: "get_commands" }, signal);
		if (!commands.some((command) => command.name === name && command.sourceInfo?.path === entryPath)) {
			throw new Error(`子 Pi 内部命令 ${name} 的实现来源未核实，未执行`);
		}
		await this.request({ type: "prompt", message: `/${name}${args ? ` ${args}` : ""}` }, signal);
	}

	async stop(entryPath?: string): Promise<Exit> {
		if (this.exit) return this.exit;
		let problem: unknown;
		let shutdownRequested = false;
		try {
			await this.request({ type: "clear_queue" });
			await this.request({ type: "abort" });
			if (entryPath) {
				await this.control(CHILD_STOP, entryPath);
				shutdownRequested = true;
			}
		} catch (error) { problem = error; }
		const terminate = (signal: NodeJS.Signals) => {
			try { this.process.kill(signal); } catch (error) { problem ??= error; }
		};
		if (!this.exit && !shutdownRequested) terminate("SIGTERM");
		let forced = false;
		const killTimer = setTimeout(() => {
			if (!this.exit) { forced = true; terminate("SIGKILL"); }
		}, 5000);
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([this.closed, new Promise<never>((_resolve, reject) => {
				deadline = setTimeout(() => reject(new Error(`无法证明子 Pi 已关闭，PID ${this.process.pid}`)), 10_000);
			})]);
			if (problem || forced) throw new Error(`子 Pi 收尾异常：${problem ? String(problem) : "被迫 SIGKILL"}，不作为成功证据`, { cause: problem });
			return result;
		} finally {
			clearTimeout(killTimer);
			clearTimeout(deadline);
		}
	}
}

type DialogContext = Pick<ExtensionContext, "mode" | "ui" | "abort">;

// 一次委派只承接一个普通问题，不转发批准、父编辑器或其他持久 UI 状态。
export function createChildDialogs(rpc: ChildRpc, ctx: DialogContext, signal: AbortSignal, interrupt: AbortController) {
	let pending: Promise<void> | undefined;
	let dialog: AbortController | undefined;
	let closed = false;
	let failure: unknown;
	const pause = (error: unknown) => {
		failure ??= error;
		interrupt.abort(error);
		if (ctx.mode === "tui") {
			try { ctx.abort(); }
			catch (abortError) { failure = new AggregateError([failure, abortError], "子交互失败且父中止失败"); }
		}
	};
	const cancel = (id: string) => {
		if (!rpc.exit && !rpc.failure) rpc.respondDialog({ type: "extension_ui_response", id, cancelled: true });
	};
	return {
		handle(event: Packet) {
			if (pending && ["tool_execution_end", "agent_settled"].includes(event.type)) {
				pause(new Error("子交互尚未回答但原任务已结束，丢弃回答并暂停"));
				dialog?.abort(failure);
			}
			if (event.type !== "extension_ui_request" || !["select", "confirm", "input", "editor"].includes(event.method)) return;
			if (typeof event.id !== "string" || !event.id) throw new Error("子交互缺少关联 ID");
			if (closed || signal.aborted || pending) {
				pause(new Error("子交互已关闭或出现并发请求，未接受新回答"));
				dialog?.abort(failure);
				cancel(event.id);
				return;
			}
			const controller = dialog = new AbortController();
			pending = Promise.resolve().then(async () => {
				try {
					if (ctx.mode !== "tui" || event.method === "editor") throw new Error(`子任务需要 ${event.method} 交互；只支持父 TUI 的普通选择、确认和输入，已暂停`);
					if (typeof event.title !== "string" || event.timeout !== undefined && (!Number.isInteger(event.timeout) || event.timeout <= 0 || event.timeout > 2_147_483_647)) throw new Error("子交互标题或超时参数无效");
					const waiting = AbortSignal.any([signal, controller.signal, ...(event.timeout ? [AbortSignal.timeout(event.timeout)] : [])]);
					waiting.throwIfAborted();
					const title = `子任务 PID ${rpc.process.pid}：普通询问，不授予交付权限\n${event.title}`;
					let value: string | boolean | undefined;
					if (event.method === "select") {
						if (!Array.isArray(event.options) || !event.options.length || !event.options.every((item: unknown) => typeof item === "string")) throw new Error("子交互选项无效");
						value = await ctx.ui.select(title, [...event.options], { signal: waiting, timeout: event.timeout });
						if (value !== undefined && !event.options.includes(value)) throw new Error("子交互回答不在本次选项内");
					} else if (event.method === "confirm") {
						if (typeof event.message !== "string") throw new Error("子交互确认正文无效");
						value = await ctx.ui.confirm(title, event.message, { signal: waiting, timeout: event.timeout });
					} else {
						if (event.placeholder !== undefined && typeof event.placeholder !== "string") throw new Error("子交互输入提示无效");
						value = await ctx.ui.input(title, event.placeholder, { signal: waiting, timeout: event.timeout });
					}
					waiting.throwIfAborted();
					if (value === undefined || value === false) throw new Error("用户取消或拒绝子问题，已暂停当前任务");
					rpc.respondDialog(event.method === "confirm" ? { type: "extension_ui_response", id: event.id, confirmed: value === true }
						: { type: "extension_ui_response", id: event.id, value: value as string });
				} catch (error) {
					pause(error);
					try { cancel(event.id); }
					catch (responseError) { failure = new AggregateError([failure, responseError], "子交互失败且取消回复失败"); }
				} finally { pending = undefined; dialog = undefined; }
			});
		},
		async close() {
			closed = true;
			dialog?.abort(new Error("子任务正在收尾，丢弃未决交互"));
			await pending;
			if (failure) throw failure;
		},
	};
}

export interface ChildTask {
	id: string;
	task: string;
	cwd: string;
	entryPath: string;
	parentSessionId: string;
	model: { provider: string; id: string };
	thinking: string;
	environment: ReadOnlyEnvironment;
	projectTrusted: boolean;
}

export async function startChild(input: ChildTask, kind: "readonly" | "development"): Promise<ChildRpc> {
	const tools = input.environment.tools.map((tool) => tool.name);
	if (!tools.length) throw new Error("没有已启用的原生只读工具，未启动子 Pi");
	if (kind === "development") tools.push("edit", "write", "bash");
	const { workspacePath } = await resolveWorkspaceIdentity(input.cwd);
	const outside = (file: string) => {
		const relative = path.relative(workspacePath, file);
		return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	};
	let executable: string | undefined;
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.resolve(input.cwd, directory, "pi");
		try { await access(candidate, constants.X_OK); }
		catch (error) {
			if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
			throw error;
		}
		const file = await realpath(candidate);
		if (!outside(candidate) || !outside(file) || !(await stat(file)).isFile()) throw new Error("Pi 入口必须是工作区外的已安装标准 CLI，未执行项目入口");
		executable = file;
		break;
	}
	if (!executable) throw new Error("没有可用的已安装标准 Pi CLI，未启动子任务");
	const node = await realpath(process.execPath);
	if (!outside(node)) throw new Error("Pi 的 Node 解释器必须在工作区外");
	// 不经 /usr/bin/env node 再次解析 PATH；仅支持当前标准 Node CLI 入口。
	return new ChildRpc(spawn(node, [executable,
		"--mode", "rpc", "--extension", input.entryPath,
		"--provider", input.model.provider, "--model", input.model.id, "--thinking", input.thinking,
		"--tools", tools.join(","), input.projectTrusted ? "--approve" : "--no-approve",
	], { cwd: input.cwd, env: { ...process.env, [CHILD_ENV]: kind === "development" ? "development" : "1" }, stdio: ["pipe", "pipe", "pipe"] }));
}

export async function readyChild(rpc: ChildRpc, input: ChildTask, signal: AbortSignal, recordState: (state: RpcSessionState) => void) {
	await rpc.control(CHILD_READY, input.entryPath, signal, input.id);
	const state = await rpc.request<RpcSessionState>({ type: "get_state" }, signal);
	recordState(state);
	const { entries } = await rpc.request<{ entries: SessionEntry[] }>({ type: "get_entries" }, signal);
	const ready = entries.filter((entry) => entry.type === "custom" && entry.customType === CHILD_READY);
	const data = ready.length === 1 && ready[0]!.type === "custom" ? ready[0]!.data as any : undefined;
	assertReadOnlyEnvironment(input.environment, data?.environment);
	if (!state.sessionFile || state.sessionId === input.parentSessionId || state.messageCount !== 0
		|| state.isStreaming || state.pendingMessageCount !== 0 || data?.pid !== rpc.process.pid
		|| data?.sessionId !== state.sessionId || data?.cwd !== input.cwd || data?.entryPath !== input.entryPath
		|| data?.projectTrusted !== input.projectTrusted
		|| state.model?.provider !== input.model.provider || state.model?.id !== input.model.id
		|| state.thinkingLevel !== input.thinking) {
		throw new Error("子 Pi 的独立会话、受控入口、模型或只读工具未核实，未发送任务");
	}
	return { state, data };
}

export async function delegateReadOnly(
	input: ChildTask,
	signal: AbortSignal,
	record: (data: Record<string, unknown>) => void,
	update: (message: string) => void,
	ctx: DialogContext,
): Promise<{ text: string; sessionId: string; sessionFile: string; pid: number }> {
	signal.throwIfAborted();
	const rpc = await startChild(input, "readonly");
	const interrupt = new AbortController();
	const operation = AbortSignal.any([signal, interrupt.signal]);
	const dialogs = createChildDialogs(rpc, ctx, operation, interrupt);
	let state: RpcSessionState | undefined;
	let text: string | null = null;
	let problem: unknown;
	const reference = () => ({ id: input.id, parentSessionId: input.parentSessionId, cwd: input.cwd,
		pid: rpc.process.pid, sessionId: state?.sessionId, sessionFile: state?.sessionFile });
	try {
		rpc.onEvent = (event) => {
			if (event.type === "tool_execution_start") update(`子任务调用 ${event.toolName}`);
			dialogs.handle(event);
		};
		await readyChild(rpc, input, operation, (value) => { state = value; });
		record({ ...reference(), phase: "started" });
		update(`只读子任务已启动，PID ${rpc.process.pid}`);
		await Promise.all([
			rpc.waitSettled(operation),
			// 不让任务正文以斜线命令的身份执行，避免绕过模型工具边界。
			rpc.request({ type: "prompt", message: `只读子任务。仅分析并提供证据，不修改文件，不继续委派。\n\n${input.task}` }, operation),
		]);
		if (rpc.toolError || rpc.openTools.size) throw new Error("子任务存在工具失败或未确认的执行终态");
	} catch (error) { problem = error; }
	try { await dialogs.close(); }
	catch (error) { problem ??= error; }
	try { await rpc.stop(input.entryPath); }
	catch (error) { problem = new Error(`${problem ? `${String(problem)}；` : ""}收尾失败：${String(error)}`, { cause: error }); }
	if (!problem && (rpc.exit?.code !== 0 || rpc.exit.signal !== null || rpc.failure || rpc.openTools.size)) {
		problem = new Error("子 Pi 的关闭或工具终态未核实");
	}
	if (!problem && state?.sessionFile) {
		try {
			const rows = (await readFile(state.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			if (rows[0]?.id !== state.sessionId || !rows.some((row) => row.type === "custom" && row.customType === CHILD_EXIT
				&& row.data?.pid === rpc.process.pid && row.data?.sessionId === state!.sessionId)) {
				throw new Error("未找到子 Pi 的持久关闭记录");
			}
			// 最终正文只从已关闭进程的原生记录取得，不把 RPC 内存读回当成落盘证明。
			const last = rows.findLast((row) => row.type === "message" && row.message?.role === "assistant")?.message;
			if (last?.stopReason !== "stop") throw new Error("子任务没有正常完成的持久模型终态");
			text = last.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("").trim();
			if (!text) throw new Error("子任务没有可核对的最终正文");
		} catch (error) { problem = error; }
	}
	if (operation.aborted) problem ??= operation.reason;
	record({ ...reference(), phase: "ended", status: !rpc.exit || rpc.openTools.size ? "unknown" : operation.aborted ? "cancelled" : problem ? "failed" : "completed",
		exit: rpc.exit, error: problem ? String(problem) : undefined });
	if (problem) throw new Error(`只读委派未成功：${String(problem)}`);
	const output = truncateHead(text!);
	return { text: `${output.content}${output.truncated ? "\n[已截断，完整结果见子会话记录]" : ""}`,
		sessionId: state!.sessionId, sessionFile: state!.sessionFile!, pid: rpc.process.pid! };
}
