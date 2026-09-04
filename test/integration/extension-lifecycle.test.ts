import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCurrentSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";

import deliveryGate from "../../extensions/delivery-gate/index.ts";
import { digestApprovalContent } from "../../extensions/delivery-gate/src/approvals.ts";
import { DIAGRAM_ENTRY_CUSTOM_TYPE } from "../../extensions/delivery-gate/src/diagrams.ts";
import {
	digestPlanningDocumentContent,
	PLANNING_DOCUMENT_EVIDENCE_VERSION,
} from "../../extensions/delivery-gate/src/planning-documents.ts";
import {
	DELIVERY_STATE_CUSTOM_TYPE,
	createInitialRuntimeState,
	parseRuntimeState,
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

function fixtureDocumentIdentity(cwd: string, relativeFile: string) {
	const root = realpathSync(cwd);
	const stats = lstatSync(path.join(root, relativeFile));
	const parentIdentities: Array<{ relativePath: string; dev: number; ino: number }> = [];
	let current = "";
	for (const component of path.dirname(relativeFile).split(path.sep).filter((value) => value !== ".")) {
		current = current ? path.join(current, component) : component;
		const parent = lstatSync(path.join(root, current));
		parentIdentities.push({ relativePath: current, dev: parent.dev, ino: parent.ino });
	}
	return { fileIdentity: { dev: stats.dev, ino: stats.ino }, parentIdentities };
}
const BASE_ACTIVE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"delivery_runtime_status",
	"delivery_invalidate",
];
const IDLE_ACTIVE_TOOLS = [...BASE_ACTIVE_TOOLS.slice(0, 5), "delivery_begin", ...BASE_ACTIVE_TOOLS.slice(5)];
const READONLY_ACTIVE_TOOLS = [...BASE_ACTIVE_TOOLS, "delivery_delegate_readonly"];
const WRITER_ACTIVE_TOOLS = [...BASE_ACTIVE_TOOLS, "edit", "write", "delivery_submit_candidate"];
const DELEGATED_WRITER_ACTIVE_TOOLS = [...BASE_ACTIVE_TOOLS, "delivery_delegate_worker"];
const VALIDATION_ACTIVE_TOOLS = [
	...BASE_ACTIVE_TOOLS,
	"delivery_progress_sync",
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
	setWorkingVisible(visible: boolean): void;
	workingVisibility: boolean[];
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
	const entryRenderers = new Map<string, Handler>();
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
	let execExecution: (() => void) | undefined;
	const execCalls: Array<{ command: string; args: string[] }> = [];
	let reviewText: string | undefined;
	let currentModel: any = TEST_MODEL;
	let workerResponseStatus = "completed";
	let workerIncludeTerminalDigest = true;
	let workerIncludeTerminalRunId = true;
	let workerExecution: (() => void) | undefined;
	let failSendUserMessage = false;
	let failNextWorkingVisibilityAfterEffect = false;
	const ui: FakeUi = {
		statuses: [],
		notifications: [],
		workingVisibility: [],
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
		setWorkingVisible(visible) {
			this.workingVisibility.push(visible);
			if (failNextWorkingVisibilityAfterEffect) {
				failNextWorkingVisibilityAfterEffect = false;
				throw new Error("setWorkingVisible injected failure");
			}
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
		registerEntryRenderer: (customType: string, renderer: Handler) => {
			entryRenderers.set(customType, renderer);
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args: [...args] });
			const execute = execExecution;
			execExecution = undefined;
			execute?.();
			return { ...execResult };
		},
			appendEntry: (customType: string, data: unknown) => {
				if (failAppend) {
					failAppend = false;
					throw new Error("append failed");
				}
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
	eventListeners.set("subagents:rpc:v1:request", new Set([(payload: any) => {
		if (payload.method !== "ping") return;
		for (const handler of eventListeners.get(`subagents:rpc:v1:reply:${payload.requestId}`) ?? []) {
			handler({
				version: 1,
				requestId: payload.requestId,
				success: true,
				data: { version: 1, methods: ["ping"], capabilities: { asyncSpawn: true } },
			});
		}
	}]));

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
		entryRenderers,
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
		setExecExecution: (execute: () => void) => {
			execExecution = execute;
		},
		invalidateWriterLease: () => {
			const leases = path.join(stateRoot, "leases");
			for (const name of existsSync(leases) ? readdirSync(leases) : []) {
				if (name.endsWith(".json")) unlinkSync(path.join(leases, name));
			}
		},
		failNextWorkingVisibilityAfterEffect: () => {
			failNextWorkingVisibilityAfterEffect = true;
		},
		setReviewText: (value: string) => {
			reviewText = value;
		},
		getReviewText: (task = "") => {
			const verdictMatches = [...(reviewText ?? "Merge verdict: OK").matchAll(/^Merge verdict:\s*(BLOCK|OK WITH NOTES|OK)\s*$/gim)];
			if (reviewText && verdictMatches.length !== 1) return reviewText;
			const candidateDigest = task.match(/^Candidate digest:\s*([a-f0-9]{64})$/m)?.[1] ?? "0".repeat(64);
			const diffDigest = task.match(/^Candidate diff digest:\s*([a-f0-9]{64})$/m)?.[1] ?? "0".repeat(64);
			const verdict = verdictMatches[0]![1]!.toUpperCase().replace(/ /g, "_");
			const findings = verdict === "BLOCK"
				? [{ severity: "P1", path: null, line: null, summary: "Concrete blocking finding" }]
				: [];
			return [
				reviewText ?? "Merge verdict: OK",
				"```adaptive-delivery-review",
				JSON.stringify({ version: 1, candidateDigest, diffDigest, verdict, findings }),
				"```",
			].join("\n");
		},
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
		const runtimeDigest = "b".repeat(64);
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
					agent: "worker",
					model: "adaptive-test/adaptive-test-model:high",
					thinking: "high",
					...(workerResponse.includeDigest ? { launchContractDigest: runtimeDigest } : {}),
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
				agent: payload.agent,
				model: "adaptive-test/adaptive-test-model:high",
				thinking: "high",
				launchContractDigest: runtimeDigest,
				result: { kind: "text", text: harness.getReviewText(payload.task) },
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
	if (needsSolution && canonicalCwd === realpathSync(process.cwd())) {
		throw new Error("Planning document fixtures must use an isolated Git repository");
	}
	const extractedSolution = `${`# ${TEST_REQUIREMENT_NAME}-技术方案`}\n\n保持公开行为不变。\n`;
	const extractedPlan = `${`# ${TEST_REQUIREMENT_NAME}-实施计划`}\n\nStatus: pending\n`;
	if (needsSolution && !existsSync(path.join(cwd, TEST_SOLUTION_PATH))) {
		writeFileSync(path.join(cwd, TEST_SOLUTION_PATH), extractedSolution);
	}
	if (needsPlanApproval) {
		writeFileSync(path.join(cwd, TEST_PLAN_PATH), extractedPlan);
	}
	const solutionIdentity = needsSolution ? fixtureDocumentIdentity(cwd, TEST_SOLUTION_PATH) : undefined;
	const planIdentity = needsPlanApproval ? fixtureDocumentIdentity(cwd, TEST_PLAN_PATH) : undefined;
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
									version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
									requirementName: TEST_REQUIREMENT_NAME,
									solutionPath: TEST_SOLUTION_PATH,
									planPath: TEST_PLAN_PATH,
									selectionSource: "project",
									solutionFileIdentity: solutionIdentity!.fileIdentity,
									solutionParentIdentities: solutionIdentity!.parentIdentities,
									solutionContentDigest: digestPlanningDocumentContent(extractedSolution),
									planFileIdentity: planIdentity!.fileIdentity,
									planParentIdentities: planIdentity!.parentIdentities,
									approvedPlanContentDigest: digestPlanningDocumentContent(extractedPlan),
									planContentDigest: digestPlanningDocumentContent(extractedPlan),
									syncedAt: "2026-01-01T00:01:00.000Z",
								},
						}
					: {}),
				...(needsSolution && !needsPlanApproval
					? {
							solutionDocument: {
								version: PLANNING_DOCUMENT_EVIDENCE_VERSION,
								requirementName: TEST_REQUIREMENT_NAME,
								solutionPath: TEST_SOLUTION_PATH,
								planPath: TEST_PLAN_PATH,
								selectionSource: "project",
								solutionFileIdentity: solutionIdentity!.fileIdentity,
								solutionParentIdentities: solutionIdentity!.parentIdentities,
								solutionContentDigest: digestPlanningDocumentContent(extractedSolution),
								syncedAt: "2026-01-01T00:00:30.000Z",
							},
						}
					: {}),
			},
		},
	];
}

