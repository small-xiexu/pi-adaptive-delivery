import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";

interface RpcRecord {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	data?: any;
	method?: string;
	statusKey?: string;
	statusText?: string;
}

class RpcHarness {
	readonly process: ChildProcessWithoutNullStreams;
	readonly records: RpcRecord[] = [];
	private readonly pending = new Map<string, { resolve(value: RpcRecord): void; reject(error: Error): void }>();
	private stderr = "";

	constructor(cwd: string, agentDir: string, options: { fakeProvider?: boolean } = {}) {
		const root = process.cwd();
		const fakeProviderArgs = options.fakeProvider
			? [
					"--extension",
					path.join(root, "test/support/fake-provider.ts"),
					"--model",
					"adaptive-fake/fake-model",
				]
			: [];
		this.process = spawn(
			process.env.PI_BINARY || "pi",
			[
				"--mode",
				"rpc",
				"--no-session",
				"--offline",
				"--no-context-files",
				"--no-themes",
				"--no-extensions",
				"--extension",
				path.join(root, "node_modules/pi-subagents/index.ts"),
				"--extension",
				path.join(root, "extensions/delivery-gate/index.ts"),
				...fakeProviderArgs,
				"--no-skills",
				"--skill",
				path.join(root, "skills/adaptive-delivery/SKILL.md"),
				"--no-prompt-templates",
				"--prompt-template",
				path.join(root, "prompts/delivery-shape.md"),
				"--prompt-template",
				path.join(root, "prompts/delivery-plan.md"),
				"--prompt-template",
				path.join(root, "prompts/delivery-run.md"),
			],
			{
				cwd,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					PI_ADAPTIVE_DELIVERY_STATE_DIR: path.join(agentDir, "adaptive-delivery"),
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.process.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
		this.attachJsonl(this.process.stdout);
		this.process.on("exit", (code) => {
			if (code === null || code === 0) return;
			const error = new Error(`Pi RPC exited ${code}: ${this.stderr}`);
			for (const waiter of this.pending.values()) waiter.reject(error);
			this.pending.clear();
		});
	}

	private attachJsonl(stream: NodeJS.ReadableStream): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		stream.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			while (true) {
				const index = buffer.indexOf("\n");
				if (index < 0) break;
				let line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;
				const record = JSON.parse(line) as RpcRecord;
				this.records.push(record);
				if (record.id && record.type === "response") {
					const waiter = this.pending.get(record.id);
					if (waiter) {
						this.pending.delete(record.id);
						waiter.resolve(record);
					}
				}
			}
		});
	}

	send(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10000): Promise<RpcRecord> {
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${type} timed out. stderr=${this.stderr}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (record) => {
					clearTimeout(timer);
					resolve(record);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.process.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
		});
	}

	waitFor(predicate: (record: RpcRecord) => boolean, timeoutMs = 10000): Promise<RpcRecord> {
		const existing = this.records.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const started = Date.now();
			const timer = setInterval(() => {
				const match = this.records.find(predicate);
				if (match) {
					clearInterval(timer);
					resolve(match);
					return;
				}
				if (Date.now() - started >= timeoutMs) {
					clearInterval(timer);
					reject(new Error(`RPC event wait timed out. stderr=${this.stderr}`));
				}
			}, 10);
		});
	}

	stop(): void {
		this.process.kill("SIGTERM");
	}
}

test("real Pi RPC discovers package resources without a model call", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-repo-"));
	execFileSync("git", ["init", "-q"], { cwd });
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-agent-"));
	const harness = new RpcHarness(cwd, agentDir);
	try {
		const commandsResponse = await harness.send("get_commands");
		assert.equal(commandsResponse.success, true);
		const commands = commandsResponse.data.commands as Array<{ name: string; source: string }>;
		const names = new Set(commands.map((command) => command.name));
		for (const expected of [
			"delivery-status",
			"delivery-approve-solution",
			"delivery-approve-plan",
			"delivery-resume",
			"delivery-force-release-lease",
			"delivery-shape",
			"delivery-plan",
			"delivery-run",
			"skill:adaptive-delivery",
		]) {
			assert.equal(names.has(expected), true, expected);
		}

		const statusResponse = await harness.send("prompt", { message: "/delivery-status" });
		assert.equal(statusResponse.success, true);
		assert.equal(
			harness.records.some(
				(record) =>
					record.type === "extension_ui_request" &&
					record.method === "notify",
			),
			true,
		);
		assert.equal(harness.records.some((record) => record.type === "agent_start"), false);
	} finally {
		harness.stop();
	}
});

test("real Pi RPC runs the shaping tool lifecycle through a local fake provider", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-fake-repo-"));
	execFileSync("git", ["init", "-q"], { cwd });
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-fake-agent-"));
	const harness = new RpcHarness(cwd, agentDir, { fakeProvider: true });
	try {
		const response = await harness.send("prompt", { message: "/delivery-shape Add a safe feature" });
		assert.equal(response.success, true);
		await harness.waitFor((record) => record.type === "agent_settled", 15000);
		assert.equal(
			harness.records.some(
				(record: any) => record.type === "tool_execution_end" && record.toolName === "delivery_begin" && record.isError === false,
			),
			true,
			JSON.stringify(
				harness.records.map((record: any) => ({
					type: record.type,
					toolName: record.toolName,
					isError: record.isError,
					error: record.error,
					message: record.message,
				})),
			),
		);
		const status = await harness.send("prompt", { message: "/delivery-status" });
		assert.equal(status.success, true);
		assert.equal(
			harness.records.some(
				(record: any) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					typeof record.message === "string" &&
					record.message.includes("方案梳理中 [SHAPING]"),
			),
			true,
		);
		const confirmRequestsBefore = harness.records.filter(
			(record) => record.type === "extension_ui_request" && record.method === "confirm",
		).length;
		const approval = await harness.send("prompt", { message: "/delivery-approve-solution" });
		assert.equal(approval.success, true);
		const confirmRequestsAfter = harness.records.filter(
			(record) => record.type === "extension_ui_request" && record.method === "confirm",
		).length;
		assert.equal(confirmRequestsAfter, confirmRequestsBefore);
		await harness.send("prompt", { message: "/delivery-status" });
		assert.equal(
			harness.records.some(
				(record: any) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					typeof record.message === "string" &&
					record.message.includes("方案梳理中 [SHAPING]"),
			),
			true,
		);
	} finally {
		harness.stop();
	}
});
