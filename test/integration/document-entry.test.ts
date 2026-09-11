import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContextActions, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Context, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getWriterStateRoot, resolveWorkspaceIdentity, WriterLeaseManager } from "../../extensions/delivery-gate/src/workspace.ts";
import { approvalUI } from "../support/delivery-ui.ts";

const entry = fileURLToPath(new URL("../../extensions/delivery-gate/index.ts", import.meta.url));
const documentWrite = "delivery_document_write";
const documentEdit = "delivery_document_edit";

// 真实 Pi 加载器与 AgentSession；只有交互选择是测试替身，不是用户 TUI 验收。
async function host(t: TestContext, configure?: (pi: ExtensionAPI) => void, conflict?: string, resume?: { cwd: string; sessionFile: string }, activate = true) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "document-entry-")));
	const cwd = resume?.cwd ?? path.join(root, "repo");
	const agentDir = path.join(root, "agent");
	await Promise.all([cwd, agentDir].map((dir) => mkdir(dir, { recursive: true })));
	if (!resume) execFileSync("git", ["init", "--quiet"], { cwd });
	await writeFile(path.join(agentDir, "auth.json"), "{}\n");
	const settingsManager = SettingsManager.inMemory({ defaultProvider: "document-fixture", defaultModel: "fake", retry: { enabled: false }, compaction: { enabled: false } });
	let calls: ToolCall[] = [];
	let followups: ToolCall[][] = [];
	const contexts: Context["messages"][] = [];
	const prompts: string[] = [];
	let feedback: (() => string | undefined) | undefined;
	let api!: ExtensionAPI;
	const notices: string[] = [];
	const choices: string[] = [];
	let select: ExtensionUIContext["select"] = async (title, items) => { choices.push(title); return items[0]; };
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionsOverride: (loaded) => ({ ...loaded, extensions: [...loaded.extensions].reverse() }),
		additionalExtensionPaths: [entry], extensionFactories: [(pi) => {
			api = pi;
			pi.registerProvider("document-fixture", { api: "document-fixture", apiKey: "test-only", baseUrl: "http://127.0.0.1",
				models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1024 }],
				streamSimple(model, context) {
					const stream = createAssistantMessageEventStream();
					contexts.push(structuredClone(context.messages));
					prompts.push(context.systemPrompt ?? "");
					const content = calls.length ? calls : followups.shift() ?? [];
					calls = [];
					queueMicrotask(() => {
						stream.push({ type: "done", reason: content.length ? "toolUse" : "stop", message: {
							role: "assistant", api: model.api, provider: model.provider, model: model.id,
							content: content.length ? content : [{ type: "text", text: "测试回合结束" }], stopReason: content.length ? "toolUse" : "stop", timestamp: Date.now(),
							usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						} });
						stream.end();
					});
					return stream;
				},
			});
			configure?.(pi);
		}] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const sm = resume ? SessionManager.open(resume.sessionFile) : SessionManager.create(cwd, path.join(root, "sessions"));
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
	const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: sm });
	t.after(async () => {
		await session.abort();
		try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
		finally { session.dispose(); }
	});
	await session.bindExtensions({ mode: "tui", commandContextActions: { reload: () => session.reload() } as ExtensionCommandContextActions, uiContext: {
		custom: approvalUI((...args) => select(...args), () => feedback?.()),
		select: (...args: Parameters<ExtensionUIContext["select"]>) => select(...args), notify: (text: string) => { notices.push(text); },
	} as unknown as ExtensionUIContext, onError: (error) => notices.push(error.error) });
	const model = modelRuntime.getModel("document-fixture", "fake");
	assert.ok(model);
	await session.setModel(model);
	if (activate) await session.prompt("/delivery-shape");
	const workspace = await resolveWorkspaceIdentity(cwd);
	const leases = new WriterLeaseManager(await getWriterStateRoot(workspace));
	const call = async (name: string, args: Record<string, unknown>) => {
		const id = randomUUID();
		calls = [{ type: "toolCall", id, name, arguments: args }];
		await session.prompt("执行本轮测试调用");
		const result = sm.getBranch().findLast((row) => row.type === "message" && row.message.role === "toolResult" && row.message.toolCallId === id);
		assert.ok(result?.type === "message" && result.message.role === "toolResult", JSON.stringify(session.messages));
		return result.message;
	};
	const approve = (stage = "design", paths = ["plan.md"]) => {
		const latest = sm.getBranch().findLast((row) => row.type === "custom" && row.customType === "delivery-approval-proposal" && (row.data as any)?.stage === "design") as any;
		const documentStrategy = stage === "design" ? paths.length ? "reuse" : "none" : latest?.data.documentStrategy ?? "reuse";
		return call("delivery_approval", { stage, body: `待确认正文 ${stage}`, documentStrategy, ...(stage === "design" && paths.length ? { technicalPlanPath: paths[0], implementationPlanPath: paths[0] } : {}), paths, validationCommands: [] });
	};
	t.diagnostic(JSON.stringify({ root, sdk: "0.85.1", ui: "simulated" }));
	return { root, cwd, sm, session, api, notices, choices, call, approve, contexts, prompts, readLease: () => leases.read(workspace.key),
		setFollowups: (steps: ToolCall[][]) => { followups = steps; },
		setFeedback: (callback: typeof feedback) => { feedback = callback; },
		setSelect: (callback: typeof select) => { select = callback; } };
}

