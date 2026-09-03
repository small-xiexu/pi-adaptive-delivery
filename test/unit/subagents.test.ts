import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCurrentSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import type { SubagentLaunchContract } from "pi-subagents/preflight";

import {
	SubagentBoundary,
	pathIsInside,
	validateReadOnlyContract,
	validateWorkerContract,
} from "../../extensions/delivery-gate/src/subagents.ts";

function contract(overrides: Record<string, unknown> = {}): SubagentLaunchContract {
	const base = {
		version: 2,
		runId: "run-1",
		agent: {
			name: "scout",
			source: "builtin",
			filePath: "<builtin:scout>",
			definitionProjectionVersion: 1,
			definitionDigest: "digest",
			shadowedCandidates: [],
		},
		context: "fresh",
		modelCandidates: [],
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritGlobalContext: false,
		inheritSkills: false,
		skills: { requested: [], resolved: [], missing: [] },
		tools: {
			requestedBuiltin: ["read", "grep", "find", "ls"],
			declaredBuiltin: ["read", "grep", "find", "ls"],
			effectiveAllowlist: ["read", "grep", "find", "ls"],
			explicitAllowlist: true,
			requiredChildTools: [],
			internalTools: [],
			mcp: [],
			effectiveMcpTools: [],
			toolExtensionPaths: [],
			runtimeExtensions: [],
			configuredExtensions: [],
			extensionArgs: [],
			disableAmbientExtensions: true,
			fanoutAuthorized: false,
			capabilityAudit: { extensionsDenied: true },
		},
		roots: { cwd: "/repo" },
		protocol: { lifecycleArtifactVersion: 1, packageVersion: "0.64.0" },
		diagnostics: [],
		launchContractDigest: "launch-digest",
		digest: "contract-digest",
	};
	return { ...base, ...overrides } as unknown as SubagentLaunchContract;
}

function createEventPi() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emitted: Array<{ event: string; payload: any }> = [];
	const events = {
		on(event: string, handler: (payload: unknown) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, payload: any) {
			emitted.push({ event, payload });
			for (const handler of listeners.get(event) ?? []) handler(payload);
		},
	};
	return { pi: { events } as any, events, emitted };
}

function installPingResponder(events: ReturnType<typeof createEventPi>["events"]): void {
	events.on("subagents:rpc:v1:request", (payload: any) => {
		if (payload.method !== "ping") return;
		events.emit(`subagents:rpc:v1:reply:${payload.requestId}`, {
			version: 1,
			requestId: payload.requestId,
			success: true,
			data: { version: 1, methods: ["ping"], capabilities: { asyncSpawn: true } },
		});
	});
}

test("applies and disposes session-scoped capability ceilings", () => {
	const { pi } = createEventPi();
	const boundary = new SubagentBoundary(pi);
	const sessionId = `session-${crypto.randomUUID()}`;
	boundary.bindSession(sessionId);

	boundary.applyAccess("readonly");
	const readonly = resolveCurrentSubagentCapabilityCeiling(sessionId);
	assert.deepEqual(readonly?.allowedAgents, ["oracle", "reviewer", "scout"]);
	assert.equal(readonly?.denyExtensions, true);
	assert.equal(readonly?.allowedTools?.includes("bash"), false);
	assert.equal(readonly?.allowedTools?.includes("read"), true);

	boundary.applyAccess("validation");
	assert.deepEqual(resolveCurrentSubagentCapabilityCeiling(sessionId)?.allowedAgents, ["reviewer"]);

	boundary.dispose();
	assert.equal(resolveCurrentSubagentCapabilityCeiling(sessionId), undefined);
});

test("recognizes canonical path containment", () => {
	assert.equal(pathIsInside("/repo", "/repo"), true);
	assert.equal(pathIsInside("/repo", "/repo/file"), true);
	assert.equal(pathIsInside("/repo", "/repo-other/file"), false);
	assert.equal(pathIsInside("/repo", "/outside"), false);
});

