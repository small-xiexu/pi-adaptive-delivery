import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEditTool, createWriteTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { captureCandidate } from "../../extensions/delivery-gate/src/candidate.ts";
import { createChildDevelopment, verifyRecordedResult } from "../../extensions/delivery-gate/src/development.ts";
import { getWriterStateRoot, resolveWorkspaceIdentity, WRITER_LEASE_VERSION } from "../../extensions/delivery-gate/src/workspace.ts";

async function host(separateGit = false, pristine = false) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "child-writer-unit-")));
	const cwd = path.join(root, "repo");
	await mkdir(cwd);
	execFileSync("git", ["init", "--quiet"], { cwd });
	if (separateGit) execFileSync("git", ["init", "--quiet", "--separate-git-dir", "metadata"], { cwd });
	const sm = SessionManager.create(cwd, path.join(root, "sessions"));
	if (!pristine) sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "单元夹具，不是批准" }], api: "fake", provider: "fake", model: "fake",
		stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const ctx: any = { cwd, mode: "rpc", sessionManager: sm };
	const writer = createChildDevelopment({ appendEntry: (name, data) => { sm.appendCustomEntry(name, data); } });
	const owner = await writer.ready("run", ctx);
	const workspace = await resolveWorkspaceIdentity(cwd);
	const stateRoot = await getWriterStateRoot(workspace);
	await mkdir(path.join(stateRoot, "leases"), { recursive: true });
	const lease = { version: WRITER_LEASE_VERSION, leaseId: "fixture-lease", workspaceKey: workspace.key };
	const parent = { kind: "parent" as const, pid: process.pid + 1, sessionId: "parent", processToken: "unit-parent-process", runId: "run" };
	const record = { version: WRITER_LEASE_VERSION, leaseId: lease.leaseId, workspace, owner, coordinator: parent,
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
	const leaseFile = path.join(stateRoot, "leases", `${workspace.key}.json`);
	const grant = { lease, owner, parent, paths: [cwd], inputs: [], protectedPaths: [path.join(cwd, "plan.md")] };
	// 单元夹具模拟另一个父进程完成交接；实际跨进程证据由 SDK/CLI 集成提供。
	const arm = async () => { await writeFile(leaseFile, JSON.stringify(record)); await writer.arm(grant, ctx); };
	return { root, cwd, sm, ctx, writer, owner, grant, record, leaseFile, arm, workspace };
}

test("开发子会话核实交接身份与范围，普通开发不能调用固定验收执行器", async () => {
	const h = await host();
	await assert.rejects(h.writer.execute("no-grant", { command: "touch src.js" }), /未取得/);
	await assert.rejects(h.writer.arm(h.grant, h.ctx), /尚未真实交接/);
	await writeFile(h.leaseFile, JSON.stringify(h.record));
	await assert.rejects(h.writer.arm({ ...h.grant, owner: { ...h.owner, runId: "other" } }, h.ctx), /身份无效/);
	await assert.rejects(h.writer.arm({ ...h.grant, protectedPaths: [] }, h.ctx), /身份无效/);
	await h.writer.arm(h.grant, h.ctx);
	await assert.rejects(h.writer.execute("development", { command: "touch src.js" }), /未取得固定验收/);
	await assert.rejects(h.writer.arm(h.grant, h.ctx), /已接收交接/);
	await assert.rejects(access(path.join(h.cwd, "src.js")), { code: "ENOENT" });
});

test("开发使用原生文件工具，完整 Session 落盘后生成收尾记录", async () => {
	const h = await host();
	await h.arm();
	await createWriteTool(h.cwd).execute("write", { path: "src/value.js", content: "export const value = 1;\n" });
	await createEditTool(h.cwd).execute("edit", { path: "src/value.js", edits: [{ oldText: "value = 1", newText: "value = 2" }] });
	assert.equal(await readFile(path.join(h.cwd, "src/value.js"), "utf8"), "export const value = 2;\n");
	const result = await h.writer.finish(h.ctx);
	assert.equal(result.clean, true);
	assert.deepEqual(result.owner, h.owner);
	assert.ok("historyDigest" in result);
	assert.match(result.historyDigest, /^[a-f0-9]{64}$/);
	await assert.rejects(h.writer.execute("late", { command: "touch src.js" }), /未取得/);
});

test("子命令仍须核实真实工具调用，只有 writer 不能伪造调用", async () => {
	const h = await host();
	await writeFile(h.leaseFile, JSON.stringify(h.record));
	const commands = ["touch forbidden"];
	h.grant.paths = [path.join(h.cwd, "forbidden")];
	const before = await captureCandidate({ workspace: h.workspace, readPaths: [], writePaths: h.grant.paths, protectedPaths: [...h.grant.protectedPaths, h.sm.getSessionFile()!] }, commands);
	await h.writer.arm({ ...h.grant, validation: { commands, before } }, h.ctx);
	await assert.rejects(h.writer.execute("forged-call", { command: commands[0]! }), /工具调用未核实/);
	await assert.rejects(access(path.join(h.cwd, "forbidden")), { code: "ENOENT" });
});

