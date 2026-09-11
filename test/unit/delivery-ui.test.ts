import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme, SessionManager, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DeliveryPanel, DesignReviewPanel } from "../../extensions/delivery-gate/src/ui.ts";
import { createTaskProgress, taskRenderers, TOOL_ERROR_STATUS } from "../../extensions/delivery-gate/src/progress.ts";
import { installTaskDetails, taskDetails, createTaskRecordReader, TaskDetailsPanel } from "../../extensions/delivery-gate/src/task-details.ts";
import { plainTheme } from "../support/delivery-ui.ts";

const tui = { terminal: { rows: 32 }, requestRender() {} } as TUI;
const mouse = (type: TuiMouseEvent["type"], y: number): TuiMouseEvent => ({ type, button: "left", x: 1, y, screenX: 1, screenY: y, width: 80, height: 30, shift: false, alt: false, ctrl: false });

test("方案先阅读，按需输入意见；空提交和查看详情不批准，多行及大粘贴完整发送", () => {
	const results: unknown[] = [];
	const panel = new DesignReviewPanel("方案：docs/设计.md", "完整条件\n".repeat(80) + "END", tui, plainTheme, (value) => results.push(value));
	panel.focused = true;
	assert.ok(!panel.render(80).join("\n").includes(CURSOR_MARKER));
	panel.handleInput("\x1b[A");
	panel.handleInput("\r");
	assert.ok(panel.render(80).join("\n").includes(CURSOR_MARKER));
	panel.handleInput("\r");
	panel.handleInput("\x0f");
	panel.handleInput("\x1b[6~");
	panel.handleInput("\r");
	assert.deepEqual(results, []);
	panel.handleInput("先保留原接口");
	panel.handleInput("\x1b\r");
	const paste = "中文与代码意见\n".repeat(300) + "最后一条";
	panel.handleInput(`\x1b[200~${paste}\x1b[201~`);
	for (const width of [20, 40, 80]) {
		const lines = panel.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.length < 30);
	}
	panel.handleInput("\r");
	assert.deepEqual(results, [{ feedback: `先保留原接口\n${paste}` }]);
});

