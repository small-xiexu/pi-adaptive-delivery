import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

const INHERITED_RPC_ENV_KEYS = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"PATHEXT",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
] as const;

function isolatedRpcEnvironment(
	agentDir: string,
	overrides: Record<string, string> = {},
	inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {};
	for (const key of INHERITED_RPC_ENV_KEYS) {
		if (inherited[key] !== undefined) base[key] = inherited[key];
	}
	return {
		...base,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_ADAPTIVE_DELIVERY_STATE_DIR: path.join(agentDir, "adaptive-delivery"),
		...overrides,
	};
}

async function startLocalOpenAiServer(): Promise<{ baseUrl: string; close(): Promise<void> }> {
	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		request.resume();
		request.on("end", () => {
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const created = Math.floor(Date.now() / 1000);
			response.write(`data: ${JSON.stringify({
				id: "chatcmpl-adaptive-local",
				object: "chat.completion.chunk",
				created,
				model: "fake-model",
				choices: [{ index: 0, delta: { role: "assistant", content: "Fake read-only delegate completed." }, finish_reason: null }],
			})}\n\n`);
			response.write(`data: ${JSON.stringify({
				id: "chatcmpl-adaptive-local",
				object: "chat.completion.chunk",
				created,
				model: "fake-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

class RpcHarness {
	readonly process: ChildProcessWithoutNullStreams;
	readonly records: RpcRecord[] = [];
	private readonly pending = new Map<string, { resolve(value: RpcRecord): void; reject(error: Error): void }>();
	private stderr = "";

	constructor(cwd: string, agentDir: string, options: { fakeProvider?: boolean; deliveryGate?: boolean; packageManifest?: boolean; env?: Record<string, string> } = {}) {
		const root = process.cwd();
		if (options.packageManifest) {
			writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [root] }, null, 2)}\n`);
		}
		const fakeProviderArgs = options.fakeProvider
			? [
					"--extension",
					path.join(root, "test/support/fake-provider.ts"),
					"--model",
					"adaptive-fake/fake-model",
					]
				: [];
		const deliveryGateArgs = options.deliveryGate === false || options.packageManifest
			? []
			: ["--extension", path.join(root, "extensions/delivery-gate/index.ts")];
		const packageResourceArgs = options.packageManifest
			? []
			: [
					"--no-extensions",
					"--extension",
					path.join(root, "node_modules/pi-subagents/index.ts"),
					...deliveryGateArgs,
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
				]
		this.process = spawn(
			process.env.PI_BINARY || "pi",
			[
				"--mode",
				"rpc",
				"--no-session",
				"--offline",
				"--no-context-files",
				"--no-themes",
				...packageResourceArgs,
				...fakeProviderArgs,
			],
			{
				cwd,
				env: isolatedRpcEnvironment(agentDir, options.env),
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
						const recent = this.records.slice(-20).map((record: any) => ({
							type: record.type,
							method: record.method,
							success: record.success,
							message: record.message,
							error: record.error,
						}));
						reject(new Error(`RPC event wait timed out. stderr=${this.stderr} recent=${JSON.stringify(recent)}`));
					}
			}, 10);
		});
	}

	stop(): void {
		this.process.kill("SIGTERM");
	}
}

test("real Pi RPC child environment excludes ambient provider credentials", () => {
	const env = isolatedRpcEnvironment(
		"/tmp/adaptive-rpc-agent",
		{ PI_ADAPTIVE_TEST_PROBE: "enabled" },
		{
			PATH: "/usr/bin:/bin",
			HOME: "/tmp/home",
			OPENAI_API_KEY: "secret",
			ANTHROPIC_API_KEY: "secret",
			AWS_SECRET_ACCESS_KEY: "secret",
			GITHUB_TOKEN: "secret",
		},
	);

	assert.equal(env.PATH, "/usr/bin:/bin");
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_ADAPTIVE_TEST_PROBE, "enabled");
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(env.GITHUB_TOKEN, undefined);
});

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

