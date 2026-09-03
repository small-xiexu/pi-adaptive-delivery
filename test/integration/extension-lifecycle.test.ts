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

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const TEST_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "adaptive-extension-agent-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
test.after(() => {
	if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

type Handler = (...args: any[]) => unknown;
let harnessSequence = 0;
const TEST_REQUIREMENT_NAME = "Canvas写路径拆分";
const TEST_SOLUTION_PATH = `docs/${TEST_REQUIREMENT_NAME}-技术方案.md`;
const TEST_PLAN_PATH = `docs/${TEST_REQUIREMENT_NAME}-实施计划.md`;
const TEST_MODEL = {
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
const BASE_ACTIVE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"delivery_runtime_status",
	"delivery_begin",
	"delivery_progress_sync",
	"delivery_invalidate",
];
const READONLY_ACTIVE_TOOLS = [...BASE_ACTIVE_TOOLS, "delivery_delegate_readonly"];
const WRITER_ACTIVE_TOOLS = [...BASE_ACTIVE_TOOLS, "edit", "write", "delivery_submit_candidate"];
const DELEGATED_WRITER_ACTIVE_TOOLS = [...BASE_ACTIVE_TOOLS, "delivery_delegate_worker"];
const VALIDATION_ACTIVE_TOOLS = [
	...BASE_ACTIVE_TOOLS,
	"delivery_validate",
	"delivery_review_candidate",
	"delivery_begin_rework",
	"delivery_finalize",
];

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
	options: { sessionId?: string; stateRoot?: string; initialActiveTools?: string[] } = {},
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
	let activeTools = [...(options.initialActiveTools ?? ["read", "grep", "find", "ls", "edit", "write", "bash", "subagent", "bg_wait"])];
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
	let currentModel: any = TEST_MODEL;
	let workerResponseStatus = "completed";
	let workerIncludeTerminalDigest = true;
	let workerIncludeTerminalRunId = true;
	let workerExecution: (() => void) | undefined;
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
			if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
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
		get model() {
			return currentModel;
		},
		thinkingLevel: "high",
		waitForIdle: async () => {},
		modelRegistry: { getAvailable: () => currentModel ? [currentModel] : [] },
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
		setModelAvailable: (value: boolean) => {
			currentModel = value ? TEST_MODEL : undefined;
		},
		configureWorkerResponse: (options: {
			status?: string;
			includeDigest?: boolean;
			includeRunId?: boolean;
			execute?: () => void;
		}) => {
			workerResponseStatus = options.status ?? "completed";
			workerIncludeTerminalDigest = options.includeDigest ?? true;
			workerIncludeTerminalRunId = options.includeRunId ?? true;
			workerExecution = options.execute;
		},
		getWorkerResponse: () => ({
			status: workerResponseStatus,
			includeDigest: workerIncludeTerminalDigest,
			includeRunId: workerIncludeTerminalRunId,
			execute: workerExecution,
		}),
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
	}]));
	harness.eventListeners.set("prompt-template:subagent:request", new Set([(payload: any) => {
		const worker = payload.agent === "worker";
		const digest = worker
			? /^worker-([a-f0-9]{64})-/.exec(payload.nodeId)?.[1]
			: /^readonly-(?:scout|oracle|reviewer)-([a-f0-9]{64})-/.exec(payload.nodeId)?.[1];
		if (worker) {
			const workerResponse = harness.getWorkerResponse();
			for (const handler of harness.eventListeners.get("prompt-template:subagent:update") ?? []) {
				handler({
					requestId: payload.requestId,
					ownerRunId: payload.ownerRunId,
					nodeId: payload.nodeId,
					runId: "worker-run",
					currentTool: "edit",
					toolCount: 1,
				});
			}
			workerResponse.execute?.();
			for (const handler of harness.eventListeners.get("prompt-template:subagent:response") ?? []) {
				handler({
					requestId: payload.requestId,
					ownerRunId: payload.ownerRunId,
					nodeId: payload.nodeId,
					status: workerResponse.status,
					...(workerResponse.includeRunId ? { runId: "worker-run" } : {}),
					...(workerResponse.includeDigest ? { launchContractDigest: digest } : {}),
					...(workerResponse.status === "completed"
						? { result: { kind: "text", text: "worker completed approved implementation" } }
						: { error: "worker failed" }),
				});
			}
			return;
		}
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

function approvalBranch(
	state: string,
	sessionId = "fixture-session",
	cwd = process.cwd(),
	route: "single" | "standard" | "high-risk" = "single",
) {
	const hasPlan = ["PLAN_PENDING_APPROVAL", "COMBINED_PENDING_APPROVAL", "IMPLEMENTING", "VALIDATING", "REWORKING"].includes(state);
	const planContract = {
			version: 2,
			risk: route === "high-risk" ? "high" : "low",
			complexity: route === "single" ? "small" : "medium",
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

	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "空闲 [IDLE]"]);
	assert.ok(harness.commands.has("delivery-status"));
	assert.equal(harness.appendedEntries.length, 1);
	assert.equal(harness.appendedEntries[0]?.customType, DELIVERY_STATE_CUSTOM_TYPE);

	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const statusText = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(statusText, /状态：空闲 \[IDLE\]/);
	assert.match(statusText, /恢复状态：无/);
	assert.match(statusText, /开发方式：待实施计划决定/);
	assert.match(statusText, /写入者：无/);
	assert.match(statusText, /候选版本：不可证明/);
	assert.match(statusText, /验证：不可证明/);
	assert.match(statusText, /审查：不可证明/);
	assert.match(statusText, /规划文档：不可证明/);
	assert.match(statusText, /进度同步：未运行/);
	assert.ok(harness.tools.has("delivery_runtime_status"));
	const runtimeStatus = await harness.tools.get("delivery_runtime_status").execute(
		"runtime-status-idle",
		{},
		undefined,
		undefined,
		harness.ctx,
	);
	assert.equal(runtimeStatus.details.state, "IDLE");
	assert.equal(runtimeStatus.details.implementationWriter, undefined);
	assert.deepEqual(runtimeStatus.details.activeTools, BASE_ACTIVE_TOOLS);
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
	assert.deepEqual(harness.getActiveTools(), READONLY_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "方案梳理中 [SHAPING]"]);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.goal, "Add a safe feature");
	assert.equal(persisted.snapshot.state, "SHAPING");
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const statusText = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(statusText, /断点：已开始梳理技术方案/);
	assert.match(statusText, /下一步：检查项目事实并形成技术方案/);
});

