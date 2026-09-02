import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCurrentSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";

import deliveryGate from "../../extensions/delivery-gate/index.ts";
import { digestApprovalContent } from "../../extensions/delivery-gate/src/approvals.ts";
import { digestPlanningDocumentContent } from "../../extensions/delivery-gate/src/planning-documents.ts";
import {
	DELIVERY_STATE_CUSTOM_TYPE,
	createInitialRuntimeState,
} from "../../extensions/delivery-gate/src/runtime-state.ts";

type Handler = (...args: any[]) => unknown;
let harnessSequence = 0;
const TEST_REQUIREMENT_NAME = "Canvas写路径拆分";
const TEST_SOLUTION_PATH = `docs/${TEST_REQUIREMENT_NAME}-技术方案.md`;
const TEST_PLAN_PATH = `docs/${TEST_REQUIREMENT_NAME}-实施计划.md`;

interface FakeUi {
	statuses: Array<[string, string | undefined]>;
	notifications: Array<[string, string | undefined]>;
	setStatus(key: string, value: string | undefined): void;
	notify(message: string, level?: string): void;
	confirm(title: string, message: string): Promise<boolean>;
	theme: { fg(_color: string, text: string): string };
}

function createHarness(
	cwd = process.cwd(),
	options: { sessionId?: string; stateRoot?: string } = {},
) {
	const sessionId = options.sessionId ?? `session-${++harnessSequence}`;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const tools = new Map<string, any>();
	const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
	const emittedEvents: Array<{ event: string; payload: any }> = [];
	const markdownTransformers: Array<(markdown: string, context: { messageType: string }) => string> = [];
	const sentMessages: Array<{ message: any; options?: any }> = [];
	const sentUserMessages: Array<{ content: any; options?: any }> = [];
	let activeTools = ["read", "grep", "find", "ls", "edit", "write", "bash", "subagent", "bg_wait"];
	let setActiveToolsCalls = 0;
	const failSetActiveToolsCalls = new Set<number>();
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	let failAppend = false;
	let mode: "tui" | "rpc" | "json" | "print" = "tui";
	let confirmResult = false;
	let confirmCalls = 0;
	const confirmationRequests: Array<{ title: string; message: string }> = [];
	let execResult = { stdout: `${cwd}\n`, stderr: "", code: 0, killed: false };
	const execCalls: Array<{ command: string; args: string[] }> = [];
	let reviewText = "Merge verdict: OK";
	let validationStatusState = "complete";
	let failSendUserMessage = false;
	const ui: FakeUi = {
		statuses: [],
		notifications: [],
		setStatus(key, value) {
			this.statuses.push([key, value]);
		},
		notify(message, level) {
			this.notifications.push([message, level]);
		},
		confirm: async (title, message) => {
			confirmCalls += 1;
			confirmationRequests.push({ title, message });
			return confirmResult;
		},
		theme: { fg: (_color, text) => text },
	};
	let branch: any[] = [];

	const pi = {
		events: {
			on(event: string, handler: (payload: unknown) => void) {
				const listeners = eventListeners.get(event) ?? new Set();
				listeners.add(handler);
				eventListeners.set(event, listeners);
				return () => listeners.delete(handler);
			},
			emit(event: string, payload: any) {
				emittedEvents.push({ event, payload });
				for (const handler of eventListeners.get(event) ?? []) handler(payload);
			},
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			setActiveToolsCalls += 1;
			if (failSetActiveToolsCalls.has(setActiveToolsCalls)) throw new Error("setActiveTools injected failure");
			activeTools = [...names];
		},
		registerCommand: (name: string, options: { handler: Handler }) => {
			commands.set(name, options);
		},
		registerTool: (definition: { name: string }) => {
			tools.set(definition.name, definition);
		},
		registerMarkdownTransformer: (transformer: (markdown: string, context: { messageType: string }) => string) => {
			markdownTransformers.push(transformer);
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args: [...args] });
			return { ...execResult };
		},
		appendEntry: (customType: string, data: unknown) => {
			if (failAppend) throw new Error("append failed");
			appendedEntries.push({ customType, data });
			return "entry-id";
		},
		sendMessage: (message: unknown, options?: unknown) => {
			sentMessages.push({ message, options });
		},
		sendUserMessage: (content: unknown, options?: unknown) => {
			if (failSendUserMessage) throw new Error("sendUserMessage injected failure");
			sentUserMessages.push({ content, options });
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		get mode() {
			return mode;
		},
		cwd,
		ui,
		model: undefined,
		thinkingLevel: "high",
		waitForIdle: async () => {},
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getBranch: () => branch,
			getLeafId: () => {
				const last = branch.at(-1) as { id?: string } | undefined;
				return last?.id;
			},
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;

	const previousStateDir = process.env.PI_ADAPTIVE_DELIVERY_STATE_DIR;
	const stateRoot = options.stateRoot ?? mkdtempSync(path.join(os.tmpdir(), "adaptive-extension-state-"));
	process.env.PI_ADAPTIVE_DELIVERY_STATE_DIR = stateRoot;
	try {
		deliveryGate(pi);
	} finally {
		if (previousStateDir === undefined) delete process.env.PI_ADAPTIVE_DELIVERY_STATE_DIR;
		else process.env.PI_ADAPTIVE_DELIVERY_STATE_DIR = previousStateDir;
	}

	return {
		handlers,
		commands,
		tools,
		ctx,
		ui,
		sessionId,
		stateRoot,
		appendedEntries,
		sentMessages,
		sentUserMessages,
		eventListeners,
		emittedEvents,
		markdownTransformers,
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			setActiveToolsCalls += 1;
			if (failSetActiveToolsCalls.has(setActiveToolsCalls)) throw new Error("setActiveTools injected failure");
			activeTools = [...names];
		},
		setBranch: (entries: any[]) => {
			branch = entries;
		},
		failNextAppend: () => {
			failAppend = true;
		},
		setMode: (next: typeof mode) => {
			mode = next;
		},
		setConfirmResult: (value: boolean) => {
			confirmResult = value;
		},
		getConfirmCalls: () => confirmCalls,
		confirmationRequests,
		execCalls,
		setExecResult: (result: typeof execResult) => {
			execResult = result;
		},
		setReviewText: (value: string) => {
			reviewText = value;
		},
		getReviewText: () => reviewText,
		setValidationStatusState: (value: string) => {
			validationStatusState = value;
		},
		getValidationStatusState: () => validationStatusState,
		failAutomaticContinuation: () => {
			failSendUserMessage = true;
		},
		failSetActiveToolsOnFutureCalls: (offsets: number[]) => {
			for (const offset of offsets) failSetActiveToolsCalls.add(setActiveToolsCalls + offset);
		},
	};
}

