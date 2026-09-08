import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createStructuredCommands } from "../../extensions/delivery-gate/src/structured.ts";
import { resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";
import { installFakeDocker } from "../support/fake-docker.ts";

async function fixture(t: TestContext, scenario = "normal") {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "structured-unit-")));
	const cwd = path.join(root, "repo");
	await mkdir(cwd); execFileSync("git", ["init", "--quiet"], { cwd });
	const fake = await installFakeDocker(t, root, scenario);
	const scope = { workspace: await resolveWorkspaceIdentity(cwd), image: `sha256:${"a".repeat(64)}`, readPaths: [], writePaths: [], protectedPaths: [], hostPaths: true, readonlyWorkspace: [] };
	let references = 0;
	const create = () => createStructuredCommands(scope, async () => { references++; });
	const runner = create();
	return { cwd, fake, runner, create, references: () => references };
}

test("Structured 无效参数与跨会话 session_id 在创建容器前拒绝", async (t) => {
	const h = await fixture(t);
	for (const args of [{ cmd: "" }, { cmd: "true", max_output_tokens: 0 }, { cmd: "true", yield_time_ms: 30001 }]) await assert.rejects(h.runner.exec("x", args));
	await assert.rejects(h.runner.stdin({ session_id: 1 }), /不属于/);
	assert.equal(h.references(), 0);
	assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: false });
	await assert.rejects(h.runner.exec("x", { cmd: "true" }), /关闭/);
});

test("Structured 一个未交回命令保持原身份，取消等真实后端收尾后拒绝旧 ID", async (t) => {
	const h = await fixture(t, "structured-wait");
	t.after(async () => { await h.runner.finish(); });
	const started = await h.runner.exec("start", { cmd: "sleep 120", yield_time_ms: 250 });
	assert.ok("session_id" in started.details && started.details.session_id);
	await assert.rejects(h.create().stdin({ session_id: started.details.session_id! }), /不属于/);
	await assert.rejects(h.runner.exec("other", { cmd: "true" }), /尚未交回/);
	await assert.rejects(h.runner.stdin({ session_id: started.details.session_id!, chars: "input" }), /tty/);
	const controller = new AbortController();
	const polling = h.runner.stdin({ session_id: started.details.session_id!, yield_time_ms: 30_000 }, controller.signal);
	controller.abort(new Error("fixture cancellation"));
	await assert.rejects(polling, /fixture cancellation/);
	assert.equal(h.runner.active, false);
	assert.equal(h.runner.lastExecution?.clean, true);
	assert.equal(h.runner.lastExecution?.status, "cancelled");
	assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: false });
	await assert.rejects(h.runner.stdin({ session_id: started.details.session_id! }), /不属于/);
	assert.equal(h.references(), 1);
	for (const row of h.fake.audit()) assert.throws(() => process.kill(row.pid, 0), { code: "ESRCH" });
});

test("Structured 未交回命令在关闭时终止，原生命令完成不能替代交回", async (t) => {
	const h = await fixture(t, "structured-wait");
	await h.runner.exec("start", { cmd: "sleep 120", yield_time_ms: 250 });
	assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: true });
	assert.equal(h.runner.lastExecution?.clean, true);
});

test("Structured 后端收尾未知时禁止替代命令并保留真实引用", async (t) => {
	const h = await fixture(t, "remove-error");
	await assert.rejects(h.runner.exec("start", { cmd: "true", yield_time_ms: 30_000 }), /remove failed/);
	assert.equal(h.runner.cleanupFailed, true);
	assert.match(h.runner.lastExecution!.name, /^pi-adaptive-/);
	await assert.rejects(h.runner.exec("next", { cmd: "true" }), /收尾未知/);
	await assert.rejects(h.runner.finish(), /收尾未知/);
	assert.equal(h.references(), 1);
});

test("Structured 大量输出保留显式截断及尾部，下一次读取不重复消耗", async (t) => {
	const h = await fixture(t, "structured-output");
	const result = await h.runner.exec("start", { cmd: "true", yield_time_ms: 30_000, max_output_tokens: 100 });
	assert.ok("exit_code" in result.details);
	assert.equal(result.details.exit_code, 0);
	assert.match(result.details.output, /^\[较早输出已截断\]/);
	assert.match(result.details.output, /OUTPUT_TAIL/);
	assert.ok(result.details.output.length < 500);
	assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: false });
});

test("只读挂载中的宿主 FIFO 在任何 Docker 创建前拒绝", async (t) => {
	const h = await fixture(t);
	execFileSync("mkfifo", [path.join(h.cwd, "host-ipc")]);
	await assert.rejects(h.runner.exec("start", { cmd: "true", yield_time_ms: 30_000 }), /socket、FIFO 或设备/);
	assert.equal(h.references(), 0);
	assert.equal(h.runner.cleanupFailed, false);
});
