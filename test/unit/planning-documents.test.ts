import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	assertPlanningDocumentsExist,
	assertSolutionDocumentCurrent,
	digestPlanningDocumentContent,
	documentContainsRequirementName,
	extractPlanningDocumentContent,
	parsePlanningDocumentEvidence,
	parsePlanningDocumentRevisionIntent,
	parseSolutionDocumentEvidence,
	resolvePlanningDocumentRevision,
	stripAdaptiveDeliveryProtocol,
	writePlanDocument,
	writePlanningDocuments,
	writeSolutionDocument,
	type PlanningDocumentRevisionIntent,
} from "../../extensions/delivery-gate/src/planning-documents.ts";

const documents = {
	requirementName: "Canvas写路径拆分",
	solutionPath: "docs/Canvas写路径拆分-技术方案.md",
	planPath: "docs/Canvas写路径拆分-实施计划.md",
	selectionSource: "project",
} as const;

const acknowledgeRevisionIntent = async () => {};

test("matches requirement names across presentation whitespace but not different characters", () => {
	assert.equal(documentContainsRequirementName("# Canvas 节点\n数据契约拆分实施计划", "Canvas节点数据契约拆分"), true);
	assert.equal(documentContainsRequirementName("# Cafe\u0301 delivery", "Café delivery"), true);
	assert.equal(documentContainsRequirementName("# Canvas边数据契约拆分实施计划", "Canvas节点数据契约拆分"), false);
	assert.equal(documentContainsRequirementName("# Canvas点节数据契约拆分实施计划", "Canvas节点数据契约拆分"), false);
});

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
				"```mermaid",
				"sequenceDiagram",
				"  用户->>父Pi: 批准技术方案",
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
	assert.match(solution, /```mermaid\nsequenceDiagram/);
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
	const solutionContent = "# Canvas写路径拆分技术方案\n\n保持 API 行为不变。\n\n```mermaid\nflowchart LR\n  A[旧路径] --> B[新边界]\n```\n";
	const planContent = "# Canvas写路径拆分实施计划\n\n运行聚焦测试。\n";
	const evidence = await writePlanningDocuments({ gitRoot: root, documents, solutionContent, planContent });

	assert.equal(await readFile(path.join(root, documents.solutionPath), "utf8"), solutionContent);
	assert.match(await readFile(path.join(root, documents.solutionPath), "utf8"), /```mermaid\nflowchart LR/);
	assert.equal(await readFile(path.join(root, documents.planPath), "utf8"), planContent);
	assert.equal(evidence.approvedPlanContentDigest, digestPlanningDocumentContent(planContent));
	assert.equal(evidence.planContentDigest, evidence.approvedPlanContentDigest);
	assert.deepEqual(parsePlanningDocumentEvidence(evidence), evidence);
	await assertPlanningDocumentsExist(root, evidence);
	await assert.rejects(
		writePlanningDocuments({ gitRoot: root, documents, solutionContent, planContent }),
		/will not be overwritten/,
	);
});

test("writes the approved solution first and creates only the plan after its evidence is rechecked", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-first-"));
	const solutionContent = "# Canvas 写路径拆分技术方案\n\n保持公开行为不变。\n";
	const planContent = "# Canvas 写路径拆分实施计划\n\n运行固定验证。\n";
	const solutionEvidence = await writeSolutionDocument({ gitRoot: root, documents, solutionContent });

	assert.equal(await readFile(path.join(root, documents.solutionPath), "utf8"), solutionContent);
	await assert.rejects(access(path.join(root, documents.planPath)));
	assert.deepEqual(parseSolutionDocumentEvidence(solutionEvidence), solutionEvidence);
	await assertSolutionDocumentCurrent(root, solutionEvidence);

	const planningEvidence = await writePlanDocument({
		gitRoot: root,
		documents,
		solutionContent,
		planContent,
		solutionEvidence,
	});
	assert.equal(await readFile(path.join(root, documents.planPath), "utf8"), planContent);
	assert.equal(planningEvidence.solutionContentDigest, solutionEvidence.solutionContentDigest);
	assert.deepEqual(parsePlanningDocumentEvidence(planningEvidence), planningEvidence);
});

