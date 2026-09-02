import assert from "node:assert/strict";
import test from "node:test";

import { PolicyController, type PolicyHost } from "../../extensions/delivery-gate/src/policy.ts";

class FakePolicyHost implements PolicyHost {
	activeTools = ["read", "grep", "find", "ls", "edit", "write", "bash", "subagent", "bg_wait"];
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

const READ_ONLY_CONTEXT = {
	approvalsValid: false,
	writerLeaseHeld: false,
	writerLeaseOwner: null,
	reworkApproved: false,
} as const;

test("captures baseline and applies state policy to Pi tools", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();

	const shaping = controller.apply({ state: "SHAPING" }, READ_ONLY_CONTEXT);
	assert.equal(shaping.ok, true);
	assert.deepEqual(host.activeTools, ["read", "grep", "find", "ls"]);
	assert.equal(host.access.at(-1), "readonly");
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
	assert.deepEqual(host.activeTools, ["read", "grep", "find", "ls", "edit", "write"]);
	assert.equal(host.access.at(-1), "controlled-writer");
});

test("falls back to read-only when a policy effect fails", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();
	host.failNextSubagent = true;

	const result = controller.apply({ state: "SHAPING" }, READ_ONLY_CONTEXT);

	assert.equal(result.ok, false);
	assert.deepEqual(host.activeTools, ["read", "grep", "find", "ls"]);
	assert.equal(host.access.at(-1), "none");
});

test("forceReadOnly never restores mutation tools", () => {
	const host = new FakePolicyHost();
	const controller = new PolicyController(host);
	controller.captureBaseline();
	host.activeTools = ["read", "edit", "write", "bash", "subagent"];

	const result = controller.forceReadOnly();

	assert.equal(result.ok, true);
	assert.deepEqual(host.activeTools, ["read", "grep", "find", "ls"]);
	assert.equal(host.access.at(-1), "none");
});