test("子收尾拒绝仅内存存在的记录，不用 clean 标记掩盖持久化缺失", async () => {
	const h = await host();
	await h.arm();
	const before = await readFile(h.sm.getSessionFile()!, "utf8");
	h.sm.appendCustomEntry("missing-terminal", { data: "只留在内存" });
	await writeFile(h.sm.getSessionFile()!, before);
	await assert.rejects(h.writer.finish(h.ctx), /完整落盘/);
});

test("未发任务且未执行工具的子关闭不要求尚未创建的模型 Session", async () => {
	const h = await host(false, true);
	await assert.rejects(access(h.sm.getSessionFile()!), { code: "ENOENT" });
	assert.equal((await h.writer.finish(h.ctx)).clean, true);
	await assert.rejects(access(h.sm.getSessionFile()!), { code: "ENOENT" });
});

test("子已有消息后丢失 Session 不能按未开始收尾", async () => {
	const h = await host();
	await rm(h.sm.getSessionFile()!, { force: true });
	await assert.rejects(h.writer.finish(h.ctx), { code: "ENOENT" });
});

for (const field of ["content", "isError"]) test(`失败结果的证据或错误标记 ${field} 被改写时不能交接`, async () => {
	const h = await host();
	const first = h.sm.getBranch()[0]!;
	assert.ok(first.type === "message" && first.message.role === "assistant");
	h.sm.appendMessage({ ...first.message, content: [{ type: "toolCall", id: "failed-run", name: "delivery_develop", arguments: { task: "核对失败" } }] });
	const call = structuredClone(h.sm.getBranch().at(-1)!);
	const result = { content: [{ type: "text" as const, text: `工具失败\n原始子 Session：${path.join(h.root, "original.jsonl")}` }], details: {}, isError: true };
	h.sm.appendMessage({ role: "toolResult", toolCallId: "failed-run", toolName: "delivery_develop", ...structuredClone(result), timestamp: Date.now() });
	const state: Parameters<typeof verifyRecordedResult>[0] = { id: "failed-run", name: "delivery_develop", cwd: h.cwd,
		sessionId: h.sm.getSessionId(), sessionFile: h.sm.getSessionFile()!, lifetime: new AbortController(),
		finished: true, attemptedLease: false, call, result: structuredClone(result) };
	await verifyRecordedResult(state, h.ctx);
	const entry = h.sm.getEntries().findLast((row) => row.type === "message" && row.message.role === "toolResult");
	assert.ok(entry?.type === "message" && entry.message.role === "toolResult");
	if (field === "content") entry.message.content = [{ type: "text", text: `工具失败\n原始子 Session：${path.join(h.root, "substituted.jsonl")}` }];
	else entry.message.isError = false;
	const rows = (await readFile(h.sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	await writeFile(h.sm.getSessionFile()!, rows.map((row) => JSON.stringify(row.id === entry.id ? entry : row)).join("\n") + "\n");
	await assert.rejects(verifyRecordedResult(state, h.ctx), /父开发工具终态未唯一落盘或与实际结果不符/);
});

for (const kind of ["disk", "memory-and-disk"]) test(`审查终态依赖原验收的私有引用，${kind} 改写不能沿用通过`, async () => {
	const h = await host();
	const first = h.sm.getBranch()[0]!;
	assert.ok(first.type === "message" && first.message.role === "assistant");
	const template = first.message;
	const record = (id: string, name: string): Parameters<typeof verifyRecordedResult>[0] => {
		h.sm.appendMessage({ ...template, content: [{ type: "toolCall", id, name, arguments: {} }] });
		const call = structuredClone(h.sm.getBranch().at(-1)!);
		const result = { content: [{ type: "text" as const, text: "original result" }], details: {}, isError: false };
		h.sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, ...result, timestamp: Date.now() });
		return { id, name, cwd: h.cwd, sessionId: h.sm.getSessionId(), sessionFile: h.sm.getSessionFile()!, lifetime: new AbortController(),
			finished: true, attemptedLease: false, call, result: structuredClone(result) };
	};
	const validation = record("validation", "delivery_validate");
	const review = { ...record("review", "delivery_review"), reviewValidation: validation };
	await verifyRecordedResult(review, h.ctx);
	const rows = (await readFile(h.sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	rows.find((row) => row.message?.toolCallId === "validation").message.content = [{ type: "text", text: "rewritten validation" }];
	if (kind === "memory-and-disk") {
		const entry = h.sm.getEntries().find((row) => row.type === "message" && row.message.role === "toolResult" && row.message.toolCallId === "validation");
		assert.ok(entry?.type === "message" && entry.message.role === "toolResult");
		entry.message.content = [{ type: "text", text: "rewritten validation" }];
	}
	await writeFile(h.sm.getSessionFile()!, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	await assert.rejects(verifyRecordedResult(review, h.ctx), /终态未唯一落盘/);
});
