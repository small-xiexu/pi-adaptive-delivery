import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";

export interface TaskProgress {
	id: string;
	name: string;
	status: string;
	action: string;
	recent: string[];
	output: string;
	startedAt: number;
	endedAt?: number;
	sessionFile?: string;
	agent?: { provider: string; id: string; thinking: string; reason: string };
	pending?: { id: string; name: string; callId?: string; args?: unknown; output: string }[];
}
export type ProgressUpdate = (message: string, progress: TaskProgress) => void;
export const TOOL_ERROR_STATUS = "已结束，有工具错误待核对";
export const TOOL_ERROR_GUIDANCE = "过程中有工具错误。请核对原始错误、后续操作及最终产物，再决定是否返工或继续验证；此结果不证明错误已修复或任务已验收。";
const short = (text: string, limit = 300) => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").slice(0, limit);
const tail = (text: string) => text.length > 4000 ? `[预览已省略，详情查看完整内容]\n${text.slice(-4000)}` : text;
const streamingTail = (text: string) => text.length > 64_000 ? `[在途输出仅保留最近片段，完成后可查看原始结果]\n${text.slice(-64_000)}` : text;
const outputText = (result: any) => (result?.content ?? []).filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");

// 每个调用独立的展示缓存；证据与交接仍只使用原生 Session。
export function createTaskProgress(id: string, label: string, task: string, update: ProgressUpdate) {
	const view: TaskProgress = { id, name: short(`${label} · ${task}`, 160), status: "准备中", action: "核对任务环境", recent: [], output: "", startedAt: Date.now() };
	const open = new Map<string, string>();
	const pending = new Map<string, NonNullable<TaskProgress["pending"]>[number]>();
	const commands = new Map<number, string>();
	const polls = new Map<string, number>();
	let text = "";
	let messageId: string | undefined;
	const snapshot = (): TaskProgress => structuredClone({ ...view, pending: [...pending.values()] });
	const emit = () => {
		// UI 通知失败不改变工具结果、取消或权限裁决。
		try { update(`${view.name} · ${view.status}\n${view.action}`, snapshot()); } catch { /* 展示可丢失，原始执行记录保留。 */ }
	};
	const action = (value: string) => {
		view.action = short(value);
		view.recent.push(view.action);
		if (view.recent.length > 16) view.recent.shift();
	};
	return {
		snapshot,
		agent(agent: NonNullable<TaskProgress["agent"]>) { view.agent = { ...agent }; emit(); },
		phase(status: string, detail?: string, sessionFile?: string) {
			view.status = status;
			if (detail) action(detail);
			if (sessionFile) view.sessionFile = sessionFile;
			emit();
		},
		end(status: string) {
			view.status = status; view.endedAt = Date.now();
			pending.clear();
			if (view.action.startsWith("正在执行：")) view.action = view.action.replace("正在执行：", "最后操作：");
			emit();
		},
		event(event: { type: string; [key: string]: any }) {
			if (event.type === "tool_execution_start") {
				const args = event.args ?? {};
				const target = args.command ?? args.cmd ?? args.path ?? args.pattern ?? (event.toolName === "apply_patch" ? args.input?.match(/\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/)?.[1] : undefined)
					?? (args.session_id !== undefined ? `session ${args.session_id}` : "");
				const detail = commands.get(args.session_id) ?? short(`${event.toolName}${target ? ` ${target}` : ""}`);
				if (event.toolName === "write_stdin") polls.set(event.toolCallId, args.session_id);
				open.set(event.toolCallId, detail);
				pending.set(`call:${event.toolCallId}`, { id: `call:${event.toolCallId}`, callId: event.toolCallId, name: event.toolName, args, output: "" });
				view.output = "";
				view.status = "执行中";
				action(`正在执行：${detail}`);
			} else if (event.type === "tool_execution_end") {
				const detail = open.get(event.toolCallId) ?? event.toolName;
				open.delete(event.toolCallId);
				pending.delete(`call:${event.toolCallId}`);
				const session = event.result?.details?.session_id;
				const running = !event.isError && ["exec_command", "write_stdin"].includes(event.toolName) && typeof session === "number";
				if (running) commands.set(session, detail);
				if (!event.isError && Number.isInteger(event.result?.details?.exit_code)) commands.delete(polls.get(event.toolCallId)!);
				polls.delete(event.toolCallId);
				action(`${event.isError ? "工具失败" : running ? "正在执行" : "已完成"}：${detail}`);
				view.status = event.isError ? "工具失败，子任务仍在运行" : running ? "执行中" : "运行中";
				if (open.size) view.action = `正在执行：${[...open.values()].at(-1)}`;
				else if (!event.isError && commands.size) view.action = `正在执行：${[...commands.values()].at(-1)}`;
				view.output = tail(outputText(event.result));
			} else if (event.type === "tool_execution_update") {
				view.output = tail(outputText(event.partialResult));
				const entry = pending.get(`call:${event.toolCallId}`);
				if (entry) entry.output = streamingTail(outputText(event.partialResult));
			} else if (event.type === "message_start" && event.message?.role === "assistant") {
				text = "";
				if (messageId) pending.delete(messageId);
				messageId = `text:${event.message.timestamp}`;
			} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				text = streamingTail(text + event.assistantMessageEvent.delta);
				view.output = tail(text);
				if (messageId) pending.set(messageId, { id: messageId, name: "子任务说明", output: text });
				if (!open.size && !commands.size) view.action = "正在整理任务说明";
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				if (messageId) pending.delete(messageId);
				messageId = undefined;
				text = tail(outputText(event.message));
				if (text) { view.output = text; if (!open.size && !commands.size) view.action = "已更新任务说明"; }
			} else if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
				view.status = "等待用户回答";
				action(event.title ?? event.message ?? "子任务请求交互");
			} else if (event.type === "agent_settled") {
				view.status = "核对收尾中";
			} else return;
			emit();
		},
	};
}