test("方案默认稍后再看，鼠标可打开意见，Esc 返回保留草稿且不批准", () => {
	const results: unknown[] = [];
	const panel = new DesignReviewPanel("方案", "详情", tui, plainTheme, (value) => results.push(value));
	panel.focused = true;
	assert.ok(!panel.render(80).join("\n").includes(CURSOR_MARKER));
	panel.handleInput("\r");
	assert.deepEqual(results, [undefined]);
	let lines = panel.render(80);
	const y = lines.findIndex((line) => line.includes("提出修改意见"));
	panel.handleMouse(mouse("press", y));
	panel.handleMouse(mouse("release", y));
	assert.equal(results.length, 1);
	assert.ok(!panel.render(80).join("\n").includes(CURSOR_MARKER));
	panel.handleMouse(mouse("click", y));
	assert.ok(panel.render(80).join("\n").includes(CURSOR_MARKER));
	panel.handleInput("\r"); // 空意见不能批准
	assert.equal(results.length, 1);
	panel.handleInput("补充验收");
	panel.handleInput("\x1b");
	lines = panel.render(80);
	assert.ok(!lines.join("\n").includes(CURSOR_MARKER));
	assert.equal(results.length, 1);
	panel.handleMouse(mouse("click", lines.findIndex((line) => line.includes("提出修改意见"))));
	panel.handleInput("\r");
	assert.deepEqual(results[1], { feedback: "补充验收" });
	panel.handleInput("\x1b");
	lines = panel.render(80);
	panel.handleMouse(mouse("click", lines.findIndex((line) => line.includes("确认方案"))));
	assert.equal(results[2], "确认方案");
	panel.handleInput("\x1b");
	assert.equal(results[3], undefined);
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) test(`${Renderer.name} 的底部审阅编辑与 Esc 焦点恢复`, () => {
	let feed!: (data: string) => void;
	let mainKeys = 0;
	const terminal: Terminal = { rows: 32, columns: 80, kittyProtocolActive: false,
		start(input) { feed = input; }, stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
	const renderer = new Renderer(terminal);
	const main = { render: () => ["主对话"], invalidate() {}, handleInput() { mainKeys++; } };
	const results: unknown[] = [];
	const panel = new DesignReviewPanel("方案", "正文\n".repeat(100), renderer, plainTheme, (result) => {
		results.push(result); renderer.removeChild(panel); renderer.setFocus(main);
	});
	renderer.addChild(main);
	renderer.addChild(panel);
	renderer.setFocus(panel);
	renderer.start();
	try {
		renderer.renderNow();
		assert.equal(renderer.hasOverlay(), false);
		feed("\x1b[A");
		feed("\r");
		assert.equal(results.length, 0);
		feed("意见");
		feed("\x1b");
		assert.equal(results.length, 0, "输入中的 Esc 先返回方案，不结束审阅");
		feed("\x1b");
		assert.deepEqual(results, [undefined]);
		assert.equal(mainKeys, 0);
		feed("下一条消息");
		assert.equal(mainKeys, 1);
	} finally { renderer.stop(); }
});

for (const accept of ["确认实施"]) test(`${accept} 在上但默认回车不批准，滚动和查看详情不改变选择`, () => {
	const results: unknown[] = [];
	const panel = new DeliveryPanel("批准", "简短说明\n".repeat(100), "完整命令\n".repeat(80) + "最后一个条件", [accept, "暂不批准"], tui, plainTheme, (value) => results.push(value), 1);
	for (const width of [20, 80]) {
		const lines = panel.render(width);
		assert.ok(lines.findIndex((line) => line.includes(accept)) < lines.findIndex((line) => line.includes("暂不批准")));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.length <= 22, "底部审批不能占满终端");
	}
	panel.handleInput("\x0f");
	panel.handleInput("\x1b[F");
	assert.match(panel.render(80).join("\n"), /最后一个条件/);
	panel.handleInput("\r");
	assert.deepEqual(results, ["暂不批准"]);
	panel.handleInput("\x1b[A");
	panel.handleInput("\r");
	assert.deepEqual(results, ["暂不批准", accept]);
});

test("鼠标确认使用 Pi 的点击事件，按下和滚轮不批准", () => {
	const results: unknown[] = [];
	const panel = new DeliveryPanel("批准", "line\n".repeat(100), "完整内容", ["确认", "暂不批准"], tui, plainTheme, (value) => results.push(value), 1);
	const y = panel.render(80).findIndex((line) => line.includes("确认") && !line.includes("Enter"));
	panel.handleMouse({ ...mouse("wheel", 1), wheelDelta: 3 });
	assert.equal(results.length, 0);
	panel.handleMouse(mouse("press", y));
	assert.equal(results.length, 0);
	panel.handleMouse(mouse("release", y));
	assert.equal(results.length, 0);
	panel.handleMouse(mouse("click", y));
	assert.deepEqual(results, ["确认"]);
});

test("确认面板适应窄终端；显示不下时仍可退出，不能选择不可见的批准操作", () => {
	const screen = { terminal: { rows: 32 }, requestRender() {} };
	for (const stage of ["design", "implementation"]) {
		const results: unknown[] = [];
		const notice = "确认后在本机开发、验收和返工；Shell 使用你的权限，不受文件路径隔离。\n提交、推送、PR、发布、部署、生产及其他外部写入需另行授权。";
		const panel = stage === "design" ? new DesignReviewPanel("改法\n".repeat(100), "详情", screen as TUI, plainTheme, (value) => results.push(value), notice)
			: new DeliveryPanel("实施确认", "步骤\n".repeat(100), "详情", ["确认实施", "暂不批准"], screen as TUI, plainTheme, (value) => results.push(value), 1, notice);
		for (const rows of [10, 20, 32, 60]) for (const width of [20, 40, 80, 110]) {
			screen.terminal.rows = rows;
			const lines = panel.render(width);
			assert.ok(lines.length < rows);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		screen.terminal.rows = 10;
		assert.match(panel.render(20).join("\n"), /请放大终端/);
		panel.handleInput("\x1b[A"); panel.handleInput("\x1b[A"); panel.handleInput("\r");
		panel.handleMouse(mouse("click", 1));
		assert.deepEqual(results, []);
		panel.handleInput("\x1b");
		assert.deepEqual(results, [undefined]);
	}
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) test(`${Renderer.name} 的真实焦点分派：Esc 只关闭详情，下次 Esc 才交回主组件`, () => {
	let feed!: (data: string) => void;
	let mainKeys = 0;
	const terminal: Terminal = { rows: 32, columns: 80, kittyProtocolActive: false,
		start(input) { feed = input; }, stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
	const renderer = new Renderer(terminal);
	const main = { render: () => ["原任务继续运行"], invalidate() {}, handleInput() { mainKeys++; } };
	renderer.addChild(main);
	renderer.setFocus(main);
	renderer.start();
	try {
		const panel = new TaskDetailsPanel({ id: "a", label: "只读", status: "运行中", task: "任务正文" }, renderer, plainTheme, () => renderer.hideOverlay());
		renderer.showOverlay(panel);
		renderer.renderNow();
		feed("\x1b");
		assert.equal(renderer.hasOverlay(), false);
		assert.equal(mainKeys, 0);
		feed("\x1b");
		assert.equal(mainKeys, 1);
	} finally { renderer.stop(); }
});

test("真实工具卡片点击按 toolCallId 打开对应详情，折叠仍保持两行", () => {
	initTheme("dark");
	const opened: string[] = [];
	const tool: ToolDefinition = { name: "delivery_readonly", label: "只读", description: "", parameters: Type.Object({ task: Type.String() }),
		...taskRenderers("只读", (id) => opened.push(id)), execute: async () => ({ content: [], details: {} }) };
	const card = new ToolExecutionComponent(tool.name, "task-a", { task: "检查中文" }, {}, tool, tui, "/tmp");
	card.updateResult({ content: [{ type: "text", text: "结束" }], details: {}, isError: false });
	const rows = card.render(80);
	assert.equal(rows.filter((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).length, 2);
	assert.match(rows.join("\n"), /\/delivery-tasks/);
	// Pi 的 ToolExecutionComponent 本身沿 Container 的公开鼠标分派到 MouseRegion。
	for (let y = 0; y < rows.length && !opened.length; y++) card.handleMouse(mouse("click", y));
	assert.deepEqual(opened, ["task-a"]);
});

test("首次按需安装即能从卡片打开详情，分支切换更新上下文，关闭后不沿用旧上下文", async () => {
	const handlers = new Map<string, Function>();
	const pi: any = { on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand() {} };
	const opened: string[] = [];
	const context = (name: string): any => ({ mode: "tui", hasUI: true, sessionManager: { getBranch: () => [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "delivery_readonly", arguments: { task: name } }] } },
	] }, ui: { custom: async () => { opened.push(name); }, notify() {} } });
	const open = installTaskDetails(pi, () => [], context("首次会话"));
	open("a"); await Promise.resolve();
	assert.deepEqual(opened, ["首次会话"]);
	handlers.get("session_tree")!({}, context("新分支"));
	open("a"); await Promise.resolve();
	assert.deepEqual(opened, ["首次会话", "新分支"]);
	handlers.get("session_shutdown")!();
	open("a"); await Promise.resolve();
	assert.equal(opened.length, 2);
});

test("详情复用原生分支与长 Session，保留完整调用/结果、末行提示且排除 thinking", async () => {
	const readTaskRecord = createTaskRecordReader();
	const root = await mkdtemp(path.join(os.tmpdir(), "delivery-detail-"));
	await mkdir(path.join(root, "sessions"));
	const sm = SessionManager.create(root, path.join(root, "sessions"));
	const task = "任务原文".repeat(500);
	const assistant: any = { role: "assistant", content: [{ type: "toolCall", id: "a", name: "delivery_readonly", arguments: { task } },
		{ type: "toolCall", id: "b", name: "delivery_readonly", arguments: { task: "另一个任务" } }], timestamp: Date.now() };
	sm.appendMessage(assistant);
	const file = path.join(root, "child.jsonl");
	sm.appendCustomEntry("delivery-delegation", { id: "a", sessionFile: file });
	const rows = [
		{ type: "session", id: "child" },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "不得显示的推理" }, { type: "toolCall", id: "read", name: "read", arguments: { path: "file.txt" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "read", toolName: "read", isError: true, content: [{ type: "text", text: "BEGIN\n" + "正文".repeat(8000) + "\nEND" }] } },
	];
	await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n{\"type\":");
	const before = await readFile(file, "utf8");
	const progress = createTaskProgress("a", "只读", task, () => {});
	progress.phase("工具失败，子任务仍在运行", "正在取证", file);
	const tasks = taskDetails({ sessionManager: sm }, [progress.snapshot()]);
	assert.equal(tasks.length, 2);
	assert.equal(tasks[0]!.status, "工具失败，子任务仍在运行");
	const record = await readTaskRecord(tasks[0]!);
	assert.equal(record.task.task, task);
	assert.equal(record.entries[0]!.callId, "read");
	assert.equal(record.entries[0]!.name, "read");
	assert.equal(record.entries[0]!.failed, true);
	assert.match(record.entries[0]!.output!, /BEGIN\n(?:正文)+\nEND/);
	assert.match(record.notice!, /末行未完整/);
	assert.ok(!JSON.stringify(record).includes("不得显示的推理") && !JSON.stringify(record).includes("另一个任务"));
	assert.equal(await readFile(file, "utf8"), before);
	sm.appendMessage({ role: "toolResult", toolCallId: "a", toolName: "delivery_readonly", isError: true, content: [{ type: "text", text: "最终失败" }], timestamp: Date.now() });
	assert.equal(taskDetails({ sessionManager: sm }, [progress.snapshot()])[0]!.status, "失败", "旧进度不能覆盖原生最终结果");
});

