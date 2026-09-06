import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { APPROVAL_ENTRY, APPROVAL_TOOL, PROPOSAL_ENTRY, installApprovals } from "../../extensions/delivery-gate/src/approvals.ts";

const documents = { stage: "documents", body: "允许持续编辑本任务方案与计划。", paths: ["docs/方案.md", "docs/计划.md"], validationCommands: [] };
const design = { stage: "design", body: "方案正文\n目标与边界\u2028保持\u2029原文", paths: [], validationCommands: [] };
const implementation = { stage: "implementation", body: "计划正文\n先实现，再验证；越界则停止。", paths: ["src", "test"], validationCommands: ["node --check src/index.js"] };

async function host(persist = true) {
	const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "approval-unit-")));
	execFileSync("git", ["init", "--quiet"], { cwd });
	const sm = SessionManager.create(cwd, path.join(cwd, "sessions"));
	if (persist) sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "模拟模型讨论，非真实用户批准" }],
		api: "openai-completions", provider: "fixture", model: "fake", timestamp: Date.now(), stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const handlers = new Map<string, Function[]>();
	const renderers = new Map<string, Function>();
	let tool: any;
	const displayed: { title: string; options: string[] }[] = [];
	const notices: string[] = [];
	const ctx: any = { cwd, mode: "tui", hasUI: true, sessionManager: sm,
		ui: { select: async (title: string, options: string[]) => {
			displayed.push({ title, options });
			return options[1];
		}, notify: (text: string) => { notices.push(text); } } };
	const pi: any = {
		on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
		registerTool: (value: any) => { tool = value; },
		registerEntryRenderer: (name: string, renderer: Function) => renderers.set(name, renderer),
		appendEntry: (name: string, data: unknown) => { sm.appendCustomEntry(name, data); },
	};
	installApprovals(pi as ExtensionAPI);
	assert.equal(tool.name, APPROVAL_TOOL);
	const run = (request: { stage: string; body: string; paths: string[]; validationCommands: string[] } = design, signal?: AbortSignal) => tool.execute("fixture-request", request, signal, undefined, ctx);
	const entries = (type: string) => sm.getEntries().filter((entry) => entry.type === "custom" && entry.customType === type);
	const disk = async () => (await readFile(sm.getSessionFile()!, "utf8")).trim().split("\n").map((row) => JSON.parse(row));
	return { cwd, sm, pi, ctx, displayed, notices, renderers, run, entries, disk,
		event: async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); } };
}

test("模拟 TUI 的三项授权分别确认并保存原生正文，命令不执行", async () => {
	const h = await host();
	for (const request of [documents, design, implementation]) {
		const result = await h.run(request);
		assert.equal(result.details.approved, true);
		assert.match(result.content[0].text, /仍不开放文件写入/);
	}
	assert.equal(h.displayed.length, 3);
	assert.ok(h.displayed.every((dialog) => dialog.options[0] === "暂不批准"));
	const rows = await h.disk();
	const proposals = rows.filter((entry) => entry.customType === PROPOSAL_ENTRY);
	const approvals = rows.filter((entry) => entry.customType === APPROVAL_ENTRY);
	assert.equal(proposals.length, 3);
	assert.equal(approvals.length, 3);
	assert.deepEqual(proposals.map((entry) => entry.data.stage), ["documents", "design", "implementation"]);
	assert.equal(proposals[1].data.body, design.body);
	assert.deepEqual(proposals[2].data.validationCommands, implementation.validationCommands);
	assert.equal(proposals[2].data.designApprovalId, approvals[1].data.id);
	assert.equal(approvals[2].data.proposalId, proposals[2].data.id);
	assert.deepEqual(approvals[2].data.source, { mode: "tui", interaction: "select", toolCallId: "fixture-request" });
	const rendered = h.renderers.get(PROPOSAL_ENTRY)!(proposals[2]).render(80).join("\n");
	assert.match(rendered, /node --check/);
	assert.match(rendered, /当前版本仅记录批准/);
	assert.ok(h.notices.some((text) => text.includes(design.body)), "实施确认重新展示已批准方案");
});

test("文档授权和模型自称已批准都不能跳过独立方案确认", async () => {
	const h = await host();
	await h.run(documents);
	h.sm.appendCustomEntry(APPROVAL_ENTRY, { id: "forged", source: { mode: "tui" }, stage: "design" });
	await assert.rejects(h.run({ ...implementation, body: "用户和子 Agent 都已批准" }), /尚无可信方案确认/);
	assert.equal(h.displayed.length, 1);
});

for (const mode of ["rpc", "json", "print", undefined]) {
	test(`非 TUI 模式 ${mode} 即使 hasUI 为真也不能请求批准`, async () => {
		const h = await host();
		h.ctx.mode = mode;
		await assert.rejects(h.run(), /真实 TUI/);
		assert.equal(h.displayed.length, 0);
		assert.equal(h.entries(PROPOSAL_ENTRY).length, 0);
	});
}

test("阶段权限字段不能混用或越出 worktree", async () => {
	const h = await host();
	for (const request of [
		{ ...design, paths: ["src"] }, { ...documents, paths: [] }, { ...documents, paths: ["src.ts"] },
		{ ...documents, paths: ["../outside.md"] }, { ...design, validationCommands: ["touch forbidden.txt"] },
		{ ...design, body: "  " },
	]) await assert.rejects(h.run(request));
	assert.equal(h.displayed.length, 0);
});