function candidateRepo(): string {
	const repo = mkdtempSync(path.join(os.tmpdir(), "adaptive-extension-candidate-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
	mkdirSync(path.join(repo, "docs"));
	execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], {
		cwd: repo,
	});
	return repo;
}

function installSubagentRpcResponder(harness: ReturnType<typeof createHarness>): void {
	harness.eventListeners.set("subagents:rpc:v1:request", new Set([(payload: any) => {
		if (payload.method === "ping") {
			for (const handler of harness.eventListeners.get(`subagents:rpc:v1:reply:${payload.requestId}`) ?? []) {
				handler({
					version: 1,
					requestId: payload.requestId,
					success: true,
					data: { version: 1, methods: ["ping"], capabilities: { asyncSpawn: true } },
				});
			}
			return;
		}
		if (payload.method === "spawn") {
			for (const handler of harness.eventListeners.get(`subagents:rpc:v1:reply:${payload.requestId}`) ?? []) {
				handler({
					version: 1,
					requestId: payload.requestId,
					success: true,
					data: { details: { asyncId: "validation-run" } },
				});
			}
			return;
		}
			if (payload.method === "status") {
				const state = harness.getValidationStatusState();
				for (const handler of harness.eventListeners.get(`subagents:rpc:v1:reply:${payload.requestId}`) ?? []) {
				handler({
					version: 1,
					requestId: payload.requestId,
					success: true,
						data: {
							text: `Run: validation-run\nState: ${state}`,
							details: { mode: "single", results: [] },
							asyncSnapshot: {
								kind: "pi-subagents.async-status-snapshot",
								version: 1,
								runs: [{ id: "validation-run", kind: "workflow", label: "validation", state }],
							},
						},
				});
			}
		}
	}]));
	harness.eventListeners.set("prompt-template:subagent:request", new Set([(payload: any) => {
		const digest = /^readonly-(?:scout|oracle|reviewer)-([a-f0-9]{64})-/.exec(payload.nodeId)?.[1];
		for (const handler of harness.eventListeners.get("prompt-template:subagent:response") ?? []) {
			handler({
				requestId: payload.requestId,
				ownerRunId: payload.ownerRunId,
				nodeId: payload.nodeId,
				status: "completed",
				runId: "review-run",
				launchContractDigest: digest,
				result: { kind: "text", text: harness.getReviewText() },
			});
		}
	}]));
}

function approvalBranch(state: string, sessionId = "fixture-session", cwd = process.cwd()) {
	const hasPlan = ["PLAN_PENDING_APPROVAL", "COMBINED_PENDING_APPROVAL", "IMPLEMENTING", "VALIDATING", "REWORKING"].includes(state);
	const planContract = {
			version: 2,
			risk: "medium",
			complexity: "medium",
			uncertainty: "low",
			documents: {
				requirementName: TEST_REQUIREMENT_NAME,
				solutionPath: TEST_SOLUTION_PATH,
				planPath: TEST_PLAN_PATH,
				selectionSource: "project",
			},
			validation: [{ id: "unit", command: "npm test", timeoutMs: 120000 }],
			progressTargets: [TEST_PLAN_PATH],
			progressChecks: [{ id: "diff-check", command: "git", args: ["diff", "--check"], timeoutMs: 30000 }],
		} as const;
	const solutionDocument = [
		"<!-- adaptive-delivery:solution:start -->",
		`# ${TEST_REQUIREMENT_NAME}-技术方案`,
		"",
		"保持公开行为不变。",
		"",
		"```adaptive-delivery-documents",
		JSON.stringify({ version: 1, ...planContract.documents }),
		"```",
		"<!-- adaptive-delivery:solution:end -->",
	].join("\n");
	const planDocument = [
		"<!-- adaptive-delivery:plan:start -->",
		`# ${TEST_REQUIREMENT_NAME}-实施计划`,
		"",
		"Status: pending",
		"",
		"```adaptive-delivery-plan",
		JSON.stringify(planContract),
		"```",
		"<!-- adaptive-delivery:plan:end -->",
	].join("\n");
	const artifact = hasPlan
		? state === "COMBINED_PENDING_APPROVAL"
			? `${solutionDocument}\n\n${planDocument}`
			: planDocument
		: state === "SOLUTION_PENDING_APPROVAL"
			? solutionDocument
			: `${state} artifact`;
	const canonicalCwd = realpathSync(cwd);
	const gitRoot = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim());
	const solutionContent = [{ type: "text", text: solutionDocument }];
	const solutionApproval = {
		version: 1,
		kind: "solution",
		sessionId,
		entryId: "assistant-solution",
		contentDigest: digestApprovalContent(solutionContent),
		branchAnchorEntryId: "solution-anchor",
		canonicalCwd,
		gitRoot,
		approvedAt: "2026-01-01T00:00:00.000Z",
	};
	const planContent = [{ type: "text", text: artifact }];
	const planApproval = {
		version: 1,
		kind: "plan",
		sessionId,
		entryId: "assistant-1",
		contentDigest: digestApprovalContent(planContent),
		branchAnchorEntryId: "state-1",
		canonicalCwd,
		gitRoot,
		approvedAt: "2026-01-01T00:01:00.000Z",
	};
	const needsSolution = ["PLANNING", "PLAN_PENDING_APPROVAL", "IMPLEMENTING", "VALIDATING", "REWORKING", "BLOCKED"].includes(state);
	const needsPlanApproval = ["IMPLEMENTING", "VALIDATING", "REWORKING"].includes(state);
	const extractedSolution = `${`# ${TEST_REQUIREMENT_NAME}-技术方案`}\n\n保持公开行为不变。\n`;
	const extractedPlan = `${`# ${TEST_REQUIREMENT_NAME}-实施计划`}\n\nStatus: pending\n`;
	if (needsPlanApproval) {
		writeFileSync(path.join(cwd, TEST_SOLUTION_PATH), extractedSolution);
		writeFileSync(path.join(cwd, TEST_PLAN_PATH), extractedPlan);
	}
	return [
		{ type: "message", id: "user-1", message: { role: "user", content: "request" } },
		{ type: "message", id: "assistant-solution", message: { role: "assistant", content: solutionContent } },
		{ type: "message", id: "solution-anchor", message: { role: "user", content: "solution approved" } },
		{
			type: "message",
			id: "assistant-1",
			message: { role: "assistant", content: planContent },
		},
		{
			type: "custom",
			id: "state-1",
			customType: DELIVERY_STATE_CUSTOM_TYPE,
			data: {
				...createInitialRuntimeState(new Date("2026-01-01T00:00:00.000Z")),
				snapshot: { state },
					...(needsSolution
						? {
								approvals: { solution: solutionApproval, ...(needsPlanApproval ? { plan: planApproval } : {}) },
								proposedDocuments: planContract.documents,
							}
					: {}),
				...(needsPlanApproval
					? {
								planContract,
								planningDocuments: {
									version: 1,
									requirementName: TEST_REQUIREMENT_NAME,
									solutionPath: TEST_SOLUTION_PATH,
									planPath: TEST_PLAN_PATH,
									selectionSource: "project",
									solutionContentDigest: digestPlanningDocumentContent(extractedSolution),
									planContentDigest: digestPlanningDocumentContent(extractedPlan),
									syncedAt: "2026-01-01T00:01:00.000Z",
								},
						}
					: {}),
			},
		},
	];
}

