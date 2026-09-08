#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

export async function installFakeDocker(t: TestContext, root: string, scenario: string) {
	const bin = path.join(root, "bin");
	await mkdir(bin);
	await symlink(fileURLToPath(import.meta.url), path.join(bin, "docker"));
	await writeFile(path.join(bin, "scenario"), scenario);
	const original = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${original}`;
	t.after(() => { process.env.PATH = original; });
	return { bin, audit: () => readFileSync(path.join(bin, "audit.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)) };
}

// 只有隔离单元测试的 PATH 指向此入口；生产没有 mock 开关或备用执行路径。
if (process.argv[2] === "--config" && process.argv[4] === "--host") {
	const bin = process.env.PATH!.split(path.delimiter)[0]!;
	const scenario = readFileSync(path.join(bin, "scenario"), "utf8");
	const args = process.argv.slice(2);
	const command = args[4]!;
	const audit = (phase: string) => appendFileSync(path.join(bin, "audit.jsonl"), JSON.stringify({ command, phase, args, pid: process.pid, env: Object.keys(process.env) }) + "\n");
	const stateFile = path.join(bin, "state.json");
	const save = (state: unknown) => writeFileSync(stateFile, JSON.stringify(state));
	const fail = (message: string): never => { console.error(message); process.exit(1); };
	audit("start");
	if (command === "image") {
		if (scenario === "image-missing") fail("fixture missing image");
		if (scenario === "image-output-limit") console.log("x".repeat(1024 * 1024 + 1));
		console.log(JSON.stringify({ id: `sha256:${"a".repeat(64)}`, os: "linux", volumes: scenario === "image-volume" ? { "/extra": {} } : null }));
	} else if (command === "create") {
		save({ id: "a".repeat(64), name: `/${args[args.indexOf("--name") + 1]}`, image: args.find((arg) => /^sha256:/.test(arg)),
			owner: args[args.indexOf("--name") + 1], state: { Status: "created", Running: false, Pid: 0, ExitCode: 0, Dead: false, OOMKilled: false, Error: "" } });
		if (scenario === "create-error") fail("fixture creation response lost");
		console.log(scenario === "create-invalid-id" ? "invalid-id" : "a".repeat(64));
	} else {
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		if (command === "inspect") {
			if (scenario === "identity") state.owner = "another owner";
			if (scenario === "incomplete" && state.state.Status !== "created") delete state.state.ExitCode;
			if (scenario === "inspect-error" && state.state.Status !== "created") fail("fixture engine observation lost");
			console.log(JSON.stringify(state));
		} else if (command === "start") {
			if (scenario === "start-error") fail("fixture confirmed start failure");
			const running = ["running", "structured-wait"].includes(scenario);
			state.state.Status = running ? "running" : "exited";
			state.state.Running = running;
			state.state.Pid = running ? 123 : 0;
			save(state);
			console.log(state.id);
		} else if (command === "wait") {
			if (scenario === "structured-wait") while (JSON.parse(readFileSync(stateFile, "utf8")).state.Running) await new Promise((resolve) => setTimeout(resolve, 20));
			await new Promise((resolve) => setTimeout(resolve, 300));
			audit("wait-ended");
			console.log("0");
		} else if (command === "logs") {
			if (scenario === "logs-error") fail("fixture log client failed");
			console.log(scenario === "structured-output" ? "A".repeat(100_000) + "OUTPUT_TAIL" : "fixture output");
		} else if (command === "rm") {
			if (scenario === "remove-error") fail("fixture remove failed");
			console.log(state.id);
		} else if (command === "stop") {
			if (scenario === "structured-wait") { state.state = { ...state.state, Status: "exited", Running: false, Pid: 0, ExitCode: 143 }; save(state); }
			console.log(state.id);
		}
		else fail(`unexpected fixture command ${command}`);
	}
}
