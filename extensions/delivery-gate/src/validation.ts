import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ValidationCommand } from "./plan-contract.ts";

const MAX_CAPTURED_OUTPUT_CHARS = 8_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

export type ValidationCommandStatus = "passed" | "failed" | "timed-out" | "cancelled" | "error";

export interface ValidationCommandResult {
	id: string;
	command: string;
	status: ValidationCommandStatus;
	durationMs: number;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
}

export interface ValidationBatchResult {
	status: "passed" | "failed" | "infrastructure";
	runs: ValidationCommandResult[];
	error?: string;
}

export interface ValidationProgress {
	index: number;
	total: number;
	command: ValidationCommand;
	phase: "starting" | "running" | "completed";
	elapsedMs: number;
	result?: ValidationCommandResult;
}

function boundedOutput(value: string): string | undefined {
	if (!value) return undefined;
	if (value.length <= MAX_CAPTURED_OUTPUT_CHARS) return value;
	return `[前部已截断 ${value.length - MAX_CAPTURED_OUTPUT_CHARS} 个字符]\n${value.slice(-MAX_CAPTURED_OUTPUT_CHARS)}`;
}

export function validationShell(command: string): { executable: string; args: string[] } {
	return process.platform === "win32"
		? { executable: process.env.ComSpec?.trim() || "cmd.exe", args: ["/d", "/s", "/c", command] }
		: { executable: "/bin/sh", args: ["-c", command] };
}

export async function runApprovedValidation(options: {
	pi: Pick<ExtensionAPI, "exec">;
	cwd: string;
	commands: readonly ValidationCommand[];
	signal?: AbortSignal;
	onProgress?: (progress: ValidationProgress) => void;
	heartbeatMs?: number;
}): Promise<ValidationBatchResult> {
	const runs: ValidationCommandResult[] = [];
	let commandFailed = false;
	const report = (progress: ValidationProgress) => {
		try {
			options.onProgress?.(progress);
		} catch {
			// Rendering progress must not alter command execution or evidence.
		}
	};

	for (const [index, command] of options.commands.entries()) {
		if (options.signal?.aborted) {
			return { status: "infrastructure", runs, error: "Validation was cancelled before the next approved command started" };
		}
		report({ index, total: options.commands.length, command, phase: "starting", elapsedMs: 0 });
		const startedAt = Date.now();
		const shell = validationShell(command.command);
		const heartbeat = setInterval(() => {
			report({
				index,
				total: options.commands.length,
				command,
				phase: "running",
				elapsedMs: Date.now() - startedAt,
			});
		}, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
		heartbeat.unref?.();
		try {
			const result = await options.pi.exec(shell.executable, shell.args, {
				cwd: options.cwd,
				timeout: command.timeoutMs,
				signal: options.signal,
			});
			const status: ValidationCommandStatus = result.killed
				? options.signal?.aborted ? "cancelled" : "timed-out"
				: result.code === 0 ? "passed" : "failed";
			const run: ValidationCommandResult = {
				id: command.id,
				command: command.command,
				status,
				durationMs: Date.now() - startedAt,
				exitCode: result.code,
				...(boundedOutput(result.stdout) ? { stdout: boundedOutput(result.stdout) } : {}),
				...(boundedOutput(result.stderr) ? { stderr: boundedOutput(result.stderr) } : {}),
			};
			clearInterval(heartbeat);
			runs.push(run);
			report({ index, total: options.commands.length, command, phase: "completed", elapsedMs: run.durationMs, result: run });
			if (status === "cancelled") {
				return { status: "infrastructure", runs, error: `Validation command '${command.id}' was cancelled` };
			}
			if (status === "failed" || status === "timed-out") commandFailed = true;
		} catch (error) {
			clearInterval(heartbeat);
			const run: ValidationCommandResult = {
				id: command.id,
				command: command.command,
				status: "error",
				durationMs: Date.now() - startedAt,
				stderr: boundedOutput(error instanceof Error ? error.message : String(error)),
			};
			runs.push(run);
			report({ index, total: options.commands.length, command, phase: "completed", elapsedMs: run.durationMs, result: run });
			return {
				status: "infrastructure",
				runs,
				error: `Failed to execute approved validation command '${command.id}'`,
			};
		}
	}

	return { status: commandFailed ? "failed" : "passed", runs };
}