test("shows an approved-solution checkpoint for an older PLANNING session", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	const branch = approvalBranch("PLANNING", harness.sessionId, harness.ctx.cwd);
	(branch.at(-1) as any).data.checkpoint = {
		summary: "Adaptive Delivery shaping started",
		nextReadyAction: "Inspect project facts and draft the technical solution",
	};
	harness.setBranch(branch);
	await emit(harness, "session_start");

	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const statusText = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(statusText, /断点：技术方案已批准/);
	assert.match(statusText, /下一步：生成实施计划/);
});

test("locks before tree navigation and restores the new branch without losing baseline", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");

	harness.setActiveTools(["read", "edit", "write", "bash", "subagent"]);
	await emit(harness, "session_before_tree");
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);

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

	assert.deepEqual(harness.getActiveTools(), READONLY_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "方案梳理中 [SHAPING]"]);
});

test("locks before session switch and fork", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");

	for (const event of ["session_before_switch", "session_before_fork"]) {
		harness.setActiveTools(["read", "edit", "write", "bash", "subagent"]);
		await emit(harness, event);
		assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS, event);
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

	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	assert.equal(harness.appendedEntries.length, 1);

	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(
		harness.ui.notifications.at(-1)?.[0] ?? "",
		/实现阶段需要技术方案与实施计划批准|无法证明写入授权或租约/,
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

	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
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

	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /批准记录与当前工作目录不匹配/);
});

test("keeps read-only policy when checkpoint persistence fails", async () => {
	const harness = createHarness();
	harness.failNextAppend();

	await emit(harness, "session_start");

	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /保存交付断点失败/);
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
	const statusText = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(statusText, /规划文档：Canvas写路径拆分.*待同步/);
	assert.match(statusText, /断点：技术方案已批准/);
	assert.match(statusText, /下一步：生成实施计划/);
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
	assert.deepEqual(harness.getActiveTools(), WRITER_ACTIVE_TOOLS);
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
	const runtimeStatus = await harness.tools.get("delivery_runtime_status").execute(
		"runtime-status-implementing",
		{},
		undefined,
		undefined,
		harness.ctx,
	);
	assert.equal(runtimeStatus.details.state, "IMPLEMENTING");
	assert.equal(runtimeStatus.details.activeTools.includes("delivery_submit_candidate"), true);
	assert.equal(runtimeStatus.details.activeTools.includes("delivery_validate"), false);
	assert.match(runtimeStatus.content[0].text, /验证与审查工具会在候选提交后的下一轮出现/);
});

