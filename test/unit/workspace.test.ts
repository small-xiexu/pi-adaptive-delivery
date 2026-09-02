import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	WriterLeaseManager,
	parseWriterLeaseRecord,
	parseWriterLeaseReference,
	resolveWorkspaceIdentity,
} from "../../extensions/delivery-gate/src/workspace.ts";

const execFileAsync = promisify(execFile);

async function gitRepo(prefix: string): Promise<string> {
	const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
	await execFileAsync("git", ["init", "-q"], { cwd: repo });
	return repo;
}

test("canonicalizes symlink aliases to the same workspace key", async () => {
	const repo = await gitRepo("adaptive-lease-repo-");
	const aliases = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-alias-"));
	const alias = path.join(aliases, "repo-link");
	await symlink(repo, alias);

	const direct = await resolveWorkspaceIdentity(repo);
	const linked = await resolveWorkspaceIdentity(alias);
	assert.deepEqual(linked, direct);
});

test("uses one lease key for a worktree root and all of its subdirectories", async () => {
	const repo = await gitRepo("adaptive-lease-subdir-");
	const subdir = path.join(repo, "src", "nested");
	await mkdir(subdir, { recursive: true });
	const root = await resolveWorkspaceIdentity(repo);
	const nested = await resolveWorkspaceIdentity(subdir);
	assert.equal(root.key, nested.key);
	assert.equal(root.workspacePath, nested.workspacePath);
	assert.notEqual(root.cwdPath, nested.cwdPath);
});

test("atomically admits only one writer for a workspace", async () => {
	const repo = await gitRepo("adaptive-lease-race-");
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-state-"));
	const identity = await resolveWorkspaceIdentity(repo);
	const first = new WriterLeaseManager(stateRoot);
	const second = new WriterLeaseManager(stateRoot);

	const results = await Promise.all([
		first.acquire(identity, { kind: "parent", sessionId: "session-a", pid: process.pid }),
		second.acquire(identity, { kind: "parent", sessionId: "session-b", pid: process.pid }),
	]);
	assert.equal(results.filter((result) => result.ok).length, 1);
	assert.equal(results.filter((result) => !result.ok).length, 1);
});

test("binds a provisional parent lease to a child run", async () => {
	const repo = await gitRepo("adaptive-lease-bind-");
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-state-"));
	const manager = new WriterLeaseManager(stateRoot);
	const identity = await resolveWorkspaceIdentity(repo);
	const acquired = await manager.acquire(identity, { kind: "parent", sessionId: "session", pid: process.pid });
	if (!acquired.ok) assert.fail(acquired.reason);
	assert.equal(acquired.ok, true);

	const bound = await manager.bind(acquired.reference, { runId: "run-1", missionId: "mission-1", pid: 12345 });
	assert.equal(bound.owner.kind, "child");
	assert.equal(bound.owner.runId, "run-1");
	assert.equal(bound.phase, "bound");
	assert.equal(await manager.isCurrentOwner(acquired.reference), true);
});

test("requires matching proof to release parent and child leases", async () => {
	const repo = await gitRepo("adaptive-lease-release-");
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-state-"));
	const manager = new WriterLeaseManager(stateRoot);
	const identity = await resolveWorkspaceIdentity(repo);

	const parent = await manager.acquire(identity, { kind: "parent", sessionId: "session", pid: process.pid });
	if (!parent.ok) assert.fail(parent.reason);
	assert.equal(parent.ok, true);
	await assert.rejects(
		manager.release(parent.reference, { kind: "process-terminal", runId: "wrong", observed: true }),
		/Parent writer lease/,
	);
	await manager.release(parent.reference, { kind: "parent-owner", processToken: manager.processToken });
	assert.equal(await manager.read(identity.key), undefined);

	const child = await manager.acquire(identity, { kind: "parent", sessionId: "session", pid: process.pid });
	if (!child.ok) assert.fail(child.reason);
	assert.equal(child.ok, true);
	await manager.bind(child.reference, { runId: "run-2" });
	await assert.rejects(
		manager.release(child.reference, { kind: "process-terminal", runId: "wrong", observed: true }),
		/process-terminal/,
	);
	await manager.release(child.reference, { kind: "process-terminal", runId: "run-2", observed: true });
	assert.equal(await manager.read(identity.key), undefined);
});

