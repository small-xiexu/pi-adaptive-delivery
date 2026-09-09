import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createParentDocumentWriter, DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL } from "../../extensions/delivery-gate/src/parent-writer.ts";
import { getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";
import { approvalUI } from "../support/delivery-ui.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, api: "openai-completions", provider: "fixture", model: "fake", stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function host(existing?: string) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "parent-writer-")));
	const cwd = existing ?? root;
	if (!existing) execFileSync("git", ["init", "--quiet"], { cwd });
	const sm = SessionManager.create(cwd, path.join(root, "sessions"));
	sm.appendMessage(assistant([{ type: "text", text: "模拟 TUI 前置，不是真实用户确认" }]));
	const handlers = new Map<string, Function[]>();
	const notices: string[] = [];
	const pi: any = { on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
		registerTool() {}, registerCommand() {}, registerEntryRenderer() {}, appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data) };
	const ctx: any = { cwd, mode: "tui", hasUI: true, sessionManager: sm, isIdle: () => true, abort: () => {},
		ui: { custom: approvalUI(async (_title, choices) => choices[0]), notify: (text: string) => notices.push(text) } };
	const writer = createParentDocumentWriter(pi);
	const workspace = await resolveWorkspaceIdentity(cwd);
	const stateRoot = await getWriterStateRoot(workspace);
	const leases = new WriterLeaseManager(stateRoot);
	const leaseFile = path.join(stateRoot, "leases", `${workspace.key}.json`);
	const event = async (name: string) => { const results = []; for (const handler of handlers.get(name) ?? []) results.push(await handler({}, ctx)); return results; };
	const begin = (input: { path: string; content: string } = { path: "plan.md", content: "更新" }, signal?: AbortSignal) => {
		const id = randomUUID();
		sm.appendMessage(assistant([{ type: "toolCall", id, name: DOCUMENT_WRITE_TOOL, arguments: input }]));
		const run = writer.write(id, input, signal, ctx);
		const outcome = run.then((result) => ({ ...result, isError: false }), (error) => ({ content: [{ type: "text" as const, text: error.message }], details: {}, isError: true }));
		const message = async (): Promise<ToolResultMessage> => ({ role: "toolResult", toolCallId: id, toolName: DOCUMENT_WRITE_TOOL, ...await outcome, timestamp: Date.now() });
		return { id, run, message, persist: async () => { const result = await message(); sm.appendMessage(result); return result; } };
	};
	return { root, cwd, sm, pi, ctx, writer, begin, event, notices, workspace, leases, leaseFile,
		readLease: () => leases.read(workspace.key), disk: async () => (await readFile(sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((row) => JSON.parse(row)) };
}

test("父 writer 绑定本次调用，原生结果落盘后释放并允许下一次编辑", async () => {
	const h = await host();
	const first = h.begin();
	await first.run;
	assert.equal(h.writer.pending, true);
	assert.equal((await h.readLease())?.owner.runId, first.id);
	await h.event("tool_execution_end");
	assert.ok(await h.readLease(), "工具返回不是释放证据");
	await first.persist();
	await h.event("turn_end");
	assert.equal(h.writer.pending, false);
	assert.equal(await h.readLease(), undefined);
	const id = randomUUID();
	const input = { path: "plan.md", edits: [{ oldText: "更新", newText: "再次更新" }] };
	h.sm.appendMessage(assistant([{ type: "toolCall", id, name: DOCUMENT_EDIT_TOOL, arguments: input }]));
	const result = await h.writer.edit(id, input, undefined, h.ctx);
	h.sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: DOCUMENT_EDIT_TOOL, ...result, isError: false, timestamp: Date.now() });
	await h.event("turn_end");
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "再次更新");
	assert.equal(await h.readLease(), undefined);
});

test("源码拒绝属于已结束的工具失败，真实错误落盘后可以释放", async () => {
	const h = await host();
	const call = h.begin({ path: "src.ts", content: "不应写入" });
	await assert.rejects(call.run, /Markdown/);
	assert.ok(await h.readLease());
	await call.persist();
	await h.event("turn_end");
	assert.equal(await h.readLease(), undefined);
	await assert.rejects(access(path.join(h.cwd, "src.ts")), { code: "ENOENT" });
});

test("只有 agent_settled 而无持久工具结果时明确关闭，不因后来补记录自动释放", async () => {
	const h = await host();
	const call = h.begin();
	await call.run;
	await h.event("agent_settled");
	assert.ok(h.notices.some((text) => text.includes("未交回")));
	await call.persist();
	await h.event("turn_end");
	assert.ok(await h.readLease());
});

