import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ExecutionReference, LocalExecution } from "./local-execution.ts";

export const STRUCTURED_TOOLS = ["exec_command", "write_stdin", "apply_patch", "view_image"];
export interface ExecInput { cmd: string; workdir?: string; shell?: string; tty?: boolean; login?: boolean; yield_time_ms?: number; max_output_tokens?: number }
interface ExecResult { output: string; exit_code?: number; session_id?: number; chunk_id: string; wall_time_seconds: number }
interface SessionManager {
	exec(input: ExecInput & { wait_until_exit?: boolean }, cwd: string, signal?: AbortSignal, update?: (value: ExecResult) => void): Promise<ExecResult>;
	shutdown(): Promise<void>;
}
type Update = ((result: AgentToolResult<unknown>) => void) | undefined;

// 只为固定验收使用插件的 exec bridge；普通命令、会话和补丁由原插件执行。
export function createStructuredCommands(packageRoot: string, cwd: string,
	beforeExecute: (reference: ExecutionReference, toolCallId: string, name: string) => Promise<void>) {
	const load = (relative: string) => import(pathToFileURL(path.join(packageRoot, "dist", relative)).href);
	let manager: SessionManager | undefined;
	let sessionId: number | undefined;
	let lastExecution: LocalExecution | undefined;
	let busy = false;
	let stopped = false;
	let cleanupFailed = false;
	const result = (value: ExecResult): AgentToolResult<unknown> => ({
		content: [{ type: "text", text: `${value.output}\n${value.session_id === undefined ? `Process exited with code ${value.exit_code}` : `Process running with session ID ${value.session_id}`}` }],
		details: { ...value, execution: lastExecution ? { ...lastExecution } : undefined },
	});
	const record = (value: ExecResult) => {
		sessionId = value.session_id;
		if (lastExecution) Object.assign(lastExecution, { settled: sessionId === undefined, exitCode: value.exit_code,
			status: sessionId !== undefined ? "unknown" : value.exit_code === 0 ? "passed" : value.exit_code === undefined ? "unknown" : "failed" });
		return result(value);
	};
	const stop = async () => {
		stopped = true;
		try { await manager?.shutdown(); sessionId = undefined; }
		catch (error) { cleanupFailed = true; throw error; }
	};
	const failed = async (error: unknown, signal?: AbortSignal): Promise<never> => {
		// exec 抛错不能当作原命令已经退出；等待插件真实关闭，再允许交回。
		await stop();
		if (lastExecution) Object.assign(lastExecution, { settled: true, status: signal?.aborted ? "cancelled" : "failed" });
		throw error;
	};
	return {
		async exec(id: string, input: ExecInput, signal?: AbortSignal, update?: Update) {
			if (stopped || busy || sessionId !== undefined) throw new Error("Structured 命令尚未交回或会话已关闭");
			signal?.throwIfAborted();
			busy = true;
			try {
				lastExecution = { name: randomUUID(), cwd: path.resolve(cwd, input.workdir ?? "."), settled: false, status: "not-run" };
				await beforeExecute({ name: lastExecution.name, cwd: lastExecution.cwd }, id, "exec_command");
				signal?.throwIfAborted();
				manager ??= (await load("tools/exec/session-manager.js")).createExecSessionManager();
				return record(await manager!.exec({ ...input, login: input.login ?? false, wait_until_exit: true }, cwd, signal,
					update ? (value) => update(result(value)) : undefined));
			} catch (error) { return await failed(error, signal); }
			finally { busy = false; }
		},
		async finish() {
			if (busy) throw new Error("Structured 工具仍在执行，不能交回 writer");
			const incomplete = sessionId !== undefined;
			await stop();
			return { incomplete, clean: true };
		},
		get active() { return busy || sessionId !== undefined; },
		get cleanupFailed() { return cleanupFailed; },
		get lastExecution() { return lastExecution; },
	};
}

export async function structuredPackage(tools: ToolInfo[]): Promise<{ root: string; version: string; tools: ToolInfo[] } | undefined> {
	const command = tools.find((tool) => tool.name === "exec_command");
	if (!command?.sourceInfo.path) return undefined;
	const entry = await realpath(command.sourceInfo.path);
	const root = path.dirname(path.dirname(entry));
	let metadata: { name?: string; version?: string };
	try { metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (metadata.name !== "@howaboua/pi-codex-conversion") return undefined;
	if (entry !== path.join(root, "dist", "index.js")) return undefined;
	const selected = tools.filter((tool) => STRUCTURED_TOOLS.includes(tool.name));
	return { root, version: metadata.version ?? "unknown", tools: selected };
}
