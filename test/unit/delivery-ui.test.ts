import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme, SessionManager, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DeliveryPanel } from "../../extensions/delivery-gate/src/ui.ts";
import { createTaskProgress, taskRenderers } from "../../extensions/delivery-gate/src/progress.ts";
import { taskDetails, readTaskRecord, TaskDetailsPanel } from "../../extensions/delivery-gate/src/task-details.ts";
import { plainTheme } from "../support/delivery-ui.ts";

const tui = { terminal: { rows: 32 }, requestRender() {} } as TUI;
const mouse = (type: TuiMouseEvent["type"], y: number): TuiMouseEvent => ({ type, button: "left", x: 1, y, screenX: 1, screenY: y, width: 80, height: 30, shift: false, alt: false, ctrl: false });

for (const accept of ["授权文档编辑", "确认方案", "确认实施"]) test(`${accept} 在上但默认回车不批准，滚动和查看详情不改变选择`, () => {
	const results: unknown[] = [];
	const panel = new DeliveryPanel("批准", "简短说明\n".repeat(100), "完整命令\n".repeat(80) + "最后一个条件", [accept, "暂不批准"], tui, plainTheme, (value) => results.push(value), 1);
	for (const width of [20, 80]) {
		const lines = panel.render(width);
		assert.ok(lines.findIndex((line) => line.includes(accept)) < lines.findIndex((line) => line.includes("暂不批准")));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.length <= 17, "底部审批不能占满终端");
	}
	panel.handleInput("\t");
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
	// Pi 的 ToolExecutionComponent 本身沿 Container 的公开鼠标分派到 MouseRegion。
	for (let y = 0; y < rows.length && !opened.length; y++) card.handleMouse(mouse("click", y));
	assert.deepEqual(opened, ["task-a"]);
});

test("详情复用原生分支与长 Session，保留完整调用/结果、末行提示且排除 thinking", async () => {
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

test("万行工具输出按需展开，概览简短，刷新与切换保留阅读位置，所有视图 Esc 直接关闭", () => {
	let closed = 0;
	const task = { id: "a", label: "开发", status: "运行中", task: "提取归档名称函数。" + "完整任务指令".repeat(1000), sessionFile: "/tmp/original-session.jsonl" };
	const record = { task, cwd: "/tmp/repo", entries: [
		{ id: "call:a", callId: "call_long_internal_id", line: 2, name: "read", args: { path: "/tmp/repo/中文.ts" }, output: "BEGIN\n" + "长输出\n".repeat(10_000) + "END", resultLine: 3 },
	] };
	const panel = new TaskDetailsPanel(task, tui, plainTheme, () => { closed++; });
	panel.update(record);
	const render = () => panel.render(80).join("\n");
	assert.ok(!render().includes("BEGIN") && !render().includes("call_long_internal_id") && !render().includes("original-session"));
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
	panel.handleInput("\t");
	assert.match(render(), /已返回 · read.*中文.ts/);
	assert.ok(!render().includes("BEGIN") && !render().includes("/tmp/repo"));
	panel.handleInput("\r");
	assert.match(render(), /参数/);
	assert.match(render(), /BEGIN/);
	panel.handleInput("\x1b[F");
	assert.match(render(), /END/);
	const before = render();
	panel.update({ ...record, entries: [...record.entries, { id: "text:4", line: 4, name: "子任务说明", output: "新进展" }] });
	assert.equal(render(), before, "追加记录不能换掉正在阅读的调用或滚动位置");
	panel.handleInput("\t");
	assert.match(render(), /尚未收到父工具结果/);
	panel.update({ ...record, task: { ...task, status: "执行结束，结果待核实", result: "最终结论" } });
	assert.match(render(), /最终结论/);
	assert.match(render(), /已结束，待核对/);
	panel.handleInput("\x1b[D");
	panel.handleInput("\r");
	assert.match(render(), /END/, "切回同一调用应保留阅读位置");
	for (let i = 0; i < 3; i++) { panel.handleInput("\x1b"); panel.handleInput("\t"); }
	assert.equal(closed, 3);
});

test("详情鼠标切换页签、点击调用展开，缺失原记录明确提示", async () => {
	const task = { id: "a", label: "只读", status: "运行中", task: "检查文件", sessionFile: "/missing/session.jsonl" };
	const panel = new TaskDetailsPanel(task, tui, plainTheme, () => {});
	panel.update(await readTaskRecord(task));
	assert.match(panel.render(80).join("\n"), /原始记录读取失败/);
	panel.update({ task, entries: [{ id: "call:a", callId: "a", line: 1, name: "read", args: { path: "file.ts" } }] });
	panel.render(80);
	panel.handleMouse({ ...mouse("click", 3), x: 12 });
	assert.match(panel.render(80).join("\n"), /待返回 · read/);
	panel.handleMouse(mouse("click", 5));
	assert.match(panel.render(80).join("\n"), /尚未取得工具返回/);
});

test("执行中的输出进入工具详情，概览跟随最新行，上翻暂停后不会被持续输出挤走", async () => {
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
	panel.handleInput("\t");
	assert.match(render(), /执行中 · bash/);
	panel.handleInput("\r");
	assert.match(render(), /SECOND_LATEST/, "单次工具详情必须展示尚未落盘的输出");
	assert.equal((await readFile(file, "utf8")).includes("SECOND_LATEST"), false);
	rows.push({ type: "message", message: { role: "toolResult", toolCallId: "bash-a", toolName: "bash",
		details: { container: { clean: true, status: "passed", exitCode: 0, inputs: Array.from({ length: 30 }, (_, i) => `input-${i}`) } },
		content: [{ type: "text", text: "最终输出\n".repeat(50) + "FINAL_RESULT" }] } });
	await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	await refresh();
	panel.handleInput("\x1b[F");
	assert.match(render(), /FINAL_RESULT/, "End 应显示最终输出，不能被长返回元数据挤走");
	assert.ok(!render().includes("SECOND_LATEST"), "原始最终返回优先于滞后的实时缓存");
	panel.handleInput("\x1b[H");
	assert.match(render(), /参数/);
	assert.match(render(), /原始记录/);
	assert.match(render(), /返回元数据/);
});

test("模型正文在结束前可读且不重复落盘内容，切换工具不串输出，小终端仍可关闭", async () => {
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
