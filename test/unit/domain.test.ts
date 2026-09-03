import assert from "node:assert/strict";
import test from "node:test";

import {
	DELIVERY_STATES,
	formatDeliveryState,
	parseDeliveryState,
	resolveDeliveryPolicy,
	transitionDelivery,
	type DeliverySnapshot,
	type DeliveryState,
	type PolicyContext,
} from "../../extensions/delivery-gate/src/domain.ts";

const BASE_CONTEXT: PolicyContext = {
	approvalsValid: false,
	writerLeaseHeld: false,
	writerLeaseOwner: null,
	reworkApproved: false,
};

test("keeps stable English states with Chinese display labels", () => {
	assert.equal(DELIVERY_STATES.length, 12);
	assert.equal(formatDeliveryState("SHAPING"), "方案梳理中 [SHAPING]");
	assert.equal(formatDeliveryState("DELIVERED"), "已交付 [DELIVERED]");
	assert.equal(parseDeliveryState("VALIDATING"), "VALIDATING");
	assert.equal(parseDeliveryState("验证中"), undefined);
	assert.equal(parseDeliveryState({ state: "VALIDATING" }), undefined);
});

test("supports the standard approval path", () => {
	const events = [
		"START",
		"SUBMIT_SOLUTION",
		"APPROVE_SOLUTION",
		"SUBMIT_PLAN",
		"APPROVE_PLAN",
		"BEGIN_VALIDATION",
		"DELIVER",
	] as const;
	let snapshot: DeliverySnapshot = { state: "IDLE" };

	for (const type of events) {
		const result = transitionDelivery(snapshot, { type });
		assert.equal(result.ok, true, `${snapshot.state} should accept ${type}`);
		if (result.ok) snapshot = result.snapshot;
	}

	assert.deepEqual(snapshot, { state: "DELIVERED" });
});

test("supports the compact approval and rework paths", () => {
	let snapshot: DeliverySnapshot = { state: "SHAPING" };

	for (const type of [
		"SUBMIT_COMBINED",
		"APPROVE_COMBINED",
		"BEGIN_VALIDATION",
		"BEGIN_REWORK",
		"FINISH_REWORK",
		"DELIVER",
	] as const) {
		const result = transitionDelivery(snapshot, { type });
		assert.equal(result.ok, true, `${snapshot.state} should accept ${type}`);
		if (result.ok) snapshot = result.snapshot;
	}

	assert.equal(snapshot.state, "DELIVERED");
});

test("stores and restores the source state when blocked", () => {
	const blocked = transitionDelivery({ state: "VALIDATING" }, { type: "BLOCK" });
	assert.deepEqual(blocked, {
		ok: true,
		snapshot: { state: "BLOCKED", resumeState: "VALIDATING" },
	});

	if (!blocked.ok) assert.fail("blocking should succeed");
	const resumed = transitionDelivery(blocked.snapshot, { type: "RESUME" });
	assert.deepEqual(resumed, { ok: true, snapshot: { state: "VALIDATING" } });

	const missingResume = transitionDelivery({ state: "BLOCKED" }, { type: "RESUME" });
	assert.equal(missingResume.ok, false);

	for (const state of ["IDLE", "DELIVERED", "CANCELLED"] as const) {
		const result = transitionDelivery({ state }, { type: "BLOCK" });
		assert.equal(result.ok, false, state);
	}
});

test("rejects illegal transitions without changing state", () => {
	const snapshot: DeliverySnapshot = { state: "IDLE" };
	const result = transitionDelivery(snapshot, { type: "APPROVE_PLAN" });

	assert.equal(result.ok, false);
	assert.deepEqual(result.snapshot, snapshot);
	assert.equal(transitionDelivery(snapshot, { type: "REVISE_PLAN" }).ok, false);
	assert.equal(transitionDelivery(snapshot, { type: "REVISE_SOLUTION" }).ok, false);
});