const reviewCall = (body: string, paths = ["plan.md"]): ToolCall => ({ type: "toolCall", id: randomUUID(), name: "delivery_approval", arguments: { stage: "design", body, documentStrategy: paths.length ? "reuse" : "none", ...(paths.length ? { technicalPlanPath: "plan.md", implementationPlanPath: "plan.md" } : {}), paths, validationCommands: [] } });
const editCall = (oldText: string, newText: string): ToolCall => ({ type: "toolCall", id: randomUUID(), name: documentEdit, arguments: { path: "plan.md", edits: [{ oldText, newText }] } });
const readCall = (): ToolCall => ({ type: "toolCall", id: randomUUID(), name: "read", arguments: { path: "plan.md" } });

test("未启用交付时普通写入、Shell 和第三方工具沿用原行为，退出后恢复", async (t) => {
	const h = await host(t, (pi) => pi.registerTool({ name: "plugin_tool", label: "原插件", description: "原插件工具", parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "PLUGIN_ORIGINAL" }], details: {} }) }), undefined, undefined, false);
	const original = h.session.getActiveToolNames();
	assert.ok(original.includes("bash") && original.includes("write") && original.includes("plugin_tool"));
	assert.ok(!h.session.getAllTools().some((tool) => tool.name.startsWith("delivery_")));
	await h.session.prompt("普通明确需求，不使用交付流程");
	await h.session.prompt("/delivery-status");
	const beforeViewing = h.contexts.length;
	await h.session.prompt("/delivery-tasks");
	await h.session.prompt("/delivery-resume");
	assert.equal(h.contexts.length, beforeViewing, "被动入口不调用模型或启用约束");
	assert.deepEqual(h.session.getActiveToolNames(), original);
	assert.equal((await h.call("write", { path: "normal.txt", content: "正常写入" })).isError, false);
	assert.equal((await h.call("bash", { command: "printf NORMAL_SHELL" })).isError, false);
	assert.match(JSON.stringify((await h.call("plugin_tool", {})).content), /PLUGIN_ORIGINAL/);
	assert.ok(h.prompts.every((prompt) => !prompt.includes("交付已启用：")));
	assert.ok(!h.sm.getEntries().some((row) => row.type === "custom" && row.customType === "delivery-activation"));
	await h.session.prompt("/delivery-shape");
	assert.ok(h.session.getActiveToolNames().includes("write"));
	h.api.setActiveTools([...h.session.getActiveToolNames(), "write", "plugin_tool"]);
	assert.equal((await h.call("write", { path: "blocked.txt", content: "原工具" })).isError, false);
	assert.equal((await h.call("plugin_tool", {})).isError, false);
	assert.match(h.prompts.at(-1)!, /交付已启用：保留 Pi 原有工具与权限检查/);
	assert.ok(h.prompts.at(-1)!.includes(fileURLToPath(new URL("../../skills/adaptive-delivery/SKILL.md", import.meta.url))));
	await h.session.prompt("/delivery-exit");
	assert.deepEqual(h.session.getActiveToolNames(), original);
	assert.ok(!h.session.getAllTools().some((tool) => tool.name.startsWith("delivery_")));
	assert.equal((await h.call("write", { path: "after.txt", content: "恢复" })).isError, false);
	assert.match(JSON.stringify((await h.call("plugin_tool", {})).content), /PLUGIN_ORIGINAL/);
	assert.ok(!h.prompts.at(-1)!.includes("交付已启用："));
	assert.equal(await readFile(path.join(h.cwd, "normal.txt"), "utf8"), "正常写入");
	assert.equal(await readFile(path.join(h.cwd, "blocked.txt"), "utf8"), "原工具");
	assert.equal(h.choices.length, 0);
});

