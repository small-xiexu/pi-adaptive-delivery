import type { SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, MouseRegion, stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";

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
export const RUNNING_STATUS = "运行中";
export const COMPLETED_STATUS = "已完成";
export const ABNORMAL_STATUS = "异常退出";
export const TOOL_ERROR_GUIDANCE = "以下为过程中工具调用的原始异常摘要。它不单独改变子 Agent 状态；请交给父 Pi 结合调用、原始返回、后续操作和最终产物判断是否继续。";
const short = (text: string, limit = 300) => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").slice(0, limit);
const tail = (text: string) => text.length > 4000 ? `[预览已省略，详情查看完整内容]\n${text.slice(-4000)}` : text;
const streamingTail = (text: string) => text.length > 64_000 ? `[在途输出仅保留最近片段，完成后可查看原始结果]\n${text.slice(-64_000)}` : text;
const outputText = (result: any): string => (result?.content ?? []).filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");

// 只投影已读取的原生记录，不解析 Shell 语义，也不保存另一份错误或修复状态。
export function summarizeToolErrors(rows: readonly SessionEntry[]) {
	const calls = new Map<string, Record<string, unknown>>();
	const notes: string[] = [];
	let count = 0;
	let first = "";
	const excerpt = (text: string, limit = 400) => {
		const value = short(stripTerminalSequences(text), Infinity).replace(/\s+/g, " ").trim();
		return value.length <= limit ? value : `${value.slice(0, limit / 2)} …[已截断]… ${value.slice(-limit / 2)}`;
	};
	for (const [index, row] of rows.entries()) {
		if (row.type !== "message") continue;
		const message = row.message;
		if (message.role === "assistant") {
			for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part.arguments);
		} else if (message.role === "toolResult") {
			const args = calls.get(message.toolCallId);
			calls.delete(message.toolCallId);
			if (!message.isError) continue;
			count++;
			if (notes.length >= 3) continue;
			const name = excerpt(message.toolName, 60);
			const output = outputText(message).trim();
			const reason = output || "未取得文本返回，请查看原记录";
			const target = args?.command ?? args?.cmd ?? args?.path ?? args?.file_path ?? args?.pattern;
			first ||= `${name}：${excerpt(reason, 140)}`;
			notes.push(`- ${name} · 原记录第 ${index + 1} 行${typeof target === "string" ? `\n  调用：${excerpt(target)}` : ""}\n  返回：${excerpt(reason)}`);
		}
	}
	if (!count) return undefined;
	return { action: `${count} 次工具异常 · ${first}`, text: `过程记录（${count} 次工具异常）：\n${notes.join("\n")}`
		+ (count > notes.length ? `\n其余 ${count - notes.length} 次见原始子 Session。` : "") };
}

// 每个调用独立的展示缓存；证据与交接仍只使用原生 Session。
export function createTaskProgress(id: string, label: string, task: string, update: ProgressUpdate) {
	const view: TaskProgress = { id, name: short(`${label} · ${task}`, 160), status: RUNNING_STATUS, action: "核对任务环境", recent: [], output: "", startedAt: Date.now() };
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
		phase(_status: string, detail?: string, sessionFile?: string) {
			view.status = RUNNING_STATUS;
			if (detail) action(detail);
			if (sessionFile) view.sessionFile = sessionFile;
			emit();
		},
		end(status: typeof COMPLETED_STATUS | typeof ABNORMAL_STATUS, detail?: string) {
			view.status = status; view.endedAt = Date.now();
			pending.clear();
			if (detail) action(detail);
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
				view.status = RUNNING_STATUS;
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
				action(`${event.isError ? "已返回" : running ? "正在执行" : "已完成"}：${detail}`);
				view.status = RUNNING_STATUS;
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
				view.status = RUNNING_STATUS;
				action(event.title ?? event.message ?? "子任务请求交互");
			} else if (event.type === "agent_settled") {
				view.status = RUNNING_STATUS;
			} else return;
			emit();
		},
	};
}

export function taskRenderers(label: string, open?: (id: string) => void): Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell"> {
	return {
		renderShell: "self",
		renderCall: () => new Container(),
		renderResult(result, { expanded, isPartial }, theme, context) {
			const progress = (result.details as { progress?: TaskProgress } | undefined)?.progress;
			if (progress) context.state.progress = progress;
			const latest = (progress ?? context.state.progress) as TaskProgress | undefined;
			const body = outputText(result);
			const status = latest?.endedAt ? (latest.status === ABNORMAL_STATUS ? ABNORMAL_STATUS : COMPLETED_STATUS)
				: isPartial ? RUNNING_STATUS : context.isError ? ABNORMAL_STATUS : COMPLETED_STATUS;
			const heading = `${status} · ${label} · ${short((context.args as { task?: string })?.task ?? "固定候选验收", 64)}`;
			const detail = (latest?.agent ? `${short(latest.agent.id, 32)} · ${latest.agent.thinking} · ` : "") + (latest?.action ?? (isPartial ? "核对任务环境" : short(body)));
			const component = {
				invalidate() {},
				render(width: number) {
					const hint = open ? " /delivery-tasks" : "";
					const title = truncateToWidth(theme.fg(status === ABNORMAL_STATUS ? "error" : "toolTitle", heading), Math.max(1, width - hint.length));
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
			const background = status === ABNORMAL_STATUS ? "toolErrorBg" : status === RUNNING_STATUS ? "toolPendingBg" : "toolSuccessBg";
			const frame = new Box(1, 1, (text) => theme.bg(background, text));
			frame.addChild(component);
			return open ? new MouseRegion(frame, (event) => {
				if (event.type === "click" && event.button === "left") { open(context.toolCallId); return { handled: true }; }
				return undefined;
			}) : frame;
		},
	};
}
