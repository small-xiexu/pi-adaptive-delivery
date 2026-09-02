export const DELIVERY_STATES = [
	"IDLE",
	"SHAPING",
	"SOLUTION_PENDING_APPROVAL",
	"PLANNING",
	"PLAN_PENDING_APPROVAL",
	"COMBINED_PENDING_APPROVAL",
	"IMPLEMENTING",
	"VALIDATING",
	"REWORKING",
	"BLOCKED",
	"DELIVERED",
	"CANCELLED",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type ResumeState = Exclude<DeliveryState, "IDLE" | "BLOCKED" | "DELIVERED" | "CANCELLED">;

export const STATE_LABELS: Readonly<Record<DeliveryState, string>> = {
	IDLE: "空闲",
	SHAPING: "方案梳理中",
	SOLUTION_PENDING_APPROVAL: "技术方案待确认",
	PLANNING: "实施计划编制中",
	PLAN_PENDING_APPROVAL: "实施计划待确认",
	COMBINED_PENDING_APPROVAL: "方案与计划待合并确认",
	IMPLEMENTING: "开发中",
	VALIDATING: "验证中",
	REWORKING: "返工中",
	BLOCKED: "已阻塞",
	DELIVERED: "已交付",
	CANCELLED: "已取消",
};

export interface DeliverySnapshot {
	state: DeliveryState;
	resumeState?: ResumeState;
}

export type DeliveryEvent =
	| { type: "START" }
	| { type: "SUBMIT_SOLUTION" }
	| { type: "APPROVE_SOLUTION" }
	| { type: "SUBMIT_PLAN" }
	| { type: "APPROVE_PLAN" }
	| { type: "SUBMIT_COMBINED" }
	| { type: "APPROVE_COMBINED" }
	| { type: "BEGIN_VALIDATION" }
	| { type: "BEGIN_REWORK" }
	| { type: "FINISH_REWORK" }
	| { type: "DELIVER" }
	| { type: "BLOCK" }
	| { type: "RESUME" }
	| { type: "REVISE_SOLUTION" }
	| { type: "REVISE_PLAN" }
	| { type: "CANCEL" };

export type TransitionResult =
	| { ok: true; snapshot: DeliverySnapshot }
	| { ok: false; snapshot: DeliverySnapshot; reason: string };

const TERMINAL_STATES = new Set<DeliveryState>(["DELIVERED", "CANCELLED"]);
const RESUMABLE_STATES = new Set<DeliveryState>([
	"SHAPING",
	"SOLUTION_PENDING_APPROVAL",
	"PLANNING",
	"PLAN_PENDING_APPROVAL",
	"COMBINED_PENDING_APPROVAL",
	"IMPLEMENTING",
	"VALIDATING",
	"REWORKING",
]);

const DIRECT_TRANSITIONS: Readonly<Record<string, DeliveryState>> = {
	"IDLE:START": "SHAPING",
	"SHAPING:SUBMIT_SOLUTION": "SOLUTION_PENDING_APPROVAL",
	"SHAPING:SUBMIT_COMBINED": "COMBINED_PENDING_APPROVAL",
	"SOLUTION_PENDING_APPROVAL:APPROVE_SOLUTION": "PLANNING",
	"PLANNING:SUBMIT_PLAN": "PLAN_PENDING_APPROVAL",
	"PLAN_PENDING_APPROVAL:APPROVE_PLAN": "IMPLEMENTING",
	"COMBINED_PENDING_APPROVAL:APPROVE_COMBINED": "IMPLEMENTING",
	"IMPLEMENTING:BEGIN_VALIDATION": "VALIDATING",
	"VALIDATING:BEGIN_REWORK": "REWORKING",
	"REWORKING:FINISH_REWORK": "VALIDATING",
	"VALIDATING:DELIVER": "DELIVERED",
};

export function parseDeliveryState(value: unknown): DeliveryState | undefined {
	return typeof value === "string" && (DELIVERY_STATES as readonly string[]).includes(value)
		? (value as DeliveryState)
		: undefined;
}

export function formatDeliveryState(state: DeliveryState): string {
	return `${STATE_LABELS[state]} [${state}]`;
}

export function transitionDelivery(snapshot: DeliverySnapshot, event: DeliveryEvent): TransitionResult {
	if (event.type === "CANCEL" && !TERMINAL_STATES.has(snapshot.state)) {
		return { ok: true, snapshot: { state: "CANCELLED" } };
	}

	if (event.type === "BLOCK" && RESUMABLE_STATES.has(snapshot.state)) {
		return { ok: true, snapshot: { state: "BLOCKED", resumeState: snapshot.state as ResumeState } };
	}

	if (event.type === "RESUME" && snapshot.state === "BLOCKED" && snapshot.resumeState) {
		return { ok: true, snapshot: { state: snapshot.resumeState } };
	}

	if (event.type === "REVISE_SOLUTION" && !TERMINAL_STATES.has(snapshot.state) && snapshot.state !== "IDLE") {
		return { ok: true, snapshot: { state: "SHAPING" } };
	}

	if (
		event.type === "REVISE_PLAN" &&
		["PLANNING", "PLAN_PENDING_APPROVAL", "IMPLEMENTING", "VALIDATING", "REWORKING", "BLOCKED"].includes(snapshot.state)
	) {
		return { ok: true, snapshot: { state: "PLANNING" } };
	}

	const next = DIRECT_TRANSITIONS[`${snapshot.state}:${event.type}`];
	if (!next) {
		return {
			ok: false,
			snapshot,
			reason: `Illegal delivery transition: ${snapshot.state} -> ${event.type}`,
		};
	}

	return { ok: true, snapshot: { state: next } };
}

export type SubagentAccess = "none" | "readonly" | "validation" | "controlled-writer";
export type HostCommandAccess = "none" | "approved" | "fixed-validation" | "fixed-progress-check";

export interface PolicyContext {
	approvalsValid: boolean;
	writerLeaseHeld: boolean;
	writerLeaseOwner: "parent" | "child" | null;
	reworkApproved: boolean;
	progressSync?: {
		active: boolean;
		writerFree: boolean;
		targetPath?: string;
		targetPathProven: boolean;
	};
}

export interface DeliveryPolicy {
	readTools: boolean;
	sourceWrite: boolean;
	writablePaths: readonly string[];
	rawBash: boolean;
	rawSubagent: boolean;
	subagentAccess: SubagentAccess;
	hostCommandAccess: HostCommandAccess;
	reason?: string;
}

const READ_ONLY_POLICY: DeliveryPolicy = {
	readTools: true,
	sourceWrite: false,
	writablePaths: [],
	rawBash: false,
	rawSubagent: false,
	subagentAccess: "none",
	hostCommandAccess: "none",
};

function readonlyPolicyForState(state: DeliveryState): DeliveryPolicy {
	switch (state) {
		case "SHAPING":
		case "SOLUTION_PENDING_APPROVAL":
		case "PLANNING":
		case "PLAN_PENDING_APPROVAL":
		case "COMBINED_PENDING_APPROVAL":
			return { ...READ_ONLY_POLICY, subagentAccess: "readonly" };
		case "VALIDATING":
			return {
				...READ_ONLY_POLICY,
				subagentAccess: "validation",
				hostCommandAccess: "fixed-validation",
			};
		case "BLOCKED":
			return { ...READ_ONLY_POLICY, subagentAccess: "readonly" };
		default:
			return READ_ONLY_POLICY;
	}
}

export function resolveDeliveryPolicy(snapshot: DeliverySnapshot, context: PolicyContext): DeliveryPolicy {
	const progress = context.progressSync;
	if (progress?.active) {
		if (
			!context.approvalsValid ||
			!progress.writerFree ||
			!context.writerLeaseHeld ||
			context.writerLeaseOwner !== "parent" ||
			!progress.targetPathProven ||
			!progress.targetPath
		) {
			return { ...READ_ONLY_POLICY, reason: "progress-sync preconditions are not proven" };
		}

		return {
			...READ_ONLY_POLICY,
			writablePaths: [progress.targetPath],
			hostCommandAccess: "fixed-progress-check",
		};
	}

	if (snapshot.state === "IMPLEMENTING" || snapshot.state === "REWORKING") {
		const reworkAllowed = snapshot.state !== "REWORKING" || context.reworkApproved;
		if (
			context.approvalsValid &&
			context.writerLeaseHeld &&
			context.writerLeaseOwner !== null &&
			reworkAllowed
		) {
			return {
				readTools: true,
				sourceWrite: true,
				writablePaths: [],
				rawBash: false,
				rawSubagent: false,
				subagentAccess: "controlled-writer",
				hostCommandAccess: "approved",
			};
		}

		return { ...READ_ONLY_POLICY, reason: "writer authorization or lease is not proven" };
	}

	return readonlyPolicyForState(snapshot.state);
}
