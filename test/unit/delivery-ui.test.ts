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
import { taskDetails, taskDetailBody } from "../../extensions/delivery-gate/src/task-details.ts";
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
		const panel = new DeliveryPanel("详情", "任务正文", "", [], renderer, plainTheme, () => renderer.hideOverlay());
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
	const body = await taskDetailBody(tasks[0]!);
	assert.ok(body.includes(task));
	assert.match(body, /调用 read.*read/);
	assert.match(body, /BEGIN\n(?:正文)+\nEND/);
	assert.match(body, /末行未完整/);
	assert.ok(!body.includes("不得显示的推理") && !body.includes("另一个任务"));
	assert.equal(await readFile(file, "utf8"), before);
	sm.appendMessage({ role: "toolResult", toolCallId: "a", toolName: "delivery_readonly", isError: true, content: [{ type: "text", text: "最终失败" }], timestamp: Date.now() });
	assert.equal(taskDetails({ sessionManager: sm }, [progress.snapshot()])[0]!.status, "失败", "旧进度不能覆盖原生最终结果");
});
