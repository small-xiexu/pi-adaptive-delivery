import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATE_TOOL } from "./subagents.ts";
import { APPROVAL_TOOL } from "./approvals.ts";
import { DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL } from "./parent-writer.ts";
import { DEVELOPMENT_TOOL, VALIDATION_TOOL, REVIEW_TOOL } from "./development.ts";
import { GIT_STATUS_TOOL } from "./workspace.ts";

export const CAPABILITY_NOTICE = "交付已启用：父会话负责讨论、Markdown 和委派；开发须方案及实施确认与 writer 交接，原生或已核实 Structured 命令在本机执行。文件工具检查路径，Shell 使用当前用户权限，不提供文件、网络或后台进程隔离。讨论与独立审查仅提供读取工具。用户在父 TUI 手动 !/!! 沿用 Pi 原生行为，不授予 AI 权限或替代固定验收。旧批准和验收不自动恢复，完成结论须有当前候选证据。";
const NATIVE_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function allowedReadTools(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">): string[] {
	const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().filter((name) => NATIVE_READ_TOOLS.has(name)
		&& tools.get(name)?.sourceInfo.source === "builtin");
}

export function installPolicy(pi: ExtensionAPI, coordinatorPath?: string, developerPath?: string, structuredAllowed: (name: string) => boolean = () => false): () => void {
	const coordinatorAllowed = (name: string) => coordinatorPath !== undefined && [GIT_STATUS_TOOL, DELEGATE_TOOL, APPROVAL_TOOL, DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL, DEVELOPMENT_TOOL, VALIDATION_TOOL, REVIEW_TOOL].includes(name)
		&& pi.getAllTools().some((tool) => tool.name === name && tool.sourceInfo.path === coordinatorPath);
	const developerAllowed = (name: string) => developerPath !== undefined && ["edit", "write", "bash"].includes(name)
		&& pi.getAllTools().some((tool) => tool.name === name && tool.sourceInfo.path === developerPath);
	const restrictTools = () => {
		const tools = allowedReadTools(pi);
		tools.push(...pi.getActiveTools().filter((name) => coordinatorAllowed(name) || developerAllowed(name) || structuredAllowed(name)));
		pi.setActiveTools(tools);
	};
	pi.on("session_start", restrictTools);
	// active-tools 只减少模型看到的工具，不作为权限保证；实际调用时重新核实实现来源。
	pi.on("tool_call", (event) => {
		try {
			if (coordinatorAllowed(event.toolName) || developerAllowed(event.toolName) || structuredAllowed(event.toolName)) return undefined;
			if (allowedReadTools(pi).includes(event.toolName)) return undefined;
		} catch (error) {
			return { block: true, reason: `无法核实工具权限，未执行：${String(error)}` };
		}
		return { block: true, reason: `${CAPABILITY_NOTICE} 工具 ${event.toolName} 不在当前已验证的原生只读或父协调能力内，未执行。` };
	});
	// 用户在父 TUI 的 !/!! 交回 Pi；RPC 与子角色不能借此取得宿主执行能力。
	pi.on("user_bash", (_event, ctx) => {
		if (coordinatorPath !== undefined && ctx.mode === "tui") return;
		return { result: { output: "此入口不接受宿主 Shell 命令；用户手动 !/!! 仅在父 TUI 保留原生执行，AI 命令须使用受控工具。Shell 未执行。", exitCode: 1, cancelled: false, truncated: false } };
	});
	return restrictTools;
}
