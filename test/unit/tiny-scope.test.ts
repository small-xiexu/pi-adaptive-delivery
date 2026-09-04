import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { digestApprovalContent, type ApprovalRecord } from "../../extensions/delivery-gate/src/approvals.ts";
import type { TinyDeliveryContract } from "../../extensions/delivery-gate/src/tiny-contract.ts";
import {
	assertTinyAuthorizationCurrent,
	assertTinyWritePath,
	captureTinyApprovalBaseline,
	freezeTinyCandidate,
} from "../../extensions/delivery-gate/src/tiny-scope.ts";

const execFileAsync = promisify(execFile);

async function repo(): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-tiny-scope-"));
	await execFileAsync("git", ["init", "-q"], { cwd });
	await writeFile(path.join(cwd, "tracked.txt"), "initial\n");
	await execFileAsync("git", ["add", "tracked.txt"], { cwd });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd });
	return cwd;
}

function contract(changeScope = ["tracked.txt"]): TinyDeliveryContract {
	return {
		version: 1,
		intent: "Correct one local label",
		nonGoals: ["No contracts or dependencies"],
		changeScope,
		validation: [{ id: "focused", command: "npm test", timeoutMs: 120000 }],
		review: "none",
		eligibility: {
			risk: "low",
			uncertainty: "low",
			userOutcomeClear: true,
			productOrArchitectureDecision: false,
			reversibleWorkspaceOnly: true,
			sharedContractChange: false,
			highRiskDomain: false,
			externalSideEffect: false,
			dependencyOrToolchainChange: false,
			focusedDeterministicValidation: true,
		},
	};
}

function approval(cwd: string, content: unknown = { tiny: true }): ApprovalRecord {
	return {
		version: 1,
		kind: "combined",
		sessionId: "session",
		entryId: "assistant",
		contentDigest: digestApprovalContent(content),
		branchAnchorEntryId: "anchor",
		canonicalCwd: cwd,
		gitRoot: cwd,
		approvedAt: "2026-01-01T00:00:00.000Z",
	};
}

test("captures a clean baseline and freezes only an exact regular-file delta", async () => {
	const cwd = await repo();
	const tiny = contract();
	const record = approval(cwd);
	const baseline = await captureTinyApprovalBaseline({ cwd, contract: tiny, approval: record });
	await writeFile(path.join(cwd, "tracked.txt"), "changed\n");
	await assertTinyAuthorizationCurrent({ cwd, contract: tiny, baseline, approval: record });
	const frozen = await freezeTinyCandidate({ cwd, contract: tiny, baseline, approval: record, approvals: { combined: record } });
	assert.deepEqual(frozen.evidence.changedPaths, ["tracked.txt"]);
	assert.equal(frozen.evidence.baselineDigest, baseline.candidateDigest);
	assert.equal(frozen.evidence.candidateDigest, frozen.candidate.digest);
});

test("rejects dirty baselines, protected paths, symlinks, and submodules", async () => {
	const dirty = await repo();
	await writeFile(path.join(dirty, "unrelated.txt"), "dirty\n");
	await assert.rejects(captureTinyApprovalBaseline({ cwd: dirty, contract: contract(), approval: approval(dirty) }), /clean workspace baseline/);

	const protectedRepo = await repo();
	await writeFile(path.join(protectedRepo, "package.json"), "{}\n");
	await assert.rejects(captureTinyApprovalBaseline({ cwd: protectedRepo, contract: contract(["package.json"]), approval: approval(protectedRepo) }), /protected or toolchain/);
	await assert.rejects(captureTinyApprovalBaseline({ cwd: protectedRepo, contract: contract(["auth.ts"]), approval: approval(protectedRepo) }), /protected or toolchain/);
	await assert.rejects(captureTinyApprovalBaseline({ cwd: protectedRepo, contract: contract(["shared-api.ts"]), approval: approval(protectedRepo) }), /protected or toolchain/);

	const symlinkRepo = await repo();
	await symlink("tracked.txt", path.join(symlinkRepo, "link.txt"));
	await assert.rejects(captureTinyApprovalBaseline({ cwd: symlinkRepo, contract: contract(["link.txt"]), approval: approval(symlinkRepo) }), /symlink/);

	const child = await repo();
	const parent = await repo();
	await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "child"], { cwd: parent });
	await execFileAsync("git", ["add", ".gitmodules", "child"], { cwd: parent });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "submodule"], { cwd: parent });
	await assert.rejects(captureTinyApprovalBaseline({ cwd: parent, contract: contract(["child/tracked.txt"]), approval: approval(parent) }), /submodule/);
});

