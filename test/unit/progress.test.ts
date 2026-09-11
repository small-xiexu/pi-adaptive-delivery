import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ABNORMAL_STATUS, COMPLETED_STATUS, createTaskProgress, taskRenderers, summarizeToolErrors, RUNNING_STATUS, type TaskProgress } from "../../extensions/delivery-gate/src/progress.ts";

test("过程摘要关联原始调用和行号，同为退出 1 不自动解释为无匹配或已修复", () => {
	const rows: any[] = [
		{ type: "session", id: "child" },
		{ type: "message", message: { role: "assistant", content: [
			{ type: "thinking", thinking: "不得进入摘要" },
			{ type: "toolCall", id: "search", name: "bash", arguments: { command: "rg missing input.txt" } },
			{ type: "toolCall", id: "test", name: "bash", arguments: { command: "node failing-test.cjs" } },
		] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "test", toolName: "bash", isError: true, content: [{ type: "text", text: "AssertionError: 1 !== 2\nCommand exited with code 1" }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "search", toolName: "bash", isError: true, content: [{ type: "text", text: "\nCommand exited with code 1\nCONFIGURED_RESULT_HOOK" }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "read", toolName: "read", isError: false, content: [{ type: "text", text: "后续正常读取" }] } },
	];
	const before = structuredClone(rows);
	const note = summarizeToolErrors(rows)!;
	assert.match(note.action, /2 次工具异常.*bash.*code 1/);
	assert.match(note.text, /原记录第 3 行.*node failing-test.cjs.*AssertionError/s);
	assert.match(note.text, /原记录第 4 行.*rg missing input.txt.*code 1/s);
	assert.match(summarizeToolErrors([rows[3]])!.action, /code 1.*CONFIGURED_RESULT_HOOK/);
	assert.doesNotMatch(note.text, /不得进入摘要|无匹配|已修复|不影响交付/);
	assert.deepEqual(rows, before);
	assert.equal(summarizeToolErrors([rows[4]]), undefined);
});

test("过程摘要有界、移除终端控制序列，缺少调用或正文时明确指向原记录", () => {
	const rows: any[] = Array.from({ length: 20 }, (_, index) => ({ type: "message", message: {
		role: "toolResult", toolCallId: String(index), toolName: "plugin", isError: true,
		content: [{ type: "text", text: "\x1b]0;BAD_TITLE\x07\x1b[31m" + "输出".repeat(10_000) + "\nERROR_END" }],
	} }));
	rows[0].message.content = [];
	const note = summarizeToolErrors(rows)!;
	assert.match(note.action, /20 次工具异常/);
	assert.match(note.text, /未取得文本返回/);
	assert.match(note.text, /其余 17 次/);
	assert.match(note.text, /ERROR_END/);
	assert.ok(note.text.length < 4000);
	assert.doesNotMatch(note.text, /\x1b|\x07|BAD_TITLE/);
});

test("正常结束的真实 Pi 卡片只显示已完成，过程摘要不改变主状态，真正异常仍用错误色", () => {
	initTheme("dark");
	const colors: [string, string][] = [];
	const renderers = taskRenderers("开发");
	const tool: ToolDefinition = { name: "delivery_develop", label: "开发", description: "", parameters: Type.Object({}),
		...renderers, renderResult(result, options, theme, context) {
			return renderers.renderResult!.call(this, result, options, { fg: (color: string, value: string) => {
				colors.push([color, value]); return theme.fg(color as any, value);
			} } as any, context);
		}, execute: async () => ({ content: [], details: {} }) };
	const component = new ToolExecutionComponent(tool.name, "note", { task: "检索后开发" }, {}, tool, { requestRender() {} } as TUI, "/tmp");
	const p = createTaskProgress("note", "开发", "检索后开发", () => {});
	p.event({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "node test.js" } });
	p.event({ type: "tool_execution_end", toolCallId: "call", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Command exited with code 1" }] } });
	p.end(COMPLETED_STATUS);
	component.updateResult({ content: [{ type: "text", text: "原始过程记录" }], details: { progress: p.snapshot() }, isError: false }, false);
	const lines = component.render(100).join("\n");
	assert.match(lines, /已完成/);
	assert.doesNotMatch(lines, /工具异常|工具失败/);
	assert.ok(colors.some(([color, value]) => color === "toolTitle" && value.startsWith(COMPLETED_STATUS)));
	assert.ok(!colors.some(([color, value]) => color === "warning" && value.includes("工具异常")));
	colors.length = 0;
	p.end(ABNORMAL_STATUS);
	component.updateResult({ content: [{ type: "text", text: "固定验收失败" }], details: { progress: p.snapshot() }, isError: true }, false);
	component.render(100);
	assert.ok(colors.some(([color, value]) => color === "error" && value.startsWith(ABNORMAL_STATUS)));
});

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
	assert.match(a.snapshot().action, /已返回.*a.ts/);
	assert.equal(a.snapshot().status, RUNNING_STATUS);
	assert.ok(!a.snapshot().action.includes("正在执行"));
	assert.match(b.snapshot().action, /正在执行.*b.ts/);
	const before = a.snapshot();
	a.event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "隐藏推理" } });
	assert.deepEqual(a.snapshot(), before);
	a.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已找到调用点" } });
	assert.equal(a.snapshot().action, "正在整理任务说明");
	assert.equal(a.snapshot().output, "已找到调用点");
	a.event({ type: "extension_ui_request", method: "input", title: "选择业务范围" });
	assert.equal(a.snapshot().status, RUNNING_STATUS);
	a.event({ type: "agent_settled" });
	assert.equal(a.snapshot().status, RUNNING_STATUS);
	a.end(ABNORMAL_STATUS);
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
		assert.match(p.snapshot().output, /^\[预览已省略，详情查看完整内容\]/);
		assert.ok(p.snapshot().output.endsWith("TAIL"));
		p.event({ type: "tool_execution_end", toolCallId: String(i), toolName: "bash", isError: false });
	}
	assert.equal(p.snapshot().recent.length, 16);
	p.end(ABNORMAL_STATUS);
	assert.equal(p.snapshot().status, ABNORMAL_STATUS);
});

