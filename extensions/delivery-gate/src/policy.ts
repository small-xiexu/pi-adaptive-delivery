import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATE_TOOL } from "./subagents.ts";
import { APPROVAL_TOOL } from "./approvals.ts";

export const READ_ONLY_NOTICE = "当前交付编排处于重构中的只读阶段；父 TUI 可记录交付批准，但文档写入、开发写入与恢复尚未开放。";
const NATIVE_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function allowedReadTools(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">): string[] {
	const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().filter((name) => NATIVE_READ_TOOLS.has(name)
		&& tools.get(name)?.sourceInfo.source === "builtin");
}

export function installReadOnlyPolicy(pi: ExtensionAPI, coordinatorPath?: string): void {
	const coordinatorAllowed = (name: string) => coordinatorPath !== undefined && [DELEGATE_TOOL, APPROVAL_TOOL].includes(name)
		&& pi.getAllTools().some((tool) => tool.name === name && tool.sourceInfo.path === coordinatorPath);
	pi.on("session_start", () => {
		const tools = allowedReadTools(pi);
		tools.push(...pi.getActiveTools().filter(coordinatorAllowed));
		pi.setActiveTools(tools);
	});
	// active-tools 只减少模型看到的工具，不作为权限保证；实际调用时重新核实实现来源。
	pi.on("tool_call", (event) => {
		try {
			if (coordinatorAllowed(event.toolName)) return undefined;
			if (allowedReadTools(pi).includes(event.toolName)) return undefined;
		} catch (error) {
			return { block: true, reason: `无法核实工具权限，未执行：${String(error)}` };
		}
		return { block: true, reason: `${READ_ONLY_NOTICE} 工具 ${event.toolName} 不在当前已验证的原生只读能力内，未执行。` };
	});
	// 原生 !/!! 及 RPC bash 也不能绕开本阶段的关闭状态。
	pi.on("user_bash", () => ({
		result: { output: `${READ_ONLY_NOTICE} Shell 未执行。`, exitCode: 1, cancelled: false, truncated: false },
	}));
}