test("显式进入后的 reload 和重开保留交付入口及普通工具，旧批准不恢复", async (t) => {
	const h = await host(t);
	await h.call(documentWrite, { path: "plan.md", content: "原始规划" });
	await h.approve();
	await h.session.reload();
	assert.equal((await h.approve("implementation", ["src"])).isError, true);
	assert.ok(h.session.getActiveToolNames().includes("write"));
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	const reopened = await host(t, undefined, undefined, { cwd: h.cwd, sessionFile: h.sm.getSessionFile()! }, false);
	assert.ok(reopened.session.getActiveToolNames().includes(documentWrite));
	assert.ok(reopened.session.getActiveToolNames().includes("write"));
	await reopened.session.prompt("/delivery-exit");
	const normal = await host(t, undefined, undefined, { cwd: h.cwd, sessionFile: h.sm.getSessionFile()! }, false);
	assert.ok(normal.session.getActiveToolNames().includes("write"));
	assert.ok(!normal.session.getAllTools().some((tool) => tool.name.startsWith("delivery_")));
});

for (const failure of ["record", "lock"]) test(`真实 SDK 退出遇到未知 writer ${failure} 保持门禁与现场`, async (t) => {
	const h = await host(t);
	const workspace = await resolveWorkspaceIdentity(h.cwd);
	const directory = path.join(await getWriterStateRoot(workspace), "leases");
	await mkdir(directory, { recursive: true });
	const file = path.join(directory, `${workspace.key}.${failure === "record" ? "json" : "operation-lock"}`);
	if (failure === "record") await writeFile(file, "broken");
	else await mkdir(file);
	await h.session.prompt("/delivery-exit");
	assert.ok(h.session.getActiveToolNames().includes("write"));
	assert.ok(h.notices.some((text) => text.startsWith("暂不能退出交付")));
	await access(file);
	assert.ok(!h.sm.getEntries().some((row) => row.type === "custom" && row.customType === "delivery-activation" && (row.data as any).enabled === false));
});

// 与 Pi 原生手动命令入口同序：分派 user_bash，再由 Session 执行或记录扩展结果。
async function userBash(h: Awaited<ReturnType<typeof host>>, command: string, excludeFromContext = false, onChunk?: (chunk: string) => void) {
	const event = await h.session.extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext, cwd: h.cwd });
	if (event?.result) {
		h.session.recordBashResult(command, event.result, { excludeFromContext });
		return event.result;
	}
	return h.session.executeBash(command, onChunk, { excludeFromContext, operations: event?.operations });
}

