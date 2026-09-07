import assert from "node:assert/strict";
import { access, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPiFixture, FixtureRpc, testEnvironment } from "../support/pi-fixture.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));
type Fixture = Awaited<ReturnType<typeof createPiFixture>>;
async function audit(fixture: Fixture) {
	return (await readFile(path.join(fixture.agentDir, "fixture-events.jsonl"), "utf8")).trimEnd().split("\n").map((row) => JSON.parse(row));
}
async function waitAudit(fixture: Fixture, phase: string) {
	for (let i = 0; i < 300; i++) { const result = (await audit(fixture)).findLast((row) => row.phase === phase); if (result) return result; await setTimeout(25); }
	throw new Error(`等待夹具证据超时：${phase}`);
}
async function prompt(fixture: Fixture) {
	const from = fixture.rpc.records.length;
	await fixture.rpc.send("prompt", { message: "执行本轮父 writer 测试" });
	await fixture.rpc.waitFor((record) => record.type === "agent_settled", from);
}

for (const scenario of ["normal", "denied", "missing", "tamper", "partial", "close", "persistence", "lock"]) {
	test(`真实 Pi 原生工具终态与父 writer：${scenario}`, { timeout: 30_000 }, async (t) => {
		const fixture = await createPiFixture(source, `writer-${scenario}`);
		t.after(() => fixture.rpc.stop());
		await prompt(fixture);
		const rows = await audit(fixture);
		const executed = rows.find((row) => row.phase === "writer-tool-result");
		assert.ok(executed?.lease);
		assert.equal(executed.lease.owner.runId, executed.toolCallId);
		const settled = await waitAudit(fixture, "writer-settled");
		const retained = ["missing", "tamper", "close", "persistence", "lock"].includes(scenario);
		assert.equal(settled.pending, retained);
		assert.equal(Boolean(settled.lease), retained && scenario !== "lock");
		const file = (await fixture.rpc.send("get_state")).data.sessionFile;
		if (scenario === "persistence") await chmod(file, 0o600);
		const native = (await readFile(file, "utf8")).trimEnd().split("\n").map((row) => JSON.parse(row));
		if (scenario === "persistence") {
			assert.equal(native.some((row) => row.message?.role === "toolResult" && row.message.toolCallId === executed.toolCallId), false);
			assert.equal(rows.some((row) => row.phase === "writer-turn-end"), false);
		}
		assert.equal(native.some((row) => row.customType === "delivery-approval"), false, "批准来源是测试替身，不冒充 TUI");
		if (scenario === "partial") assert.equal(await readFile(path.join(fixture.cwd, "plan.md"), "utf8"), "部分内容");
		if (scenario === "lock") {
			assert.ok((await audit(fixture)).some((row) => row.phase === "writer-lock-cleanup-failed"));
			await access(path.join(fixture.cwd, ".git/pi-adaptive-delivery/leases", `${executed.lease.workspace.key}.operation-lock`));
		}
		if (scenario === "normal") {
			await prompt(fixture);
			assert.equal((await audit(fixture)).filter((row) => row.phase === "writer-tool-result").length, 2);
			assert.equal((await audit(fixture)).findLast((row) => row.phase === "writer-turn-end").pending, false);
		}
		t.diagnostic(JSON.stringify({ root: fixture.root, pid: fixture.rpc.process.pid, scenario, retained }));
	});
}

test("两个真实 Pi 使用不同 agent dir 争抢同一 worktree，取消收尾后才交回", { timeout: 30_000 }, async (t) => {
	const first = await createPiFixture(source, "writer-wait");
	t.after(() => first.rpc.stop());
	const second = await createPiFixture(source, "writer-normal");
	await second.rpc.send("get_state");
	await second.rpc.stop();
	second.rpc = new FixtureRpc(first.cwd, { ...testEnvironment(second.root), ADAPTIVE_FIXTURE_SCENARIO: "writer-normal" });
	t.after(() => second.rpc.stop());
	await first.rpc.send("prompt", { message: "等待取消的父写入" });
	await waitAudit(first, "writer-io-pending");
	await prompt(second);
	const denied = (await audit(second)).find((row) => row.phase === "writer-tool-result");
	assert.equal(denied.isError, true);
	assert.equal(denied.lease.owner.pid, first.rpc.process.pid);
	await first.rpc.send("abort");
	await first.rpc.waitFor((record) => record.type === "agent_settled");
	const finished = await waitAudit(first, "writer-turn-end");
	assert.equal(finished.pending, false);
	assert.equal(finished.lease, undefined);
	const firstRows = await audit(first);
	assert.ok(firstRows.findIndex((row) => row.phase === "writer-handle-closed") < firstRows.findIndex((row) => row.phase === "writer-tool-result"));
	await prompt(second);
	assert.equal((await audit(second)).findLast((row) => row.phase === "writer-tool-result").isError, false);
	assert.equal(await readFile(path.join(first.cwd, "plan.md"), "utf8"), `父 writer ${second.rpc.process.pid}\n`);
	t.diagnostic(JSON.stringify({ first: first.root, second: second.root, pids: [first.rpc.process.pid, second.rpc.process.pid] }));
});

test("真实 reload 不恢复未知 writer 或重放原工具", { timeout: 30_000 }, async (t) => {
	const fixture = await createPiFixture(source, "writer-missing");
	t.after(() => fixture.rpc.stop());
	await prompt(fixture);
	const previous = (await audit(fixture)).findLast((row) => row.phase === "writer-turn-end").lease;
	assert.ok(previous);
	await fixture.rpc.send("prompt", { message: "/fixture-writer-reload" });
	await prompt(fixture);
	const latest = (await audit(fixture)).findLast((row) => row.phase === "writer-tool-result");
	assert.equal(latest.isError, true);
	assert.equal(latest.lease.leaseId, previous.leaseId);
	t.diagnostic(JSON.stringify({ root: fixture.root, pid: fixture.rpc.process.pid, leaseId: previous.leaseId }));
});
