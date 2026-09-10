import { randomUUID } from "node:crypto";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";

export interface ExecutionReference { name: string; cwd: string }
export interface LocalExecution extends ExecutionReference {
	exitCode?: number;
	settled: boolean;
	status: "not-run" | "passed" | "failed" | "cancelled" | "timeout" | "unknown";
}

// 复用 Pi 的本机 Shell、输出和取消语义。settled 只表示本次调用已返回，不能证明任意后台后代已消失。
export function createLocalOperations(cwd: string, beforeExecute: (reference: ExecutionReference) => Promise<void>) {
	const local = createLocalBashOperations();
	let active = false;
	let lastExecution: LocalExecution | undefined;
	const operations: BashOperations = {
		async exec(command, directory, options) {
			if (active) throw new Error("本机命令尚未交回，未开始新执行");
			options.signal?.throwIfAborted();
			if (directory !== cwd) throw new Error("命令工作目录与本次交接不符");
			active = true;
			const execution: LocalExecution = { name: randomUUID(), cwd, settled: false, status: "not-run" };
			lastExecution = execution;
			try {
				await beforeExecute({ name: execution.name, cwd });
				options.signal?.throwIfAborted();
				const result = await local.exec(command, cwd, options);
				execution.exitCode = result.exitCode ?? undefined;
				execution.status = result.exitCode === 0 ? "passed" : result.exitCode === null ? "unknown" : "failed";
				return result;
			} catch (error) {
				execution.status = options.signal?.aborted ? "cancelled" : error instanceof Error && error.message.startsWith("timeout:") ? "timeout" : "failed";
				throw error;
			} finally { execution.settled = true; active = false; }
		},
	};
	return { operations, get active() { return active; }, get lastExecution() { return lastExecution; } };
}
