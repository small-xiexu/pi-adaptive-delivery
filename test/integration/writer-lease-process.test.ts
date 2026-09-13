import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";

async function runContender(stateRoot: string, repo: string, sessionId: string): Promise<{ ok: boolean; reason?: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				path.resolve("test/support/lease-contender.ts"),
				stateRoot,
				repo,
				sessionId,
			],
			{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(stderr || `contender exited ${code}`));
				return;
			}
			resolve(JSON.parse(stdout.trim()));
		});
	});
}

test("admits only one writer across independent Node processes", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-process-lease-state-"));
	const repo = await mkdtemp(path.join(os.tmpdir(), "adaptive-process-lease-repo-"));
	await new Promise<void>((resolve, reject) => {
		const git = spawn("git", ["init", "-q"], { cwd: repo });
		git.on("error", reject);
		git.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git init exited ${code}`))));
	});

	const results = await Promise.all([
		runContender(stateRoot, repo, "session-a"),
		runContender(stateRoot, repo, "session-b"),
	]);
	assert.equal(results.filter((result) => result.ok).length, 1);
	assert.equal(results.filter((result) => !result.ok && /already held/.test(result.reason ?? "")).length, 1);
});

test("独立进程留下的 lease 可由人工强制重置清理，之后能重新取得 writer", async () => {
	const stateRoot = await mkdtemp(path.join(os.tmpdir(), "adaptive-process-discard-state-"));
	const repo = await mkdtemp(path.join(os.tmpdir(), "adaptive-process-discard-repo-"));
	await new Promise<void>((resolve, reject) => {
		const git = spawn("git", ["init", "-q"], { cwd: repo });
		git.on("error", reject);
		git.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git init exited ${code}`))));
	});
	// 真实独立进程取得 writer 后退出，留下未正常交回的 lease。
	assert.equal((await runContender(stateRoot, repo, "session-crashed")).ok, true);
	const workspace = await resolveWorkspaceIdentity(repo);
	const manager = new WriterLeaseManager(stateRoot);
	assert.notEqual(await manager.read(workspace.key), undefined);
	await assert.rejects(manager.assertIdle(workspace.key), /writer/);
	// 操作锁残留由夹具构造：强杀正在锁内写入的进程无法在测试中稳定复现。
	await mkdir(path.join(stateRoot, "leases", `${workspace.key}.operation-lock`));
	const blockage = await manager.inspectBlockage(workspace.key);
	assert.equal(blockage.operationLock, true);
	assert.deepEqual(await manager.discard(workspace.key, blockage), { lease: true, operationLock: true });
	await manager.assertIdle(workspace.key);
	assert.equal((await runContender(stateRoot, repo, "session-recovered")).ok, true);
});
