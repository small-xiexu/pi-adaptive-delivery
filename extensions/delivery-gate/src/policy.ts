import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATE_TOOL } from "./subagents.ts";
import { APPROVAL_TOOL } from "./approvals.ts";
import { DOCUMENT_EDIT_TOOL, DOCUMENT_WRITE_TOOL } from "./parent-writer.ts";
import { DEVELOPMENT_TOOL, REVIEW_TOOL } from "./development.ts";
import { GIT_STATUS_TOOL } from "./workspace.ts";
import { EXECUTION_PATH_TOOL } from "./execution-path.ts";

export const CAPABILITY_NOTICE = "交付已启用：先确认方案，再按范围实施、检查和必要的独立审查。方案确认后立即授权本轮实施，不另设第二次确认。简单任务由父 Pi 直接完成，复杂任务才委派；所有普通工具和原有权限继续由 Pi 管理。范围内返工不重复确认。delivery_develop 和 delivery_review 的 paths 只放源码、测试和配置，inputs 只放额外只读证据。交付结果要区分修改、实际检查、独立审查和未验证事项。交付工具只管理自身的任务交接，不接管普通工具。若上次任务留下占用，用户说“继续”时先自动核对；能证明任务已结束就恢复，无法核实时只请求一次选择，不要求用户理解或操作内部 lease。不要向用户解释 Skill 或内部规则，不把任务收尾当作检查通过。结束交付不会强制清理占用。";

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
