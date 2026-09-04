import {
	parseDeliveryState,
	type DeliverySnapshot,
	type ResumeState,
} from "./domain.ts";
import {
	APPROVAL_KINDS,
	parseApprovalRecord,
	type ApprovalKind,
	type ApprovalRecord,
} from "./approvals.ts";
import {
	parseWriterLeaseReference,
	type WriterLeaseReference,
} from "./workspace.ts";
import {
	parsePlanContractValue,
	parsePlanningDocumentsValue,
	type ApprovedPlanContract,
	type PlanningDocumentsContract,
} from "./plan-contract.ts";
import {
	parsePlanningDocumentEvidence,
	parsePlanningDocumentRevisionIntent,
	parseSolutionDocumentEvidence,
	type PlanningDocumentEvidence,
	type PlanningDocumentRevisionIntent,
	type SolutionDocumentEvidence,
} from "./planning-documents.ts";
import {
	parseTinyContractValue,
	type TinyDeliveryContract,
} from "./tiny-contract.ts";
import {
	parseTinyApprovalBaseline,
	parseTinyScopeEvidence,
	type TinyApprovalBaseline,
	type TinyScopeEvidence,
} from "./tiny-scope.ts";

export const DELIVERY_STATE_CUSTOM_TYPE = "pi-adaptive-delivery.state";
export const DELIVERY_RUNTIME_STATE_VERSION = 1 as const;

export interface DeliveryCheckpoint {
	summary?: string;
	changedFiles?: string[];
	nextReadyAction?: string;
}

export interface ReviewEvidence {
	candidateDigest: string;
	candidateDiffDigest?: string;
	reviewContractVersion?: 1;
	verdict: "BLOCK" | "OK" | "OK_WITH_NOTES";
	textDigest: string;
	runId?: string;
	completedAt: string;
}

export interface ValidationEvidence {
	candidateDigest: string;
	runId: string;
	outcome: "passed" | "failed" | "infrastructure";
	commands: Array<{
		id: string;
		status: "passed" | "failed" | "timed-out" | "cancelled" | "error";
		durationMs: number;
		exitCode?: number;
	}>;
	completedAt: string;
}

export interface FinalEvidence {
	candidateDigest: string;
	progressArtifacts: Array<{ path: string; digest: string }>;
	completedAt: string;
}

export interface DeliveryRuntimeState {
	version: typeof DELIVERY_RUNTIME_STATE_VERSION;
	snapshot: DeliverySnapshot;
	taskId?: string;
	goal?: string;
	approvals?: Partial<Record<ApprovalKind, ApprovalRecord>>;
	writerLease?: WriterLeaseReference;
	proposedDocuments?: PlanningDocumentsContract;
	planContract?: ApprovedPlanContract;
	tinyContract?: TinyDeliveryContract;
	tinyBaseline?: TinyApprovalBaseline;
	tinyScopeEvidence?: TinyScopeEvidence;
	solutionDocument?: SolutionDocumentEvidence;
	planningDocuments?: PlanningDocumentEvidence;
	planningDocumentRevision?: PlanningDocumentRevisionIntent;
	workerRunId?: string;
	workerStatus?: "starting" | "running" | "completed" | "failed";
	workerLaunchContractDigest?: string;
	candidateDigest?: string;
	validationRunId?: string;
	validationStatus?: "pending" | "passed" | "failed";
	validationFailureKind?: "candidate" | "infrastructure";
	validationEvidence?: ValidationEvidence;
	reviewEvidence?: ReviewEvidence;
	reworkApproved?: boolean;
	finalEvidence?: FinalEvidence;
	blockingReason?: string;
	recoveryCondition?: string;
	checkpoint?: DeliveryCheckpoint;
	updatedAt: string;
}

export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export type RestoreRuntimeStateResult =
	| { ok: true; state: DeliveryRuntimeState; found: boolean }
	| { ok: false; state: DeliveryRuntimeState; reason: string };

