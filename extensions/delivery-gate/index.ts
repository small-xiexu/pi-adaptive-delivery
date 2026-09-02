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
	parsePlanContractFromContent,
	parsePlanningDocumentsFromContent,
} from "./src/plan-contract.ts";
import {
	assertPlanningDocumentsExist,
	extractPlanningDocumentContent,
	stripAdaptiveDeliveryProtocol,
	writePlanningDocuments,
} from "./src/planning-documents.ts";
import {
	READONLY_DELEGATE_ROLES,
	SubagentBoundary,
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

const STATUS_KEY = "adaptive-delivery";
const SERIALIZED_DELIVERY_TOOLS = new Set([
	"delivery_begin",
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
	const activeMutationTools = new Map<string, string>();
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
	});

	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "assistant" ? stripAdaptiveDeliveryProtocol(markdown) : markdown,
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
		if (state.planningDocuments) {
			try {
				await assertPlanningDocumentsExist(identity.gitRoot, state.planningDocuments);
			} catch (error) {
				return `Planning documents cannot be proven: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		return undefined;
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		currentContext = ctx;
		subagents.bindSession(ctx.sessionManager.getSessionId());
		policy.captureBaseline();
		const restored = restoreRuntimeState(ctx.sessionManager.getBranch());
		state = restored.state;
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
		if (!restored.ok || approvalError || !applied.ok || applied.policy.reason) {
			const reason = !restored.ok
				? restored.reason
				: approvalError ?? applied.reason ?? applied.policy.reason ?? "Failed to apply delivery policy";
			setBlocked(reason, resumableState(state.snapshot.state));
			persistCurrentState();
		} else if (!restored.found) {
			persistCurrentState();
		}
		updateStatus(ctx);
		if (state.validationStatus === "pending" && state.validationRunId) {
			try {
				const status = await subagents.status(state.validationRunId);
				if (status.state !== "running" && status.state !== "queued") {
					await handleValidationCompletion(
						{
							runId: state.validationRunId,
							state: status.state,
							success: status.state === "complete",
						},
						ctx,
					);
				}
			} catch (error) {
				setBlocked(`Pending validation status cannot be proven: ${error instanceof Error ? error.message : String(error)}`, "VALIDATING");
				persistCurrentState();
				updateStatus(ctx);
			}
		}
	}

	async function handleValidationCompletion(payload: unknown, ctx?: ExtensionContext): Promise<void> {
		if (
			!payload ||
			typeof payload !== "object" ||
			state.snapshot.state !== "VALIDATING" ||
			!state.validationRunId ||
			state.validationStatus !== "pending"
		) return;
		const result = payload as Record<string, unknown>;
		const runId = typeof result.runId === "string" ? result.runId : typeof result.id === "string" ? result.id : undefined;
		if (runId !== state.validationRunId) return;
		const activeContext = ctx ?? currentContext;
		if (!activeContext) {
			setBlocked("Validation completed without an active parent context", "VALIDATING");
			state = checkpointRuntimeState(state, { validationStatus: "failed" });
			persistCurrentState();
			return;
		}
		const terminalState = typeof result.status === "string" ? result.status : typeof result.state === "string" ? result.state : undefined;
		const success = result.success === true && (terminalState === "completed" || terminalState === "complete");
		if (!success) {
			setBlocked(`Validation run failed: ${terminalState ?? "unknown state"}`, "VALIDATING");
			state = checkpointRuntimeState(state, { validationStatus: "failed" });
			persistCurrentState();
			updateStatus(activeContext);
			return;
		}
		try {
			await requireCurrentCandidate(activeContext);
			state = checkpointRuntimeState(state, {
				validationStatus: "passed",
				checkpoint: {
					summary: `Validation passed for ${state.candidateDigest}`,
					nextReadyAction: "Run fresh review for the same candidate",
				},
			});
			persistCurrentState();
			updateStatus(activeContext);
		} catch {
			state = checkpointRuntimeState(state, { validationStatus: "failed" });
			persistCurrentState();
		}
	}

	function approvalPolicyContext(): PolicyContext {
		return {
			approvalsValid: Boolean(state.approvals?.plan || state.approvals?.combined),
			writerLeaseHeld: leaseValid,
			writerLeaseOwner: leaseValid ? "parent" : null,
			reworkApproved: state.reworkApproved === true,
		};
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

	async function ensureParentWriterLease(ctx: ExtensionContext): Promise<boolean> {
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
				"IMPLEMENTING",
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

	async function approve(
		ctx: ExtensionCommandContext,
		kind: ApprovalKind,
		event: DeliveryEvent,
	): Promise<void> {
		await ctx.waitForIdle();
		if (kind === "plan") {
			const reason = await validateStoredApprovals(ctx);
			if (reason) {
				ctx.ui.notify(reason, "error");
				return;
			}
		}
		const target = await createCurrentApproval(kind, ctx);
		if (!target) return;
		const { record } = target;
		const planContract = kind === "solution" ? undefined : parsePlanContractFromContent(target.content);
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
		}
		const documentSummary = `\n需求：${proposedDocuments.requirementName}\n技术方案：${proposedDocuments.solutionPath}\n实施计划：${proposedDocuments.planPath}\n路径来源：${proposedDocuments.selectionSource}`;
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
				ctx.ui.notify(submitted.reason, "error");
				return;
			}
			approvalSnapshot = submitted.snapshot;
		}
		const transition = transitionDelivery(approvalSnapshot, event);
		if (!transition.ok) {
			ctx.ui.notify(transition.reason, "error");
			return;
		}
		state = checkpointRuntimeState(state, {
			approvals: { ...state.approvals, [kind]: record },
			proposedDocuments,
			...(planContract ? { planContract } : {}),
		});
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
				const planningDocuments = await writePlanningDocuments({
					gitRoot: identity.gitRoot,
					documents: planContract.documents,
					solutionContent: planningDocumentContent.solution,
					planContent: planningDocumentContent.plan,
				});
				state = checkpointRuntimeState(state, {
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
				ctx.ui.notify(reason, "error");
				return;
			}
		}
		if (!commitSnapshot(transition.snapshot, ctx, widening)) return;
		if (kind === "solution") {
			queueAutomaticContinuation(
				ctx,
				"/delivery-plan",
				`技术方案已批准：${proposedDocuments.requirementName}\n技术方案：${proposedDocuments.solutionPath}\n实施计划：${proposedDocuments.planPath}\n正在生成实施计划...`,
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
			let writerOwner = "(none)";
			if (state.writerLease) {
				try {
					const record = await writerLeases.read(state.writerLease.workspaceKey);
					writerOwner = record?.leaseId === state.writerLease.leaseId
						? `${record.owner.kind}:${record.owner.sessionId}${record.owner.runId ? `/${record.owner.runId}` : ""}`
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
			const lines = [
				`状态：${formatDeliveryState(state.snapshot.state)}`,
				`恢复状态：${state.snapshot.resumeState ? formatDeliveryState(state.snapshot.resumeState) : "(none)"}`,
				`Writer owner：${writerOwner}`,
				`Candidate：${state.candidateDigest ? `${state.candidateDigest} (${candidateValidity})` : "不可证明"}`,
				`Validation：${state.validationStatus ? `${state.validationStatus} (${evidenceValidity})` : "不可证明"}${state.validationRunId ? ` (${state.validationRunId})` : ""}`,
				`Review：${state.reviewEvidence ? `${state.reviewEvidence.verdict} (${reviewValidity})` : "不可证明"}`,
				`规划文档：${state.planningDocuments
					? `${state.planningDocuments.requirementName} (${state.planningDocuments.solutionPath}, ${state.planningDocuments.planPath}; synced)`
					: state.proposedDocuments
						? `${state.proposedDocuments.requirementName} (${state.proposedDocuments.solutionPath}, ${state.proposedDocuments.planPath}; pending)`
						: "不可证明"}`,
				`Progress-sync：${state.checkpoint?.summary?.startsWith("progress-sync") ? state.checkpoint.summary : "inactive"}`,
				...(state.blockingReason ? [`阻塞原因：${state.blockingReason}`] : []),
				...(state.checkpoint?.summary ? [`断点：${state.checkpoint.summary}`] : []),
				...(state.checkpoint?.nextReadyAction ? [`下一步：${state.checkpoint.nextReadyAction}`] : []),
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
				ctx.ui.notify(transition.reason, "error");
				return;
			}
			state = checkpointRuntimeState(state, {
				approvals: event.type === "REVISE_PLAN" ? { solution: state.approvals?.solution } : {},
				proposedDocuments: event.type === "REVISE_PLAN" ? state.proposedDocuments : undefined,
				planContract: undefined,
				planningDocuments: undefined,
				candidateDigest: undefined,
				validationRunId: undefined,
				validationStatus: undefined,
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
				ctx.ui.notify(transition.reason, "error");
				return;
			}
			if (state.validationStatus === "pending") {
				state = checkpointRuntimeState(state, {
					validationRunId: undefined,
					validationStatus: undefined,
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
				ctx.ui.notify("当前没有可恢复的 BLOCKED 状态。", "warning");
				return;
			}
			const authorizationError = await validateStoredApprovals(ctx);
			if (authorizationError) {
				ctx.ui.notify(`无法恢复：${authorizationError}`, "error");
				return;
			}
			const confirmed = await requireTuiUserConfirmation(ctx, {
				title: "恢复交付流程",
				message: `恢复到 ${formatDeliveryState(state.snapshot.resumeState)}？`,
			});
			if (!confirmed) return;
			const transition = transitionDelivery(state.snapshot, { type: "RESUME" });
			if (!transition.ok) {
				ctx.ui.notify(transition.reason, "error");
				return;
			}
			const widening = transition.snapshot.state === "IMPLEMENTING" || transition.snapshot.state === "REWORKING";
			if (widening && !(await ensureParentWriterLease(ctx))) return;
			commitSnapshot(transition.snapshot, ctx, widening);
		},
	});

	pi.registerCommand("delivery-force-release-lease", {
		description: "在用户确认后强制释放当前 workspace 的 writer lease",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const identity = await resolveWorkspaceIdentity(ctx.cwd);
			const existing = await writerLeases.read(identity.key);
			if (!existing) {
				ctx.ui.notify("当前 workspace 没有 writer lease。", "info");
				return;
			}
			const confirmed = await requireTuiUserConfirmation(ctx, {
				title: "强制释放 writer lease",
				message: `workspace=${existing.workspace.workspacePath}\nowner=${existing.owner.sessionId}\nrun=${existing.owner.runId ?? "(parent)"}\n强制释放可能遗留未知 writer，确认继续？`,
			});
			if (!confirmed) return;
			await writerLeases.forceRelease(identity.key, existing.leaseId);
			leaseValid = false;
			const resumeState =
				state.snapshot.state === "IMPLEMENTING" || state.snapshot.state === "REWORKING"
					? state.snapshot.state
					: undefined;
			setBlocked("Writer lease was force-released by the user", resumeState);
			state = checkpointRuntimeState(state, { writerLease: undefined });
			persistCurrentState();
			updateStatus(ctx);
			ctx.ui.notify("writer lease 已强制释放；流程保持只读，需显式 resume。", "warning");
		},
	});

	pi.registerTool({
		name: "delivery_begin",
		label: "开始交付流程",
		description: "从 IDLE 进入只读方案梳理阶段。只能收紧为 Adaptive Delivery 流程，不能授予写权限。",
		parameters: Type.Object({
			goal: Type.String({ minLength: 1, maxLength: 4000 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
		description: "在 Adaptive Delivery 只读阶段调用受限的 native Pi 子 Agent。不能写入项目、运行 gate 或指定 output。",
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
			const result = await subagents.delegate(role, task, ctx, contract.launchContractDigest, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					role,
					runId: result.runId,
					launchContractDigest: contract.launchContractDigest,
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
			if (!state.planContract) throw new Error("Approved plan contract is missing");
			await requireAuthorization(ctx, "implementation");
			if (activeMutationTools.size > 0) throw new Error("Cannot freeze candidate while mutation tools are active");
			const candidate = await recomputeCandidate(ctx);
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
				validationRunId: undefined,
				validationStatus: undefined,
				reviewEvidence: undefined,
				reworkApproved: false,
				finalEvidence: undefined,
				writerLease: undefined,
				checkpoint: {
					summary: `Candidate frozen: ${candidate.digest}`,
					nextReadyAction: "Run fixed validation and fresh review",
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
		description: "对当前 candidate 执行已批准计划中的固定验证命令。调用者不能传入命令。",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (state.snapshot.state !== "VALIDATING") throw new Error("Validation requires VALIDATING state");
			if (!state.planContract) throw new Error("Approved plan contract is missing");
			await requireAuthorization(ctx, "implementation");
			if (state.validationStatus === "pending") throw new Error("Validation is already pending for this candidate");
			const candidateDigest = await requireCurrentCandidate(ctx);
			const spawned = await subagents.spawnValidation(state.planContract, candidateDigest, ctx);
			state = checkpointRuntimeState(state, {
				validationRunId: spawned.runId,
				validationStatus: "pending",
				checkpoint: {
					summary: `Validation launched for ${candidateDigest}`,
					nextReadyAction: "Wait for validation result, then review the same candidate",
				},
			});
			if (!persistCurrentState()) throw new Error("Validation started but its checkpoint could not be persisted");
			return {
				content: [{ type: "text", text: `验证已启动：${spawned.runId}` }],
				details: { runId: spawned.runId, candidateDigest },
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
			await requireAuthorization(ctx, "implementation");
			const candidateDigest = await requireCurrentCandidate(ctx);
			const identity = await resolveWorkspaceIdentity(ctx.cwd);
			const task = [
				"Review the current repository candidate without modifying project/source files.",
				`Candidate digest: ${candidateDigest}`,
				`Approved requirement and acceptance context:\n${approvedContextText(ctx) || "(no approved context text available)"}`,
				params.focus ? `Review focus: ${params.focus}` : "Review correctness, regressions, tests, and unnecessary complexity.",
				"Return concrete P0/P1/P2 findings with source proof and a merge verdict.",
			].join("\n");
			const contract = await subagents.preflight("reviewer", task, ctx, identity.gitRoot);
			const result = await subagents.delegate("reviewer", task, ctx, contract.launchContractDigest, signal);
			await requireCurrentCandidate(ctx);
			const verdictMatches = [...result.text.matchAll(/^Merge verdict:\s*(BLOCK|OK WITH NOTES|OK)\s*$/gim)];
			const verdict = verdictMatches.length === 1
				? verdictMatches[0]![1]!.toUpperCase().replace(/ /g, "_") as
				| "BLOCK"
				| "OK"
				| "OK_WITH_NOTES"
				: undefined;
			if (!verdict) throw new Error("Fresh reviewer did not return a recognized merge verdict");
			state = checkpointRuntimeState(state, {
				reviewEvidence: {
					candidateDigest,
					verdict,
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
				details: { candidateDigest, runId: result.runId },
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
		description: "在 validation passed、fresh review OK 且 candidate 未变化时进入已交付状态。",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (state.snapshot.state !== "VALIDATING") throw new Error("Finalize requires VALIDATING state");
			await requireAuthorization(ctx, "implementation");
			const candidateDigest = await requireCurrentCandidate(ctx);
			if (state.validationStatus !== "passed") throw new Error("Validation evidence has not passed");
			if (!state.reviewEvidence || state.reviewEvidence.candidateDigest !== candidateDigest) {
				throw new Error("Fresh review evidence is missing or stale");
			}
			if (state.reviewEvidence.verdict === "BLOCK") throw new Error("Fresh review still blocks delivery");
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
		description: "只能撤销 Adaptive Delivery 批准并退回只读状态；不能授予权限。",
		parameters: Type.Object({
			target: StringEnum(["SHAPING", "PLANNING", "BLOCKED"] as const),
			reason: Type.String({ minLength: 1 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
			state = checkpointRuntimeState(state, {
				snapshot: { state: target },
				approvals: target === "PLANNING" ? { solution: state.approvals?.solution } : {},
				proposedDocuments: target === "PLANNING" ? state.proposedDocuments : undefined,
				writerLease: undefined,
				planContract: undefined,
				planningDocuments: undefined,
				candidateDigest: undefined,
				validationRunId: undefined,
				validationStatus: undefined,
				reviewEvidence: undefined,
				reworkApproved: false,
				finalEvidence: undefined,
				blockingReason: target === "BLOCKED" ? params.reason : undefined,
			});
			if (!persistCurrentState()) throw new Error("Authorization was invalidated but its checkpoint could not be persisted");
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: `已降权到 ${formatDeliveryState(target)}：${params.reason}` }],
				details: { target, reason: params.reason },
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
	pi.on("tool_call", async (event, _ctx) => {
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
		}
		if (event.toolName === "bash" || event.toolName === "subagent") {
			return { block: true, reason: `Raw ${event.toolName} is not allowed by Adaptive Delivery` };
		}
	});

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.events.on("subagent:async-complete", async (payload) => {
		await handleValidationCompletion(payload);
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
		policy.forceReadOnly();
		subagents.dispose();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
