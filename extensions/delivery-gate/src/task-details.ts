import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { displayText } from "./ui.ts";
import type { TaskProgress } from "./progress.ts";
import { DELEGATE_TOOL, DELEGATION_ENTRY } from "./subagents.ts";
import { DEVELOPMENT_TOOL, VALIDATION_TOOL, REVIEW_TOOL } from "./development.ts";

const labels: Record<string, string> = { [DELEGATE_TOOL]: "只读", [DEVELOPMENT_TOOL]: "开发", [VALIDATION_TOOL]: "验收", [REVIEW_TOOL]: "审查" };
const text = (message: any) => (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
export interface TaskDetail {
	id: string;
	label: string;
	task: string;
	status: string;
	result?: string;
	sessionFile?: string;
	progress?: TaskProgress;
}

// 当前分支的原生调用、结果和既有委派引用；不保存第二份任务列表。
export function taskDetails(ctx: Pick<ExtensionContext, "sessionManager">, live: TaskProgress[]): TaskDetail[] {
	const tasks = new Map<string, TaskDetail>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const part of entry.message.content) if (part.type === "toolCall" && labels[part.name]) tasks.set(part.id,
				{ id: part.id, label: labels[part.name]!, task: String(part.arguments.task ?? "执行本轮固定候选验收"), status: "未取得执行终态" });
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			const task = tasks.get(entry.message.toolCallId);
			if (!task) continue;
			const progress = (entry.message.details as { progress?: TaskProgress } | undefined)?.progress;
			task.status = entry.message.isError ? progress && ["已取消", "收尾未知"].includes(progress.status) ? progress.status : "失败" : "执行结束，结果待核实";
			task.result = text(entry.message);
			task.progress = progress;
			if (progress?.sessionFile) task.sessionFile = progress.sessionFile;
		} else if (entry.type === "custom" && [DELEGATION_ENTRY, "delivery-development"].includes(entry.customType)) {
			const data = entry.data as { id: string; sessionFile?: string; childSessionFile?: string };
			const task = tasks.get(data.id);
			if (task && (data.childSessionFile || data.sessionFile)) task.sessionFile = data.childSessionFile ?? data.sessionFile;
		}
	}
	for (const progress of live) {
		const task = tasks.get(progress.id);
		if (task && task.result === undefined) Object.assign(task, { status: progress.status, progress, sessionFile: progress.sessionFile ?? task.sessionFile });
	}
	return [...tasks.values()];
}

interface DetailEntry {
	id: string;
	line?: number;
	name: string;
	callId?: string;
	args?: unknown;
	output?: string;
	resultLine?: number;
	failed?: boolean;
	metadata?: unknown;
	live?: boolean;
}
interface TaskRecord { task: TaskDetail; entries: DetailEntry[]; cwd?: string; notice?: string }

// 仅供当前弹层使用的原记录投影，不写入第二份日志。
export async function readTaskRecord(task: TaskDetail): Promise<TaskRecord> {
	const record: TaskRecord = { task, entries: [] };
	if (!task.sessionFile) record.notice = "尚未取得原始子 Session。";
	try {
		const source = task.sessionFile ? await readFile(task.sessionFile, "utf8") : "";
		const lines = source.split("\n");
		const partial = lines.pop(); // 活动 Session 的最后一行可能仍在追加，不把半行解释成事件。
		const calls = new Map<string, DetailEntry>();
		for (let index = 0; index < lines.length; index++) {
			const row = JSON.parse(lines[index]!);
			if (row.type === "session") record.cwd = row.cwd;
			const message = row.type === "message" ? row.message : undefined;
			if (message?.role === "assistant") {
				const content = text(message);
				if (content) record.entries.push({ id: `text:${message.timestamp ?? `line:${index}`}`, line: index + 1, name: "子任务说明", output: content });
				for (const part of message.content ?? []) if (part.type === "toolCall") {
					const call = { id: `call:${part.id}`, callId: part.id, line: index + 1, name: part.name, args: part.arguments };
					calls.set(part.id, call);
					record.entries.push(call);
				}
				if (message.errorMessage) record.entries.push({ id: `error:${index}`, line: index + 1, name: "模型错误", output: message.errorMessage, failed: true });
			} else if (message?.role === "toolResult") {
				let call = calls.get(message.toolCallId);
				if (!call) {
					call = { id: `call:${message.toolCallId}`, callId: message.toolCallId, line: index + 1, name: message.toolName };
					record.entries.push(call);
				}
				Object.assign(call, { output: text(message), resultLine: index + 1, failed: Boolean(message.isError), metadata: message.details });
			}
		}
		if (partial) record.notice = "原始记录末行未完整写入，等待更新。";
	} catch (error) { record.notice = `原始记录读取失败：${String(error)}`; }
	// 原始返回优先；在途输出仅补充尚未落盘的正文，不参与终态判断。
	for (const pending of task.result === undefined ? task.progress?.pending ?? [] : []) {
		const original = record.entries.find((entry) => entry.id === pending.id);
		if (original?.resultLine || original && !pending.callId) continue;
		if (original) Object.assign(original, { output: pending.output, live: true });
		else record.entries.push({ ...pending, live: true });
	}
	return record;
}

