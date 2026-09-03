import {
	digestApprovalContent,
	validateApprovalRecord,
	type ApprovalMessageEntry,
} from "./approvals.ts";
import type { DeliveryState } from "./domain.ts";
import {
	parsePlanContractFromContent,
	parsePlanningDocumentsFromContent,
	type PlanningDocumentsContract,
} from "./plan-contract.ts";
import type { DeliveryRuntimeState } from "./runtime-state.ts";
import {
	digestPlanningDocumentContent,
	extractPlanningDocumentContent,
	type SolutionDocumentEvidence,
} from "./planning-documents.ts";
import { parseTinyContractFromContent } from "./tiny-contract.ts";

export interface AuthorizationContext {
	sessionId: string;
	branch: readonly unknown[];
	canonicalCwd: string;
	gitRoot: string;
}

export type AuthorizationRequirement = "state" | "implementation";

function approvalEntry(branch: readonly unknown[], entryId: string): ApprovalMessageEntry | undefined {
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Record<string, unknown>;
		if (candidate.id !== entryId || candidate.type !== "message") continue;
		if (!candidate.message || typeof candidate.message !== "object") continue;
		if ((candidate.message as Record<string, unknown>).role !== "assistant") continue;
		return candidate as unknown as ApprovalMessageEntry;
	}
	return undefined;
}

function effectiveState(state: DeliveryRuntimeState): DeliveryState {
	return state.snapshot.state === "BLOCKED" && state.snapshot.resumeState
		? state.snapshot.resumeState
		: state.snapshot.state;
}

function samePlanningDocuments(left: PlanningDocumentsContract, right: PlanningDocumentsContract): boolean {
	return left.requirementName === right.requirementName &&
		left.solutionPath === right.solutionPath &&
		left.planPath === right.planPath &&
		left.selectionSource === right.selectionSource;
}

function solutionEvidenceMatches(
	evidence: SolutionDocumentEvidence,
	documents: PlanningDocumentsContract,
): boolean {
	return evidence.requirementName === documents.requirementName &&
		evidence.solutionPath === documents.solutionPath &&
		evidence.planPath === documents.planPath &&
		evidence.selectionSource === documents.selectionSource;
}

export function validateAuthorizationBundle(
	state: DeliveryRuntimeState,
	context: AuthorizationContext,
	requirement: AuthorizationRequirement = "state",
): { ok: true } | { ok: false; reason: string } {
	for (const record of Object.values(state.approvals ?? {})) {
		if (!record) continue;
		const result = validateApprovalRecord(record, context);
		if (!result.ok) return result;
	}

	const targetState = effectiveState(state);
	const needsSolution = ["PLANNING", "PLAN_PENDING_APPROVAL"].includes(targetState);
	const needsImplementationBundle =
		requirement === "implementation" || ["IMPLEMENTING", "VALIDATING", "REWORKING"].includes(targetState);
	if (needsSolution && !state.approvals?.solution) {
		return { ok: false, reason: "A valid solution approval is required before planning" };
	}
	if (needsSolution && state.approvals?.solution) {
		const entry = approvalEntry(context.branch, state.approvals.solution.entryId);
		const proposed = entry ? parsePlanningDocumentsFromContent(entry.message.content) : undefined;
		const solutionContent = entry
			? extractPlanningDocumentContent(entry.message.content, "solution")
			: undefined;
		if (
			!proposed ||
			!state.proposedDocuments ||
			!samePlanningDocuments(proposed, state.proposedDocuments) ||
			!state.solutionDocument ||
			!solutionEvidenceMatches(state.solutionDocument, proposed) ||
			!solutionContent ||
			state.solutionDocument.solutionContentDigest !== digestPlanningDocumentContent(solutionContent)
		) {
			return { ok: false, reason: "Planning document paths do not match the approved solution entry" };
		}
	}
	if (needsImplementationBundle) {
		if (state.tinyContract) {
			const combined = state.approvals?.combined;
			if (!combined || state.approvals?.solution || state.approvals?.plan) {
				return { ok: false, reason: "Tiny implementation requires exactly one combined approval" };
			}
			const entry = approvalEntry(context.branch, combined.entryId);
			const parsed = entry ? parseTinyContractFromContent(entry.message.content) : undefined;
			if (!parsed || digestApprovalContent(parsed) !== digestApprovalContent(state.tinyContract)) {
				return { ok: false, reason: "Runtime Tiny contract does not match the approved assistant entry" };
			}
			if (!state.tinyBaseline || state.tinyBaseline.approvalContentDigest !== combined.contentDigest) {
				return { ok: false, reason: "Tiny approval baseline is missing or stale" };
			}
			if (
				(targetState === "VALIDATING" || targetState === "REWORKING") &&
				(!state.tinyScopeEvidence || state.tinyScopeEvidence.candidateDigest !== state.candidateDigest)
			) {
				return { ok: false, reason: "Tiny scope evidence is missing or stale" };
			}
		} else {
			const combined = state.approvals?.combined;
			const standard = state.approvals?.solution && state.approvals?.plan;
			if (!combined && !standard) {
				return { ok: false, reason: "Implementation requires solution+plan approvals or one combined approval" };
			}
			const planApproval = combined ?? state.approvals?.plan;
			if (!planApproval || !state.planContract) {
				return { ok: false, reason: "Approved plan contract is missing" };
			}
			const entry = approvalEntry(context.branch, planApproval.entryId);
			if (!entry) return { ok: false, reason: "Approved plan entry is absent" };
			const parsed = parsePlanContractFromContent(entry.message.content);
			if (!parsed) return { ok: false, reason: "Approved plan entry no longer contains a valid plan contract" };
			if (digestApprovalContent(parsed) !== digestApprovalContent(state.planContract)) {
				return { ok: false, reason: "Runtime plan contract does not match the approved assistant entry" };
			}
			const solutionApproval = combined ?? state.approvals?.solution;
			const solutionEntry = solutionApproval ? approvalEntry(context.branch, solutionApproval.entryId) : undefined;
			const proposed = solutionEntry ? parsePlanningDocumentsFromContent(solutionEntry.message.content) : undefined;
			const solutionContent = solutionEntry
				? extractPlanningDocumentContent(solutionEntry.message.content, "solution")
				: undefined;
			const planContent = extractPlanningDocumentContent(entry.message.content, "plan");
			const documents = state.planningDocuments;
			if (
				!proposed ||
				!state.proposedDocuments ||
				!samePlanningDocuments(proposed, state.proposedDocuments) ||
				!samePlanningDocuments(state.proposedDocuments, state.planContract.documents) ||
				!solutionContent ||
				!planContent ||
				!documents
			) {
				return { ok: false, reason: "Approved planning documents have not been synchronized" };
			}
			if (
				documents.requirementName !== state.planContract.documents.requirementName ||
				documents.solutionPath !== state.planContract.documents.solutionPath ||
				documents.planPath !== state.planContract.documents.planPath ||
				documents.selectionSource !== state.planContract.documents.selectionSource ||
				documents.solutionContentDigest !== digestPlanningDocumentContent(solutionContent) ||
				documents.planContentDigest !== digestPlanningDocumentContent(planContent)
			) {
				return { ok: false, reason: "Planning document evidence does not match the approved entries" };
			}
		}
	}
	if ((targetState === "VALIDATING" || targetState === "REWORKING") && !state.candidateDigest) {
		return { ok: false, reason: "Candidate digest is required for validation or rework" };
	}
	return { ok: true };
}
