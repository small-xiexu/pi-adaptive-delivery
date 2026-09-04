import assert from "node:assert/strict";
import test from "node:test";

import {
	parseTinyContractFromContent,
	parseTinyContractValue,
} from "../../extensions/delivery-gate/src/tiny-contract.ts";

const valid = {
	version: 1,
	intent: "Change the Settings modal Cancel label to Close.",
	nonGoals: ["No state behavior changes", "No API or dependency changes"],
	changeScope: ["src/components/SettingsModal.tsx", "src/components/SettingsModal.test.tsx"],
	validation: [{ id: "settings-test", command: "npm test -- SettingsModal", timeoutMs: 120000 }],
	review: "none",
	eligibility: {
		risk: "low",
		uncertainty: "low",
		userOutcomeClear: true,
		productOrArchitectureDecision: false,
		reversibleWorkspaceOnly: true,
		sharedContractChange: false,
		highRiskDomain: false,
		externalSideEffect: false,
		dependencyOrToolchainChange: false,
		focusedDeterministicValidation: true,
	},
} as const;

test("parses one strict Tiny delivery contract", () => {
	assert.deepEqual(parseTinyContractValue(valid), valid);
	const content = `Tiny\n\n\`\`\`adaptive-delivery-tiny\n${JSON.stringify(valid)}\n\`\`\``;
	assert.deepEqual(parseTinyContractFromContent(content), valid);
	assert.equal(parseTinyContractFromContent(`${content}\n${content}`), undefined);
});

test("rejects unknown fields, empty or duplicate scope, and malformed validation", () => {
	assert.equal(parseTinyContractValue({ ...valid, extra: true }), undefined);
	assert.equal(parseTinyContractValue({ ...valid, changeScope: [] }), undefined);
	assert.equal(parseTinyContractValue({ ...valid, changeScope: [valid.changeScope[0], valid.changeScope[0]] }), undefined);
	assert.equal(parseTinyContractValue({ ...valid, validation: [{ id: "bad id", command: "test", timeoutMs: 1000 }] }), undefined);
	assert.equal(parseTinyContractValue({
		...valid,
		validation: [{
			...valid.validation[0],
			repairCommand: "npm run format",
			repairTimeoutMs: 120000,
		}],
	}), undefined);
	assert.equal(parseTinyContractValue({ ...valid, validation: [] }), undefined);
});

test("rejects absolute, escaping, malformed, and control-plane scope paths", () => {
	for (const scope of [
		["/tmp/file.ts"],
		["../file.ts"],
		["src/../file.ts"],
		["src\\file.ts"],
		["src//file.ts"],
		[".git/config"],
		["node_modules/pkg/index.js"],
	]) {
		assert.equal(parseTinyContractValue({ ...valid, changeScope: scope }), undefined, scope[0]);
	}
});

test("requires every low-risk eligibility declaration and no review", () => {
	assert.equal(parseTinyContractValue({ ...valid, eligibility: { ...valid.eligibility, risk: "high" } }), undefined);
	assert.equal(parseTinyContractValue({ ...valid, eligibility: { ...valid.eligibility, highRiskDomain: true } }), undefined);
	assert.equal(parseTinyContractValue({ ...valid, eligibility: { ...valid.eligibility, sharedContractChange: true } }), undefined);
	assert.equal(parseTinyContractValue({ ...valid, eligibility: { ...valid.eligibility, dependencyOrToolchainChange: true } }), undefined);
	assert.equal(parseTinyContractValue({ ...valid, review: "required" }), undefined);
});