async function emit(harness: ReturnType<typeof createHarness>, event: string): Promise<void> {
	for (const handler of harness.handlers.get(event) ?? []) {
		await handler({}, harness.ctx);
	}
}

async function emitWithResults(
	harness: ReturnType<typeof createHarness>,
	event: string,
	payload: Record<string, unknown>,
): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of harness.handlers.get(event) ?? []) {
		results.push(await handler(payload, harness.ctx));
	}
	return results;
}

async function emitBus(harness: ReturnType<typeof createHarness>, event: string, payload: unknown): Promise<void> {
	for (const handler of harness.eventListeners.get(event) ?? []) {
		await handler(payload);
	}
}

test("restores IDLE as read-only and exposes Chinese status", async () => {
	const harness = createHarness();

	await emit(harness, "session_start");

	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "空闲 [IDLE]"]);
	assert.ok(harness.commands.has("delivery-status"));
	assert.equal(harness.appendedEntries.length, 1);
	assert.equal(harness.appendedEntries[0]?.customType, DELIVERY_STATE_CUSTOM_TYPE);

	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const statusText = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(statusText, /状态：空闲 \[IDLE\]/);
	assert.match(statusText, /恢复状态：\(none\)/);
	assert.match(statusText, /Writer owner：\(none\)/);
	assert.match(statusText, /Candidate：不可证明/);
	assert.match(statusText, /Validation：不可证明/);
	assert.match(statusText, /Review：不可证明/);
	assert.match(statusText, /规划文档：不可证明/);
	assert.match(statusText, /Progress-sync：inactive/);
});

test("registers a display-only transformer that hides internal protocol from assistant Markdown", () => {
	const harness = createHarness();
	assert.equal(harness.markdownTransformers.length, 1);
	const markdown = [
		"<!-- adaptive-delivery:solution:start -->",
		"# 用户可见技术方案",
		"```adaptive-delivery-documents",
		'{"version":1}',
		"```",
		"<!-- adaptive-delivery:solution:end -->",
	].join("\n");
	const transformed = harness.markdownTransformers[0]!(markdown, { messageType: "assistant" });
	assert.equal(transformed, "# 用户可见技术方案");
	assert.equal(harness.markdownTransformers[0]!(markdown, { messageType: "user" }), markdown);
});

test("begins shaping from IDLE without granting write access", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");
	const begin = harness.tools.get("delivery_begin");
	assert.ok(begin);

	const result = await begin.execute(
		"begin-1",
		{ goal: "Add a safe feature" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.match(result.content[0].text, /方案梳理中 \[SHAPING\]/);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "方案梳理中 [SHAPING]"]);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.goal, "Add a safe feature");
	assert.equal(persisted.snapshot.state, "SHAPING");
});

test("locks before tree navigation and restores the new branch without losing baseline", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");

	harness.setActiveTools(["read", "edit", "write", "bash", "subagent"]);
	await emit(harness, "session_before_tree");
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);

	harness.setBranch([
		{
			type: "custom",
			customType: DELIVERY_STATE_CUSTOM_TYPE,
			data: {
				...createInitialRuntimeState(new Date("2026-01-01T00:00:00.000Z")),
				snapshot: { state: "SHAPING" },
			},
		},
	]);
	await emit(harness, "session_tree");

	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "方案梳理中 [SHAPING]"]);
});

test("locks before session switch and fork", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");

	for (const event of ["session_before_switch", "session_before_fork"]) {
		harness.setActiveTools(["read", "edit", "write", "bash", "subagent"]);
		await emit(harness, event);
		assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"], event);
	}
});

test("fails closed when a persisted writer state cannot prove approvals or lease", async () => {
	const harness = createHarness();
	harness.setBranch([
		{
			type: "custom",
			customType: DELIVERY_STATE_CUSTOM_TYPE,
			data: {
				...createInitialRuntimeState(new Date("2026-01-01T00:00:00.000Z")),
				snapshot: { state: "IMPLEMENTING" },
			},
		},
	]);

	await emit(harness, "session_start");

	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	assert.equal(harness.appendedEntries.length, 1);

	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(
		harness.ui.notifications.at(-1)?.[0] ?? "",
		/Implementation requires solution\+plan approvals|writer authorization or lease is not proven/,
	);
});

