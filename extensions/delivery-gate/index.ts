import { randomUUID } from "node:crypto";
import path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	createApprovalRecord,
	digestApprovalContent,
	findLatestAssistantEntry,
	requireTuiUserConfirmation,
	validateApprovalRecord,
	type ApprovalKind,
	type ApprovalRecord,
} from "./src/approvals.ts";
import { createCandidateSnapshot, snapshotProgressArtifact } from "./src/candidate.ts";
import {
	createCandidateReviewPacket,
	parseStructuredReviewResult,
} from "./src/review-contract.ts";
import { renderDiagramEntry } from "./src/diagram-view.ts";
import {
	DIAGRAM_ENTRY_CUSTOM_TYPE,
	extractMermaidDiagrams,
	transformMermaidForDisplay,
	type DiagramEntryData,
} from "./src/diagrams.ts";
import {
	validateAuthorizationBundle,
	type AuthorizationRequirement,
} from "./src/authorization.ts";
import { resolveProgressTarget, syncProjectProgress } from "./src/progress-sync.ts";
import {
	formatDeliveryState,
	resolveDeliveryPolicy,
	transitionDelivery,
	type DeliveryEvent,
	type DeliveryState,
	type DeliverySnapshot,
	type PolicyContext,
	type ResumeState,
} from "./src/domain.ts";
import { PolicyController } from "./src/policy.ts";
import {
	formatDocumentSelectionSource,
	formatEvidenceValidity,
	formatReviewVerdict,
	formatRuntimeText,
	formatValidationStatus,
	formatValidationVerifyStatus,
	formatWriterKind,
	formatWorkerStatus,
} from "./src/presentation.ts";
import {
	parsePlanContractFromContent,
	parsePlanningDocumentsFromContent,
	selectDeliveryRoute,
} from "./src/plan-contract.ts";
import {
	assertPlanningDocumentsExist,
	assertSolutionDocumentCurrent,
	extractPlanningDocumentContent,
	stripAdaptiveDeliveryProtocol,
	writePlanDocument,
	writePlanningDocuments,
	writeSolutionDocument,
	type PlanningDocumentEvidence,
} from "./src/planning-documents.ts";
import {
	parseTinyContractFromContent,
	stripTinyDeliveryProtocol,
	type TinyDeliveryContract,
} from "./src/tiny-contract.ts";
import {
	assertTinyAuthorizationCurrent,
	assertTinyWritePath,
	captureTinyApprovalBaseline,
	freezeTinyCandidate,
} from "./src/tiny-scope.ts";
import {
	READONLY_DELEGATE_ROLES,
	PI_SUBAGENTS_RUNTIME_VERSION,
	SubagentBoundary,
	validatePublicPreflightStability,
	type ReadonlyDelegateRole,
} from "./src/subagents.ts";
import {
	DELIVERY_STATE_CUSTOM_TYPE,
	checkpointRuntimeState,
	createInitialRuntimeState,
	restoreRuntimeState,
	type DeliveryRuntimeState,
} from "./src/runtime-state.ts";
import { WriterLeaseManager, resolveWorkspaceIdentity } from "./src/workspace.ts";
import {
	runApprovedValidation,
	type ValidationBatchResult,
	type ValidationCommandResult,
} from "./src/validation.ts";

const STATUS_KEY = "adaptive-delivery";
const SERIALIZED_DELIVERY_TOOLS = new Set([
	"delivery_begin",
	"delivery_delegate_worker",
	"delivery_submit_candidate",
	"delivery_validate",
	"delivery_review_candidate",
	"delivery_begin_rework",
	"delivery_finalize",
	"delivery_progress_sync",
	"delivery_invalidate",
]);