function addApprovedRepairCommand(branch: any[], command = "npm run format"): void {
	const planEntry = branch.find((entry: any) => entry.id === "assistant-1") as any;
	const planContract = JSON.parse(planEntry.message.content[0].text.match(/```adaptive-delivery-plan\n([\s\S]*?)\n```/)![1]);
	planContract.validation[0].repairCommand = command;
	planContract.validation[0].repairTimeoutMs = 30000;
	planEntry.message.content[0].text = planEntry.message.content[0].text.replace(
		/```adaptive-delivery-plan\n[\s\S]*?\n```/,
		`\`\`\`adaptive-delivery-plan\n${JSON.stringify(planContract)}\n\`\`\``,
	);
}

function tinyApprovalBranch(sessionId: string, cwd: string, changeScope = ["tracked.txt"]) {
	const contract = {
		version: 1,
		intent: "Change one local label without changing behavior.",
		nonGoals: ["No API, state, dependency, or architecture changes"],
		changeScope,
		validation: [{ id: "focused", command: "npm test -- tracked", timeoutMs: 120000 }],
		review: "none",
		eligibility: {
			risk: "low",
			uncertainty: "low",
			userOutcomeClear: true,
			productOrArchitectureDecision: false,
			reversibleWorkspaceOnly: true,
			sharedContractChange: false,
			highRiskDomain: false,
			externalSideEffect: false,
			dependencyOrToolchainChange: false,
			focusedDeterministicValidation: true,
		},
	} as const;
	return [
		{ type: "message", id: "tiny-user", message: { role: "user", content: "change one label" } },
		{
			type: "message",
			id: "tiny-assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `Tiny change\n\n\`\`\`adaptive-delivery-tiny\n${JSON.stringify(contract)}\n\`\`\`` }],
			},
		},
		{
			type: "custom",
			id: "tiny-state",
			customType: DELIVERY_STATE_CUSTOM_TYPE,
			data: {
				...createInitialRuntimeState(new Date("2026-01-01T00:00:00.000Z")),
				snapshot: { state: "SHAPING" },
				goal: "change one label",
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

	assert.deepEqual(harness.getActiveTools(), IDLE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "空闲 [IDLE]"]);
	assert.ok(harness.commands.has("delivery-status"));
	assert.equal(harness.appendedEntries.length, 1);
	assert.equal(harness.appendedEntries[0]?.customType, DELIVERY_STATE_CUSTOM_TYPE);

	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const statusText = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(statusText, /状态：空闲 \[IDLE\]/);
	assert.match(statusText, /子 Agent runtime：bundled pi-subagents 0\.64\.0（唯一 owner）/);
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
	assert.deepEqual(runtimeStatus.details.activeTools, IDLE_ACTIVE_TOOLS);
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

test("collects assistant Mermaid at message end and appends display-only diagrams after agent end", async () => {
	const harness = createHarness();
	const markdown = [
		"# 技术方案",
		"",
		"```mermaid",
		"sequenceDiagram",
		"  actor U as 用户",
		"  participant P as 父 Pi",
		"  U->>P: 提出需求",
		"```",
	].join("\n");
	const transformed = harness.markdownTransformers[0]!(markdown, { messageType: "assistant" });
	assert.doesNotMatch(transformed, /sequenceDiagram/);
	assert.match(transformed, /时序图 1 已在下方渲染/);
	assert.equal(harness.entryRenderers.has(DIAGRAM_ENTRY_CUSTOM_TYPE), true);

	await emit(harness, "agent_start");
	await emitWithResults(harness, "message_end", {
		message: {
			role: "assistant",
			content: [{ type: "text", text: markdown }],
			stopReason: "stop",
		},
	});
	assert.equal(harness.appendedEntries.some((entry) => entry.customType === DIAGRAM_ENTRY_CUSTOM_TYPE), false);
	await emit(harness, "agent_end");

	const diagrams = harness.appendedEntries.filter((entry) => entry.customType === DIAGRAM_ENTRY_CUSTOM_TYPE);
	assert.equal(diagrams.length, 1);
	assert.equal((diagrams[0]!.data as any).diagrams[0].kind, "sequence");
	assert.match((diagrams[0]!.data as any).diagrams[0].ascii, /提出需求/);
});

test("only a real delivery-shape input can begin shaping from IDLE", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");
	const begin = harness.tools.get("delivery_begin");
	assert.ok(begin);
	await assert.rejects(
		begin.execute("begin-unarmed", { goal: "Read-only inventory" }, undefined, undefined, harness.ctx),
		/requires a real \/delivery-shape input/,
	);
	await emitWithResults(harness, "input", { text: "/delivery-shape Injected", source: "extension" });
	await assert.rejects(
		begin.execute("begin-injected", { goal: "Injected delivery" }, undefined, undefined, harness.ctx),
		/requires a real \/delivery-shape input/,
	);
	await emitWithResults(harness, "input", { text: "/delivery-shape Add a safe feature", source: "interactive" });

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

test("reapplies phase tools before each agent run after provider tools are dynamically activated", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");
	await emitWithResults(harness, "input", { text: "/delivery-shape Add a safe feature", source: "interactive" });
	await harness.tools.get("delivery_begin").execute(
		"begin-dynamic-tools",
		{ goal: "Add a safe feature" },
		undefined,
		undefined,
		harness.ctx,
	);
	harness.setActiveTools([
		...harness.getActiveTools(),
		"exec_command",
		"write_stdin",
		"apply_patch",
		"view_image",
		"delivery_begin",
		"delivery_progress_sync",
	]);

	await emit(harness, "before_agent_start");

	assert.deepEqual(harness.getActiveTools(), READONLY_ACTIVE_TOOLS);
});

test("filters tools injected after the delivery before-agent handler from provider payloads", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");
	await emitWithResults(harness, "input", { text: "/delivery-shape Add a safe feature", source: "interactive" });
	await harness.tools.get("delivery_begin").execute(
		"begin-provider-payload",
		{ goal: "Add a safe feature" },
		undefined,
		undefined,
		harness.ctx,
	);
	await emit(harness, "before_agent_start");
	harness.setActiveTools([...harness.getActiveTools(), "exec_command", "apply_patch"]);

	const results = await emitWithResults(harness, "before_provider_request", {
		payload: {
			tools: [
				{ type: "function", function: { name: "read", parameters: {} } },
				{ type: "custom", custom: { name: "grep", format: {} } },
				{ type: "function", function: { name: "exec_command", parameters: {} } },
				{ type: "custom", name: "apply_patch" },
				{ functionDeclarations: [{ name: "grep" }, { name: "write_stdin" }] },
			],
			functions: [{ name: "ls" }, { name: "delivery_begin" }],
			context: { tools: [{ name: "find" }, { name: "view_image" }] },
			messages: [{ role: "system", tools: [{ name: "ls" }, { name: "exec_command" }] }],
		},
	});

	const payload = results[0] as any;
	assert.deepEqual(payload.tools, [
		{ type: "function", function: { name: "read", parameters: {} } },
		{ type: "custom", custom: { name: "grep", format: {} } },
		{ functionDeclarations: [{ name: "grep" }] },
	]);
	assert.deepEqual(payload.functions, [{ name: "ls" }]);
	assert.deepEqual(payload.context.tools, [{ name: "find" }]);
	assert.deepEqual(payload.messages, [{ role: "system", tools: [{ name: "ls" }] }]);
});

test("blocks before a new agent run when the retained writer lease is no longer current", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard"));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	harness.invalidateWriterLease();

	await emit(harness, "before_agent_start");

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.ok(blocked.writerLease?.leaseId);
	assert.match(blocked.blockingReason, /writer lease/);
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.equal(harness.getActiveTools().includes("delivery_progress_sync"), false);
});

