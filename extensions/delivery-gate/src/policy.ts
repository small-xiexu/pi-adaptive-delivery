import {
	resolveDeliveryPolicy,
	type DeliveryPolicy,
	type DeliverySnapshot,
	type PolicyContext,
} from "./domain.ts";

export interface PolicyHost {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	applySubagentAccess?(access: DeliveryPolicy["subagentAccess"]): void;
}

export interface ApplyPolicyResult {
	ok: boolean;
	policy: DeliveryPolicy;
	activeTools: string[];
	reason?: string;
}

export interface PolicyControllerOptions {
	baselineKey?: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SAFE_CONTROL_TOOLS = new Set([
	"delivery_runtime_status",
	"delivery_invalidate",
]);
const MANAGED_DELIVERY_TOOLS = new Set([
	"delivery_begin",
	...SAFE_CONTROL_TOOLS,
	"delivery_progress_sync",
	"delivery_delegate_readonly",
	"delivery_delegate_worker",
	"delivery_submit_candidate",
	"delivery_validate",
	"delivery_review_candidate",
	"delivery_begin_rework",
	"delivery_finalize",
]);
const PROCESS_BASELINES_KEY = Symbol.for("pi-adaptive-delivery.policy-baselines.v1");

function unique(names: readonly string[]): string[] {
	return [...new Set(names)];
}

function processBaselines(): Map<string, string[]> {
	const store = globalThis as unknown as { [key: symbol]: unknown };
	const existing = store[PROCESS_BASELINES_KEY];
	if (existing instanceof Map) return existing as Map<string, string[]>;
	const created = new Map<string, string[]>();
	store[PROCESS_BASELINES_KEY] = created;
	return created;
}

function resolveActiveTools(
	baseline: readonly string[],
	policy: DeliveryPolicy,
	state?: DeliverySnapshot["state"],
	context?: PolicyContext,
): string[] {
	const active = baseline.filter((name) =>
		READ_TOOLS.has(name) ||
		SAFE_CONTROL_TOOLS.has(name) ||
		(state === "IDLE" && name === "delivery_begin"),
	);
	if (
		(state === "VALIDATING" || state === "BLOCKED") &&
		context?.progressSyncAvailable === true &&
		!context.writerLeaseHeld
	) {
		active.push(...baseline.filter((name) => name === "delivery_progress_sync"));
	}

	if (policy.sourceWrite || policy.writablePaths.length > 0) {
		active.push(...baseline.filter((name) => WRITE_TOOLS.has(name)));
	}
	if (policy.subagentAccess === "readonly") {
		active.push(...baseline.filter((name) => name === "delivery_delegate_readonly"));
	}
	if (policy.subagentAccess === "controlled-writer") {
		active.push(
			...baseline.filter((name) =>
				name === (policy.sourceWrite ? "delivery_submit_candidate" : "delivery_delegate_worker")
			),
		);
	}
	if (policy.subagentAccess === "validation") {
		active.push(
			...baseline.filter(
				(name) =>
					name === "delivery_validate" ||
					name === "delivery_review_candidate" ||
					name === "delivery_begin_rework" ||
					name === "delivery_finalize",
			),
		);
	}

	return unique(active);
}

function requiredTools(policy: DeliveryPolicy): string[] {
	if (policy.subagentAccess === "controlled-writer") {
		return policy.sourceWrite
			? ["edit", "write", "delivery_submit_candidate"]
			: ["delivery_delegate_worker"];
	}
	if (policy.subagentAccess === "validation") {
		return [
			"delivery_validate",
			"delivery_review_candidate",
			"delivery_begin_rework",
			"delivery_finalize",
		];
	}
	return [];
}

export class PolicyController {
	private baselineTools: string[] = [];
	private baselineCaptured = false;
	private authorizedTools = new Set<string>();
	private readonly host: PolicyHost;
	private readonly baselineKey?: string;

	constructor(host: PolicyHost, options: PolicyControllerOptions = {}) {
		this.host = host;
		this.baselineKey = options.baselineKey;
	}

	captureBaseline(): void {
		if (this.baselineCaptured) return;
		const activeTools = unique(this.host.getActiveTools());
		if (!this.baselineKey) {
			this.baselineTools = activeTools;
			this.baselineCaptured = true;
			return;
		}

		const baselines = processBaselines();
		const saved = baselines.get(this.baselineKey);
		this.baselineTools = saved
			? unique([
					...saved,
					...activeTools.filter((name) => MANAGED_DELIVERY_TOOLS.has(name)),
				])
			: activeTools;
		baselines.set(this.baselineKey, [...this.baselineTools]);
		this.baselineCaptured = true;
	}

	forceReadOnly(): ApplyPolicyResult {
		const policy: DeliveryPolicy = {
			readTools: true,
			sourceWrite: false,
			writablePaths: [],
			rawBash: false,
			rawSubagent: false,
			subagentAccess: "none",
			hostCommandAccess: "none",
		};
		const activeTools = resolveActiveTools(this.baselineTools, policy);
		try {
			this.host.setActiveTools(activeTools);
			this.authorizedTools = new Set(activeTools);
			this.host.applySubagentAccess?.("none");
			return { ok: true, policy, activeTools };
		} catch (error) {
			return {
				ok: false,
				policy,
				activeTools,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	apply(snapshot: DeliverySnapshot, context: PolicyContext): ApplyPolicyResult {
		const policy = resolveDeliveryPolicy(snapshot, context);
		const activeTools = resolveActiveTools(this.baselineTools, policy, snapshot.state, context);
		const missingTools = requiredTools(policy).filter((name) => !activeTools.includes(name));
		if (missingTools.length > 0) {
			const fallback = this.forceReadOnly();
			return {
				ok: false,
				policy: fallback.policy,
				activeTools: fallback.activeTools,
				reason: `Required tools are unavailable in the original Pi tool baseline: ${missingTools.join(", ")}`,
			};
		}

		try {
			this.host.setActiveTools(activeTools);
			this.authorizedTools = new Set(activeTools);
			const observed = new Set(this.host.getActiveTools());
			const inactiveTools = requiredTools(policy).filter((name) => !observed.has(name));
			if (inactiveTools.length > 0) {
				throw new Error(`Pi did not activate required tools: ${inactiveTools.join(", ")}`);
			}
			this.host.applySubagentAccess?.(policy.subagentAccess);
			return { ok: true, policy, activeTools };
		} catch (error) {
			const fallback = this.forceReadOnly();
			return {
				ok: false,
				policy: fallback.policy,
				activeTools: fallback.activeTools,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	isToolAuthorized(name: string): boolean {
		return this.authorizedTools.has(name);
	}
}
