import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createValidationRun as initializeValidationRun, validationPassed } from "../../extensions/delivery-gate/src/validation.ts";
import { captureCandidate } from "../../extensions/delivery-gate/src/candidate.ts";
import { prepareReview } from "../../extensions/delivery-gate/src/review.ts";
import type { LocalExecution } from "../../extensions/delivery-gate/src/local-execution.ts";
import { resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";

async function host() {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "validation-unit-")));
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	await mkdir(path.join(root, "src"));
	await writeFile(path.join(root, "src/value.js"), "original\n");
	const scope = { workspace: await resolveWorkspaceIdentity(root),
		readPaths: [], writePaths: ["src"], protectedPaths: [path.join(root, "plan.md")] };
	return { root, scope };
}

async function createValidationRun(scope: Parameters<typeof initializeValidationRun>[0], commands: string[]) {
	return initializeValidationRun(scope, commands, await captureCandidate(scope, commands));
}

test("固定验收使用交接前的候选副本，准备后文件变化不能成为新的通过基线", async () => {
	const h = await host();
	const before = await captureCandidate(h.scope, ["check"]);
	await writeFile(path.join(h.root, "src/value.js"), "changed after preparation\n");
	const validation = await initializeValidationRun(h.scope, ["check"], before);
	const original = before.digest;
	before.digest = "tampered input";
	await validation.execute("check", { command: "check" }, async () => {}, () => completed("check"));
	const proof = await validation.finish();
	assert.equal(proof.before.digest, original);
	assert.equal(validationPassed(proof), false);
});

function completed(name: string, status: LocalExecution["status"] = "passed"): LocalExecution {
	return { name, cwd: ".", settled: true, status, exitCode: status === "passed" ? 0 : 7 };
}

test("固定验收由实际执行引用和稳定候选组成，不能用返回文本声称通过", async () => {
	const h = await host();
	const commands = ["first", "second"];
	const validation = await createValidationRun(h.scope, commands);
	commands[0] = "not-approved";
	let actual: LocalExecution | undefined;
	for (const [index, command] of ["first", "second"].entries()) {
		assert.equal(await validation.execute(`tool-${index}`, { command, timeout: 10 }, async () => {
			actual = completed(`execution-${index}`);
			return "model text is not authoritative";
		}, () => actual), "model text is not authoritative");
	}
	const proof = await validation.finish();
	assert.equal(validationPassed(proof), true);
	assert.deepEqual(proof.commands, ["first", "second"]);
	assert.deepEqual(proof.results.map((row) => [row.toolCallId, row.execution, row.timeout]), [["tool-0", "execution-0", 10], ["tool-1", "execution-1", 10]]);
	proof.commands[0] = "mutated returned copy";
	proof.results[0]!.status = "failed";
	assert.equal(validationPassed(await validation.finish()), true);
});

for (const status of ["failed", "cancelled", "timeout", "unknown", "not-run"] as const) test(`实际命令 ${status} 不被模型成功声明覆盖`, async () => {
	const h = await host();
	const validation = await createValidationRun(h.scope, ["first", "second"]);
	let actual: LocalExecution | undefined;
	await validation.execute("tool", { command: "first" }, async () => { actual = completed("execution", status); return "通过"; }, () => actual);
	let invoked = false;
	await assert.rejects(validation.execute("next", { command: "second" }, async () => { invoked = true; }, () => actual), /失败后继续/);
	assert.equal(invoked, false);
	const proof = await validation.finish();
	assert.deepEqual(proof.results.map((row) => row.status), [status, "not-run"]);
	assert.equal(validationPassed(proof), false);
});

test("固定验收没有执行的命令保持未运行，不能替换、跳序或重放", async () => {
	const h = await host();
	const validation = await createValidationRun(h.scope, ["first", "second"]);
	let calls = 0;
	for (const command of ["other", "second"]) await assert.rejects(validation.execute("wrong", { command }, async () => { calls++; }, () => undefined));
	assert.equal(calls, 0);
	assert.equal(validationPassed(await validation.finish()), false);
	await validation.execute("first", { command: "first" }, async () => { calls++; }, () => completed("first"));
	await assert.rejects(validation.execute("again", { command: "first" }, async () => { calls++; }, () => undefined));
	assert.equal(calls, 1);
	assert.equal(validationPassed(await validation.finish()), false);
});

test("下一命令在启动前失败不能复用上一命令成功终态", async () => {
	const h = await host();
	const validation = await createValidationRun(h.scope, ["first", "second"]);
	let actual: LocalExecution | undefined;
	await validation.execute("first", { command: "first" }, async () => { actual = completed("first"); }, () => actual);
	await assert.rejects(validation.execute("second", { command: "second", timeout: 301 }, async () => { throw new Error("fixture pre-execution failure"); }, () => actual));
	const proof = await validation.finish();
	assert.deepEqual(proof.results.map((row) => row.status), ["passed", "not-run"]);
	assert.equal(validationPassed(proof), false);
});

for (const kind of ["changed", "missing"]) test(`命令退出 0 但候选 ${kind} 不产生验收通过`, async () => {
	const h = await host();
	const validation = await createValidationRun(h.scope, ["command"]);
	let actual: LocalExecution | undefined;
	await validation.execute("tool", { command: "command" }, async () => {
		if (kind === "changed") await writeFile(path.join(h.root, "src/value.js"), "changed\n");
		else await rm(path.join(h.root, "src"), { recursive: true });
		actual = completed("execution");
	}, () => actual);
	const proof = await validation.finish();
	assert.equal(proof.results[0]!.status, "passed");
	assert.equal(validationPassed(proof), false);
	if (kind === "missing") assert.notEqual(proof.after?.digest, proof.before.digest);
});