test("standard route delegates one worker and freezes its terminal candidate", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard"));
	harness.configureWorkerResponse({
		execute: () => writeFileSync(path.join(repo, "worker-change.txt"), "implemented by worker\n"),
	});
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.deepEqual(harness.getActiveTools(), DELEGATED_WRITER_ACTIVE_TOOLS);
	assert.equal(harness.getActiveTools().includes("edit"), false);
	assert.equal(harness.getActiveTools().includes("delivery_submit_candidate"), false);
	assert.equal(harness.tools.has("delivery_delegate_worker"), true);
	const workerStatus = await harness.tools.get("delivery_runtime_status").execute(
		"worker-route-status",
		{},
		undefined,
		undefined,
		harness.ctx,
	);
	assert.equal(workerStatus.details.implementationWriter, "worker");
	assert.match(workerStatus.content[0].text, /父 Pi 不得修改源码/);
	const blockedParentEdit = await emitWithResults(harness, "tool_call", {
		toolCallId: "parent-edit-standard",
		toolName: "edit",
		input: { path: "tracked.txt" },
	});
	assert.match((blockedParentEdit[0] as any).reason, /does not allow source writes/);
	await assert.rejects(
		harness.tools.get("delivery_submit_candidate").execute("parent-submit", {}, undefined, undefined, harness.ctx),
		/requires the controlled worker/,
	);

	const result = await harness.tools.get("delivery_delegate_worker").execute(
		"worker-tool",
		{},
		undefined,
		undefined,
		harness.ctx,
	);

	assert.match(result.content[0].text, /worker completed approved implementation/);
	assert.match(result.details.candidateDigest, /^[a-f0-9]{64}$/);
	assert.equal(readFileSync(path.join(repo, "worker-change.txt"), "utf8"), "implemented by worker\n");
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.snapshot.state, "VALIDATING");
	assert.equal(persisted.workerRunId, "worker-run");
	assert.equal(persisted.workerStatus, "completed");
	assert.equal(persisted.workerLaunchContractDigest, result.details.launchContractDigest);
	assert.equal(persisted.writerLease, undefined);
	assert.equal(persisted.candidateDigest, result.details.candidateDigest);
	assert.deepEqual(harness.getActiveTools(), VALIDATION_ACTIVE_TOOLS);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const statusText = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(statusText, /开发方式：唯一 worker/);
	assert.match(statusText, /开发执行者：已完成（运行 ID：worker-run）/);
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /没有写入租约/);
});

test("standard route blocks before source work when worker preflight is shadowed", async () => {
	const repo = candidateRepo();
	mkdirSync(path.join(repo, ".pi", "agents"), { recursive: true });
	writeFileSync(
		path.join(repo, ".pi", "agents", "worker.md"),
		"---\nname: worker\ndescription: Project shadow\ntools: read, edit, write\n---\nProject worker shadow.\n",
	);
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard"));
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(blocked.writerLease, undefined);
	assert.equal(harness.sentUserMessages.length, 0);
	assert.equal(harness.getActiveTools().includes("edit"), false);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /唯一 worker 当前不可用/);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /not the builtin 'worker'/);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: pending/);
});

