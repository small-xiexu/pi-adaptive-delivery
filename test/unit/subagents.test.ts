import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadTool, type BuildSystemPromptOptions, type ExtensionUIContext, type ToolInfo } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { ChildRpc, createChildDialogs, delegateReadOnly, parseReadOnlySession, snapshotReadOnlyEnvironment, assertReadOnlyEnvironment, startChild } from "../../extensions/delivery-gate/src/subagents.ts";

test("只读持久结果拒绝截断、关闭记录重复、归属不符及关闭后消息，保留 Unicode 正文", () => {
	const rows = [{ type: "session", id: "session" },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "中文\u2028✅\u2029" }], stopReason: "stop" } },
		{ type: "custom", customType: "delivery-child-exit", data: { pid: 42, sessionId: "session" } }];
	const encode = (value: unknown[]) => value.map((row) => JSON.stringify(row)).join("\n") + "\n";
	assert.deepEqual(parseReadOnlySession(encode(rows), "session", 42), rows);
	assert.throws(() => parseReadOnlySession(encode(rows).slice(0, -1), "session", 42), /不完整/);
	assert.throws(() => parseReadOnlySession(encode([...rows, rows[2]]), "session", 42), /唯一持久关闭记录/);
	assert.throws(() => parseReadOnlySession(encode([...rows, rows[1]]), "session", 42), /关闭后消息/);
	assert.throws(() => parseReadOnlySession(encode(rows.slice(0, 2)), "session", 42), /唯一持久关闭记录/);
	assert.throws(() => parseReadOnlySession(encode(rows), "different", 42), /归属/);
	assert.throws(() => parseReadOnlySession(encode(rows), "session", 43), /归属/);
});

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
		model: { provider: "fake", id: "fake" }, thinking: "off", selectionReason: "测试", toolInput: {}, environment: snapshotReadOnlyEnvironment({ cwd: "/not-used" }, []), projectTrusted: false };
	const ctx = { mode: "rpc" as const, ui: {} as ExtensionUIContext, abort() {} };
	await assert.rejects(delegateReadOnly(input, controller.signal, () => {}, () => {}, ctx), /没有已启用/);
	controller.abort(new Error("fixture before launch"));
	await assert.rejects(delegateReadOnly(input, controller.signal, () => {}, () => {}, ctx), /fixture before launch/);
});

