import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPiFixture, FixtureRpc, testEnvironment } from "../support/pi-fixture.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));

test("正式 Package 默认不约束 RPC Shell，shape 后受控，exit 后恢复", { timeout: 30_000 }, async (t) => {
	const f = await createPiFixture(source, undefined, false);
	t.after(() => f.rpc.stop());
	const commands = (await f.rpc.send("get_commands")).data.commands;
	assert.ok(commands.some((command: any) => command.name === "delivery-shape" && command.source === "extension"));
	assert.ok(!commands.some((command: any) => command.name === "delivery-resume"));
	assert.equal((await f.rpc.send("bash", { command: "printf before > normal.txt" })).data.exitCode, 0);
	await f.rpc.send("prompt", { message: "/delivery-status" });
	await f.rpc.send("prompt", { message: "/delivery-shape" });
	assert.equal((await f.rpc.send("bash", { command: "printf blocked > blocked.txt" })).data.exitCode, 1);
	await f.rpc.send("prompt", { message: "/delivery-exit" });
	assert.equal((await f.rpc.send("bash", { command: "printf after >> normal.txt" })).data.exitCode, 0);
	assert.equal(await readFile(path.join(f.cwd, "normal.txt"), "utf8"), "beforeafter");
	await assert.rejects(access(path.join(f.cwd, "blocked.txt")), { code: "ENOENT" });
	await f.rpc.send("prompt", { message: "/delivery-shape" });
	await f.rpc.send("new_session");
	assert.equal((await f.rpc.send("bash", { command: "printf NEW_SESSION" })).data.exitCode, 0);
	t.diagnostic(JSON.stringify({ root: f.root, pid: f.rpc.process.pid }));
});

test("离线 npm tarball 在无 node_modules 的隔离目录加载完整自有资源并执行真实 Pi", { timeout: 40_000 }, async (t) => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adaptive-pack-")));
	const stage = path.join(root, "stage");
	const extracted = path.join(root, "extracted");
	await mkdir(stage);
	await mkdir(extracted);
	const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
	// 仅将 manifest 明确列出的交付资源放入空目录，不带仓库或用户 npm 配置。
	for (const file of ["package.json", ...manifest.files]) {
		await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
		await cp(path.join(source, file), path.join(stage, file), { recursive: true });
	}
	const env = testEnvironment(root);
	env.NPM_CONFIG_USERCONFIG = path.join(root, "empty-user.npmrc");
	env.NPM_CONFIG_GLOBALCONFIG = path.join(root, "empty-global.npmrc");
	await mkdir(env.HOME!);
	const [pack] = JSON.parse(execFileSync("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", root],
		{ cwd: stage, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }));
	const files = pack.files.map((entry: { path: string }) => entry.path);
	for (const file of ["extensions/delivery-gate/src/candidate.ts", "extensions/delivery-gate/src/validation.ts", "extensions/delivery-gate/src/review.ts", "skills/adaptive-delivery/SKILL.md"]) assert.ok(files.includes(file), file);
	assert.ok(!files.some((file: string) => /(^|\/)(node_modules|test|\.git|\.pi|\.npmrc|\.env)(\/|$)/.test(file)));
	const archive = path.join(root, pack.filename);
	execFileSync("tar", ["-xzf", archive, "-C", extracted], { cwd: root, env, timeout: 10_000 });
	const fixture = await createPiFixture(path.join(extracted, "package"));
	t.after(() => fixture.rpc.stop());
	await assert.rejects(access(path.join(fixture.productDir!, "node_modules")), { code: "ENOENT" });
	const commands = (await fixture.rpc.send("get_commands")).data.commands;
	for (const name of ["delivery-status", "delivery-resume", "delivery-shape", "delivery-plan", "delivery-run", "skill:adaptive-delivery"]) assert.ok(commands.some((command: any) => command.name === name));
	await fixture.rpc.send("prompt", { message: "读取 input.txt，验证打包制品加载" });
	await fixture.rpc.waitFor((row) => row.type === "agent_settled");
	assert.match((await fixture.rpc.send("get_last_assistant_text")).data.text, /fixture-read-ok/);
	t.diagnostic(JSON.stringify({ archive, integrity: pack.integrity, files: files.length, fixture: fixture.root, pid: fixture.rpc.process.pid, provider: "fake" }));
});

test("无 node_modules 的正式 Package 加载自身资源并完成真实只读任务", { timeout: 30_000 }, async (t) => {
	const fixture = await createPiFixture(source);
	t.after(() => fixture.rpc.stop());
	const commands = (await fixture.rpc.send("get_commands")).data.commands;
	for (const name of ["delivery-status", "delivery-resume", "delivery-shape", "delivery-plan", "delivery-run", "skill:adaptive-delivery"]) {
		assert.ok(commands.some((command: any) => command.name === name), name);
	}
	assert.ok(!commands.some((command: any) => command.sourceInfo?.path?.includes("pi-subagents")));
	await assert.rejects(access(path.join(fixture.productDir!, "node_modules")), { code: "ENOENT" });
	await fixture.rpc.send("prompt", { message: "读取 input.txt" });
	await fixture.rpc.waitFor((record) => record.type === "agent_settled");
	assert.match((await fixture.rpc.send("get_last_assistant_text")).data.text, /fixture-read-ok/);
	t.diagnostic(JSON.stringify({ root: fixture.root, pid: fixture.rpc.process.pid }));
});