test("卡片只显示已核实模型，原生记录重开后保留选择理由且不被旧进度覆盖", async () => {
	initTheme("dark");
	const root = await mkdtemp(path.join(os.tmpdir(), "delivery-agent-detail-"));
	const sm = SessionManager.create(root, root);
	const agent = { provider: "fixture-provider", id: "fixture-reasoner", thinking: "high", reason: "代码审查需要检查权限边界" };
	const progress = createTaskProgress("a", "审查", "核对代码", () => {});
	assert.equal(progress.snapshot().agent, undefined, "READY 前不能展示未经核实的选择");
	progress.agent(agent);
	progress.end(TOOL_ERROR_STATUS, "2 次工具异常 · bash：Command exited with code 1");
	const tool: ToolDefinition = { name: "delivery_review", label: "审查", description: "", parameters: Type.Object({}),
		...taskRenderers("审查"), execute: async () => ({ content: [], details: {} }) };
	const card = new ToolExecutionComponent(tool.name, "a", { task: "核对代码" }, {}, tool, tui, root);
	card.updateResult({ content: [], details: { progress: progress.snapshot() }, isError: false }, true);
	const rows = card.render(80).filter((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
	assert.equal(rows.length, 2);
	assert.match(rows[1]!, /fixture-reasoner.*high/);
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "a", name: tool.name, arguments: { task: "核对代码" } }], timestamp: Date.now() } as any);
	sm.appendCustomEntry("delivery-development", { id: "a", agent, childSessionFile: path.join(root, "child.jsonl") });
	assert.deepEqual(taskDetails({ sessionManager: sm }, [])[0]!.agent, agent);
	sm.appendMessage({ role: "toolResult", toolCallId: "a", toolName: tool.name, isError: false,
		content: [{ type: "text", text: "过程记录：原记录第 3 行，rg missing input.txt 返回 code 1" }], details: { progress: progress.snapshot() }, timestamp: Date.now() });
	progress.agent({ ...agent, thinking: "low", reason: "过时进度" });
	const reopened = SessionManager.open(sm.getSessionFile()!);
	const task = taskDetails({ sessionManager: reopened }, [progress.snapshot()])[0]!;
	assert.deepEqual(task.agent, agent);
	assert.equal(task.status, TOOL_ERROR_STATUS, "重开后保留过程错误提示，不还原为失败或无问题");
	const panel = new TaskDetailsPanel(task, tui, plainTheme, () => {});
	panel.update({ task, entries: [{ id: "result", name: "子任务说明", output: "已完成检查" }] });
	assert.match(panel.render(100).join("\n"), /fixture-reasoner.*high/);
	assert.match(panel.render(100).join("\n"), /2 次工具异常.*code 1/);
	assert.match(panel.render(100).join("\n"), /原记录第 3 行，rg missing input.txt/);
	panel.handleInput("\r");
	assert.match(panel.render(100).join("\n"), /fixture-provider\/fixture-reasoner.*high/);
	assert.match(panel.render(100).join("\n"), /代码审查需要检查权限边界/);
});

