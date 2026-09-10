import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	WriterLeaseManager,
	parseWriterLeaseRecord,
	parseWriterLeaseReference,
	resolveWorkspaceIdentity,
	getWriterStateRoot,
	readGitStatus,
} from "../../extensions/delivery-gate/src/workspace.ts";

const execFileAsync = promisify(execFile);

test("固定 Git 状态保留 unborn、暂存/未暂存/未跟踪、重命名及特殊路径，不运行 fsmonitor 或内容过滤器", async () => {
	const repo = await gitRepo("adaptive-git-status-");
	const git = (...args: string[]) => execFileAsync("/usr/bin/git", args, { cwd: repo });
	const name = "文件 空格\n\t.txt";
	await writeFile(path.join(repo, name), "before\n");
	let status = await readGitStatus(repo);
	assert.equal(status.head, null);
	assert.deepEqual(status.changes, [{ status: "??", path: name }]);
	await git("add", "--", name);
	await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
	await writeFile(path.join(repo, name), "after!\n");
	await writeFile(path.join(repo, "new.txt"), "new\n");
	await git("config", "core.fsmonitor", "touch FS_MONITOR_EXECUTED");
	await git("config", "filter.fixture.clean", "touch FILTER_EXECUTED; cat");
	await git("config", "filter.fixture.required", "true");
	await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=fixture\n");
	const index = await readFile(path.join(repo, ".git/index"));
	status = await readGitStatus(repo);
	assert.ok(status.head);
	assert.ok(status.branch);
	assert.ok(status.changes.some((item) => item.status === ".M" && item.path === name));
	assert.ok(status.changes.some((item) => item.status === "??" && item.path === "new.txt"));
	assert.deepEqual(await readFile(path.join(repo, ".git/index")), index);
	await assert.rejects(access(path.join(repo, "FS_MONITOR_EXECUTED")), { code: "ENOENT" });
	await assert.rejects(access(path.join(repo, "FILTER_EXECUTED")), { code: "ENOENT" });
	await git("config", "--unset", "core.fsmonitor");
	await git("config", "--unset", "filter.fixture.clean");
	await git("config", "--unset", "filter.fixture.required");
	await git("mv", "--", name, "renamed.txt");
	status = await readGitStatus(repo);
	assert.ok(status.changes.some((item) => item.path === "renamed.txt" && item.originalPath === name));
	await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "rename");
	await git("checkout", "--detach", "--quiet");
	assert.equal((await readGitStatus(repo)).branch, null);
});

async function gitRepo(prefix: string): Promise<string> {
	const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
	await execFileAsync("git", ["init", "-q"], { cwd: repo });
	return repo;
}

test("退出所需 writer 空闲证据拒绝损坏记录及残留操作锁，不解锁", async () => {
	const repo = await gitRepo("adaptive-idle-");
	const workspace = await resolveWorkspaceIdentity(repo);
	const root = await getWriterStateRoot(workspace);
	const manager = new WriterLeaseManager(root);
	await manager.assertIdle(workspace.key);
	await mkdir(path.join(root, "leases"), { recursive: true });
	const lock = path.join(root, "leases", `${workspace.key}.operation-lock`);
	await mkdir(lock);
	await assert.rejects(manager.assertIdle(workspace.key), /操作锁/);
	await access(lock);
	await writeFile(path.join(root, "leases", `${workspace.key}.json`), "broken");
	await assert.rejects(manager.assertIdle(workspace.key));
	await access(lock);
});

test("canonicalizes symlink aliases to the same workspace key", async () => {
	const repo = await gitRepo("adaptive-lease-repo-");
	const aliases = await mkdtemp(path.join(os.tmpdir(), "adaptive-lease-alias-"));
	const alias = path.join(aliases, "repo-link");
	await symlink(repo, alias);

	const direct = await resolveWorkspaceIdentity(repo);
	const linked = await resolveWorkspaceIdentity(alias);
	assert.deepEqual(linked, direct);
	assert.equal(await getWriterStateRoot(linked), await getWriterStateRoot(direct));
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
	assert.equal(await getWriterStateRoot(root), await getWriterStateRoot(nested));
});

