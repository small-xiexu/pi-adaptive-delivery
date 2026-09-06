import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { ChildRpc, delegateReadOnly } from "../../extensions/delivery-gate/src/subagents.ts";

function fixture() {
	const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
		pid: 123, kill: (_signal: string) => { process.emit("close", 0, null); return true; } });
	const rpc = new ChildRpc(process as unknown as ChildProcessWithoutNullStreams);
	const requests: any[] = [];
	process.stdin.on("data", (chunk) => requests.push(JSON.parse(chunk.toString())));
	return { rpc, process, requests, emit: (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`) };
}

test("严格 JSONL 保留跨 Buffer 的 UTF-8 与 Unicode 分隔符", async () => {
	const { rpc, process, requests } = fixture();
	const result = rpc.request<{ text: string }>({ type: "get_last_assistant_text" });
	const text = "中文✅\u2028不分行\u2029";
	const bytes = Buffer.from(`${JSON.stringify({ type: "response", command: "get_last_assistant_text", id: requests[0].id, success: true, data: { text } })}\n`);
	for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
	assert.deepEqual(await result, { text });
	process.emit("close", 0, null);
});

test("无关响应不能完成当前请求，匹配响应中的失败必须抛出", async () => {
	const { rpc, process, requests, emit } = fixture();
	let finished = false;
	const result = rpc.request({ type: "get_state" }).finally(() => { finished = true; });
	emit({ type: "response", id: "unrelated", command: "get_state", success: true });
	await Promise.resolve();
	assert.equal(finished, false);
	const rejection = assert.rejects(result, /拒绝/);
	emit({ type: "response", id: requests[0].id, command: "get_state", success: false, error: "fixture" });
	await rejection;
	process.emit("close", 0, null);
});

for (const kind of ["malformed", "mismatch", "truncated", "exit", "error"]) {
	test(`协议或连接异常 ${kind} 不返回成功`, async () => {
		const { rpc, process, requests, emit } = fixture();
		const rejection = assert.rejects(rpc.request({ type: "get_state" }));
		if (kind === "malformed") process.stdout.write("invalid\n");
		if (kind === "mismatch") emit({ type: "response", id: requests[0].id, command: "prompt", success: true });
		if (kind === "truncated") { process.stdout.write('{"type":'); process.emit("close", 0, null); }
		if (kind === "exit") process.emit("close", 3, null);
		if (kind === "error") process.emit("error", new Error("spawn pi ENOENT"));
		await rejection;
		if (!rpc.exit) process.emit("close", 0, null);
	});
}

test("取消中断等待；收尾按 clear_queue→abort，并等待真实 close", async () => {
	const { rpc, process, requests, emit } = fixture();
	const controller = new AbortController();
	const waiting = assert.rejects(rpc.waitSettled(controller.signal), /fixture cancel/);
	controller.abort(new Error("fixture cancel"));
	await waiting;
	process.stdin.on("data", (chunk) => {
		const request = JSON.parse(chunk.toString());
		emit({ type: "response", id: request.id, command: request.type, success: true });
	});
	const exit = await rpc.stop();
	assert.deepEqual(requests.map((request) => request.type), ["clear_queue", "abort"]);
	assert.deepEqual(exit, { code: 0, signal: null });
});

test("取消和无只读能力在启动进程前拒绝", async () => {
	const controller = new AbortController();
	const input = { id: "test", task: "read", cwd: "/not-used", entryPath: "/not-used", parentSessionId: "parent",
		model: { provider: "fake", id: "fake" }, thinking: "off", tools: [], projectTrusted: false };
	await assert.rejects(delegateReadOnly(input, controller.signal, () => {}, () => {}), /没有已启用/);
	controller.abort(new Error("fixture before launch"));
	await assert.rejects(delegateReadOnly(input, controller.signal, () => {}, () => {}), /fixture before launch/);
});

test("内部命令来源不符时不能执行，即使名字相同", async () => {
	const { rpc, process, requests, emit } = fixture();
	process.stdin.on("data", (chunk) => {
		const request = JSON.parse(chunk.toString());
		emit({ type: "response", id: request.id, command: request.type, success: true,
			data: { commands: [{ name: "delivery-child-ready", sourceInfo: { path: "/foreign.ts" } }] } });
	});
	await assert.rejects(rpc.control("delivery-child-ready", "/owned.ts"), /实现来源未核实/);
	assert.deepEqual(requests.map((request) => request.type), ["get_commands"]);
	process.emit("close", 0, null);
});

test("正常关闭使用来源已核实的控制命令并等待 close，不靠发送信号宣称完成", async () => {
	const { rpc, process, requests, emit } = fixture();
	process.kill = () => { throw new Error("不应发送信号"); };
	process.stdin.on("data", (chunk) => {
		const request = JSON.parse(chunk.toString());
		emit({ type: "response", id: request.id, command: request.type, success: true,
			data: { commands: [{ name: "delivery-child-stop", sourceInfo: { path: "/owned.ts" } }] } });
		if (request.type === "prompt") queueMicrotask(() => process.emit("close", 0, null));
	});
	assert.deepEqual(await rpc.stop("/owned.ts"), { code: 0, signal: null });
	assert.deepEqual(requests.map((request) => request.type), ["clear_queue", "abort", "get_commands", "prompt"]);
});
