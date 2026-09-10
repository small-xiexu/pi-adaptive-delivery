import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalOperations } from "../../extensions/delivery-gate/src/local-execution.ts";

const directory = async () => realpath(await mkdtemp(path.join(os.tmpdir(), "local-execution-")));
test("本机执行保留工作目录、输出、实际退出码和部分产物，失败后可以重试", async () => {
	const cwd = await directory();
	const references: unknown[] = [];
	const runner = createLocalOperations(cwd, async (ref) => { references.push(ref); });
	let output = "";
	assert.equal((await runner.operations.exec("printf partial > value.txt; printf out; printf err >&2; exit 7", cwd,
		{ onData: (data) => { output += data; } })).exitCode, 7);
	assert.match(output, /out/); assert.match(output, /err/);
	assert.equal(await readFile(path.join(cwd, "value.txt"), "utf8"), "partial");
	assert.equal(runner.lastExecution?.status, "failed");
	assert.equal(runner.lastExecution?.settled, true);
	assert.equal((await runner.operations.exec("test -f value.txt", cwd, { onData() {} })).exitCode, 0);
	assert.equal(runner.lastExecution?.status, "passed");
	assert.equal(references.length, 2);
});

test("批准引用失败或目录不符时不能启动 Shell", async () => {
	const cwd = await directory();
	const runner = createLocalOperations(cwd, async () => { throw new Error("fixture reference failure"); });
	await assert.rejects(runner.operations.exec("touch forbidden", cwd, { onData() {} }), /reference failure/);
	await assert.rejects(runner.operations.exec("touch forbidden", path.dirname(cwd), { onData() {} }), /目录/);
	await assert.rejects(access(path.join(cwd, "forbidden")), { code: "ENOENT" });
	assert.equal(runner.active, false);
});

for (const kind of ["cancel", "timeout"]) test(`本机 ${kind} 等待 Pi 的执行返回，再交回调用`, async () => {
	const cwd = await directory();
	const runner = createLocalOperations(cwd, async () => {});
	const controller = new AbortController();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const run = runner.operations.exec("printf ready; exec sleep 30", cwd,
		{ timeout: kind === "timeout" ? 0.1 : undefined, signal: controller.signal, onData: () => started() });
	const rejected = assert.rejects(run, kind === "cancel" ? /aborted/ : /timeout/);
	await ready;
	await assert.rejects(runner.operations.exec("true", cwd, { onData() {} }), /尚未交回/);
	if (kind === "cancel") controller.abort();
	await rejected;
	assert.equal(runner.active, false);
	assert.equal(runner.lastExecution?.settled, true);
	assert.equal(runner.lastExecution?.status, kind === "cancel" ? "cancelled" : "timeout");
});
