import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	assertPlanningDocumentsExist,
	extractPlanningDocumentContent,
	parsePlanningDocumentEvidence,
	stripAdaptiveDeliveryProtocol,
	writePlanningDocuments,
} from "../../extensions/delivery-gate/src/planning-documents.ts";

const documents = {
	requirementName: "Canvas写路径拆分",
	solutionPath: "docs/Canvas写路径拆分-技术方案.md",
	planPath: "docs/Canvas写路径拆分-实施计划.md",
	selectionSource: "project",
} as const;

test("extracts exactly one marked solution and plan document", () => {
	const content = [{
		type: "text",
		text: [
			"before",
			"<!-- adaptive-delivery:solution:start -->",
			"# Canvas写路径拆分技术方案",
			"```ts",
			"const value = true;",
			"```",
			"```adaptive-delivery-documents",
			'{"version":1}',
			"```",
			"<!-- adaptive-delivery:solution:end -->",
			"<!-- adaptive-delivery:plan:start -->",
			"# Canvas写路径拆分实施计划",
			"<!-- adaptive-delivery:plan:end -->",
		].join("\n"),
	}];
	const solution = extractPlanningDocumentContent(content, "solution") ?? "";
	assert.match(solution, /const value = true/);
	assert.doesNotMatch(solution, /adaptive-delivery-documents|"version"/);
	assert.match(extractPlanningDocumentContent(content, "plan") ?? "", /实施计划/);
	assert.equal(extractPlanningDocumentContent(`${content[0]!.text}\n${content[0]!.text}`, "solution"), undefined);
});

test("hides complete and streaming protocol blocks without changing ordinary Markdown", () => {
	const complete = [
		"<!-- adaptive-delivery:solution:start -->",
		"# 可见方案",
		"```adaptive-delivery-documents",
		'{"version":1}',
		"```",
		"<!-- adaptive-delivery:solution:end -->",
		"正文",
	].join("\n");
	assert.equal(stripAdaptiveDeliveryProtocol(complete), "# 可见方案\n\n正文");
	assert.equal(
		stripAdaptiveDeliveryProtocol("# 可见计划\n```adaptive-delivery-plan\n{\"version\":"),
		"# 可见计划",
	);
	assert.equal(stripAdaptiveDeliveryProtocol("# 普通 Markdown\n\n正文"), "# 普通 Markdown\n\n正文");
});

test("creates two requirement-named Markdown documents and records evidence", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-planning-docs-"));
	const solutionContent = "# Canvas写路径拆分技术方案\n\n保持 API 行为不变。\n";
	const planContent = "# Canvas写路径拆分实施计划\n\n运行聚焦测试。\n";
	const evidence = await writePlanningDocuments({ gitRoot: root, documents, solutionContent, planContent });

	assert.equal(await readFile(path.join(root, documents.solutionPath), "utf8"), solutionContent);
	assert.equal(await readFile(path.join(root, documents.planPath), "utf8"), planContent);
	assert.deepEqual(parsePlanningDocumentEvidence(evidence), evidence);
	await assertPlanningDocumentsExist(root, evidence);
	await assert.rejects(
		writePlanningDocuments({ gitRoot: root, documents, solutionContent, planContent }),
		/will not be overwritten/,
	);
});

test("rejects traversal, symlink parents, and a pre-existing second target without partial creation", async () => {
	const traversalRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-planning-traversal-"));
	await assert.rejects(
		writePlanningDocuments({
			gitRoot: traversalRoot,
			documents: { ...documents, solutionPath: "../Canvas写路径拆分-技术方案.md" },
			solutionContent: "Canvas写路径拆分 solution",
			planContent: "Canvas写路径拆分 plan",
		}),
		/Invalid planning document path/,
	);

	const symlinkRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-planning-symlink-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "adaptive-planning-outside-"));
	await symlink(outside, path.join(symlinkRoot, "docs"));
	await assert.rejects(
		writePlanningDocuments({
			gitRoot: symlinkRoot,
			documents,
			solutionContent: "Canvas写路径拆分 solution",
			planContent: "Canvas写路径拆分 plan",
		}),
		/not a regular directory/,
	);
	await assert.rejects(access(path.join(outside, path.basename(documents.solutionPath))));

	const collisionRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-planning-collision-"));
	await mkdir(path.join(collisionRoot, "docs"));
	await writeFile(path.join(collisionRoot, documents.planPath), "existing\n");
	await assert.rejects(
		writePlanningDocuments({
			gitRoot: collisionRoot,
			documents,
			solutionContent: "Canvas写路径拆分 solution",
			planContent: "Canvas写路径拆分 plan",
		}),
		/will not be overwritten/,
	);
	await assert.rejects(access(path.join(collisionRoot, documents.solutionPath)));
});

test("does not write document content when a parent becomes a symlink before open", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-planning-parent-swap-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "adaptive-planning-parent-outside-"));
	await mkdir(path.join(root, "docs"));
	await assert.rejects(
		writePlanningDocuments({
			gitRoot: root,
			documents,
			solutionContent: "Canvas写路径拆分 solution",
			planContent: "Canvas写路径拆分 plan",
			afterResolveBeforeOpen: async () => {
				await rename(path.join(root, "docs"), path.join(root, "docs-original"));
				await symlink(outside, path.join(root, "docs"));
			},
		}),
		/parent identity changed|target identity changed/,
	);
	await assert.rejects(access(path.join(outside, path.basename(documents.solutionPath))));
	await assert.rejects(access(path.join(outside, path.basename(documents.planPath))));
});
