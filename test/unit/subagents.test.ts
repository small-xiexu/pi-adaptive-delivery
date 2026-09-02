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
		protocol: { lifecycleArtifactVersion: 1, packageVersion: "0.62.0" },
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

test("validates RPC ping and structured delegation response", async () => {
	const { pi, events } = createEventPi();
	const boundary = new SubagentBoundary(pi);
	boundary.bindSession(`session-${crypto.randomUUID()}`);

	installPingResponder(events);
	events.on("prompt-template:subagent:request", (payload: any) => {
		events.emit("prompt-template:subagent:response", {
			requestId: payload.requestId,
			ownerRunId: payload.ownerRunId,
			nodeId: payload.nodeId,
			status: "completed",
			runId: "child-run",
			launchContractDigest: "launch-digest",
			result: { kind: "text", text: "read-only result" },
		});
	});

	const result = await boundary.delegate(
		"scout",
		"Inspect code",
		{
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "session-1" },
		} as any,
		"launch-digest",
	);
	assert.deepEqual(result, {
		text: "read-only result",
		runId: "child-run",
		launchContractDigest: "launch-digest",
	});
	boundary.dispose();
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
				"launch-digest",
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
			result: { kind: "text", text: "unsafe result" },
		});
	});
	await assert.rejects(
		boundary.delegate(
			"scout",
			"Inspect",
			{ cwd: process.cwd(), sessionManager: { getSessionId: () => "session" } } as any,
			"a".repeat(64),
		),
		/digest is missing or changed/,
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
			"launch-digest",
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
			"launch-digest",
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

test("reads validation state from the versioned public async status snapshot", async () => {
	const { pi, events } = createEventPi();
	const boundary = new SubagentBoundary(pi);
	installPingResponder(events);
	events.on("subagents:rpc:v1:request", (payload: any) => {
		if (payload.method !== "status") return;
		events.emit(`subagents:rpc:v1:reply:${payload.requestId}`, {
			version: 1,
			requestId: payload.requestId,
			success: true,
			data: {
				text: "Run: validation-run\nState: complete",
				details: { mode: "single", results: [] },
				asyncSnapshot: {
					kind: "pi-subagents.async-status-snapshot",
					version: 1,
					runs: [{ id: "validation-run", kind: "workflow", label: "validation", state: "complete" }],
				},
			},
		});
	});
	assert.deepEqual(await boundary.status("validation-run"), { state: "complete" });
	await assert.rejects(boundary.status("other-run"), /exactly one run/);
});

test("builds validation spawn only from the approved plan contract", async () => {
	const { pi, events, emitted } = createEventPi();
	const boundary = new SubagentBoundary(pi);
	installPingResponder(events);
	events.on("subagents:rpc:v1:request", (payload: any) => {
		if (payload.method !== "spawn") return;
		events.emit(`subagents:rpc:v1:reply:${payload.requestId}`, {
			version: 1,
			requestId: payload.requestId,
			success: true,
			data: { details: { asyncId: "validation-run" } },
		});
	});
	const plan = {
		version: 2,
		risk: "medium",
		complexity: "medium",
		uncertainty: "low",
		documents: {
			requirementName: "候选验证",
			solutionPath: "docs/候选验证-技术方案.md",
			planPath: "docs/候选验证-实施计划.md",
			selectionSource: "package-default",
		},
		validation: [
			{ id: "typecheck", command: "npm run typecheck", timeoutMs: 120000 },
			{ id: "unit", command: "npm test", timeoutMs: 120000 },
		],
		progressTargets: ["docs/候选验证-实施计划.md"],
		progressChecks: [],
	} as const;
	const candidate = "a".repeat(64);

	const result = await boundary.spawnValidation(plan, candidate, { cwd: "/repo" } as any);
	assert.equal(result.runId, "validation-run");
	const spawn = emitted.find((entry) => entry.event === "subagents:rpc:v1:request" && entry.payload.method === "spawn");
	assert.ok(spawn);
	const script = spawn.payload.params.workflowScript as string;
	assert.match(script, /candidate-validation/);
	assert.match(script, /npm run typecheck/);
	assert.match(script, /npm test/);
	assert.match(script, new RegExp(candidate));
	assert.equal(spawn.payload.params.context, "fresh");
	assert.equal(spawn.payload.params.async, true);
});