test("父 TUI 手动 Shell 保留退出码和 !! 上下文语义，普通模型 Shell 同样可用但不产生交付批准", async (t) => {
	const h = await host(t);
	const chunks: string[] = [];
	const pwd = await userBash(h, "pwd", false, (chunk) => chunks.push(chunk));
	assert.equal(pwd.exitCode, 0, pwd.output);
	assert.equal(await realpath(pwd.output.trim()), h.cwd);
	assert.equal(chunks.join(""), pwd.output);
	const written = await userBash(h, "printf VISIBLE_MANUAL; printf USER_CONTENT | tr A-Z a-z > manual.txt");
	assert.equal(written.exitCode, 0, written.output);
	assert.equal(await readFile(path.join(h.cwd, "manual.txt"), "utf8"), "user_content");
	const hidden = await userBash(h, "printf HIDDEN_MANUAL", true);
	assert.equal(hidden.exitCode, 0, hidden.output);
	assert.equal(hidden.output, "HIDDEN_MANUAL");
	const failed = await userBash(h, "printf MANUAL_FAILURE; exit 7");
	assert.equal(failed.exitCode, 7);
	assert.equal(failed.output, "MANUAL_FAILURE");
	const denied = await h.call("bash", { command: "printf MODEL_OVERWRITE > manual.txt" });
	assert.equal(denied.isError, false);
	assert.equal(await readFile(path.join(h.cwd, "manual.txt"), "utf8"), "MODEL_OVERWRITE");
	const context = JSON.stringify(h.contexts);
	assert.match(context, /VISIBLE_MANUAL/);
	assert.doesNotMatch(context, /HIDDEN_MANUAL/);
	const rows = (await readFile(h.sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	const commands = rows.filter((row) => row.message?.role === "bashExecution").map((row) => row.message);
	assert.deepEqual(commands.map((row) => row.exitCode), [0, 0, 0, 7]);
	assert.equal(commands.find((row) => row.output === "HIDDEN_MANUAL")?.excludeFromContext, true);
	assert.ok(!rows.some((row) => ["delivery-approval", "delivery-validation"].includes(row.customType)));
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, 0);
});

test("父 TUI 手动 Shell 保留原生取消与 reload 后执行", { timeout: 20_000 }, async (t) => {
	const h = await host(t);
	let pid: number | undefined;
	const result = await userBash(h, 'printf "MANUAL_RUNNING:%s\\n" "$$"; sleep 30', false, (chunk) => {
		const match = chunk.match(/MANUAL_RUNNING:(\d+)/);
		if (match) { pid = Number(match[1]); h.session.abortBash(); }
	});
	assert.equal(result.cancelled, true, result.output);
	assert.ok(pid, "必须取得真实 Shell PID 后才取消");
	assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
	assert.equal(h.session.isBashRunning, false);
	await h.session.reload();
	const pwd = await userBash(h, "pwd");
	assert.equal(pwd.exitCode, 0, pwd.output);
	assert.equal(await realpath(pwd.output.trim()), h.cwd);
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, 0);
});

test("父 TUI 手动 Shell 继续交给已有扩展处理，不覆盖其执行结果", async (t) => {
	let received = false;
	const h = await host(t, (pi) => pi.on("user_bash", (event) => {
		if (event.command !== "fixture-existing-shell") return;
		received = true;
		return { result: { output: "EXISTING_SHELL_BACKEND", exitCode: 9, cancelled: false, truncated: false } };
	}));
	const result = await userBash(h, "fixture-existing-shell", true);
	assert.equal(received, true);
	assert.deepEqual(result, { output: "EXISTING_SHELL_BACKEND", exitCode: 9, cancelled: false, truncated: false });
	assert.equal(h.session.messages.at(-1)?.role, "bashExecution");
});