export default function deliveryGate(pi: ExtensionAPI): void {
	let state = createInitialRuntimeState();
	let currentContext: ExtensionContext | undefined;
	let leaseValid = false;
	let deliveryBeginArmed = false;
	const activeMutationTools = new Map<string, string>();
	const pendingDiagramEntries: DiagramEntryData[] = [];
	let activeDeliveryBarrier: { toolCallId: string; toolName: string } | undefined;
	const leaseStateRoot = process.env.PI_ADAPTIVE_DELIVERY_STATE_DIR?.trim()
		? path.resolve(process.env.PI_ADAPTIVE_DELIVERY_STATE_DIR)
		: path.join(getAgentDir(), "adaptive-delivery");
	const writerLeases = new WriterLeaseManager(leaseStateRoot);
	const subagents = new SubagentBoundary(pi);
	const policy = new PolicyController({
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
		applySubagentAccess: (access) => subagents.applyAccess(access),
	}, { baselineKey: leaseStateRoot });

	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "assistant"
			? transformMermaidForDisplay(stripTinyDeliveryProtocol(stripAdaptiveDeliveryProtocol(markdown)))
			: markdown,
	);
	pi.registerEntryRenderer<DiagramEntryData>(DIAGRAM_ENTRY_CUSTOM_TYPE, (entry, { expanded }, theme) =>
		renderDiagramEntry(entry.data, expanded, theme),
	);

	function updateStatus(ctx: ExtensionContext): void {
		const label = formatDeliveryState(state.snapshot.state);
		ctx.ui.setStatus(STATUS_KEY, state.snapshot.state === "BLOCKED" ? ctx.ui.theme.fg("warning", label) : label);
	}

	function textFromMessageContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter(
				(item): item is { type: "text"; text: string } =>
					Boolean(
						item &&
							typeof item === "object" &&
							(item as Record<string, unknown>).type === "text" &&
							typeof (item as Record<string, unknown>).text === "string",
					),
			)
			.map((item) => item.text)
			.join("\n");
	}

	function approvedContextText(ctx: ExtensionContext): string {
		const ids = [
			state.approvals?.solution?.entryId,
			state.approvals?.plan?.entryId,
			state.approvals?.combined?.entryId,
		].filter(
			(value): value is string => Boolean(value),
		);
		const texts: string[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!entry || typeof entry !== "object" || entry.type !== "message" || !ids.includes(entry.id)) continue;
			if (entry.message.role !== "assistant") continue;
			const text = textFromMessageContent(entry.message.content);
			if (text) texts.push(text);
		}
		return texts.join("\n\n").slice(0, 20000);
	}

	function approvalMessageContent(ctx: ExtensionContext, record: ApprovalRecord | undefined): unknown | undefined {
		if (!record) return undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!entry || typeof entry !== "object" || entry.type !== "message" || entry.id !== record.entryId) continue;
			if (entry.message.role === "assistant") return entry.message.content;
		}
		return undefined;
	}

	function queueAutomaticContinuation(
		ctx: ExtensionContext,
		command: "/delivery-plan" | "/delivery-run",
		message: string,
	): void {
		try {
			pi.sendMessage({
				customType: "pi-adaptive-delivery.status",
				content: message,
				display: true,
			});
			pi.sendUserMessage(command, { expandPromptTemplates: true });
			ctx.ui.notify(message, "info");
		} catch (error) {
			ctx.ui.notify(
				`${message}\n自动继续失败：${error instanceof Error ? error.message : String(error)}\n请手动运行 ${command}`,
				"warning",
			);
		}
	}

	function readOnlyContext() {
		return {
			approvalsValid: false,
			writerLeaseHeld: false,
			writerLeaseOwner: null,
			reworkApproved: false,
		} as const;
	}

	function setBlocked(reason: string, resumeState?: DeliverySnapshot["resumeState"]): void {
		const locked = policy.forceReadOnly();
		state = checkpointRuntimeState(state, {
			snapshot: { state: "BLOCKED", ...(resumeState ? { resumeState } : {}) },
			blockingReason: locked.ok ? reason : `${reason}; failed to prove read-only policy: ${locked.reason ?? "unknown error"}`,
		});
	}

	function resumableState(value: DeliveryState): ResumeState | undefined {
		return value === "SHAPING" ||
			value === "SOLUTION_PENDING_APPROVAL" ||
			value === "PLANNING" ||
			value === "PLAN_PENDING_APPROVAL" ||
			value === "COMBINED_PENDING_APPROVAL" ||
			value === "IMPLEMENTING" ||
			value === "VALIDATING" ||
			value === "REWORKING"
			? value
			: undefined;
	}

	function plannedImplementationWriter(): "parent" | "worker" | undefined {
		if (state.tinyContract) return "parent";
		if (!state.planContract) return undefined;
		return selectDeliveryRoute(state.planContract) === "single" ? "parent" : "worker";
	}

	function implementationWriter(): "parent" | "worker" {
		return plannedImplementationWriter() ?? "parent";
	}

	function isTinyDelivery(): boolean {
		return Boolean(state.tinyContract);
	}

	function approvedValidationCommands() {
		return state.tinyContract?.validation ?? state.planContract?.validation ?? [];
	}

	function runtimePhaseGuidance(): string {
		if (state.snapshot.state === "BLOCKED") {
			return "当前保持只读。先解决阻塞原因，再由 TUI 用户执行 /delivery-resume；Agent 不能自行恢复权限。";
		}
		switch (state.snapshot.state) {
			case "IMPLEMENTING":
			case "REWORKING":
				return implementationWriter() === "worker"
					? "当前由唯一 worker 执行已批准实现；父 Pi 不得修改源码。调用 delivery_delegate_worker，worker 成功结束后会自动冻结候选并进入验证。"
					: isTinyDelivery()
						? "当前是 Tiny 路径；父 Pi 只能修改批准的 exact scope，完成后调用 delivery_submit_candidate。"
						: "当前是 small/low/low 直接实现路径；父 Pi 完成后调用 delivery_submit_candidate。验证与审查工具会在候选提交后的下一轮出现。";
			case "VALIDATING":
				if (state.validationStatus === "pending") {
					return "固定验证工具尚未写入终态；不要重复启动。若 Pi 已 reload 或上次工具被中断，先确认没有遗留命令，再由 TUI 用户恢复并重试同一候选。";
				}
				if (state.validationStatus === "failed" && state.validationFailureKind !== "candidate") {
					return "验证命令未能可靠执行或终态未保存；解决本机执行问题后重试 delivery_validate，不要返工代码。";
				}
				if (state.validationStatus === "failed" || state.reviewEvidence?.verdict === "BLOCK") {
					return "批准命令未通过或审查阻塞。先判断原因属于候选代码、验证环境还是已批准计划；只有代码问题才使用 delivery_begin_rework，计划错误使用 /delivery-revise。";
				}
				if (state.validationStatus === "passed" && state.reviewEvidence) {
					return "验证和审查证据已就绪；确认仍绑定当前候选后调用 delivery_finalize。";
				}
				if (state.validationStatus === "passed") {
					if (isTinyDelivery()) return "固定验证已通过；确认候选和 scope 证据仍有效后调用 delivery_finalize。";
					return "固定验证已通过；下一步使用 delivery_review_candidate 审查同一候选。";
				}
				return "候选已冻结；下一步使用 delivery_validate。验证通过后再使用 delivery_review_candidate。";
			case "SHAPING":
			case "SOLUTION_PENDING_APPROVAL":
			case "PLANNING":
			case "PLAN_PENDING_APPROVAL":
			case "COMBINED_PENDING_APPROVAL":
				return "当前只能只读梳理方案或计划；批准必须由 TUI 用户完成。";
			case "IDLE":
				return "当前尚未开始交付流程；修改型任务先使用 delivery_begin。";
			case "DELIVERED":
			case "CANCELLED":
				return "当前流程已经结束，不能继续修改项目。";
		}
	}

	function formatElapsed(startedAt: number): string {
		const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
		if (seconds < 60) return `${seconds} 秒`;
		const minutes = Math.floor(seconds / 60);
		return `${minutes} 分 ${seconds % 60} 秒`;
	}

	function formatValidationRuns(
		runs: ReadonlyArray<Pick<ValidationCommandResult, "id" | "status" | "durationMs" | "exitCode">>,
	): string[] {
		return runs.map((run) => {
			const details = [
				run.exitCode !== undefined ? `退出码 ${run.exitCode}` : undefined,
				run.durationMs !== undefined ? `耗时 ${(run.durationMs / 1000).toFixed(1)} 秒` : undefined,
			].filter((value): value is string => Boolean(value));
			return `- ${run.id}：${formatValidationVerifyStatus(run.status)}${details.length ? `（${details.join("，")}）` : ""}`;
		});
	}

	function validationFailureExcerpts(runs: readonly ValidationCommandResult[]): string[] {
		const lines: string[] = [];
		for (const run of runs) {
			if (run.status === "passed") continue;
			const output = (run.stderr || run.stdout || "").trim();
			if (!output) continue;
			const excerpt = output.length > 1200 ? `...${output.slice(-1200)}` : output;
			lines.push(`${run.id} 输出摘要：\n${excerpt}`);
		}
		return lines;
	}

	function buildValidationEvidence(runId: string, candidateDigest: string, result: ValidationBatchResult) {
		return {
			candidateDigest,
			runId,
			outcome: result.status,
			commands: result.runs.map((run) => ({
				id: run.id,
				status: run.status,
				durationMs: run.durationMs,
				...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
			})),
			completedAt: new Date().toISOString(),
		} as const;
	}

	function persistCurrentState(): boolean {
		try {
			pi.appendEntry(DELIVERY_STATE_CUSTOM_TYPE, state);
			return true;
		} catch (error) {
			state = {
				...state,
				snapshot: { state: "BLOCKED" },
				blockingReason: `Failed to persist delivery checkpoint: ${error instanceof Error ? error.message : String(error)}`,
				updatedAt: new Date().toISOString(),
			};
			policy.forceReadOnly();
			return false;
		}
	}

	async function validateStoredApprovals(
		ctx: ExtensionContext,
		requirement: AuthorizationRequirement = "state",
	): Promise<string | undefined> {
		const identity = await resolveWorkspaceIdentity(ctx.cwd);
		const result = validateAuthorizationBundle(state, {
			sessionId: ctx.sessionManager.getSessionId(),
			branch: ctx.sessionManager.getBranch(),
			canonicalCwd: identity.cwdPath,
			gitRoot: identity.gitRoot,
		}, requirement);
		if (!result.ok) return result.reason;
		if (state.solutionDocument) {
			try {
				await assertSolutionDocumentCurrent(identity.gitRoot, state.solutionDocument);
			} catch (error) {
				return `Technical solution document cannot be proven: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		if (state.planningDocuments) {
			try {
				await assertPlanningDocumentsExist(identity.gitRoot, state.planningDocuments);
			} catch (error) {
				return `Planning documents cannot be proven: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		if (state.tinyContract && state.tinyBaseline && state.approvals?.combined) {
			try {
				await assertTinyAuthorizationCurrent({
					cwd: ctx.cwd,
					contract: state.tinyContract,
					baseline: state.tinyBaseline,
					approval: state.approvals.combined,
				});
			} catch (error) {
				return `Tiny baseline or exact scope cannot be proven: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		return undefined;
	}

	async function preflightReviewer(ctx: ExtensionContext): Promise<void> {
		const identity = await resolveWorkspaceIdentity(ctx.cwd);
		await subagents.preflight(
			"reviewer",
			"Preflight the required fresh review without launching a child or modifying files.",
			ctx,
			identity.gitRoot,
		);
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		currentContext = ctx;
		deliveryBeginArmed = false;
		subagents.bindSession(ctx.sessionManager.getSessionId());
		const restored = restoreRuntimeState(ctx.sessionManager.getBranch());
		state = restored.state;
		try {
			policy.captureBaseline();
		} catch (error) {
			setBlocked(
				`Failed to capture the original Pi tool baseline: ${error instanceof Error ? error.message : String(error)}`,
				resumableState(state.snapshot.state),
			);
			persistCurrentState();
			updateStatus(ctx);
			return;
		}
		let approvalError: string | undefined;
		if (restored.ok) {
			try {
				approvalError = await validateStoredApprovals(ctx);
			} catch (error) {
				approvalError = `Failed to validate delivery approvals: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		leaseValid = false;
		if (restored.ok && state.writerLease) {
			leaseValid = await writerLeases.isCurrentOwner(state.writerLease);
			if (!leaseValid) approvalError = approvalError ?? "Writer lease cannot be proven for the current process";
		}
		const applied = policy.apply(state.snapshot, state.writerLease ? approvalPolicyContext() : readOnlyContext());
		const restorationValid = restored.ok && !approvalError && applied.ok && !applied.policy.reason;
		if (!restorationValid) {
			const reason = !restored.ok
				? restored.reason
				: approvalError ?? applied.reason ?? applied.policy.reason ?? "Failed to apply delivery policy";
			setBlocked(reason, resumableState(state.snapshot.state));
			persistCurrentState();
		} else if (!restored.found) {
			persistCurrentState();
		}
		updateStatus(ctx);
		if (restorationValid && state.validationStatus === "pending") {
			setBlocked("Validation was interrupted before its terminal checkpoint", "VALIDATING");
			state = checkpointRuntimeState(state, {
				validationStatus: "failed",
				validationFailureKind: "infrastructure",
				validationEvidence: undefined,
				checkpoint: {
					summary: `Validation infrastructure failed for ${state.candidateDigest}`,
					nextReadyAction: "Confirm no validation command is still running, then retry the same candidate",
				},
			});
			persistCurrentState();
			updateStatus(ctx);
		} else if (restorationValid && state.validationStatus === "passed" && !state.validationEvidence) {
			setBlocked("Passed validation state has no recoverable command evidence", "VALIDATING");
			state = checkpointRuntimeState(state, {
				validationStatus: "failed",
				validationFailureKind: "infrastructure",
				checkpoint: {
					summary: `Validation infrastructure failed for ${state.candidateDigest}`,
					nextReadyAction: "Retry fixed validation to create recoverable command evidence",
				},
			});
			persistCurrentState();
			updateStatus(ctx);
		}
	}

	function approvalPolicyContext(): PolicyContext {
		return {
			approvalsValid: Boolean(state.approvals?.plan || state.approvals?.combined),
			writerLeaseHeld: leaseValid,
			writerLeaseOwner: leaseValid ? "parent" : null,
			reworkApproved: state.reworkApproved === true,
			implementationWriter: implementationWriter(),
			tinyWritablePaths: state.tinyContract?.changeScope,
		};
	}

	function workerTask(ctx: ExtensionContext, additionalInstructions?: string): string {
		return [
			"Implement the currently approved Adaptive Delivery plan in the current repository.",
			"You are the sole implementation worker for this foreground handoff. Modify only project/source files allowed by the approved plan.",
			"Read and follow project AGENTS.md. Do not start subagents, change product/scope/architecture decisions, update progress documents, commit, push, publish, deploy, access credentials, or call real providers unless the approved plan explicitly authorizes it.",
			"Run no unapproved release or production action. Stop and report when an unapproved decision is required.",
			state.goal ? `Goal: ${state.goal}` : undefined,
			`Approved solution and implementation plan:\n${approvedContextText(ctx) || "(approved entries unavailable)"}`,
			additionalInstructions ? `Parent instructions for this approved slice:\n${additionalInstructions}` : undefined,
			"Return a concise handoff with changed files, checks attempted, remaining risks, and any blocked decision. Child-reported checks are claimed evidence only; the parent runtime performs formal validation after your terminal result.",
		].filter((value): value is string => Boolean(value)).join("\n\n");
	}

	function commitSnapshot(next: DeliverySnapshot, ctx: ExtensionContext, widening: boolean): boolean {
		if (!widening) {
			const locked = policy.forceReadOnly();
			if (!locked.ok) {
				setBlocked(`Cannot commit state transition because read-only policy failed: ${locked.reason ?? "unknown error"}`);
				persistCurrentState();
				updateStatus(ctx);
				return false;
			}
		}
		state = checkpointRuntimeState(state, { snapshot: next, blockingReason: undefined, recoveryCondition: undefined });
		if (!persistCurrentState()) {
			updateStatus(ctx);
			return false;
		}
		const applied = policy.apply(next, widening ? approvalPolicyContext() : readOnlyContext());
		if (!applied.ok || applied.policy.reason) {
			setBlocked(applied.reason ?? applied.policy.reason ?? "Failed to apply delivery policy", next.state === "IMPLEMENTING" || next.state === "REWORKING" || next.state === "VALIDATING" ? next.state : undefined);
			persistCurrentState();
			updateStatus(ctx);
			return false;
		}
		updateStatus(ctx);
		return true;
	}

	async function createCurrentApproval(
		kind: ApprovalKind,
		ctx: ExtensionCommandContext,
	): Promise<{ record: ApprovalRecord; content: unknown } | undefined> {
		const branch = ctx.sessionManager.getBranch();
		const entry = findLatestAssistantEntry(branch);
		const anchor = ctx.sessionManager.getLeafId();
		if (!entry || !anchor) {
			ctx.ui.notify("找不到当前分支上可批准的 assistant 消息。", "error");
			return undefined;
		}
		const identity = await resolveWorkspaceIdentity(ctx.cwd);
		return { record: createApprovalRecord(kind, {
			sessionId: ctx.sessionManager.getSessionId(),
			entry,
			branchAnchorEntryId: anchor,
			canonicalCwd: identity.cwdPath,
			gitRoot: identity.gitRoot,
		}), content: entry.message.content };
	}

	async function ensureParentWriterLease(
		ctx: ExtensionContext,
		blockedResumeState: ResumeState = "IMPLEMENTING",
	): Promise<boolean> {
		if (state.writerLease && (await writerLeases.isCurrentOwner(state.writerLease))) {
			leaseValid = true;
			return true;
		}
		const identity = await resolveWorkspaceIdentity(ctx.cwd);
		const acquired = await writerLeases.acquire(identity, {
			kind: "parent",
			sessionId: ctx.sessionManager.getSessionId(),
			pid: process.pid,
		});
		if (!acquired.ok) {
			setBlocked(
				`${acquired.reason}${acquired.existing ? `；owner=${acquired.existing.owner.sessionId}` : ""}`,
				blockedResumeState,
			);
			persistCurrentState();
			updateStatus(ctx);
			return false;
		}
		leaseValid = true;
		state = checkpointRuntimeState(state, { writerLease: acquired.reference });
		return true;
	}

	async function releaseParentLeaseIfOwned(): Promise<boolean> {
		if (!state.writerLease) return true;
		if (!(await writerLeases.isCurrentOwner(state.writerLease))) return false;
		await writerLeases.release(state.writerLease, {
			kind: "parent-owner",
			processToken: writerLeases.processToken,
		});
		leaseValid = false;
		state = checkpointRuntimeState(state, { writerLease: undefined });
		return true;
	}

	async function recomputeCandidate(ctx: ExtensionContext) {
		return createCandidateSnapshot({
			cwd: ctx.cwd,
			approvals: state.approvals,
			progressPaths: state.planContract?.progressTargets,
		});
	}

	async function requireCurrentCandidate(ctx: ExtensionContext): Promise<string> {
		if (!state.candidateDigest) throw new Error("No frozen candidate digest is available");
		const current = await recomputeCandidate(ctx);
		if (current.digest !== state.candidateDigest) {
			setBlocked("Candidate changed after evidence was requested", "VALIDATING");
			persistCurrentState();
			updateStatus(ctx);
			throw new Error("Candidate changed; previous validation or review evidence is stale");
		}
		return current.digest;
	}

	async function requireAuthorization(
		ctx: ExtensionContext,
		requirement: AuthorizationRequirement = "state",
	): Promise<void> {
		const reason = await validateStoredApprovals(ctx, requirement);
		if (reason) {
			setBlocked(`Authorization bundle is invalid: ${reason}`, resumableState(state.snapshot.state));
			persistCurrentState();
			updateStatus(ctx);
			throw new Error(reason);
		}
	}

	async function approveTiny(
		ctx: ExtensionCommandContext,
		record: ApprovalRecord,
		contract: TinyDeliveryContract,
		event: DeliveryEvent,
	): Promise<void> {
		if (event.type !== "APPROVE_COMBINED") {
			ctx.ui.notify("Tiny 只能使用一次合并批准。", "error");
			return;
		}
		const confirmed = await requireTuiUserConfirmation(ctx, {
			title: "确认 Tiny Delivery",
			message: [
				`批准当前 assistant 条目 ${record.entryId}？`,
				`SHA-256: ${record.contentDigest}`,
				`将修改：${contract.changeScope.join("、")}`,
				`不会修改：${contract.nonGoals.join("；")}`,
				`验证：${contract.validation.map((command) => command.command).join("；")}`,
			].join("\n"),
		});
		if (!confirmed) {
			ctx.ui.notify("未授予权限。", "warning");
			return;
		}

		let approvalSnapshot = state.snapshot;
		if (approvalSnapshot.state === "SHAPING") {
			const submitted = transitionDelivery(approvalSnapshot, { type: "SUBMIT_COMBINED" });
			if (!submitted.ok) throw new Error(submitted.reason);
			approvalSnapshot = submitted.snapshot;
		}
		const transition = transitionDelivery(approvalSnapshot, event);
		if (!transition.ok) {
			ctx.ui.notify(formatRuntimeText(transition.reason) ?? "Tiny 状态转换失败", "error");
			return;
		}

		let baseline;
		try {
			baseline = await captureTinyApprovalBaseline({ cwd: ctx.cwd, contract, approval: record });
		} catch (error) {
			ctx.ui.notify(
				`Tiny baseline 无法证明，必须升级 Standard：${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		state = checkpointRuntimeState(state, {
			approvals: { combined: record },
			tinyContract: contract,
			tinyBaseline: baseline,
			tinyScopeEvidence: undefined,
			proposedDocuments: undefined,
			planContract: undefined,
			solutionDocument: undefined,
			planningDocuments: undefined,
			workerRunId: undefined,
			workerStatus: undefined,
			workerLaunchContractDigest: undefined,
			candidateDigest: undefined,
			validationRunId: undefined,
			validationStatus: undefined,
			validationFailureKind: undefined,
			validationEvidence: undefined,
			reviewEvidence: undefined,
			reworkApproved: false,
			finalEvidence: undefined,
			checkpoint: {
				summary: `Tiny contract approved with exact scope: ${contract.changeScope.join(", ")}`,
				nextReadyAction: "Implement only the approved Tiny paths, then freeze the candidate",
			},
		});
		if (!(await ensureParentWriterLease(ctx))) return;
		if (!commitSnapshot(transition.snapshot, ctx, true)) return;
		queueAutomaticContinuation(
			ctx,
			"/delivery-run",
			`Tiny Delivery 已批准。exact scope：${contract.changeScope.join("、")}。正在开始实现...`,
		);
	}

	async function approve(
		ctx: ExtensionCommandContext,
		kind: ApprovalKind,
		event: DeliveryEvent,
	): Promise<void> {
		await ctx.waitForIdle();
		if (kind === "plan") {
			const reason = await validateStoredApprovals(ctx);
			if (reason) {
				ctx.ui.notify(formatRuntimeText(reason) ?? "授权信息无效", "error");
				return;
			}
		}
		const target = await createCurrentApproval(kind, ctx);
		if (!target) return;
		const { record } = target;
		const tinyContract = kind === "combined" ? parseTinyContractFromContent(target.content) : undefined;
		const planContract = kind === "solution" ? undefined : parsePlanContractFromContent(target.content);
		if (tinyContract && planContract) {
			ctx.ui.notify("当前 assistant 条目同时包含 Tiny 和 Standard 契约，无法确定授权边界。", "error");
			return;
		}
		if (tinyContract) {
			await approveTiny(ctx, record, tinyContract, event);
			return;
		}
		if (kind !== "solution" && !planContract) {
			ctx.ui.notify("实施计划缺少唯一有效的 adaptive-delivery-plan 契约。", "error");
			return;
		}
		const proposedDocuments = kind === "solution" || kind === "combined"
			? parsePlanningDocumentsFromContent(target.content)
			: state.proposedDocuments;
		if (!proposedDocuments) {
			ctx.ui.notify("当前方案缺少唯一有效的 adaptive-delivery-documents 契约。", "error");
			return;
		}
		const solutionOnlyContent = kind === "solution"
			? extractPlanningDocumentContent(target.content, "solution")
			: undefined;
		if (kind === "solution" && !solutionOnlyContent) {
			ctx.ui.notify("技术方案缺少唯一有效的规划文档内容标记。", "error");
			return;
		}
		if (
			kind === "solution" &&
			state.solutionDocument &&
			(!state.proposedDocuments ||
				digestApprovalContent(proposedDocuments) !== digestApprovalContent(state.proposedDocuments))
		) {
			ctx.ui.notify("修订后的技术方案必须继续使用已落盘的需求名称和文档路径。", "error");
			return;
		}
		if (
			planContract &&
			digestApprovalContent(proposedDocuments) !== digestApprovalContent(planContract.documents)
		) {
			ctx.ui.notify("实施计划中的规划文档路径与已批准技术方案不一致。", "error");
			return;
		}
		let planningDocumentContent: { solution: string; plan: string } | undefined;
		if (planContract) {
			const solutionSource = kind === "combined"
				? target.content
				: approvalMessageContent(ctx, state.approvals?.solution);
			const solution = extractPlanningDocumentContent(solutionSource, "solution");
			const plan = extractPlanningDocumentContent(target.content, "plan");
			if (!solution || !plan) {
				ctx.ui.notify("技术方案或实施计划缺少唯一有效的规划文档内容标记。", "error");
				return;
			}
			planningDocumentContent = { solution, plan };
			try {
				await preflightReviewer(ctx);
			} catch (error) {
				ctx.ui.notify(
					`独立审查暂时不可用：${error instanceof Error ? error.message : String(error)}\n请先配置至少一个可用 reviewer 模型或 fallback，再重新批准实施计划。固定命令验证本身不依赖模型。`,
					"error",
				);
				return;
			}
		}
		const documentSummary = `\n需求：${proposedDocuments.requirementName}\n技术方案：${proposedDocuments.solutionPath}\n实施计划：${proposedDocuments.planPath}\n路径来源：${formatDocumentSelectionSource(proposedDocuments.selectionSource)}`;
		const confirmed = await requireTuiUserConfirmation(ctx, {
			title: kind === "solution" ? "确认技术方案" : kind === "plan" ? "确认实施计划" : "确认方案与计划",
			message: `批准当前 assistant 条目 ${record.entryId}？\nSHA-256: ${record.contentDigest}${documentSummary}`,
		});
		if (!confirmed) {
			ctx.ui.notify("未授予权限。", "warning");
			return;
		}

		let approvalSnapshot = state.snapshot;
		const submitEvent: DeliveryEvent | undefined =
			kind === "solution" && state.snapshot.state === "SHAPING"
				? { type: "SUBMIT_SOLUTION" }
				: kind === "plan" && state.snapshot.state === "PLANNING"
					? { type: "SUBMIT_PLAN" }
					: kind === "combined" && state.snapshot.state === "SHAPING"
						? { type: "SUBMIT_COMBINED" }
						: undefined;
		if (submitEvent) {
			const submitted = transitionDelivery(approvalSnapshot, submitEvent);
			if (!submitted.ok) {
				ctx.ui.notify(formatRuntimeText(submitted.reason) ?? "无法提交当前方案", "error");
				return;
			}
			approvalSnapshot = submitted.snapshot;
		}
		const transition = transitionDelivery(approvalSnapshot, event);
		if (!transition.ok) {
			ctx.ui.notify(formatRuntimeText(transition.reason) ?? "交付状态转换失败", "error");
			return;
		}
		if (kind === "solution") {
			const previousSolutionDocument = state.solutionDocument;
			if (!(await ensureParentWriterLease(ctx, "SHAPING"))) return;
			try {
				const identity = await resolveWorkspaceIdentity(ctx.cwd);
				const solutionDocument = await writeSolutionDocument({
					gitRoot: identity.gitRoot,
					documents: proposedDocuments,
					solutionContent: solutionOnlyContent!,
					...(previousSolutionDocument ? { previous: previousSolutionDocument } : {}),
				});
				state = checkpointRuntimeState(state, {
					approvals: { ...state.approvals, solution: record },
					proposedDocuments,
					solutionDocument,
					checkpoint: {
						summary: `Technical solution synchronized: ${solutionDocument.solutionPath}`,
						nextReadyAction: "Generate the implementation plan",
					},
				});
			} catch (error) {
				let releaseError: string | undefined;
				try {
					if (!(await releaseParentLeaseIfOwned())) releaseError = "writer lease ownership is unproven";
				} catch (releaseFailure) {
					releaseError = releaseFailure instanceof Error ? releaseFailure.message : String(releaseFailure);
				}
				const reason = `Technical solution synchronization failed: ${error instanceof Error ? error.message : String(error)}${releaseError ? `; ${releaseError}` : ""}`;
				setBlocked(reason, "SHAPING");
				persistCurrentState();
				updateStatus(ctx);
				ctx.ui.notify(formatRuntimeText(reason) ?? "技术方案文档同步失败", "error");
				return;
			}
			try {
				if (!(await releaseParentLeaseIfOwned())) {
					setBlocked("Technical solution synchronized but writer lease ownership is unproven", "PLANNING");
					persistCurrentState();
					updateStatus(ctx);
					return;
				}
			} catch (error) {
				setBlocked(`Technical solution synchronized but writer lease release failed: ${error instanceof Error ? error.message : String(error)}`, "PLANNING");
				persistCurrentState();
				updateStatus(ctx);
				return;
			}
		} else {
			state = checkpointRuntimeState(state, {
				approvals: { ...state.approvals, [kind]: record },
				proposedDocuments,
				...(planContract ? { planContract } : {}),
			});
		}
		const widening = transition.snapshot.state === "IMPLEMENTING";
		if (widening) {
			if (!planContract || !planningDocumentContent) {
				setBlocked("Planning document contract is missing", resumableState(state.snapshot.state));
				persistCurrentState();
				updateStatus(ctx);
				return;
			}
			if (!(await ensureParentWriterLease(ctx))) return;
			try {
				const identity = await resolveWorkspaceIdentity(ctx.cwd);
				let planningDocuments: PlanningDocumentEvidence;
				if (kind === "combined") {
					planningDocuments = await writePlanningDocuments({
						gitRoot: identity.gitRoot,
						documents: planContract.documents,
						solutionContent: planningDocumentContent.solution,
						planContent: planningDocumentContent.plan,
					});
				} else {
					if (!state.solutionDocument) {
						throw new Error("Approved technical solution document evidence is missing");
					}
					planningDocuments = await writePlanDocument({
						gitRoot: identity.gitRoot,
						documents: planContract.documents,
						solutionContent: planningDocumentContent.solution,
						planContent: planningDocumentContent.plan,
						solutionEvidence: state.solutionDocument,
					});
				}
				state = checkpointRuntimeState(state, {
					solutionDocument: undefined,
					planningDocuments,
					checkpoint: {
						summary: `Planning documents synchronized for ${planningDocuments.requirementName}`,
						nextReadyAction: "Enter implementation using the approved requirement documents",
					},
				});
			} catch (error) {
				let releaseError: string | undefined;
				try {
					if (!(await releaseParentLeaseIfOwned())) releaseError = "writer lease ownership is unproven";
				} catch (releaseFailure) {
					releaseError = releaseFailure instanceof Error ? releaseFailure.message : String(releaseFailure);
				}
				const reason = `Planning document synchronization failed: ${error instanceof Error ? error.message : String(error)}${releaseError ? `; ${releaseError}` : ""}`;
				setBlocked(reason, resumableState(state.snapshot.state));
				persistCurrentState();
				updateStatus(ctx);
				ctx.ui.notify(formatRuntimeText(reason) ?? "规划文档同步失败", "error");
				return;
			}
		}
		if (!commitSnapshot(transition.snapshot, ctx, widening)) return;
		if (widening && implementationWriter() === "worker") {
			try {
				const identity = await resolveWorkspaceIdentity(ctx.cwd);
				await subagents.preflightWorker(workerTask(ctx), ctx, identity.gitRoot);
			} catch (error) {
				let released = false;
				try {
					released = await releaseParentLeaseIfOwned();
				} catch {
					// Keep the lease reference when release cannot be proven.
				}
				const reason = `Controlled worker preflight failed: ${error instanceof Error ? error.message : String(error)}`;
				setBlocked(reason, "IMPLEMENTING");
				state = checkpointRuntimeState(state, {
					...(released ? { writerLease: undefined } : {}),
				});
				persistCurrentState();
				updateStatus(ctx);
				ctx.ui.notify(`唯一 worker 当前不可用：${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
		}
		if (kind === "solution") {
			queueAutomaticContinuation(
				ctx,
				"/delivery-plan",
				`技术方案已批准并写入项目：${proposedDocuments.requirementName}\n技术方案：${proposedDocuments.solutionPath}\n实施计划：${proposedDocuments.planPath}\n正在生成实施计划...`,
			);
		} else {
			queueAutomaticContinuation(
				ctx,
				"/delivery-run",
				`实施计划已批准，规划文档已同步：${proposedDocuments.requirementName}\n技术方案：${proposedDocuments.solutionPath}\n实施计划：${proposedDocuments.planPath}\n正在开始实现...`,
			);
		}
	}

	pi.registerCommand("delivery-status", {
		description: "显示 Adaptive Delivery 当前状态",
		handler: async (_args, ctx) => {
			let subagentRuntime = `bundled pi-subagents ${PI_SUBAGENTS_RUNTIME_VERSION}（不可证明）`;
			try {
				await subagents.ping();
				subagentRuntime = `bundled pi-subagents ${PI_SUBAGENTS_RUNTIME_VERSION}（唯一 owner）`;
			} catch (error) {
				subagentRuntime = `bundled pi-subagents ${PI_SUBAGENTS_RUNTIME_VERSION}（不可证明：${error instanceof Error ? error.message : String(error)}）`;
			}
			let writerOwner = "无";
			if (state.writerLease) {
				try {
					const record = await writerLeases.read(state.writerLease.workspaceKey);
					writerOwner = record?.leaseId === state.writerLease.leaseId
						? `${formatWriterKind(record.owner.kind)}：${record.owner.sessionId}${record.owner.runId ? `/${record.owner.runId}` : ""}`
						: "不可证明";
				} catch {
					writerOwner = "不可证明";
				}
			}
			let candidateValidity: "current" | "stale" | "unproven" = "unproven";
			if (state.candidateDigest) {
				try {
					candidateValidity = (await recomputeCandidate(ctx)).digest === state.candidateDigest ? "current" : "stale";
				} catch {
					candidateValidity = "unproven";
				}
			}
			const evidenceValidity = state.candidateDigest
				? candidateValidity
				: "unproven";
			const reviewValidity = state.reviewEvidence
				? state.reviewEvidence.candidateDigest !== state.candidateDigest
					? "stale"
					: evidenceValidity
				: "unproven";
			const planningApproved = state.snapshot.state === "PLANNING" && Boolean(state.approvals?.solution);
			const checkpointSummary = planningApproved
				? state.checkpoint?.summary?.startsWith("Technical solution synchronized:")
					? state.checkpoint.summary
					: "Technical solution approved"
				: state.checkpoint?.summary;
			const nextReadyAction = planningApproved ? "Generate the implementation plan" : state.checkpoint?.nextReadyAction;
			const progressSummary = state.checkpoint?.summary;
			const progressStatus = progressSummary && (
				progressSummary.startsWith("progress-sync") ||
				progressSummary.startsWith("Project progress synchronized:")
			)
				? formatRuntimeText(progressSummary)
				: "未运行";
			const lines = [
				`状态：${formatDeliveryState(state.snapshot.state)}`,
				`交付等级：${isTinyDelivery() ? "TINY" : state.planContract && selectDeliveryRoute(state.planContract) === "high-risk" ? "HIGH_RISK" : state.planContract ? "STANDARD" : "待确定"}`,
				`子 Agent runtime：${subagentRuntime}`,
				`恢复状态：${state.snapshot.resumeState ? formatDeliveryState(state.snapshot.resumeState) : "无"}`,
				`开发方式：${plannedImplementationWriter() === "worker" ? "唯一 worker" : plannedImplementationWriter() === "parent" ? "父 Pi 直接实现" : "待实施计划决定"}`,
				`开发执行者：${state.workerStatus ? `${formatWorkerStatus(state.workerStatus)}${state.workerRunId ? `（运行 ID：${state.workerRunId}）` : ""}` : "未启动"}`,
				`写入者：${writerOwner}`,
				`候选版本：${state.candidateDigest ? `${state.candidateDigest}（${formatEvidenceValidity(candidateValidity)}）` : "不可证明"}`,
				`验证：${state.validationStatus ? `${formatValidationStatus(state.validationStatus)}（${formatEvidenceValidity(evidenceValidity)}）${state.validationFailureKind === "infrastructure" ? "（本机执行未完成）" : state.validationFailureKind === "candidate" ? "（批准命令未通过）" : state.validationStatus === "failed" ? "（失败类型不可证明）" : ""}` : "不可证明"}${state.validationRunId ? `（批次 ID：${state.validationRunId}）` : ""}`,
				`验证命令：${state.validationEvidence ? `\n${formatValidationRuns(state.validationEvidence.commands).join("\n")}` : "无终态证据"}`,
				`审查：${state.reviewEvidence ? `${formatReviewVerdict(state.reviewEvidence.verdict)}（${formatEvidenceValidity(reviewValidity)}）` : isTinyDelivery() ? "Tiny 默认省略" : "不可证明"}`,
				`规划文档：${state.planningDocuments
					? `${state.planningDocuments.requirementName}（${state.planningDocuments.solutionPath}，${state.planningDocuments.planPath}；已同步）`
					: state.solutionDocument
						? `${state.solutionDocument.requirementName}（${state.solutionDocument.solutionPath}；技术方案已同步，${state.solutionDocument.planPath}；实施计划待同步）`
					: state.proposedDocuments
						? `${state.proposedDocuments.requirementName}（${state.proposedDocuments.solutionPath}，${state.proposedDocuments.planPath}；待同步）`
						: isTinyDelivery() ? "Tiny 使用 Session/runtime contract，不创建需求级文档" : "不可证明"}`,
				`进度同步：${isTinyDelivery() ? "Tiny 不启用" : progressStatus}`,
				...(state.blockingReason ? [`阻塞原因：${formatRuntimeText(state.blockingReason)}`] : []),
				...(state.recoveryCondition ? [`恢复条件：${formatRuntimeText(state.recoveryCondition)}`] : []),
				...(checkpointSummary ? [`断点：${formatRuntimeText(checkpointSummary)}`] : []),
				...(nextReadyAction ? [`下一步：${formatRuntimeText(nextReadyAction)}`] : []),
			];
			ctx.ui.notify(lines.join("\n"), state.snapshot.state === "BLOCKED" ? "warning" : "info");
		},
	});

	pi.registerCommand("delivery-approve-solution", {
		description: "确认当前技术方案",
		handler: async (_args, ctx) => approve(ctx, "solution", { type: "APPROVE_SOLUTION" }),
	});

	pi.registerCommand("delivery-approve-plan", {
		description: "确认当前实施计划或小型合并方案",
		handler: async (_args, ctx) => {
			const combined = state.snapshot.state === "SHAPING" || state.snapshot.state === "COMBINED_PENDING_APPROVAL";
			await approve(ctx, combined ? "combined" : "plan", {
				type: combined ? "APPROVE_COMBINED" : "APPROVE_PLAN",
			});
		},
	});

	pi.registerCommand("delivery-revise", {
		description: "撤销当前批准并返回方案或计划阶段",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (state.writerLease && !(await releaseParentLeaseIfOwned())) {
				setBlocked(
					"Cannot revise while writer lease ownership is unproven",
					state.snapshot.state === "IMPLEMENTING" || state.snapshot.state === "REWORKING"
						? state.snapshot.state
						: undefined,
				);
				persistCurrentState();
				updateStatus(ctx);
				return;
			}
			const event: DeliveryEvent = { type: args.trim() === "plan" ? "REVISE_PLAN" : "REVISE_SOLUTION" };
			const transition = transitionDelivery(state.snapshot, event);
			if (!transition.ok) {
				ctx.ui.notify(formatRuntimeText(transition.reason) ?? "无法修改当前方案", "error");
				return;
			}
			state = checkpointRuntimeState(state, {
				approvals: event.type === "REVISE_PLAN" ? { solution: state.approvals?.solution } : {},
				proposedDocuments: event.type === "REVISE_PLAN" || state.solutionDocument
					? state.proposedDocuments
					: undefined,
				planContract: undefined,
				tinyContract: undefined,
				tinyBaseline: undefined,
				tinyScopeEvidence: undefined,
				planningDocuments: undefined,
				workerRunId: undefined,
				workerStatus: undefined,
				workerLaunchContractDigest: undefined,
				candidateDigest: undefined,
				validationRunId: undefined,
				validationStatus: undefined,
				validationFailureKind: undefined,
				validationEvidence: undefined,
				reviewEvidence: undefined,
				reworkApproved: false,
				finalEvidence: undefined,
			});
			if (!commitSnapshot(transition.snapshot, ctx, false)) {
				throw new Error("Failed to persist the revision transition");
			}
		},
	});

	pi.registerCommand("delivery-cancel", {
		description: "取消当前交付流程并锁定只读",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (state.writerLease && !(await releaseParentLeaseIfOwned())) {
				setBlocked(
					"Cannot cancel while writer lease ownership is unproven",
					state.snapshot.state === "IMPLEMENTING" || state.snapshot.state === "REWORKING"
						? state.snapshot.state
						: undefined,
				);
				persistCurrentState();
				updateStatus(ctx);
				return;
			}
			const transition = transitionDelivery(state.snapshot, { type: "CANCEL" });
			if (!transition.ok) {
				ctx.ui.notify(formatRuntimeText(transition.reason) ?? "无法取消当前流程", "error");
				return;
			}
			if (state.validationStatus === "pending") {
				state = checkpointRuntimeState(state, {
					validationRunId: undefined,
					validationStatus: undefined,
					validationFailureKind: undefined,
					validationEvidence: undefined,
				});
			}
			if (!commitSnapshot(transition.snapshot, ctx, false)) {
				throw new Error("Failed to persist the cancellation transition");
			}
		},
	});

	pi.registerCommand("delivery-resume", {
		description: "在用户确认后尝试恢复 BLOCKED 流程",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (state.snapshot.state !== "BLOCKED" || !state.snapshot.resumeState) {
				ctx.ui.notify("当前没有可恢复的已阻塞 [BLOCKED] 状态。", "warning");
				return;
			}
			const authorizationError = await validateStoredApprovals(ctx);
			if (authorizationError) {
				ctx.ui.notify(`无法恢复：${formatRuntimeText(authorizationError)}`, "error");
				return;
			}
			const confirmed = await requireTuiUserConfirmation(ctx, {
				title: "恢复交付流程",
				message: `恢复到 ${formatDeliveryState(state.snapshot.resumeState)}？`,
			});
			if (!confirmed) return;
			const transition = transitionDelivery(state.snapshot, { type: "RESUME" });
			if (!transition.ok) {
				ctx.ui.notify(formatRuntimeText(transition.reason) ?? "交付状态恢复失败", "error");
				return;
			}
			const widening = transition.snapshot.state === "IMPLEMENTING" || transition.snapshot.state === "REWORKING";
			if (widening && !(await ensureParentWriterLease(ctx))) return;
			if (!commitSnapshot(transition.snapshot, ctx, widening)) return;
			if (transition.snapshot.state === "PLANNING") {
				queueAutomaticContinuation(
					ctx,
					"/delivery-plan",
					`流程已恢复到 ${formatDeliveryState(transition.snapshot.state)}，正在继续生成实施计划...`,
				);
			} else if (
				transition.snapshot.state === "IMPLEMENTING" ||
				transition.snapshot.state === "REWORKING" ||
				transition.snapshot.state === "VALIDATING"
			) {
				queueAutomaticContinuation(
					ctx,
					"/delivery-run",
					`流程已恢复到 ${formatDeliveryState(transition.snapshot.state)}，正在从已批准断点继续...`,
				);
			}
		},
	});

	pi.registerCommand("delivery-force-release-lease", {
		description: "在用户确认后强制释放当前 workspace 的 writer lease",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const identity = await resolveWorkspaceIdentity(ctx.cwd);
			const existing = await writerLeases.read(identity.key);
			if (!existing) {
				ctx.ui.notify("当前工作区没有写入租约。", "info");
				return;
			}
			const confirmed = await requireTuiUserConfirmation(ctx, {
				title: "强制释放 writer lease",
				message: `工作区：${existing.workspace.workspacePath}\n持有者：${existing.owner.sessionId}\n运行 ID：${existing.owner.runId ?? "父会话"}\n强制释放可能遗留未知写入进程，确认继续？`,
			});
			if (!confirmed) return;
			await writerLeases.forceRelease(identity.key, existing.leaseId);
			leaseValid = false;
			const resumeState =
				state.snapshot.state === "BLOCKED"
					? state.snapshot.resumeState
					: state.snapshot.state === "IMPLEMENTING" || state.snapshot.state === "REWORKING"
					? state.snapshot.state
					: undefined;
			setBlocked("Writer lease was force-released by the user", resumeState);
			state = checkpointRuntimeState(state, {
				writerLease: undefined,
				...(state.workerStatus === "starting" || state.workerStatus === "running"
					? { workerStatus: "failed" as const }
					: {}),
			});
			persistCurrentState();
			updateStatus(ctx);
			ctx.ui.notify("写入租约已强制释放；流程保持只读，需要显式执行 /delivery-resume。", "warning");
		},
	});

	pi.registerTool({
		name: "delivery_runtime_status",
		label: "读取交付阶段",
		description: "只读返回当前 Adaptive Delivery 阶段、当前可用工具和下一步。工具按阶段开放；未来阶段工具暂时不可见不代表运行时故障。",
		parameters: Type.Object({}),
		async execute() {
			const activeTools = pi.getActiveTools();
			const deliveryTools = activeTools.filter((name) => name.startsWith("delivery_"));
			const nextReadyAction = formatRuntimeText(state.checkpoint?.nextReadyAction);
			const guidance = runtimePhaseGuidance();
			const lines = [
				`当前状态：${formatDeliveryState(state.snapshot.state)}`,
				...(state.snapshot.resumeState ? [`可恢复到：${formatDeliveryState(state.snapshot.resumeState)}`] : []),
				`当前可用交付工具：${deliveryTools.join(", ") || "无"}`,
				...(nextReadyAction ? [`已记录下一步：${nextReadyAction}`] : []),
				...(state.blockingReason ? [`阻塞原因：${formatRuntimeText(state.blockingReason)}`] : []),
				`阶段说明：${guidance}`,
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
					details: {
					state: state.snapshot.state,
					profile: isTinyDelivery()
						? "tiny"
						: state.planContract && selectDeliveryRoute(state.planContract) === "high-risk"
							? "high-risk"
							: state.planContract ? "standard" : undefined,
					resumeState: state.snapshot.resumeState,
					activeTools,
					nextReadyAction: state.checkpoint?.nextReadyAction,
					blockingReason: state.blockingReason,
					writerLeaseHeld: Boolean(state.writerLease && leaseValid),
					implementationWriter: plannedImplementationWriter(),
					workerRunId: state.workerRunId,
					workerStatus: state.workerStatus,
					workerLaunchContractDigest: state.workerLaunchContractDigest,
					candidateDigest: state.candidateDigest,
					validationRunId: state.validationRunId,
					validationStatus: state.validationStatus,
					validationFailureKind: state.validationFailureKind,
					validationEvidence: state.validationEvidence,
					reviewVerdict: state.reviewEvidence?.verdict,
					solutionDocument: state.solutionDocument
						? {
								requirementName: state.solutionDocument.requirementName,
								solutionPath: state.solutionDocument.solutionPath,
								planPath: state.solutionDocument.planPath,
							}
						: undefined,
					planningDocuments: state.planningDocuments
						? {
								requirementName: state.planningDocuments.requirementName,
								solutionPath: state.planningDocuments.solutionPath,
								planPath: state.planningDocuments.planPath,
							}
						: undefined,
					guidance,
				},
			};
		},
	});

	pi.registerTool({
		name: "delivery_begin",
		label: "开始交付流程",
		description: "仅在用户明确输入 /delivery-shape 后，从 IDLE 进入只读方案梳理阶段。普通问答、只读梳理、诊断或评审不得调用；该工具不能授予写权限。",
		parameters: Type.Object({
			goal: Type.String({ minLength: 1, maxLength: 4000 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!deliveryBeginArmed) {
				throw new Error("delivery_begin requires a real /delivery-shape input from the user");
			}
			deliveryBeginArmed = false;
			const transition = transitionDelivery(state.snapshot, { type: "START" });
			if (!transition.ok) throw new Error(transition.reason);
			state = checkpointRuntimeState(state, {
				goal: params.goal,
				checkpoint: {
					summary: "Adaptive Delivery shaping started",
					nextReadyAction: "Inspect project facts and draft the technical solution",
				},
			});
			if (!commitSnapshot(transition.snapshot, ctx, false)) {
				throw new Error("Failed to persist the shaping transition");
			}
			return {
				content: [{ type: "text", text: `已进入 ${formatDeliveryState("SHAPING")}` }],
				details: { state: "SHAPING", goal: params.goal },
			};
		},
	});

	pi.registerTool({
		name: "delivery_delegate_readonly",
		label: "只读子 Agent 委派",
		description: "仅在高风险技术取舍确实需要架构顾问时调用受限 builtin oracle。普通方案梳理由父 Pi 直接使用 read/grep/find/ls，不得启动 scout；终态证明错误不得重试同一任务。",
		parameters: Type.Object({
			role: StringEnum(READONLY_DELEGATE_ROLES),
			task: Type.String({ minLength: 1, maxLength: 20000 }),
			focus: Type.Optional(Type.String({ maxLength: 2000 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const role = params.role as ReadonlyDelegateRole;
			const identity = await resolveWorkspaceIdentity(ctx.cwd);
			const task = params.focus ? `${params.task}\n\n只读关注点：${params.focus}` : params.task;
			const contract = await subagents.preflight(role, task, ctx, identity.gitRoot);
			const result = await subagents.delegate(role, task, ctx, contract, identity.gitRoot, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					role,
					runId: result.runId,
					launchContractDigest: result.launchContractDigest,
					preflightLaunchContractDigest: result.preflightLaunchContractDigest,
				},
			};
		},
	});

	pi.registerTool({
		name: "delivery_delegate_worker",
		label: "委派唯一开发执行者",
		description: "仅在 standard/high-risk 的 IMPLEMENTING 或批准 REWORKING 中启动一个受控 foreground worker。成功后自动冻结候选并进入验证。",
		parameters: Type.Object({
			instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (state.snapshot.state !== "IMPLEMENTING" && state.snapshot.state !== "REWORKING") {
				throw new Error("Worker delegation requires IMPLEMENTING or REWORKING state");
			}
			if (implementationWriter() !== "worker") {
				throw new Error("This approved route requires direct parent implementation");
			}
			if (state.workerStatus === "starting" || state.workerStatus === "running") {
				throw new Error("A controlled worker is already active or lacks terminal proof");
			}
			await requireAuthorization(ctx, "implementation");
			if (!state.writerLease || !leaseValid) throw new Error("Worker delegation requires a proven parent-custodied writer lease");
			if (activeMutationTools.size > 0) throw new Error("Worker delegation cannot start beside an active parent mutation tool");

			const sourceState = state.snapshot.state;
			const identity = await resolveWorkspaceIdentity(ctx.cwd);
			const task = workerTask(ctx, params.instructions);
			const contract = await subagents.preflightWorker(task, ctx, identity.gitRoot);
			state = checkpointRuntimeState(state, {
				workerRunId: undefined,
				workerStatus: "starting",
				workerLaunchContractDigest: contract.launchContractDigest,
				checkpoint: {
					summary: "Controlled worker launch preflight passed",
					nextReadyAction: "Wait for the sole foreground worker terminal result",
				},
			});
			if (!persistCurrentState()) throw new Error("Worker preflight passed but its starting checkpoint could not be persisted");

			let workerCheckpointFailed = false;
			let result;
			try {
				result = await subagents.delegateWorker(task, ctx, contract, {
					signal,
					onRunId: (runId) => {
						state = checkpointRuntimeState(state, {
							workerRunId: runId,
							workerStatus: "running",
							checkpoint: {
								summary: `Controlled worker running: ${runId}`,
								nextReadyAction: "Wait for the sole foreground worker terminal result",
							},
						});
						if (!persistCurrentState()) workerCheckpointFailed = true;
					},
					onUpdate: (update) => {
						onUpdate?.({
							content: [{
								type: "text",
								text: update.currentTool
									? `唯一 worker 正在执行：${update.currentTool}`
									: "唯一 worker 正在执行已批准计划...",
							}],
							details: { runId: update.runId, toolCount: update.toolCount },
						});
					},
				});
			} catch (error) {
				setBlocked(
					`Controlled worker terminal proof is unavailable: ${error instanceof Error ? error.message : String(error)}`,
					sourceState,
				);
				persistCurrentState();
				updateStatus(ctx);
				throw error;
			}
			try {
				const recheckedContract = await subagents.preflightWorker(task, ctx, identity.gitRoot);
				const stable = validatePublicPreflightStability(contract, recheckedContract);
				if (!stable.ok) throw new Error(stable.reason);
			} catch (error) {
				let released = false;
				let releaseError: string | undefined;
				try {
					released = await releaseParentLeaseIfOwned();
				} catch (releaseFailure) {
					releaseError = releaseFailure instanceof Error ? releaseFailure.message : String(releaseFailure);
				}
				setBlocked(
					`Controlled worker public preflight cannot be revalidated: ${error instanceof Error ? error.message : String(error)}${releaseError ? `; lease release failed: ${releaseError}` : ""}`,
					sourceState,
				);
				state = checkpointRuntimeState(state, {
					workerRunId: result.runId,
					workerStatus: "failed",
					workerLaunchContractDigest: result.launchContractDigest,
					...(released ? { writerLease: undefined } : {}),
				});
				persistCurrentState();
				updateStatus(ctx);
				throw error;
			}

			if (workerCheckpointFailed) {
				let released = false;
				let releaseError: string | undefined;
				try {
					released = await releaseParentLeaseIfOwned();
				} catch (error) {
					releaseError = error instanceof Error ? error.message : String(error);
				}
				setBlocked(
					`Controlled worker completed but its running checkpoint was not durable${releaseError ? `; lease release failed: ${releaseError}` : ""}`,
					sourceState,
				);
				state = checkpointRuntimeState(state, {
					workerRunId: result.runId,
					workerStatus: "failed",
					workerLaunchContractDigest: result.launchContractDigest,
					...(released ? { writerLease: undefined } : {}),
				});
				persistCurrentState();
				updateStatus(ctx);
				throw new Error("Worker checkpoint persistence failed");
			}

			if (result.status !== "completed") {
				let released = false;
				let releaseError: string | undefined;
				try {
					released = await releaseParentLeaseIfOwned();
				} catch (error) {
					releaseError = error instanceof Error ? error.message : String(error);
				}
				setBlocked(
					`Controlled worker failed: ${result.error ?? result.status}${releaseError ? `; lease release failed: ${releaseError}` : ""}`,
					sourceState,
				);
				state = checkpointRuntimeState(state, {
					workerRunId: result.runId,
					workerStatus: "failed",
					workerLaunchContractDigest: result.launchContractDigest,
					...(released ? { writerLease: undefined } : {}),
				});
				persistCurrentState();
				updateStatus(ctx);
				throw new Error(result.error ?? `Controlled worker ended with ${result.status}`);
			}

			let candidate;
			try {
				candidate = await recomputeCandidate(ctx);
			} catch (error) {
				let released = false;
				let releaseError: string | undefined;
				try {
					released = await releaseParentLeaseIfOwned();
				} catch (releaseFailure) {
					releaseError = releaseFailure instanceof Error ? releaseFailure.message : String(releaseFailure);
				}
				setBlocked(
					`Candidate snapshot failed after controlled worker: ${error instanceof Error ? error.message : String(error)}${releaseError ? `; lease release failed: ${releaseError}` : ""}`,
					sourceState,
				);
				state = checkpointRuntimeState(state, {
					workerRunId: result.runId,
					workerStatus: "failed",
					workerLaunchContractDigest: result.launchContractDigest,
					...(released ? { writerLease: undefined } : {}),
				});
				persistCurrentState();
				updateStatus(ctx);
				throw error;
			}
			let released = false;
			let releaseError: string | undefined;
			try {
				released = await releaseParentLeaseIfOwned();
			} catch (error) {
				releaseError = error instanceof Error ? error.message : String(error);
			}
			if (!released) {
				setBlocked(
					`Cannot freeze worker candidate while writer lease ownership is unproven${releaseError ? `: ${releaseError}` : ""}`,
					sourceState,
				);
				persistCurrentState();
				updateStatus(ctx);
				throw new Error("Writer lease ownership is unproven after controlled worker completion");
			}
			const transition = transitionDelivery(
				{ state: sourceState },
				{ type: sourceState === "IMPLEMENTING" ? "BEGIN_VALIDATION" : "FINISH_REWORK" },
			);
			if (!transition.ok) throw new Error(transition.reason);
			state = checkpointRuntimeState(state, {
				workerRunId: result.runId,
				workerStatus: "completed",
				workerLaunchContractDigest: result.launchContractDigest,
				candidateDigest: candidate.digest,
				validationRunId: undefined,
				validationStatus: undefined,
				validationFailureKind: undefined,
				validationEvidence: undefined,
				reviewEvidence: undefined,
				reworkApproved: false,
				finalEvidence: undefined,
				writerLease: undefined,
				checkpoint: {
					summary: `Candidate frozen after controlled worker: ${candidate.digest}`,
					nextReadyAction: "Run fixed validation and fresh review",
				},
			});
			if (!commitSnapshot(transition.snapshot, ctx, false)) {
				throw new Error("Failed to persist the controlled worker candidate transition");
			}
			return {
				content: [{
					type: "text",
					text: `${result.text ?? "唯一 worker 已完成。"}\n\n候选已冻结：${candidate.digest}`,
				}],
				details: {
					runId: result.runId,
					model: result.model,
					launchContractDigest: result.launchContractDigest,
					preflightLaunchContractDigest: result.preflightLaunchContractDigest,
					candidateDigest: candidate.digest,
				},
			};
		},
	});

	pi.registerTool({
		name: "delivery_submit_candidate",
		label: "提交候选进行验证",
		description: "冻结当前候选、释放 parent writer lease，并进入验证中状态。",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (state.snapshot.state !== "IMPLEMENTING" && state.snapshot.state !== "REWORKING") {
				throw new Error("Candidate can only be submitted from IMPLEMENTING or REWORKING");
			}
			if (implementationWriter() !== "parent") {
				throw new Error("This approved route requires the controlled worker to submit the candidate");
			}
			if (!state.planContract && !state.tinyContract) throw new Error("Approved delivery contract is missing");
			await requireAuthorization(ctx, "implementation");
			if (activeMutationTools.size > 0) throw new Error("Cannot freeze candidate while mutation tools are active");
			let candidate;
			let tinyScopeEvidence;
			if (state.tinyContract) {
				if (!state.tinyBaseline || !state.approvals?.combined) throw new Error("Tiny approval baseline is missing");
				const frozen = await freezeTinyCandidate({
					cwd: ctx.cwd,
					contract: state.tinyContract,
					baseline: state.tinyBaseline,
					approval: state.approvals.combined,
					approvals: { combined: state.approvals.combined },
				});
				candidate = frozen.candidate;
				tinyScopeEvidence = frozen.evidence;
			} else {
				candidate = await recomputeCandidate(ctx);
			}
			if (!(await releaseParentLeaseIfOwned())) {
				setBlocked("Cannot submit candidate while writer lease ownership is unproven", state.snapshot.state);
				persistCurrentState();
				updateStatus(ctx);
				throw new Error("Writer lease ownership is unproven");
			}
			const event: DeliveryEvent = {
				type: state.snapshot.state === "IMPLEMENTING" ? "BEGIN_VALIDATION" : "FINISH_REWORK",
			};
			const transition = transitionDelivery(state.snapshot, event);
			if (!transition.ok) throw new Error(transition.reason);
			state = checkpointRuntimeState(state, {
				candidateDigest: candidate.digest,
				tinyScopeEvidence,
				validationRunId: undefined,
				validationStatus: undefined,
				validationFailureKind: undefined,
				validationEvidence: undefined,
				workerRunId: undefined,
				workerStatus: undefined,
				workerLaunchContractDigest: undefined,
				reviewEvidence: undefined,
				reworkApproved: false,
				finalEvidence: undefined,
				writerLease: undefined,
				checkpoint: {
					summary: `Candidate frozen: ${candidate.digest}`,
					nextReadyAction: isTinyDelivery() ? "Run focused fixed validation" : "Run fixed validation and fresh review",
				},
			});
			if (!commitSnapshot(transition.snapshot, ctx, false)) {
				throw new Error("Failed to persist the candidate transition");
			}
			return {
				content: [{ type: "text", text: `候选已冻结：${candidate.digest}` }],
				details: { candidateDigest: candidate.digest },
			};
		},
	});

	pi.registerTool({
		name: "delivery_validate",
		label: "执行固定验证",
		description: "对当前 candidate 执行已批准计划中的固定验证命令，并在同一工具调用中等待权威终态。调用者不能传入命令；不要循环查询状态。",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			if (state.snapshot.state !== "VALIDATING") throw new Error("Validation requires VALIDATING state");
			if (!state.planContract && !state.tinyContract) throw new Error("Approved delivery contract is missing");
			await requireAuthorization(ctx, "implementation");
			if (state.validationStatus === "pending") throw new Error("Validation is already pending for this candidate");
			const candidateDigest = await requireCurrentCandidate(ctx);
			const validationCommands = approvedValidationCommands();
			const commandIds = validationCommands.map((command) => command.id);
			const startedAt = Date.now();
			const runId = randomUUID();
			onUpdate?.({
				content: [{ type: "text", text: `正在启动固定验证\n批准命令：${commandIds.join("、")}` }],
				details: { state: "starting", candidateDigest, commandIds },
			});
			state = checkpointRuntimeState(state, {
				validationRunId: runId,
				validationStatus: "pending",
				validationFailureKind: undefined,
				validationEvidence: undefined,
				checkpoint: {
					summary: `Validation started for ${candidateDigest}`,
					nextReadyAction: "Wait in the current validation tool call for terminal command results",
				},
			});
			if (!persistCurrentState()) throw new Error("Validation started but its checkpoint could not be persisted");

			const completedRuns: ValidationCommandResult[] = [];
			const result: ValidationBatchResult = await runApprovedValidation({
				pi,
				cwd: ctx.cwd,
				commands: validationCommands,
				signal,
				onProgress: (progress) => {
					if (progress.phase === "completed" && progress.result) completedRuns.push(progress.result);
					const current = progress.phase === "completed"
						? `已完成 ${progress.index + 1}/${progress.total}：${progress.command.id}`
						: `正在执行 ${progress.index + 1}/${progress.total}：${progress.command.id}`;
					const visibleCommand = progress.command.command.length > 500
						? `${progress.command.command.slice(0, 500)}...`
						: progress.command.command;
					onUpdate?.({
						content: [{
							type: "text",
							text: [
								`${current}（已运行 ${formatElapsed(startedAt)}）`,
								`命令：${visibleCommand}`,
								`验证批次：${runId}`,
								...formatValidationRuns(completedRuns),
							].join("\n"),
						}],
						details: { runId, candidateDigest, commandIds, completedRuns: [...completedRuns] },
					});
				},
			});

			try {
				await requireCurrentCandidate(ctx);
			} catch (error) {
				setBlocked("Candidate changed after validation completed", "VALIDATING");
				state = checkpointRuntimeState(state, {
					validationStatus: "failed",
					validationFailureKind: "candidate",
					validationEvidence: undefined,
				});
				persistCurrentState();
				updateStatus(ctx);
				return {
					content: [{ type: "text", text: `验证期间候选版本发生变化，当前结果已失效：${error instanceof Error ? error.message : String(error)}` }],
					details: { runId, candidateDigest, result, staleCandidate: true },
				};
			}

			if (result.status === "passed") {
				state = checkpointRuntimeState(state, {
					validationStatus: "passed",
					validationFailureKind: undefined,
					validationEvidence: buildValidationEvidence(runId, candidateDigest, result),
					checkpoint: {
						summary: `Validation passed for ${candidateDigest}`,
						nextReadyAction: isTinyDelivery() ? "Finalize the same Tiny candidate" : "Run fresh review for the same candidate",
					},
				});
				if (!persistCurrentState()) throw new Error("Validation passed but its terminal checkpoint could not be persisted");
				updateStatus(ctx);
				return {
					content: [{ type: "text", text: [
						`固定验证已通过，且结果绑定当前候选版本：${candidateDigest}`,
						...formatValidationRuns(result.runs),
						isTinyDelivery() ? "下一步完成同一 Tiny 候选版本的交付。" : "下一步进行同一候选版本的独立审查。",
					].join("\n") }],
					details: { runId, candidateDigest, result },
				};
			}

			const failedIds = result.runs
				.filter((run) => run.status === "failed" || run.status === "timed-out")
				.map((run) => run.id);
			const failureKind = result.status === "failed" ? "candidate" as const : "infrastructure" as const;
			const reason = failureKind === "candidate"
				? `Approved validation command(s) failed: ${failedIds.join(", ")}`
				: `Validation infrastructure failed: ${result.error ?? "unknown execution error"}`;
			setBlocked(reason, "VALIDATING");
			state = checkpointRuntimeState(state, {
				validationStatus: "failed",
				validationFailureKind: failureKind,
				validationEvidence: buildValidationEvidence(runId, candidateDigest, result),
				checkpoint: {
					summary: failureKind === "candidate"
						? `Approved validation failed for ${candidateDigest}`
						: `Validation infrastructure failed for ${candidateDigest}`,
					nextReadyAction: failureKind === "candidate"
						? "Classify the failed command as a candidate, environment, or approved-plan problem"
						: "Restore validation infrastructure, then retry the same candidate",
				},
			});
			if (!persistCurrentState()) throw new Error("Validation failed but its terminal checkpoint could not be persisted");
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: [
					`固定验证未通过：${runId}`,
					...formatValidationRuns(result.runs),
					...validationFailureExcerpts(result.runs),
					"该结果只证明批准命令未通过，不自动等同于源码缺陷；需要区分候选代码、验证环境和已批准计划。",
				].join("\n") }],
				details: { runId, candidateDigest, result },
			};
		},
	});

	pi.registerTool({
		name: "delivery_review_candidate",
		label: "独立审查候选",
		description: "使用 fresh reviewer 审查当前 candidate，并在返回后复算 digest。",
		parameters: Type.Object({
			focus: Type.Optional(Type.String({ maxLength: 2000 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (state.snapshot.state !== "VALIDATING") throw new Error("Review requires VALIDATING state");
			if (isTinyDelivery()) throw new Error("Tiny Delivery does not use fresh review; upgrade to Standard when independent review is required");
			await requireAuthorization(ctx, "implementation");
			const candidateDigest = await requireCurrentCandidate(ctx);
			if (
				state.validationStatus !== "passed" ||
				!state.validationEvidence ||
				state.validationEvidence.candidateDigest !== candidateDigest ||
				state.validationEvidence.outcome !== "passed"
			) {
				throw new Error("Fresh review requires passed fixed validation evidence for the current candidate");
			}
			const identity = await resolveWorkspaceIdentity(ctx.cwd);
			const reviewPacket = await createCandidateReviewPacket({
				cwd: ctx.cwd,
				candidateDigest,
				progressPaths: state.planContract?.progressTargets,
			});
			await requireCurrentCandidate(ctx);
			const task = [
				"Review the current repository candidate without modifying project/source files.",
				`Approved requirement and acceptance context:\n${approvedContextText(ctx) || "(no approved context text available)"}`,
				params.focus ? `Review focus: ${params.focus}` : "Review correctness, regressions, tests, and unnecessary complexity.",
				"The runtime-generated packet below is the canonical actual candidate diff. Review this exact packet; do not infer changes from repository state alone.",
				reviewPacket.text,
				"Return exactly one fenced adaptive-delivery-review JSON object with version, candidateDigest, diffDigest, verdict, and findings. Each finding has severity, path, line, and summary. P0/P1 requires BLOCK; no P0/P1 permits OK or OK_WITH_NOTES.",
			].join("\n");
			const contract = await subagents.preflight("reviewer", task, ctx, identity.gitRoot);
			const result = await subagents.delegate("reviewer", task, ctx, contract, identity.gitRoot, signal);
			await requireCurrentCandidate(ctx);
			const review = parseStructuredReviewResult(result.text, reviewPacket);
			if (!review) throw new Error("Fresh reviewer did not return valid candidate/diff-bound review evidence");
			state = checkpointRuntimeState(state, {
				reviewEvidence: {
					candidateDigest,
					candidateDiffDigest: reviewPacket.diffDigest,
					reviewContractVersion: review.version,
					verdict: review.verdict,
					textDigest: digestApprovalContent(result.text),
					...(result.runId ? { runId: result.runId } : {}),
					completedAt: new Date().toISOString(),
				},
				checkpoint: {
					summary: `Fresh review completed for ${candidateDigest}`,
					nextReadyAction: "Classify findings and either rework or finalize delivery",
				},
			});
			if (!persistCurrentState()) throw new Error("Review completed but its evidence could not be persisted");
			return {
				content: [{ type: "text", text: result.text }],
				details: { candidateDigest, candidateDiffDigest: reviewPacket.diffDigest, runId: result.runId },
			};
		},
	});

	pi.registerTool({
		name: "delivery_begin_rework",
		label: "开始批准返工",
		description: "仅在当前 candidate 的 validation 失败或 fresh review BLOCK 后恢复原 writer 进行返工。",
		parameters: Type.Object({
			reason: Type.String({ minLength: 1, maxLength: 4000 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.snapshot.state !== "VALIDATING") throw new Error("Rework requires VALIDATING state");
			await requireAuthorization(ctx, "implementation");
			await requireCurrentCandidate(ctx);
			if (state.validationStatus === "pending") throw new Error("Cannot begin rework while validation is still pending");
			if (
				state.validationStatus === "failed" &&
				state.validationFailureKind !== "candidate" &&
				state.reviewEvidence?.verdict !== "BLOCK"
			) {
				throw new Error("Validation infrastructure failure must be retried before code rework");
			}
			if (state.validationStatus !== "failed" && state.reviewEvidence?.verdict !== "BLOCK") {
				throw new Error("Rework requires failed validation or a BLOCK review verdict");
			}
			const transition = transitionDelivery(state.snapshot, { type: "BEGIN_REWORK" });
			if (!transition.ok) throw new Error(transition.reason);
			state = checkpointRuntimeState(state, {
				reworkApproved: true,
				checkpoint: {
					summary: `Rework approved: ${params.reason}`,
					nextReadyAction: "Apply only accepted findings, then submit a new candidate",
				},
			});
			if (!(await ensureParentWriterLease(ctx))) throw new Error("Failed to acquire writer lease for rework");
			if (!commitSnapshot(transition.snapshot, ctx, true)) {
				throw new Error("Failed to persist the rework transition");
			}
			return {
				content: [{ type: "text", text: `已进入 ${formatDeliveryState("REWORKING")}` }],
				details: { candidateDigest: state.candidateDigest, reason: params.reason },
			};
		},
	});

	pi.registerTool({
		name: "delivery_finalize",
		label: "完成开发交付",
		description: "在当前 candidate 的固定 validation 通过，且所需 review/scope 证据有效时进入已交付状态。",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (state.snapshot.state !== "VALIDATING") throw new Error("Finalize requires VALIDATING state");
			await requireAuthorization(ctx, "implementation");
			const candidateDigest = await requireCurrentCandidate(ctx);
			if (state.validationStatus !== "passed") throw new Error("Validation evidence has not passed");
			const validationEvidence = state.validationEvidence;
			const approvedValidationIds = approvedValidationCommands().map((command) => command.id);
			if (
				!validationEvidence ||
				validationEvidence.candidateDigest !== candidateDigest ||
				validationEvidence.runId !== state.validationRunId ||
				validationEvidence.outcome !== "passed" ||
				validationEvidence.commands.length !== approvedValidationIds.length ||
				validationEvidence.commands.some((command, index) => command.id !== approvedValidationIds[index] || command.status !== "passed")
			) {
				throw new Error("Validation command evidence is missing, stale, or does not match the approved plan");
			}
			if (isTinyDelivery()) {
				if (
					!state.tinyBaseline ||
					!state.tinyScopeEvidence ||
					state.tinyScopeEvidence.baselineDigest !== state.tinyBaseline.candidateDigest ||
					state.tinyScopeEvidence.candidateDigest !== candidateDigest
				) {
					throw new Error("Tiny baseline or exact scope evidence is missing or stale");
				}
			} else {
				if (
					!state.reviewEvidence ||
					state.reviewEvidence.candidateDigest !== candidateDigest ||
					state.reviewEvidence.reviewContractVersion !== 1 ||
					!state.reviewEvidence.candidateDiffDigest
				) {
					throw new Error("Fresh candidate/diff-bound review evidence is missing or stale");
				}
				if (state.reviewEvidence.verdict === "BLOCK") throw new Error("Fresh review still blocks delivery");
			}
			const identity = await resolveWorkspaceIdentity(ctx.cwd);
			const progressArtifacts = [];
			for (const progressPath of state.planContract?.progressTargets ?? []) {
				const snapshot = await snapshotProgressArtifact(identity.gitRoot, progressPath);
				progressArtifacts.push({ path: snapshot.path, digest: snapshot.digest });
			}
			await requireCurrentCandidate(ctx);
			const transition = transitionDelivery(state.snapshot, { type: "DELIVER" });
			if (!transition.ok) throw new Error(transition.reason);
			state = checkpointRuntimeState(state, {
				finalEvidence: {
					candidateDigest,
					progressArtifacts,
					completedAt: new Date().toISOString(),
				},
				checkpoint: {
					summary: `Delivery finalized for ${candidateDigest}`,
					nextReadyAction: "User TUI acceptance and separately authorized publication actions",
				},
			});
			if (!commitSnapshot(transition.snapshot, ctx, false)) {
				throw new Error("Failed to persist the delivered transition");
			}
			return {
				content: [{ type: "text", text: `已进入 ${formatDeliveryState("DELIVERED")}` }],
				details: { candidateDigest, progressArtifacts },
			};
		},
	});

	pi.registerTool({
		name: "delivery_progress_sync",
		label: "同步项目进度",
		description: "在 writer-free 边界更新批准计划中的 exact progress target。不能修改其他路径或运行任意 Bash。",
		parameters: Type.Object({
			target: Type.String({ minLength: 1, maxLength: 512 }),
			oldText: Type.String({ minLength: 1, maxLength: 20000 }),
			newText: Type.String({ maxLength: 20000 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.snapshot.state !== "VALIDATING" && state.snapshot.state !== "BLOCKED") {
				throw new Error("Progress sync is allowed only at VALIDATING or BLOCKED writer-free boundaries");
			}
			if (state.tinyContract) throw new Error("Tiny Delivery has no project progress target; upgrade to Standard when progress sync is required");
			if (!state.planContract) throw new Error("Approved plan contract is missing");
			await requireAuthorization(ctx, "implementation");
			const planContract = state.planContract;
			if (state.writerLease) throw new Error("Progress sync requires no active writer lease");
			const identity = await resolveWorkspaceIdentity(ctx.cwd);
			const target = await resolveProgressTarget(identity.gitRoot, planContract.progressTargets, params.target);
			const existing = await writerLeases.read(identity.key);
			if (existing) throw new Error(`Progress sync requires writer-free workspace; owner=${existing.owner.sessionId}`);
			const acquired = await writerLeases.acquire(identity, {
				kind: "parent",
				sessionId: ctx.sessionManager.getSessionId(),
				pid: process.pid,
			});
			if (!acquired.ok) throw new Error(acquired.reason);
			leaseValid = true;
			state = checkpointRuntimeState(state, {
				writerLease: acquired.reference,
				checkpoint: {
					summary: `progress-sync started for ${target.relative}`,
					nextReadyAction: "Complete project progress update and restore the base policy",
				},
			});
			if (!persistCurrentState()) {
				await writerLeases.release(acquired.reference, {
					kind: "parent-owner",
					processToken: writerLeases.processToken,
				});
				leaseValid = false;
				throw new Error("Failed to persist progress-sync operation checkpoint");
			}
			const progressPolicy = policy.apply(state.snapshot, {
				approvalsValid: true,
				writerLeaseHeld: true,
				writerLeaseOwner: "parent",
				reworkApproved: false,
				progressSync: {
					active: true,
					writerFree: true,
					targetPath: target.absolute,
					targetPathProven: true,
				},
			});
			if (!progressPolicy.ok || progressPolicy.policy.reason) {
				const reason = progressPolicy.reason ?? progressPolicy.policy.reason ?? "Failed to apply progress-sync policy";
				const restored = policy.apply(state.snapshot, readOnlyContext());
				if (restored.ok && !restored.policy.reason) {
					await writerLeases.release(acquired.reference, {
						kind: "parent-owner",
						processToken: writerLeases.processToken,
					});
					leaseValid = false;
					state = checkpointRuntimeState(state, { writerLease: undefined });
				}
				setBlocked(`Progress sync failed: ${reason}`, state.snapshot.state === "VALIDATING" ? "VALIDATING" : undefined);
				persistCurrentState();
				updateStatus(ctx);
				throw new Error(reason);
			}

			let result;
			try {
				result = await syncProjectProgress({
					gitRoot: identity.gitRoot,
					approvedTargets: planContract.progressTargets,
					target: params.target,
					oldText: params.oldText,
					newText: params.newText,
					checks: planContract.progressChecks,
					runCheck: async (check) => {
						const checkResult = await pi.exec(check.command, [...check.args], {
							cwd: identity.workspacePath,
							timeout: check.timeoutMs,
						});
						return { code: checkResult.code, stdout: checkResult.stdout, stderr: checkResult.stderr };
					},
				});
				const restored = policy.apply(state.snapshot, readOnlyContext());
				if (!restored.ok || restored.policy.reason) {
					throw new Error(restored.reason ?? restored.policy.reason ?? "Failed to restore base policy");
				}
				await writerLeases.release(acquired.reference, {
					kind: "parent-owner",
					processToken: writerLeases.processToken,
				});
				leaseValid = false;
				state = checkpointRuntimeState(state, {
					writerLease: undefined,
					checkpoint: {
						summary: `Project progress synchronized: ${result.target}`,
						nextReadyAction: state.snapshot.state === "VALIDATING" ? "Continue candidate validation" : "Resolve the blocking condition",
					},
				});
				if (!persistCurrentState()) throw new Error("Project progress changed but final checkpoint failed");
				updateStatus(ctx);
				return {
					content: [{ type: "text", text: `项目进度已同步：${result.target}` }],
					details: result,
				};
			} catch (error) {
				const restored = policy.apply(state.snapshot, readOnlyContext());
				if (restored.ok && !restored.policy.reason) {
					try {
						await writerLeases.release(acquired.reference, {
							kind: "parent-owner",
							processToken: writerLeases.processToken,
						});
						leaseValid = false;
					} catch {
						// Keep the reference and block below when release cannot be proven.
					}
				}
				setBlocked(`Progress sync failed: ${error instanceof Error ? error.message : String(error)}`, state.snapshot.state === "VALIDATING" ? "VALIDATING" : undefined);
				state = checkpointRuntimeState(state, {
					...(leaseValid ? {} : { writerLease: undefined }),
				});
				persistCurrentState();
				updateStatus(ctx);
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "delivery_invalidate",
		label: "撤销交付授权",
		description: "只能降低权限。BLOCKED 暂时阻塞并保留批准与证据；SHAPING/PLANNING 才撤销相应批准。",
		parameters: Type.Object({
			target: StringEnum(["SHAPING", "PLANNING", "BLOCKED"] as const),
			reason: Type.String({ minLength: 1 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const priorSnapshot = state.snapshot;
			const locked = policy.forceReadOnly();
			if (!locked.ok) {
				setBlocked(`Cannot invalidate because read-only policy failed: ${locked.reason ?? "unknown error"}`);
				persistCurrentState();
				updateStatus(ctx);
				throw new Error("Read-only policy could not be proven");
			}
			if (state.writerLease && !(await releaseParentLeaseIfOwned())) {
				setBlocked("Cannot invalidate while writer lease ownership is unproven", resumableState(state.snapshot.state));
				persistCurrentState();
				updateStatus(ctx);
				throw new Error("Writer lease ownership is unproven");
			}
			const target = params.target;
			if (target === "BLOCKED") {
				const resumeState = priorSnapshot.state === "BLOCKED"
					? priorSnapshot.resumeState
					: resumableState(priorSnapshot.state);
				state = checkpointRuntimeState(state, {
					snapshot: { state: "BLOCKED", ...(resumeState ? { resumeState } : {}) },
					writerLease: undefined,
					blockingReason: params.reason,
					recoveryCondition: "Resolve the blocking condition, then ask the TUI user to run /delivery-resume",
				});
			} else {
				state = checkpointRuntimeState(state, {
					snapshot: { state: target },
					approvals: target === "PLANNING" ? { solution: state.approvals?.solution } : {},
					proposedDocuments: target === "PLANNING" || (target === "SHAPING" && state.solutionDocument)
						? state.proposedDocuments
						: undefined,
					writerLease: undefined,
					planContract: undefined,
					tinyContract: undefined,
					tinyBaseline: undefined,
					tinyScopeEvidence: undefined,
					planningDocuments: undefined,
					workerRunId: undefined,
					workerStatus: undefined,
					workerLaunchContractDigest: undefined,
					candidateDigest: undefined,
					validationRunId: undefined,
					validationStatus: undefined,
					validationFailureKind: undefined,
					validationEvidence: undefined,
					reviewEvidence: undefined,
					reworkApproved: false,
					finalEvidence: undefined,
					blockingReason: undefined,
					recoveryCondition: undefined,
				});
			}
			if (!persistCurrentState()) throw new Error("Authorization was invalidated but its checkpoint could not be persisted");
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: `已降权到 ${formatDeliveryState(target)}：${params.reason}` }],
				details: { target, reason: params.reason, resumeState: state.snapshot.resumeState },
			};
		},
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			activeMutationTools.set(event.toolCallId, event.toolName);
		}
	});
	pi.on("tool_execution_end", async (event, _ctx) => {
		activeMutationTools.delete(event.toolCallId);
		if (activeDeliveryBarrier?.toolCallId === event.toolCallId) activeDeliveryBarrier = undefined;
	});
	pi.on("tool_call", async (event, ctx) => {
		if (SERIALIZED_DELIVERY_TOOLS.has(event.toolName)) {
			if (activeMutationTools.size > 0) {
				return { block: true, reason: `${event.toolName} cannot run in a tool batch that already contains a writer` };
			}
			if (activeDeliveryBarrier && activeDeliveryBarrier.toolCallId !== event.toolCallId) {
				return {
					block: true,
					reason: `${event.toolName} cannot run beside Delivery control operation ${activeDeliveryBarrier.toolName}`,
				};
			}
			activeDeliveryBarrier = { toolCallId: event.toolCallId, toolName: event.toolName };
			return;
		}
		if (event.toolName === "edit" || event.toolName === "write") {
			if (activeDeliveryBarrier) {
				return {
					block: true,
					reason: `${activeDeliveryBarrier.toolName} is a serialization barrier; sibling writes are blocked`,
				};
			}
			const runtimePolicy = resolveDeliveryPolicy(state.snapshot, approvalPolicyContext());
			if (!runtimePolicy.sourceWrite || !leaseValid) {
				return { block: true, reason: "Current delivery state or writer lease does not allow source writes" };
			}
			if (state.tinyContract) {
				try {
					const identity = await resolveWorkspaceIdentity(ctx.cwd);
					await assertTinyWritePath({
						cwd: ctx.cwd,
						gitRoot: identity.gitRoot,
						changeScope: state.tinyContract.changeScope,
						toolPath: (event.input as Record<string, unknown> | undefined)?.path,
					});
				} catch (error) {
					return { block: true, reason: error instanceof Error ? error.message : String(error) };
				}
			}
		}
		if (event.toolName === "bash" || event.toolName === "subagent") {
			return { block: true, reason: `Raw ${event.toolName} is not allowed by Adaptive Delivery` };
		}
	});
	pi.on("input", async (event) => {
		deliveryBeginArmed =
			event.source !== "extension" &&
			/^\/delivery-shape(?:\s|$)/.test(event.text.trimStart());
	});

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("agent_start", async () => {
		pendingDiagramEntries.length = 0;
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		const entry = extractMermaidDiagrams(textFromMessageContent(event.message.content));
		if (!entry || pendingDiagramEntries.some((candidate) => candidate.messageDigest === entry.messageDigest)) return;
		pendingDiagramEntries.push(entry);
	});
	pi.on("agent_end", async (_event, ctx) => {
		deliveryBeginArmed = false;
		const entries = pendingDiagramEntries.splice(0);
		for (const entry of entries) {
			try {
				pi.appendEntry(DIAGRAM_ENTRY_CUSTOM_TYPE, entry);
			} catch (error) {
				ctx.ui.notify(`图表展示记录保存失败，Mermaid 源码仍已保留：${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
	});
	pi.on("session_before_tree", async (_event, _ctx) => {
		const result = policy.forceReadOnly();
		if (!result.ok) return { cancel: true };
	});
	pi.on("session_before_switch", async (_event, _ctx) => {
		const result = policy.forceReadOnly();
		if (!result.ok) return { cancel: true };
	});
	pi.on("session_before_fork", async (_event, _ctx) => {
		const result = policy.forceReadOnly();
		if (!result.ok) return { cancel: true };
	});
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		currentContext = undefined;
		deliveryBeginArmed = false;
		pendingDiagramEntries.length = 0;
		policy.forceReadOnly();
		subagents.dispose();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
