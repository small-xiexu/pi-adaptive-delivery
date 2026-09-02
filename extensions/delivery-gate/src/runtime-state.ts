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
	type PlanningDocumentEvidence,
} from "./planning-documents.ts";

export const DELIVERY_STATE_CUSTOM_TYPE = "pi-adaptive-delivery.state";
export const DELIVERY_RUNTIME_STATE_VERSION = 1 as const;

export interface DeliveryCheckpoint {
	summary?: string;
	changedFiles?: string[];
	nextReadyAction?: string;
}

export interface ReviewEvidence {
	candidateDigest: string;
	verdict: "BLOCK" | "OK" | "OK_WITH_NOTES";
	textDigest: string;
	runId?: string;
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
	planningDocuments?: PlanningDocumentEvidence;
	candidateDigest?: string;
	validationRunId?: string;
	validationStatus?: "pending" | "passed" | "failed";
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
	let planningDocuments: PlanningDocumentEvidence | undefined;
	if (input.planningDocuments !== undefined) {
		planningDocuments = parsePlanningDocumentEvidence(input.planningDocuments);
		if (!planningDocuments) {
			const reason = "Delivery planning document evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
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
			typeof review.completedAt !== "string" ||
			Number.isNaN(Date.parse(review.completedAt)) ||
			(review.runId !== undefined && (typeof review.runId !== "string" || !review.runId))
		) {
			const reason = "Delivery review evidence is malformed";
			return { ok: false, state: blockedState(reason, now), reason };
		}
		reviewEvidence = {
			candidateDigest: review.candidateDigest,
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
				...(planningDocuments ? { planningDocuments } : {}),
			...(candidateDigest ? { candidateDigest } : {}),
			...(validationRunId ? { validationRunId } : {}),
			...(validationStatus ? { validationStatus } : {}),
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
