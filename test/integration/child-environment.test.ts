import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPiFixture } from "../support/pi-fixture.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));

test("项目显式启用查找工具后，真实父子保留 read/grep/find/ls 并实际查找读回", { timeout: 40_000 }, async (t) => {
	const fixture = await createPiFixture(source, "readonly-search");
	const { rpc } = fixture;
	t.after(() => rpc.stop());
	await rpc.send("prompt", { message: "/delivery-status" });
	const status = rpc.records.find((row) => row.type === "extension_ui_request" && row.method === "notify" && row.message.includes("只读工具"));
	assert.match(status?.message, /read.*grep.*find.*ls/);
	assert.ok(!status?.message.includes("defaultTools"), "已经启用查找工具时不再提示配置");
	await rpc.send("prompt", { message: "fixture-delegate" });
	await rpc.waitFor((row) => row.type === "agent_settled");
	const result = rpc.records.find((row) => row.type === "tool_execution_end" && row.toolName === "delivery_readonly");
	assert.equal(result?.isError, false, JSON.stringify(result));
	const rows = (await readFile(result!.result.details.sessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	const tools = rows.filter((row) => row.type === "message" && row.message.role === "toolResult").map((row) => row.message);
	assert.deepEqual(tools.map((row) => row.toolName), ["ls", "find", "grep", "read"]);
	assert.ok(tools.every((row) => row.isError === false));
	assert.ok(tools.every((row) => /input.txt|fixture-read-ok/.test(JSON.stringify(row.content))));
	const model = (await readFile(path.join(fixture.agentDir, "fixture-events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line)).filter((row) => row.phase === "model");
	for (const row of model) for (const name of ["read", "grep", "find", "ls"]) assert.ok(row.tools.includes(name));
	assert.ok(model.every((row) => !row.tools.includes("bash") && !row.tools.includes("write")));
	assert.throws(() => process.kill(result!.result.details.pid, 0), { code: "ESRCH" });
	t.diagnostic(JSON.stringify({ root: fixture.root, parentPid: rpc.process.pid, childPid: result!.result.details.pid }));
});

test("真实父调用固定 Git 状态入口，保留既有改动并拒绝参数与同名覆盖", { timeout: 40_000 }, async (t) => {
	const fixture = await createPiFixture(source);
	const { rpc } = fixture;
	t.after(() => rpc.stop());
	const invoke = async (id: string, args: unknown) => {
		await rpc.send("prompt", { message: `/fixture-next-tool ${JSON.stringify({ type: "toolCall", id, name: "delivery_git_status", arguments: args })}` });
		const cursor = rpc.records.length;
		await rpc.send("prompt", { message: "核对 Git 现状" });
		await rpc.waitFor((row) => row.type === "agent_settled", cursor);
		return rpc.records.slice(cursor).find((row) => row.type === "tool_execution_end" && row.toolName === "delivery_git_status")!;
	};
	const result = await invoke("git-status", {});
	assert.equal(result.isError, false);
	assert.equal(result.result.details.head, null);
	assert.equal(result.result.details.workspace, fixture.cwd);
	assert.ok(result.result.details.changes.some((row: any) => row.path === "input.txt" && row.status === "??"));
	assert.equal((await invoke("git-args", { command: "touch forbidden.txt" })).isError, true);
	await rpc.send("prompt", { message: "/fixture-replace-tool delivery_git_status" });
	assert.equal((await invoke("git-replacement", {})).isError, true);
	assert.equal(await readFile(path.join(fixture.cwd, "input.txt"), "utf8"), "fixture-read-ok\n");
	await assert.rejects(access(path.join(fixture.cwd, "forbidden.txt")), { code: "ENOENT" });
	t.diagnostic(JSON.stringify({ root: fixture.root, parentPid: rpc.process.pid }));
});

for (const scenario of ["normal", "rules-missing", "instructions-missing", "skills-missing", "tool-replaced", "hook-deny", "hook-error"]) {
	test(`真实 Pi 按配置重建只读环境：${scenario}`, { timeout: 40_000 }, async (t) => {
		const fixture = await createPiFixture(source, `environment-${scenario}`);
		const { rpc } = fixture;
		t.after(() => rpc.stop());
		const parent = (await rpc.send("get_state")).data;
		await rpc.send("prompt", { message: "/fixture-parent-history" });
		await rpc.send("prompt", { message: "fixture-delegate" });
		await rpc.waitFor((record) => record.type === "agent_settled");
		const result = rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "delivery_readonly");
		assert.ok(result);
		assert.equal(result.isError, scenario !== "normal", JSON.stringify(result.result));
		const entries = (await rpc.send("get_entries")).data.entries;
		const ended = entries.findLast((entry: any) => entry.customType === "delivery-delegation" && entry.data.phase === "ended")?.data;
		assert.ok(ended?.pid);
		assert.equal(ended.status, scenario === "normal" ? "completed" : "failed");
		assert.throws(() => process.kill(ended.pid, 0), { code: "ESRCH" });
		const events = (await readFile(path.join(fixture.agentDir, "fixture-events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
		const child = events.filter((event) => event.child);
		const model = child.filter((event) => event.phase === "model");
		if (scenario.endsWith("missing") || scenario === "tool-replaced") {
			assert.equal(model.length, 0, "环境不符时不调用子模型");
			assert.ok(!entries.some((entry: any) => entry.customType === "delivery-delegation" && entry.data.phase === "started"));
			const reason = scenario === "rules-missing" ? /规则未对齐/ : scenario === "instructions-missing" ? /基础指令未对齐/
				: scenario === "tool-replaced" ? /只读工具定义或来源未对齐/ : /Skills.*未对齐/;
			assert.match(ended.error, reason);
			assert.match(ended.error, /未发送任务/);
			if (scenario === "tool-replaced") {
				const replacement = child.find((event) => event.phase === "environment-read-replaced");
				assert.ok(replacement?.sourceInfo);
				assert.notEqual(replacement.sourceInfo.source, "builtin");
				assert.equal(replacement.sourceInfo.path, path.join(fixture.packageDir, "provider.ts"));
			}
		} else if (scenario === "hook-error") {
			assert.match(ended.error, /已记录的工具失败/);
			assert.equal(model.length, 2);
			const failed = model[1].messages.find((message: any) => message.role === "toolResult");
			assert.equal(failed?.isError, true);
			assert.match(JSON.stringify(failed.content), /CONFIGURED_TOOL_HOOK_ERROR/);
			assert.equal(child.filter((event) => event.phase === "environment-tool-call").length, 1);
			assert.ok(!model.some((request) => JSON.stringify(request.messages).includes("fixture-read-ok")));
		} else {
			assert.equal(model.length, scenario === "normal" ? 3 : 2);
			assert.equal(child.filter((event) => event.phase === "environment-before-agent").length, 1);
			assert.equal(child.filter((event) => event.phase === "environment-context").length, model.length);
			for (const request of model) {
				for (const marker of ["BASE_ENVIRONMENT_INSTRUCTION", "GLOBAL_ENVIRONMENT_RULE", "PROJECT_ENVIRONMENT_RULE", "ENVIRONMENT_SKILL_DESCRIPTION", "CONFIGURED_BEFORE_AGENT_HOOK"]) {
					assert.match(request.systemPrompt, new RegExp(marker));
				}
				const messages = JSON.stringify(request.messages);
				assert.match(messages, /CHILD_CONTEXT_HOOK/);
				assert.ok(!messages.includes("PARENT_CONTEXT_HOOK"));
				assert.equal(request.parentMarkerSeen, false);
				assert.deepEqual(request.tools, ["read"]);
			}
			const calls = child.filter((event) => event.phase === "environment-tool-call");
			assert.equal(calls.length, scenario === "normal" ? 2 : 1);
			assert.equal(new Set(calls.map((call) => call.toolCallId)).size, calls.length);
			const results = child.filter((event) => event.phase === "environment-tool-result");
			if (scenario === "normal") {
				assert.deepEqual(results.map((item) => item.toolCallId), calls.map((item) => item.toolCallId));
				assert.match(JSON.stringify(model[1].messages), /fixture-read-ok.*CONFIGURED_RESULT_HOOK/s);
				assert.match(JSON.stringify(model[2].messages), /ENVIRONMENT_SKILL_BODY.*CONFIGURED_RESULT_HOOK/s);
				assert.match(JSON.stringify(result.result), /ENVIRONMENT_SKILL_BODY/);
			} else {
				assert.match(JSON.stringify(model[1].messages), /CONFIGURED_TOOL_HOOK_DENIED/);
				assert.ok(!JSON.stringify(model[1].messages).includes("fixture-read-ok"));
			}
			const childLog = await readFile(ended.sessionFile, "utf8");
			assert.match(childLog, /fixture-child-tool-check/);
			assert.ok(!childLog.includes("PARENT_ONLY_HISTORY_SENTINEL"));
			const parentLog = await readFile(parent.sessionFile, "utf8");
			assert.ok(!parentLog.includes('"customType":"fixture-child-tool-check"'));
			assert.ok(!parentLog.includes("CHILD_CONTEXT_HOOK"));
		}
		assert.equal(await readFile(path.join(fixture.cwd, "input.txt"), "utf8"), "fixture-read-ok\n");
		await assert.rejects(access(path.join(fixture.cwd, "forbidden.txt")), { code: "ENOENT" });
		t.diagnostic(JSON.stringify({ root: fixture.root, parentPid: rpc.process.pid, childPid: ended.pid, scenario }));
	});
}
