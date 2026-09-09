import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DeliveryPanel, displayText } from "./ui.ts";
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

export async function taskDetailBody(task: TaskDetail): Promise<string> {
	let body = `${task.label} · ${task.status}\n\n任务说明：\n${task.task}`;
	if (task.progress) body += `\n\n当前操作：${task.progress.action}`;
	if (task.result !== undefined) body += `\n\n父工具结果：\n${task.result}`;
	if (!task.sessionFile) return body + "\n\n尚未取得原始子 Session。";
	body += `\n\n原始子 Session：${task.sessionFile}\n`;
	try {
		const source = await readFile(task.sessionFile, "utf8");
		const lines = source.split("\n");
		const partial = lines.pop(); // 活动 Session 的最后一行可能仍在追加，不把半行解释成事件。
		for (let index = 0; index < lines.length; index++) {
			const row = JSON.parse(lines[index]!);
			const message = row.type === "message" ? row.message : undefined;
			if (message?.role === "assistant") {
				const content = text(message);
				if (content) body += `\n[${index + 1}] 子任务说明：\n${content}\n`;
				for (const part of message.content ?? []) if (part.type === "toolCall") body += `\n[${index + 1}] 调用 ${part.name} · ${part.id}\n${JSON.stringify(part.arguments, null, 2)}\n`;
				if (message.errorMessage) body += `\n[${index + 1}] 模型错误：${message.errorMessage}\n`;
			} else if (message?.role === "toolResult") {
				body += `\n[${index + 1}] ${message.isError ? "失败" : "返回"} ${message.toolName} · ${message.toolCallId}\n${text(message)}\n`;
				if (message.details && Object.keys(message.details).length) body += `${JSON.stringify(message.details, null, 2)}\n`;
			}
		}
		if (partial) body += "\n原始记录末行未完整写入，等待后续更新。";
	} catch (error) { body += `\n原始记录读取失败：${String(error)}`; }
	if (task.result === undefined && task.progress?.output) body += `\n\n当前输出（临时预览）：\n${task.progress.output}`;
	return body;
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
				const panel = new DeliveryPanel("子任务详情", "正在读取原始记录…", "", [], tui, theme, () => done());
				close = () => done();
				const refresh = async () => {
					if (closed || loading) return;
					loading = true;
					try {
						const task = taskDetails(ctx, live()).find((task) => task.id === id);
						const body = task ? await taskDetailBody(task) : "任务已离开当前分支。";
						if (!closed) { panel.body = body; tui.requestRender(); }
					} catch (error) {
						if (!closed) { panel.body = `详情更新失败：${String(error)}`; tui.requestRender(); }
					} finally { loading = false; }
				};
				const timer = setInterval(() => void refresh(), 1000);
				void refresh();
				return Object.assign(panel, { dispose() { closed = true; clearInterval(timer); close = undefined; } });
			}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } });
		} finally { close = undefined; }
	};
	pi.registerCommand("delivery-tasks", { description: "查看交付子任务详情，Esc 关闭详情", handler: (args, ctx) => open(args.trim() || undefined, ctx) });
	return (id: string) => { void open(id).catch((error) => current?.ui.notify(`无法打开任务详情：${String(error)}`, "error")); };
}