test("only writer states with proven authorization and lease can write source files", () => {
	const writerContext: PolicyContext = {
		approvalsValid: true,
		writerLeaseHeld: true,
		writerLeaseOwner: "child",
		reworkApproved: true,
	};

	for (const state of DELIVERY_STATES) {
		const policy = resolveDeliveryPolicy({ state }, writerContext);
		const expected = state === "IMPLEMENTING" || state === "REWORKING";
		assert.equal(policy.sourceWrite, expected, state);
		assert.equal(policy.rawBash, false, state);
		assert.equal(policy.rawSubagent, false, state);
	}
});

test("standard and high-risk implementation routes reserve source writes for one worker", () => {
	const policy = resolveDeliveryPolicy(
		{ state: "IMPLEMENTING" },
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "parent",
			reworkApproved: false,
			implementationWriter: "worker",
		},
	);

	assert.equal(policy.sourceWrite, false);
	assert.equal(policy.subagentAccess, "controlled-writer");
});

test("projects Tiny exact scope into the parent writer policy", () => {
	const policy = resolveDeliveryPolicy(
		{ state: "IMPLEMENTING" },
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "parent",
			reworkApproved: false,
			implementationWriter: "parent",
			tinyWritablePaths: ["src/label.ts", "src/label.test.ts"],
		},
	);
	assert.equal(policy.sourceWrite, true);
	assert.deepEqual(policy.writablePaths, ["src/label.ts", "src/label.test.ts"]);
});

test("keeps writer states read-only when authorization or lease is missing", () => {
	for (const state of ["IMPLEMENTING", "REWORKING"] as const) {
		const policy = resolveDeliveryPolicy({ state }, BASE_CONTEXT);
		assert.equal(policy.sourceWrite, false);
		assert.match(policy.reason ?? "", /not proven/);
	}
});

test("uses state-specific read-only delegation", () => {
	const expected: Partial<Record<DeliveryState, string>> = {
		SHAPING: "readonly",
		SOLUTION_PENDING_APPROVAL: "readonly",
		PLANNING: "readonly",
		PLAN_PENDING_APPROVAL: "readonly",
		COMBINED_PENDING_APPROVAL: "readonly",
		VALIDATING: "validation",
		BLOCKED: "readonly",
	};

	for (const state of DELIVERY_STATES) {
		const policy = resolveDeliveryPolicy({ state }, BASE_CONTEXT);
		assert.equal(policy.subagentAccess, expected[state] ?? "none", state);
	}
});

test("progress-sync opens only one proven target and fixed checks", () => {
	const targetPath = "/repo/docs/plan.md";
	const policy = resolveDeliveryPolicy(
		{ state: "VALIDATING" },
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "parent",
			reworkApproved: false,
			progressSync: {
				active: true,
				writerFree: true,
				targetPath,
				targetPathProven: true,
			},
		},
	);

	assert.equal(policy.sourceWrite, false);
	assert.deepEqual(policy.writablePaths, [targetPath]);
	assert.equal(policy.hostCommandAccess, "fixed-progress-check");
	assert.equal(policy.rawBash, false);
	assert.equal(policy.rawSubagent, false);
});

test("progress-sync fails closed when any prerequisite is missing", () => {
	const incompleteContexts: PolicyContext[] = [
		{
			...BASE_CONTEXT,
			progressSync: { active: true, writerFree: true, targetPath: "/repo/plan.md", targetPathProven: true },
		},
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "child",
			reworkApproved: false,
			progressSync: { active: true, writerFree: true, targetPath: "/repo/plan.md", targetPathProven: true },
		},
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "parent",
			reworkApproved: false,
			progressSync: { active: true, writerFree: true, targetPath: "/repo/plan.md", targetPathProven: false },
		},
	];

	for (const context of incompleteContexts) {
		const policy = resolveDeliveryPolicy({ state: "VALIDATING" }, context);
		assert.equal(policy.sourceWrite, false);
		assert.deepEqual(policy.writablePaths, []);
		assert.equal(policy.rawBash, false);
		assert.equal(policy.rawSubagent, false);
		assert.match(policy.reason ?? "", /not proven/);
	}
});