test("revises only the unchanged package-written solution and rejects content or parent identity drift", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-revise-"));
	const first = "# Canvas写路径拆分技术方案\n\n第一版。\n";
	const second = "# Canvas写路径拆分技术方案\n\n第二版。\n";
	const evidence = await writeSolutionDocument({ gitRoot: root, documents, solutionContent: first });
	const revised = await writeSolutionDocument({
		gitRoot: root,
		documents,
		solutionContent: second,
		previous: evidence,
		onRevisionPrepared: acknowledgeRevisionIntent,
	});
	assert.equal(await readFile(path.join(root, documents.solutionPath), "utf8"), second);
	await assertSolutionDocumentCurrent(root, revised);

	await writeFile(path.join(root, documents.solutionPath), "人工修改\n");
	await assert.rejects(
		writeSolutionDocument({
			gitRoot: root,
			documents,
			solutionContent: first,
			previous: revised,
			onRevisionPrepared: acknowledgeRevisionIntent,
		}),
		/content changed and will not be overwritten/,
	);
	assert.equal(await readFile(path.join(root, documents.solutionPath), "utf8"), "人工修改\n");

	const swapRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-swap-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-swap-outside-"));
	const swapEvidence = await writeSolutionDocument({ gitRoot: swapRoot, documents, solutionContent: first });
	await mkdir(path.join(outside, "docs"));
	const outsideTarget = path.join(outside, documents.solutionPath);
	await writeFile(outsideTarget, first);
	await assert.rejects(
		writeSolutionDocument({
			gitRoot: swapRoot,
			documents,
			solutionContent: second,
			previous: swapEvidence,
			onRevisionPrepared: acknowledgeRevisionIntent,
			afterResolveBeforeOpen: async () => {
				await rename(path.join(swapRoot, "docs"), path.join(swapRoot, "docs-original"));
				await symlink(path.join(outside, "docs"), path.join(swapRoot, "docs"));
			},
		}),
		/identity changed/,
	);
	assert.equal(await readFile(outsideTarget, "utf8"), first);
});

test("rejects same-content file or parent replacement between synchronization and revision", async () => {
	const fileRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-file-identity-"));
	const first = "# Canvas写路径拆分技术方案\n\n第一版。\n";
	const second = "# Canvas写路径拆分技术方案\n\n第二版。\n";
	const fileEvidence = await writeSolutionDocument({ gitRoot: fileRoot, documents, solutionContent: first });
	await rename(path.join(fileRoot, documents.solutionPath), path.join(fileRoot, `${documents.solutionPath}.old`));
	await writeFile(path.join(fileRoot, documents.solutionPath), first);
	await assert.rejects(
		writeSolutionDocument({
			gitRoot: fileRoot,
			documents,
			solutionContent: second,
			previous: fileEvidence,
			onRevisionPrepared: acknowledgeRevisionIntent,
		}),
		/file identity changed/,
	);
	assert.equal(await readFile(path.join(fileRoot, documents.solutionPath), "utf8"), first);

	const parentRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-parent-identity-"));
	const parentEvidence = await writeSolutionDocument({ gitRoot: parentRoot, documents, solutionContent: first });
	await rename(path.join(parentRoot, "docs"), path.join(parentRoot, "docs-old"));
	await mkdir(path.join(parentRoot, "docs"));
	await writeFile(path.join(parentRoot, documents.solutionPath), first);
	await assert.rejects(
		writeSolutionDocument({
			gitRoot: parentRoot,
			documents,
			solutionContent: second,
			previous: parentEvidence,
			onRevisionPrepared: acknowledgeRevisionIntent,
		}),
		/file identity changed|parent identity changed/,
	);
	assert.equal(await readFile(path.join(parentRoot, documents.solutionPath), "utf8"), first);
});

test("keeps the old document intact when atomic replacement fails before rename", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-atomic-"));
	const first = "# Canvas写路径拆分技术方案\n\n第一版。\n";
	const second = "# Canvas写路径拆分技术方案\n\n第二版。\n";
	const evidence = await writeSolutionDocument({ gitRoot: root, documents, solutionContent: first });
	await assert.rejects(
		writeSolutionDocument({
			gitRoot: root,
			documents,
			solutionContent: second,
			previous: evidence,
			onRevisionPrepared: acknowledgeRevisionIntent,
			afterTemporaryWriteBeforeCommit: async () => { throw new Error("injected replacement failure"); },
		}),
		/injected replacement failure/,
	);
	assert.equal(await readFile(path.join(root, documents.solutionPath), "utf8"), first);
	assert.equal((await readdir(path.join(root, "docs"))).some((name) => name.includes("adaptive-delivery")), false);
});