test("blocks before a new agent run when an approved planning document changed", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard"));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	writeFileSync(path.join(repo, TEST_PLAN_PATH), "manually changed between agent runs\n");

	await emit(harness, "before_agent_start");

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.match(blocked.blockingReason, /plan document/i);
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
});

test("blocks raw provider adapters and phase-invalid control tools before execution", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");

	for (const toolName of ["bash", "powershell", "exec_command", "write_stdin", "apply_patch", "subagent"]) {
		const results = await emitWithResults(harness, "tool_call", {
			toolCallId: `raw-${toolName}`,
			toolName,
			input: {},
		});
		assert.match((results[0] as any).reason, new RegExp(`Raw ${toolName}`));
	}

	await emitWithResults(harness, "input", { text: "/delivery-shape Add a safe feature", source: "interactive" });
	await harness.tools.get("delivery_begin").execute(
		"begin-phase-guard",
		{ goal: "Add a safe feature" },
		undefined,
		undefined,
		harness.ctx,
	);
	const begin = await emitWithResults(harness, "tool_call", {
		toolCallId: "begin-in-shaping",
		toolName: "delivery_begin",
		input: { goal: "wrong" },
	});
	assert.match((begin[0] as any).reason, /only allowed.*IDLE/);
	const progress = await emitWithResults(harness, "tool_call", {
		toolCallId: "progress-in-shaping",
		toolName: "delivery_progress_sync",
		input: {},
	});
	assert.match((progress[0] as any).reason, /only allowed.*VALIDATING or BLOCKED/);
});

test("blocks an arbitrary tool injected after the last successful delivery policy", async () => {
	const harness = createHarness();
	await emit(harness, "session_start");
	await emitWithResults(harness, "input", { text: "/delivery-shape Add a safe feature", source: "interactive" });
	await harness.tools.get("delivery_begin").execute(
		"begin-late-tool",
		{ goal: "Add a safe feature" },
		undefined,
		undefined,
		harness.ctx,
	);
	harness.setActiveTools([...harness.getActiveTools(), "dangerous_write"]);

	const results = await emitWithResults(harness, "tool_call", {
		toolCallId: "late-dangerous-write",
		toolName: "dangerous_write",
		input: { path: "tracked.txt" },
	});

	assert.equal((results[0] as any).block, true);
	assert.match((results[0] as any).reason, /not authorized by the current Adaptive Delivery policy/);
});

test("bounds shaping reads per call and per agent run", async () => {
	const idle = createHarness();
	await emit(idle, "session_start");
	const idleRead = { path: "README.md", limit: 2_000 };
	await emitWithResults(idle, "tool_call", { toolCallId: "idle-read", toolName: "read", input: idleRead });
	assert.equal(idleRead.limit, 2_000);

	const harness = createHarness();
	await emit(harness, "session_start");
	await emitWithResults(harness, "input", { text: "/delivery-shape Add a safe feature", source: "interactive" });
	await harness.tools.get("delivery_begin").execute(
		"begin-read-budget",
		{ goal: "Add a safe feature" },
		undefined,
		undefined,
		harness.ctx,
	);
	await emit(harness, "agent_start");
	const first = { path: "README.md", limit: 2_000 };
	await emitWithResults(harness, "tool_call", { toolCallId: "read-0", toolName: "read", input: first });
	assert.equal(first.limit, 500);
	for (let index = 1; index < 10; index += 1) {
		const input = { path: `file-${index}.md`, limit: 500 };
		const results = await emitWithResults(harness, "tool_call", {
			toolCallId: `read-${index}`,
			toolName: "read",
			input,
		});
		assert.equal(results[0], undefined);
		assert.equal(input.limit, 500);
	}
	const exhausted = await emitWithResults(harness, "tool_call", {
		toolCallId: "read-exhausted",
		toolName: "read",
		input: { path: "more.md" },
	});
	assert.match((exhausted[0] as any).reason, /read budget is exhausted/);

	await emit(harness, "agent_start");
	const reset = { path: "after-reset.md" } as { path: string; limit?: number };
	const resetResults = await emitWithResults(harness, "tool_call", {
		toolCallId: "read-after-reset",
		toolName: "read",
		input: reset,
	});
	assert.equal(resetResults[0], undefined);
	assert.equal(reset.limit, 500);
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
	const harness = createHarness(candidateRepo());
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
	assert.equal(existsSync(path.join(repo, TEST_SOLUTION_PATH)), false);
	assert.equal(existsSync(path.join(repo, TEST_PLAN_PATH)), false);
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
	assert.equal(persisted.solutionDocument.solutionPath, TEST_SOLUTION_PATH);
	assert.equal(persisted.writerLease, undefined);
	assert.match(harness.confirmationRequests.at(-1)?.message ?? "", new RegExp(TEST_PLAN_PATH));
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	const statusText = harness.ui.notifications.at(-1)?.[0] ?? "";
	assert.match(statusText, /规划文档：Canvas写路径拆分.*技术方案已同步.*实施计划待同步/);
	assert.match(statusText, /断点：技术方案已同步/);
	assert.match(statusText, /下一步：生成实施计划/);
	assert.match(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /保持公开行为不变/);
	assert.throws(() => readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /ENOENT/);
	assert.deepEqual(harness.sentUserMessages.at(-1), {
		content: "/delivery-plan",
		options: { expandPromptTemplates: true },
	});
	assert.equal(harness.sentMessages.at(-1)?.message.display, true);
	assert.match(harness.sentMessages.at(-1)?.message.content ?? "", /技术方案已批准并写入项目/);
});

