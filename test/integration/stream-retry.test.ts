import assert from "node:assert/strict";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createDevelopmentHost } from "../support/development-host.ts";
import { createPiFixture } from "../support/pi-fixture.ts";

const errors = (rows: any[]) => rows.filter((row) => row.message?.role === "assistant" && row.message.stopReason === "error");
const disk = async (file: string) => (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
const inject = (h: Awaited<ReturnType<typeof createDevelopmentHost>>, remaining = 1, afterTools = 0, message = "stream_read_error") =>
	h.session.prompt(`/fixture-stream-error ${JSON.stringify({ message, remaining, afterTools })}`);

test("真实 SDK 父断流自动续跑：已完成文档写入不重放，半截调用不执行，批准不重复", async (t) => {
	const h = await createDevelopmentHost(t, "stream-retry-parent");
	await h.approve("documents", ["plan.md"]);
	const events: any[] = [];
	h.session.subscribe((event) => events.push(event));
	await inject(h, 1, 1);
	const result = await h.call("delivery_document_write", { path: "plan.md", content: "只写一次\n" });
	assert.equal(result.isError, false);
	assert.equal(events.filter((event) => event.type === "auto_retry_start").length, 1);
	assert.ok(events.some((event) => event.type === "auto_retry_end" && event.success));
	const rows = await disk(h.sm.getSessionFile()!);
	assert.equal(errors(rows).length, 1);
	assert.match(errors(rows)[0].message.errorMessage, /^stream_read_error\n/);
	assert.equal(rows.filter((row) => row.message?.role === "toolResult" && row.message.toolName === "delivery_document_write").length, 1);
	assert.ok(!rows.some((row) => row.message?.role === "toolResult" && row.message.toolCallId === "incomplete-stream-call"));
	assert.equal(rows.at(-1).message.stopReason, "stop");
	assert.equal(events.filter((event) => event.type === "message_end" && event.message.role === "user").length, 1);
	assert.equal(h.choices.length, 1);
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "只写一次\n");
	await assert.rejects(access(path.join(h.cwd, "src/incomplete.txt")), { code: "ENOENT" });
	assert.equal(await h.readLease(), undefined);
});

for (const kind of ["exhausted", "disabled", "other-error"]) test(`真实 SDK 父断流边界：${kind}`, async (t) => {
	const h = await createDevelopmentHost(t, "stream-retry-parent");
	if (kind === "disabled") h.session.setAutoRetryEnabled(false);
	const events: any[] = [];
	h.session.subscribe((event) => events.push(event));
	await inject(h, 10, 0, kind === "other-error" ? "invalid_api_key" : "stream_read_error");
	await h.session.prompt("验证原生重试上限");
	const count = kind === "exhausted" ? 3 : 1;
	assert.equal(errors(await disk(h.sm.getSessionFile()!)).length, count);
	assert.equal(events.filter((event) => event.type === "auto_retry_start").length, count - 1);
	assert.deepEqual(events.filter((event) => event.type === "auto_retry_start").map((event) => event.delayMs), count === 3 ? [80, 160] : []);
	assert.equal(h.session.isIdle, true);
	assert.equal(h.choices.length, 0);
	assert.equal(await h.readLease(), undefined);
});

for (const kind of ["cancel", "reload"]) test(`真实 SDK 父在重试等待期间 ${kind} 后无迟到续跑`, async (t) => {
	const h = await createDevelopmentHost(t, "stream-retry-parent");
	await inject(h, 10);
	let waiting!: () => void;
	const ready = new Promise<void>((resolve) => { waiting = resolve; });
	h.session.subscribe((event) => { if (event.type === "auto_retry_start") queueMicrotask(waiting); });
	const run = h.session.prompt("在原生退避期间停止");
	await ready;
	if (kind === "reload") await h.session.reload();
	else await h.session.abort();
	await run;
	await setTimeout(200);
	assert.equal((await h.audit()).filter((row) => row.phase === "stream-error").length, 1);
	assert.equal(h.session.isIdle, true);
	assert.equal(h.session.isRetrying, false);
});

test("真实 SDK 父错误消息写盘失败不进入自动重试", async (t) => {
	let file: string | undefined;
	const h = await createDevelopmentHost(t, "stream-retry-parent", (pi) => {
		pi.on("message_end", async (event, ctx) => {
			if (event.message.role === "assistant" && event.message.stopReason === "error") {
				file = ctx.sessionManager.getSessionFile();
				await chmod(file!, 0o400);
			}
		});
	});
	await h.session.prompt("先建立可写的原生 Session");
	await inject(h);
	try {
		await assert.rejects(h.session.prompt("写盘故障"), { code: "EACCES" });
		assert.equal((await h.audit()).filter((row) => row.phase === "stream-error").length, 1);
		assert.equal(h.session.isRetrying, false);
	} finally { if (file) await chmod(file, 0o600); }
});

