import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const agentSelection = Type.Object({
	model: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
	reason: Type.String({ minLength: 1, description: "按本次工作场景、复杂度和风险选择模型/级别的简短理由" }),
}, { additionalProperties: false, description: "可选子任务配置。先用 delivery_models 查询可用模型和支持级别；未指定的字段继承父会话。不自动降级或切换 Provider。" });

export function selectChildAgent(pi: Pick<ExtensionAPI, "getThinkingLevel">, ctx: Pick<ExtensionContext, "model" | "modelRegistry">, choice?: Static<typeof agentSelection>) {
	if (!ctx.model) throw new Error("父会话模型尚未确定，未委派");
	if (choice && !choice.reason.trim()) throw new Error("模型选择理由不能为空白");
	const model = choice?.model ? ctx.modelRegistry.getAvailable().find((model) => model.provider === choice.model!.provider && model.id === choice.model!.id) : ctx.model;
	if (!model) throw new Error("所选模型不在 Pi 当前可用模型中；先用 delivery_models 核对，不自动切换");
	const thinking = choice?.thinking ?? pi.getThinkingLevel();
	if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error(`模型 ${model.provider}/${model.id} 不支持 ${thinking}；可选：${getSupportedThinkingLevels(model).join("、")}。未启动子任务`);
	return { model, thinking, selectionReason: choice?.reason.trim() ?? "继承父会话" };
}

export function installModelCatalog(pi: ExtensionAPI) {
	pi.registerTool({ name: "delivery_models", label: "子任务可用模型", description: "只读列出 Pi 已配置且可用的模型及推理级别，供父按工作场景选择子任务配置；不调用 Provider，不返回凭据或统计费用。",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (_id, _input, _signal, _update, ctx) => {
			const models = ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, name: model.name, thinking: getSupportedThinkingLevels(model) }));
			return { content: [{ type: "text", text: models.length ? JSON.stringify(models, null, 2) : "Pi 当前没有可用模型。" }], details: { models } };
		},
	});
}