test("详情只留连续输出，万行滚动和完整任务切换保留阅读位置，Esc 直接关闭", () => {
	let closed = 0;
	const task = { id: "a", label: "开发", status: "运行中", task: "提取归档名称函数。" + "完整任务指令".repeat(1000), sessionFile: "/tmp/original-session.jsonl" };
	const record = { task, cwd: "/tmp/repo", entries: [
		{ id: "call:a", callId: "call_long_internal_id", line: 2, name: "read", args: { path: "/tmp/repo/中文.ts" }, output: "BEGIN\n" + "长输出\n".repeat(10_000) + "END", resultLine: 3 },
	] };
	const panel = new TaskDetailsPanel(task, tui, plainTheme, () => { closed++; });
	panel.update(record);
	const render = () => panel.render(80).join("\n");
	assert.ok(!render().includes("BEGIN") && !render().includes("call_long_internal_id") && !render().includes("original-session"));
	assert.doesNotMatch(render(), /工具过程|Tab 切换|\[概览\]/);
	assert.match(render(), /END/);
	const latest = render();
	for (const key of ["\t", "\x1b[C", "\x1b[D"]) { panel.handleInput(key); assert.equal(render(), latest); }
	for (const width of [20, 40, 80, 110]) {
		const lines = panel.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.length <= 28);
		if (width >= 32) assert.ok(lines.every((line) => visibleWidth(line) === width), "边框与留白必须补齐宽度，避免背景透出");
	}
	panel.handleInput("\r");
	assert.match(render(), /完整任务/);
	panel.handleInput("\x1b[F");
	assert.match(render(), /original-session/);
	panel.handleInput("\r");
	panel.handleInput("\x1b[H");
	assert.match(render(), /BEGIN/);
	const before = render();
	panel.update({ ...record, entries: [...record.entries, { id: "text:4", line: 4, name: "子任务说明", output: "新进展" }] });
	assert.equal(render(), before, "追加输出不能移动正在阅读的内容");
	panel.handleInput("\r");
	render();
	panel.handleInput("\x7f");
	assert.equal(render(), before, "返回实时输出保留上翻内容");
	panel.handleInput("\x1b[F");
	assert.match(render(), /新进展/);
	panel.handleInput("\x1b");
	panel.handleInput("\r"); panel.handleInput("\x1b");
	assert.equal(closed, 2);
});

