import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATE_TOOL } from "./subagents.ts";
import { APPROVAL_TOOL } from "./approvals.ts";
import { DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL } from "./parent-writer.ts";
import { DEVELOPMENT_TOOL, REVIEW_TOOL } from "./development.ts";
import { GIT_STATUS_TOOL } from "./workspace.ts";
import { EXECUTION_PATH_TOOL } from "./execution-path.ts";

export const CAPABILITY_NOTICE = "交付已启用：小改动、低风险、范围明确的任务可以直接由父 Pi 完成；复杂任务才委派，必要时独立审查。交付保留 Pi 原有工具与权限检查，联网查资料、文件、Shell 和插件能力不按角色删减。方案确认后立即授权本轮实施，实施计划由父 Pi 内部维护，不另设第二次确认。交付委派和 writer 交接只管理本 Package 的开发与审查调用。普通工具不由交付 writer 接管。父负责讨论与协调，开发子按任务实现，审查子主动运行测试并独立检查；两者都应遵守用户授权，不能因工具可用就擅自写入、递归委派或执行外部操作。父 Pi 直接实施节点前调用 delivery_path 记录路径；委派路径由 Package 自动记录。旧批准不自动恢复，完成结论须有当前候选证据。交付完成时必须分开说明修改内容、实际检查命令与退出码、独立审查、限制和未执行项；未运行检查不得写成通过。delivery_develop 或 delivery_review 的 paths 只放源码、测试和配置，inputs 只放额外只读证据；父维护规划文档发生范围冲突时会在子 Session 启动前拒绝调用。若 lease 残留，先用 /delivery-status details 确认没有在途任务，再执行 /delivery-unlock；如果提示已复位同一父进程中已结束且有 fault 的已知运行态，方案确认仍有效时可重新核对现场并重试交付任务；如果仍保留交付状态，再用 /delivery-exit 结束并重载。/delivery-exit 不负责清理 lease。";

// 子任务继承父实际启用的工具；交付协调工具属于父会话，不是项目原有能力。
export function inheritedTools(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">, entryPath: string) {
	const active = new Set(pi.getActiveTools());
	return pi.getAllTools().filter((tool) => active.has(tool.name) && tool.sourceInfo.path !== entryPath);
}

export function installPolicy(pi: ExtensionAPI, entryPath: string): void {
	const ownTools = [GIT_STATUS_TOOL, DELEGATE_TOOL, APPROVAL_TOOL, DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL, DEVELOPMENT_TOOL, REVIEW_TOOL, EXECUTION_PATH_TOOL];
	// 仅核实本 Package 的交付入口；普通工具继续由 Pi 和原有插件判断。
	pi.on("tool_call", (event) => {
		if (!ownTools.includes(event.toolName)) return;
		try {
			if (pi.getAllTools().some((tool) => tool.name === event.toolName && tool.sourceInfo.path === entryPath)) return;
		} catch (error) { return { block: true, reason: `无法核实交付工具来源，未执行：${String(error)}` }; }
		return { block: true, reason: `交付工具 ${event.toolName} 的实现来源已变化，未执行。` };
	});
}
