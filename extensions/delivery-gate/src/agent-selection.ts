import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const agentSelection = Type.Object({
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
	reason: Type.String({ minLength: 1, description: "按本次工作场景、复杂度和风险选择推理级别的简短理由" }),
}, { additionalProperties: false, description: "子任务固定使用父 Pi 当前模型，只能选择该模型支持的推理级别；省略 thinking 继承父当前级别，不自动降级。" });

export function selectChildAgent(pi: Pick<ExtensionAPI, "getThinkingLevel">, ctx: Pick<ExtensionContext, "model">, choice?: Static<typeof agentSelection>) {
	if (!ctx.model) throw new Error("父会话模型尚未确定，未委派");
	if (choice && !choice.reason.trim()) throw new Error("推理级别选择理由不能为空白");
	const model = ctx.model;
	const thinking = choice?.thinking ?? pi.getThinkingLevel();
	if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error(`模型 ${model.provider}/${model.id} 不支持 ${thinking}；可选：${getSupportedThinkingLevels(model).join("、")}。未启动子任务`);
	return { model, thinking, selectionReason: choice?.reason.trim() ?? "继承父会话" };
}