test("revises the synchronized solution in place but never overwrites manual changes", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	const initialBranch = approvalBranch("SOLUTION_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd);
	harness.setBranch(initialBranch);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-solution")?.handler("", harness.ctx);
	const firstState = harness.appendedEntries.at(-1)?.data as any;
	const firstDigest = firstState.solutionDocument.solutionContentDigest;

	await harness.commands.get("delivery-revise")?.handler("", harness.ctx);
	const revising = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(revising.snapshot.state, "SHAPING");
	assert.equal(revising.approvals.solution, undefined);
	assert.equal(revising.solutionDocument.solutionPath, TEST_SOLUTION_PATH);
	assert.equal(revising.proposedDocuments.solutionPath, TEST_SOLUTION_PATH);

	const revisedContent = structuredClone((initialBranch.find((entry: any) => entry.id === "assistant-solution") as any).message.content);
	revisedContent[0].text = revisedContent[0].text.replace("保持公开行为不变。", "保持公开行为和错误优先级不变。");
	harness.setBranch([
		...initialBranch,
		{ type: "message", id: "revision-request", message: { role: "user", content: "revise" } },
		{ type: "message", id: "assistant-revised", message: { role: "assistant", content: revisedContent } },
	]);
	await harness.commands.get("delivery-approve-solution")?.handler("", harness.ctx);
	const revisedState = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(revisedState.snapshot.state, "PLANNING");
	assert.equal(revisedState.approvals.solution.entryId, "assistant-revised");
	assert.notEqual(revisedState.solutionDocument.solutionContentDigest, firstDigest);
	assert.match(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /错误优先级不变/);
	assert.equal(existsSync(path.join(repo, TEST_PLAN_PATH)), false);

	await harness.commands.get("delivery-revise")?.handler("", harness.ctx);
	writeFileSync(path.join(repo, TEST_SOLUTION_PATH), "人工修改\n");
	const thirdContent = structuredClone(revisedContent);
	thirdContent[0].text = thirdContent[0].text.replace("错误优先级不变", "错误优先级与排序不变");
	harness.setBranch([
		...initialBranch,
		{ type: "message", id: "manual-revision-request", message: { role: "user", content: "revise again" } },
		{ type: "message", id: "assistant-third", message: { role: "assistant", content: thirdContent } },
	]);
	await harness.commands.get("delivery-approve-solution")?.handler("", harness.ctx);
	assert.equal(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), "人工修改\n");
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /will not be overwritten/);
});

test("revises already synchronized solution and plan documents in place", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	const initialBranch = approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd);
	harness.setBranch(initialBranch);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: pending/);

	await harness.commands.get("delivery-revise")?.handler("", harness.ctx);
	const revising = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(revising.snapshot.state, "SHAPING");
	assert.equal(revising.planningDocuments.planPath, TEST_PLAN_PATH);
	assert.equal(revising.solutionDocument.solutionPath, TEST_SOLUTION_PATH);

	const revisedSolution = structuredClone((initialBranch.find((entry: any) => entry.id === "assistant-solution") as any).message.content);
	revisedSolution[0].text = revisedSolution[0].text.replace("保持公开行为不变。", "保持公开行为与错误优先级不变。");
	const solutionRevisionBranch = [
		...initialBranch,
		{ type: "message", id: "solution-revision-request", message: { role: "user", content: "revise solution" } },
		{ type: "message", id: "assistant-revised-solution", message: { role: "assistant", content: revisedSolution } },
	];
	harness.setBranch(solutionRevisionBranch);
	await harness.commands.get("delivery-approve-solution")?.handler("", harness.ctx);
	assert.match(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /错误优先级不变/);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: pending/);

	const revisedPlan = structuredClone((initialBranch.find((entry: any) => entry.id === "assistant-1") as any).message.content);
	revisedPlan[0].text = revisedPlan[0].text.replace("Status: pending", "Status: revised");
	const revisedPlanContract = JSON.parse(revisedPlan[0].text.match(/```adaptive-delivery-plan\n([\s\S]*?)\n```/)![1]);
	revisedPlanContract.validation[0].command = "npm test -- revised";
	revisedPlan[0].text = revisedPlan[0].text.replace(
		/```adaptive-delivery-plan\n[\s\S]*?\n```/,
		`\`\`\`adaptive-delivery-plan\n${JSON.stringify(revisedPlanContract)}\n\`\`\``,
	);
	harness.setBranch([
		...solutionRevisionBranch,
		{ type: "message", id: "plan-revision-request", message: { role: "user", content: "revise plan" } },
		{ type: "message", id: "assistant-revised-plan", message: { role: "assistant", content: revisedPlan } },
	]);
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: revised/);
	const completed = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(completed.snapshot.state, "IMPLEMENTING");
	assert.equal(completed.solutionDocument, undefined);
	assert.equal(completed.planContract.validation[0].command, "npm test -- revised");
	assert.equal(completed.planningDocuments.planContentDigest, digestPlanningDocumentContent(`# ${TEST_REQUIREMENT_NAME}-实施计划\n\nStatus: revised\n`));
});

test("restores between a synchronized solution revision and the following plan revision", async () => {
	const repo = candidateRepo();
	const first = createHarness(repo);
	first.setConfirmResult(true);
	const initialBranch = approvalBranch("PLAN_PENDING_APPROVAL", first.sessionId, first.ctx.cwd);
	first.setBranch(initialBranch);
	await emit(first, "session_start");
	await first.commands.get("delivery-approve-plan")?.handler("", first.ctx);
	await first.commands.get("delivery-revise")?.handler("", first.ctx);

	const revisedSolution = structuredClone((initialBranch.find((entry: any) => entry.id === "assistant-solution") as any).message.content);
	revisedSolution[0].text = revisedSolution[0].text.replace("保持公开行为不变。", "保持公开行为与恢复语义不变。");
	const revisionBranch = [
		...initialBranch,
		{ type: "message", id: "solution-revision-request", message: { role: "user", content: "revise solution" } },
		{ type: "message", id: "assistant-revised-solution", message: { role: "assistant", content: revisedSolution } },
	];
	first.setBranch(revisionBranch);
	await first.commands.get("delivery-approve-solution")?.handler("", first.ctx);
	const persisted = structuredClone(first.appendedEntries.at(-1)?.data as any);
	assert.equal(persisted.snapshot.state, "PLANNING");
	assert.ok(persisted.solutionDocument);
	assert.ok(persisted.planningDocuments);
	await emit(first, "session_shutdown");

	const second = createHarness(repo, { sessionId: first.sessionId, stateRoot: first.stateRoot });
	second.setBranch([
		...revisionBranch,
		{ type: "custom", id: "revision-state", customType: DELIVERY_STATE_CUSTOM_TYPE, data: persisted },
	]);
	await emit(second, "session_start");

	assert.deepEqual(second.ui.statuses.at(-1), ["adaptive-delivery", "实施计划编制中 [PLANNING]"]);
	assert.match(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /恢复语义不变/);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: pending/);
});

test("reconciles a persisted planning revision intent to only its complete old or new state", async () => {
	for (const outcome of ["previous", "next"] as const) {
		const repo = candidateRepo();
		const harness = createHarness(repo);
		const branch = approvalBranch("IMPLEMENTING", harness.sessionId, harness.ctx.cwd);
		const runtime = (branch.at(-1) as any).data;
		const previous = runtime.planningDocuments;
		const previousSolution = {
			version: previous.version,
			requirementName: previous.requirementName,
			solutionPath: previous.solutionPath,
			planPath: previous.planPath,
			selectionSource: previous.selectionSource,
			solutionFileIdentity: previous.solutionFileIdentity,
			solutionParentIdentities: previous.solutionParentIdentities,
			solutionContentDigest: previous.solutionContentDigest,
			syncedAt: previous.syncedAt,
		};
		const nextContent = `# ${TEST_REQUIREMENT_NAME}-技术方案\n\n恢复到完整新态。\n`;
		const temporary = path.join(repo, "docs", `.revision-${outcome}.tmp`);
		writeFileSync(temporary, nextContent);
		const nextStats = lstatSync(temporary);
		runtime.snapshot = { state: "SHAPING" };
		runtime.approvals = {};
		runtime.planContract = undefined;
		runtime.solutionDocument = previousSolution;
		runtime.planningDocumentRevision = {
			version: 1,
			kind: "solution",
			path: TEST_SOLUTION_PATH,
			previousFileIdentity: previous.solutionFileIdentity,
			previousParentIdentities: previous.solutionParentIdentities,
			previousContentDigest: previous.solutionContentDigest,
			nextFileIdentity: { dev: nextStats.dev, ino: nextStats.ino },
			nextParentIdentities: previous.solutionParentIdentities,
			nextContentDigest: digestPlanningDocumentContent(nextContent),
			preparedAt: "2026-01-01T00:02:00.000Z",
		};
		if (outcome === "next") renameSync(temporary, path.join(repo, TEST_SOLUTION_PATH));
		harness.setBranch(branch);

		await emit(harness, "session_start");

		assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "方案梳理中 [SHAPING]"]);
		const reconciled = harness.appendedEntries.at(-1)?.data as any;
		assert.equal(reconciled.planningDocumentRevision, undefined);
		assert.equal(
			reconciled.solutionDocument.solutionContentDigest,
			outcome === "next" ? digestPlanningDocumentContent(nextContent) : previous.solutionContentDigest,
		);
		assert.equal(reconciled.planningDocuments.solutionContentDigest, reconciled.solutionDocument.solutionContentDigest);
	}
});