test("real Pi RPC loads exactly one bundled pi-subagents runtime owner", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-owner-repo-"));
	execFileSync("git", ["init", "-q"], { cwd });
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-owner-agent-"));
	const harness = new RpcHarness(cwd, agentDir, {
		fakeProvider: true,
		packageManifest: true,
		env: { PI_ADAPTIVE_SUBAGENT_OWNER_PROBE: "1" },
	});
	try {
		const commandsResponse = await harness.send("get_commands");
		assert.equal(commandsResponse.success, true);
		const commandNames = new Set((commandsResponse.data.commands as Array<{ name: string }>).map((command) => command.name));
		for (const expected of ["parallel-review", "review-loop", "skill:pi-subagents", "skill:council-mode"]) {
			assert.equal(commandNames.has(expected), true, expected);
		}
		const response = await harness.send("prompt", { message: "/adaptive-subagent-owner-probe" });
		assert.equal(response.success, true);
		const notification = await harness.waitFor(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "notify" &&
				typeof (record as any).message === "string" &&
				((record as any).message.includes('"owners"') || (record as any).message.startsWith("subagent-owner-probe-error:")),
			10_000,
		);
		assert.equal((notification as any).message.startsWith("subagent-owner-probe-error:"), false, (notification as any).message);
		const payload = JSON.parse((notification as any).message);
		assert.equal(payload.owners.length, 1);
		assert.match(payload.owners[0], /node_modules[/\\]pi-subagents[/\\]index\.ts$/);
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

test("real Pi RPC keeps a natural-language read-only request in IDLE", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-readonly-repo-"));
	execFileSync("git", ["init", "-q"], { cwd });
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-readonly-agent-"));
	const harness = new RpcHarness(cwd, agentDir, { fakeProvider: true });
	try {
		const response = await harness.send("prompt", { message: "梳理当前项目还有哪些任务没有完成" });
		assert.equal(response.success, true);
		await harness.waitFor((record) => record.type === "agent_settled", 15_000);
		assert.equal(
			harness.records.some(
				(record: any) => record.type === "tool_execution_end" && record.toolName === "delivery_begin" && record.isError === true,
			),
			true,
		);
		await harness.send("prompt", { message: "/delivery-status" });
		assert.equal(
			harness.records.some(
				(record: any) =>
					record.type === "extension_ui_request" &&
					record.method === "notify" &&
					typeof record.message === "string" &&
					record.message.includes("空闲 [IDLE]"),
			),
			true,
		);
	} finally {
		harness.stop();
	}
});

test("real Pi RPC validates one oracle delegation with public and runtime evidence", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-oracle-repo-"));
	execFileSync("git", ["init", "-q"], { cwd });
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-oracle-agent-"));
	const localProvider = await startLocalOpenAiServer();
	writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify({
		providers: {
			"adaptive-local": {
				baseUrl: localProvider.baseUrl,
				api: "openai-completions",
				apiKey: "local-test-key",
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					supportsUsageInStreaming: false,
				},
				models: [{
					id: "fake-model",
					name: "Local Fake Model",
					reasoning: true,
					input: ["text"],
					contextWindow: 100000,
					maxTokens: 4096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
	}, null, 2)}\n`);
	writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({
		subagents: {
			agentOverrides: {
				oracle: { model: "adaptive-local/fake-model" },
			},
		},
	}, null, 2)}\n`);
	const harness = new RpcHarness(cwd, agentDir, {
		fakeProvider: true,
		env: { PI_ADAPTIVE_READONLY_DELEGATION_PROBE: "1" },
	});
	try {
		const response = await harness.send("prompt", { message: "/delivery-shape Review a bounded high-risk decision" }, 30_000);
		assert.equal(response.success, true);
		await harness.waitFor((record) => record.type === "agent_settled", 30_000);
		assert.equal(
			harness.records.some(
				(record: any) =>
					record.type === "tool_execution_end" &&
					record.toolName === "delivery_delegate_readonly" &&
					record.isError === false,
			),
			true,
			JSON.stringify(harness.records.slice(-30)),
		);
	} finally {
		harness.stop();
		await localProvider.close();
	}
});

test("real Pi RPC preserves Mermaid source and appends a display-only diagram entry", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-diagram-repo-"));
	execFileSync("git", ["init", "-q"], { cwd });
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-diagram-agent-"));
	const harness = new RpcHarness(cwd, agentDir, {
		fakeProvider: true,
		env: { PI_ADAPTIVE_DIAGRAM_PROBE: "1" },
	});
	try {
		const response = await harness.send("prompt", { message: "/delivery-shape Explain the flow" });
		assert.equal(response.success, true);
		await harness.waitFor((record) => record.type === "agent_settled", 15000);
		const status = await harness.send("prompt", { message: "/adaptive-diagram-probe-status" });
		assert.equal(status.success, true);
		const notification = await harness.waitFor(
			(record: any) =>
				record.type === "extension_ui_request" &&
				record.method === "notify" &&
				typeof record.message === "string" &&
				record.message.includes("pi-adaptive-delivery.diagrams"),
			10000,
		);
		const result = JSON.parse((notification as any).message);
		assert.deepEqual(result, {
			rawMermaid: true,
			diagramKind: "sequence",
			customType: "pi-adaptive-delivery.diagrams",
		});
	} finally {
		harness.stop();
	}
});

test("real Pi RPC validation executes the fixed host command without a child", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-validation-repo-"));
	execFileSync("git", ["init", "-q"], { cwd });
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-rpc-validation-agent-"));
	const harness = new RpcHarness(cwd, agentDir, {
		fakeProvider: true,
		deliveryGate: false,
		env: { PI_ADAPTIVE_VALIDATION_PROBE: "1" },
	});
	try {
		const response = await harness.send("prompt", { message: "/adaptive-validation-probe" }, 30000);
		assert.equal(response.success, true);
		const notification = await harness.waitFor(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "notify" &&
				typeof (record as any).message === "string" &&
				((record as any).message.includes('"status":"passed"') || (record as any).message.startsWith("validation-probe-error:")),
				30000,
			);
		assert.equal((notification as any).message.startsWith("validation-probe-error:"), false, (notification as any).message);
		const payload = JSON.parse((notification as any).message);
		assert.equal(payload.result.runs.length, 1);
		assert.equal(payload.result.runs[0].id, "runtime-probe");
		assert.equal(payload.result.runs[0].status, "passed");
		assert.equal(payload.result.runs[0].stdout, "validation-runtime-ok");
		assert.equal(harness.records.some((record: any) => record.message?.customType === "subagent-notify"), false);
	} finally {
		harness.stop();
	}
});