for (const kind of ["file", "symlink"]) test(`子 Pi 启动前拒绝工作区 ${kind} 入口，子目录 cwd 不能缩小检查范围`, async (t) => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "child-path-unit-")));
	const repo = path.join(root, "repo");
	const cwd = path.join(repo, "src");
	await mkdir(cwd, { recursive: true });
	execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: repo });
	await writeFile(path.join(repo, "pi"), `#!/bin/sh\nprintf executed > '${repo}/executed'\n`, { mode: 0o700 });
	const bin = kind === "file" ? repo : path.join(root, "bin");
	if (kind === "symlink") { await mkdir(bin); await symlink(path.join(repo, "pi"), path.join(bin, "pi")); }
	const original = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${original}`;
	t.after(() => { process.env.PATH = original; });
	const input = { id: "run", task: "read", cwd, entryPath: "/unused", parentSessionId: "parent", model: { provider: "fake", id: "fake" },
		thinking: "off", selectionReason: "测试", toolInput: {}, projectTrusted: false, environment: { tools: [{ name: "read", digest: "unused" }], instructions: "", rules: "", skills: "" } };
	await assert.rejects(async () => {
		const rpc = await startChild(input, "readonly");
		await rpc.closed;
	}, /Pi.*工作区外/);
	await assert.rejects(access(path.join(repo, "executed")), { code: "ENOENT" });
});

function environmentFixture() {
	const sourceInfo = { path: "read", source: "builtin", scope: "temporary" as const, origin: "top-level" as const };
	const { name, description, parameters } = createReadTool("/repo");
	const tools: ToolInfo[] = [{ name, description, parameters, sourceInfo }];
	const options: BuildSystemPromptOptions = { cwd: "/repo", customPrompt: "基础指令", appendSystemPrompt: "附加指令",
		contextFiles: [{ path: "/repo/AGENTS.md", content: "规则正文，不复制到子握手" }],
		skills: [{ name: "proof", description: "任务所需 Skill", filePath: "/repo/skills/proof/SKILL.md", baseDir: "/repo/skills/proof",
			sourceInfo: { ...sourceInfo, path: "/repo/skills/proof/SKILL.md", source: "local" }, disableModelInvocation: false }] };
	return { tools, options };
}

test("只读环境快照独立于可变对象且不持久复制规则或指令正文", () => {
	const { tools, options } = environmentFixture();
	const expected = snapshotReadOnlyEnvironment(options, tools);
	assert.doesNotThrow(() => assertReadOnlyEnvironment(expected, structuredClone(expected)));
	assert.ok(!JSON.stringify(expected).includes("规则正文"));
	assert.ok(!JSON.stringify(expected).includes("基础指令"));
	options.contextFiles![0]!.content = "已改变";
	assert.throws(() => assertReadOnlyEnvironment(expected, snapshotReadOnlyEnvironment(options, tools)), /规则未对齐/);
});

for (const change of ["definition", "source", "instructions", "rules", "skill-description", "skill-source", "skill-missing", "missing"] as const) {
	test(`只读环境在任务发送前拒绝 ${change}，同名工具不等于同一能力`, () => {
		const { tools, options } = environmentFixture();
		const expected = snapshotReadOnlyEnvironment(options, tools);
		if (change === "definition") tools[0]!.parameters = { type: "object", properties: { different: { type: "string" } } } as ToolInfo["parameters"];
		if (change === "source") tools[0]!.sourceInfo.source = "foreign";
		if (change === "instructions") options.appendSystemPrompt = "different";
		if (change === "rules") options.contextFiles = [];
		if (change === "skill-description") options.skills![0]!.description = "different";
		if (change === "skill-source") options.skills![0]!.sourceInfo.path = "/different/SKILL.md";
		if (change === "skill-missing") options.skills = [];
		assert.throws(() => assertReadOnlyEnvironment(expected, change === "missing" ? undefined : snapshotReadOnlyEnvironment(options, tools)), /未发送任务/);
	});
}

test("父协调工具提示与只读子工具提示不同，不当作基础指令丢失", () => {
	const { tools, options } = environmentFixture();
	const expected = snapshotReadOnlyEnvironment(options, tools);
	options.selectedTools = ["read", "delivery_readonly"];
	options.toolSnippets = { delivery_readonly: "父角色专有" };
	options.promptGuidelines = ["父角色工具指南"];
	assert.doesNotThrow(() => assertReadOnlyEnvironment(expected, snapshotReadOnlyEnvironment(options, tools)));
});

test("工具环境不一致明确列出缺少、新增和定义差异，并引导收尾后退出恢复", () => {
	const base = snapshotReadOnlyEnvironment({ cwd: "/repo" }, []);
	const expected = { ...base, tools: [{ name: "read", digest: "original" }, { name: "grep", digest: "original" }] };
	const actual = { ...base, tools: [{ name: "read", digest: "changed" }, { name: "bash", digest: "new" }] };
	assert.throws(() => assertReadOnlyEnvironment(expected, actual), (error: Error) => {
		assert.match(error.message, /子会话缺少：grep/);
		assert.match(error.message, /子会话额外启用：bash/);
		assert.match(error.message, /定义或来源不同：read/);
		assert.match(error.message, /未发送任务/);
		assert.match(error.message, /不得改用普通工具继续源码或测试写入/);
		assert.match(error.message, /收尾.*\/delivery-exit/s);
		assert.match(error.message, /\/reload.*保留.*工具/s);
		assert.doesNotMatch(error.message, /digest|original|changed/);
		return true;
	});
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

function dialogFixture(mode: "tui" | "rpc" = "tui") {
	const h = fixture();
	const parent = new AbortController();
	const interrupt = new AbortController();
	const titles: string[] = [];
	let aborts = 0;
	const ui = {
		select: async (title: string) => { titles.push(title); return "second"; },
		confirm: async (title: string) => { titles.push(title); return true; },
		input: async (title: string) => { titles.push(title); return "普通回答"; },
	} as unknown as ExtensionUIContext;
	const dialogs = createChildDialogs(h.rpc, { mode, ui, abort() { aborts++; } }, AbortSignal.any([parent.signal, interrupt.signal]), interrupt);
	h.rpc.onEvent = (event) => dialogs.handle(event);
	const request = (method: string, id = "child-request", extras = {}) => h.emit({ type: "extension_ui_request", id, method,
		title: "同意方案并扩大权限？", options: ["first", "second"], message: "问题正文", placeholder: "输入", ...extras });
	return { ...h, dialogs, ui, titles, parent, interrupt, request, aborts: () => aborts };
}

for (const method of ["select", "confirm", "input"] as const) test(`普通子 ${method} 回答只关联当前请求，不成为批准`, async () => {
	const h = dialogFixture();
	h.request(method, `child-${method}`);
	await nextTurn();
	await h.dialogs.close();
	assert.deepEqual(h.requests, [{ type: "extension_ui_response", id: `child-${method}`,
		...(method === "confirm" ? { confirmed: true } : { value: method === "select" ? "second" : "普通回答" }) }]);
	assert.match(h.titles[0]!, /PID 123.*普通询问，不授予交付权限/);
	assert.equal(h.aborts(), 0);
	assert.equal(h.interrupt.signal.aborted, false);
	h.process.emit("close", 0, null);
});

for (const kind of ["select-cancel", "confirm-deny", "input-cancel", "ui-error", "invalid-answer", "editor", "rpc"]) test(`子交互 ${kind} 取消回复并暂停，不回答允许`, async () => {
	const h = dialogFixture(kind === "rpc" ? "rpc" : "tui");
	if (kind === "select-cancel") h.ui.select = async () => undefined;
	if (kind === "confirm-deny") h.ui.confirm = async () => false;
	if (kind === "input-cancel") h.ui.input = async () => undefined;
	if (kind === "ui-error") h.ui.select = async () => { throw new Error("fixture UI failure"); };
	if (kind === "invalid-answer") h.ui.select = async () => "unrelated";
	h.request(kind === "confirm-deny" ? "confirm" : kind === "input-cancel" ? "input" : kind === "editor" ? "editor" : "select");
	await nextTurn();
	await assert.rejects(h.dialogs.close());
	assert.deepEqual(h.requests, [{ type: "extension_ui_response", id: "child-request", cancelled: true }]);
	assert.equal(h.interrupt.signal.aborted, true);
	assert.equal(h.aborts(), kind === "rpc" ? 0 : 1);
	if (kind === "ui-error") assert.match(String(h.interrupt.signal.reason), /fixture UI failure/);
	h.process.emit("close", 0, null);
});

for (const kind of ["parent-cancel", "timeout", "tool-ended", "concurrent", "child-exit"]) test(`未决子交互 ${kind} 丢弃迟到回答并结束对话`, async () => {
	const h = dialogFixture();
	let answer!: (value: string | undefined) => void;
	h.ui.input = async (_title, _placeholder, options) => new Promise((resolve) => {
		answer = resolve;
		options!.signal!.addEventListener("abort", () => resolve("迟到允许"), { once: true });
	});
	if (kind === "tool-ended") h.emit({ type: "tool_execution_start", toolCallId: "call" });
	h.request("input", "original", kind === "timeout" ? { timeout: 1 } : {});
	await nextTurn();
	if (kind === "timeout") await new Promise((resolve) => setTimeout(resolve, 10));
	if (kind === "parent-cancel") h.parent.abort(new Error("fixture cancel"));
	if (kind === "tool-ended") h.emit({ type: "tool_execution_end", toolCallId: "call", isError: false });
	if (kind === "concurrent") h.request("select", "other");
	if (kind === "child-exit") h.process.emit("close", 0, null);
	const closing = assert.rejects(h.dialogs.close());
	answer("迟到允许");
	await closing;
	assert.ok(h.requests.every((row) => row.cancelled === true));
	assert.ok(h.requests.every((row) => ["original", "other"].includes(row.id)));
	if (kind === "child-exit") assert.deepEqual(h.requests, []);
	else h.process.emit("close", 0, null);
});

test("父中止抛错仍取消子回答并保留两个真实错误", async () => {
	const h = fixture();
	const controller = new AbortController();
	const dialogs = createChildDialogs(h.rpc, { mode: "tui", ui: { input: async () => { throw new Error("fixture UI failed"); } } as unknown as ExtensionUIContext,
		abort() { throw new Error("fixture abort failed"); } }, controller.signal, controller);
	dialogs.handle({ type: "extension_ui_request", id: "request", method: "input", title: "问题" });
	await nextTurn();
	await assert.rejects(dialogs.close(), (error: unknown) => error instanceof AggregateError
		&& error.errors.some((item) => String(item).includes("fixture UI failed")) && error.errors.some((item) => String(item).includes("fixture abort failed")));
	assert.equal(h.requests[0].cancelled, true);
	h.process.emit("close", 0, null);
});
