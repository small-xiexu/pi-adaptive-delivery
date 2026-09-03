import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	createCandidateReviewPacket,
	parseStructuredReviewResult,
} from "../../extensions/delivery-gate/src/review-contract.ts";

const execFileAsync = promisify(execFile);

async function repo(): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "adaptive-review-contract-"));
	await execFileAsync("git", ["init", "-q"], { cwd });
	await writeFile(path.join(cwd, "tracked.txt"), "initial\n");
	await execFileAsync("git", ["add", "tracked.txt"], { cwd });
	await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"], { cwd });
	return cwd;
}

test("builds a deterministic bounded packet with tracked and untracked actual changes", async () => {
	const cwd = await repo();
	await writeFile(path.join(cwd, "tracked.txt"), "changed\n");
	await writeFile(path.join(cwd, "new.txt"), "new\n");
	const first = await createCandidateReviewPacket({ cwd, candidateDigest: "a".repeat(64) });
	const second = await createCandidateReviewPacket({ cwd: path.join(cwd, "."), candidateDigest: "a".repeat(64) });
	assert.equal(first.diffDigest, second.diffDigest);
	assert.deepEqual(first.changedPaths, ["new.txt", "tracked.txt"]);
	assert.match(first.text, /-initial/);
	assert.match(first.text, /\+changed/);
	assert.match(first.text, /diff --git a\/new\.txt b\/new\.txt/);
});

test("reports actual untracked executable modes and symlink targets", async () => {
	const cwd = await repo();
	await writeFile(path.join(cwd, "run.sh"), "#!/bin/sh\nexit 0\n");
	await chmod(path.join(cwd, "run.sh"), 0o755);
	await symlink("../outside target\n", path.join(cwd, "linked"));
	const packet = await createCandidateReviewPacket({ cwd, candidateDigest: "e".repeat(64) });
	assert.match(packet.text, /new file mode 100755/);
	assert.match(packet.text, /untracked symlink "linked" mode=120000 target="\.\.\/outside target\\n"/);
});

test("requires one structured result bound to both candidate and diff", async () => {
	const cwd = await repo();
	await writeFile(path.join(cwd, "tracked.txt"), "changed\n");
	const packet = await createCandidateReviewPacket({ cwd, candidateDigest: "b".repeat(64) });
	const valid = `\`\`\`adaptive-delivery-review\n${JSON.stringify({
		version: 1,
		candidateDigest: packet.candidateDigest,
		diffDigest: packet.diffDigest,
		verdict: "OK",
		findings: [],
	})}\n\`\`\``;
	assert.equal(parseStructuredReviewResult(valid, packet)?.verdict, "OK");
	assert.equal(parseStructuredReviewResult("Merge verdict: OK", packet), undefined);
	assert.equal(parseStructuredReviewResult(valid.replace(packet.diffDigest, "c".repeat(64)), packet), undefined);
	assert.equal(parseStructuredReviewResult(`${valid}\n${valid}`, packet), undefined);
});

test("rejects verdicts that contradict blocking findings", async () => {
	const cwd = await repo();
	const packet = await createCandidateReviewPacket({ cwd, candidateDigest: "d".repeat(64) });
	const result = `\`\`\`adaptive-delivery-review\n${JSON.stringify({
		version: 1,
		candidateDigest: packet.candidateDigest,
		diffDigest: packet.diffDigest,
		verdict: "OK",
		findings: [{ severity: "P1", path: "tracked.txt", line: 1, summary: "Blocking bug" }],
	})}\n\`\`\``;
	assert.equal(parseStructuredReviewResult(result, packet), undefined);
});
