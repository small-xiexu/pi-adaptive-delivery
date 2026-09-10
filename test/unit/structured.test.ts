import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStructuredCommands } from "../../extensions/delivery-gate/src/structured.ts";

// 后端替身只用于故障注入；本机 Shell、PTY 和补丁的证据见 Structured 专项真实插件测试。
async function fixture(shutdownFails = false) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "structured-unit-")));
	await mkdir(path.join(root, "dist/tools/exec"), { recursive: true });
	await writeFile(path.join(root, "package.json"), '{"type":"module"}');
	await writeFile(path.join(root, "dist/tools/exec/session-manager.js"), `export function createExecSessionManager() { return {
		exec: async () => ({session_id: 42, output:"started", chunk_id:"fixture", wall_time_seconds:0}),
		write: async (input) => { if(input.chars === "fail") throw Error("fixture command failure"); return {exit_code:7, output:"failed", chunk_id:"fixture", wall_time_seconds:0}; },
		shutdown: async () => { ${shutdownFails ? 'throw Error("fixture shutdown failure");' : ""} }
	}; }`);
	let references = 0;
	const runner = createStructuredCommands(root, root, async () => { references++; }, async () => {});
	return { root, runner, references: () => references };
}

test("Structured 一个未交回命令阻止第二次执行，跨会话 ID 被拒绝，真实非零退出保留", async () => {
	const h = await fixture();
	await h.runner.exec("first", { cmd: "fixture" });
	await assert.rejects(h.runner.exec("second", { cmd: "fixture" }), /尚未交回/);
	await assert.rejects(h.runner.stdin({ session_id: 43 }), /不属于/);
	assert.equal(h.runner.active, true);
	await h.runner.stdin({ session_id: 42 });
	assert.equal(h.runner.lastExecution?.exitCode, 7);
	assert.equal(h.runner.lastExecution?.status, "failed");
	assert.equal(h.runner.active, false);
	assert.equal(h.references(), 1);
	assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: false });
});

test("未通过工具取回结果的命令在退出时仍标为 incomplete", async () => {
	const h = await fixture();
	await h.runner.exec("first", { cmd: "fixture" });
	assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: true });
	await assert.rejects(h.runner.exec("late", { cmd: "fixture" }), /关闭/);
});

for (const failure of [false, true]) test(`Structured 调用失败后等待后端关闭，关闭${failure ? "失败" : "成功"}如实记录`, async () => {
	const h = await fixture(failure);
	await h.runner.exec("first", { cmd: "fixture" });
	await assert.rejects(h.runner.stdin({ session_id: 42, chars: "fail" }), failure ? /shutdown failure/ : /command failure/);
	assert.equal(h.runner.cleanupFailed, failure);
	await assert.rejects(h.runner.exec("late", { cmd: "fixture" }), /关闭/);
	if (failure) await assert.rejects(h.runner.finish(), /shutdown failure/);
	else assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: false });
});
