import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDevelopmentHost as host } from "../support/development-host.ts";
import { COMPLETED_STATUS } from "../../extensions/delivery-gate/src/progress.ts";

test("没有实施批准时不启动开发或审查子 Agent", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	assert.equal((await h.call("delivery_develop", { task: "未批准开发" })).isError, true);
	assert.equal((await h.call("delivery_review", { task: "未批准审查" })).isError, true);
	assert.ok(!(await h.audit()).some((row) => row.child));
});

test("复杂开发由独立子 Agent 完成并核实 writer 收尾", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	await h.prepare();
	const result = await h.call("delivery_develop", { task: "创建 src/value.js，将 value 从 1 改为 2 并读取文件核对。" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal((result.details as any).progress.status, COMPLETED_STATUS);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	assert.equal(await h.readLease(), undefined);
	const child = (await h.audit()).find((row) => row.child && row.phase === "start");
	assert.ok(child);
	assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("审查子 Agent 主动运行检查并独立读取候选差异", { timeout: 60_000 }, async (t) => {
	const h = await host(t, "review-normal");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const developed = await h.call("delivery_develop", { task: "把 src/value.js 的 value 修改为 2，并自行运行适合的项目检查。" });
	assert.equal(developed.isError, false, JSON.stringify(developed));
	const reviewed = await h.call("delivery_review", { task: "核对需求、源码差异，并主动运行相关测试或编译检查。" });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.match(JSON.stringify(reviewed.content), /独立验收和审查/);
	assert.ok((reviewed.details as any).candidate.digest);
	assert.equal(await h.readLease(), undefined);
	const sessions = (await h.audit()).filter((row) => row.child && row.phase === "start");
	assert.equal(sessions.length, 2);
});

test("审查在批准范围内修改后重新记录最终候选", { timeout: 60_000 }, async (t) => {
	const h = await host(t, "review-modifies");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	assert.equal((await h.call("delivery_develop", { task: "把 src/value.js 的 value 修改为 2。" })).isError, false);
	const reviewed = await h.call("delivery_review", { task: "独立检查实现，必要时修复批准范围内的问题。" });
	assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 3;\n");
	assert.ok((reviewed.details as any).candidate.digest);
	assert.ok((reviewed.details as any).diffFile);
	assert.equal(await h.readLease(), undefined);
});

test("实施批准只保存范围和审查输入，不要求固定测试命令", { timeout: 40_000 }, async (t) => {
	const h = await host(t);
	assert.equal((await h.approve("design", [])).isError, false);
	assert.equal((await h.approve("implementation", ["src"], ["README.md"])).isError, false);
	assert.ok(!(await h.audit()).some((row) => JSON.stringify(row).includes("delivery_validate")));
	await assert.rejects(access(path.join(h.cwd, "src")), { code: "ENOENT" });
});
