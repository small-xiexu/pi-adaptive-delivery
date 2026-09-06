import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { truncateHead, type RpcCommand, type RpcSessionState, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const CHILD_ENV = "PI_ADAPTIVE_DELIVERY_CHILD";
export const DELEGATE_TOOL = "delivery_readonly";
export const CHILD_READY = "delivery-child-ready";
export const CHILD_EXIT = "delivery-child-exit";
export const CHILD_STOP = "delivery-child-stop";
export const DELEGATION_ENTRY = "delivery-delegation";

type Packet = { type: string; [key: string]: any };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

// 仅服务下方的一次只读委派：不实现模型循环、后台调度或完整 RPC 客户端。
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

	denyDialog(id: string): void {
		this.process.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`);
	}

	async control(name: string, entryPath: string, signal?: AbortSignal): Promise<void> {
		const { commands } = await this.request<{ commands: { name: string; sourceInfo: { path?: string } }[] }>({ type: "get_commands" }, signal);
		if (!commands.some((command) => command.name === name && command.sourceInfo?.path === entryPath)) {
			throw new Error(`子 Pi 内部命令 ${name} 的实现来源未核实，未执行`);
		}
		await this.request({ type: "prompt", message: `/${name}` }, signal);
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

interface ReadOnlyTask {
	id: string;
	task: string;
	cwd: string;
	entryPath: string;
	parentSessionId: string;
	model: { provider: string; id: string };
	thinking: string;
	tools: string[];
	projectTrusted: boolean;
}

export async function delegateReadOnly(
	input: ReadOnlyTask,
	signal: AbortSignal,
	record: (data: Record<string, unknown>) => void,
	update: (message: string) => void,
): Promise<{ text: string; sessionId: string; sessionFile: string; pid: number }> {
	signal.throwIfAborted();
	if (!input.tools.length) throw new Error("没有已启用的原生只读工具，未启动子 Pi");
	const rpc = new ChildRpc(spawn("pi", [
		"--mode", "rpc", "--extension", input.entryPath,
		"--provider", input.model.provider, "--model", input.model.id, "--thinking", input.thinking,
		"--tools", input.tools.join(","), input.projectTrusted ? "--approve" : "--no-approve",
	], { cwd: input.cwd, env: { ...process.env, [CHILD_ENV]: "1" }, stdio: ["pipe", "pipe", "pipe"] }));
	const interrupt = new AbortController();
	const operation = AbortSignal.any([signal, interrupt.signal]);
	let state: RpcSessionState | undefined;
	let text: string | null = null;
	let problem: unknown;
	const reference = () => ({ id: input.id, parentSessionId: input.parentSessionId, cwd: input.cwd,
		pid: rpc.process.pid, sessionId: state?.sessionId, sessionFile: state?.sessionFile });
	try {
		rpc.onEvent = (event) => {
			if (event.type === "tool_execution_start") update(`子任务调用 ${event.toolName}`);
			if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) {
				rpc.denyDialog(event.id);
				interrupt.abort(new Error("子任务需要交互；当前只读阶段尚未支持转发，已拒绝并暂停该任务"));
			}
		};
		await rpc.control(CHILD_READY, input.entryPath, operation);
		state = await rpc.request<RpcSessionState>({ type: "get_state" }, operation);
		const { entries } = await rpc.request<{ entries: SessionEntry[] }>({ type: "get_entries" }, operation);
		const ready = entries.filter((entry) => entry.type === "custom" && entry.customType === CHILD_READY);
		const data = ready.length === 1 && ready[0]!.type === "custom" ? ready[0]!.data as any : undefined;
		if (JSON.stringify(data?.tools) !== JSON.stringify(input.tools)) {
			throw new Error(`只读工具未对齐：需要 ${input.tools.join(",")}；实际 ${JSON.stringify(data?.tools)}。未发送任务`);
		}
		if (!state.sessionFile || state.sessionId === input.parentSessionId || state.messageCount !== 0
			|| state.isStreaming || state.pendingMessageCount !== 0 || data?.pid !== rpc.process.pid
			|| data?.sessionId !== state.sessionId || data?.cwd !== input.cwd
			|| data?.projectTrusted !== input.projectTrusted
			|| state.model?.provider !== input.model.provider || state.model?.id !== input.model.id) {
			throw new Error("子 Pi 的独立会话、受控入口、模型或只读工具未核实，未发送任务");
		}
		record({ ...reference(), phase: "started" });
		update(`只读子任务已启动，PID ${rpc.process.pid}`);
		await Promise.all([
			rpc.waitSettled(operation),
			// 不让任务正文以斜线命令的身份执行，避免绕过模型工具边界。
			rpc.request({ type: "prompt", message: `只读子任务。仅分析并提供证据，不修改文件，不继续委派。\n\n${input.task}` }, operation),
		]);
		if (rpc.toolError || rpc.openTools.size) throw new Error("子任务存在工具失败或未确认的执行终态");
	} catch (error) { problem = error; }
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
