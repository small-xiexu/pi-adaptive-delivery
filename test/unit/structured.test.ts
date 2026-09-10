import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStructuredCommands, structuredPackage } from "../../extensions/delivery-gate/src/structured.ts";

test("识别 Structured 不要求所有工具存在，也不因未验收版本阻止普通能力", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "structured-metadata-")));
	await mkdir(path.join(root, "dist"));
	const entry = path.join(root, "dist/index.js");
	await writeFile(entry, "export default () => {};\n");
	await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@howaboua/pi-codex-conversion", version: "fixture-unverified" }));
	const tools: any[] = [{ name: "exec_command", sourceInfo: { path: entry } }, { name: "apply_patch", sourceInfo: { path: "/fixture/other-plugin.ts" } }];
	const result = await structuredPackage(tools);
	assert.equal(result?.version, "fixture-unverified");
	assert.deepEqual(result?.tools, tools);
});

// 后端替身只用于故障注入；本机 Shell、PTY 和补丁的证据见 Structured 专项真实插件测试。
async function fixture(shutdownFails = false) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "structured-unit-")));
	await mkdir(path.join(root, "dist/tools/exec"), { recursive: true });
	await writeFile(path.join(root, "package.json"), '{"type":"module"}');
	await writeFile(path.join(root, "dist/tools/exec/session-manager.js"), `export function createExecSessionManager() { return {
		exec: async (input) => {
			if (!input.wait_until_exit) throw Error("must wait for final exit");
			if (input.cmd === "fail") throw Error("fixture command failure");
			return { ...(input.cmd === "running" ? {session_id:42} : {exit_code:7}), output:"fixture", chunk_id:"fixture", wall_time_seconds:0};
		},
		shutdown: async () => { ${shutdownFails ? 'throw Error("fixture shutdown failure");' : ""} }
	}; }`);
	let references = 0;
	const runner = createStructuredCommands(root, root, async () => { references++; });
	return { root, runner, references: () => references };
}

test("Structured 固定验收等待退出并保留真实非零结果", async () => {
	const h = await fixture();
	await h.runner.exec("first", { cmd: "fixture" });
	assert.equal(h.runner.lastExecution?.exitCode, 7);
	assert.equal(h.runner.lastExecution?.status, "failed");
	assert.equal(h.runner.active, false);
	assert.equal(h.references(), 1);
	assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: false });
});

test("未通过工具取回结果的命令在退出时仍标为 incomplete", async () => {
	const h = await fixture();
	await h.runner.exec("first", { cmd: "running" });
	await assert.rejects(h.runner.exec("second", { cmd: "fixture" }), /尚未交回/);
	assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: true });
	await assert.rejects(h.runner.exec("late", { cmd: "fixture" }), /关闭/);
});

for (const failure of [false, true]) test(`Structured 调用失败后等待后端关闭，关闭${failure ? "失败" : "成功"}如实记录`, async () => {
	const h = await fixture(failure);
	await assert.rejects(h.runner.exec("first", { cmd: "fail" }), failure ? /shutdown failure/ : /command failure/);
	assert.equal(h.runner.cleanupFailed, failure);
	await assert.rejects(h.runner.exec("late", { cmd: "fixture" }), /关闭/);
	if (failure) await assert.rejects(h.runner.finish(), /shutdown failure/);
	else assert.deepEqual(await h.runner.finish(), { clean: true, incomplete: false });
});
