import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATE_TOOL } from "./subagents.ts";
import { APPROVAL_TOOL } from "./approvals.ts";
import { DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL } from "./parent-writer.ts";
import { DEVELOPMENT_TOOL, VALIDATION_TOOL, REVIEW_TOOL } from "./development.ts";
import { GIT_STATUS_TOOL } from "./workspace.ts";

export const CAPABILITY_NOTICE = "交付已启用：保留 Pi 原有工具与权限检查，联网查资料、文件、Shell 和插件能力不按角色删减。方案与实施仍分别确认，交付委派、写入交接和固定候选验收只管理本 Package 的交付调用。普通工具不由交付 writer 接管，也不能用其输出代替固定验收。父负责讨论与协调，子按任务要求开发或只读审查；两者都应遵守用户授权，不能因工具可用就擅自写入、递归委派或执行外部操作。旧批准和验收不自动恢复，完成结论须有当前候选证据。";

// 子任务继承父实际启用的工具；交付协调工具属于父会话，不是项目原有能力。
export function inheritedTools(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">, entryPath: string) {
	const active = new Set(pi.getActiveTools());
	return pi.getAllTools().filter((tool) => active.has(tool.name) && tool.sourceInfo.path !== entryPath);
}

export function installPolicy(pi: ExtensionAPI, entryPath: string): void {
	const ownTools = [GIT_STATUS_TOOL, DELEGATE_TOOL, APPROVAL_TOOL, DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL, DEVELOPMENT_TOOL, VALIDATION_TOOL, REVIEW_TOOL];
	// 仅核实本 Package 的交付入口；普通工具继续由 Pi 和原有插件判断。
	pi.on("tool_call", (event) => {
		if (!ownTools.includes(event.toolName)) return;
		try {
			if (pi.getAllTools().some((tool) => tool.name === event.toolName && tool.sourceInfo.path === entryPath)) return;
		} catch (error) { return { block: true, reason: `无法核实交付工具来源，未执行：${String(error)}` }; }
		return { block: true, reason: `交付工具 ${event.toolName} 的实现来源已变化，未执行。` };
	});
}