test("standard route returns accepted review rework to one worker", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setReviewText("Concrete P1 finding\nMerge verdict: BLOCK");
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard"));
	harness.configureWorkerResponse({
		execute: () => writeFileSync(path.join(repo, "worker-change.txt"), "first candidate\n"),
	});
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	const first = await harness.tools.get("delivery_delegate_worker").execute(
		"initial-worker",
		{},
		undefined,
		undefined,
		harness.ctx,
	);
	await harness.tools.get("delivery_validate").execute("validate-before-review", {}, undefined, undefined, harness.ctx);
	await harness.tools.get("delivery_review_candidate").execute("review", {}, undefined, undefined, harness.ctx);
	await harness.tools.get("delivery_begin_rework").execute(
		"begin-worker-rework",
		{ reason: "Fix accepted P1" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.deepEqual(harness.getActiveTools(), DELEGATED_WRITER_ACTIVE_TOOLS);
	assert.equal(harness.getActiveTools().includes("edit"), false);
	harness.configureWorkerResponse({
		execute: () => writeFileSync(path.join(repo, "worker-change.txt"), "reworked candidate\n"),
	});
	const second = await harness.tools.get("delivery_delegate_worker").execute(
		"rework-worker",
		{ instructions: "Apply only the accepted P1 finding." },
		undefined,
		undefined,
		harness.ctx,
	);
	assert.notEqual(second.details.candidateDigest, first.details.candidateDigest);
	assert.equal(readFileSync(path.join(repo, "worker-change.txt"), "utf8"), "reworked candidate\n");
	const state = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(state.snapshot.state, "VALIDATING");
	assert.equal(state.workerStatus, "completed");
	assert.equal(state.reworkApproved, false);
	assert.equal(state.reviewEvidence, undefined);
});

test("standard route serializes the foreground worker against sibling parent writes", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard"));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await emitWithResults(harness, "tool_execution_start", {
		toolCallId: "worker-first",
		toolName: "delivery_delegate_worker",
		args: {},
	});
	assert.deepEqual(
		await emitWithResults(harness, "tool_call", {
			toolCallId: "worker-first",
			toolName: "delivery_delegate_worker",
			input: {},
		}),
		[undefined],
	);
	await emitWithResults(harness, "tool_execution_start", {
		toolCallId: "parent-edit-second",
		toolName: "edit",
		args: { path: "tracked.txt" },
	});
	const blocked = await emitWithResults(harness, "tool_call", {
		toolCallId: "parent-edit-second",
		toolName: "edit",
		input: { path: "tracked.txt" },
	});
	assert.match((blocked[0] as any).reason, /serialization barrier/);
	await emitWithResults(harness, "tool_execution_end", {
		toolCallId: "worker-first",
		toolName: "delivery_delegate_worker",
	});
	await harness.commands.get("delivery-cancel")?.handler("", harness.ctx);
});

test("controlled worker failure releases only with complete terminal proof", async () => {
	const failedRepo = candidateRepo();
	const failed = createHarness(failedRepo);
	failed.setConfirmResult(true);
	failed.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", failed.sessionId, failed.ctx.cwd, "standard"));
	failed.configureWorkerResponse({ status: "failed" });
	installSubagentRpcResponder(failed);
	await emit(failed, "session_start");
	await failed.commands.get("delivery-approve-plan")?.handler("", failed.ctx);
	await assert.rejects(
		failed.tools.get("delivery_delegate_worker").execute("failed-worker", {}, undefined, undefined, failed.ctx),
		/worker failed/,
	);
	const failedState = failed.appendedEntries.at(-1)?.data as any;
	assert.equal(failedState.snapshot.state, "BLOCKED");
	assert.equal(failedState.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(failedState.workerStatus, "failed");
	assert.equal(failedState.writerLease, undefined);
	await failed.commands.get("delivery-force-release-lease")?.handler("", failed.ctx);
	assert.match(failed.ui.notifications.at(-1)?.[0] ?? "", /没有写入租约/);

	const unprovenRepo = candidateRepo();
	const unproven = createHarness(unprovenRepo);
	unproven.setConfirmResult(true);
	unproven.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", unproven.sessionId, unproven.ctx.cwd, "standard"));
	unproven.configureWorkerResponse({ includeDigest: false });
	installSubagentRpcResponder(unproven);
	await emit(unproven, "session_start");
	await unproven.commands.get("delivery-approve-plan")?.handler("", unproven.ctx);
	await assert.rejects(
		unproven.tools.get("delivery_delegate_worker").execute("unproven-worker", {}, undefined, undefined, unproven.ctx),
		/terminal launch contract digest is missing or changed/,
	);
	const unprovenState = unproven.appendedEntries.at(-1)?.data as any;
	assert.equal(unprovenState.snapshot.state, "BLOCKED");
	assert.equal(unprovenState.snapshot.resumeState, "IMPLEMENTING");
	assert.ok(unprovenState.writerLease?.leaseId);
	await unproven.commands.get("delivery-force-release-lease")?.handler("", unproven.ctx);
	assert.match(unproven.ui.notifications.at(-1)?.[0] ?? "", /已强制释放/);
	const releasedState = unproven.appendedEntries.at(-1)?.data as any;
	assert.equal(releasedState.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(releasedState.workerStatus, "failed");
	assert.equal(releasedState.writerLease, undefined);
	await unproven.commands.get("delivery-resume")?.handler("", unproven.ctx);
	assert.equal((unproven.appendedEntries.at(-1)?.data as any).snapshot.state, "IMPLEMENTING");
	assert.deepEqual(unproven.getActiveTools(), DELEGATED_WRITER_ACTIVE_TOOLS);
	await unproven.commands.get("delivery-cancel")?.handler("", unproven.ctx);
});

test("rejects plan approval before confirmation when no reviewer model is usable", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setModelAvailable(false);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.equal(harness.getConfirmCalls(), 0);
	assert.equal(harness.sentUserMessages.length, 0);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /独立审查暂时不可用/);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /固定命令验证本身不依赖模型/);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /No usable subagent model/);
	assert.throws(() => readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /ENOENT/);
	assert.throws(() => readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /ENOENT/);
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
	assert.deepEqual(harness.getActiveTools(), WRITER_ACTIVE_TOOLS);
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
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /需要有效的技术方案批准/);
});