test("restores real plan revision intent checkpoints to old or new state before reapproval", async () => {
	for (const outcome of ["previous", "next"] as const) {
		const repo = candidateRepo();
		const first = createHarness(repo);
		first.setConfirmResult(true);
		const initialBranch = approvalBranch("PLAN_PENDING_APPROVAL", first.sessionId, first.ctx.cwd);
		first.setBranch(initialBranch);
		await emit(first, "session_start");
		await first.commands.get("delivery-approve-plan")?.handler("", first.ctx);
		await first.commands.get("delivery-revise")?.handler("plan", first.ctx);

		const oldPlanPath = path.join(repo, "docs", `.plan-revision-${outcome}.old`);
		linkSync(path.join(repo, TEST_PLAN_PATH), oldPlanPath);
		const revisedPlan = structuredClone((initialBranch.find((entry: any) => entry.id === "assistant-1") as any).message.content);
		revisedPlan[0].text = revisedPlan[0].text.replace("Status: pending", `Status: recovered-${outcome}`);
		const revisedPlanContract = JSON.parse(revisedPlan[0].text.match(/```adaptive-delivery-plan\n([\s\S]*?)\n```/)![1]);
		revisedPlanContract.validation[0].command = `npm test -- recovered-${outcome}`;
		revisedPlan[0].text = revisedPlan[0].text.replace(
			/```adaptive-delivery-plan\n[\s\S]*?\n```/,
			`\`\`\`adaptive-delivery-plan\n${JSON.stringify(revisedPlanContract)}\n\`\`\``,
		);
		const revisionBranch = [
			...initialBranch,
			{ type: "message", id: `plan-revision-request-${outcome}`, message: { role: "user", content: "revise plan" } },
			{ type: "message", id: `assistant-revised-plan-${outcome}`, message: { role: "assistant", content: revisedPlan } },
		];
		first.setBranch(revisionBranch);
		await first.commands.get("delivery-approve-plan")?.handler("", first.ctx);

		const intentCheckpoint = structuredClone(
			(first.appendedEntries.find((entry) => (entry.data as any).planningDocumentRevision)?.data ?? null) as any,
		);
		assert.ok(intentCheckpoint?.planningDocumentRevision);
		assert.equal(intentCheckpoint.snapshot.state, "PLANNING");
		assert.equal(intentCheckpoint.approvals.plan, undefined);
		assert.equal(intentCheckpoint.planContract, undefined);
		assert.ok(intentCheckpoint.approvals.solution);
		if (outcome === "previous") renameSync(oldPlanPath, path.join(repo, TEST_PLAN_PATH));
		else unlinkSync(oldPlanPath);
		await emit(first, "session_shutdown");

		const second = createHarness(repo, { sessionId: first.sessionId, stateRoot: first.stateRoot });
		second.setConfirmResult(true);
		second.setBranch([
			...revisionBranch,
			{ type: "custom", id: `plan-intent-${outcome}`, customType: DELIVERY_STATE_CUSTOM_TYPE, data: intentCheckpoint },
		]);
		await emit(second, "session_start");

		assert.deepEqual(second.ui.statuses.at(-1), ["adaptive-delivery", "实施计划编制中 [PLANNING]"]);
		const reconciled = second.appendedEntries.find((entry) => !(entry.data as any).planningDocumentRevision)?.data as any;
		assert.equal(reconciled.planningDocumentRevision, undefined);
		assert.equal(reconciled.approvals.plan, undefined);
		assert.equal(reconciled.planContract, undefined);
		assert.equal(
			reconciled.planningDocuments.planContentDigest,
			outcome === "next"
				? digestPlanningDocumentContent(`# ${TEST_REQUIREMENT_NAME}-实施计划\n\nStatus: recovered-next\n`)
				: intentCheckpoint.planningDocumentRevision.previousContentDigest,
		);
		await second.commands.get("delivery-approve-plan")?.handler("", second.ctx);

		const completed = second.appendedEntries.at(-1)?.data as any;
		assert.equal(
			completed.snapshot.state,
			"IMPLEMENTING",
			JSON.stringify(second.ui.notifications, null, 2),
		);
		assert.equal(completed.approvals.plan.entryId, `assistant-revised-plan-${outcome}`);
		assert.equal(completed.planContract.validation[0].command, `npm test -- recovered-${outcome}`);
		assert.equal(completed.planningDocumentRevision, undefined);
		assert.equal(
			completed.planningDocuments.planContentDigest,
			digestPlanningDocumentContent(`# ${TEST_REQUIREMENT_NAME}-实施计划\n\nStatus: recovered-${outcome}\n`),
		);
	}
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

test("accepts presentation whitespace in the approved requirement name", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	const branch = approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd);
	const planEntry = branch.find((entry: any) => entry.id === "assistant-1") as any;
	planEntry.message.content[0].text = planEntry.message.content[0].text.replace(
		`# ${TEST_REQUIREMENT_NAME}-实施计划`,
		`# Canvas 写路径拆分-实施计划`,
	);
	harness.setBranch(branch);
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.snapshot.state, "IMPLEMENTING");
	assert.equal(persisted.planningDocuments.requirementName, TEST_REQUIREMENT_NAME);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Canvas 写路径拆分/);
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

test("reproves the writer lease before launching the controlled worker", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard"));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	harness.invalidateWriterLease();

	await assert.rejects(
		harness.tools.get("delivery_delegate_worker").execute("worker-stale-lease", {}, undefined, undefined, harness.ctx),
		/requires current authorization and writer lease/,
	);

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(blocked.workerStatus, undefined);
	assert.equal(blocked.candidateDigest, undefined);
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
});

test("blocks without worker preflight when authorization revalidation throws", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard"));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	rmSync(path.join(repo, ".git"), { recursive: true, force: true });

	await assert.rejects(
		harness.tools.get("delivery_delegate_worker").execute("worker-authorization-error", {}, undefined, undefined, harness.ctx),
		/requires current authorization and writer lease/,
	);

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(blocked.workerStatus, undefined);
	assert.equal(blocked.workerLaunchContractDigest, undefined);
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
});

test("reproves approvals and the writer lease before each direct parent write", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "single"));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	assert.equal(harness.getActiveTools().includes("edit"), true);
	harness.invalidateWriterLease();

	const results = await emitWithResults(harness, "tool_call", {
		toolCallId: "parent-write-stale-lease",
		toolName: "edit",
		input: { path: "tracked.txt" },
	});

	assert.match((results[0] as any).reason, /writer lease/);
	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
});

