import type { BashToolInput } from "@earendil-works/pi-coding-agent";
import { captureCandidate, type CandidateSnapshot, type CandidateScope } from "./candidate.ts";
import type { LocalExecution } from "./local-execution.ts";

export interface ValidationProof {
	before: CandidateSnapshot;
	after?: CandidateSnapshot;
	commands: string[];
	results: { toolCallId?: string; timeout?: number; status: LocalExecution["status"]; exitCode?: number; execution?: string }[];
	environment: { platform: string; arch: string; node: string };
	error?: string;
}

// 只记录本次固定验收的真实执行引用；权限、Pi 队列与调用收尾仍由原开发路径负责。
export async function createValidationRun(scope: CandidateScope, commands: readonly string[], before: CandidateSnapshot) {
	if (!commands.length || commands.some((command) => typeof command !== "string" || !command.trim())) throw new Error("没有明确的固定验收命令，不能报告验收通过");
	const proof: ValidationProof = { before: structuredClone(before), commands: [...commands], results: commands.map(() => ({ status: "not-run" })),
		environment: { platform: process.platform, arch: process.arch, node: process.version } };
	let next = 0;
	return {
		async execute<T>(id: string, input: BashToolInput, execute: () => Promise<T>, execution: () => LocalExecution | undefined) {
			if (next >= proof.commands.length || next > 0 && proof.results[next - 1]!.status !== "passed" || input.command !== proof.commands[next]) {
				throw new Error("固定验收只按原清单顺序执行；不能替换命令、失败后继续或重放");
			}
			const index = next++;
			const previous = execution()?.name;
			proof.results[index] = { toolCallId: id, timeout: input.timeout, status: "not-run" };
			try { return await execute(); }
			finally {
				const actual = execution();
				if (actual && actual.name !== previous && actual.settled) Object.assign(proof.results[index]!, { status: actual.status, exitCode: actual.exitCode, execution: actual.name });
			}
		},
		async finish(): Promise<ValidationProof> {
			try { proof.after = await captureCandidate(scope, proof.commands); }
			catch (error) { proof.error = String(error); }
			return structuredClone(proof);
		},
	};
}

export function validationPassed(proof: ValidationProof): boolean {
	return !proof.error && proof.before.digest === proof.after?.digest && proof.commands.length > 0
		&& proof.results.length === proof.commands.length && proof.results.every((result) => result.status === "passed" && result.exitCode === 0 && Boolean(result.toolCallId));
}