test("does not treat another process token as ownership even with the same PID", async () => {
	const repo = await gitRepo("adaptive-lease-owner-");
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-state-"));
	const manager = new WriterLeaseManager(stateRoot);
	const identity = await resolveWorkspaceIdentity(repo);
	const acquired = await manager.acquire(identity, { kind: "parent", sessionId: "session", pid: process.pid });
	if (!acquired.ok) assert.fail(acquired.reason);
	assert.equal(acquired.ok, true);

	const leasePath = path.join(stateRoot, "leases", `${identity.key}.json`);
	const record = JSON.parse(await readFile(leasePath, "utf8"));
	record.owner.processToken = "different-process-token";
	await writeFile(leasePath, `${JSON.stringify(record)}\n`);

	assert.equal(await manager.isCurrentOwner(acquired.reference), false);
	await assert.rejects(
		manager.release(acquired.reference, { kind: "parent-owner", processToken: manager.processToken }),
		/different process owner/,
	);
});

test("fails closed for malformed records and references", async () => {
	assert.equal(parseWriterLeaseRecord({ version: 1 }), undefined);
	assert.equal(parseWriterLeaseReference({ version: 1, leaseId: "x", workspaceKey: "bad" }), undefined);

	const repo = await gitRepo("adaptive-lease-corrupt-");
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-state-"));
	const manager = new WriterLeaseManager(stateRoot);
	const identity = await resolveWorkspaceIdentity(repo);
	const acquired = await manager.acquire(identity, { kind: "parent", sessionId: "session", pid: process.pid });
	assert.equal(acquired.ok, true);
	const leasePath = path.join(stateRoot, "leases", `${identity.key}.json`);
	await writeFile(leasePath, "not-json\n");
	await assert.rejects(manager.read(identity.key));
});

test("force-release refuses to delete an owner that changed after confirmation", async () => {
	const repo = await gitRepo("adaptive-lease-owner-race-");
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-state-"));
	const manager = new WriterLeaseManager(stateRoot);
	const identity = await resolveWorkspaceIdentity(repo);
	const acquired = await manager.acquire(identity, { kind: "parent", sessionId: "session-a", pid: process.pid });
	if (!acquired.ok) assert.fail(acquired.reason);
	const displayedLeaseId = acquired.record.leaseId;
	const leasePath = path.join(stateRoot, "leases", `${identity.key}.json`);
	const replacement = {
		...acquired.record,
		leaseId: crypto.randomUUID(),
		owner: { ...acquired.record.owner, sessionId: "session-b" },
		updatedAt: new Date().toISOString(),
	};
	await writeFile(leasePath, `${JSON.stringify(replacement, null, 2)}\n`);

	await assert.rejects(
		manager.forceRelease(identity.key, displayedLeaseId),
		/owner changed/,
	);
	assert.equal((await manager.read(identity.key))?.leaseId, replacement.leaseId);
});

test("force-release does not break a live lease operation lock", async () => {
	const repo = await gitRepo("adaptive-lease-live-operation-");
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-state-"));
	const manager = new WriterLeaseManager(stateRoot);
	const identity = await resolveWorkspaceIdentity(repo);
	const acquired = await manager.acquire(identity, { kind: "parent", sessionId: "session", pid: process.pid });
	if (!acquired.ok) assert.fail(acquired.reason);
	const lockPath = path.join(stateRoot, "leases", `${identity.key}.operation-lock`);
	await mkdir(lockPath);
	await writeFile(path.join(lockPath, "owner"), "live-operation", "utf8");

	await assert.rejects(
		manager.forceRelease(identity.key, acquired.record.leaseId),
		/operation lock is held or stale/,
	);
	assert.equal((await manager.read(identity.key))?.leaseId, acquired.record.leaseId);
});

test("uses distinct lease keys for independent worktrees", async () => {
	const repo = await gitRepo("adaptive-lease-worktree-");
	await writeFile(path.join(repo, "README.md"), "root\n");
	await execFileAsync("git", ["add", "README.md"], { cwd: repo });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], {
		cwd: repo,
	});
	const worktree = `${repo}-worktree`;
	await execFileAsync("git", ["worktree", "add", "-q", "-b", "other", worktree], { cwd: repo });

	const rootIdentity = await resolveWorkspaceIdentity(repo);
	const worktreeIdentity = await resolveWorkspaceIdentity(worktree);
	assert.notEqual(rootIdentity.key, worktreeIdentity.key);
	assert.equal(rootIdentity.gitRoot, await realpath(repo));
	assert.equal(worktreeIdentity.gitRoot, await realpath(worktree));
});