test("缺失原记录与父最终失败原因直接显示，鼠标不打开已删除页面", async () => {
	const readTaskRecord = createTaskRecordReader();
	const task = { id: "a", label: "只读", status: "运行中", task: "检查文件", sessionFile: "/missing/session.jsonl" };
	const panel = new TaskDetailsPanel(task, tui, plainTheme, () => {});
	panel.update(await readTaskRecord(task));
	assert.match(panel.render(80).join("\n"), /原始记录读取失败/);
	panel.update({ task: { ...task, status: "失败", result: "持久关闭记录未核实" }, entries: [{ id: "call:a", callId: "a", line: 1, name: "read", args: { path: "file.ts" } }] });
	panel.render(80);
	panel.handleMouse({ ...mouse("click", 3), x: 12 });
	assert.match(panel.render(80).join("\n"), /read · 待返回/);
	panel.handleMouse(mouse("click", 5));
	assert.match(panel.render(80).join("\n"), /尚未取得工具返回/);
	assert.match(panel.render(80).join("\n"), /持久关闭记录未核实/);
});

test("执行中的连续输出跟随最新行，上翻暂停，最终结果替换在途缓存且不展示元数据", async () => {
	const readTaskRecord = createTaskRecordReader();
	const root = await mkdtemp(path.join(os.tmpdir(), "delivery-stream-detail-"));
	const file = path.join(root, "child.jsonl");
	const rows: any[] = [{ type: "session", cwd: root }, { type: "message", message: { role: "assistant", timestamp: 10,
		content: [{ type: "toolCall", id: "bash-a", name: "bash", arguments: { command: "node test.js" } }] } }];
	await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const progress = createTaskProgress("a", "验收", "执行测试", () => {});
	const task = { id: "a", label: "验收", status: "执行中", task: "执行测试", sessionFile: file };
	const panel = new TaskDetailsPanel(task, tui, plainTheme, () => {});
	const refresh = async () => panel.update(await readTaskRecord({ ...task, progress: progress.snapshot() }));
	const render = () => panel.render(80).join("\n");
	progress.event({ type: "tool_execution_start", toolCallId: "bash-a", toolName: "bash", args: { command: "node test.js" } });
	const first = Array.from({ length: 100 }, (_, i) => `输出 ${i} ${"内容".repeat(30)}`).join("\n") + "\nFIRST_LATEST";
	progress.event({ type: "tool_execution_update", toolCallId: "bash-a", partialResult: { content: [{ type: "text", text: first }] } });
	await refresh();
	assert.match(render(), /FIRST_LATEST/);
	assert.match(render(), /执行测试/);
	panel.handleInput("\x1b[5~");
	const paused = render();
	assert.match(paused, /暂停跟随/);
	const next = first + "\n" + "后续输出\n".repeat(20_000) + "SECOND_LATEST";
	progress.event({ type: "tool_execution_update", toolCallId: "bash-a", partialResult: { content: [{ type: "text", text: next }] } });
	await refresh();
	assert.equal(render(), paused, "持续输出和预览截断不能移动正在阅读的内容");
	panel.handleInput("\x1b[F");
	assert.match(render(), /SECOND_LATEST/);
	assert.equal((await readFile(file, "utf8")).includes("SECOND_LATEST"), false);
	rows.push({ type: "message", message: { role: "toolResult", toolCallId: "bash-a", toolName: "bash",
		details: { execution: { settled: true, status: "passed", exitCode: 0, inputs: Array.from({ length: 30 }, (_, i) => `input-${i}`) } },
		content: [{ type: "text", text: "最终输出\n".repeat(50) + "FINAL_RESULT" }] } });
	await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	await refresh();
	panel.handleInput("\x1b[F");
	assert.match(render(), /FINAL_RESULT/, "End 应显示最终输出，不能被长返回元数据挤走");
	assert.ok(!render().includes("SECOND_LATEST"), "原始最终返回优先于滞后的实时缓存");
	panel.handleInput("\x1b[H");
	assert.match(render(), /bash · 已返回/);
	assert.doesNotMatch(render(), /返回元数据|input-0|Tab 切换/);
});