test("空清单不是零项全部通过，未开始验收", async () => {
	const h = await host();
	await assert.rejects(createValidationRun(h.scope, []), /没有明确/);
	await assert.rejects(createValidationRun(h.scope, [" "]), /没有明确/);
});

test("审查差异使用真实 Git 基线与当前副本，创建/删除/模式变化及忽略源码不遗漏，不执行项目过滤器", async () => {
	const h = await host();
	const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: h.root, encoding: "utf8" });
	await writeFile(path.join(h.root, "src/deleted.js"), "deleted baseline\n");
	git("add", "src");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "temporary fixture baseline");
	const script = path.join(h.root, "unsafe-filter.sh");
	await writeFile(script, `#!/bin/sh\nprintf unsafe > '${path.join(h.root, "filter-executed")}'\nexec /bin/cat\n`, { mode: 0o700 });
	await writeFile(path.join(h.root, ".gitattributes"), "*.js filter=probe diff=probe\n");
	await writeFile(path.join(h.root, ".gitignore"), "src/ignored.js\n");
	git("config", "filter.probe.clean", script);
	git("config", "filter.probe.required", "true");
	git("config", "diff.probe.textconv", script);
	git("config", "diff.external", script);
	git("config", "core.fsmonitor", script);
	await writeFile(path.join(h.root, "src/value.js"), "changed code\n");
	await chmod(path.join(h.root, "src/value.js"), 0o700);
	await rm(path.join(h.root, "src/deleted.js"));
	await writeFile(path.join(h.root, "src/ignored.js"), "ignored source must be reviewed\n");
	const candidate = await captureCandidate(h.scope, ["check"]);
	const review = await prepareReview(h.scope, candidate);
	assert.match(review.baseHead!, /^[a-f0-9]{40}$/);
	const diff = await readFile(review.diffFile, "utf8");
	assert.match(diff, /changed code/);
	assert.match(diff, /deleted baseline/);
	assert.match(diff, /ignored source must be reviewed/);
	assert.match(diff, /old mode 100644\nnew mode 100755/);
	await assert.rejects(access(path.join(h.root, "filter-executed")), { code: "ENOENT" });
	assert.equal((await captureCandidate(h.scope, ["check"])).digest, candidate.digest);
});

test("无 HEAD 的临时 Git 审查明确采用空基线，原始新增文件形成真实差异", async () => {
	const h = await host();
	const review = await prepareReview(h.scope, await captureCandidate(h.scope, ["check"]));
	assert.equal(review.baseHead, undefined);
	assert.match(await readFile(review.diffFile, "utf8"), /new file mode 100644/);
	assert.match(await readFile(review.diffFile, "utf8"), /\+original/);
});

for (const kind of ["blob", "commit"]) test(`Git replace ${kind} 不改变审查原始基线，也不删除替代规则`, async () => {
	const h = await host();
	const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: h.root, encoding: "utf8" }).trim();
	const commit = () => git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "isolated replace fixture");
	git("add", "src"); commit();
	const head = git("rev-parse", "HEAD");
	const old = kind === "blob" ? git("rev-parse", "HEAD:src/value.js") : head;
	await writeFile(path.join(h.root, "src/value.js"), "changed source\n");
	let replacement: string;
	if (kind === "blob") replacement = git("hash-object", "-w", "src/value.js");
	else { git("add", "src"); commit(); replacement = git("rev-parse", "HEAD"); git("update-ref", "HEAD", head); }
	git("replace", old, replacement);
	const review = await prepareReview(h.scope, await captureCandidate(h.scope, ["check"]));
	assert.equal(review.baseHead, head);
	assert.match(await readFile(review.diffFile, "utf8"), /-original\n\+changed source/);
	assert.equal(git("rev-parse", `refs/replace/${old}`), replacement);
	assert.equal(await readFile(path.join(h.root, "src/value.js"), "utf8"), "changed source\n");
});

test("Git 原始二进制差异不被转码成文本或静默忽略", async () => {
	const h = await host();
	await writeFile(path.join(h.root, "src/binary.dat"), Buffer.from([0, 1, 255, 2]));
	const review = await prepareReview(h.scope, await captureCandidate(h.scope, ["check"]));
	assert.match(await readFile(review.diffFile, "utf8"), /GIT binary patch/);
});

test("特殊 Git 基线类型不能伪装成普通文件差异", async () => {
	const h = await host();
	const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: h.root });
	await symlink("value.js", path.join(h.root, "src/alias"));
	git("add", "src");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "temporary symbolic baseline");
	await rm(path.join(h.root, "src/alias"));
	await assert.rejects(prepareReview(h.scope, await captureCandidate(h.scope, ["check"])), /不是受支持的普通文件/);
});

test("审查临时目录不能落入被审查 worktree", async (t) => {
	const h = await host();
	const candidate = await captureCandidate(h.scope, ["check"]);
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = h.root;
	t.after(() => { process.env.TMPDIR = previous; });
	await assert.rejects(prepareReview(h.scope, candidate), /必须在被审查 worktree 之外/);
});