test("runs only the plan-approved deterministic repair after the worker and before candidate freeze", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	const branch = approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard");
	addApprovedRepairCommand(branch);
	harness.setBranch(branch);
	harness.configureWorkerResponse({
		execute: () => writeFileSync(path.join(repo, "worker-change.txt"), "needs formatting\n"),
	});
	harness.setExecExecution(() => writeFileSync(path.join(repo, "worker-change.txt"), "formatted\n"));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	const result = await harness.tools.get("delivery_delegate_worker").execute(
		"worker-with-repair",
		{},
		undefined,
		() => { throw new Error("render failed"); },
		harness.ctx,
	);

	assert.equal(readFileSync(path.join(repo, "worker-change.txt"), "utf8"), "formatted\n");
	assert.deepEqual(harness.execCalls.at(-1), { command: "/bin/sh", args: ["-c", "npm run format"] });
	assert.match(result.details.candidateDigest, /^[a-f0-9]{64}$/);
	assert.equal((harness.appendedEntries.at(-1)?.data as any).snapshot.state, "VALIDATING");
});

test("blocks without freezing a candidate when an approved deterministic repair fails", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	const branch = approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard");
	addApprovedRepairCommand(branch);
	harness.setBranch(branch);
	harness.configureWorkerResponse({
		execute: () => writeFileSync(path.join(repo, "worker-change.txt"), "needs formatting\n"),
	});
	harness.setExecResult({ stdout: "", stderr: "format failed", code: 1, killed: false });
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await assert.rejects(
		harness.tools.get("delivery_delegate_worker").execute("worker-repair-failure", {}, undefined, undefined, harness.ctx),
		/Approved deterministic repair failed/,
	);

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(blocked.candidateDigest, undefined);
	assert.equal(blocked.writerLease, undefined);
	assert.equal(blocked.workerStatus, "completed");
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
});

test("does not run an approved repair when lease ownership changed after worker terminal", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	const branch = approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd, "standard");
	addApprovedRepairCommand(branch);
	harness.setBranch(branch);
	harness.configureWorkerResponse({
		execute: () => {
			writeFileSync(path.join(repo, "worker-change.txt"), "needs formatting\n");
			harness.invalidateWriterLease();
		},
	});
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await assert.rejects(
		harness.tools.get("delivery_delegate_worker").execute("worker-lost-lease", {}, undefined, undefined, harness.ctx),
		/Writer lease ownership changed before approved deterministic repair/,
	);

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(blocked.candidateDigest, undefined);
	assert.equal(harness.execCalls.length, 0);
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
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
		/runtime launch contract digest is missing or malformed/,
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
	assert.match(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /保持公开行为不变/);
	assert.throws(() => readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /ENOENT/);
});

test("Tiny uses one TUI approval, exact scope, focused validation, and no docs or reviewer", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setModelAvailable(false);
	harness.setBranch(tinyApprovalBranch(harness.sessionId, repo));
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	const approved = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(approved.snapshot.state, "IMPLEMENTING");
	assert.equal(approved.tinyContract.version, 1);
	assert.ok(approved.tinyBaseline.candidateDigest);
	assert.equal(approved.planContract, undefined);
	assert.equal(approved.planningDocuments, undefined);
	assert.equal(existsSync(path.join(repo, TEST_SOLUTION_PATH)), false);
	assert.equal(existsSync(path.join(repo, TEST_PLAN_PATH)), false);
	assert.deepEqual(harness.getActiveTools(), WRITER_ACTIVE_TOOLS);
	assert.equal(harness.emittedEvents.some((entry) => entry.event === "subagents:rpc:v1:request"), false);

	const allowed = await emitWithResults(harness, "tool_call", {
		toolCallId: "tiny-allowed",
		toolName: "edit",
		input: { path: "tracked.txt" },
	});
	assert.equal(allowed[0], undefined);
	const denied = await emitWithResults(harness, "tool_call", {
		toolCallId: "tiny-denied",
		toolName: "write",
		input: { path: "outside.txt" },
	});
	assert.match((denied[0] as any).reason, /outside approved scope/);

	writeFileSync(path.join(repo, "tracked.txt"), "tiny change\n");
	const submitted = await harness.tools.get("delivery_submit_candidate").execute("tiny-submit", {}, undefined, undefined, harness.ctx);
	const frozen = harness.appendedEntries.at(-1)?.data as any;
	assert.deepEqual(frozen.tinyScopeEvidence.changedPaths, ["tracked.txt"]);
	assert.equal(frozen.tinyScopeEvidence.candidateDigest, submitted.details.candidateDigest);
	const validated = await harness.tools.get("delivery_validate").execute("tiny-validate", {}, undefined, undefined, harness.ctx);
	assert.equal(validated.details.result.status, "passed");
	assert.equal(harness.execCalls.some((call) => call.args.includes("npm test -- tracked")), true);
	await assert.rejects(
		harness.tools.get("delivery_review_candidate").execute("tiny-review", {}, undefined, undefined, harness.ctx),
		/does not use fresh review/,
	);
	const finalized = await harness.tools.get("delivery_finalize").execute("tiny-finalize", {}, undefined, undefined, harness.ctx);
	assert.match(finalized.content[0].text, /已交付 \[DELIVERED\]/);
	const delivered = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(delivered.reviewEvidence, undefined);
	assert.deepEqual(delivered.finalEvidence.progressArtifacts, []);
});

test("Tiny cannot self-authorize outside an affirmative TUI confirmation", async () => {
	for (const mode of ["rpc", "tui"] as const) {
		const repo = candidateRepo();
		const harness = createHarness(repo);
		harness.setMode(mode);
		harness.setConfirmResult(false);
		harness.setBranch(tinyApprovalBranch(harness.sessionId, repo));
		await emit(harness, "session_start");
		await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
		assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "方案梳理中 [SHAPING]"]);
		assert.equal(harness.getActiveTools().includes("edit"), false);
		assert.equal(harness.getConfirmCalls(), mode === "tui" ? 1 : 0);
	}
});

test("Tiny rejects dirty baseline and out-of-scope generated delta", async () => {
	const dirtyRepo = candidateRepo();
	writeFileSync(path.join(dirtyRepo, "unrelated.txt"), "existing dirty\n");
	const dirty = createHarness(dirtyRepo);
	dirty.setConfirmResult(true);
	dirty.setBranch(tinyApprovalBranch(dirty.sessionId, dirtyRepo));
	await emit(dirty, "session_start");
	await dirty.commands.get("delivery-approve-plan")?.handler("", dirty.ctx);
	assert.match(dirty.ui.notifications.at(-1)?.[0] ?? "", /必须升级 Standard/);
	assert.deepEqual(dirty.ui.statuses.at(-1), ["adaptive-delivery", "方案梳理中 [SHAPING]"]);

	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(tinyApprovalBranch(harness.sessionId, repo));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	writeFileSync(path.join(repo, "tracked.txt"), "approved partial change\n");
	writeFileSync(path.join(repo, "generated.txt"), "unexpected\n");
	await assert.rejects(
		harness.tools.get("delivery_submit_candidate").execute("tiny-submit", {}, undefined, undefined, harness.ctx),
		/scope/,
	);
	assert.equal(readFileSync(path.join(repo, "tracked.txt"), "utf8"), "approved partial change\n");
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
});

