import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PolicyController, type PolicyHost } from "../../extensions/delivery-gate/src/policy.ts";

class FakePolicyHost implements PolicyHost {
	activeTools = [
		"read",
		"grep",
		"find",
		"ls",
		"edit",
		"write",
		"bash",
		"subagent",
		"bg_wait",
		"delivery_runtime_status",
		"delivery_begin",
		"delivery_delegate_readonly",
		"delivery_delegate_worker",
		"delivery_submit_candidate",
		"delivery_validate",
		"delivery_review_candidate",
		"delivery_begin_rework",
		"delivery_finalize",
		"delivery_progress_sync",
		"delivery_invalidate",
	];
	failNextTools = false;
	failNextSubagent = false;
	access: string[] = [];

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	setActiveTools(names: string[]): void {
		if (this.failNextTools) {
			this.failNextTools = false;
			throw new Error("setActiveTools failed");
		}
		this.activeTools = [...names];
	}

	applySubagentAccess(access: "none" | "readonly" | "validation" | "controlled-writer"): void {
		if (this.failNextSubagent) {
			this.failNextSubagent = false;
			throw new Error("ceiling failed");
		}
		this.access.push(access);
	}
}

const BASE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"delivery_runtime_status",
	"delivery_invalidate",
];
const IDLE_TOOLS = [...BASE_TOOLS.slice(0, 5), "delivery_begin", ...BASE_TOOLS.slice(5)];
const READONLY_TOOLS = [...BASE_TOOLS, "delivery_delegate_readonly"];
const WRITER_TOOLS = [...BASE_TOOLS, "edit", "write", "delivery_submit_candidate"];
const DELEGATED_WRITER_TOOLS = [...BASE_TOOLS, "delivery_delegate_worker"];
const VALIDATION_TOOLS = [
	...BASE_TOOLS,
	"delivery_progress_sync",
	"delivery_validate",
	"delivery_review_candidate",
	"delivery_begin_rework",
	"delivery_finalize",
];

const READ_ONLY_CONTEXT = {
	approvalsValid: false,
	writerLeaseHeld: false,
	writerLeaseOwner: null,
	reworkApproved: false,
	progressSyncAvailable: false,
} as const;

const PROGRESS_SYNC_CONTEXT = {
	...READ_ONLY_CONTEXT,
	progressSyncAvailable: true,
} as const;

test("captures baseline and applies state policy to Pi tools", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();

	const shaping = controller.apply({ state: "SHAPING" }, READ_ONLY_CONTEXT);
	assert.equal(shaping.ok, true);
	assert.deepEqual(host.activeTools, READONLY_TOOLS);
	assert.equal(host.access.at(-1), "readonly");
	assert.equal(controller.isToolAuthorized("read"), true);
	assert.equal(controller.isToolAuthorized("edit"), false);
	assert.equal(controller.isToolAuthorized("late_dynamic_write"), false);
});

test("exposes delivery_begin only while the runtime is IDLE", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();

	assert.equal(controller.apply({ state: "IDLE" }, READ_ONLY_CONTEXT).ok, true);
	assert.deepEqual(host.activeTools, IDLE_TOOLS);
	assert.equal(controller.apply({ state: "VALIDATING" }, READ_ONLY_CONTEXT).ok, true);
	assert.equal(host.activeTools.includes("delivery_begin"), false);
});