for (const failure of ["missing", "memory-only", "duplicate", "content", "isError", "toolName", "call", "header", "truncated", "branch", "file", "owner"]) {
	test(`原生终态 ${failure} 不可核实则保留 lease，修复文件也不自动重试释放`, async (t) => {
		const h = await host();
		const call = h.begin();
		await call.run;
		const file = h.sm.getSessionFile()!;
		t.after(() => chmod(file, 0o600));
		if (failure === "memory-only") {
			await chmod(file, 0o400);
			await assert.rejects(call.persist(), /EACCES|EPERM/);
			await chmod(file, 0o600);
		} else if (failure !== "missing") {
			const result = await call.persist();
			if (failure === "duplicate") h.sm.appendMessage(result);
			if (failure === "content") result.content = [{ type: "text", text: "伪造成功" }];
			if (failure === "isError") result.isError = true;
			if (failure === "toolName") result.toolName = "read";
			if (failure === "call") {
				const entry: any = h.sm.getBranch().findLast((row) => row.type === "message" && row.message.role === "assistant");
				entry.message.content[0].arguments.content = "不是原执行内容";
			}
			if (["content", "isError", "toolName", "call"].includes(failure)) {
				await writeFile(file, [h.sm.getHeader(), ...h.sm.getEntries()].map((row) => JSON.stringify(row)).join("\n") + "\n");
			}
			if (failure === "header") {
				const rows = await h.disk(); rows[0].id = "other";
				await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
			}
			if (failure === "truncated") await writeFile(file, (await readFile(file, "utf8")).trimEnd());
			if (failure === "branch") h.sm.branch(h.sm.getEntries()[0]!.id);
			if (failure === "file") { const copy = path.join(h.root, "copy.jsonl"); await copyFile(file, copy); h.sm.setSessionFile(copy); }
			if (failure === "owner") { const lease = await h.readLease(); lease!.owner.sessionId = "other"; await writeFile(h.leaseFile, JSON.stringify(lease)); }
		}
		await h.event("turn_end");
		assert.ok(await h.readLease());
		assert.equal(h.writer.pending, true);
		assert.ok(h.notices.some((text) => text.includes("未交回")));
		await writeFile(file, [h.sm.getHeader(), ...h.sm.getEntries()].map((row) => JSON.stringify(row)).join("\n") + "\n");
		await h.event("turn_end");
		assert.ok(await h.readLease());
		await assert.rejects(h.writer.write("next", { path: "plan.md", content: "不应写入" }, undefined, h.ctx), /尚未完成/);
	});
}

test("调用方改变返回对象不能同时改变私有终态依据", async () => {
	const h = await host();
	const call = h.begin();
	const result = await call.run;
	result.content.splice(0, result.content.length, { type: "text", text: "替换的结果" });
	await call.persist();
	await h.event("turn_end");
	assert.ok(await h.readLease());
});

test("默认编辑仍要求原生调用，空闲时分支导航不引入文档授权步骤", async () => {
	const h = await host();
	await assert.rejects(h.writer.write("absent", { path: "plan.md", content: "不应写入" }, undefined, h.ctx), /原生工具调用/);
	await h.event("session_tree");
	const call = h.begin();
	await call.run;
	await call.persist();
	await h.event("turn_end");
	assert.ok(!(await h.disk()).some((row) => row.customType === "delivery-approval"));
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.writer.pending, false);
});

test("同一实例拒绝并发请求；持有 writer 时阻止切换、fork 和分支导航", async () => {
	const h = await host();
	const call = h.begin();
	await assert.rejects(h.writer.write("parallel", { path: "plan.md", content: "不应写入" }, undefined, h.ctx), /尚未完成/);
	await call.run;
	for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) assert.ok((await h.event(event)).some((result) => result?.cancel));
	await call.persist();
	await h.event("turn_end");
	for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) assert.ok((await h.event(event)).every((result) => !result?.cancel));
});

test("不同 Session 与 cwd 别名共享 Git 元数据 lease，争抢失败不释放另一 writer", async () => {
	const first = await host();
	const alias = path.join(first.root, "alias");
	await symlink(first.cwd, alias);
	const second = await host(alias);
	const call = first.begin();
	await call.run;
	const owner = await first.readLease();
	await assert.rejects(second.begin().run, /already held/);
	assert.deepEqual(await second.readLease(), owner);
	assert.equal(second.writer.pending, false);
	await call.persist();
	await first.event("turn_end");
	const next = second.begin();
	await next.run;
	await next.persist();
	await second.event("turn_end");
	assert.equal(await first.readLease(), undefined);
});