test("Tiny scope expansion invalidates authorization while preserving partial diff", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(tinyApprovalBranch(harness.sessionId, repo));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	writeFileSync(path.join(repo, "tracked.txt"), "partial tiny change\n");
	await harness.tools.get("delivery_invalidate").execute(
		"tiny-escalate",
		{ target: "SHAPING", reason: "Scope expanded to a shared API; upgrade to Standard" },
		undefined,
		undefined,
		harness.ctx,
	);
	const invalidated = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(invalidated.snapshot.state, "SHAPING");
	assert.equal(invalidated.tinyContract, undefined);
	assert.equal(invalidated.tinyBaseline, undefined);
	assert.equal(invalidated.tinyScopeEvidence, undefined);
	assert.equal(invalidated.writerLease, undefined);
	assert.equal(readFileSync(path.join(repo, "tracked.txt"), "utf8"), "partial tiny change\n");
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
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
	writeFileSync(path.join(repo, TEST_PLAN_PATH), "existing plan\n");
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");

	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);

	assert.match(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /保持公开行为不变/);
	assert.equal(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), "existing plan\n");
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
		assert.match(readFileSync(path.join(repo, TEST_SOLUTION_PATH), "utf8"), /保持公开行为不变/);
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
	const harness = createHarness(candidateRepo());
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
	(branch.at(-1) as any).data.planningDocuments.approvedPlanContentDigest = "a".repeat(64);
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
	const rpcHarness = createHarness(candidateRepo());
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

	const tuiHarness = createHarness(candidateRepo());
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
	const cancelled = createHarness(candidateRepo());
	const cancelledBranch = approvalBranch("BLOCKED", cancelled.sessionId, cancelled.ctx.cwd);
	(cancelledBranch.at(-1) as any).data.snapshot = { state: "BLOCKED", resumeState: "PLANNING" };
	cancelled.setBranch(cancelledBranch);
	await emit(cancelled, "session_start");
	await cancelled.commands.get("delivery-resume")?.handler("", cancelled.ctx);
	assert.equal(cancelled.getConfirmCalls(), 1);
	assert.equal(cancelled.sentUserMessages.length, 0);
	assert.deepEqual(cancelled.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);

	const failed = createHarness(candidateRepo());
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
	harness.failNextWorkingVisibilityAfterEffect();
	const validation = await validate.execute("validate-1", {}, undefined, (update: any) => updates.push(update), harness.ctx);
	assert.match(validation.details.runId, /^[a-f0-9-]{36}$/);
	assert.equal(validation.details.candidateDigest, candidateDigest);
	assert.equal(validation.details.result.status, "passed");
	assert.match(validation.content[0].text, /unit：通过/);
	assert.deepEqual(harness.ui.workingVisibility, [false, true]);
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
	assert.match(reviewed.details.candidateDiffDigest, /^[a-f0-9]{64}$/);
	const reviewRequest = harness.emittedEvents.find(
		(entry) => entry.event === "prompt-template:subagent:request" && entry.payload.agent === "reviewer",
	);
	assert.match(reviewRequest?.payload.task ?? "", /=== TRACKED WORKTREE DIFF ===/);
	assert.match(reviewRequest?.payload.task ?? "", new RegExp(`Candidate digest: ${candidateDigest}`));
	assert.match(reviewRequest?.payload.task ?? "", /Candidate diff digest: [a-f0-9]{64}/);

	writeFileSync(path.join(repo, "tracked.txt"), "changed after validation\n");
	await assert.rejects(
		validate.execute("validate-2", {}, undefined, undefined, harness.ctx),
		/stale/,
	);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
});

test("ignores validation artifacts but blocks and diagnoses real candidate drift", async () => {
	const repo = candidateRepo();
	writeFileSync(path.join(repo, ".gitignore"), "runtime-cache/\n");
	execFileSync("git", ["add", ".gitignore"], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "ignore runtime cache"], {
		cwd: repo,
	});
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	harness.setExecExecution(() => {
		mkdirSync(path.join(repo, "runtime-cache"));
		writeFileSync(path.join(repo, "runtime-cache", "result.bin"), "generated during validation\n");
	});
	const validation = await harness.tools.get("delivery_validate").execute(
		"validate",
		{},
		undefined,
		() => { throw new Error("render failed"); },
		harness.ctx,
	);
	assert.equal(validation.details.result.status, "passed");
	assert.equal(validation.details.staleCandidate, undefined);
	const persisted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(persisted.snapshot.state, "VALIDATING");
	assert.equal(persisted.validationStatus, "passed");
	assert.ok(persisted.validationEvidence);

	harness.setExecExecution(() => {
		writeFileSync(path.join(repo, "tracked.txt"), "changed during validation\n");
	});
	const entryCountBeforeStaleValidation = harness.appendedEntries.length;
	const stale = await harness.tools.get("delivery_validate").execute("validate-stale", {}, undefined, undefined, harness.ctx);
	assert.equal(harness.appendedEntries.length, entryCountBeforeStaleValidation + 2);
	assert.equal(stale.details.staleCandidate, true);
	assert.match(stale.content[0].text, /unit：通过/);
	assert.match(stale.content[0].text, /仅用于诊断，不构成当前候选版本的 validation evidence/);
	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "VALIDATING");
	assert.equal(blocked.validationStatus, "failed");
	assert.equal(blocked.validationFailureKind, undefined);
	assert.equal(blocked.validationEvidence, undefined);
	assert.equal(
		blocked.checkpoint.nextReadyAction,
		"Restore the frozen candidate and resume, or revise the plan for intentional drift",
	);
	assert.match(stale.content[0].text, /\/delivery-resume/);
	assert.match(stale.content[0].text, /\/delivery-revise plan/);
});

