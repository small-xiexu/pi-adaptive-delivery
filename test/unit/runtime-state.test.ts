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

	const infrastructureFailure = parseRuntimeState({
		version: 1,
		snapshot: { state: "BLOCKED", resumeState: "VALIDATING" },
		validationStatus: "failed",
		validationFailureKind: "infrastructure",
		updatedAt: "2026-01-01T00:03:00.000Z",
	}, NOW);
	assert.equal(infrastructureFailure.ok, true);
	assert.equal(infrastructureFailure.state.validationFailureKind, "infrastructure");

	const passedValidation = parseRuntimeState({
		version: 1,
		snapshot: { state: "VALIDATING" },
		candidateDigest: "b".repeat(64),
		validationRunId: "validation-batch",
		validationStatus: "passed",
		validationEvidence: {
			candidateDigest: "b".repeat(64),
			runId: "validation-batch",
			outcome: "passed",
			commands: [{ id: "unit", status: "passed", durationMs: 25, exitCode: 0 }],
			completedAt: "2026-01-01T00:03:30.000Z",
		},
		updatedAt: "2026-01-01T00:03:30.000Z",
	}, NOW);
	assert.equal(passedValidation.ok, true);
	assert.equal(passedValidation.state.validationEvidence?.commands[0]?.status, "passed");

	const runningWorker = parseRuntimeState({
		version: 1,
		snapshot: { state: "IMPLEMENTING" },
		workerRunId: "worker-run",
		workerStatus: "running",
		workerLaunchContractDigest: "a".repeat(64),
		updatedAt: "2026-01-01T00:04:00.000Z",
	}, NOW);
	assert.equal(runningWorker.ok, true);
	assert.equal(runningWorker.state.workerStatus, "running");

	const synchronizedSolution = parseRuntimeState({
		version: 1,
		snapshot: { state: "PLANNING" },
		solutionDocument: {
			version: 1,
			requirementName: "Canvas写路径拆分",
			solutionPath: "docs/Canvas写路径拆分-技术方案.md",
			planPath: "docs/Canvas写路径拆分-实施计划.md",
			selectionSource: "project",
			solutionContentDigest: "c".repeat(64),
			syncedAt: NOW.toISOString(),
		},
		updatedAt: NOW.toISOString(),
	}, NOW);
	assert.equal(synchronizedSolution.ok, true);
	assert.equal(synchronizedSolution.state.solutionDocument?.solutionPath, "docs/Canvas写路径拆分-技术方案.md");
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
		{
			version: 1,
			snapshot: { state: "VALIDATING" },
			candidateDigest: "b".repeat(64),
			validationRunId: "validation-batch",
			validationStatus: "failed",
			validationFailureKind: "infrastructure",
			validationEvidence: {
				candidateDigest: "b".repeat(64),
				runId: "validation-batch",
				outcome: "failed",
				commands: [{ id: "unit", status: "failed", durationMs: 1, exitCode: 1 }],
				completedAt: NOW.toISOString(),
			},
			updatedAt: NOW.toISOString(),
		},
		{ version: 1, snapshot: { state: "VALIDATING" }, validationStatus: "unknown", updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "VALIDATING" }, validationStatus: "failed", validationFailureKind: "unknown", updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "VALIDATING" }, validationStatus: "pending", validationFailureKind: "candidate", updatedAt: NOW.toISOString() },
		{
			version: 1,
			snapshot: { state: "VALIDATING" },
			candidateDigest: "b".repeat(64),
			validationRunId: "validation-batch",
			validationStatus: "passed",
			validationEvidence: {
				candidateDigest: "b".repeat(64),
				runId: "other-batch",
				outcome: "passed",
				commands: [{ id: "unit", status: "passed", durationMs: 1 }],
				completedAt: NOW.toISOString(),
			},
			updatedAt: NOW.toISOString(),
		},
		{
			version: 1,
			snapshot: { state: "VALIDATING" },
			candidateDigest: "b".repeat(64),
			validationRunId: "validation-batch",
			validationStatus: "passed",
			validationEvidence: {
				candidateDigest: "b".repeat(64),
				runId: "validation-batch",
				outcome: "passed",
				commands: [{ id: "unit", status: "failed", durationMs: 1 }],
				completedAt: NOW.toISOString(),
			},
			updatedAt: NOW.toISOString(),
		},
		{ version: 1, snapshot: { state: "IMPLEMENTING" }, workerStatus: "running", updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "IMPLEMENTING" }, workerStatus: "unknown", updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "IMPLEMENTING" }, workerLaunchContractDigest: "bad", updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "PLANNING" }, planningDocuments: { version: 1 }, updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "PLANNING" }, solutionDocument: { version: 1 }, updatedAt: NOW.toISOString() },
		{ version: 1, snapshot: { state: "PLANNING" }, proposedDocuments: { requirementName: "x" }, updatedAt: NOW.toISOString() },
	];

	for (const data of malformedStates) {
		const result = parseRuntimeState(data, NOW);
		assert.equal(result.ok, false, JSON.stringify(data));
		assert.equal(result.state.snapshot.state, "BLOCKED");
		assert.ok(result.state.blockingReason);
	}
});