test("fails closed for malformed branch state", async () => {
	const harness = createHarness();
	harness.setBranch([
		{
			type: "custom",
			customType: DELIVERY_STATE_CUSTOM_TYPE,
			data: { version: 99, snapshot: { state: "IMPLEMENTING" } },
		},
	]);

	await emit(harness, "session_start");

	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	assert.equal(harness.appendedEntries.length, 1);
});

test("fails closed when a persisted approval no longer matches cwd or branch", async () => {
	const harness = createHarness();
	const entries = approvalBranch("PLANNING", harness.sessionId, harness.ctx.cwd);
	const content = (entries[1] as any).message.content;
	(entries.at(-1) as any).data.approvals = {
		solution: {
			version: 1,
			kind: "solution",
			sessionId: harness.sessionId,
			entryId: "assistant-1",
			contentDigest: digestApprovalContent(content),
			branchAnchorEntryId: "state-1",
			canonicalCwd: "/different-cwd",
			approvedAt: "2026-01-01T00:00:00.000Z",
		},
	};
	harness.setBranch(entries);

	await emit(harness, "session_start");

	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /Approval cwd does not match/);
});

test("keeps read-only policy when checkpoint persistence fails", async () => {
	const harness = createHarness();
	harness.failNextAppend();

	await emit(harness, "session_start");

	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /Failed to persist delivery checkpoint/);
});

test("rejects approval outside TUI without opening a confirmation prompt", async () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const harness = createHarness();
		harness.setMode(mode);
		harness.setConfirmResult(true);
		harness.setBranch(approvalBranch("SOLUTION_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
		await emit(harness, "session_start");

		const before = harness.appendedEntries.length;
		await harness.commands.get("delivery-approve-solution")?.handler("", harness.ctx);

		assert.equal(harness.getConfirmCalls(), 0, mode);
		assert.equal(harness.appendedEntries.length, before, mode);
		assert.deepEqual(harness.ui.statuses.at(-1), [
			"adaptive-delivery",
			"技术方案待确认 [SOLUTION_PENDING_APPROVAL]",
		]);
	}
});

test("requires an affirmative TUI gesture before approving a solution", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setBranch(approvalBranch("SOLUTION_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");

	harness.setConfirmResult(false);
	await harness.commands.get("delivery-approve-solution")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), 1);
	assert.deepEqual(harness.ui.statuses.at(-1), [
		"adaptive-delivery",
		"技术方案待确认 [SOLUTION_PENDING_APPROVAL]",
	]);

	harness.setConfirmResult(true);
	await harness.commands.get("delivery-approve-solution")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), 2);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "实施计划编制中 [PLANNING]"]);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.snapshot.state, "PLANNING");
	assert.equal(persisted.approvals.solution.kind, "solution");
	assert.equal(persisted.approvals.solution.sessionId, harness.sessionId);
	assert.equal(persisted.proposedDocuments.requirementName, TEST_REQUIREMENT_NAME);
	assert.equal(persisted.proposedDocuments.solutionPath, TEST_SOLUTION_PATH);
	assert.match(harness.confirmationRequests.at(-1)?.message ?? "", new RegExp(TEST_PLAN_PATH));
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /规划文档：Canvas写路径拆分.*pending/);
	assert.throws(() => readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /ENOENT/);
	assert.throws(() => readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /ENOENT/);
	assert.deepEqual(harness.sentUserMessages.at(-1), {
		content: "/delivery-plan",
		options: { expandPromptTemplates: true },
	});
	assert.equal(harness.sentMessages.at(-1)?.message.display, true);
	assert.match(harness.sentMessages.at(-1)?.message.content ?? "", /正在生成实施计划/);
});

test("records plan approval and enters writer state after acquiring the lease", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.equal(harness.getConfirmCalls(), 1);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "edit", "write"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "开发中 [IMPLEMENTING]"]);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.snapshot.state, "IMPLEMENTING");
	assert.equal(persisted.approvals.plan.kind, "plan");
	assert.ok(persisted.writerLease?.leaseId);
	assert.equal(persisted.planningDocuments.requirementName, TEST_REQUIREMENT_NAME);
	assert.equal(persisted.planningDocuments.solutionPath, TEST_SOLUTION_PATH);
	assert.equal(persisted.planningDocuments.planPath, TEST_PLAN_PATH);
	assert.match(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /保持公开行为不变/);
	assert.doesNotMatch(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /adaptive-delivery:/);
	assert.doesNotMatch(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /adaptive-delivery-plan/);
	assert.match(harness.confirmationRequests.at(-1)?.message ?? "", new RegExp(TEST_REQUIREMENT_NAME));
	assert.match(harness.confirmationRequests.at(-1)?.message ?? "", new RegExp(TEST_SOLUTION_PATH));
	assert.match(harness.confirmationRequests.at(-1)?.message ?? "", new RegExp(TEST_PLAN_PATH));
	assert.deepEqual(harness.sentUserMessages.at(-1), {
		content: "/delivery-run",
		options: { expandPromptTemplates: true },
	});
	assert.match(harness.sentMessages.at(-1)?.message.content ?? "", /正在开始实现/);
});

test("combined approval creates separate requirement documents before enabling writes", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("COMBINED_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.snapshot.state, "IMPLEMENTING");
	assert.equal(persisted.approvals.combined.kind, "combined");
	assert.equal(persisted.planningDocuments.solutionPath, TEST_SOLUTION_PATH);
	assert.equal(persisted.planningDocuments.planPath, TEST_PLAN_PATH);
	assert.equal(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8").startsWith(`# ${TEST_REQUIREMENT_NAME}`), true);
	assert.equal(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8").startsWith(`# ${TEST_REQUIREMENT_NAME}`), true);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "edit", "write"]);
	assert.equal(harness.sentUserMessages.at(-1)?.content, "/delivery-run");
});

test("planning document collision blocks implementation without overwriting the existing file", async () => {
	const repo = candidateRepo();
	writeFileSync(path.join(repo, TEST_SOLUTION_PATH), "existing solution\n");
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.equal(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), "existing solution\n");
	assert.equal(harness.getActiveTools().includes("edit"), false);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /will not be overwritten/);
	assert.equal(harness.sentUserMessages.length, 0);
});

