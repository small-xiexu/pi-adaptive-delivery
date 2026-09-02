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

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SAFE_CONTROL_TOOLS = new Set(["delivery_begin", "delivery_invalidate", "delivery_progress_sync"]);

function unique(names: readonly string[]): string[] {
	return [...new Set(names)];
}

function resolveActiveTools(baseline: readonly string[], policy: DeliveryPolicy): string[] {
	const active = baseline.filter((name) => READ_TOOLS.has(name) || SAFE_CONTROL_TOOLS.has(name));

	if (policy.sourceWrite || policy.writablePaths.length > 0) {
		active.push(...baseline.filter((name) => WRITE_TOOLS.has(name)));
	}
	if (policy.subagentAccess === "readonly") {
		active.push(...baseline.filter((name) => name === "delivery_delegate_readonly"));
	}
	if (policy.subagentAccess === "controlled-writer") {
		active.push(...baseline.filter((name) => name === "delivery_submit_candidate"));
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

export class PolicyController {
	private baselineTools: string[] = [];
	private readonly host: PolicyHost;

	constructor(host: PolicyHost) {
		this.host = host;
	}

	captureBaseline(): void {
		if (this.baselineTools.length > 0) return;
		this.baselineTools = unique(this.host.getActiveTools());
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
		const activeTools = resolveActiveTools(this.baselineTools, policy);

		try {
			this.host.setActiveTools(activeTools);
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
}