test("exposes progress sync only in writer-free validation and blocked states", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();

	for (const state of ["SHAPING", "PLANNING", "IMPLEMENTING", "REWORKING"] as const) {
		const context = state === "IMPLEMENTING" || state === "REWORKING"
			? {
					approvalsValid: true,
					writerLeaseHeld: true,
					writerLeaseOwner: "parent" as const,
					reworkApproved: state === "REWORKING",
				}
			: READ_ONLY_CONTEXT;
		assert.equal(controller.apply({ state }, context).ok, true);
		assert.equal(host.activeTools.includes("delivery_progress_sync"), false, state);
	}

	assert.equal(controller.apply({ state: "VALIDATING" }, PROGRESS_SYNC_CONTEXT).ok, true);
	assert.deepEqual(host.activeTools, VALIDATION_TOOLS);
	assert.equal(controller.apply({ state: "BLOCKED", resumeState: "VALIDATING" }, PROGRESS_SYNC_CONTEXT).ok, true);
	assert.equal(host.activeTools.includes("delivery_progress_sync"), true);
	assert.equal(controller.apply(
		{ state: "BLOCKED", resumeState: "VALIDATING" },
		{ ...PROGRESS_SYNC_CONTEXT, writerLeaseHeld: true, writerLeaseOwner: "parent" },
	).ok, true);
	assert.equal(host.activeTools.includes("delivery_progress_sync"), false);
	controller.forceReadOnly();
	assert.equal(host.activeTools.includes("delivery_progress_sync"), false);
});

test("applies writer tools only when policy preconditions are proven", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();

	const result = controller.apply(
		{ state: "IMPLEMENTING" },
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "parent",
			reworkApproved: false,
		},
	);

	assert.equal(result.ok, true);
	assert.deepEqual(host.activeTools, WRITER_TOOLS);
	assert.equal(host.access.at(-1), "controlled-writer");
	assert.equal(controller.isToolAuthorized("edit"), true);
});

test("worker implementation route removes parent mutation tools", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();

	const result = controller.apply(
		{ state: "IMPLEMENTING" },
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "parent",
			reworkApproved: false,
			implementationWriter: "worker",
		},
	);

	assert.equal(result.ok, true);
	assert.deepEqual(host.activeTools, DELEGATED_WRITER_TOOLS);
	assert.equal(host.access.at(-1), "controlled-writer");
});

test("falls back to read-only when a policy effect fails", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();
	host.failNextSubagent = true;

	const result = controller.apply({ state: "SHAPING" }, READ_ONLY_CONTEXT);

	assert.equal(result.ok, false);
	assert.deepEqual(host.activeTools, BASE_TOOLS);
	assert.equal(host.access.at(-1), "none");
});

test("forceReadOnly never restores mutation tools", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();
	host.activeTools = ["read", "edit", "write", "bash", "subagent"];

	const result = controller.forceReadOnly();

	assert.equal(result.ok, true);
	assert.deepEqual(host.activeTools, BASE_TOOLS);
	assert.equal(host.access.at(-1), "none");
});

test("restores the original built-in tool baseline across same-process reload", () => {
	const baselineKey = `policy-reload-${randomUUID()}`;
	const firstHost = new FakePolicyHost();
	const first = new PolicyController(firstHost, { baselineKey });
	first.captureBaseline();
	first.forceReadOnly();

	const secondHost = new FakePolicyHost();
	secondHost.activeTools = [
		...firstHost.activeTools,
		"delivery_delegate_readonly",
		"delivery_delegate_worker",
		"delivery_submit_candidate",
		"delivery_validate",
		"delivery_review_candidate",
		"delivery_begin_rework",
		"delivery_finalize",
	];
	const second = new PolicyController(secondHost, { baselineKey });
	second.captureBaseline();
	const result = second.apply(
		{ state: "IMPLEMENTING" },
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "parent",
			reworkApproved: false,
		},
	);

	assert.equal(result.ok, true);
	assert.deepEqual(secondHost.activeTools, WRITER_TOOLS);
});

test("fails closed when the original Pi baseline lacks current-stage tools", () => {
	const host = new FakePolicyHost();
	host.activeTools = host.activeTools.filter((name) => name !== "edit" && name !== "write");
	const controller = new PolicyController(host, { baselineKey: `policy-disabled-${randomUUID()}` });
	controller.captureBaseline();

	const result = controller.apply(
		{ state: "IMPLEMENTING" },
		{
			approvalsValid: true,
			writerLeaseHeld: true,
			writerLeaseOwner: "parent",
			reworkApproved: false,
		},
	);

	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /edit, write/);
	assert.deepEqual(host.activeTools, BASE_TOOLS);
});
