import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";
import { cleanupReviewArtifacts, prepareReview } from "../../extensions/delivery-gate/src/review.ts";

test("审查制品可在交付退出时安全清理", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "review-unit-")));
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	await mkdir(path.join(root, "src"));
	await writeFile(path.join(root, "src/value.js"), "export const value = 1;\n");
	const artifact = await prepareReview({ workspace: await resolveWorkspaceIdentity(root), readPaths: [], writePaths: ["src"], protectedPaths: [] }, { digest: "fixture", files: ["src/value.js"] });
	await access(artifact.diffFile);
	const result = await cleanupReviewArtifacts();
	assert.deepEqual(result.failed, []);
	assert.equal(result.removed, 1);
	await assert.rejects(access(artifact.directory), { code: "ENOENT" });
});