test("blocks restore when runtime plan contract differs from the approved entry", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	const branch = approvalBranch("IMPLEMENTING", harness.sessionId, harness.ctx.cwd);
	(branch.at(-1) as any).data.planContract.validation[0].command = "malicious-command";
	harness.setBranch(branch);

	await emit(harness, "session_start");

	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /运行时实施计划契约与已批准消息不一致/);
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
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /无法证明规划文档/);
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
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /规划文档同步证据与已批准内容不一致/);
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
	const narrowedTools = first.getActiveTools();
	assert.equal(narrowedTools.includes("edit"), false);
	assert.equal(narrowedTools.includes("write"), false);

	const branch = structuredClone(approvedBranch);
	(branch.at(-1) as any).data = persisted;
	const second = createHarness(repo, {
		sessionId: first.sessionId,
		stateRoot: first.stateRoot,
		initialActiveTools: narrowedTools,
	});
	second.setBranch(branch);
	await emit(second, "session_start");

	await second.commands.get("delivery-status")?.handler("", second.ctx);
	assert.deepEqual(
		second.ui.statuses.at(-1),
		["adaptive-delivery", "开发中 [IMPLEMENTING]"],
		second.ui.notifications.at(-1)?.[0],
	);
	assert.deepEqual(second.getActiveTools(), WRITER_ACTIVE_TOOLS);
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

	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已取消 [CANCELLED]"]);
	const confirmations = harness.getConfirmCalls();
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), confirmations);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /没有写入租约/);
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
	assert.equal(rpcHarness.sentUserMessages.length, 0);
	assert.deepEqual(rpcHarness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);

	const tuiHarness = createHarness();
	const tuiBlockedBranch = approvalBranch("BLOCKED", tuiHarness.sessionId, tuiHarness.ctx.cwd);
	(tuiBlockedBranch.at(-1) as any).data.snapshot = { state: "BLOCKED", resumeState: "PLANNING" };
	tuiHarness.setConfirmResult(true);
	tuiHarness.setBranch(tuiBlockedBranch);
	await emit(tuiHarness, "session_start");
	await tuiHarness.commands.get("delivery-resume")?.handler("", tuiHarness.ctx);
	assert.deepEqual(tuiHarness.ui.statuses.at(-1), ["adaptive-delivery", "实施计划编制中 [PLANNING]"]);
	assert.deepEqual(tuiHarness.sentUserMessages.at(-1), {
		content: "/delivery-plan",
		options: { expandPromptTemplates: true },
	});
	assert.match(tuiHarness.sentMessages.at(-1)?.message.content ?? "", /正在继续生成实施计划/);
	await tuiHarness.commands.get("delivery-force-release-lease")?.handler("", tuiHarness.ctx);
	assert.equal(tuiHarness.getConfirmCalls(), 1);
	assert.match(tuiHarness.ui.notifications.at(-1)?.[0] ?? "", /没有写入租约/);
});

