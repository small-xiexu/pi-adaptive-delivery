import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDevelopmentHost } from "../support/development-host.ts";

test("开发子 Agent 可以使用项目本机工具自检，结果交回父会话", { timeout: 60_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "local-development");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	const result = await h.call("delivery_develop", { task: "把 value 修改为 2，使用项目工具检查结果。" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	const rows = (await h.audit()).filter((row) => row.child && row.phase === "model");
	assert.ok(rows.length > 0);
	assert.equal(await h.readLease(), undefined);
});

test("独立审查子 Agent 读取当前候选并主动执行检查", { timeout: 60_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "local-review");
	await mkdir(path.join(h.cwd, "src"));
	await writeFile(path.join(h.cwd, "src/value.js"), "export const value = 1;\n");
	await h.prepare();
	assert.equal((await h.call("delivery_develop", { task: "把 value 修改为 2。" })).isError, false);
	const result = await h.call("delivery_review", { task: "检查需求和实际差异，运行必要的测试或编译命令。" });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.ok((result.details as any).candidate.digest);
	assert.ok((result.details as any).reviewSessionFile);
	assert.equal(await h.readLease(), undefined);
});