test("用户取消后等原生失败记录释放，不自动再次写入", async (t) => {
	const h = await host();
	const file = path.join(h.cwd, "plan.md");
	let unblock!: () => void;
	let checked!: () => void;
	const blocked = new Promise<void>((resolve) => { unblock = resolve; });
	const initialCheck = new Promise<void>((resolve) => { checked = resolve; });
	const blocker = withFileMutationQueue(file, () => blocked);
	t.after(async () => { unblock(); await blocker; });
	const read = WriterLeaseManager.prototype.read;
	t.mock.method(WriterLeaseManager.prototype, "read", async function (this: WriterLeaseManager, key: string) {
		const result = await read.call(this, key); if (result) checked(); return result;
	});
	const abort = new AbortController();
	const call = h.begin(undefined, abort.signal);
	await initialCheck;
	abort.abort();
	unblock();
	await assert.rejects(call.run);
	assert.ok(await h.readLease());
	await call.persist();
	await h.event("turn_end");
	assert.equal(await h.readLease(), undefined);
	await assert.rejects(access(file), { code: "ENOENT" });
});

test("关闭失败即使有原生错误记录也不释放 writer", async (t) => {
	const h = await host();
	const open = fs.open;
	t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
		const handle = await open(...args);
		if (args[0] === path.join(h.cwd, "plan.md")) { const close = handle.close.bind(handle); handle.close = async () => { await close(); throw new Error("fixture close error"); }; }
		return handle;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const call = h.begin();
	await assert.rejects(call.run, /close error/);
	await call.persist();
	await h.event("turn_end");
	assert.ok(await h.readLease());
	assert.ok(h.notices.some((text) => text.includes("清理失败")));
});

test("shutdown 与重新安装不恢复未交接的 writer", async () => {
	const h = await host();
	const call = h.begin();
	await call.run;
	await h.event("session_shutdown");
	await call.persist();
	await h.event("turn_end");
	assert.ok(await h.readLease());
	await assert.rejects(h.writer.write("closed", { path: "plan.md", content: "不应写入" }, undefined, h.ctx), /已关闭/);
	const replacement = createParentDocumentWriter(h.pi);
	const input = { path: "plan.md", content: "不应写入" };
	h.sm.appendMessage(assistant([{ type: "toolCall", id: "restored", name: DOCUMENT_WRITE_TOOL, arguments: input }]));
	await assert.rejects(replacement.write("restored", input, undefined, h.ctx), /writer|lease|占用|持有/);
	assert.ok(await h.readLease());
});

for (const terminal of ["persisted", "missing"]) test(`在途父回合 shutdown 等待原生停止，${terminal} 结果决定是否交回`, async () => {
	const h = await host();
	const call = h.begin();
	await call.run;
	let aborted = false;
	h.ctx.isIdle = () => false;
	h.ctx.abort = () => { aborted = true; };
	let closed = false;
	const shutdown = h.event("session_shutdown").then(() => { closed = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(aborted, true);
	assert.equal(closed, false);
	assert.ok(await h.readLease());
	if (terminal === "persisted") await call.persist();
	await h.event("agent_settled");
	await shutdown;
	assert.equal(Boolean(await h.readLease()), terminal === "missing");
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "更新");
});

for (const failure of ["remove-lock", "foreign-lock"]) {
	test(`释放后的操作锁 ${failure} 无法确认清理时，不能报告 writer 已交回`, async (t) => {
		const h = await host();
		const call = h.begin();
		await call.run;
		await call.persist();
		const lock = path.join(path.dirname(h.leaseFile), `${h.workspace.key}.operation-lock`);
		if (failure === "remove-lock") {
			const rm = fs.rm;
			t.mock.method(fs, "rm", async (...args: Parameters<typeof rm>) => { if (args[0] === lock) throw new Error("fixture lock cleanup failure"); return rm(...args); });
		} else {
			const read = fs.readFile;
			t.mock.method(fs, "readFile", async (...args: Parameters<typeof read>) => args[0] === path.join(lock, "owner") ? "foreign-owner" : read(...args));
		}
		syncBuiltinESMExports();
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		await h.event("turn_end");
		assert.equal(h.writer.pending, true);
		assert.ok(h.notices.some((text) => text.includes("未交回")));
		await access(lock);
		assert.equal(await h.readLease(), undefined, "lease unlink 已完成，不能伪称回滚；残留操作锁仍阻止新的获取");
	});
}

test("释放等待操作锁期间原生结果丢失，不使用等待前的证明", async (t) => {
	const h = await host();
	const call = h.begin();
	await call.run;
	const before = await readFile(h.sm.getSessionFile()!, "utf8");
	await call.persist();
	const lock = path.join(path.dirname(h.leaseFile), `${h.workspace.key}.operation-lock`);
	await mkdir(lock);
	await writeFile(path.join(lock, "owner"), "fixture-owned-lock");
	let waiting!: () => void;
	const entered = new Promise<void>((resolve) => { waiting = resolve; });
	const make = fs.mkdir;
	t.mock.method(fs, "mkdir", async (...args: Parameters<typeof make>) => { if (args[0] === lock) waiting(); return make(...args); });
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const finish = h.event("turn_end");
	await entered;
	await writeFile(h.sm.getSessionFile()!, before);
	await fs.rm(lock, { recursive: true });
	await finish;
	assert.ok(await h.readLease());
	assert.equal(h.writer.pending, true);
});

for (const failure of ["acquire-write", "release-unlink"]) {
	test(`${failure} 的真实 lease I/O 故障保留未知状态，不开放替代 writer`, async (t) => {
		const h = await host();
		if (failure === "acquire-write") {
			const open = fs.open;
			t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
				const handle = await open(...args);
				if (args[0] === h.leaseFile) { const write = handle.writeFile.bind(handle); handle.writeFile = async () => { await write("{"); throw new Error("fixture lease write failure"); }; }
				return handle;
			});
		} else {
			const unlink = fs.unlink;
			t.mock.method(fs, "unlink", async (file: Parameters<typeof unlink>[0]) => { if (file === h.leaseFile) throw new Error("fixture unlink failure"); return unlink(file); });
		}
		syncBuiltinESMExports();
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		const call = h.begin();
		if (failure === "acquire-write") await assert.rejects(call.run, /lease write failure/);
		else await call.run;
		await call.persist();
		await h.event("turn_end");
		assert.equal(h.writer.pending, true);
		await access(h.leaseFile);
		assert.ok(h.notices.some((text) => text.includes("未交回")));
	});
}

