import assert from "node:assert/strict";
import test from "node:test";

import {
	parsePlanContractFromContent,
	parsePlanContractValue,
	parsePlanningDocumentsFromContent,
	selectDeliveryRoute,
} from "../../extensions/delivery-gate/src/plan-contract.ts";

const valid = {
	version: 2,
	risk: "medium",
	complexity: "medium",
	uncertainty: "low",
	documents: {
		requirementName: "避免重复扣款",
		solutionPath: "docs/避免重复扣款-技术方案.md",
		planPath: "docs/避免重复扣款-实施计划.md",
		selectionSource: "user",
	},
	validation: [
		{ id: "typecheck", command: "npm run typecheck", timeoutMs: 120000 },
		{ id: "unit", command: "npm test", timeoutMs: 120000 },
	],
	progressTargets: ["docs/避免重复扣款-实施计划.md"],
	progressChecks: [{ id: "diff-check", command: "git", args: ["diff", "--check"], timeoutMs: 30000 }],
} as const;

test("parses one strict plan contract fence", () => {
	const content = [
		{ type: "text", text: `Plan\n\n\`\`\`adaptive-delivery-plan\n${JSON.stringify(valid)}\n\`\`\`` },
	];
	assert.deepEqual(parsePlanContractFromContent(content), valid);
	assert.equal(parsePlanContractFromContent("no contract"), undefined);
	assert.equal(parsePlanContractFromContent(`${content[0]!.text}\n${content[0]!.text}`), undefined);
});

test("parses one versioned planning document target fence", () => {
	const content = `\`\`\`adaptive-delivery-documents\n${JSON.stringify({ version: 1, ...valid.documents })}\n\`\`\``;
	assert.deepEqual(parsePlanningDocumentsFromContent(content), valid.documents);
	assert.equal(parsePlanningDocumentsFromContent(content.replace('"version":1', '"version":2')), undefined);
	assert.equal(parsePlanningDocumentsFromContent(`${content}\n${content}`), undefined);
});

test("rejects unknown fields, duplicate validation ids, and unsafe bounds", () => {
	assert.equal(parsePlanContractValue({ ...valid, extra: true }), undefined);
	assert.equal(
		parsePlanContractValue({ ...valid, validation: [valid.validation[0], valid.validation[0]] }),
		undefined,
	);
	assert.equal(
		parsePlanContractValue({ ...valid, validation: [{ id: "bad id", command: "test", timeoutMs: 1000 }] }),
		undefined,
	);
	assert.equal(
		parsePlanContractValue({ ...valid, validation: [{ id: "test", command: "test", timeoutMs: 999 }] }),
		undefined,
	);
	assert.equal(parsePlanContractValue({ ...valid, progressTargets: [] }), undefined);
	assert.equal(
		parsePlanContractValue({
			...valid,
			documents: { ...valid.documents, solutionPath: valid.documents.planPath },
		}),
		undefined,
	);
	assert.equal(
		parsePlanContractValue({
			...valid,
			documents: { ...valid.documents, planPath: "docs/通用实施计划.md" },
			progressTargets: ["docs/通用实施计划.md"],
		}),
		undefined,
	);
});

test("selects routes with risk and uncertainty taking precedence", () => {
	assert.equal(selectDeliveryRoute({ ...valid, complexity: "small", risk: "low", uncertainty: "low" }), "single");
	assert.equal(selectDeliveryRoute(valid), "standard");
	assert.equal(selectDeliveryRoute({ ...valid, complexity: "small", risk: "high" }), "high-risk");
	assert.equal(selectDeliveryRoute({ ...valid, complexity: "small", risk: "low", uncertainty: "high" }), "high-risk");
});
