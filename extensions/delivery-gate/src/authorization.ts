import {
	digestApprovalContent,
	validateApprovalRecord,
	type ApprovalMessageEntry,
} from "./approvals.ts";
import type { DeliveryState } from "./domain.ts";
import { parsePlanContractFromContent } from "./plan-contract.ts";
import type { DeliveryRuntimeState } from "./runtime-state.ts";

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
	if (needsImplementationBundle) {
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
		const parsed = entry ? parsePlanContractFromContent(entry.message.content) : undefined;
		if (!parsed) return { ok: false, reason: "Approved plan entry no longer contains a valid plan contract" };
		if (digestApprovalContent(parsed) !== digestApprovalContent(state.planContract)) {
			return { ok: false, reason: "Runtime plan contract does not match the approved assistant entry" };
		}
	}
	if ((targetState === "VALIDATING" || targetState === "REWORKING") && !state.candidateDigest) {
		return { ok: false, reason: "Candidate digest is required for validation or rework" };
	}
	return { ok: true };
}