test("plan approval does not auto-run when the IMPLEMENTING policy cannot be committed", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	harness.failSetActiveToolsOnFutureCalls([1]);

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.equal(harness.sentUserMessages.length, 0);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
});

test("automatic continuation failure keeps the approved state and shows the manual command", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.failAutomaticContinuation();
	harness.setBranch(approvalBranch("SOLUTION_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-solution")?.handler("", harness.ctx);

	assert.equal(harness.sentUserMessages.length, 0);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "实施计划编制中 [PLANNING]"]);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /请手动运行 \/delivery-plan/);
});

test("plan approval without an affirmative TUI confirmation does not create planning documents", async () => {
	for (const mode of ["rpc", "json", "print", "tui"] as const) {
		const repo = candidateRepo();
		const harness = createHarness(repo);
		harness.setMode(mode);
		harness.setConfirmResult(false);
		harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
		await emit(harness, "session_start");

		await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

		assert.equal(harness.getConfirmCalls(), mode === "tui" ? 1 : 0, mode);
		assert.equal(harness.getActiveTools().includes("edit"), false, mode);
		assert.equal(harness.sentUserMessages.length, 0, mode);
		assert.throws(() => readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /ENOENT/);
		assert.throws(() => readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /ENOENT/);
	}
});

test("plan approval rejects missing document markers before confirmation", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	const branch = approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd);
	const planEntry = branch.find((entry: any) => entry.id === "assistant-1") as any;
	planEntry.message.content[0].text = planEntry.message.content[0].text.replace(
		"<!-- adaptive-delivery:plan:end -->",
		"",
	);
	harness.setBranch(branch);
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.equal(harness.getConfirmCalls(), 0);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /规划文档内容标记/);
	assert.equal(harness.sentUserMessages.length, 0);
	assert.throws(() => readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /ENOENT/);
});

test("plan approval rejects document paths that differ from the approved solution", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	const branch = approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd);
	const planEntry = branch.find((entry: any) => entry.id === "assistant-1") as any;
	planEntry.message.content[0].text = planEntry.message.content[0].text.replace(
		TEST_SOLUTION_PATH,
		`docs/${TEST_REQUIREMENT_NAME}-替代技术方案.md`,
	);
	harness.setBranch(branch);
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.equal(harness.getConfirmCalls(), 0);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /与已批准技术方案不一致/);
	assert.equal(harness.sentUserMessages.length, 0);
	assert.throws(() => readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /ENOENT/);
});

test("rejects plan approval when the solution approval is missing", async () => {
	const harness = createHarness();
	harness.setConfirmResult(true);
	const branch = approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd);
	delete (branch.at(-1) as any).data.approvals;
	harness.setBranch(branch);
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.equal(harness.getConfirmCalls(), 0);
	assert.deepEqual(harness.ui.statuses.at(-1), [
		"adaptive-delivery",
		"已阻塞 [BLOCKED]",
	]);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /valid solution approval/);
});

test("blocks restore when runtime plan contract differs from the approved entry", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	const branch = approvalBranch("IMPLEMENTING", harness.sessionId, harness.ctx.cwd);
	(branch.at(-1) as any).data.planContract.validation[0].command = "malicious-command";
	harness.setBranch(branch);

	await emit(harness, "session_start");

	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /does not match the approved assistant entry/);
});

test("blocks restore when synchronized planning documents are missing", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	const branch = approvalBranch("IMPLEMENTING", harness.sessionId, harness.ctx.cwd);
	unlinkSync(path.join(repo, TEST_SOLUTION_PATH));
	harness.setBranch(branch);

	await emit(harness, "session_start");

	assert.equal(harness.getActiveTools().includes("edit"), false);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /Planning documents cannot be proven/);
});

test("blocks restore when planning document evidence does not match approved content", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	const branch = approvalBranch("IMPLEMENTING", harness.sessionId, harness.ctx.cwd);
	(branch.at(-1) as any).data.planningDocuments.planContentDigest = "a".repeat(64);
	harness.setBranch(branch);

	await emit(harness, "session_start");

	assert.equal(harness.getActiveTools().includes("edit"), false);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /evidence does not match the approved entries/);
});

test("rejects plan-derived progress writes from BLOCKED without an implementation approval bundle", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	const branch = approvalBranch("IMPLEMENTING", harness.sessionId, harness.ctx.cwd);
	const runtime = (branch.at(-1) as any).data;
	runtime.snapshot = { state: "BLOCKED" };
	runtime.approvals = {};
	harness.setBranch(branch);
	await emit(harness, "session_start");

	await assert.rejects(
		harness.tools.get("delivery_progress_sync").execute(
			"unapproved-progress",
			{ target: TEST_PLAN_PATH, oldText: "Status: pending", newText: "Status: complete" },
			undefined,
			undefined,
			harness.ctx,
		),
		/Implementation requires solution\+plan approvals|Authorization bundle is invalid/,
	);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: pending/);
});

test("restores an owned writer lease after same-process extension reload", async () => {
	const repo = candidateRepo();
	const first = createHarness(repo);
	first.setConfirmResult(true);
	const approvedBranch = approvalBranch("PLAN_PENDING_APPROVAL", first.sessionId, first.ctx.cwd);
	first.setBranch(approvedBranch);
	await emit(first, "session_start");
	await first.commands.get("delivery-approve-plan")?.handler("", first.ctx);
	const persisted = first.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.snapshot.state, "IMPLEMENTING");
	await emit(first, "session_shutdown");
	assert.equal(resolveCurrentSubagentCapabilityCeiling(first.sessionId), undefined);
	assert.deepEqual(first.ui.statuses.at(-1), ["adaptive-delivery", undefined]);

	const branch = structuredClone(approvedBranch);
	(branch.at(-1) as any).data = persisted;
	const second = createHarness(repo, { sessionId: first.sessionId, stateRoot: first.stateRoot });
	second.setBranch(branch);
	await emit(second, "session_start");

	await second.commands.get("delivery-status")?.handler("", second.ctx);
	assert.deepEqual(
		second.ui.statuses.at(-1),
		["adaptive-delivery", "开发中 [IMPLEMENTING]"],
		second.ui.notifications.at(-1)?.[0],
	);
	assert.deepEqual(second.getActiveTools(), ["read", "grep", "find", "ls", "edit", "write"]);
	await second.commands.get("delivery-cancel")?.handler("", second.ctx);
	assert.deepEqual(second.ui.statuses.at(-1), ["adaptive-delivery", "已取消 [CANCELLED]"]);
	await emit(second, "session_shutdown");
});