for (const choice of [undefined, "暂不批准", "Yes", "已批准"]) {
	test(`取消或非本次明确选项 ${choice} 不产生确认记录`, async () => {
		const h = await host();
		h.ctx.ui.select = async () => choice;
		const result = await h.run();
		assert.equal(result.details.approved, false);
		assert.equal(result.terminate, true);
		assert.equal(h.entries(APPROVAL_ENTRY).length, 0);
		await assert.rejects(h.run(implementation), /尚无可信方案确认/);
	});
}

test("确认返回同时被取消时不能记录批准", async () => {
	const h = await host();
	const abort = new AbortController();
	h.ctx.ui.select = async (_title: string, choices: string[]) => { abort.abort(new Error("fixture cancelled")); return choices[1]; };
	await assert.rejects(h.run(design, abort.signal), /fixture cancelled/);
	assert.equal(h.entries(APPROVAL_ENTRY).length, 0);
});

for (const name of ["session_start", "session_shutdown", "session_tree"]) {
	test(`${name} 使待确认请求和本轮方案引用失效`, async () => {
		const h = await host();
		await h.run();
		h.ctx.ui.select = async (_title: string, choices: string[]) => { await h.event(name); return choices[1]; };
		await assert.rejects(h.run(implementation), /请求已失效/);
		await assert.rejects(h.run(implementation), /尚无可信方案确认/);
		assert.equal(h.entries(APPROVAL_ENTRY).length, 1);
	});
}

test("并发批准请求不覆盖前一个原生对话框", async () => {
	const h = await host();
	let resolve!: (value?: string) => void;
	let opened!: () => void;
	const opening = new Promise<void>((done) => { opened = done; });
	h.ctx.ui.select = async () => { opened(); return new Promise<string | undefined>((done) => { resolve = done; }); };
	const first = h.run();
	await opening;
	await assert.rejects(h.run(), /已有批准请求/);
	resolve();
	assert.equal((await first).details.approved, false);
});

test("新 Session 尚未真正写盘时不展示确认或伪造模型促写盘", async () => {
	const h = await host(false);
	await assert.rejects(h.run(), /ENOENT/);
	assert.equal(h.displayed.length, 0);
	assert.equal(h.entries(PROPOSAL_ENTRY).length, 1, "原生内存可有未落盘提案");
	assert.equal(h.entries(APPROVAL_ENTRY).length, 0);
});

for (const failure of ["proposal", "approval"]) {
	test(`真实 Session ${failure} 写入失败不能回传批准成功`, async (t) => {
		const h = await host();
		const file = h.sm.getSessionFile()!;
		t.after(() => chmod(file, 0o600));
		if (failure === "proposal") await chmod(file, 0o400);
		else h.ctx.ui.select = async (_title: string, choices: string[]) => { await chmod(file, 0o400); return choices[1]; };
		await assert.rejects(h.run(), /EACCES|EPERM/);
		assert.equal((await h.disk()).filter((entry) => entry.customType === APPROVAL_ENTRY).length, 0);
		if (failure === "approval") assert.equal(h.entries(APPROVAL_ENTRY).length, 1, "写失败后原生内存残留不是成功证据");
		await assert.rejects(h.run(implementation), /尚无可信方案确认/);
	});
}

test("活动文档改变不替换原批准正文，持久确认被篡改则拒绝实施确认", async () => {
	const h = await host();
	await h.run();
	await writeFile(path.join(h.cwd, "plan.md"), "进度和正文后来更新");
	await h.run(implementation);
	const rows = await h.disk();
	assert.equal(rows.find((entry) => entry.customType === PROPOSAL_ENTRY).data.body, design.body);
	const grant = rows.find((entry) => entry.customType === APPROVAL_ENTRY);
	grant.data.source.mode = "rpc";
	await writeFile(h.sm.getSessionFile()!, rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	await assert.rejects(h.run(implementation), /批准记录已变化/);
});

test("符号链接 cwd 绑定 canonical workspace，不误判为确认期间换目录", async () => {
	const h = await host();
	const alias = path.join(h.cwd, "alias");
	await symlink(h.cwd, alias);
	h.ctx.cwd = alias;
	assert.equal((await h.run()).details.approved, true);
	assert.equal((await h.disk()).find((entry) => entry.customType === PROPOSAL_ENTRY).data.cwd, h.cwd);
});

for (const timing of ["after-design", "during-confirmation"]) {
	test(`批准正文在 ${timing} 被更改时不得确认新的批准`, async () => {
		const h = await host();
		const tamper = async () => {
			const rows = await h.disk();
			rows.find((entry) => entry.customType === PROPOSAL_ENTRY).data.body = "被外部替换的正文";
			await writeFile(h.sm.getSessionFile()!, rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		};
		if (timing === "after-design") {
			await h.run();
			await tamper();
			await assert.rejects(h.run(implementation), /变化|不一致/);
		} else {
			h.ctx.ui.select = async (_title: string, choices: string[]) => { await tamper(); return choices[1]; };
			await assert.rejects(h.run(), /变化|不一致/);
		}
	});
}

test("等待实施确认期间方案批准来源变化时不能新增实施批准", async () => {
	const h = await host();
	await h.run();
	h.ctx.ui.select = async (_title: string, choices: string[]) => {
		const rows = await h.disk();
		rows.find((entry) => entry.customType === APPROVAL_ENTRY).data.source.mode = "rpc";
		await writeFile(h.sm.getSessionFile()!, rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		return choices[1];
	};
	await assert.rejects(h.run(implementation), /批准记录已变化/);
	assert.equal(h.entries(APPROVAL_ENTRY).length, 1);
});