test("rejects existing and missing ignored Tiny scope targets at approval and write time", async () => {
	const cwd = await repo();
	await writeFile(path.join(cwd, ".gitignore"), "ignored/\n");
	await execFileAsync("git", ["add", ".gitignore"], { cwd });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "ignore Tiny targets"], { cwd });
	await mkdir(path.join(cwd, "ignored"));
	await writeFile(path.join(cwd, "ignored", "existing.txt"), "ignored\n");
	for (const relativePath of ["ignored/existing.txt", "ignored/missing.txt"]) {
		await assert.rejects(
			captureTinyApprovalBaseline({ cwd, contract: contract([relativePath]), approval: approval(cwd) }),
			/ignored path/,
			relativePath,
		);
		await assert.rejects(
			assertTinyWritePath({ cwd, gitRoot: cwd, changeScope: [relativePath], toolPath: relativePath }),
			/ignored path/,
			relativePath,
		);
	}
});

test("fails closed for scope escape, staged, delete, rename, HEAD, and branch drift", async () => {
	for (const operation of ["outside", "staged", "delete", "rename", "head", "branch"] as const) {
		const cwd = await repo();
		const tiny = contract();
		const record = approval(cwd);
		const baseline = await captureTinyApprovalBaseline({ cwd, contract: tiny, approval: record });
		if (operation === "outside") await writeFile(path.join(cwd, "outside.txt"), "new\n");
		if (operation === "staged") {
			await writeFile(path.join(cwd, "tracked.txt"), "staged\n");
			await execFileAsync("git", ["add", "tracked.txt"], { cwd });
		}
		if (operation === "delete") await execFileAsync("git", ["rm", "-q", "tracked.txt"], { cwd });
		if (operation === "rename") await execFileAsync("git", ["mv", "tracked.txt", "renamed.txt"], { cwd });
		if (operation === "head") {
			await writeFile(path.join(cwd, "other.txt"), "head\n");
			await execFileAsync("git", ["add", "other.txt"], { cwd });
			await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head"], { cwd });
		}
		if (operation === "branch") await execFileAsync("git", ["switch", "-q", "-c", "other-branch"], { cwd });
		await assert.rejects(
			assertTinyAuthorizationCurrent({ cwd, contract: tiny, baseline, approval: record }),
			/scope|support|HEAD|branch/,
			operation,
		);
	}
});

test("enforces normalized exact write paths and rejects a symlink swap", async () => {
	const cwd = await repo();
	assert.equal(await assertTinyWritePath({ cwd, gitRoot: cwd, changeScope: ["tracked.txt"], toolPath: "tracked.txt" }), "tracked.txt");
	await assert.rejects(assertTinyWritePath({ cwd, gitRoot: cwd, changeScope: ["tracked.txt"], toolPath: "outside.txt" }), /outside approved scope/);
	await assert.rejects(assertTinyWritePath({ cwd, gitRoot: cwd, changeScope: ["tracked.txt"], toolPath: "../outside.txt" }), /escapes/);
	await symlink("tracked.txt", path.join(cwd, "link.txt"));
	await assert.rejects(assertTinyWritePath({ cwd, gitRoot: cwd, changeScope: ["link.txt"], toolPath: "link.txt" }), /symlink/);
});