test("resume does not auto-continue after TUI cancellation or a failed policy commit", async () => {
	const cancelled = createHarness();
	const cancelledBranch = approvalBranch("BLOCKED", cancelled.sessionId, cancelled.ctx.cwd);
	(cancelledBranch.at(-1) as any).data.snapshot = { state: "BLOCKED", resumeState: "PLANNING" };
	cancelled.setBranch(cancelledBranch);
	await emit(cancelled, "session_start");
	await cancelled.commands.get("delivery-resume")?.handler("", cancelled.ctx);
	assert.equal(cancelled.getConfirmCalls(), 1);
	assert.equal(cancelled.sentUserMessages.length, 0);
	assert.deepEqual(cancelled.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);

	const failed = createHarness();
	const failedBranch = approvalBranch("BLOCKED", failed.sessionId, failed.ctx.cwd);
	(failedBranch.at(-1) as any).data.snapshot = { state: "BLOCKED", resumeState: "PLANNING" };
	failed.setBranch(failedBranch);
	failed.setConfirmResult(true);
	await emit(failed, "session_start");
	failed.failSetActiveToolsOnFutureCalls([1]);
	await failed.commands.get("delivery-resume")?.handler("", failed.ctx);
	assert.equal(failed.sentUserMessages.length, 0);
	assert.deepEqual(failed.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
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
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
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
	assert.deepEqual(harness.getActiveTools(), VALIDATION_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "验证中 [VALIDATING]"]);
	await assert.rejects(
		review.execute("review-before-validation", {}, undefined, undefined, harness.ctx),
		/requires passed fixed validation evidence/,
	);

	const updates: any[] = [];
	const validation = await validate.execute("validate-1", {}, undefined, (update: any) => updates.push(update), harness.ctx);
	assert.match(validation.details.runId, /^[a-f0-9-]{36}$/);
	assert.equal(validation.details.candidateDigest, candidateDigest);
	assert.equal(validation.details.result.status, "passed");
	assert.match(validation.content[0].text, /unit：通过/);
	assert.equal(updates.length >= 2, true);
	assert.match(updates[0].content[0].text, /正在启动固定验证/);
	assert.match(updates.at(-1).content[0].text, /unit：通过/);
	assert.equal(harness.execCalls.some((call) => call.args.includes("npm test")), true);
	assert.equal(
		harness.emittedEvents.some((entry) => entry.event === "subagents:rpc:v1:request" && entry.payload.method === "spawn"),
		false,
	);
	await emitBus(harness, "subagent:async-complete", { runId: "unrelated", success: true, status: "completed" });
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
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已交付 [DELIVERED]"]);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.validationStatus, "passed");
	assert.equal(persisted.reviewEvidence.verdict, "OK");
	assert.equal(persisted.finalEvidence.candidateDigest, persisted.candidateDigest);
	assert.equal(persisted.finalEvidence.progressArtifacts[0].path, TEST_PLAN_PATH);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const status = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(status, /候选版本：[a-f0-9]{64}（当前有效）/);
	assert.match(status, /验证：已通过（当前有效）/);
	assert.match(status, /审查：通过（当前有效）/);
	writeFileSync(path.join(repo, "tracked.txt"), "changed after delivery\n");
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const staleStatus = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(staleStatus, /候选版本：[a-f0-9]{64}（已过期）/);
	assert.match(staleStatus, /验证：已通过（已过期）/);
	assert.match(staleStatus, /审查：通过（已过期）/);
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
	await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);

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
	await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);
	await harness.tools.get("delivery_review_candidate").execute("review", {}, undefined, undefined, harness.ctx);
	const rework = await harness.tools.get("delivery_begin_rework").execute(
		"rework",
		{ reason: "Fix accepted P1" },
		undefined,
		undefined,
		harness.ctx,
	);

	assert.match(rework.content[0].text, /返工中 \[REWORKING\]/);
	assert.deepEqual(harness.getActiveTools(), WRITER_ACTIVE_TOOLS);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.reworkApproved, true);
	assert.equal(persisted.reviewEvidence.verdict, "BLOCK");
	assert.ok(persisted.writerLease.leaseId);
});