test("取得 lease 后立即取消，不创建文档；失败结果落盘后仍可正常交回", async (t) => {
	const h = await host();
	const abort = new AbortController();
	const acquire = WriterLeaseManager.prototype.acquire;
	t.mock.method(WriterLeaseManager.prototype, "acquire", async function (this: WriterLeaseManager, ...args: Parameters<typeof acquire>) {
		const result = await acquire.apply(this, args); abort.abort(); return result;
	});
	const call = h.begin(undefined, abort.signal);
	await assert.rejects(call.run);
	assert.ok(await h.readLease());
	await assert.rejects(access(path.join(h.cwd, "plan.md")), { code: "ENOENT" });
	await call.persist();
	await h.event("turn_end");
	assert.equal(await h.readLease(), undefined);
});

test("shutdown 等待在途文档 I/O 与关闭，提前终态事件不能释放 lease", async (t) => {
	const h = await host();
	let enter!: () => void;
	let unblock!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const blocked = new Promise<void>((resolve) => { unblock = resolve; });
	const open = fs.open;
	let closed = false;
	t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
		const handle = await open(...args);
		if (args[0] === path.join(h.cwd, "plan.md")) {
			const write = handle.writeFile.bind(handle);
			handle.writeFile = async (...content: Parameters<typeof write>) => { enter(); await blocked; await write(...content); };
			const close = handle.close.bind(handle);
			handle.close = async () => { await close(); closed = true; };
		}
		return handle;
	});
	syncBuiltinESMExports();
	t.after(() => { unblock(); t.mock.restoreAll(); syncBuiltinESMExports(); });
	const call = h.begin();
	await entered;
	let stopped = false;
	const shutdown = h.event("session_shutdown").then(() => { stopped = true; });
	await h.event("agent_settled");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(stopped, false);
	assert.equal(closed, false);
	assert.ok(await h.readLease());
	unblock();
	await assert.rejects(call.run);
	await shutdown;
	assert.equal(closed, true);
	await call.persist();
	await h.event("agent_settled");
	assert.ok(await h.readLease(), "没有完成原生命周期内的交接，不因补记录重开权限");
});

test("lease 操作与操作锁清理同时失败时保留两个真实错误", async (t) => {
	const h = await host();
	const lease = await h.leases.acquire(h.workspace, { kind: "parent", sessionId: h.sm.getSessionId(), pid: process.pid, runId: "fixture-run" });
	assert.ok(lease.ok);
	const remove = fs.rm;
	t.mock.method(fs, "rm", async (...args: Parameters<typeof remove>) => {
		if (String(args[0]).endsWith(".operation-lock")) throw new Error("fixture cleanup error");
		return remove(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	await assert.rejects(h.leases.releaseParent(lease.reference, lease.record.owner, async () => { throw new Error("fixture terminal error"); }, new AbortController().signal),
		(error: unknown) => error instanceof AggregateError && error.errors[0].message === "fixture terminal error" && error.errors[1].message === "fixture cleanup error");
	assert.ok(await h.readLease());
});