test("真实 Pi 卡片保留异常退出，原生失败结果不覆盖已核实的展示状态", () => {
	initTheme("dark");
	const tool: ToolDefinition = { name: "delivery_develop", label: "开发", description: "", parameters: Type.Object({ task: Type.String() }),
		...taskRenderers("开发"), execute: async () => ({ content: [], details: {} }) };
	const component = new ToolExecutionComponent(tool.name, "startup", { task: "启动检查" }, {}, tool, { requestRender() {} } as TUI, "/tmp");
	const progress = createTaskProgress("startup", "开发", "启动检查", (message, view) => {
		component.updateResult({ content: [{ type: "text", text: message }], details: { progress: view }, isError: false }, true);
	});
	component.markExecutionStarted();
	progress.end(ABNORMAL_STATUS);
	component.render(100);
	component.updateResult({ content: [{ type: "text", text: "本次执行失败" }], details: {}, isError: true }, false);
	assert.match(component.render(100).join("\n"), new RegExp(ABNORMAL_STATUS));
});

test("在途输出按调用关联，累计工具更新不重复追加，结束和取消清除临时正文", () => {
	const p = createTaskProgress("a", "开发", "并行读取", () => {});
	for (const id of ["one", "two"]) p.event({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } });
	const update = (id: string, text: string) => p.event({ type: "tool_execution_update", toolCallId: id, partialResult: { content: [{ type: "text", text }] } });
	update("one", "A"); update("one", "AB"); update("two", "C");
	assert.deepEqual(p.snapshot().pending?.map((entry) => [entry.callId, entry.output]), [["one", "AB"], ["two", "C"]]);
	const copy = p.snapshot(); copy.pending![0]!.output = "污染";
	assert.equal(p.snapshot().pending![0]!.output, "AB");
	update("two", "X".repeat(200_000) + "TAIL");
	assert.ok(p.snapshot().pending![1]!.output.length < 65_000);
	assert.ok(p.snapshot().pending![1]!.output.endsWith("TAIL"));
	p.event({ type: "tool_execution_end", toolCallId: "one", toolName: "read", isError: false });
	assert.deepEqual(p.snapshot().pending?.map((entry) => entry.callId), ["two"]);
	p.end(ABNORMAL_STATUS);
	assert.deepEqual(p.snapshot().pending, []);
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
	p.end(ABNORMAL_STATUS);
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
		assert.match(rows.join(""), /运行中/, "窄屏不能把真实状态截断到长任务名称之后");
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
	progress.end(ABNORMAL_STATUS);
	component.updateResult({ content: [{ type: "text", text: "取消；原始子 Session：/tmp/child.jsonl" }], details: {}, isError: true });
	assert.match(component.render(80).join(""), /异常退出/);
	const restored = new ToolExecutionComponent(tool.name, "old", { task: "历史任务" }, {}, tool, { requestRender() {} } as TUI, "/tmp");
	restored.updateResult({ content: [{ type: "text", text: "子任务失败" }], details: {}, isError: true });
	assert.match(restored.render(80).join(""), /失败/);
	assert.ok(!restored.render(80).join("").includes("运行中"));
});