test("cancel releases an owned parent lease before entering the terminal state", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.commands.get("delivery-cancel")?.handler("", harness.ctx);

	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已取消 [CANCELLED]"]);
	const confirmations = harness.getConfirmCalls();
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), confirmations);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /没有 writer lease/);
});

test("serializes candidate submission against sibling writes in either source order", async () => {
	const repo = candidateRepo();
	const submitFirst = createHarness(repo);
	submitFirst.setConfirmResult(true);
	submitFirst.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", submitFirst.sessionId, submitFirst.ctx.cwd));
	await emit(submitFirst, "session_start");
	await submitFirst.commands.get("delivery-approve-plan")?.handler("", submitFirst.ctx);
	await emitWithResults(submitFirst, "tool_execution_start", {
		toolCallId: "submit",
		toolName: "delivery_submit_candidate",
		args: {},
	});
	assert.deepEqual(
		await emitWithResults(submitFirst, "tool_call", {
			toolCallId: "submit",
			toolName: "delivery_submit_candidate",
			input: {},
		}),
		[undefined],
	);
	await emitWithResults(submitFirst, "tool_execution_start", {
		toolCallId: "edit",
		toolName: "edit",
		args: { path: "tracked.txt" },
	});
	const blockedEdit = await emitWithResults(submitFirst, "tool_call", {
		toolCallId: "edit",
		toolName: "edit",
		input: { path: "tracked.txt" },
	});
	assert.match((blockedEdit[0] as any).reason, /serialization barrier/);

	const editFirst = createHarness(candidateRepo());
	editFirst.setConfirmResult(true);
	editFirst.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", editFirst.sessionId, editFirst.ctx.cwd));
	await emit(editFirst, "session_start");
	await editFirst.commands.get("delivery-approve-plan")?.handler("", editFirst.ctx);
	await emitWithResults(editFirst, "tool_execution_start", {
		toolCallId: "edit-first",
		toolName: "edit",
		args: { path: "tracked.txt" },
	});
	assert.deepEqual(
		await emitWithResults(editFirst, "tool_call", {
			toolCallId: "edit-first",
			toolName: "edit",
			input: { path: "tracked.txt" },
		}),
		[undefined],
	);
	await emitWithResults(editFirst, "tool_execution_start", {
		toolCallId: "submit-second",
		toolName: "delivery_submit_candidate",
		args: {},
	});
	const blockedSubmit = await emitWithResults(editFirst, "tool_call", {
		toolCallId: "submit-second",
		toolName: "delivery_submit_candidate",
		input: {},
	});
	assert.match((blockedSubmit[0] as any).reason, /already contains a writer/);

	for (const toolName of ["bash", "subagent"]) {
		const result = await emitWithResults(editFirst, "tool_call", {
			toolCallId: toolName,
			toolName,
			input: {},
		});
		assert.match((result[0] as any).reason, /not allowed/);
	}
});

test("serializes authorization invalidation against sibling writes in either source order", async () => {
	const invalidateFirst = createHarness(candidateRepo());
	invalidateFirst.setConfirmResult(true);
	invalidateFirst.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", invalidateFirst.sessionId, invalidateFirst.ctx.cwd));
	await emit(invalidateFirst, "session_start");
	await invalidateFirst.commands.get("delivery-approve-plan")?.handler("", invalidateFirst.ctx);
	await emitWithResults(invalidateFirst, "tool_execution_start", {
		toolCallId: "invalidate",
		toolName: "delivery_invalidate",
		args: { target: "BLOCKED", reason: "scope changed" },
	});
	assert.deepEqual(
		await emitWithResults(invalidateFirst, "tool_call", {
			toolCallId: "invalidate",
			toolName: "delivery_invalidate",
			input: { target: "BLOCKED", reason: "scope changed" },
		}),
		[undefined],
	);
	await emitWithResults(invalidateFirst, "tool_execution_start", {
		toolCallId: "edit-after-invalidate",
		toolName: "edit",
		args: { path: "tracked.txt" },
	});
	const blockedEdit = await emitWithResults(invalidateFirst, "tool_call", {
		toolCallId: "edit-after-invalidate",
		toolName: "edit",
		input: { path: "tracked.txt" },
	});
	assert.match((blockedEdit[0] as any).reason, /serialization barrier/);

	const editFirst = createHarness(candidateRepo());
	editFirst.setConfirmResult(true);
	editFirst.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", editFirst.sessionId, editFirst.ctx.cwd));
	await emit(editFirst, "session_start");
	await editFirst.commands.get("delivery-approve-plan")?.handler("", editFirst.ctx);
	await emitWithResults(editFirst, "tool_execution_start", {
		toolCallId: "edit-before-invalidate",
		toolName: "edit",
		args: { path: "tracked.txt" },
	});
	assert.deepEqual(
		await emitWithResults(editFirst, "tool_call", {
			toolCallId: "edit-before-invalidate",
			toolName: "edit",
			input: { path: "tracked.txt" },
		}),
		[undefined],
	);
	await emitWithResults(editFirst, "tool_execution_start", {
		toolCallId: "invalidate-after-edit",
		toolName: "delivery_invalidate",
		args: { target: "BLOCKED", reason: "scope changed" },
	});
	const blockedInvalidate = await emitWithResults(editFirst, "tool_call", {
		toolCallId: "invalidate-after-edit",
		toolName: "delivery_invalidate",
		input: { target: "BLOCKED", reason: "scope changed" },
	});
	assert.match((blockedInvalidate[0] as any).reason, /already contains a writer/);
});

test("cancels navigation when read-only policy cannot be applied", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");
	harness.failSetActiveToolsOnFutureCalls([1]);
	const results = await emitWithResults(harness, "session_before_tree", {});
	assert.deepEqual(results, [{ cancel: true }]);
});