test("真实 SDK 在同一模型回合接收两轮意见、修订同一方案并批准最新提案", async (t) => {
	const h = await host(t);
	await h.call(documentWrite, { path: "plan.md", content: "方案 V1\n用户段落\n" });
	const suggestions = ["改为 V2，保留用户段落", "再调整为 V3"];
	h.setFeedback(() => suggestions.shift());
	h.setFollowups([
		[readCall()], [editCall("方案 V1", "方案 V2")], [readCall()], [reviewCall("plan.md：方案 V2；保留用户段落")],
		[readCall()], [editCall("方案 V2", "方案 V3")], [readCall()], [reviewCall("plan.md：方案 V3；保留用户段落")],
	]);
	const first = await h.call("delivery_approval", reviewCall("plan.md：方案 V1").arguments);
	assert.equal(first.isError, false);
	assert.equal((first.details as any).feedback, "改为 V2，保留用户段落");
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "方案 V3\n用户段落\n");
	assert.equal(await h.readLease(), undefined);
	const rows = (await readFile(h.sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	const designs = rows.filter((row) => row.customType === "delivery-approval-proposal" && row.data.stage === "design");
	assert.equal(designs.length, 3);
	assert.equal(new Set(designs.map((row) => row.data.id)).size, 3);
	const approved = rows.filter((row) => row.customType === "delivery-approval");
	assert.equal(approved.length, 1, "只有最后方案一份批准，文档编辑无审批");
	assert.equal(approved[0].data.proposalId, designs[2].data.id);
	const feedbackResults = rows.filter((row) => row.message?.role === "toolResult" && row.message.details?.feedback);
	assert.deepEqual(feedbackResults.map((row) => row.message.details.feedback), ["改为 V2，保留用户段落", "再调整为 V3"]);
	for (const text of ["改为 V2，保留用户段落", "再调整为 V3"]) assert.ok(h.contexts.some((messages) => messages.some((message) => message.role === "toolResult" && (message.details as any)?.feedback === text)));
	assert.ok(!rows.some((row) => row.message?.toolName === "delivery_develop" || row.data?.stage === "implementation"));
	assert.deepEqual(h.notices.filter((text) => !text.startsWith("交付已启用")), []);
});

test("无规划文档的真实 SDK 方案反馈、暂停和重载恢复仅使用会话正文", async (t) => {
	const h = await host(t), files = await readdir(h.cwd);
	const suggestions = ["保留原接口，只调整参数值"];
	h.setFeedback(() => suggestions.shift());
	h.setSelect(async (_title, items) => items.at(-1));
	h.setFollowups([[reviewCall("V2：保留接口，只修参数", [])]]);
	const first = await h.call("delivery_approval", reviewCall("V1：局部参数修改", []).arguments);
	assert.equal(first.isError, false, JSON.stringify(first));
	assert.equal((first.details as any).feedback, "保留原接口，只调整参数值");
	assert.equal(h.sm.getBranch().filter((row) => row.type === "custom" && row.customType === "delivery-approval").length, 0);
	await h.session.reload();
	assert.equal((await h.approve("implementation", ["src"])).isError, true);
	h.setSelect(async (_title, items) => items[0]);
	const resumed = reviewCall("V3：核对现场后修正参数，接口保持", []);
	h.setFollowups([[resumed]]);
	await h.session.prompt("/delivery-resume");
	for (let i = 0; i < 100 && !h.sm.getBranch().some((row) => row.type === "message" && row.message.role === "toolResult" && row.message.toolCallId === resumed.id); i++) await setTimeout(20);
	await h.session.agent.waitForIdle();
	const result = h.sm.getBranch().find((row) => row.type === "message" && row.message.role === "toolResult" && row.message.toolCallId === resumed.id);
	assert.ok(result?.type === "message" && result.message.role === "toolResult", JSON.stringify(h.notices));
	assert.equal(result.message.isError, false);
	assert.equal((result.message.details as any).approved, true);
	assert.equal((await h.approve("implementation", ["src"])).isError, false);
	const rows = (await readFile(h.sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	const designs = rows.filter((row) => row.customType === "delivery-approval-proposal" && row.data.stage === "design");
	assert.deepEqual(designs.map((row) => row.data.paths), [[], [], []]);
	const approved = rows.filter((row) => row.customType === "delivery-approval");
	assert.equal(approved.length, 2);
	assert.equal(approved[0].data.proposalId, designs[2].data.id);
	assert.ok(h.contexts.some((messages) => messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("V2：保留接口，只修参数"))));
	assert.ok(!rows.some((row) => ["read", documentWrite, documentEdit].includes(row.message?.toolName)));
	assert.deepEqual(await readdir(h.cwd), files);
	assert.equal(await h.readLease(), undefined);
});

for (const mode of ["language", "command", "reload", "reopen"]) test(`真实 SDK 暂停后 ${mode} 读取用户最新文件，用新提案恢复审阅`, async (t) => {
	const original = await host(t);
	await original.call(documentWrite, { path: "plan.md", content: "方案 V1\n用户段落\n" });
	original.setSelect(async (_title, items) => items.at(-1));
	const beforePause = original.contexts.length;
	const paused = await original.call("delivery_approval", reviewCall("方案：plan.md；V1").arguments);
	assert.equal((paused.details as any).paused, true);
	assert.equal(original.contexts.length, beforePause + 1, "暂停必须终止模型续转");
	await writeFile(path.join(original.cwd, "plan.md"), "方案 V2：用户已调整\n用户段落\n");
	let h = original;
	if (mode === "reload") await h.session.reload();
	if (mode === "reopen") {
		await original.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		h = await host(t, undefined, undefined, { cwd: original.cwd, sessionFile: original.sm.getSessionFile()! });
	}
	h.setSelect(async (_title, items) => items.at(-1)); // 恢复后依然可稍后再看
	const resumed = reviewCall("plan.md：V2，用户已调整；保留用户段落");
	h.setFollowups([[readCall()], [resumed]]);
	if (mode === "language") await h.session.prompt("继续看方案，我在项目中调整了文档");
	else {
		await h.session.prompt("/delivery-resume");
		for (let i = 0; i < 100 && !h.sm.getBranch().some((row) => row.type === "message" && row.message.role === "toolResult" && row.message.toolCallId === resumed.id); i++) await setTimeout(20);
		await h.session.agent.waitForIdle();
	}
	const rows = h.sm.getBranch();
	const result = rows.find((row) => row.type === "message" && row.message.role === "toolResult" && row.message.toolCallId === resumed.id);
	assert.ok(result?.type === "message" && result.message.role === "toolResult", JSON.stringify(h.notices));
	assert.equal((result.message.details as any).paused, true);
	assert.notEqual((result.message.details as any).proposalId, (paused.details as any).proposalId);
	assert.ok(h.contexts.some((messages) => messages.some((message) => message.role === "toolResult" && message.toolName === "read" && JSON.stringify(message.content).includes("V2：用户已调整"))));
	assert.equal(rows.filter((row) => row.type === "custom" && row.customType === "delivery-approval").length, 0);
	const edited = await h.call(documentEdit, { path: "plan.md", edits: [{ oldText: "用户段落", newText: "用户段落\n新增意见" }] });
	assert.equal(edited.isError, false, JSON.stringify(edited));
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "方案 V2：用户已调整\n用户段落\n新增意见\n");
	assert.equal(await h.readLease(), undefined);
});

test("正式入口默认创建及持续编辑，文档写入无审批，进度更新不替换方案与实施正文", async (t) => {
	const h = await host(t);
	for (const name of [documentWrite, documentEdit]) {
		assert.equal(h.session.getAllTools().find((tool) => tool.name === name)?.sourceInfo.path, entry);
		assert.ok(h.session.getActiveToolNames().includes(name));
	}
	assert.equal((await h.call(documentWrite, { path: "plan.md", content: "任意正文\n进度：待验证\n" })).isError, false);
	assert.equal(await h.readLease(), undefined);
	assert.equal(h.choices.length, 0);
	assert.equal((await h.approve()).isError, false);
	assert.equal((await h.approve("implementation")).isError, false);
	const approved = structuredClone(h.sm.getEntries().filter((row) => row.type === "custom"));
	await writeFile(path.join(h.cwd, "plan.md"), "任意正文\n进度：待验证\n用户补充\n");
	assert.equal((await h.call(documentEdit, { path: "plan.md", edits: [{ oldText: "进度：待验证", newText: "进度：已验证" }] })).isError, false);
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "任意正文\n进度：已验证\n用户补充\n");
	assert.equal(await h.readLease(), undefined);
	assert.deepEqual(h.sm.getEntries().filter((row) => row.type === "custom"), approved);
	const disk = (await readFile(h.sm.getSessionFile()!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(disk.filter((row) => row.type === "custom"), approved);
	assert.equal(h.choices.length, 2, "只有方案与实施确认");
});

test("交付文档工具拒绝源码、越界与 Git，普通文件和 Shell 沿用 Pi", async (t) => {
	const h = await host(t);
	assert.equal((await h.call(documentWrite, { path: "other.md", content: "默认允许" })).isError, false);
	assert.equal(await h.readLease(), undefined);
	for (const target of ["src.ts", ".git/forbidden.md", "../outside.md"]) {
		assert.equal((await h.call(documentWrite, { path: target, content: "禁止" })).isError, true);
		assert.equal(await h.readLease(), undefined);
		await assert.rejects(access(path.resolve(h.cwd, target)), { code: "ENOENT" });
	}
	h.api.setActiveTools([...h.session.getActiveToolNames(), "write", "edit", "bash"]);
	assert.equal((await h.call("write", { path: "plan.md", content: "原工具" })).isError, false);
	assert.equal((await h.call("bash", { command: "touch forbidden.txt" })).isError, false);
	assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "原工具");
	await access(path.join(h.cwd, "forbidden.txt"));
	assert.equal(h.choices.length, 0);
});

for (const name of [documentWrite, documentEdit]) for (const phase of ["startup", "late"]) test(`正式入口拒绝 ${phase} 注册的同名 ${name} 覆盖`, async (t) => {
	const replace = (pi: ExtensionAPI) => pi.registerTool({ name, label: "测试覆盖", description: "不应执行", parameters: Type.Object({}),
		execute: async (_id, _args, _signal, _update, ctx) => { await writeFile(path.join(ctx.cwd, "forbidden.txt"), "禁止"); return { content: [], details: {} }; } });
	const h = await host(t, phase === "startup" ? replace : undefined, phase === "startup" ? name : undefined);
	if (phase === "late") replace(h.api);
	h.api.setActiveTools([...h.session.getActiveToolNames(), name]);
	assert.notEqual(h.session.getAllTools().find((tool) => tool.name === name)?.sourceInfo.path, entry);
	const result = await h.call(name, {});
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /实现来源已变化/);
	assert.equal(await h.readLease(), undefined);
	await assert.rejects(access(path.join(h.cwd, "forbidden.txt")), { code: "ENOENT" });
});

