import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { containerMounts, createContainerOperations, resolveContainerImage } from "../../extensions/delivery-gate/src/container.ts";
import { resolveWorkspaceIdentity } from "../../extensions/delivery-gate/src/workspace.ts";
import { installFakeDocker } from "../support/fake-docker.ts";

async function host() {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "container-unit-")));
	const cwd = path.join(root, "repo");
	await mkdir(path.join(cwd, "src"), { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd });
	await writeFile(path.join(cwd, "input.json"), "{}\n");
	await writeFile(path.join(cwd, "src/value.js"), "original\n");
	const workspace = await resolveWorkspaceIdentity(cwd);
	const scope = { workspace, readPaths: ["input.json"], writePaths: ["src"], protectedPaths: [path.join(cwd, "plan.md")] };
	return { root, cwd, scope };
}

test("容器挂载保持只读输入、明确可写目录和容器内相对结构", async () => {
	const h = await host();
	const result = await containerMounts(h.scope);
	assert.deepEqual(result, [
		{ source: path.join(h.cwd, "src"), target: "/workspace/src", readonly: false },
		{ source: path.join(h.cwd, "input.json"), target: "/workspace/input.json", readonly: true },
	]);
});

for (const target of [".", "..", ".git", "plan.md", "src/missing.js"]) test(`容器挂载拒绝不明确、受保护或不存在路径 ${target}`, async () => {
	const h = await host();
	await assert.rejects(containerMounts({ ...h.scope, writePaths: [target] }));
});

for (const kind of ["file-symlink", "ancestor-symlink", "nested-symlink", "hardlink", "protected-descendant"]) test(`容器目录挂载不能带入 ${kind}`, async () => {
	const h = await host();
	let writePaths = ["src"];
	if (kind === "file-symlink") { await symlink("src/value.js", path.join(h.cwd, "alias")); writePaths = ["alias"]; }
	if (kind === "ancestor-symlink") { await symlink("src", path.join(h.cwd, "alias")); writePaths = ["alias/value.js"]; }
	if (kind === "nested-symlink") await symlink("../input.json", path.join(h.cwd, "src/link.json"));
	if (kind === "hardlink") await link(path.join(h.cwd, "input.json"), path.join(h.cwd, "src/link.json"));
	if (kind === "protected-descendant") h.scope.protectedPaths.push(path.join(h.cwd, "src/plan.md"));
	await assert.rejects(containerMounts({ ...h.scope, writePaths }));
	assert.equal(await readFile(path.join(h.cwd, "input.json"), "utf8"), "{}\n");
});

test("取消、错误镜像、cwd 或记录失败在创建容器前拒绝，不把它们记成未知容器", async () => {
	const h = await host();
	const image = `sha256:${"a".repeat(64)}`;
	let calls = 0;
	const runner = createContainerOperations({ ...h.scope, image, beforeCreate: async () => { calls++; throw new Error("fixture persistence failure"); } });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(runner.operations.exec("true", h.cwd, { onData() {}, signal: controller.signal }));
	await assert.rejects(runner.operations.exec("true", h.root, { onData() {} }), /工作目录/);
	await assert.rejects(runner.operations.exec("true", h.cwd, { onData() {}, timeout: 301 }), /timeout/);
	assert.equal(calls, 0);
	await assert.rejects(runner.operations.exec("true", h.cwd, { onData() {} }), /persistence failure/);
	assert.equal(calls, 1);
	assert.equal(runner.cleanupFailed, false);
	const other = createContainerOperations({ ...h.scope, image: "node:latest", beforeCreate: async () => {} });
	await assert.rejects(other.operations.exec("true", h.cwd, { onData() {} }), /固定镜像/);
});

for (const scenario of ["image-missing", "image-volume"]) test(`本地镜像 ${scenario} 不拉取或创建容器`, async (t) => {
	const h = await host();
	const fake = await installFakeDocker(t, h.root, scenario);
	await assert.rejects(resolveContainerImage("fixture-image", h.cwd));
	assert.deepEqual(fake.audit().map((row) => row.command), ["image"]);
});