test("resume and force-release cannot bypass the TUI confirmation gate", async () => {
	const rpcHarness = createHarness();
	const rpcBlockedBranch = approvalBranch("BLOCKED", rpcHarness.sessionId, rpcHarness.ctx.cwd);
	(rpcBlockedBranch.at(-1) as any).data.snapshot = { state: "BLOCKED", resumeState: "PLANNING" };
	rpcHarness.setMode("rpc");
	rpcHarness.setConfirmResult(true);
	rpcHarness.setBranch(rpcBlockedBranch);
	await emit(rpcHarness, "session_start");
	await rpcHarness.commands.get("delivery-resume")?.handler("", rpcHarness.ctx);
	await rpcHarness.commands.get("delivery-force-release-lease")?.handler("", rpcHarness.ctx);
	assert.equal(rpcHarness.getConfirmCalls(), 0);
	assert.deepEqual(rpcHarness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);

	const tuiHarness = createHarness();
	const tuiBlockedBranch = approvalBranch("BLOCKED", tuiHarness.sessionId, tuiHarness.ctx.cwd);
	(tuiBlockedBranch.at(-1) as any).data.snapshot = { state: "BLOCKED", resumeState: "PLANNING" };
	tuiHarness.setConfirmResult(true);
	tuiHarness.setBranch(tuiBlockedBranch);
	await emit(tuiHarness, "session_start");
	await tuiHarness.commands.get("delivery-resume")?.handler("", tuiHarness.ctx);
	assert.deepEqual(tuiHarness.ui.statuses.at(-1), ["adaptive-delivery", "实施计划编制中 [PLANNING]"]);
	await tuiHarness.commands.get("delivery-force-release-lease")?.handler("", tuiHarness.ctx);
	assert.equal(tuiHarness.getConfirmCalls(), 1);
	assert.match(tuiHarness.ui.notifications.at(-1)?.[0] ?? "", /没有 writer lease/);
});

test("force-release requires TUI confirmation and leaves the flow blocked", async () => {
	const harness = createHarness(candidateRepo());
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "开发中 [IMPLEMENTING]"]);

	harness.setMode("rpc");
	const before = harness.getConfirmCalls();
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), before);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "开发中 [IMPLEMENTING]"]);

	harness.setMode("tui");
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), before + 1);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /已强制释放/);
});

test("freezes one candidate, launches only approved validation, and invalidates stale evidence", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	const submit = harness.tools.get("delivery_submit_candidate");
	const validate = harness.tools.get("delivery_validate");
	const review = harness.tools.get("delivery_review_candidate");
	assert.ok(submit);
	assert.ok(validate);
	assert.ok(review);
	const submitted = await submit.execute("submit-1", {}, undefined, undefined, harness.ctx);
	const candidateDigest = submitted.details.candidateDigest as string;
	assert.match(candidateDigest, /^[a-f0-9]{64}$/);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "验证中 [VALIDATING]"]);

	const validation = await validate.execute("validate-1", {}, undefined, undefined, harness.ctx);
	assert.equal(validation.details.runId, "validation-run");
	assert.equal(validation.details.candidateDigest, candidateDigest);
	const spawn = harness.emittedEvents.find(
		(entry) => entry.event === "subagents:rpc:v1:request" && entry.payload.method === "spawn",
	);
	assert.ok(spawn);
	assert.match(spawn.payload.params.workflowScript, /npm test/);
	assert.match(spawn.payload.params.workflowScript, new RegExp(candidateDigest));
	await emitBus(harness, "subagent:async-complete", { runId: "unrelated", success: true, status: "completed" });
	assert.equal((harness.appendedEntries.at(-1)?.data as any).validationStatus, "pending");
	await emitBus(harness, "subagent:async-complete", {
		runId: "validation-run",
		success: true,
		status: "completed",
	});
	assert.equal((harness.appendedEntries.at(-1)?.data as any).validationStatus, "passed");
	const reviewed = await review.execute("review-1", {}, undefined, undefined, harness.ctx);
	assert.match(reviewed.content[0].text, /Merge verdict: OK/);
	assert.equal(reviewed.details.candidateDigest, candidateDigest);

	writeFileSync(path.join(repo, "tracked.txt"), "changed after validation\n");
	await assert.rejects(
		validate.execute("validate-2", {}, undefined, undefined, harness.ctx),
		/stale/,
	);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
});

test("finalizes only after passed validation and an OK fresh review", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	const validation = await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);
	await emitBus(harness, "subagent:async-complete", {
		runId: validation.details.runId,
		success: true,
		status: "completed",
	});
	await harness.tools.get("delivery_review_candidate").execute("review", {}, undefined, undefined, harness.ctx);
	const finalized = await harness.tools.get("delivery_finalize").execute("finalize", {}, undefined, undefined, harness.ctx);

	assert.match(finalized.content[0].text, /已交付 \[DELIVERED\]/);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已交付 [DELIVERED]"]);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.validationStatus, "passed");
	assert.equal(persisted.reviewEvidence.verdict, "OK");
	assert.equal(persisted.finalEvidence.candidateDigest, persisted.candidateDigest);
	assert.equal(persisted.finalEvidence.progressArtifacts[0].path, TEST_PLAN_PATH);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const status = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(status, /Candidate：[a-f0-9]{64} \(current\)/);
	assert.match(status, /Validation：passed \(current\)/);
	assert.match(status, /Review：OK \(current\)/);
	writeFileSync(path.join(repo, "tracked.txt"), "changed after delivery\n");
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const staleStatus = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(staleStatus, /Candidate：[a-f0-9]{64} \(stale\)/);
	assert.match(staleStatus, /Validation：passed \(stale\)/);
	assert.match(staleStatus, /Review：OK \(stale\)/);
});

test("finalize reports failure when the delivered transition cannot be persisted", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	const validation = await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);
	await emitBus(harness, "subagent:async-complete", {
		runId: validation.details.runId,
		success: true,
		status: "completed",
	});
	await harness.tools.get("delivery_review_candidate").execute("review", {}, undefined, undefined, harness.ctx);
	harness.failSetActiveToolsOnFutureCalls([1]);

	await assert.rejects(
		harness.tools.get("delivery_finalize").execute("finalize", {}, undefined, undefined, harness.ctx),
		/Failed to persist the delivered transition/,
	);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
});

