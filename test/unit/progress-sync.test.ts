import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	resolveProgressTarget,
	syncProjectProgress,
} from "../../extensions/delivery-gate/src/progress-sync.ts";

async function progressFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "adaptive-progress-root-"));
	await mkdir(path.join(root, "docs"));
	const target = path.join(root, "docs", "plan.md");
	await writeFile(target, "Status: pending\n");
	return { root, target, relative: "docs/plan.md" };
}

test("updates one exact approved progress target and runs fixed argv checks", async () => {
	const fixture = await progressFixture();
	const calls: unknown[] = [];
	const result = await syncProjectProgress({
		gitRoot: fixture.root,
		approvedTargets: [fixture.relative],
		target: fixture.relative,
		oldText: "Status: pending",
		newText: "Status: complete",
		checks: [{ id: "diff", command: "git", args: ["diff", "--check"], timeoutMs: 30000 }],
		runCheck: async (check) => {
			calls.push(check);
			return { code: 0, stdout: "", stderr: "" };
		},
	});

	assert.equal(await readFile(fixture.target, "utf8"), "Status: complete\n");
	assert.equal(result.target, fixture.relative);
	assert.match(result.digest, /^[a-f0-9]{64}$/);
	assert.deepEqual(result.checks, [{ id: "diff", code: 0 }]);
	assert.equal(calls.length, 1);
});

test("rejects traversal, absolute, unapproved, and directory targets", async () => {
	const fixture = await progressFixture();
	await assert.rejects(resolveProgressTarget(fixture.root, [fixture.relative], "../outside.md"), /escapes/);
	await assert.rejects(resolveProgressTarget(fixture.root, [fixture.relative], "/tmp/outside.md"), /relative/);
	await assert.rejects(resolveProgressTarget(fixture.root, [fixture.relative], "docs/other.md"), /not approved/);
	await assert.rejects(resolveProgressTarget(fixture.root, ["docs"], "docs"), /regular file/);
});

test("rejects symlink target and parent components", async () => {
	const fixture = await progressFixture();
	const outside = await mkdtemp(path.join(os.tmpdir(), "adaptive-progress-outside-"));
	await writeFile(path.join(outside, "outside.md"), "outside\n");
	await symlink(path.join(outside, "outside.md"), path.join(fixture.root, "docs", "linked.md"));
	await symlink(outside, path.join(fixture.root, "linked-parent"));

	await assert.rejects(
		resolveProgressTarget(fixture.root, ["docs/linked.md"], "docs/linked.md"),
		/symlink component/,
	);
	await assert.rejects(
		resolveProgressTarget(fixture.root, ["linked-parent/outside.md"], "linked-parent/outside.md"),
		/symlink component/,
	);
});

test("detects a symlink swap between validation and open", async () => {
	const fixture = await progressFixture();
	const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "adaptive-progress-swap-")), "outside.md");
	await writeFile(outside, "outside\n");
	await assert.rejects(
		syncProjectProgress({
			gitRoot: fixture.root,
			approvedTargets: [fixture.relative],
			target: fixture.relative,
			oldText: "Status: pending",
			newText: "Status: complete",
			checks: [],
			runCheck: async () => ({ code: 0, stdout: "", stderr: "" }),
			beforeOpen: async () => {
				await rename(fixture.target, `${fixture.target}.backup`);
				await symlink(outside, fixture.target);
			},
		}),
		/symlink component|changed during validation/,
	);
	assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("detects a parent symlink swap after final path recheck and before open", async () => {
	const fixture = await progressFixture();
	const outsideDir = await mkdtemp(path.join(os.tmpdir(), "adaptive-progress-parent-swap-"));
	const outside = path.join(outsideDir, "plan.md");
	await writeFile(outside, "outside\n");
	await assert.rejects(
		syncProjectProgress({
			gitRoot: fixture.root,
			approvedTargets: [fixture.relative],
			target: fixture.relative,
			oldText: "Status: pending",
			newText: "Status: complete",
			checks: [],
			runCheck: async () => ({ code: 0, stdout: "", stderr: "" }),
			afterRecheckBeforeOpen: async () => {
				await rename(path.join(fixture.root, "docs"), path.join(fixture.root, "docs-original"));
				await symlink(outsideDir, path.join(fixture.root, "docs"));
			},
		}),
		/identity does not match|parent identity changed/,
	);
	assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("requires one unique oldText occurrence", async () => {
	const fixture = await progressFixture();
	await assert.rejects(
		syncProjectProgress({
			gitRoot: fixture.root,
			approvedTargets: [fixture.relative],
			target: fixture.relative,
			oldText: "missing",
			newText: "value",
			checks: [],
			runCheck: async () => ({ code: 0, stdout: "", stderr: "" }),
		}),
		/not found/,
	);
	await writeFile(fixture.target, "same\nsame\n");
	await assert.rejects(
		syncProjectProgress({
			gitRoot: fixture.root,
			approvedTargets: [fixture.relative],
			target: fixture.relative,
			oldText: "same",
			newText: "changed",
			checks: [],
			runCheck: async () => ({ code: 0, stdout: "", stderr: "" }),
		}),
		/not unique/,
	);
});

test("keeps the project write but reports a failed post-write check", async () => {
	const fixture = await progressFixture();
	await assert.rejects(
		syncProjectProgress({
			gitRoot: fixture.root,
			approvedTargets: [fixture.relative],
			target: fixture.relative,
			oldText: "pending",
			newText: "complete",
			checks: [{ id: "docs", command: "docs-check", args: [], timeoutMs: 30000 }],
			runCheck: async () => ({ code: 1, stdout: "", stderr: "invalid docs" }),
		}),
		/invalid docs/,
	);
	assert.equal(await readFile(fixture.target, "utf8"), "Status: complete\n");
});
