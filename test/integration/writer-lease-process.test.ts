import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