test("accepts only builtin fresh contracts with approved tools", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-contract-root-"));
	const managed = await mkdtemp(path.join(os.tmpdir(), "adaptive-contract-managed-"));
	const output = path.join(managed, "outputs", "scout.md");
	const safe = contract({
		roots: { cwd: root, artifactsDir: managed, outputPath: output },
	});

	assert.deepEqual(await validateReadOnlyContract(safe, "scout", root), { ok: true });

	for (const unsafe of [
		contract({ ...safe, agent: { ...safe.agent, source: "project" } }),
		contract({ ...safe, context: "fork" }),
		contract({ ...safe, tools: { ...safe.tools, effectiveAllowlist: ["read", "bash"] } }),
		contract({ ...safe, tools: { ...safe.tools, fanoutAuthorized: true } }),
		contract({ ...safe, tools: { ...safe.tools, disableAmbientExtensions: false } }),
		contract({ ...safe, tools: { ...safe.tools, capabilityAudit: { extensionsDenied: false } } }),
		contract({ ...safe, tools: { ...safe.tools, effectiveMcpTools: ["mcp_write"] } }),
	]) {
		assert.equal((await validateReadOnlyContract(unsafe, "scout", root)).ok, false);
	}
});

test("rejects project, arbitrary external, and symlink-escaped output paths", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-output-root-"));
	const managed = await mkdtemp(path.join(os.tmpdir(), "adaptive-output-managed-"));
	const arbitrary = await mkdtemp(path.join(os.tmpdir(), "adaptive-output-arbitrary-"));
	await mkdir(path.join(root, "docs"));
	await symlink(arbitrary, path.join(managed, "escaped"));

	const cases = [
		contract({ roots: { cwd: root, artifactsDir: managed, outputPath: path.join(root, "report.md") } }),
		contract({ roots: { cwd: root, artifactsDir: managed, outputPath: path.join(arbitrary, "report.md") } }),
		contract({ roots: { cwd: root, artifactsDir: managed, outputPath: path.join(managed, "escaped", "report.md") } }),
		contract({ roots: { cwd: root, outputPath: path.join(arbitrary, "report.md") } }),
	];

	for (const value of cases) {
		assert.equal((await validateReadOnlyContract(value, "scout", root)).ok, false);
	}
});

test("accepts only the builtin fresh worker with the bounded mutation tools", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-worker-root-"));
	const managed = await mkdtemp(path.join(os.tmpdir(), "adaptive-worker-managed-"));
	const safe = contract({
		agent: {
			...contract().agent,
			name: "worker",
			filePath: "<builtin:worker>",
		},
		tools: {
			...contract().tools,
			requestedBuiltin: ["read", "grep", "find", "ls", "edit", "write"],
			declaredBuiltin: ["read", "grep", "find", "ls", "edit", "write"],
			effectiveAllowlist: ["read", "grep", "find", "ls", "edit", "write"],
		},
		roots: { cwd: root, artifactsDir: managed, outputPath: path.join(managed, "worker.md") },
	});

	assert.deepEqual(await validateWorkerContract(safe, root), { ok: true });
	for (const unsafe of [
		contract({ ...safe, agent: { ...safe.agent, source: "project" } }),
		contract({ ...safe, context: "fork" }),
		contract({ ...safe, tools: { ...safe.tools, effectiveAllowlist: ["read", "edit", "write", "bash"] } }),
		contract({ ...safe, tools: { ...safe.tools, effectiveAllowlist: ["read", "edit"] } }),
		contract({ ...safe, tools: { ...safe.tools, capabilityAudit: { extensionsDenied: false } } }),
	]) {
		assert.equal((await validateWorkerContract(unsafe, root)).ok, false);
	}
});

