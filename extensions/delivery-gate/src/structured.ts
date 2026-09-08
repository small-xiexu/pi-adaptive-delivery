import { randomInt, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createContainerOperations, type ContainerScope, type ContainerReference } from "./container.ts";

export const STRUCTURED_TOOLS = ["exec_command", "write_stdin", "apply_patch", "view_image"];
export const STRUCTURED_READ_IMAGE = "node:22-alpine";
export interface ExecInput { cmd: string; workdir?: string; shell?: string; tty?: boolean; login?: boolean; yield_time_ms?: number; max_output_tokens?: number }
export interface StdinInput { session_id: number; chars?: string; yield_time_ms?: number; max_output_tokens?: number }
type Update = ((result: AgentToolResult<unknown>) => void) | undefined;
type Runner = ReturnType<typeof createContainerOperations>;
interface Command {
	id: number;
	command: string;
	runner: Runner;
	controller: AbortController;
	done: Promise<void>;
	ready?: Promise<void>;
	output: string;
	omitted: boolean;
	startedAt: number;
	ended?: boolean;
	exitCode?: number;
	error?: unknown;
	write?: (chars: string) => Promise<void>;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// 一次交付子会话内最多一个未交回的命令。进程生命周期由 Docker 管理。
export function createStructuredCommands(scope: Omit<ContainerScope, "beforeCreate">,
	beforeCreate: (reference: ContainerReference, toolCallId: string, name: string) => Promise<void>) {
	let active: Command | undefined;
	let previous: Command | undefined;
	let stopped = false;
	let busy = false;
	const runner = (id: string, name: string, helper?: string) => createContainerOperations({ ...scope, helper,
		beforeCreate: (reference) => beforeCreate(reference, id, name) });
	const result = (state: Command, maxTokens = 4000) => {
		if (!Number.isFinite(maxTokens) || maxTokens <= 0 || maxTokens > 12_500) throw new Error("max_output_tokens 必须在 1—12500 内");
		const limit = Math.floor(maxTokens * 4);
		const output = (state.omitted || state.output.length > limit ? "[较早输出已截断]\n" : "") + state.output.slice(-limit);
		const details = { chunk_id: randomUUID(), output, wall_time_seconds: (Date.now() - state.startedAt) / 1000,
			...(state.ended ? { exit_code: state.exitCode } : { session_id: state.id }), container: state.runner.lastExecution };
		return { content: [{ type: "text" as const, text: `${output}\n${state.ended ? `Process exited with code ${state.exitCode}` : `Process running with session ID ${state.id}`}` }], details };
	};
	const poll = async (state: Command, yieldTime: number | undefined, maxTokens: number | undefined, signal: AbortSignal | undefined, update: Update, untilExit = false, chars?: string) => {
		if (busy) throw new Error("当前命令仍有原生调用在途，未并发操作同一执行");
		if (yieldTime !== undefined && (!Number.isFinite(yieldTime) || yieldTime < 0 || yieldTime > 30_000)) throw new Error("yield_time_ms 必须在 0—30000 内");
		// 参数先验证，再等待/消耗输出。
		result(state, maxTokens);
		busy = true;
		const abort = () => state.controller.abort(signal?.reason ?? new Error("Structured 调用已取消"));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const notify = setInterval(() => { try { update?.(result(state, maxTokens)); } catch { /* 仅丢弃 UI 更新。 */ } }, 250);
		try {
			await state.ready;
			if (chars) await state.write!(chars);
			if (untilExit) await state.done;
			else await Promise.race([state.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(250, yieldTime ?? 1000)); })]);
			if (signal?.aborted) { abort(); await state.done; previous = state; if (active === state) active = undefined; throw signal.reason ?? new Error("Structured 调用已取消"); }
			if (state.ended) {
				previous = state;
				if (active === state) active = undefined;
				if (state.error) throw state.error;
			}
			const value = result(state, maxTokens);
			state.output = "";
			state.omitted = false;
			return value;
		} finally { clearTimeout(timer); clearInterval(notify); signal?.removeEventListener("abort", abort); busy = false; }
	};
	return {
		async exec(id: string, input: ExecInput, signal?: AbortSignal, update?: Update, untilExit = false) {
			if (stopped || active || previous?.runner.cleanupFailed) throw new Error("Structured 命令尚未交回、收尾未知或会话已关闭");
			signal?.throwIfAborted();
			if (typeof input.cmd !== "string" || !input.cmd.trim()) throw new Error("cmd 不能为空");
			if (input.max_output_tokens !== undefined && (!Number.isFinite(input.max_output_tokens) || input.max_output_tokens <= 0 || input.max_output_tokens > 12_500)) throw new Error("max_output_tokens 必须在 1—12500 内");
			if (input.yield_time_ms !== undefined && (!Number.isFinite(input.yield_time_ms) || input.yield_time_ms < 0 || input.yield_time_ms > 30_000)) throw new Error("yield_time_ms 必须在 0—30000 内");
			const state: Command = { id: randomInt(1, 2 ** 48 - 1), command: input.cmd, runner: runner(id, "exec_command"), controller: new AbortController(),
				done: Promise.resolve(), output: "", omitted: false, startedAt: Date.now() };
			active = state;
			let ready!: () => void;
			state.ready = new Promise<void>((resolve) => { ready = resolve; });
			const decoder = new StringDecoder("utf8");
			state.done = state.runner.execute(input.cmd, scope.workspace.cwdPath, { signal: state.controller.signal, timeout: 300,
				onData(chunk) {
					state.output += decoder.write(chunk);
					if (state.output.length > 50_000) { state.output = state.output.slice(-50_000); state.omitted = true; }
				} }, { ...input, onInput: (write) => { state.write = write; }, onStarted: ready }).then((value) => { state.exitCode = value.exitCode; }, (error) => { state.error = error; })
				.finally(() => { state.output += decoder.end(); state.ended = true; ready(); });
			return poll(state, input.yield_time_ms, input.max_output_tokens, signal, update, untilExit);
		},
		async stdin(input: StdinInput, signal?: AbortSignal, update?: Update) {
			const state = active?.id === input.session_id ? active : previous?.id === input.session_id ? previous : undefined;
			if (stopped || !state) throw new Error("session_id 不属于本次会话中的命令");
			signal?.throwIfAborted();
			result(state, input.max_output_tokens);
			if (input.yield_time_ms !== undefined && (!Number.isFinite(input.yield_time_ms) || input.yield_time_ms < 0 || input.yield_time_ms > 30_000)) throw new Error("yield_time_ms 必须在 0—30000 内");
			if (input.chars) {
				if (busy || state.ended || !state.write) throw new Error("命令尚未接通输入、已退出或未使用 tty=true，不能写入");
			}
			return poll(state, input.yield_time_ms, input.max_output_tokens, signal, update, false, input.chars);
		},
		async patch(id: string, text: string, helper: string, signal?: AbortSignal) {
			if (stopped || active || busy || previous?.runner.cleanupFailed) throw new Error("命令尚未交回或收尾未知，不能同时应用补丁");
			if (scope.readonlyWorkspace) throw new Error("只读角色不提供补丁写入");
			const operation = runner(id, "apply_patch", helper);
			const state: Command = { id: randomInt(1, 2 ** 48 - 1), command: "apply_patch", runner: operation, controller: new AbortController(), done: Promise.resolve(), output: "", omitted: false, startedAt: Date.now() };
			active = state;
			const abort = () => state.controller.abort(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			const decoder = new StringDecoder("utf8");
			state.done = operation.execute(`printf %s ${quote(text)} | PI_APPLY_PATCH_JSON=1 /adaptive-helper`, scope.workspace.cwdPath,
				{ signal: state.controller.signal, timeout: 300, onData(chunk) { state.output += decoder.write(chunk); if (state.output.length > 50_000) throw new Error("补丁结果超过 50 KiB；请核对原始记录与实际文件"); } })
				.then((value) => { state.exitCode = value.exitCode; }, (error) => { state.error = error; }).finally(() => { state.output += decoder.end(); state.ended = true; });
			try {
				await state.done;
				if (state.error) throw state.error;
				let output: any;
				// 3.0.29 helper 先输出人类摘要，再输出一行 JSON，与其公开工具的解析约定一致。
				try { output = JSON.parse(state.output.trimEnd().split("\n").findLast((line) => line.trimStart().startsWith("{")) ?? ""); }
				catch (error) { throw new Error(`补丁执行器没有返回 JSON，退出码 ${state.exitCode}：${state.output}`, { cause: error }); }
				if (state.exitCode !== 0 || output.status !== "success") throw new Error(`补丁失败，可能已部分修改：${state.output}`);
				return { content: [{ type: "text" as const, text: state.output }], details: { ...output.result, container: operation.lastExecution } };
			} finally { signal?.removeEventListener("abort", abort); previous = state; active = undefined; }
		},
		async finish() {
			stopped = true;
			const incomplete = active !== undefined;
			if (active) { active.controller.abort(new Error("Structured 子会话关闭，停止未交回命令")); await active.done; previous = active; active = undefined; }
			if (previous?.runner.cleanupFailed) throw new Error("Structured 容器收尾未知");
			return { incomplete, clean: true };
		},
		get active() { return active !== undefined; },
		get cleanupFailed() { return previous?.runner.cleanupFailed || active?.runner.cleanupFailed || false; },
		get lastExecution() { return (active ?? previous)?.runner.lastExecution; },
	};
}

export async function structuredPackage(tools: ToolInfo[]): Promise<{ root: string; tools: ToolInfo[] } | undefined> {
	const command = tools.find((tool) => tool.name === "exec_command");
	if (!command?.sourceInfo.path) return undefined;
	const entry = await realpath(command.sourceInfo.path);
	const root = path.dirname(path.dirname(entry));
	let metadata: { name?: string; version?: string };
	try { metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (metadata.name !== "@howaboua/pi-codex-conversion") return undefined;
	if (metadata.version !== "3.0.29" || entry !== path.join(root, "dist", "index.js")) throw new Error("Structured 仅核实 pi-codex-conversion 3.0.29 的正式入口");
	const selected = tools.filter((tool) => STRUCTURED_TOOLS.includes(tool.name));
	if (!["exec_command", "write_stdin", "apply_patch"].every((name) => selected.some((tool) => tool.name === name))
		|| selected.some((tool) => tool.sourceInfo.path !== command.sourceInfo.path)) throw new Error("Structured 工具实现来源不完整或已覆盖");
	return { root, tools: selected };
}
