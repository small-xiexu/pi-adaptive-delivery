import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	createCandidateSnapshot,
	snapshotProgressArtifact,
} from "../../extensions/delivery-gate/src/candidate.ts";

const execFileAsync = promisify(execFile);

async function commitRepo(prefix: string): Promise<string> {
	const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
	await execFileAsync("git", ["init", "-q"], { cwd: repo });
	await writeFile(path.join(repo, "tracked.txt"), "initial\n");
	await execFileAsync("git", ["add", "tracked.txt"], { cwd: repo });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], {
		cwd: repo,
	});
	return repo;
}

test("produces a stable digest for an unchanged candidate", async () => {
	const repo = await commitRepo("adaptive-candidate-stable-");
	const first = await createCandidateSnapshot({ cwd: repo });
	const second = await createCandidateSnapshot({ cwd: repo });
	assert.equal(first.digest, second.digest);
	assert.deepEqual(first.manifest, second.manifest);
});

test("keeps the candidate stable when Git-ignored artifacts change", async () => {
	const repo = await commitRepo("adaptive-candidate-ignored-");
	await writeFile(path.join(repo, ".gitignore"), "runtime-cache/\n");
	await execFileAsync("git", ["add", ".gitignore"], { cwd: repo });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "ignore runtime cache"], {
		cwd: repo,
	});
	const baseline = await createCandidateSnapshot({ cwd: repo });
	await mkdir(path.join(repo, "runtime-cache"));
	await writeFile(path.join(repo, "runtime-cache", "result.bin"), "first\n");
	const created = await createCandidateSnapshot({ cwd: repo });
	await writeFile(path.join(repo, "runtime-cache", "result.bin"), "second\n");
	const modified = await createCandidateSnapshot({ cwd: repo });
	await rm(path.join(repo, "runtime-cache"), { recursive: true });
	const removed = await createCandidateSnapshot({ cwd: repo });
	assert.equal(created.digest, baseline.digest);
	assert.equal(modified.digest, baseline.digest);
	assert.equal(removed.digest, baseline.digest);
});

test("changes the candidate digest when HEAD changes", async () => {
	const repo = await commitRepo("adaptive-candidate-head-");
	const baseline = await createCandidateSnapshot({ cwd: repo });
	await writeFile(path.join(repo, "next.txt"), "next\n");
	await execFileAsync("git", ["add", "next.txt"], { cwd: repo });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "next head"], {
		cwd: repo,
	});
	const changed = await createCandidateSnapshot({ cwd: repo });
	assert.notEqual(changed.manifest.head, baseline.manifest.head);
	assert.notEqual(changed.digest, baseline.digest);
});

test("changes for HEAD, staged, tracked, untracked, symlink, and approval changes", async () => {
	const repo = await commitRepo("adaptive-candidate-changes-");
	let previous = await createCandidateSnapshot({ cwd: repo });

	await writeFile(path.join(repo, "staged.txt"), "staged\n");
	await execFileAsync("git", ["add", "staged.txt"], { cwd: repo });
	let next = await createCandidateSnapshot({ cwd: repo });
	assert.notEqual(next.digest, previous.digest);
	previous = next;

	await writeFile(path.join(repo, "tracked.txt"), "changed\n");
	next = await createCandidateSnapshot({ cwd: repo });
	assert.notEqual(next.digest, previous.digest);
	previous = next;

	await writeFile(path.join(repo, "untracked.bin"), Buffer.from([0, 1, 2, 3]));
	next = await createCandidateSnapshot({ cwd: repo });
	assert.notEqual(next.digest, previous.digest);
	assert.equal(next.manifest.untracked.find((item) => item.path === "untracked.bin")?.type, "file");
	assert.equal(next.manifest.untracked.find((item) => item.path === "untracked.bin")?.mode, "100644");
	previous = next;

	await chmod(path.join(repo, "untracked.bin"), 0o755);
	next = await createCandidateSnapshot({ cwd: repo });
	assert.notEqual(next.digest, previous.digest);
	assert.equal(next.manifest.untracked.find((item) => item.path === "untracked.bin")?.mode, "100755");
	previous = next;

	await symlink("tracked.txt", path.join(repo, "untracked-link"));
	next = await createCandidateSnapshot({ cwd: repo });
	assert.notEqual(next.digest, previous.digest);
	assert.equal(next.manifest.untracked.find((item) => item.path === "untracked-link")?.type, "symlink");
	assert.equal(next.manifest.untracked.find((item) => item.path === "untracked-link")?.mode, "120000");
	previous = next;

	next = await createCandidateSnapshot({
		cwd: repo,
		approvals: {
			plan: {
				version: 1,
				kind: "plan",
				sessionId: "session",
				entryId: "entry",
				contentDigest: "a".repeat(64),
				branchAnchorEntryId: "anchor",
				canonicalCwd: repo,
				gitRoot: repo,
				approvedAt: "2026-01-01T00:00:00.000Z",
			},
		},
	});
	assert.notEqual(next.digest, previous.digest);
});

