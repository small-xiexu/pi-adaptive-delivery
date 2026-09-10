import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const ENTRY = "delivery-activation";
type Activation = { enabled: boolean; tools?: string[] };
type Runtime = { initialize(): Promise<void>; assertCanExit(ctx: ExtensionContext): Promise<void> };

// 只保存用户选择的入口和原工具集合，不保存或恢复批准。
export function installActivation(pi: ExtensionAPI, start: () => Runtime): void {
	let runtime: Runtime | undefined;
	let originalTools: string[] = [];
	let restoreTools: string[] | undefined;
	let changing = false;
	const enter = async () => {
		runtime ??= start();
		await runtime.initialize();
	};
	pi.on("session_start", async (_event, ctx) => {
		const entry = ctx.sessionManager.getEntries().findLast((row) => row.type === "custom" && row.customType === ENTRY);
		if (entry?.type !== "custom") return;
		const state = entry.data as Activation;
		if (state.enabled) {
			originalTools = state.tools ?? [];
			await enter();
		} else if (state.tools) {
			restoreTools = state.tools;
		}
	});
	// 此事件在所有 session_start 钩子之后运行，避免原插件启动时覆盖用户停用选择。
	pi.on("resources_discover", () => {
		if (!restoreTools) return;
		pi.setActiveTools(restoreTools.filter((name) => pi.getAllTools().some((tool) => tool.name === name)));
		pi.appendEntry(ENTRY, { enabled: false });
		restoreTools = undefined;
	});
	pi.registerCommand("delivery-status", {
		description: "查看交付是否启用及当前状态",
		handler: async (_args, ctx) => { ctx.ui.notify("交付未启用，当前沿用 Pi 原有工具。使用 /delivery-shape 进入交付流程。", "info"); },
	});
	pi.registerCommand("delivery-shape", {
		description: "启用当前会话的受控交付，可附带需求",
		handler: async (args, ctx) => {
			if (changing || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("请等待当前回合和排队消息结束后再进入交付。", "warning");
				return;
			}
			changing = true;
			try {
				if (!runtime) {
					originalTools = pi.getActiveTools();
					pi.appendEntry(ENTRY, { enabled: true, tools: originalTools });
					await enter();
				}
				ctx.ui.notify("交付已启用；方案与实施仍需分别确认。任务收尾后用 /delivery-exit 恢复普通使用。", "info");
				if (args.trim()) pi.sendUserMessage(`先读取并遵循 ${fileURLToPath(new URL("../../../skills/adaptive-delivery/SKILL.md", import.meta.url))}，核实项目事实并对齐需求；明确需求可以零追问，简单任务无须规划文档。当前需求：\n${args}`, { expandPromptTemplates: false });
			} finally { changing = false; }
		},
	});
	pi.registerCommand("delivery-exit", {
		description: "交付执行收尾后退出，并重载恢复原工具",
		handler: async (_args, ctx) => {
			if (!runtime) { ctx.ui.notify("交付未启用。", "info"); return; }
			if (changing || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("当前仍有执行或排队消息，请先等待收尾或取消，再退出交付。", "warning");
				return;
			}
			changing = true;
			try { await runtime.assertCanExit(ctx); }
			catch (error) {
				changing = false;
				ctx.ui.notify(`暂不能退出交付：${String(error)}`, "warning");
				return;
			}
			pi.appendEntry(ENTRY, { enabled: false, tools: originalTools });
			pi.sendMessage({ customType: "delivery-mode", content: "用户已通过 /delivery-exit 结束本轮受控交付。后续普通请求沿用 Pi 原有工具与项目规则，不再要求交付阶段确认；旧交付记录只供查阅，不授予新权限。", display: false }, { triggerTurn: false });
			pi.setActiveTools(originalTools);
			ctx.ui.notify("交付已退出，正在重载并恢复原工具；执行记录保留，旧批准不再有效。", "info");
			await ctx.reload();
		},
	});
}