for (const kind of ["once", "exhausted", "disabled"]) test(`真实开发 CLI 子断流 ${kind}：父等待稳定终态，writer 只在收尾核验后交回`, { timeout: 40_000 }, async (t) => {
	const h = await createDevelopmentHost(t, `stream-retry-${kind}`);
	if (kind === "disabled") h.session.setAutoRetryEnabled(false);
	await h.prepare();
	const result = await h.call("delivery_develop", { task: "创建、编辑并读回 src/value.js，断流后沿原记录继续。" });
	assert.equal(result.isError, kind !== "once", JSON.stringify(result));
	const ref = h.sm.getBranch().findLast((row) => row.type === "custom" && row.customType === "delivery-development") as any;
	const rows = await disk(ref.data.childSessionFile);
	assert.equal(errors(rows).length, kind === "exhausted" ? 3 : 1);
	const tools = rows.filter((row) => row.message?.role === "toolResult").map((row) => row.message);
	assert.deepEqual(tools.map((tool) => tool.toolName), kind !== "once" ? ["write"] : ["write", "edit", "read"]);
	assert.ok(tools.every((tool) => !tool.isError));
	const exit = rows.findLast((row) => row.customType === "delivery-child-exit");
	assert.equal(exit.data.development.clean, true);
	assert.throws(() => process.kill(exit.data.pid, 0), { code: "ESRCH" });
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal(h.choices.length, 3);
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), `export const value = ${kind !== "once" ? 1 : 2};\n`);
	await assert.rejects(access(path.join(h.cwd, "src/incomplete.txt")), { code: "ENOENT" });
});

test("真实只读 CLI 子断流恢复，原读取和委派各执行一次", { timeout: 40_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "stream-retry-once");
	const result = await h.call("delivery_readonly", { task: "读取 input.txt 后提供结论" });
	assert.equal(result.isError, false, JSON.stringify(result));
	const ref = h.sm.getBranch().findLast((row) => row.type === "custom" && row.customType === "delivery-delegation") as any;
	const rows = await disk(ref.data.sessionFile);
	assert.equal(errors(rows).length, 1);
	assert.deepEqual(rows.filter((row) => row.message?.role === "toolResult").map((row) => row.message.toolName), ["read"]);
	assert.equal(rows.findLast((row) => row.message?.role === "assistant").message.stopReason, "stop");
	assert.equal((await h.audit()).filter((row) => row.phase === "start" && row.child).length, 1);
	assert.equal(h.choices.length, 0);
});

test("真实开发 CLI 子退避中取消，不再编辑且正常交回 writer", { timeout: 40_000 }, async (t) => {
	const h = await createDevelopmentHost(t, "stream-retry-once", undefined, async (fixture) => {
		const file = path.join(fixture.agentDir, "settings.json");
		const settings = JSON.parse(await readFile(file, "utf8"));
		settings.retry.baseDelayMs = 1500;
		await writeFile(file, JSON.stringify(settings));
	});
	await h.prepare();
	const run = h.call("delivery_develop", { task: "创建文件，在重试等待期间取消" });
	const deadline = Date.now() + 15_000;
	while (!(await h.audit()).some((row) => row.child && row.phase === "stream-error")) {
		assert.ok(Date.now() < deadline, "未观察到子断流");
		await setTimeout(10);
	}
	assert.equal((await h.readLease())?.owner.kind, "child", "重试期间不能提前交回 writer");
	await h.session.abort();
	assert.equal((await run).isError, true);
	await setTimeout(1600);
	const audit = await h.audit();
	assert.deepEqual(audit.filter((row) => row.child && row.phase === "environment-tool-call").map((row) => row.toolName), ["write"]);
	for (const start of audit.filter((row) => row.child && row.phase === "start")) assert.throws(() => process.kill(start.pid, 0), { code: "ESRCH" });
	assert.equal(await h.readLease(), undefined, h.notices.join("\n"));
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 1;\n");
});

test("真实父 CLI 退避期间 SIGTERM 退出，不留下迟到请求", { timeout: 20_000 }, async (t) => {
	const h = await createPiFixture(fileURLToPath(new URL("../../", import.meta.url)), "stream-retry-exit");
	t.after(() => h.rpc.stop());
	await h.rpc.send("prompt", { message: `/fixture-stream-error ${JSON.stringify({ message: "stream_read_error", remaining: 10, afterTools: 0 })}` });
	await h.rpc.send("prompt", { message: "退避期间退出" });
	await h.rpc.waitFor((row) => row.type === "auto_retry_start");
	const state = (await h.rpc.send("get_state")).data;
	await h.rpc.stop();
	assert.deepEqual(await h.rpc.closed, { code: 143, signal: null }, "Pi 的 SIGTERM handler 先清理，再以 128+15 退出");
	assert.throws(() => process.kill(h.rpc.process.pid!, 0), { code: "ESRCH" });
	assert.ok((await disk(state.sessionFile)).some((row) => row.customType === "fixture-shutdown"));
	const events = await disk(path.join(h.agentDir, "fixture-events.jsonl"));
	assert.equal(events.filter((row) => row.phase === "stream-error").length, 1);
});
