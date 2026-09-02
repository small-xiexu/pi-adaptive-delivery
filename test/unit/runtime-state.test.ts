import assert from "node:assert/strict";
import test from "node:test";

import {
	DELIVERY_RUNTIME_STATE_VERSION,
	DELIVERY_STATE_CUSTOM_TYPE,
	checkpointRuntimeState,
	createInitialRuntimeState,
	parseRuntimeState,
	restoreRuntimeState,
} from "../../extensions/delivery-gate/src/runtime-state.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

test("creates and checkpoints a versioned runtime state", () => {
	const initial = createInitialRuntimeState(NOW);
	assert.deepEqual(initial, {
		version: DELIVERY_RUNTIME_STATE_VERSION,
		snapshot: { state: "IDLE" },
		updatedAt: NOW.toISOString(),
	});

	const updated = checkpointRuntimeState(
		initial,
		{
			snapshot: { state: "SHAPING" },
			checkpoint: { summary: "Read project rules", changedFiles: [], nextReadyAction: "Draft solution" },
		},
		new Date("2026-01-01T00:01:00.000Z"),
	);
	assert.equal(updated.snapshot.state, "SHAPING");
	assert.equal(updated.checkpoint?.nextReadyAction, "Draft solution");
});

test("restores the latest state from the active branch entries", () => {
	const entries = [
		{ type: "custom", customType: DELIVERY_STATE_CUSTOM_TYPE, data: createInitialRuntimeState(NOW) },
		{
			type: "custom",
			customType: DELIVERY_STATE_CUSTOM_TYPE,
			data: {
				version: 1,
				snapshot: { state: "BLOCKED", resumeState: "VALIDATING" },
				blockingReason: "candidate changed",
				updatedAt: "2026-01-01T00:02:00.000Z",
			},
		},
	];

	const result = restoreRuntimeState(entries, NOW);
	assert.equal(result.ok, true);
	assert.equal(result.state.snapshot.state, "BLOCKED");
	assert.equal(result.state.snapshot.resumeState, "VALIDATING");
	assert.equal(result.state.blockingReason, "candidate changed");
});

test("uses IDLE when the active branch has no delivery state", () => {
	const result = restoreRuntimeState([{ type: "message" }], NOW);
	assert.deepEqual(result, {
		ok: true,
		found: false,
		state: createInitialRuntimeState(NOW),
	});
});

test("fails closed for malformed or unknown persisted state", () => {
	const malformedStates = [
		null,
		{},
		{ version: 2, snapshot: { state: "IDLE" }, updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "UNKNOWN" }, updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "BLOCKED", resumeState: "DELIVERED" }, updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "IDLE" }, updatedAt: "not-a-date" },
		{ version: 1, snapshot: { state: "IDLE" }, checkpoint: { changedFiles: [42] }, updatedAt: NOW.toISOString() },
		{
			version: 1,
			snapshot: { state: "PLANNING" },
			approvals: { solution: { version: 1, kind: "solution" } },
			updatedAt: NOW.toISOString(),
		},
		{ version: 1, snapshot: { state: "VALIDATING" }, validationStatus: "unknown", updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "PLANNING" }, planningDocuments: { version: 1 }, updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "PLANNING" }, proposedDocuments: { requirementName: "x" }, updatedAt: NOW.toISOString() },
	];

	for (const data of malformedStates) {
		const result = parseRuntimeState(data, NOW);
		assert.equal(result.ok, false, JSON.stringify(data));
		assert.equal(result.state.snapshot.state, "BLOCKED");
		assert.ok(result.state.blockingReason);
	}
});
