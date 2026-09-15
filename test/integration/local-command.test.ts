import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDevelopmentHost } from "../support/development-host.ts";

// 真实可执行的项目检查：改动前返回非零，改动后打印标记。夹具必须真的提供它，否则“本机自检”只是缺席后的失败路径。
const PROJECT_CHECK = `const { readFileSync } = require("node:fs");
const source = readFileSync("src/value.js", "utf8");
if (!source.includes("value = 2")) {
  console.error("LOCAL_CHECK_FAILED：" + source.trim());
  process.exit(1);
}
console.log("LOCAL_CHECK_OK：src/value.js 已是 2");
`;

async function seed(cwd: string) {
	await mkdir(path.join(cwd, "src"));
	await mkdir(path.join(cwd, "inputs"));
	await writeFile(path.join(cwd, "src/value.js"), "export const value = 1;\n");
	await writeFile(path.join(cwd, "inputs/command.cjs"), PROJECT_CHECK);
}

test("开发子 Agent 可以使用项目本机工具自检，结果交回父会话", { timeout: 60_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "local-development");
	await seed(h.cwd);
	// 改动前先真实执行一次，证明检查存在且会失败，而不是文件缺席。
	assert.throws(() => execFileSync(process.execPath, ["inputs/command.cjs"], { cwd: h.cwd, stdio: "pipe" }));
	await h.prepare();
	const result = await h.call("delivery_develop", { task: "把 value 修改为 2，使用项目工具检查结果。", paths: ["src"], inputs: ["inputs"] });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	const rows = (await h.audit()).filter((row) => row.child && row.phase === "model");
	assert.ok(rows.length > 0);
	// 子会话回传的记录里必须有项目检查的真实输出。
	assert.match(JSON.stringify(rows), /LOCAL_CHECK_OK/);
	assert.equal(await h.readLease(), undefined);
});

test("独立审查子 Agent 读取当前候选并主动执行检查", { timeout: 60_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "local-review");
	await seed(h.cwd);
	await h.prepare();
	assert.equal((await h.call("delivery_develop", { task: "把 value 修改为 2。", paths: ["src"], inputs: ["inputs"] })).isError, false);
	assert.match(JSON.stringify(await h.audit()), /LOCAL_CHECK_OK/);
	const result = await h.call("delivery_review", { task: "检查需求和实际差异，运行必要的测试或编译命令。", paths: ["src"], inputs: ["inputs"] });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.ok((result.details as any).candidate.digest);
	assert.ok((result.details as any).reviewSessionFile);
	assert.equal(await h.readLease(), undefined);
});