test("模型正文在结束前可读且不重复落盘内容，切换工具不串输出，小终端仍可关闭", async () => {
	const readTaskRecord = createTaskRecordReader();
	const root = await mkdtemp(path.join(os.tmpdir(), "delivery-stream-message-"));
	const file = path.join(root, "child.jsonl");
	const rows: any[] = [{ type: "session", cwd: root }];
	const save = () => writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	await save();
	const p = createTaskProgress("a", "只读", "检查文件", () => {});
	const task = { id: "a", label: "只读", status: "运行中", task: "检查文件", sessionFile: file };
	p.event({ type: "message_start", message: { role: "assistant", timestamp: 100 } });
	p.event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "隐藏思考" } });
	p.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我正在" } });
	p.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "检查文件" } });
	let record = await readTaskRecord({ ...task, progress: p.snapshot() });
	assert.equal(record.entries.length, 1);
	assert.equal(record.entries[0]!.output, "我正在检查文件");
	assert.equal(record.entries[0]!.live, true);
	assert.ok(!JSON.stringify(record).includes("隐藏思考"));
	const message = { role: "assistant", timestamp: 100, content: [{ type: "text", text: "我正在检查文件" }] };
	rows.push({ type: "message", message }); await save();
	record = await readTaskRecord({ ...task, progress: p.snapshot() });
	assert.equal(record.entries.length, 1, "模型正文从实时到落盘不能重复");
	assert.equal(record.entries[0]!.live, undefined);
	p.event({ type: "message_end", message });
	p.event({ type: "tool_execution_start", toolCallId: "first", toolName: "read", args: { path: "one.ts" } });
	p.event({ type: "tool_execution_update", toolCallId: "first", partialResult: { content: [{ type: "text", text: "FIRST_TOOL_OUTPUT" }] } });
	p.event({ type: "tool_execution_start", toolCallId: "second", toolName: "read", args: { path: "two.ts" } });
	record = await readTaskRecord({ ...task, progress: p.snapshot() });
	assert.equal(record.entries.find((entry) => entry.callId === "first")?.output, "FIRST_TOOL_OUTPUT");
	assert.equal(record.entries.find((entry) => entry.callId === "second")?.output, "");
	const screen = { terminal: { rows: 32 }, requestRender() {} };
	let closed = 0;
	const panel = new TaskDetailsPanel(task, screen as TUI, plainTheme, () => { closed++; });
	panel.update(record);
	for (const rows of [10, 12, 20, 32, 60]) for (const width of [20, 40, 100]) {
		screen.terminal.rows = rows;
		const rendered = panel.render(width);
		assert.ok(rendered.length <= rows);
		assert.ok(rendered.every((line) => visibleWidth(line) <= width));
	}
	panel.handleInput("\x1b");
	assert.equal(closed, 1);
	const final = await readTaskRecord({ ...task, result: "父结果已返回", progress: p.snapshot() });
	assert.equal(final.entries.length, 1, "父结果已落盘时不能重新展示旧在途工具");
});