for (const boundary of ["paused-design", "design", "implementation", "reload", "tree"]) {
	test(`正式入口 ${boundary} 后仍可编辑文档，不恢复实施批准`, async (t) => {
		const h = await host(t);
		await h.call(documentWrite, { path: "plan.md", content: "用户段落\n" });
		if (boundary === "paused-design") h.setSelect(async () => undefined);
		assert.equal((await h.approve()).isError, false);
		if (boundary === "implementation" || boundary === "reload" || boundary === "tree") await h.approve("implementation", ["src"]);
		if (boundary === "reload") await h.session.reload();
		if (boundary === "tree") await h.session.navigateTree(h.sm.getEntries()[0]!.id, { summarize: false });
		const dialogs = h.choices.length;
		assert.equal((await h.call(documentEdit, { path: "plan.md", edits: [{ oldText: "用户段落", newText: "用户段落\n补充证据" }] })).isError, false);
		assert.equal(h.choices.length, dialogs);
		if (boundary !== "implementation") assert.equal((await h.call("delivery_develop", { task: "不能沿旧批准写源码" })).isError, true);
		assert.equal(await h.readLease(), undefined);
		assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "用户段落\n补充证据\n");
	});
}

test("默认文档编辑拒绝链接，普通匹配失败收尾后可以修正", async (t) => {
	const h = await host(t);
	await writeFile(path.join(h.cwd, "user.md"), "用户原文");
	await symlink("user.md", path.join(h.cwd, "plan.md"));
	assert.equal((await h.call(documentWrite, { path: "plan.md", content: "禁止" })).isError, true);
	assert.equal(await readFile(path.join(h.cwd, "user.md"), "utf8"), "用户原文");
	assert.equal(await h.readLease(), undefined);
	assert.equal((await h.call(documentEdit, { path: "user.md", edits: [{ oldText: "不匹配", newText: "禁止" }] })).isError, true);
	assert.equal(await h.readLease(), undefined);
	assert.equal((await h.call(documentEdit, { path: "user.md", edits: [{ oldText: "用户原文", newText: "用户原文\n验证证据" }] })).isError, false);
	assert.equal(await readFile(path.join(h.cwd, "user.md"), "utf8"), "用户原文\n验证证据");
	assert.equal(h.choices.length, 0);
});