test("validates RPC ping and structured delegation response", async () => {
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-delegation-agent-"));
	const repo = await mkdtemp(path.join(os.tmpdir(), "adaptive-delegation-repo-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { pi, events } = createEventPi();
	const boundary = new SubagentBoundary(pi);
	const sessionId = `session-${crypto.randomUUID()}`;
	const model = {
		id: "adaptive-test-model",
		name: "Adaptive Test Model",
		provider: "adaptive-test",
		api: "openai-responses",
		baseUrl: "http://127.0.0.1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	};
	const ctx = {
		cwd: repo,
		model,
		modelRegistry: { getAvailable: () => [model] },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getLeafId: () => undefined,
		},
	} as any;

	try {
		boundary.bindSession(sessionId);
		boundary.applyAccess("readonly");
		installPingResponder(events);
		const task = "Inspect code";
		const initialContract = await boundary.preflight("scout", task, ctx, repo);
		const terminalContract = await boundary.preflight("scout", task, ctx, repo, "child-run");
		assert.notEqual(initialContract.launchContractDigest, terminalContract.launchContractDigest);
		assert.match(initialContract.roots.outputPath ?? "", /outputs[/\\]preflight[/\\]context\.md$/);
		assert.match(terminalContract.roots.outputPath ?? "", /outputs[/\\]child-run[/\\]context\.md$/);

		events.on("prompt-template:subagent:request", (payload: any) => {
			events.emit("prompt-template:subagent:response", {
				requestId: payload.requestId,
				ownerRunId: payload.ownerRunId,
				nodeId: payload.nodeId,
				status: "completed",
				runId: "child-run",
				launchContractDigest: terminalContract.launchContractDigest,
				result: { kind: "text", text: "read-only result" },
			});
		});

		const result = await boundary.delegate("scout", task, ctx, initialContract, repo);
		assert.deepEqual(result, {
			text: "read-only result",
			runId: "child-run",
			launchContractDigest: terminalContract.launchContractDigest,
		});
	} finally {
		boundary.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("requires exact run and launch proof for a controlled worker terminal response", async () => {
	const successHarness = createEventPi();
	installPingResponder(successHarness.events);
	const boundary = new SubagentBoundary(successHarness.pi);
	const runIds: string[] = [];
	successHarness.events.on("prompt-template:subagent:request", (payload: any) => {
		successHarness.events.emit("prompt-template:subagent:update", {
			requestId: payload.requestId,
			ownerRunId: payload.ownerRunId,
			nodeId: payload.nodeId,
			runId: "worker-run",
			currentTool: "edit",
		});
		successHarness.events.emit("prompt-template:subagent:response", {
			requestId: payload.requestId,
			ownerRunId: payload.ownerRunId,
			nodeId: payload.nodeId,
			status: "completed",
			runId: "worker-run",
			launchContractDigest: "launch-digest",
			result: { kind: "text", text: "implemented" },
		});
	});
	const result = await boundary.delegateWorker(
		"Implement approved scope",
		{ cwd: "/repo", sessionManager: { getSessionId: () => "session" } } as any,
		"launch-digest",
		{ onRunId: (runId) => runIds.push(runId) },
	);
	assert.equal(result.status, "completed");
	assert.equal(result.runId, "worker-run");
	assert.equal(result.text, "implemented");
	assert.deepEqual(runIds, ["worker-run"]);

	const missingProofHarness = createEventPi();
	installPingResponder(missingProofHarness.events);
	const missingProofBoundary = new SubagentBoundary(missingProofHarness.pi);
	missingProofHarness.events.on("prompt-template:subagent:request", (payload: any) => {
		missingProofHarness.events.emit("prompt-template:subagent:response", {
			requestId: payload.requestId,
			ownerRunId: payload.ownerRunId,
			nodeId: payload.nodeId,
			status: "failed",
			runId: "worker-run",
			error: "worker failed",
		});
	});
	await assert.rejects(
		missingProofBoundary.delegateWorker(
			"Implement approved scope",
			{ cwd: "/repo", sessionManager: { getSessionId: () => "session" } } as any,
			"launch-digest",
		),
		/launch contract digest is missing or changed/,
	);
});

test("fails closed for duplicate or failed delegation responses", async () => {
	for (const status of ["duplicate_node", "failed"] as const) {
		const { pi, events } = createEventPi();
		const boundary = new SubagentBoundary(pi);
		installPingResponder(events);
		events.on("prompt-template:subagent:request", (payload: any) => {
			events.emit("prompt-template:subagent:response", {
				requestId: payload.requestId,
				ownerRunId: payload.ownerRunId,
				nodeId: payload.nodeId,
				status,
				error: `${status} error`,
			});
		});

		await assert.rejects(
			boundary.delegate(
				"scout",
				"Inspect",
				{ cwd: process.cwd(), sessionManager: { getSessionId: () => "session" } } as any,
				contract(),
				process.cwd(),
			),
			new RegExp(`${status} error`),
		);
	}
});

test("rejects a completed read-only response without the preflight digest", async () => {
	const { pi, events } = createEventPi();
	const boundary = new SubagentBoundary(pi);
	installPingResponder(events);
	events.on("prompt-template:subagent:request", (payload: any) => {
		events.emit("prompt-template:subagent:response", {
			requestId: payload.requestId,
			ownerRunId: payload.ownerRunId,
			nodeId: payload.nodeId,
			status: "completed",
			runId: "child-run",
			result: { kind: "text", text: "unsafe result" },
		});
	});
	await assert.rejects(
		boundary.delegate(
			"scout",
			"Inspect",
			{ cwd: process.cwd(), sessionManager: { getSessionId: () => "session" } } as any,
			contract({ launchContractDigest: "a".repeat(64) }),
			process.cwd(),
		),
		/digest is missing/,
	);
});

test("aborts and times out delegation with an exact cancellation identity", async () => {
	const abortedHarness = createEventPi();
	installPingResponder(abortedHarness.events);
	const abortedBoundary = new SubagentBoundary(abortedHarness.pi);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		abortedBoundary.delegate(
			"scout",
			"Inspect",
			{ cwd: process.cwd(), sessionManager: { getSessionId: () => "session" } } as any,
			contract(),
			process.cwd(),
			controller.signal,
		),
		/aborted/,
	);
	assert.equal(
		abortedHarness.emitted.some((entry) => entry.event === "prompt-template:subagent:cancel"),
		true,
	);

	const timeoutHarness = createEventPi();
	installPingResponder(timeoutHarness.events);
	const timeoutBoundary = new SubagentBoundary(timeoutHarness.pi);
	await assert.rejects(
		timeoutBoundary.delegate(
			"scout",
			"Inspect",
			{ cwd: process.cwd(), sessionManager: { getSessionId: () => "session" } } as any,
			contract(),
			process.cwd(),
			undefined,
			5,
		),
		/timed out/,
	);
	assert.equal(
		timeoutHarness.emitted.some((entry) => entry.event === "prompt-template:subagent:cancel"),
		true,
	);
});

test("ping fails closed when no runtime owner answers", async () => {
	const { pi } = createEventPi();
	const boundary = new SubagentBoundary(pi);
	await assert.rejects(boundary.ping(5), /did not answer/);
});

test("ping fails before delegation when multiple runtime owners answer", async () => {
	const { pi, events } = createEventPi();
	const boundary = new SubagentBoundary(pi);
	events.on("subagents:rpc:v1:request", (payload: any) => {
		if (payload.method !== "ping") return;
		for (let index = 0; index < 2; index += 1) {
			events.emit(`subagents:rpc:v1:reply:${payload.requestId}`, {
				version: 1,
				requestId: payload.requestId,
				success: true,
				data: { version: 1, methods: ["ping"] },
			});
		}
	});
	await assert.rejects(boundary.ping(100), /多个 pi-subagents runtime owner/);
});
