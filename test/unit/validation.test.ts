import assert from "node:assert/strict";
import test from "node:test";

import { runApprovedValidation, validationShell } from "../../extensions/delivery-gate/src/validation.ts";

test("runs only the supplied approved validation commands in order", async () => {
	const calls: Array<{ command: string; args: string[]; options: any }> = [];
	const progress: any[] = [];
	let index = 0;
	const result = await runApprovedValidation({
		pi: {
			exec: async (command: string, args: string[], options: any) => {
				calls.push({ command, args, options });
				index += 1;
				return index === 1
					? { stdout: "focused ok", stderr: "", code: 0, killed: false }
					: { stdout: "", stderr: "full failed", code: 1, killed: false };
			},
		} as any,
		cwd: "/repo",
		commands: [
			{ id: "focused", command: "npm test -- focused", timeoutMs: 10_000 },
			{ id: "full", command: "npm test", timeoutMs: 20_000 },
		],
		onProgress: (value) => progress.push(value),
	});

	assert.equal(result.status, "failed");
	assert.deepEqual(result.runs.map((run) => [run.id, run.status, run.exitCode]), [
		["focused", "passed", 0],
		["full", "failed", 1],
	]);
	assert.deepEqual(calls.map((call) => call.options), [
		{ cwd: "/repo", timeout: 10_000, signal: undefined },
		{ cwd: "/repo", timeout: 20_000, signal: undefined },
	]);
	assert.deepEqual(progress.map((value) => [value.command.id, value.phase]), [
		["focused", "starting"],
		["focused", "completed"],
		["full", "starting"],
		["full", "completed"],
	]);
	assert.equal(progress.every((value) => Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0), true);
	const shell = validationShell("npm test");
	assert.equal(calls[0]!.command, shell.executable);
	assert.deepEqual(calls[0]!.args, shell.args.map((value) => value === "npm test" ? "npm test -- focused" : value));
});

test("distinguishes timeout, cancellation, and execution infrastructure errors", async () => {
	const timedOut = await runApprovedValidation({
		pi: { exec: async () => ({ stdout: "", stderr: "timeout", code: 1, killed: true }) } as any,
		cwd: "/repo",
		commands: [{ id: "unit", command: "npm test", timeoutMs: 1000 }],
	});
	assert.equal(timedOut.status, "failed");
	assert.equal(timedOut.runs[0]?.status, "timed-out");

	const controller = new AbortController();
	controller.abort();
	const cancelled = await runApprovedValidation({
		pi: { exec: async () => assert.fail("cancelled validation must not execute") } as any,
		cwd: "/repo",
		commands: [{ id: "unit", command: "npm test", timeoutMs: 1000 }],
		signal: controller.signal,
	});
	assert.equal(cancelled.status, "infrastructure");
	assert.deepEqual(cancelled.runs, []);

	const unavailable = await runApprovedValidation({
		pi: { exec: async () => { throw new Error("spawn unavailable"); } } as any,
		cwd: "/repo",
		commands: [{ id: "unit", command: "npm test", timeoutMs: 1000 }],
	});
	assert.equal(unavailable.status, "infrastructure");
	assert.equal(unavailable.runs[0]?.status, "error");
	assert.match(unavailable.runs[0]?.stderr ?? "", /spawn unavailable/);
});

test("bounds captured validation output", async () => {
	const result = await runApprovedValidation({
		pi: { exec: async () => ({ stdout: `prefix-${"x".repeat(9000)}`, stderr: "", code: 0, killed: false }) } as any,
		cwd: "/repo",
		commands: [{ id: "unit", command: "npm test", timeoutMs: 1000 }],
	});
	assert.equal(result.status, "passed");
	assert.match(result.runs[0]?.stdout ?? "", /前部已截断/);
	assert.equal((result.runs[0]?.stdout?.length ?? 0) < 8100, true);
});

test("does not let UI progress rendering change validation evidence", async () => {
	const result = await runApprovedValidation({
		pi: { exec: async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }) } as any,
		cwd: "/repo",
		commands: [{ id: "unit", command: "npm test", timeoutMs: 1000 }],
		onProgress: () => { throw new Error("render failed"); },
	});
	assert.equal(result.status, "passed");
	assert.equal(result.runs[0]?.status, "passed");
});

test("emits a running heartbeat while one approved command is quiet", async () => {
	const phases: string[] = [];
	const result = await runApprovedValidation({
		pi: {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			},
		} as any,
		cwd: "/repo",
		commands: [{ id: "quiet", command: "quiet-check", timeoutMs: 5000 }],
		heartbeatMs: 5,
		onProgress: (progress) => phases.push(progress.phase),
	});
	assert.equal(result.status, "passed");
	assert.equal(phases[0], "starting");
	assert.equal(phases.includes("running"), true);
	assert.equal(phases.at(-1), "completed");
});