for (const failure of ["tamper-result", "persistence"]) test(`正式入口的终态 ${failure} 关闭交接及后续写入`, async (t) => {
	let file: string | undefined;
	const h = await host(t, (pi) => {
		pi.on("tool_result", async (event, ctx) => {
			if (event.toolName !== documentWrite) return;
			if (failure === "tamper-result") return { content: [{ type: "text", text: "替换结果" }] };
			if (file) return;
			file = ctx.sessionManager.getSessionFile();
			await chmod(file!, 0o400);
		});
	});
	try {
		const run = h.call(documentWrite, { path: "plan.md", content: "已经写入" });
		if (failure === "persistence") await assert.rejects(run, { code: "EACCES" });
		else await run;
		assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "已经写入");
		assert.ok(await h.readLease());
		assert.ok(h.notices.some((notice) => notice.includes("父 writer 未交回")));
		if (file) {
			assert.ok(!(await readFile(file, "utf8")).includes('"toolName":"delivery_document_write"'));
			await chmod(file, 0o600);
		}
		const result = await h.call(documentWrite, { path: "plan.md", content: "禁止再次写入" });
		assert.equal(result.isError, true);
		assert.equal(await readFile(path.join(h.cwd, "plan.md"), "utf8"), "已经写入");
		assert.ok(await h.readLease());
	} finally { if (file) await chmod(file, 0o600); }
});

test("正式入口取消持有 writer 的文档调用，终态落盘后才交回", async (t) => {
	const h = await host(t);
	let release!: () => void;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const held = withFileMutationQueue(path.join(h.cwd, "plan.md"), () => new Promise<void>((resolve) => { release = resolve; entered(); }));
	await ready;
	const run = h.call(documentWrite, { path: "plan.md", content: "禁止写入" });
	let abort: Promise<void> | undefined;
	try {
		for (let i = 0; !await h.readLease(); i++) { assert.ok(i < 200, "未取得 writer，不能作为在途取消证据"); await setTimeout(10); }
		abort = h.session.abort();
		assert.ok(await h.readLease());
	} finally { release(); await held; }
	await abort;
	assert.equal((await run).isError, true);
	assert.equal(await h.readLease(), undefined);
	await assert.rejects(access(path.join(h.cwd, "plan.md")), { code: "ENOENT" });
});
