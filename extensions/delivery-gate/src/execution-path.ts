import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { installApprovals } from "./approvals.ts";
import type { TaskProgress } from "./progress.ts";
import { displayText } from "./ui.ts";

export const EXECUTION_PATH_TOOL = "delivery_path";
export const EXECUTION_PATH_ENTRY = "delivery-execution-path";
export type ExecutionPathKind = "parent_direct" | "delivery_develop" | "delivery_review";
export type ExecutionPathInput = { id: string; path: ExecutionPathKind; phase: "declared" | "started" | "ended"; node: string; reason: string; [key: string]: unknown };

export function appendExecutionPath(pi: Pick<ExtensionAPI, "appendEntry">, value: ExecutionPathInput): void {
	pi.appendEntry(EXECUTION_PATH_ENTRY, { ...value, recordedAt: new Date().toISOString() });
}

// 只记录父侧声明。委派及其结果已有原生调用/结果和引用，不再写第二份。
export function installExecutionPath(pi: ExtensionAPI, approvals: Pick<ReturnType<typeof installApprovals>, "readApproval">) {
	pi.registerTool({
		name: EXECUTION_PATH_TOOL, label: "记录父 Pi 实施路径",
		description: "父 Pi 直接开始一个实施节点前调用，记录节点、选择理由和是否计划独立审查。只记录 parent_direct 声明，不修改项目、不证明完成或授予权限。delivery_develop / delivery_review 的实际调用自动展示，无须另行声明。",
		parameters: Type.Object({
			node: Type.String({ minLength: 1, description: "本次直接实施的节点" }),
			reason: Type.String({ minLength: 1, description: "选择父 Pi 直接实施的理由" }),
			independentReview: Type.Boolean({ description: "是否计划安排独立审查；计划不代表已执行" }),
		}, { additionalProperties: false }),
		execute: async (id, input, signal, _update, ctx) => {
			if (!input.node.trim() || !input.reason.trim()) throw new Error("节点和理由不能为空白");
			const grant = await approvals.readApproval(ctx, signal);
			const record = { id, path: "parent_direct" as const, phase: "declared" as const, node: input.node, reason: input.reason,
				independentReview: input.independentReview, approvalId: grant.approvalId,
				sessionId: ctx.sessionManager.getSessionId(), workspaceKey: grant.workspace.key, cwd: ctx.cwd };
			appendExecutionPath(pi, record);
			return { content: [{ type: "text", text: `执行路径：parent_direct（父 Pi 声明）\n节点：${input.node}\n理由：${input.reason}\n计划独立审查：${input.independentReview ? "是" : "否"}\n声明不代表已修改或检查通过，实际结果仍须核对原生工具记录。` }], details: record };
		},
	});
}

const short = (value: string, limit = 240) => {
	const text = displayText(value).replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, limit)}…（完整内容见原记录）`;
};
const outputText = (message: any) => (message?.content ?? []).filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
const delegatedNames = new Set(["delivery_develop", "delivery_review", "delivery_readonly"]);

interface DelegatedView {
	id: string;
	name: string;
	task: string;
	result?: string;
	resultFailed?: boolean;
	sessionFile?: string;
	progress?: TaskProgress;
}

function delegatedViews(entries: readonly SessionEntry[], live: readonly TaskProgress[]): DelegatedView[] {
	const views = new Map<string, DelegatedView>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const part of entry.message.content) {
				if (part.type !== "toolCall" || !delegatedNames.has(part.name)) continue;
				views.set(part.id, { id: part.id, name: part.name, task: String((part.arguments as any)?.task ?? "执行本次任务") });
			}
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			const view = views.get(entry.message.toolCallId);
			if (view) Object.assign(view, { result: outputText(entry.message), resultFailed: Boolean(entry.message.isError) });
		} else if (entry.type === "custom" && ["delivery-delegation", "delivery-development"].includes(entry.customType)) {
			const data = entry.data as { id?: unknown; sessionFile?: unknown; childSessionFile?: unknown } | undefined;
			const view = typeof data?.id === "string" ? views.get(data.id) : undefined;
			const sessionFile = data?.childSessionFile ?? data?.sessionFile;
			if (view && typeof sessionFile === "string") view.sessionFile = sessionFile;
		}
	}
	for (const progress of live) {
		const view = views.get(progress.id);
		if (view) view.progress = progress;
	}
	return [...views.values()];
}

// 原生分支投影：压缩不丢记录，新交付不混入上轮记录，历史“已启动”不冒充仍在运行。
export function formatExecutionPaths(entries: readonly SessionEntry[], live: readonly TaskProgress[]): string {
	const start = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === "delivery-activation");
	const branch = entries.slice(start < 0 ? 0 : start + 1);
	const tasks = delegatedViews(branch, live);
	const lines: string[] = [];
	let declared = false;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === EXECUTION_PATH_ENTRY) {
			const data = entry.data as { path?: unknown; node?: unknown; reason?: unknown; independentReview?: unknown } | undefined;
			if (data?.path !== "parent_direct" || typeof data.node !== "string" || typeof data.reason !== "string" || typeof data.independentReview !== "boolean") continue;
			declared = true;
			lines.push(`- parent_direct · ${short(data.node, 120)} · 父 Pi 已声明，执行结果见普通工具记录\n  理由：${short(data.reason)}；计划独立审查：${data.independentReview ? "是（不代表已执行）" : "否"}`);
		}
	}
	for (const task of tasks) {
		const toolError = task.result?.includes("工具调用失败记录") || task.result?.includes("过程记录（");
		const result = task.progress && !task.progress.endedAt ? "运行中"
			: task.resultFailed ? "未形成有效结果"
			: task.result !== undefined ? "已返回，结论待父 Pi 核对"
			: "未取得执行终态";
		lines.push(`- ${task.name} · ${short(task.task, 120)} · ${result}${toolError ? "；含工具失败记录" : ""}`
			+ (task.resultFailed ? `\n  失败：${short(task.result ?? "原因未取得")}` : "")
			+ `\n  调用：${task.id}${task.sessionFile ? `；原始子 Session：${task.sessionFile}` : "；尚未取得子 Session"}`);
	}
	if (!declared) lines.unshift("父侧直接实施路径：未声明；普通工具调用不自动归入业务节点。");
	return lines.join("\n") + "\n路径和子任务结束均不代表交付通过；父侧普通检查见原生工具结果。";
}

export function deliveryStage(confirmed: boolean, busy: boolean, queued: boolean) {
	return confirmed ? busy ? "实施进行中（父 Pi 回合运行中）" : queued ? "交付已启用，仍有排队消息" : "交付已启用，当前无在途任务" : "等待方案确认";
}