test("fails closed when the stale validation terminal checkpoint cannot be persisted", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	harness.setExecExecution(() => {
		writeFileSync(path.join(repo, "tracked.txt"), "changed during validation\n");
		harness.failNextAppend();
	});
	await assert.rejects(
		harness.tools.get("delivery_validate").execute("validate-stale-persist-failure", {}, undefined, undefined, harness.ctx),
		/terminal checkpoint could not be persisted/,
	);
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
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
	assert.equal(parseRuntimeState(persisted).ok, true);
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

test("rejects bare reviewer output without candidate/diff-bound evidence", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setReviewText("Everything looks good.");
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	installSubagentRpcResponder(harness);
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);

	await assert.rejects(
		harness.tools.get("delivery_review_candidate").execute("review", {}, undefined, undefined, harness.ctx),
		/candidate\/diff-bound review evidence/,
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

test("resumes partial rework without treating its edits as frozen-candidate drift", async () => {
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
	await harness.tools.get("delivery_begin_rework").execute(
		"rework",
		{ reason: "Fix accepted P1" },
		undefined,
		undefined,
		harness.ctx,
	);
	writeFileSync(path.join(repo, "tracked.txt"), "partial rework\n");
	await harness.tools.get("delivery_invalidate").execute(
		"temporary-rework-block",
		{ target: "BLOCKED", reason: "temporary interruption" },
		undefined,
		undefined,
		harness.ctx,
	);

	await harness.commands.get("delivery-resume")?.handler("", harness.ctx);

	const resumed = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(resumed.snapshot.state, "REWORKING");
	assert.equal(resumed.reworkApproved, true);
	assert.equal(resumed.reviewEvidence.verdict, "BLOCK");
	assert.equal(resumed.reviewEvidence.candidateDigest, resumed.candidateDigest);
	assert.ok(resumed.writerLease?.leaseId);
	assert.deepEqual(harness.getActiveTools(), WRITER_ACTIVE_TOOLS);
	await harness.commands.get("delivery-cancel")?.handler("", harness.ctx);
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

test("keeps the lease and blocks a running worker after hot restore loses terminal observation", async () => {
	const repo = candidateRepo();
	const first = createHarness(repo);
	first.setConfirmResult(true);
	const approvedBranch = approvalBranch("PLAN_PENDING_APPROVAL", first.sessionId, first.ctx.cwd, "standard");
	first.setBranch(approvedBranch);
	await emit(first, "session_start");
	await first.commands.get("delivery-approve-plan")?.handler("", first.ctx);
	const running = structuredClone(first.appendedEntries.at(-1)?.data as any);
	running.workerRunId = "unobserved-worker";
	running.workerStatus = "running";
	running.workerLaunchContractDigest = "a".repeat(64);
	await emit(first, "session_shutdown");

	const branch = structuredClone(approvedBranch);
	(branch.at(-1) as any).data = running;
	const second = createHarness(repo, { sessionId: first.sessionId, stateRoot: first.stateRoot });
	second.setConfirmResult(true);
	second.setBranch(branch);
	await emit(second, "session_start");

	const restored = second.appendedEntries.at(-1)?.data as any;
	assert.equal(restored.snapshot.state, "BLOCKED");
	assert.equal(restored.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(restored.workerStatus, "running");
	assert.equal(restored.workerRunId, "unobserved-worker");
	assert.ok(restored.writerLease?.leaseId);
	assert.match(restored.blockingReason, /terminal status is unknown/);
	assert.deepEqual(second.getActiveTools(), BASE_ACTIVE_TOOLS);
	await second.commands.get("delivery-resume")?.handler("", second.ctx);
	const stillBlocked = second.appendedEntries.at(-1)?.data as any;
	assert.equal(stillBlocked.snapshot.state, "BLOCKED");
	assert.equal(stillBlocked.snapshot.resumeState, "IMPLEMENTING");
	assert.equal(stillBlocked.workerStatus, "running");
	assert.ok(stillBlocked.writerLease?.leaseId);
	assert.match(stillBlocked.blockingReason, /Worker terminal status is still unknown/);
	assert.deepEqual(second.getActiveTools(), BASE_ACTIVE_TOOLS);
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
	assert.deepEqual(harness.ui.workingVisibility, [false, true]);
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
	const synchronized = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(synchronized.planningDocuments.approvedPlanContentDigest, digestPlanningDocumentContent(`# ${TEST_REQUIREMENT_NAME}-实施计划\n\nStatus: pending\n`));
	assert.equal(synchronized.planningDocuments.planContentDigest, result.details.digest);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "验证中 [VALIDATING]"]);
	assert.equal(harness.execCalls.some((call) => call.command === "git" && call.args.includes("--check")), true);
	await harness.commands.get("delivery-status")?.handler("", harness.ctx);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /进度同步：项目进度已同步：/);
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

test("cleans an acquired lease and permits retry when the initial progress checkpoint fails", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	const progress = harness.tools.get("delivery_progress_sync");
	harness.failNextAppend();

	await assert.rejects(
		progress.execute(
			"progress-checkpoint-failure",
			{ target: TEST_PLAN_PATH, oldText: "Status: pending", newText: "Status: complete" },
			undefined,
			undefined,
			harness.ctx,
		),
		/Failed to persist progress-sync operation checkpoint/,
	);

	const recovered = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(recovered.snapshot.state, "VALIDATING");
	assert.equal(recovered.writerLease, undefined);
	assert.match(recovered.checkpoint.summary, /checkpoint failed before write/);
	assert.deepEqual(harness.getActiveTools(), VALIDATION_ACTIVE_TOOLS);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: pending/);

	const retried = await progress.execute(
		"progress-checkpoint-retry",
		{ target: TEST_PLAN_PATH, oldText: "Status: pending", newText: "Status: complete" },
		undefined,
		undefined,
		harness.ctx,
	);
	assert.match(retried.content[0].text, /项目进度已同步/);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: complete/);
});

test("keeps validation evidence and permits an exact retry after a pre-write progress conflict", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	await harness.tools.get("delivery_validate").execute("validate", {}, undefined, undefined, harness.ctx);
	const before = readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8");

	const progress = harness.tools.get("delivery_progress_sync");
	await assert.rejects(
		progress.execute(
			"progress-stale",
			{ target: TEST_PLAN_PATH, oldText: "Status: stale", newText: "Status: complete" },
			undefined,
			undefined,
			harness.ctx,
		),
		/oldText was not found/,
	);

	assert.equal(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), before);
	const conflicted = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(conflicted.snapshot.state, "VALIDATING");
	assert.equal(conflicted.writerLease, undefined);
	assert.equal(conflicted.validationStatus, "passed");
	assert.equal(conflicted.validationEvidence.candidateDigest, conflicted.candidateDigest);
	assert.deepEqual(harness.getActiveTools(), VALIDATION_ACTIVE_TOOLS);

	const retried = await progress.execute(
		"progress-retry",
		{ target: TEST_PLAN_PATH, oldText: "Status: pending", newText: "Status: complete" },
		undefined,
		undefined,
		harness.ctx,
	);
	assert.match(retried.content[0].text, /项目进度已同步/);
	assert.match(readFileSync(path.join(repo, TEST_PLAN_PATH), "utf8"), /Status: complete/);
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
	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.planningDocuments.approvedPlanContentDigest, digestPlanningDocumentContent(`# ${TEST_REQUIREMENT_NAME}-实施计划\n\nStatus: pending\n`));
	assert.equal(blocked.planningDocuments.planContentDigest, digestPlanningDocumentContent(`# ${TEST_REQUIREMENT_NAME}-实施计划\n\nStatus: complete\n`));
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
	assert.deepEqual(harness.ui.statuses.at(-1), ["adaptive-delivery", "已阻塞 [BLOCKED]"]);
	const confirmations = harness.getConfirmCalls();
	await harness.commands.get("delivery-force-release-lease")?.handler("", harness.ctx);
	assert.equal(harness.getConfirmCalls(), confirmations);
	assert.match(harness.ui.notifications.at(-1)?.[0] ?? "", /没有写入租约/);
});

test("blocks a killed progress check even when the process reports exit code zero", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	harness.setExecResult({ stdout: "", stderr: "", code: 0, killed: true });

	await assert.rejects(
		harness.tools.get("delivery_progress_sync").execute(
			"progress-killed",
			{ target: TEST_PLAN_PATH, oldText: "Status: pending", newText: "Status: complete" },
			undefined,
			undefined,
			harness.ctx,
		),
		/timed out/,
	);

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "VALIDATING");
	assert.equal(blocked.writerLease, undefined);
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
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

test("resume keeps validation blocked when the frozen candidate changed", async () => {
	const repo = candidateRepo();
	const harness = createHarness(repo);
	harness.setConfirmResult(true);
	harness.setBranch(approvalBranch("PLAN_PENDING_APPROVAL", harness.sessionId, harness.ctx.cwd));
	await emit(harness, "session_start");
	await harness.commands.get("delivery-approve-plan")?.handler("", harness.ctx);
	await harness.tools.get("delivery_submit_candidate").execute("submit", {}, undefined, undefined, harness.ctx);
	await harness.tools.get("delivery_invalidate").execute(
		"temporary-validation-block-before-drift",
		{ target: "BLOCKED", reason: "temporary interruption" },
		undefined,
		undefined,
		harness.ctx,
	);
	writeFileSync(path.join(repo, "tracked.txt"), "changed while blocked\n");
	const sentBefore = harness.sentUserMessages.length;

	await harness.commands.get("delivery-resume")?.handler("", harness.ctx);

	const blocked = harness.appendedEntries.at(-1)?.data as any;
	assert.equal(blocked.snapshot.state, "BLOCKED");
	assert.equal(blocked.snapshot.resumeState, "VALIDATING");
	assert.equal(blocked.writerLease, undefined);
	assert.match(blocked.blockingReason, /Candidate changed while delivery was blocked/);
	assert.equal(harness.sentUserMessages.length, sentBefore);
	assert.deepEqual(harness.getActiveTools(), BASE_ACTIVE_TOOLS);
});