export function createInitialRuntimeState(now: Date = new Date()): DeliveryRuntimeState {
	return {
		version: DELIVERY_RUNTIME_STATE_VERSION,
		snapshot: { state: "IDLE" },
		updatedAt: now.toISOString(),
	};
}

function blockedState(reason: string, now: Date): DeliveryRuntimeState {
	return {
		version: DELIVERY_RUNTIME_STATE_VERSION,
		snapshot: { state: "BLOCKED" },
		blockingReason: reason,
		updatedAt: now.toISOString(),
	};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return [...value];
}

export function parseRuntimeState(value: unknown, now: Date = new Date()): RestoreRuntimeStateResult {
	if (!value || typeof value !== "object") {
		const reason = "Delivery state entry is not an object";
		return { ok: false, state: blockedState(reason, now), reason };
	}

	const input = value as Record<string, unknown>;
	if (input.version !== DELIVERY_RUNTIME_STATE_VERSION) {
		const reason = `Unsupported delivery state version: ${String(input.version)}`;
		return { ok: false, state: blockedState(reason, now), reason };
	}

	if (!input.snapshot || typeof input.snapshot !== "object") {
		const reason = "Delivery state snapshot is missing";
		return { ok: false, state: blockedState(reason, now), reason };
	}

	const snapshotInput = input.snapshot as Record<string, unknown>;
	const state = parseDeliveryState(snapshotInput.state);
	if (!state) {
		const reason = `Unknown delivery state: ${String(snapshotInput.state)}`;
		return { ok: false, state: blockedState(reason, now), reason };
	}

	const parsedResumeState = parseDeliveryState(snapshotInput.resumeState);
	if (
		snapshotInput.resumeState !== undefined &&
		(!parsedResumeState || ["IDLE", "BLOCKED", "DELIVERED", "CANCELLED"].includes(parsedResumeState))
	) {
		const reason = `Invalid delivery resume state: ${String(snapshotInput.resumeState)}`;
		return { ok: false, state: blockedState(reason, now), reason };
	}

	if (state === "BLOCKED" && !parsedResumeState && snapshotInput.resumeState !== undefined) {
		const reason = "Blocked delivery state has an invalid resume state";
		return { ok: false, state: blockedState(reason, now), reason };
	}

	const checkpointInput = input.checkpoint;
	let checkpoint: DeliveryCheckpoint | undefined;
	if (checkpointInput !== undefined) {
		if (!checkpointInput || typeof checkpointInput !== "object") {
			const reason = "Delivery checkpoint is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		const raw = checkpointInput as Record<string, unknown>;
		const changedFiles = optionalStringArray(raw.changedFiles);
		if (raw.changedFiles !== undefined && changedFiles === undefined) {
			const reason = "Delivery checkpoint changedFiles is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		checkpoint = {
			...(optionalString(raw.summary) ? { summary: optionalString(raw.summary) } : {}),
			...(changedFiles ? { changedFiles } : {}),
			...(optionalString(raw.nextReadyAction) ? { nextReadyAction: optionalString(raw.nextReadyAction) } : {}),
		};
	}

	const updatedAt = optionalString(input.updatedAt);
	if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
		const reason = "Delivery state updatedAt is invalid";
		return { ok: false, state: blockedState(reason, now), reason };
	}

	let approvals: Partial<Record<ApprovalKind, ApprovalRecord>> | undefined;
	if (input.approvals !== undefined) {
		if (!input.approvals || typeof input.approvals !== "object") {
			const reason = "Delivery approvals are malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		approvals = {};
		const rawApprovals = input.approvals as Record<string, unknown>;
		for (const kind of APPROVAL_KINDS) {
			if (rawApprovals[kind] === undefined) continue;
			const parsed = parseApprovalRecord(rawApprovals[kind]);
			if (!parsed || parsed.kind !== kind) {
				const reason = `Delivery ${kind} approval is malformed`;
				return { ok: false, state: blockedState(reason, now), reason };
			}
			approvals[kind] = parsed;
		}
	}

	let writerLease: WriterLeaseReference | undefined;
	if (input.writerLease !== undefined) {
		writerLease = parseWriterLeaseReference(input.writerLease);
		if (!writerLease) {
			const reason = "Delivery writer lease reference is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}

	let planContract: ApprovedPlanContract | undefined;
	let proposedDocuments: PlanningDocumentsContract | undefined;
	if (input.proposedDocuments !== undefined) {
		proposedDocuments = parsePlanningDocumentsValue(input.proposedDocuments);
		if (!proposedDocuments) {
			const reason = "Delivery planning document proposal is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}
	if (input.planContract !== undefined) {
		planContract = parsePlanContractValue(input.planContract);
		if (!planContract) {
			const reason = "Delivery plan contract is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}
	let tinyContract: TinyDeliveryContract | undefined;
	let tinyBaseline: TinyApprovalBaseline | undefined;
	let tinyScopeEvidence: TinyScopeEvidence | undefined;
	if (input.tinyContract !== undefined) {
		tinyContract = parseTinyContractValue(input.tinyContract);
		if (!tinyContract) {
			const reason = "Delivery Tiny contract is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}
	if (planContract && tinyContract) {
		const reason = "Delivery state cannot contain both plan and Tiny contracts";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	if (input.tinyBaseline !== undefined) {
		tinyBaseline = parseTinyApprovalBaseline(input.tinyBaseline);
		if (!tinyBaseline) {
			const reason = "Delivery Tiny approval baseline is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}
	if (input.tinyScopeEvidence !== undefined) {
		tinyScopeEvidence = parseTinyScopeEvidence(input.tinyScopeEvidence);
		if (!tinyScopeEvidence) {
			const reason = "Delivery Tiny scope evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}
	if ((tinyBaseline || tinyScopeEvidence) && !tinyContract) {
		const reason = "Delivery Tiny evidence requires a Tiny contract";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	let planningDocuments: PlanningDocumentEvidence | undefined;
	let solutionDocument: SolutionDocumentEvidence | undefined;
	if (input.solutionDocument !== undefined) {
		solutionDocument = parseSolutionDocumentEvidence(input.solutionDocument);
		if (!solutionDocument) {
			const reason = "Delivery technical solution document evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}
	if (input.planningDocuments !== undefined) {
		planningDocuments = parsePlanningDocumentEvidence(input.planningDocuments);
		if (!planningDocuments) {
			const reason = "Delivery planning document evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}
	let planningDocumentRevision: PlanningDocumentRevisionIntent | undefined;
	if (input.planningDocumentRevision !== undefined) {
		planningDocumentRevision = parsePlanningDocumentRevisionIntent(input.planningDocumentRevision);
		if (!planningDocumentRevision) {
			const reason = "Delivery planning document revision intent is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		const previousParents = JSON.stringify(planningDocumentRevision.previousParentIdentities);
		const matchesSolution = solutionDocument &&
			planningDocumentRevision.path === solutionDocument.solutionPath &&
			planningDocumentRevision.previousContentDigest === solutionDocument.solutionContentDigest &&
			planningDocumentRevision.previousFileIdentity.dev === solutionDocument.solutionFileIdentity.dev &&
			planningDocumentRevision.previousFileIdentity.ino === solutionDocument.solutionFileIdentity.ino &&
			previousParents === JSON.stringify(solutionDocument.solutionParentIdentities);
		const matchesPlan = planningDocuments &&
			planningDocumentRevision.path === planningDocuments.planPath &&
			planningDocumentRevision.previousContentDigest === planningDocuments.planContentDigest &&
			planningDocumentRevision.previousFileIdentity.dev === planningDocuments.planFileIdentity.dev &&
			planningDocumentRevision.previousFileIdentity.ino === planningDocuments.planFileIdentity.ino &&
			previousParents === JSON.stringify(planningDocuments.planParentIdentities);
		const matchesPlanningSolution = !planningDocuments || (
			planningDocumentRevision.path === planningDocuments.solutionPath &&
			planningDocumentRevision.previousContentDigest === planningDocuments.solutionContentDigest &&
			planningDocumentRevision.previousFileIdentity.dev === planningDocuments.solutionFileIdentity.dev &&
			planningDocumentRevision.previousFileIdentity.ino === planningDocuments.solutionFileIdentity.ino &&
			previousParents === JSON.stringify(planningDocuments.solutionParentIdentities)
		);
		if (
			(planningDocumentRevision.kind === "solution" && (!matchesSolution || !matchesPlanningSolution)) ||
			(planningDocumentRevision.kind === "plan" && !matchesPlan)
		) {
			const reason = "Delivery planning document revision intent does not match the previous evidence";
			return { ok: false, state: blockedState(reason, now), reason };
		}
	}
	const workerRunId = optionalString(input.workerRunId);
	const workerStatus = input.workerStatus;
	if (
		workerStatus !== undefined &&
		workerStatus !== "starting" &&
		workerStatus !== "running" &&
		workerStatus !== "completed" &&
		workerStatus !== "failed"
	) {
		const reason = "Delivery worker status is malformed";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	if ((workerStatus === "running" || workerStatus === "completed" || workerStatus === "failed") && !workerRunId) {
		const reason = "Delivery worker status requires a run id";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	const workerLaunchContractDigest = optionalString(input.workerLaunchContractDigest);
	if (workerLaunchContractDigest && !/^[a-f0-9]{64}$/.test(workerLaunchContractDigest)) {
		const reason = "Delivery worker launch contract digest is malformed";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	const candidateDigest = optionalString(input.candidateDigest);
	if (candidateDigest && !/^[a-f0-9]{64}$/.test(candidateDigest)) {
		const reason = "Delivery candidate digest is malformed";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	const validationRunId = optionalString(input.validationRunId);
	const validationStatus = input.validationStatus;
	if (
		validationStatus !== undefined &&
		validationStatus !== "pending" &&
		validationStatus !== "passed" &&
		validationStatus !== "failed"
	) {
		const reason = "Delivery validation status is malformed";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	const validationFailureKind = input.validationFailureKind;
	if (
		validationFailureKind !== undefined &&
		(validationFailureKind !== "candidate" && validationFailureKind !== "infrastructure")
	) {
		const reason = "Delivery validation failure kind is malformed";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	if (validationFailureKind !== undefined && validationStatus !== "failed") {
		const reason = "Delivery validation failure kind requires failed validation status";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	let validationEvidence: ValidationEvidence | undefined;
	if (input.validationEvidence !== undefined) {
		if (!input.validationEvidence || typeof input.validationEvidence !== "object" || Array.isArray(input.validationEvidence)) {
			const reason = "Delivery validation evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		const evidence = input.validationEvidence as Record<string, unknown>;
		const commands = Array.isArray(evidence.commands) ? evidence.commands : undefined;
		const seen = new Set<string>();
		if (
			typeof evidence.candidateDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(evidence.candidateDigest) ||
			typeof evidence.runId !== "string" ||
			!evidence.runId ||
			(evidence.outcome !== "passed" && evidence.outcome !== "failed" && evidence.outcome !== "infrastructure") ||
			!commands ||
			commands.length > 12 ||
			!commands.every((value) => {
				if (!value || typeof value !== "object" || Array.isArray(value)) return false;
				const command = value as Record<string, unknown>;
				if (
					typeof command.id !== "string" ||
					!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(command.id) ||
					seen.has(command.id) ||
					(command.status !== "passed" && command.status !== "failed" && command.status !== "timed-out" && command.status !== "cancelled" && command.status !== "error") ||
					typeof command.durationMs !== "number" ||
					!Number.isInteger(command.durationMs) ||
					command.durationMs < 0 ||
					(command.exitCode !== undefined && (typeof command.exitCode !== "number" || !Number.isInteger(command.exitCode)))
				) return false;
				seen.add(command.id);
				return true;
			}) ||
			typeof evidence.completedAt !== "string" ||
			Number.isNaN(Date.parse(evidence.completedAt))
		) {
			const reason = "Delivery validation evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		if (evidence.outcome === "passed" && (commands.length === 0 || commands.some((value) => (value as Record<string, unknown>).status !== "passed"))) {
			const reason = "Passed validation evidence contains a non-passing command";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		validationEvidence = {
			candidateDigest: evidence.candidateDigest,
			runId: evidence.runId,
			outcome: evidence.outcome,
			commands: commands.map((value) => {
				const command = value as Record<string, unknown>;
				return {
					id: command.id as string,
					status: command.status as ValidationEvidence["commands"][number]["status"],
					durationMs: command.durationMs as number,
					...(typeof command.exitCode === "number" ? { exitCode: command.exitCode } : {}),
				};
			}),
			completedAt: evidence.completedAt,
		};
		if (
			validationEvidence.runId !== validationRunId ||
			validationEvidence.candidateDigest !== candidateDigest ||
			validationStatus === undefined ||
			validationStatus === "pending" ||
			(validationStatus === "passed" && validationEvidence.outcome !== "passed") ||
			(validationStatus === "failed" && validationEvidence.outcome === "passed") ||
			(validationEvidence.outcome === "failed" && validationFailureKind !== "candidate") ||
			(validationEvidence.outcome === "infrastructure" && validationFailureKind !== "infrastructure")
		) {
			const reason = "Delivery validation evidence does not match validation state";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		const approvedValidation = planContract?.validation ?? tinyContract?.validation;
		if (approvedValidation) {
			const expected = approvedValidation;
			const prefixMatches = validationEvidence.commands.every((command, index) => command.id === expected[index]?.id);
			if (
				!prefixMatches ||
				(validationEvidence.outcome !== "infrastructure" && validationEvidence.commands.length !== expected.length)
			) {
				const reason = "Delivery validation evidence does not match the approved plan contract";
				return { ok: false, state: blockedState(reason, now), reason };
			}
		}
	}
	let reviewEvidence: ReviewEvidence | undefined;
	if (input.reviewEvidence !== undefined) {
		if (!input.reviewEvidence || typeof input.reviewEvidence !== "object") {
			const reason = "Delivery review evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		const review = input.reviewEvidence as Record<string, unknown>;
		if (
			typeof review.candidateDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(review.candidateDigest) ||
			(review.verdict !== "BLOCK" && review.verdict !== "OK" && review.verdict !== "OK_WITH_NOTES") ||
			typeof review.textDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(review.textDigest) ||
			(review.candidateDiffDigest !== undefined &&
				(typeof review.candidateDiffDigest !== "string" || !/^[a-f0-9]{64}$/.test(review.candidateDiffDigest))) ||
			(review.reviewContractVersion !== undefined && review.reviewContractVersion !== 1) ||
			typeof review.completedAt !== "string" ||
			Number.isNaN(Date.parse(review.completedAt)) ||
			(review.runId !== undefined && (typeof review.runId !== "string" || !review.runId))
		) {
			const reason = "Delivery review evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		reviewEvidence = {
			candidateDigest: review.candidateDigest,
			...(typeof review.candidateDiffDigest === "string" ? { candidateDiffDigest: review.candidateDiffDigest } : {}),
			...(review.reviewContractVersion === 1 ? { reviewContractVersion: 1 as const } : {}),
			verdict: review.verdict,
			textDigest: review.textDigest,
			...(typeof review.runId === "string" ? { runId: review.runId } : {}),
			completedAt: review.completedAt,
		};
	}
	if (input.reworkApproved !== undefined && typeof input.reworkApproved !== "boolean") {
		const reason = "Delivery rework approval is malformed";
		return { ok: false, state: blockedState(reason, now), reason };
	}
	let finalEvidence: FinalEvidence | undefined;
	if (input.finalEvidence !== undefined) {
		if (!input.finalEvidence || typeof input.finalEvidence !== "object") {
			const reason = "Delivery final evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		const final = input.finalEvidence as Record<string, unknown>;
		if (
			typeof final.candidateDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(final.candidateDigest) ||
			!Array.isArray(final.progressArtifacts) ||
			!final.progressArtifacts.every(
				(item) =>
					Boolean(
						item &&
							typeof item === "object" &&
							typeof (item as Record<string, unknown>).path === "string" &&
							/^[a-f0-9]{64}$/.test(String((item as Record<string, unknown>).digest)),
					),
			) ||
			typeof final.completedAt !== "string" ||
			Number.isNaN(Date.parse(final.completedAt))
		) {
			const reason = "Delivery final evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		finalEvidence = {
			candidateDigest: final.candidateDigest,
			progressArtifacts: (final.progressArtifacts as Array<Record<string, unknown>>).map((item) => ({
				path: String(item.path),
				digest: String(item.digest),
			})),
			completedAt: final.completedAt,
		};
	}

	return {
		ok: true,
		found: true,
		state: {
			version: DELIVERY_RUNTIME_STATE_VERSION,
			snapshot: {
				state,
				...(parsedResumeState ? { resumeState: parsedResumeState as ResumeState } : {}),
			},
			...(optionalString(input.taskId) ? { taskId: optionalString(input.taskId) } : {}),
			...(optionalString(input.goal) ? { goal: optionalString(input.goal) } : {}),
			...(approvals ? { approvals } : {}),
			...(writerLease ? { writerLease } : {}),
			...(proposedDocuments ? { proposedDocuments } : {}),
			...(planContract ? { planContract } : {}),
			...(tinyContract ? { tinyContract } : {}),
			...(tinyBaseline ? { tinyBaseline } : {}),
			...(tinyScopeEvidence ? { tinyScopeEvidence } : {}),
			...(solutionDocument ? { solutionDocument } : {}),
			...(planningDocuments ? { planningDocuments } : {}),
			...(planningDocumentRevision ? { planningDocumentRevision } : {}),
			...(workerRunId ? { workerRunId } : {}),
			...(workerStatus ? { workerStatus } : {}),
			...(workerLaunchContractDigest ? { workerLaunchContractDigest } : {}),
			...(candidateDigest ? { candidateDigest } : {}),
			...(validationRunId ? { validationRunId } : {}),
			...(validationStatus ? { validationStatus } : {}),
			...(validationFailureKind ? { validationFailureKind } : {}),
			...(validationEvidence ? { validationEvidence } : {}),
			...(reviewEvidence ? { reviewEvidence } : {}),
			...(typeof input.reworkApproved === "boolean" ? { reworkApproved: input.reworkApproved } : {}),
			...(finalEvidence ? { finalEvidence } : {}),
			...(optionalString(input.blockingReason) ? { blockingReason: optionalString(input.blockingReason) } : {}),
			...(optionalString(input.recoveryCondition) ? { recoveryCondition: optionalString(input.recoveryCondition) } : {}),
			...(checkpoint ? { checkpoint } : {}),
			updatedAt,
		},
	};
}

export function restoreRuntimeState(
	entries: readonly SessionEntryLike[],
	now: Date = new Date(),
): RestoreRuntimeStateResult {
	const latest = [...entries]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === DELIVERY_STATE_CUSTOM_TYPE);

	if (!latest) {
		return { ok: true, state: createInitialRuntimeState(now), found: false };
	}

	return parseRuntimeState(latest.data, now);
}

export function checkpointRuntimeState(
	state: DeliveryRuntimeState,
	updates: Partial<Omit<DeliveryRuntimeState, "version" | "updatedAt">>,
	now: Date = new Date(),
): DeliveryRuntimeState {
	return {
		...state,
		...updates,
		version: DELIVERY_RUNTIME_STATE_VERSION,
		updatedAt: now.toISOString(),
	};
}