const clean = (value: string) => displayText(stripTerminalSequences(value)).replace(/\t/g, "    ");
const short = (value: string) => clean(value).replace(/\s+/g, " ").trim();
const entryStatus = (entry: DetailEntry) => entry.failed ? "失败" : entry.resultLine ? "已返回" : entry.live ? entry.callId ? "执行中" : "正在输出" : entry.callId ? "待返回" : "说明";

export class TaskDetailsPanel {
	private record: TaskRecord;
	private tab = 0;
	private full = false;
	private selected?: string;
	private offsets = [0, 0, 0, 0, 0];
	private following = [true, false, false, false, false];
	private frozen = new Map<number, string>();
	private inspected?: string;
	private pageSize = 1;
	private total = 0;
	private tabs: { start: number; end: number }[] = [];
	private wrapped?: { body: string; width: number; lines: string[] };
	constructor(task: TaskDetail, private readonly tui: TUI, private readonly theme: Theme, private readonly done: () => void) {
		this.record = { task, entries: [], notice: "正在读取原始记录…" };
	}
	update(record: TaskRecord) {
		this.record = record;
		if (!record.entries.some((entry) => entry.id === this.selected)) this.selected = record.entries.at(-1)?.id;
		this.tui.requestRender();
	}
	showError(message: string) { this.record.notice = message; this.tui.requestRender(); }
	invalidate() { this.wrapped = undefined; }
	private get slot() { return this.tab === 2 ? 4 : this.tab * 2 + Number(this.full); }
	private get offset() { return this.offsets[this.slot]!; }
	private set offset(value: number) { this.offsets[this.slot] = value; }
	private get listing() { return this.tab === 1 && !this.full; }
	private get overview() { return this.tab === 0 && !this.full; }
	private switchTab(tab: number) { this.tab = (tab + 3) % 3; this.full = false; this.tui.requestRender(); }
	private expand() {
		if (this.tab === 1 && this.inspected !== this.selected) {
			this.inspected = this.selected;
			this.offsets[3] = 0;
			this.frozen.delete(3);
			this.following[3] = Boolean(this.record.entries.find((entry) => entry.id === this.selected)?.live);
		}
		this.full = true;
	}
	private move(delta: number) {
		if (this.listing) {
			const index = Math.max(0, this.record.entries.findIndex((entry) => entry.id === this.selected));
			this.selected = this.record.entries[Math.max(0, Math.min(this.record.entries.length - 1, index + delta))]?.id;
			this.offsets[3] = 0;
		} else {
			const bottom = Math.max(0, this.total - this.pageSize);
			this.offset = Math.max(0, Math.min(bottom, this.offset + delta));
			if (this.overview || this.slot === 3 && (this.following[3] || this.frozen.has(3))) {
				if (delta < 0 && this.following[this.slot] && this.wrapped) this.frozen.set(this.slot, this.wrapped.body);
				this.following[this.slot] = delta > 0 && this.offset === bottom;
				if (this.following[this.slot]) this.frozen.delete(this.slot);
			}
		}
		this.tui.requestRender();
	}
	handleInput(data: string) {
		if (matchesKey(data, "escape")) { this.done(); return; }
		if (matchesKey(data, "tab") || matchesKey(data, "right")) this.switchTab(this.tab + 1);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.switchTab(this.tab - 1);
		else if (matchesKey(data, "return") && this.tab !== 2) this.expand();
		else if (matchesKey(data, "backspace")) this.full = false;
		else if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "pageUp")) this.move(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.move(this.pageSize);
		else if (matchesKey(data, "home")) this.move(-Infinity);
		else if (matchesKey(data, "end")) this.move(Infinity);
		this.tui.requestRender();
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type === "wheel") this.move(event.wheelDelta ?? 0);
		if (event.type === "click" && event.button === "left") {
			if (event.y === 3) {
				const tab = this.tabs.findIndex(({ start, end }) => event.x >= start && event.x < end);
				if (tab >= 0) this.switchTab(tab);
			} else if (this.listing && event.y >= 5 && event.y < 5 + this.pageSize) {
				const entry = this.record.entries[this.offset + event.y - 5];
				if (entry) { this.selected = entry.id; this.expand(); this.tui.requestRender(); }
			}
		}
		return { handled: true };
	}
	private summary(entry: DetailEntry) {
		const args = entry.args as Record<string, unknown> | undefined;
		let value = entry.callId ? String(args?.path ?? args?.file_path ?? args?.command ?? args?.cmd ?? args?.pattern ?? "") : entry.output ?? "";
		if (this.record.cwd && path.isAbsolute(value)) value = path.relative(this.record.cwd, value) || ".";
		return short(value).slice(0, 200);
	}
	private content(width: number): string[] {
		const { task, entries, notice } = this.record;
		let body: string;
		if (this.frozen.has(this.slot)) body = this.frozen.get(this.slot)!;
		else if (this.overview) {
			body = entries.map((entry) => `${truncateToWidth(`${short(entry.name)} · ${entryStatus(entry)}${entry.callId ? ` · ${this.summary(entry)}` : ""}`, width)}\n`
				+ (entry.output || (entry.live ? "等待输出…" : entry.callId ? "尚未取得工具返回。" : ""))).join("\n\n") || "等待子任务输出…";
			if (notice) body += `\n\n${notice}`;
		}
		else if (this.tab === 0) body = `完整任务\n\n${task.task}\n\n原始子 Session\n${task.sessionFile ?? "尚未取得"}`;
		else if (this.tab === 2) body = `任务结果\n\n${task.result ?? "尚未收到父工具结果。当前进展可在「概览」查看。"}`;
		else {
			const entry = entries.find((entry) => entry.id === this.selected);
			if (!entry) return ["还没有工具过程记录。"];
			body = `${entry.name} · ${entryStatus(entry)}\n\n`;
			if (entry.args !== undefined) body += `参数\n${JSON.stringify(entry.args, null, 2)}\n\n`;
			if (!entry.live) {
				body += `原始记录\n${task.sessionFile ?? "尚未取得"}${entry.line ? `\n第 ${entry.line} 行` : ""}${entry.resultLine ? ` · 返回第 ${entry.resultLine} 行` : ""}\n`;
				if (entry.callId) body += `调用 ID：${entry.callId}\n`;
				if (entry.metadata && Object.keys(entry.metadata).length) body += `\n返回元数据\n${JSON.stringify(entry.metadata, null, 2)}\n`;
				body += "\n";
			}
			body += `${entry.callId ? "输出" : "正文"}\n${entry.output || (entry.live ? "等待输出…" : "尚未取得工具返回。")}`;
		}
		if (notice && !this.overview && !this.frozen.has(this.slot)) body += `\n\n${notice}`;
		if (this.wrapped?.body !== body || this.wrapped.width !== width) this.wrapped = { body, width, lines: wrapTextWithAnsi(clean(body), width) };
		return this.wrapped.lines;
	}
	render(width: number) {
		const th = this.theme;
		if (width < 32 || this.tui.terminal.rows < 12) return [truncateToWidth(th.fg("muted", "Esc 关闭 · 请放大终端"), width)];
		const inner = width - 6;
		const fit = (value: string, size: number) => { const clipped = truncateToWidth(value, size); return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped))); };
		const row = (value: string) => th.bg("customMessageBg", th.fg("border", "│") + "  " + fit(value, inner) + "  " + th.fg("border", "│"));
		const rule = (left: string, right: string) => th.bg("customMessageBg", th.fg("border", left + "─".repeat(width - 2) + right));
		const footer = width >= 72 ? ["Tab 切换 · ↑↓ / PgUp/PgDn 滚动 · Esc 关闭"] : ["Tab 切换 · ↑↓ 滚动", "Esc 关闭"];
		const task = this.record.task;
		const context = this.overview ? [th.fg("muted", `任务：${short(task.task)}`),
			th.fg("muted", short(task.progress?.action ?? (task.result === undefined ? "等待进度更新" : "已收到结果，可切换到「结果」查看"))),
			th.fg("accent", this.following[0] ? "实时输出 · 跟随最新" : "实时输出 · 暂停跟随 · End 查看最新")] : [];
		context.splice(Math.max(0, Math.floor(this.tui.terminal.rows * 0.85) - 10));
		this.pageSize = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - 8 - footer.length - context.length);
		let cursor = 3;
		const tabs = (width < 44 ? ["概览", "过程", "结果"] : ["概览", "工具过程", "结果"]).map((label, index) => {
			const title = this.tab === index ? `[${label}]` : ` ${label} `;
			this.tabs[index] = { start: cursor, end: cursor + visibleWidth(title) };
			cursor += visibleWidth(title) + 2;
			return this.tab === index ? th.fg("accent", th.bold(title)) : th.fg("muted", title);
		}).join("  ");
		let page: string[];
		let position: string;
		if (this.listing) {
			const entries = this.record.entries;
			this.total = entries.length;
			const index = Math.max(0, entries.findIndex((entry) => entry.id === this.selected));
			this.offset = Math.max(0, Math.min(this.offset, index, Math.max(0, entries.length - this.pageSize)));
			if (index >= this.offset + this.pageSize) this.offset = index - this.pageSize + 1;
			page = entries.slice(this.offset, this.offset + this.pageSize).map((entry) => {
				const value = fit(`${entry.id === this.selected ? "›" : " "} ${entryStatus(entry)} · ${short(entry.name)}  ${this.summary(entry)}`, inner);
				return entry.id === this.selected ? th.bg("selectedBg", th.fg("accent", value)) : entry.failed ? th.fg("error", value) : value;
			});
			if (!entries.length) page = ["还没有工具过程记录。"];
			position = `${entries.length ? index + 1 : 0} / ${entries.length} 条 · Enter 查看${this.record.notice ? " · 记录不完整，概览查看原因" : ""}`;
		} else {
			const lines = this.content(inner);
			this.total = lines.length;
			const bottom = Math.max(0, this.total - this.pageSize);
			this.offset = this.following[this.slot] ? bottom : Math.min(this.offset, bottom);
			page = lines.slice(this.offset, this.offset + this.pageSize);
			position = this.full ? "Backspace 返回" : this.tab === 0 ? "Enter 查看完整任务" : "父工具返回正文";
			if (this.slot === 3 && (this.following[3] || this.frozen.has(3))) position += this.following[3] ? " · 跟随最新" : " · 暂停跟随 · End 最新";
			if (this.total > this.pageSize) position += ` · ${this.offset + 1}–${Math.min(this.total, this.offset + this.pageSize)} / ${this.total} 行`;
		}
		while (page.length < this.pageSize) page.push("");
		const status = task.status === "执行结束，结果待核实" ? "已结束，待核对" : task.status;
		return [rule("╭", "╮"), row(th.bold(th.fg("accent", "子任务详情")) + th.fg("muted", `  · ${clean(task.label)} · ${clean(status)}`)), row(""), row(tabs), rule("├", "┤"),
			...context.map(row), ...page.map(row), rule("├", "┤"), row(th.fg("muted", position)), ...footer.map((line) => row(th.fg("muted", line))), rule("╰", "╯")];
	}
}

