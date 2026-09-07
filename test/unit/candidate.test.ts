import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureCandidate } from "../../extensions/delivery-gate/src/candidate.ts";
import { resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";

async function host() {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "candidate-unit-")));
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	await mkdir(path.join(root, "src"));
	await mkdir(path.join(root, "inputs"));
	await writeFile(path.join(root, "src/value.js"), "export const value = 1;\n");
	await writeFile(path.join(root, "inputs/check.js"), "console.log(1);\n");
	await writeFile(path.join(root, "plan.md"), "原始台账\n");
	const scope = { workspace: await resolveWorkspaceIdentity(root), image: `sha256:${"a".repeat(64)}`,
		readPaths: ["inputs"], writePaths: ["src"], protectedPaths: [path.join(root, "plan.md")] };
	return { root, scope, commands: ["node inputs/check.js"], capture: () => captureCandidate(scope, ["node inputs/check.js"]) };
}

test("候选来自实际输入/源码内容及元数据，重复读取稳定且不读取规划文档", async () => {
	const h = await host();
	const before = await h.capture();
	assert.deepEqual(before.files, ["inputs/check.js", "src/value.js"]);
	assert.match(before.digest, /^[a-f0-9]{64}$/);
	await writeFile(path.join(h.root, "plan.md"), "父更新进度\n");
	assert.deepEqual(await h.capture(), before);
	assert.equal(await readFile(path.join(h.root, "src/value.js"), "utf8"), "export const value = 1;\n");
});

for (const kind of ["source", "test", "new-file", "delete", "rename", "mode", "same-content-rewrite", "image", "command", "command-order", "mount-mode", "cwd"]) {
	test(`候选 ${kind} 变化使原指纹失效`, async () => {
		const h = await host();
		const original = await captureCandidate(h.scope, ["first", "second"]);
		let commands = ["first", "second"];
		const file = path.join(h.root, "src/value.js");
		if (kind === "source") await writeFile(file, "export const value = 2;\n");
		if (kind === "test") await writeFile(path.join(h.root, "inputs/check.js"), "console.log(2);\n");
		if (kind === "new-file") await writeFile(path.join(h.root, "src/generated.js"), "构建产物也不能任意排除\n");
		if (kind === "delete") await rm(file);
		if (kind === "rename") await rename(file, path.join(h.root, "src/renamed.js"));
		if (kind === "mode") await chmod(file, 0o700);
		if (kind === "same-content-rewrite") await writeFile(file, await readFile(file));
		if (kind === "image") h.scope.image = `sha256:${"b".repeat(64)}`;
		if (kind === "command") commands = ["changed", "second"];
		if (kind === "command-order") commands.reverse();
		if (kind === "mount-mode") h.scope.writePaths.push("inputs");
		if (kind === "cwd") {
			h.scope.workspace.cwdPath = path.join(h.root, "src");
			h.scope.readPaths = ["../inputs"];
			h.scope.writePaths = ["."];
		}
		assert.notEqual((await captureCandidate(h.scope, commands)).digest, original.digest);
	});
}

for (const kind of ["protected", "symlink", "hardlink", "cancel"]) test(`候选 ${kind} 无有效指纹，不放宽挂载边界`, async () => {
	const h = await host();
	const controller = new AbortController();
	if (kind === "protected") h.scope.readPaths.push("plan.md");
	if (kind === "symlink") await symlink("../plan.md", path.join(h.root, "src/alias"));
	if (kind === "hardlink") await link(path.join(h.root, "plan.md"), path.join(h.root, "src/alias"));
	if (kind === "cancel") controller.abort(new Error("fixture candidate cancel"));
	await assert.rejects(captureCandidate(h.scope, h.commands, controller.signal));
});
