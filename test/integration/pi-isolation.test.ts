import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { createPiFixture, testEnvironment } from "../support/pi-fixture.ts";

test("测试环境仅构造必要变量，不复制宿主凭证或加载选项", () => {
	const env = testEnvironment("/tmp/fixture");
	assert.equal(env.HOME, "/tmp/fixture/home");
	assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/fixture/agent");
	assert.equal(env.PI_OFFLINE, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.HTTP_PROXY, undefined);
	assert.equal(env.NPM_CONFIG_USERCONFIG, "/dev/null");
});

test("普通 Package 在允许联网、空凭证、拒读真实 HOME 的 Pi 中执行并持久化", { timeout: 40_000 }, async (t) => {
	const server = createServer((socket) => socket.end());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const fixture = await createPiFixture();
	t.after(() => fixture.rpc.stop());
	const { rpc } = fixture;
	t.diagnostic(JSON.stringify({ root: fixture.root, pid: rpc.process.pid }));
	const state = (await rpc.send("get_state")).data;
	assert.equal(state.model.provider, "adaptive-fixture");
	assert.equal(state.messageCount, 0);
	const commands = (await rpc.send("get_commands")).data.commands;
	assert.ok(commands.some((command: any) => command.name === "fixture-isolation"
		&& command.sourceInfo.path === path.join(fixture.packageDir, "provider.ts")));
	assert.ok(!commands.some((command: any) => command.name === "subagent"));
	const cursor = rpc.records.length;
	await rpc.send("prompt", { message: `/fixture-isolation ${address.port}` });
	const report = JSON.parse((await rpc.waitFor((record) => record.type === "extension_ui_request"
		&& record.method === "notify", cursor)).message);
	assert.equal(report.homeAccess, "EPERM");
	assert.equal(report.network, "allowed");
	assert.equal(report.credentials, 0);
	assert.equal(report.calls, 0);
	assert.equal(report.home, path.join(fixture.root, "home"));
	assert.equal(report.pid, rpc.process.pid);
	assert.equal(report.session, state.sessionId);
	assert.equal(execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: fixture.cwd, env: testEnvironment(fixture.root), encoding: "utf8",
	}).trim(), fixture.cwd);
	const from = rpc.records.length;
	await rpc.send("prompt", { message: "读取临时 input.txt，不访问其他数据。" });
	await rpc.waitFor((record) => record.type === "agent_settled", from);
	const tool = rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "read");
	assert.ok(tool && !tool.isError);
	assert.match(JSON.stringify(tool.result.content), /fixture-read-ok/);
	const text = (await rpc.send("get_last_assistant_text")).data.text;
	assert.match(text, /fixture-read-ok/);
	assert.ok(text.includes("\u2028") && text.includes("\u2029"));
	const entries = (await rpc.send("get_entries")).data.entries;
	assert.ok(entries.some((entry: any) => entry.type === "message" && entry.message.role === "toolResult"));
	assert.equal((await readFile(path.join(fixture.cwd, "input.txt"), "utf8")), "fixture-read-ok\n");
	await rpc.stop();
	assert.throws(() => process.kill(report.pid, 0), { code: "ESRCH" });
	const persisted = (await readFile(state.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(persisted[0].id, state.sessionId);
	assert.ok(persisted.some((entry: any) => entry.type === "custom" && entry.customType === "fixture-shutdown"));
	t.diagnostic(JSON.stringify({ root: fixture.root, pid: report.pid, sessionFile: state.sessionFile,
		network: report.network, realHome: report.homeAccess, credentials: 0, exited: true }));
});