test("详情复用未变化记录时仍跟进覆盖、替换、半行追加和删除，不把实时输出写入投影", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "delivery-record-refresh-"));
	const file = path.join(root, "child.jsonl"), replacement = path.join(root, "replacement.jsonl");
	const read = createTaskRecordReader();
	const task = { id: "a", label: "开发", status: "运行中", task: "测试刷新", sessionFile: file };
	const row = (value: string) => JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: value }] } }) + "\n";
	await writeFile(file, row("FIRST"));
	const first = await read(task);
	assert.equal(first.entries[0]!.output, "FIRST");
	assert.deepEqual((await read(task)).entries, first.entries);
	await writeFile(file, row("OTHER"));
	assert.equal((await read(task)).entries[0]!.output, "OTHER", "同长度覆盖必须刷新");
	await writeFile(replacement, row("THIRD"));
	await rename(replacement, file);
	assert.equal((await read(task)).entries[0]!.output, "THIRD", "原路径换文件必须刷新");
	await appendFile(file, row("ADDED").slice(0, -1));
	assert.match((await read(task)).notice!, /末行未完整/);
	await appendFile(file, "\n");
	const appended = await read(task);
	assert.equal(appended.notice, undefined);
	assert.equal(appended.entries.at(-1)!.output, "ADDED");
	const progress = createTaskProgress("a", "开发", "测试刷新", () => {});
	progress.event({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { command: "test" } });
	progress.event({ type: "tool_execution_update", toolCallId: "live", partialResult: { content: [{ type: "text", text: "LIVE" }] } });
	assert.equal((await read({ ...task, progress: progress.snapshot() })).entries.at(-1)!.output, "LIVE");
	assert.deepEqual((await read({ ...task, result: "已结束" })).entries, appended.entries);
	await rm(file);
	const missing = await read(task);
	assert.match(missing.notice!, /原始记录读取失败/);
	assert.deepEqual(missing.entries, [], "不能把已删除记录的旧正文显示成当前结果");
	await writeFile(file, "invalid\n");
	assert.match((await read(task)).notice!, /原始记录读取失败/);
	await writeFile(file, row("RECOVERED"));
	assert.equal((await read(task)).entries[0]!.output, "RECOVERED");
});