test("rejects ambiguous reviewer output with more than one merge verdict", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setReviewText("Merge verdict: OK\nP1 remains\nMerge verdict: BLOCK");
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);

	await assert.rejects(
		harness.tools.get("delivery_review_candidate").execute("review", {}, undefined, undefined, harness.ctx),
		/recognized merge verdict/,
	);
});

test("restores the writer only for a BLOCK review on the current candidate", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setReviewText("Concrete P1 finding\nMerge verdict: BLOCK");
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	await harness.tools.get("delivery_review_candidate").execute("review", {}, undefined, undefined, harness.ctx);
	const rework = await harness.tools.get("delivery_begin_rework").execute(
		"rework",
		{ reason: "Fix accepted P1" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.match(rework.content[0].text, /返工中 \[REWORKING\]/);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "edit", "write"]);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.reworkApproved, true);
	assert.equal(persisted.reviewEvidence.verdict, "BLOCK");
	assert.ok(persisted.writerLease.leaseId);
});

test("reconciles a pending validation through public status after reload", async () => {
	const repo = candidateRepo();
	const first = createHarness(repo);
	first.setConfirmResult(true);
	const approvedBranch = approvalBranch("PLAN_PENDING_APPROVAL", first.sessionId, first.ctx.cwd);
	first.setBranch(approvedBranch);
	installSubagentRpcResponder(first);
	await emit(first, "session_start");
	await first.commands.get("delivery-approve-plan")?.handler("", first.ctx);
	await first.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, first.ctx);
	await first.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, first.ctx);
	const pending = first.appendedEntries.at(-1)?.data as any;
	assert.equal(pending.validationStatus, "pending");
	await emit(first, "session_shutdown");

	const branch = structuredClone(approvedBranch);
	(branch.at(-1) as any).data = pending;
	const second = createHarness(repo, { sessionId: first.sessionId, stateRoot: first.stateRoot });
	second.setBranch(branch);
	installSubagentRpcResponder(second);
	await emit(second, "session_start");

	const restored = second.appendedEntries.at(-1)?.data as any;
	assert.equal(restored.validationStatus, "passed");
	assert.deepEqual(second.ui.statuses.at(-1), ["adaptive-delivery", "验证中 [VALIDATING]"]);
});

test("ignores late validation completion after cancellation", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	const validation = await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);
	await harness.commands.get("delivery-cancel")?.handler("", harness.ctx);
	const entryCount = harness.appendedEntries.length;

	await emitBus(harness, "subagent:async-complete", {
		runId: validation.details.runId,
		success: false,
		status: "failed",
	});
	assert.equal(harness.appendedEntries.length, entryCount);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已取消 [CANCELLED]"]);
});

test("blocks explicit validation failure and ignores duplicate completion", async () => {
	const harness = createHarness(candidateRepo());
	harness.setValidationStatusState("running");
	installSubagentRpcResponder(harness);
	const entries = approvalBranch("VALIDATING", harness.sessionId, harness.ctx.cwd);
	(entries.at(-1) as any).data.validationRunId = "validation-run";
	(entries.at(-1) as any).data.validationStatus = "pending";
	(entries.at(-1) as any).data.candidateDigest = "a".repeat(64);
	harness.setBranch(entries);
	await emit(harness, "session_start");

	await emitBus(harness, "subagent:async-complete", {
		runId: "validation-run",
		success: false,
		status: "completed",
	});
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	assert.equal((harness.appendedEntries.at(-1)?.data as any).validationStatus, "failed");
	const entryCount = harness.appendedEntries.length;
	await emitBus(harness, "subagent:async-complete", {
		runId: "validation-run",
		success: true,
		status: "completed",
	});
	assert.equal(harness.appendedEntries.length, entryCount);
});

test("syncs only the approved progress target at a writer-free boundary", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);

	const progress = harness.tools.get("delivery_progress_sync");
	assert.ok(progress);
	const result = await progress.execute(
		"progress",
		{ target: TEST_PLAN_PATH, oldText: "Status: pending", newText: "Status: complete" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.match(result.content[0].text, /项目进度已同步/);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: complete/);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "验证中 [VALIDATING]"]);
	assert.equal(harness.execCalls.some((call) => call.command === "git" && call.args.includes("--check")), true);
	await assert.rejects(
		progress.execute(
			"progress-escape",
			{ target: "tracked.txt", oldText: "initial", newText: "changed" },
			undefined,
			undefined,
			harness.ctx,
		),
		/not approved/,
	);
});

test("blocks after a failed progress check without leaving write tools or lease", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	harness.setExecResult({ stdout: "", stderr: "docs invalid", code: 1, killed: false });

	await assert.rejects(
		harness.tools.get("delivery_progress_sync").execute(
			"progress-fail",
			{ target: TEST_PLAN_PATH, oldText: "Status: pending", newText: "Status: complete" },
			undefined,
			undefined,
			harness.ctx,
		),
		/docs invalid/,
	);

	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: complete/);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	const confirmations = harness.getConfirmCalls();
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), confirmations);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /没有 writer lease/);
});

test("retains the lease when progress-sync policy restoration cannot be proven", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	harness.failSetActiveToolsOnFutureCalls([2, 3, 4, 5]);

	await assert.rejects(
		harness.tools.get("delivery_progress_sync").execute(
			"progress-restore-fail",
			{ target: TEST_PLAN_PATH, oldText: "Status: pending", newText: "Status: complete" },
			undefined,
			undefined,
			harness.ctx,
		),
		/setActiveTools injected failure|restore base policy/,
	);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	const before = harness.getConfirmCalls();
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), before + 1);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /已强制释放/);
});

test("model-callable invalidation can only downgrade", async () => {
	const harness = createHarness(candidateRepo());
	harness.setBranch(approvalBranch("VALIDATING", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	const invalidate = harness.tools.get("delivery_invalidate");
	assert.ok(invalidate);

	const result = await invalidate.execute(
		"tool-1",
		{ target: "BLOCKED", reason: "scope changed" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.match(result.content[0].text, /已降权到 已阻塞 \[BLOCKED\]/);
	assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls"]);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
});