test("工作区查询固定系统 Git，不执行 PATH 中的项目脚本", async (t) => {
	const repo = await gitRepo("adaptive-lease-path-");
	const bin = path.join(repo, "bin");
	await mkdir(bin);
	await writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf executed > '${repo}/executed'\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
	const original = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${original}`;
	t.after(() => { process.env.PATH = original; });
	const workspace = await resolveWorkspaceIdentity(repo);
	assert.equal(await getWriterStateRoot(workspace), path.join(await realpath(repo), ".git/pi-adaptive-delivery"));
	await assert.rejects(access(path.join(repo, "executed")), { code: "ENOENT" });
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

async function transferFixture() {
	const repo = await gitRepo("adaptive-lease-transfer-");
	const workspace = await resolveWorkspaceIdentity(repo);
	const root = await getWriterStateRoot(workspace);
	const manager = new WriterLeaseManager(root);
	const acquired = await manager.acquire(workspace, { kind: "parent", sessionId: "parent", pid: process.pid, runId: "run" });
	assert.ok(acquired.ok);
	const child = { kind: "child" as const, sessionId: "child", pid: process.pid + 1, processToken: "unit-child-process", runId: "run" };
	const signal = new AbortController().signal;
	return { manager, workspace, acquired, child, signal, file: path.join(root, "leases", `${workspace.key}.json`),
		handoff: () => manager.handoff(acquired.reference, acquired.record.owner, child, async () => {}, signal),
		release: (verify = async () => {}) => manager.releaseChild(acquired.reference, child, acquired.record.owner, verify, signal) };
}

test("父到子的交接更换实际 owner，父只有收尾协调身份", async () => {
	const h = await transferFixture();
	let verified = false;
	const record = await h.manager.handoff(h.acquired.reference, h.acquired.record.owner, h.child, async () => {
		assert.equal(await h.manager.isCurrentOwner(h.acquired.reference), true);
		verified = true;
	}, h.signal);
	assert.equal(verified, true);
	assert.equal(record.leaseId, h.acquired.record.leaseId);
	assert.deepEqual(record.owner, h.child);
	assert.deepEqual(record.coordinator, h.acquired.record.owner);
	assert.equal(await h.manager.isCurrentOwner(h.acquired.reference), false);
	await assert.rejects(h.manager.releaseParent(h.acquired.reference, h.acquired.record.owner, async () => {}, h.signal));
	await assert.rejects(h.handoff());
	await h.release();
	assert.equal(await h.manager.read(h.workspace.key), undefined);
	assert.ok((await h.manager.acquire(h.workspace, { kind: "parent", sessionId: "parent", pid: process.pid, runId: "next" })).ok);
});

for (const changed of ["pid", "sessionId", "processToken", "runId", "kind"] as const) {
	test(`交接拒绝非独立或不匹配的子 ${changed}`, async () => {
		const h = await transferFixture();
		const child = { ...h.child, [changed]: changed === "runId" ? "different-run" : h.acquired.record.owner[changed] };
		await assert.rejects(h.manager.handoff(h.acquired.reference, h.acquired.record.owner, child as typeof h.child, async () => {}, h.signal), /绑定无效/);
		assert.deepEqual((await h.manager.read(h.workspace.key))?.owner, h.acquired.record.owner);
	});
}

for (const boundary of ["handoff", "release"]) for (const failure of ["proof", "cancel", "owner"]) {
	test(`${boundary} 的 ${failure} 失败保留当前 writer`, async () => {
		const h = await transferFixture();
		if (boundary === "release") await h.handoff();
		const controller = new AbortController();
		const verify = async () => {
			if (failure === "proof") throw new Error("fixture proof failure");
			if (failure === "cancel") controller.abort(new Error("fixture cancelled"));
		};
		if (failure === "owner") {
			const row = JSON.parse(await readFile(h.file, "utf8"));
			row.owner.sessionId = "different-session";
			await writeFile(h.file, JSON.stringify(row));
		}
		if (boundary === "handoff") await assert.rejects(h.manager.handoff(h.acquired.reference, h.acquired.record.owner, h.child, verify, controller.signal));
		else await assert.rejects(h.manager.releaseChild(h.acquired.reference, h.child, h.acquired.record.owner, verify, controller.signal));
		assert.ok(await h.manager.read(h.workspace.key));
	});
}

for (const field of ["processToken", "sessionId", "pid"]) test(`原父协调 ${field} 变化时，不能凭读到的子 owner 释放`, async () => {
	const h = await transferFixture();
	await h.handoff();
	const row = JSON.parse(await readFile(h.file, "utf8"));
	row.coordinator[field] = field === "pid" ? process.pid + 100 : "different-parent";
	await writeFile(h.file, JSON.stringify(row));
	await assert.rejects(h.release(), /父协调归属/);
	assert.ok(await h.manager.read(h.workspace.key));
});

test("交接和交回均在操作锁内验证，未验证时竞争者不能取得 writer", async () => {
	const h = await transferFixture();
	for (const phase of ["handoff", "release"]) {
		const verify = async () => {
			const result = await h.manager.acquire(h.workspace, { kind: "parent", sessionId: "racer", pid: process.pid });
			assert.fail(`操作锁不能被竞争者越过：${JSON.stringify(result)}`);
		};
		if (phase === "handoff") {
			await assert.rejects(h.manager.handoff(h.acquired.reference, h.acquired.record.owner, h.child, verify, h.signal), /operation lock/);
			await h.handoff();
		} else await assert.rejects(h.release(verify), /operation lock/);
		assert.ok(await h.manager.read(h.workspace.key));
	}
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
		manager.releaseParent(acquired.reference, acquired.record.owner, async () => {}, new AbortController().signal),
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

test("旧 lease 与缺失父协调身份的子记录均拒绝，不提供迁移或 force-release", async () => {
	const h = await transferFixture();
	assert.equal(parseWriterLeaseRecord({ ...h.acquired.record, version: 1 }), undefined);
	assert.equal(parseWriterLeaseReference({ ...h.acquired.reference, version: 1 }), undefined);
	assert.equal(parseWriterLeaseRecord({ ...h.acquired.record, owner: h.child }), undefined);
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
	const rootState = await getWriterStateRoot(rootIdentity);
	const worktreeState = await getWriterStateRoot(worktreeIdentity);
	assert.notEqual(rootState, worktreeState);
	assert.equal(path.dirname(path.dirname(worktreeState)), path.join(rootIdentity.gitRoot, ".git", "worktrees"));
});
