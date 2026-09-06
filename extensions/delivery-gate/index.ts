import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { allowedReadTools, installReadOnlyPolicy, READ_ONLY_NOTICE } from "./src/policy.ts";
import { resolveWorkspaceIdentity } from "./src/workspace.ts";
import { CHILD_ENV, CHILD_READY, CHILD_EXIT, CHILD_STOP, DELEGATE_TOOL, DELEGATION_ENTRY, delegateReadOnly } from "./src/subagents.ts";
import { installApprovals } from "./src/approvals.ts";

export default function adaptiveDelivery(pi: ExtensionAPI): void {
	const entryPath = fileURLToPath(import.meta.url);
	// 子进程启动前确定角色；该内部标记只去除协调权限，不提供批准能力。
	const child = process.env[CHILD_ENV] === "1";
	installReadOnlyPolicy(pi, child ? undefined : entryPath);
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${READ_ONLY_NOTICE}\n不要把规划目标、旧记录或模型声明当成已实现功能或用户批准。`,
	}));
	if (child) {
		pi.registerCommand(CHILD_STOP, { description: "内部子任务收尾，不授予任何权限", handler: async (_args, ctx) => ctx.shutdown() });
		pi.registerCommand(CHILD_READY, { description: "内部只读环境核对，不调用模型", handler: async (_args, ctx) => {
			const workspace = await resolveWorkspaceIdentity(ctx.cwd);
			pi.appendEntry(CHILD_READY, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
				cwd: workspace.cwdPath, entryPath, tools: allowedReadTools(pi), projectTrusted: ctx.isProjectTrusted() });
		} });
		pi.on("session_shutdown", (_event, ctx) => {
			pi.appendEntry(CHILD_EXIT, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId() });
		});
		return;
	}
	installApprovals(pi);
	const active = new Map<AbortController, Promise<unknown>>();
	pi.registerTool({
		name: DELEGATE_TOOL, label: "只读委派",
		description: "在独立标准 Pi 会话中执行一次只读分析。仅支持父会话已启用的原生 read/grep/find/ls；需要其他能力时不要用它冒充开发。结果最多 2000 行或 50KB，原始证据保留在子 Session。",
		parameters: Type.Object({ task: Type.String({ minLength: 1, description: "目标、必要背景、只读边界及预期证据；不要复制父完整历史" }) }),
		execute: async (id, params, signal, onUpdate, ctx) => {
			if (!ctx.model) throw new Error("当前模型未确定，未委派");
			const controller = new AbortController();
			const operation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			const run = (async () => {
				const workspace = await resolveWorkspaceIdentity(ctx.cwd);
				const result = await delegateReadOnly({ id, task: params.task, cwd: workspace.cwdPath, entryPath,
					parentSessionId: ctx.sessionManager.getSessionId(), model: ctx.model!, thinking: pi.getThinkingLevel(),
					tools: allowedReadTools(pi), projectTrusted: ctx.isProjectTrusted() }, operation,
					(data) => pi.appendEntry(DELEGATION_ENTRY, data),
					(message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }));
				return { content: [{ type: "text" as const, text: `子任务执行结束，结果仍需父会话核实：\n${result.text}\n子会话：${result.sessionFile}` }], details: result };
			})();
			active.set(controller, run);
			try { return await run; } finally { active.delete(controller); }
		},
	});
	pi.on("session_before_switch", () => active.size ? { cancel: true } : undefined);
	pi.on("session_before_fork", () => active.size ? { cancel: true } : undefined);
	pi.on("session_shutdown", async (_event, ctx) => {
		for (const controller of active.keys()) controller.abort(new Error("父会话正在关闭或重载"));
		const results = await Promise.allSettled(active.values());
		if (results.some((result) => result.status === "rejected")) ctx.ui.notify("委派已停止；存在取消或失败，请核对原生会话记录。", "warning");
	});
	pi.registerCommand("delivery-status", {
		description: "查看当前交付编排能力与工作区",
		handler: async (_args, ctx) => {
			try {
				const workspace = await resolveWorkspaceIdentity(ctx.cwd);
				ctx.ui.notify(`${READ_ONLY_NOTICE}\n工作区：${workspace.workspacePath}`, "info");
			} catch (error) {
				ctx.ui.notify(`${READ_ONLY_NOTICE}\n工作区未核实：${String(error)}`, "error");
			}
		},
	});
}