test("resolves a durable revision intent to the complete old or new document after interruption", async () => {
	const first = "# Canvas写路径拆分技术方案\n\n第一版。\n";
	const second = "# Canvas写路径拆分技术方案\n\n第二版。\n";

	const oldRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-intent-old-"));
	const oldEvidence = await writeSolutionDocument({ gitRoot: oldRoot, documents, solutionContent: first });
	let oldIntent: PlanningDocumentRevisionIntent | undefined;
	await assert.rejects(
		writeSolutionDocument({
			gitRoot: oldRoot,
			documents,
			solutionContent: second,
			previous: oldEvidence,
			onRevisionPrepared: async (intent) => {
				oldIntent = intent;
				throw new Error("interrupted after intent persistence");
			},
		}),
		/interrupted after intent persistence/,
	);
	assert.ok(oldIntent);
	assert.deepEqual(parsePlanningDocumentRevisionIntent(oldIntent), oldIntent);
	assert.equal(await resolvePlanningDocumentRevision(oldRoot, oldIntent), "previous");
	assert.equal(await readFile(path.join(oldRoot, documents.solutionPath), "utf8"), first);

	const nextRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-solution-intent-next-"));
	const nextEvidence = await writeSolutionDocument({ gitRoot: nextRoot, documents, solutionContent: first });
	let nextIntent: PlanningDocumentRevisionIntent | undefined;
	await assert.rejects(
		writeSolutionDocument({
			gitRoot: nextRoot,
			documents,
			solutionContent: second,
			previous: nextEvidence,
			onRevisionPrepared: async (intent) => { nextIntent = intent; },
			afterRenameBeforeDirectorySync: async () => { throw new Error("injected directory sync failure"); },
		}),
		/injected directory sync failure/,
	);
	assert.ok(nextIntent);
	assert.deepEqual(parsePlanningDocumentRevisionIntent(nextIntent), nextIntent);
	assert.equal(await resolvePlanningDocumentRevision(nextRoot, nextIntent), "next");
	assert.equal(await readFile(path.join(nextRoot, documents.solutionPath), "utf8"), second);
});

test("revises an unchanged package-written plan in place and rejects manual changes", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-plan-revise-"));
	const solutionContent = "# Canvas写路径拆分技术方案\n\n保持公开行为不变。\n";
	const firstPlan = "# Canvas写路径拆分实施计划\n\n运行第一组固定验证。\n";
	const secondPlan = "# Canvas写路径拆分实施计划\n\n运行修订后的固定验证。\n";
	const first = await writePlanningDocuments({
		gitRoot: root,
		documents,
		solutionContent,
		planContent: firstPlan,
	});
	const solutionEvidence = {
		version: first.version,
		requirementName: first.requirementName,
		solutionPath: first.solutionPath,
		planPath: first.planPath,
		selectionSource: first.selectionSource,
		solutionFileIdentity: first.solutionFileIdentity,
		solutionParentIdentities: first.solutionParentIdentities,
		solutionContentDigest: first.solutionContentDigest,
		syncedAt: first.syncedAt,
	};
	const revised = await writePlanDocument({
		gitRoot: root,
		documents,
		solutionContent,
		planContent: secondPlan,
		solutionEvidence,
		previous: first,
		onRevisionPrepared: acknowledgeRevisionIntent,
	});
	assert.equal(await readFile(path.join(root, documents.planPath), "utf8"), secondPlan);
	assert.equal(revised.planContentDigest, digestPlanningDocumentContent(secondPlan));

	await writeFile(path.join(root, documents.planPath), "人工修改\n");
	await assert.rejects(
		writePlanDocument({
			gitRoot: root,
			documents,
			solutionContent,
			planContent: firstPlan,
			solutionEvidence,
			previous: revised,
			onRevisionPrepared: acknowledgeRevisionIntent,
		}),
		/content changed and will not be overwritten/,
	);
	assert.equal(await readFile(path.join(root, documents.planPath), "utf8"), "人工修改\n");
	await assert.rejects(
		writeSolutionDocument({
			gitRoot: root,
			documents,
			solutionContent: "# Canvas写路径拆分技术方案\n\n修订方案。\n",
			previous: solutionEvidence,
			previousPlanning: revised,
			onRevisionPrepared: acknowledgeRevisionIntent,
		}),
		/Implementation plan document content changed/,
	);
	assert.equal(await readFile(path.join(root, documents.solutionPath), "utf8"), solutionContent);
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