export function taskRenderers(label: string, open?: (id: string) => void): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall: () => new Container(),
		renderResult(result, { expanded, isPartial }, theme, context) {
			const progress = (result.details as { progress?: TaskProgress } | undefined)?.progress;
			if (progress) context.state.progress = progress;
			const latest = (progress ?? context.state.progress) as TaskProgress | undefined;
			const body = outputText(result);
			const status = isPartial ? latest?.status ?? "准备中" : context.isError ? (latest?.status === "已取消" || latest?.status === "收尾未知" ? latest.status : "失败") : latest?.status ?? "执行结束，结果待核实";
			const heading = `${status === "执行结束，结果待核实" ? "已结束，待核对" : status} · ${label} · ${short((context.args as { task?: string })?.task ?? "固定候选验收", 64)}`;
			const detail = (latest?.agent ? `${short(latest.agent.id, 32)} · ${latest.agent.thinking} · ` : "") + (latest?.action ?? (isPartial ? "核对任务环境" : short(body)));
			const component = {
				invalidate() {},
				render(width: number) {
					const hint = open ? " /delivery-tasks" : "";
					const title = truncateToWidth(theme.fg(context.isError ? "error" : status === TOOL_ERROR_STATUS ? "warning" : "toolTitle", heading), Math.max(1, width - hint.length));
					const lines = [truncateToWidth(title + theme.fg("muted", hint), width), truncateToWidth(theme.fg("muted", detail), width)];
					if (expanded) {
						if (open) lines.push(...new Text("/delivery-tasks 查看详情 · 全屏模式可点击卡片 · Esc 关闭详情", 0, 0).render(width));
						const elapsed = latest ? `耗时 ${Math.max(0, ((latest.endedAt ?? Date.now()) - latest.startedAt) / 1000).toFixed(1)} 秒` : "";
						const more = [latest?.agent ? `模型：${latest.agent.provider}/${latest.agent.id} · ${latest.agent.thinking}\n选择理由：${latest.agent.reason}` : "", elapsed, ...(latest?.recent ?? []), latest?.output, latest?.sessionFile ? `原始子 Session：${latest.sessionFile}` : "", !isPartial ? tail(body) : ""].filter(Boolean).join("\n");
						// Text 处理宽度；终端控制字符不能通过子输出注入界面。
						lines.push(...new Text(more.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""), 0, 0).render(width));
					}
					return lines;
				},
			};
			return open ? new MouseRegion(component, (event) => {
				if (event.type === "click" && event.button === "left") { open(context.toolCallId); return { handled: true }; }
				return undefined;
			}) : component;
		},
	};
}