test("fails closed for a validation interrupted before its terminal checkpoint", async () => {
	const repo = candidateRepo();
	const first = createHarness(repo);
	first.setConfirmResult(true);
	const approvedBranch = approvalBranch("PLAN_PENDING_APPROVAL", first.sessionId, first.ctx.cwd);
	first.setBranch(approvedBranch);
	installSubagentRpcResponder(first);
	await emit(first, "session_start");
	await first.commands.get("delivery-approve-plan")?.handler("", first.ctx);
	await first.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, first.ctx);
	const pending = structuredClone(first.appendedEntries.at(-1)?.data as any);
	pending.validationRunId = "interrupted-validation";
	pending.validationStatus = "pending";
	pending.validationFailureKind = undefined;
	assert.equal(pending.validationStatus, "pending");
	await emit(first, "session_shutdown");

	const branch = structuredClone(approvedBranch);
	(branch.at(-1) as any).data = pending;
	const second = createHarness(repo, { sessionId: first.sessionId, stateRoot: first.stateRoot });
	second.setBranch(branch);
	installSubagentRpcResponder(second);
	await emit(second, "session_start");

	const restored = second.appendedEntries.at(-1)?.data as any;
	assert.equal(restored.snapshot.state, "BLOCKED");
	assert.equal(restored.snapshot.resumeState, "VALIDATING");
	assert.equal(restored.validationStatus, "failed");
	assert.equal(restored.validationFailureKind, "infrastructure");
	assert.match(restored.blockingReason, /interrupted before its terminal checkpoint/);
	assert.deepEqual(second.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
});

test("preserves approvals but blocks an old passed validation without command evidence", async () => {
	const repo = candidateRepo();
	const first = createHarness(repo);
	first.setConfirmResult(true);
	const approvedBranch = approvalBranch("PLAN_PENDING_APPROVAL", first.sessionId, first.ctx.cwd);
	first.setBranch(approvedBranch);
	installSubagentRpcResponder(first);
	await emit(first, "session_start");
	await first.commands.get("delivery-approve-plan")?.handler("", first.ctx);
	await first.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, first.ctx);
	const legacy = structuredClone(first.appendedEntries.at(-1)?.data as any);
	legacy.validationRunId = "old-validation-run";
	legacy.validationStatus = "passed";
	legacy.validationFailureKind = undefined;
	delete legacy.validationEvidence;
	await emit(first, "session_shutdown");

	const branch = structuredClone(approvedBranch);
	(branch.at(-1) as any).data = legacy;
	const second = createHarness(repo, { sessionId: first.sessionId, stateRoot: first.stateRoot });
	second.setBranch(branch);
	installSubagentRpcResponder(second);
	await emit(second, "session_start");

	const restored = second.appendedEntries.at(-1)?.data as any;
	assert.equal(restored.snapshot.state, "BLOCKED");
	assert.equal(restored.snapshot.resumeState, "VALIDATING");
	assert.equal(restored.validationStatus, "failed");
	assert.equal(restored.validationFailureKind, "infrastructure");
	assert.ok(restored.approvals.plan);
	assert.match(restored.blockingReason, /no recoverable command evidence/);
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

test("blocks a failed approved command and ignores unrelated async completion", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	installSubagentRpcResponder(harness);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	harness.setExecResult({ stdout: "", stderr: "tests failed", code: 1, killed: false });
	const validation = await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	assert.equal((harness.appendedEntries.at(-1)?.data as any).validationStatus, "failed");
	assert.equal((harness.appendedEntries.at(-1)?.data as any).validationFailureKind, "candidate");
	assert.match(validation.content[0].text, /unit：失败/);
	assert.match(validation.content[0].text, /tests failed/);
	const entryCount = harness.appendedEntries.length;
	await emitBus(harness, "subagent:async-complete", {
		runId: validation.details.runId,
		success: true,
		status: "completed",
	});
	assert.equal(harness.appendedEntries.length, entryCount);
});

test("retries an interrupted validation without opening code rework", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	const interrupted = new AbortController();
	interrupted.abort();
	const validation = await harness.tools.get("delivery_validate").execute("validate", {}, interrupted.signal, undefined, harness.ctx);
	assert.equal(validation.details.result.status, "infrastructure");
	let blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "VALIDATING");
	assert.equal(blocked.validationFailureKind, "infrastructure");

	await harness.commands.get("delivery-resume")?.handler("", harness.ctx);
	await assert.rejects(
		harness.tools.get("delivery_begin_rework").execute(
			"rework-infrastructure",
			{ reason: "validation command was interrupted" },
			undefined,
			undefined,
			harness.ctx,
		),
		/infrastructure failure must be retried/,
	);
	const runtimeStatus = await harness.tools.get("delivery_runtime_status").execute(
		"runtime-status-infrastructure",
		{},
		undefined,
		undefined,
		harness.ctx,
	);
	assert.match(runtimeStatus.content[0].text, /重试 delivery_validate，不要返工代码/);
	await harness.tools.get("delivery_validate").execute("retry-validation", {}, undefined, undefined, harness.ctx);
	const retried = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(retried.validationStatus, "passed");
	assert.equal(retried.validationFailureKind, undefined);
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
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	const confirmations = harness.getConfirmCalls();
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), confirmations);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /没有写入租约/);
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
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
});