test("records unborn repositories", async () => {
	const repo = await mkdtemp(path.join(os.tmpdir(), "adaptive-candidate-unborn-"));
	await execFileAsync("git", ["init", "-q"], { cwd: repo });
	await writeFile(path.join(repo, "new.txt"), "new\n");
	const snapshot = await createCandidateSnapshot({ cwd: repo });
	assert.equal(snapshot.manifest.head, "UNBORN");
	assert.equal(snapshot.manifest.untracked[0]?.path, "new.txt");
});

test("excludes project progress from candidate but snapshots it at delivery", async () => {
	const repo = await commitRepo("adaptive-candidate-progress-");
	await writeFile(path.join(repo, "progress.md"), "pending\n");
	await execFileAsync("git", ["add", "progress.md"], { cwd: repo });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "plan"], {
		cwd: repo,
	});
	const first = await createCandidateSnapshot({ cwd: repo, progressPaths: ["progress.md"] });
	const progressBefore = await snapshotProgressArtifact(repo, "progress.md");
	await writeFile(path.join(repo, "progress.md"), "complete\n");
	const second = await createCandidateSnapshot({ cwd: repo, progressPaths: ["progress.md"] });
	const progressAfter = await snapshotProgressArtifact(repo, "progress.md");

	assert.equal(first.digest, second.digest);
	assert.notEqual(progressBefore.digest, progressAfter.digest);
	assert.equal(progressBefore.dev > 0, true);
	assert.equal(progressBefore.ino > 0, true);
	assert.deepEqual(second.manifest.controlPlaneExclusions, ["progress.md"]);
});

test("rejects progress paths outside the Git root", async () => {
	const repo = await commitRepo("adaptive-candidate-escape-");
	await assert.rejects(createCandidateSnapshot({ cwd: repo, progressPaths: ["../outside.md"] }), /escapes Git root/);
	await assert.rejects(createCandidateSnapshot({ cwd: repo, progressPaths: ["/tmp/outside.md"] }), /must be relative/);
});

test("rejects directory and symlink progress exclusions without hiding source changes", async () => {
	const repo = await commitRepo("adaptive-candidate-progress-boundary-");
	await writeFile(path.join(repo, "progress.md"), "progress\n");
	await symlink("tracked.txt", path.join(repo, "progress-link.md"));
	await assert.rejects(createCandidateSnapshot({ cwd: repo, progressPaths: ["."] }), /regular file/);
	await assert.rejects(
		createCandidateSnapshot({ cwd: repo, progressPaths: ["progress-link.md"] }),
		/symlink component/,
	);
	const baseline = await createCandidateSnapshot({ cwd: repo, progressPaths: ["progress.md"] });
	await writeFile(path.join(repo, "tracked.txt"), "source changed\n");
	const changed = await createCandidateSnapshot({ cwd: repo, progressPaths: ["progress.md"] });
	assert.notEqual(changed.digest, baseline.digest);
});

test("treats progress exclusions as literal paths even when filenames contain Git pathspec magic", async () => {
	for (const { progressPath, sourcePath } of [
		{ progressPath: "*.ts", sourcePath: "source.ts" },
		{ progressPath: "file?.md", sourcePath: "fileA.md" },
		{ progressPath: "[status].md", sourcePath: "s.md" },
	]) {
		const repo = await commitRepo("adaptive-candidate-progress-literal-");
		await writeFile(path.join(repo, progressPath), "progress\n");
		await writeFile(path.join(repo, sourcePath), "source\n");
		await execFileAsync("git", ["add", "-A"], { cwd: repo });
		await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "paths"], {
			cwd: repo,
		});
		const baseline = await createCandidateSnapshot({ cwd: repo, progressPaths: [progressPath] });
		await writeFile(path.join(repo, sourcePath), "source changed\n");
		const changed = await createCandidateSnapshot({ cwd: repo, progressPaths: [progressPath] });
		assert.notEqual(changed.digest, baseline.digest, progressPath);
		assert.deepEqual(changed.manifest.controlPlaneExclusions, [progressPath]);
	}
});

test("detects submodule state changes", async () => {
	const child = await commitRepo("adaptive-candidate-submodule-child-");
	const repo = await commitRepo("adaptive-candidate-submodule-parent-");
	await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "child"], { cwd: repo });
	await execFileAsync("git", ["add", ".gitmodules", "child"], { cwd: repo });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "submodule"], {
		cwd: repo,
	});
	const first = await createCandidateSnapshot({ cwd: repo });
	await writeFile(path.join(repo, "child", "tracked.txt"), "dirty\n");
	const second = await createCandidateSnapshot({ cwd: repo });
	assert.notEqual(first.digest, second.digest);
});
