import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPiFixture } from "../support/pi-fixture.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));

test("无 node_modules 的正式 Package 加载自身资源并完成真实只读任务", { timeout: 30_000 }, async (t) => {
	const fixture = await createPiFixture(source);
	t.after(() => fixture.rpc.stop());
	const commands = (await fixture.rpc.send("get_commands")).data.commands;
	for (const name of ["delivery-status", "delivery-shape", "delivery-plan", "delivery-run", "skill:adaptive-delivery"]) {
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