export function installTaskDetails(pi: ExtensionAPI, live: () => TaskProgress[]) {
	let current: ExtensionContext | undefined;
	let close: (() => void) | undefined;
	const reset = (_event: unknown, ctx: ExtensionContext) => { close?.(); current = ctx; };
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", () => { close?.(); current = undefined; });
	const open = async (id?: string, ctx = current) => {
		if (!ctx?.hasUI || ctx.mode !== "tui" || close) return;
		const tasks = taskDetails(ctx, live()).reverse();
		if (!id) {
			if (!tasks.length) { ctx.ui.notify("当前会话还没有交付子任务。", "info"); return; }
			const choices = tasks.map((task, index) => `${index + 1}. ${displayText(task.label)} · ${displayText(task.status)} · ${displayText(task.task).replace(/\s+/g, " ").slice(0, 80)}`);
			const controller = new AbortController();
			close = () => controller.abort();
			let selected: string | undefined;
			try { selected = await ctx.ui.select("子任务详情", choices, { signal: controller.signal }); }
			finally { close = undefined; }
			if (controller.signal.aborted) return;
			if (selected === undefined) return;
			id = tasks[choices.indexOf(selected)]?.id;
		}
		if (!id || !tasks.some((task) => task.id === id)) { ctx.ui.notify("当前分支没有这个子任务。", "warning"); return; }
		try {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				let closed = false;
				let loading = false;
				const panel = new TaskDetailsPanel(tasks.find((task) => task.id === id)!, tui, theme, () => done());
				close = () => done();
				const refresh = async () => {
					if (closed || loading) return;
					loading = true;
					try {
						const task = taskDetails(ctx, live()).find((task) => task.id === id);
						const record = task ? await readTaskRecord(task) : undefined;
						if (!closed) { if (record) panel.update(record); else panel.showError("任务已离开当前分支。"); }
					} catch (error) {
						if (!closed) panel.showError(`详情更新失败：${String(error)}`);
					} finally { loading = false; }
				};
				const timer = setInterval(() => void refresh(), 1000);
				void refresh();
				return Object.assign(panel, { dispose() { closed = true; clearInterval(timer); close = undefined; } });
			}, { overlay: true, overlayOptions: { width: 110, maxHeight: "90%", margin: 1, anchor: "center" } });
		} finally { close = undefined; }
	};
	pi.registerCommand("delivery-tasks", { description: "查看交付子任务详情，Esc 关闭详情", handler: (args, ctx) => open(args.trim() || undefined, ctx) });
	return (id: string) => { void open(id).catch((error) => current?.ui.notify(`无法打开任务详情：${String(error)}`, "error")); };
}