test("temporary BLOCKED invalidation preserves the approved implementation bundle and resumes", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	const solutionBefore = readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8");
	const planBefore = readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8");

	const result = await harness.tools.get("delivery_invalidate").execute(
		"temporary-block",
		{ target: "BLOCKED", reason: "current-stage tool unavailable" },
		undefined,
		undefined,
		harness.ctx,
	);

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(blocked.approvals.solution.kind, "solution");
	assert.equal(blocked.approvals.plan.kind, "plan");
	assert.equal(blocked.planContract.version, 2);
	assert.equal(blocked.planningDocuments.solutionPath, TEST_SOLUTION_PATH);
	assert.equal(blocked.writerLease, undefined);
	assert.equal(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), solutionBefore);
	assert.equal(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), planBefore);
	assert.equal(result.details.resumeState, "IMPLEMENTING");
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);

	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /恢复条件：解决阻塞条件后，由 TUI 用户执行 \/delivery-resume/);
	const runtimeStatus = await harness.tools.get("delivery_runtime_status").execute(
		"runtime-status-blocked",
		{},
		undefined,
		undefined,
		harness.ctx,
	);
	assert.equal(runtimeStatus.details.state, "BLOCKED");
	assert.equal(runtimeStatus.details.resumeState, "IMPLEMENTING");
	assert.match(runtimeStatus.content[0].text, /Agent 不能自行恢复权限/);

	await harness.commands.get("delivery-resume")?.handler("", harness.ctx);
	const resumed = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(resumed.snapshot.state, "IMPLEMENTING");
	assert.equal(resumed.approvals.plan.kind, "plan");
	assert.equal(resumed.planningDocuments.planPath, TEST_PLAN_PATH);
	assert.ok(resumed.writerLease?.leaseId);
	assert.deepEqual(harness.getActiveTools(), WRITER_ACTIVE_TOOLS);
	assert.deepEqual(harness.sentUserMessages.at(-1), {
		content: "/delivery-run",
		options: { expandPromptTemplates: true },
	});
	assert.match(harness.sentMessages.at(-1)?.message.content ?? "", /正在从已批准断点继续/);
	await harness.commands.get("delivery-cancel")?.handler("", harness.ctx);
});

test("resume keeps the restored writer state when automatic continuation fails", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_invalidate").execute(
		"temporary-block-before-send-failure",
		{ target: "BLOCKED", reason: "temporary runtime interruption" },
		undefined,
		undefined,
		harness.ctx,
	);
	const sentBeforeResume = harness.sentUserMessages.length;
	harness.failAutomaticContinuation();

	await harness.commands.get("delivery-resume")?.handler("", harness.ctx);

	const resumed = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(resumed.snapshot.state, "IMPLEMENTING");
	assert.ok(resumed.writerLease?.leaseId);
	assert.equal(harness.sentUserMessages.length, sentBeforeResume);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /自动继续失败/);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /请手动运行 \/delivery-run/);
	await harness.commands.get("delivery-cancel")?.handler("", harness.ctx);
});

test("temporary BLOCKED preserves completed validation evidence", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	const validation = await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);
	await harness.tools.get("delivery_invalidate").execute(
		"temporary-validation-block",
		{ target: "BLOCKED", reason: "runtime notification interrupted" },
		undefined,
		undefined,
		harness.ctx,
	);

	let blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.resumeState, "VALIDATING");
	assert.equal(blocked.validationRunId, validation.details.runId);
	assert.equal(blocked.validationStatus, "passed");
	assert.match(blocked.candidateDigest, /^[a-f0-9]{64}$/);

	await harness.commands.get("delivery-resume")?.handler("", harness.ctx);
	const resumed = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(resumed.snapshot.state, "VALIDATING");
	assert.equal(resumed.validationStatus, "passed");
	assert.deepEqual(harness.getActiveTools(), VALIDATION_ACTIVE_TOOLS);
	assert.deepEqual(harness.sentUserMessages.at(-1), {
		content: "/delivery-run",
		options: { expandPromptTemplates: true },
	});
});