test("Docker 请求输出有界，错误保留且等客户端退出，不启动容器", async (t) => {
	const h = await host();
	const fake = await installFakeDocker(t, h.root, "image-output-limit");
	await assert.rejects(resolveContainerImage("fixture-image", h.cwd), /输出超过 1 MiB/);
	const audit = fake.audit();
	assert.deepEqual(audit.map((row) => row.command), ["image"]);
	assert.throws(() => process.kill(audit[0].pid, 0), { code: "ESRCH" });
});

test("项目内 PATH 同名 Docker 在宿主执行之前拒绝", async (t) => {
	const h = await host();
	const bin = path.join(h.cwd, "bin");
	await mkdir(bin);
	const marker = path.join(h.cwd, "plan.md");
	await writeFile(path.join(bin, "docker"), `#!/bin/sh\nprintf compromised > '${marker}'\n`, { mode: 0o700 });
	const previous = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${previous}`;
	t.after(() => { process.env.PATH = previous; });
	await assert.rejects(resolveContainerImage("fixture-image", h.cwd), /不能执行项目内同名脚本/);
	const runner = createContainerOperations({ ...h.scope, image: `sha256:${"a".repeat(64)}`, beforeCreate: async () => {} });
	await assert.rejects(runner.operations.exec("true", h.cwd, { onData() {} }), /不能执行项目内同名脚本/);
	await assert.rejects(readFile(marker), { code: "ENOENT" });
	assert.equal(runner.cleanupFailed, false);
});

for (const scenario of ["create-error", "create-invalid-id", "identity", "running", "incomplete", "inspect-error", "remove-error"]) test(`容器 ${scenario} 关闭新执行并保留引用`, async (t) => {
	const h = await host();
	const fake = await installFakeDocker(t, h.root, scenario);
	const references: unknown[] = [];
	const runner = createContainerOperations({ ...h.scope, image: `sha256:${"a".repeat(64)}`, beforeCreate: async (ref) => { references.push(ref); } });
	await assert.rejects(runner.operations.exec("true", h.cwd, { onData() {} }));
	assert.equal(runner.cleanupFailed, true);
	assert.equal(runner.lastExecution?.clean, false);
	assert.equal(references.length, 1);
	await assert.rejects(runner.operations.exec("true", h.cwd, { onData() {} }), /状态未知/);
	const audit = fake.audit();
	assert.equal(audit.filter((row) => row.command === "create").length, 1);
	if (scenario !== "remove-error") assert.ok(!audit.some((row) => row.command === "rm"));
});

test("模型提出的镜像名不能成为 Docker 全局选项", async (t) => {
	const h = await host();
	const fake = await installFakeDocker(t, h.root, "normal");
	for (const image of ["--config=/unapproved", "--host=tcp://192.0.2.1:2375", "--context=other"]) {
		await resolveContainerImage(image, h.cwd);
		assert.deepEqual(fake.audit().at(-1).args.slice(-2), ["--", image]);
	}
});

for (const scenario of ["normal", "start-error", "logs-error", "output-error"]) test(`Docker ${scenario} 等待全部客户端关闭后才返回，无宿主环境透传`, async (t) => {
	const h = await host();
	const fake = await installFakeDocker(t, h.root, scenario);
	const runner = createContainerOperations({ ...h.scope, image: `sha256:${"a".repeat(64)}`, beforeCreate: async () => {} });
	const run = runner.operations.exec("true", h.cwd, { onData() { if (scenario === "output-error") throw new Error("fixture output failure"); } });
	if (scenario === "normal") assert.equal((await run).exitCode, 0);
	else await assert.rejects(run);
	assert.equal(runner.lastExecution?.clean, true);
	assert.equal(runner.cleanupFailed, false);
	const audit = fake.audit();
	if (scenario !== "start-error") {
		const ended = audit.findIndex((row) => row.phase === "wait-ended");
		assert.ok(ended >= 0 && ended < audit.findLastIndex((row) => row.command === "inspect"), "不能先检查终态再遗留 wait 客户端");
	}
	const create = audit.find((row) => row.command === "create");
	assert.equal(create.args[create.args.indexOf("--log-driver") + 1], "local");
	assert.ok(create.args.includes("compress=false"));
	assert.ok(audit.every((row) => row.env.every((key: string) => ["PATH", "HOME", "DOCKER_CONFIG", "__CF_USER_TEXT_ENCODING"].includes(key))));
});
