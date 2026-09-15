import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { APPROVAL_ENTRY, APPROVAL_TOOL, PROPOSAL_ENTRY, installApprovals } from "../../extensions/delivery-gate/src/approvals.ts";
import { executionInstruction } from "../../extensions/delivery-gate/src/approvals.ts";
import { approvalUI } from "../support/delivery-ui.ts";

async function host() {
	const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "approval-unit-")));
	execFileSync("git", ["init", "--quiet"], { cwd });
	await mkdir(path.join(cwd, "docs"));
	await writeFile(path.join(cwd, "docs/方案.md"), "# 方案\n");
	const sm = SessionManager.create(cwd, path.join(cwd, "sessions"));
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "模拟模型讨论" }], api: "fake", provider: "fixture", model: "fake", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const handlers = new Map<string, Function[]>(), continuations: unknown[] = [];
	const ctx: any = { cwd, mode: "tui", hasUI: true, sessionManager: sm, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } };
	ctx.ui.custom = approvalUI(async (_title, options) => options[0]);
	const pi: any = { on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]), registerTool: (value: any) => { pi.tool = value; }, registerCommand() {}, registerEntryRenderer() {}, sendMessage: (message: unknown) => continuations.push(message), appendEntry: (name: string, data: unknown) => sm.appendCustomEntry(name, data) };
	const approvals = installApprovals(pi as ExtensionAPI);
	const request = { stage: "design", body: "目标：空列表显示空状态。\n数据行为：不改变接口。\n验收：现有测试通过。\n本次假设：无", documentStrategy: "reuse", technicalPlanPath: "docs/方案.md", paths: ["docs/方案.md"] };
	const run = (value = request) => pi.tool.execute("approval-call", value, undefined, undefined, ctx);
	return { cwd, sm, ctx, pi, approvals, request, run, continuations, event: async (name: string, value = {}) => { for (const handler of handlers.get(name) ?? []) await handler(value, ctx); } };
}

test("一次真实方案确认同时授权开始实施", async () => {
	const h = await host();
	const result = await h.run();
	assert.equal(result.details.approved, true);
	assert.equal(h.approvals.confirmedStage, "design");
	assert.equal(h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === APPROVAL_ENTRY).length, 1);
	assert.equal(h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === PROPOSAL_ENTRY).length, 1);
	assert.equal(h.continuations.length, 0);
	await h.event("agent_settled");
	assert.equal(h.continuations.length, 1);
	await h.event("agent_settled");
	assert.equal(h.continuations.length, 1);
	assert.match(String((h.continuations[0] as any).content), /内部计划/);
	assert.match(String((h.continuations[0] as any).content), /不再请求实施确认/);
});

test("方案暂停不产生批准，也不启动实施衔接", async () => {
	const h = await host();
	h.ctx.ui.custom = approvalUI(async () => undefined);
	const result = await h.run();
	assert.equal(result.details.paused, true);
	assert.equal(h.approvals.confirmedStage, undefined);
	assert.equal(h.continuations.length, 0);
});

test("批准入口拒绝伪造的 implementation 阶段", async () => {
	const h = await host();
	await assert.rejects(h.run({ ...h.request, stage: "implementation" } as any), /只接受方案确认/);
	assert.equal(h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === APPROVAL_ENTRY).length, 0);
});

test("确认前规划文件缺失时关闭批准", async () => {
	const h = await host();
	await assert.rejects(h.run({ ...h.request, technicalPlanPath: "docs/missing.md", paths: ["docs/missing.md"] }), /规划文档尚未写入/);
	assert.equal(h.sm.getBranch().some((row) => row.type === "custom" && row.customType === APPROVAL_ENTRY), false);
});

test("方案面板主按钮明确表达开始实施", async () => {
	const h = await host();
	await h.run();
	const proposal = h.sm.getBranch().findLast((row) => row.type === "custom" && row.customType === PROPOSAL_ENTRY);
	assert.ok(proposal?.type === "custom");
	assert.equal(h.pi.tool.name, APPROVAL_TOOL);
	assert.match(executionInstruction, /文件数量、步骤、顺序/);
	assert.match(executionInstruction, /业务目标、数据行为、对外接口、验收标准/);
	assert.match(executionInstruction, /重大外部风险变化/);
});

test("方案反馈不形成批准，也不触发实施", async () => {
	const h = await host();
	h.ctx.ui.custom = approvalUI(async () => undefined, () => "验收标准还需补充");
	const result = await h.run();
	assert.equal(result.details.approved, false);
	assert.equal(h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === APPROVAL_ENTRY).length, 0);
	assert.equal(h.continuations.length, 0);
});

test("非 TUI 不能伪造方案批准", async () => {
	const h = await host();
	h.ctx.mode = "rpc";
	await assert.rejects(h.run(), /真实 TUI/);
	assert.equal(h.sm.getBranch().some((row) => row.type === "custom" && row.customType === APPROVAL_ENTRY), false);
});

for (const event of ["session_start", "session_shutdown", "session_tree"])
	test(`${event} 使本轮方案授权失效并关闭开发入口`, async () => {
		const h = await host();
		await h.run();
		const grant = await h.approvals.readApproval(h.ctx);
		await h.event(event);
		assert.equal(grant.signal.aborted, true);
		await assert.rejects(h.approvals.readApproval(h.ctx), /本轮没有|失效/);
	});

for (const mode of ["rpc", "json", "print", undefined])
	test(`非 TUI 模式 ${mode ?? "未设置"} 均拒绝批准`, async () => {
		const h = await host();
		h.ctx.mode = mode;
		await assert.rejects(h.run(), /真实 TUI/);
		assert.equal(h.sm.getBranch().some((row) => row.type === "custom" && row.customType === PROPOSAL_ENTRY), false);
	});

test("批准核验同时绑定原生方案和批准记录", async () => {
	const h = await host();
	await h.run();
	const grant = await h.approvals.readApproval(h.ctx);
	assert.equal(grant.designBody, h.request.body);
	assert.deepEqual(grant.planningPaths, [path.join(h.cwd, "docs/方案.md")]);
	const file = h.sm.getSessionFile()!;
	const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	rows[rows.length - 1].data.workspaceKey = "tampered";
	await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	await assert.rejects(h.approvals.readApproval(h.ctx), /批准记录已变化/);
	assert.equal(h.approvals.confirmedStage, undefined);
});