for (const scenario of ["write", "replacement", "delegator-replacement", "approval-replacement", "bash"]) {
	test(`正式只读边界拒绝 ${scenario}，临时目标未写入`, { timeout: 30_000 }, async (t) => {
		const fixture = await createPiFixture(source, scenario === "approval-replacement" ? "approval-design" : undefined);
		t.after(() => fixture.rpc.stop());
		const { rpc } = fixture;
		await rpc.send("get_state");
		if (scenario === "bash") {
			const result = await rpc.send("bash", { command: "printf unexpected > forbidden.txt" });
			assert.equal(result.data.exitCode, 1);
		} else {
			const replacedTool = scenario === "delegator-replacement" ? "delivery_readonly" : scenario === "approval-replacement" ? "delivery_approval" : "read";
			await rpc.send("prompt", { message: scenario === "write" ? "/fixture-activate-write" : `/fixture-replace-tool ${replacedTool}` });
			await rpc.send("prompt", { message: scenario === "write" ? "fixture-attempt-write" : scenario === "delegator-replacement" ? "fixture-delegate" : "读取 input.txt" });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.ok(rpc.records.some((record) => record.type === "tool_execution_end" && record.isError));
			if (scenario === "delegator-replacement" || scenario === "approval-replacement") {
				const result = rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === replacedTool);
				assert.ok(result);
				assert.match(JSON.stringify(result.result), /不在当前已验证/);
			}
		}
		await assert.rejects(access(path.join(fixture.cwd, "forbidden.txt")), { code: "ENOENT" });
		t.diagnostic(JSON.stringify({ root: fixture.root, pid: rpc.process.pid, scenario }));
	});
}

test("标准 CLI 开发入口拒绝无批准 RPC；开发角色标记本身不提供 writer", { timeout: 30_000 }, async (t) => {
	const fixture = await createPiFixture(source, "development-normal");
	t.after(() => fixture.rpc.stop());
	await fixture.rpc.send("prompt", { message: `/fixture-next-tool ${JSON.stringify({ type: "toolCall", id: "unapproved-development", name: "delivery_develop", arguments: { task: "未授权开发" } })}` });
	await fixture.rpc.send("prompt", { message: "执行无批准开发测试" });
	await fixture.rpc.waitFor((row) => row.type === "agent_settled");
	assert.ok(fixture.rpc.records.some((row) => row.type === "tool_execution_end" && row.toolName === "delivery_develop" && row.isError));
	await fixture.rpc.stop();
	const child = new FixtureRpc(fixture.cwd, { ...testEnvironment(fixture.root), ADAPTIVE_FIXTURE_SCENARIO: "development-normal", PI_ADAPTIVE_DELIVERY_CHILD: "development" });
	t.after(() => child.stop());
	await child.send("prompt", { message: "未交接的子进程尝试写入" });
	await child.waitFor((row) => row.type === "agent_settled");
	const result = child.records.find((row) => row.type === "tool_execution_end" && row.toolName === "write");
	assert.equal(result?.isError, true);
	assert.match(JSON.stringify(result.result), /未取得已授权 writer/);
	await assert.rejects(access(path.join(fixture.cwd, "src/value.js")), { code: "ENOENT" });
	await assert.rejects(access(path.join(fixture.cwd, ".git/pi-adaptive-delivery")), { code: "ENOENT" });
	t.diagnostic(JSON.stringify({ root: fixture.root, parentPid: fixture.rpc.process.pid, childPid: child.process.pid }));
});

for (const kind of ["write", "edit"]) for (const boundary of ["rpc", "replacement", "child"]) {
	test(`标准 CLI 正式文档 ${kind} 拒绝 ${boundary}`, { timeout: 30_000 }, async (t) => {
		const fixture = await createPiFixture(source, `document-entry-${kind}`);
		const { rpc } = fixture;
		t.after(() => rpc.stop());
		const state = (await rpc.send("get_state")).data;
		const name = `delivery_document_${kind}`;
		if (boundary === "replacement") await rpc.send("prompt", { message: `/fixture-replace-tool ${name}` });
		await rpc.send("prompt", { message: boundary === "child" ? "fixture-delegate" : "验证父 TUI 之外的文档编辑边界" });
		await rpc.waitFor((record) => record.type === "agent_settled");
		if (boundary === "child") {
			const rows = (await readFile(path.join(fixture.agentDir, "fixture-events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
			const child = rows.find((row) => row.child && row.phase === "start");
			assert.ok(child);
			assert.ok(!child.tools.includes(name));
			assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
		} else {
			const result = rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === name);
			assert.ok(result?.isError);
			assert.match(JSON.stringify(result.result), boundary === "replacement" ? /不在当前已验证/ : /只供父 Pi TUI/);
		}
		const native = await readFile(state.sessionFile, "utf8");
		assert.ok(!native.includes('"customType":"delivery-approval"'));
		for (const file of ["plan.md", "forbidden.txt", ".git/pi-adaptive-delivery"]) {
			await assert.rejects(access(path.join(fixture.cwd, file)), { code: "ENOENT" });
		}
		t.diagnostic(JSON.stringify({ root: fixture.root, pid: rpc.process.pid, kind, boundary }));
	});
}
