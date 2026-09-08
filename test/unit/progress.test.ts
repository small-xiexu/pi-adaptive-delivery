import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createTaskProgress, taskRenderers, type TaskProgress } from "../../extensions/delivery-gate/src/progress.ts";

test("两个调用及交错工具各自保留目标、真实终态，文本不包含思考事件", () => {
	const updates: TaskProgress[] = [];
	const a = createTaskProgress("a", "只读", "核对代码", (_text, view) => updates.push(view));
	const b = createTaskProgress("b", "审查", "独立检查", () => {});
	a.event({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "a.ts" } });
	b.event({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "b.ts" } });
	a.event({ type: "tool_execution_start", toolCallId: "2", toolName: "read", args: { path: "c.ts" } });
	a.event({ type: "tool_execution_end", toolCallId: "2", toolName: "read", isError: false });
	assert.match(a.snapshot().action, /正在执行.*a.ts/);
	a.event({ type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: true });
	assert.match(a.snapshot().action, /工具失败.*a.ts/);
	assert.ok(!a.snapshot().action.includes("正在执行"));
	assert.match(b.snapshot().action, /正在执行.*b.ts/);
	const before = a.snapshot();
	a.event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "隐藏推理" } });
	assert.deepEqual(a.snapshot(), before);
	a.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已找到调用点" } });
	assert.match(a.snapshot().action, /子任务说明：已找到调用点/);
	a.event({ type: "extension_ui_request", method: "input", title: "选择业务范围" });
	assert.equal(a.snapshot().status, "等待用户回答");
	a.event({ type: "agent_settled" });
	assert.equal(a.snapshot().status, "核对收尾中");
	a.end("已取消");
	assert.ok(a.snapshot().endedAt);
	assert.ok(updates.every((view) => view.id === "a" && !JSON.stringify(view).includes("b.ts")));
	updates[0]!.recent.push("污染");
	assert.ok(!a.snapshot().recent.includes("污染"));
});

test("进度大量输出有界，通知错误不影响状态和真实结束", () => {
	const p = createTaskProgress("a", "开发", "验证", () => { throw new Error("UI unavailable"); });
	for (let i = 0; i < 100; i++) {
		p.event({ type: "tool_execution_start", toolCallId: String(i), toolName: "bash", args: { command: `echo ${i}` } });
		p.event({ type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "A".repeat(100_000) + "TAIL" }] } });
		assert.match(p.snapshot().output, /^\[前文已截断\]/);
		assert.ok(p.snapshot().output.endsWith("TAIL"));
		p.event({ type: "tool_execution_end", toolCallId: String(i), toolName: "bash", isError: false });
	}
	assert.equal(p.snapshot().recent.length, 16);
	p.end("收尾未知");
	assert.equal(p.snapshot().status, "收尾未知");
});

test("Structured 工具返回 session_id 时仍显示真实命令，最终退出和取消不遗留运行状态", () => {
	const p = createTaskProgress("s", "开发", "命令交回", () => {});
	p.event({ type: "tool_execution_start", toolCallId: "cmd", toolName: "exec_command", args: { cmd: "node test.js" } });
	p.event({ type: "tool_execution_end", toolCallId: "cmd", toolName: "exec_command", result: { details: { session_id: 123 } } });
	assert.equal(p.snapshot().action, "正在执行：exec_command node test.js");
	p.event({ type: "tool_execution_start", toolCallId: "poll", toolName: "write_stdin", args: { session_id: 123 } });
	assert.equal(p.snapshot().action, "正在执行：exec_command node test.js");
	p.event({ type: "tool_execution_end", toolCallId: "poll", toolName: "write_stdin", result: { details: { exit_code: 0 } } });
	assert.equal(p.snapshot().action, "已完成：exec_command node test.js");
	p.event({ type: "tool_execution_start", toolCallId: "patch", toolName: "apply_patch", args: { input: "*** Begin Patch\n*** Update File: src/a.ts\n" } });
	assert.match(p.snapshot().action, /apply_patch src\/a.ts/);
	p.end("已取消");
	assert.ok(!p.snapshot().action.includes("正在执行"));
});

test("真实 Pi 工具组件折叠为两行、展开有界，错误终态与恢复不显示运行中", () => {
	initTheme("dark");
	const tool: ToolDefinition = { name: "delivery_readonly", label: "只读", description: "", parameters: Type.Object({ task: Type.String() }),
		...taskRenderers("只读"), execute: async () => ({ content: [], details: {} }) };
	const component = new ToolExecutionComponent(tool.name, "call", { task: "检查中文与窄屏" }, {}, tool, { requestRender() {} } as TUI, "/tmp");
	const progress = createTaskProgress("call", "只读", "检查中文与窄屏", (message, view) => {
		component.updateResult({ content: [{ type: "text", text: message }], details: { progress: view }, isError: false }, true);
	});
	component.markExecutionStarted();
	progress.event({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "文件.ts" } });
	for (const width of [20, 80]) {
		const rows = component.render(width).filter((row) => row.trim());
		// Pi 卡片自带边距，内容仍只有两行。
		assert.equal(rows.filter((row) => row.replace(/\x1b\[[0-9;]*m/g, "").trim()).length, 2);
		assert.ok(rows.every((row) => visibleWidth(row) <= width));
		assert.match(rows.join(""), /执行中/, "窄屏不能把真实状态截断到长任务名称之后");
		assert.ok(!rows.join("").includes("耗时"));
	}
	progress.phase("运行中", "最近操作", "/tmp/child.jsonl");
	progress.event({ type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "OUTPUT\n\x1b]0;INJECT\x07" + "X".repeat(5000) }] } });
	component.setExpanded(true);
	const expanded = component.render(80).join("\n");
	assert.match(expanded, /耗时/);
	assert.match(expanded, /child.jsonl/);
	assert.ok(expanded.length < 20_000);
	component.setExpanded(false);
	progress.end("已取消");
	component.updateResult({ content: [{ type: "text", text: "取消；原始子 Session：/tmp/child.jsonl" }], details: {}, isError: true });
	assert.match(component.render(80).join(""), /已取消/);
	const restored = new ToolExecutionComponent(tool.name, "old", { task: "历史任务" }, {}, tool, { requestRender() {} } as TUI, "/tmp");
	restored.updateResult({ content: [{ type: "text", text: "子任务失败" }], details: {}, isError: true });
	assert.match(restored.render(80).join(""), /失败/);
	assert.ok(!restored.render(80).join("").includes("运行中"));
});
