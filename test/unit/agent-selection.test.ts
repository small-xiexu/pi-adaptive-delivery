import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { installModelCatalog, selectChildAgent } from "../../extensions/delivery-gate/src/agent-selection.ts";

const model: Model<Api> = { provider: "fixture", id: "reasoner", name: "测试推理模型", api: "openai-completions", baseUrl: "http://127.0.0.1",
	reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 };
const light: Model<Api> = { ...model, provider: "other-fixture", id: "light", reasoning: false };
const ctx = { model, modelRegistry: { getAvailable: () => [model, light] } } as Pick<ExtensionContext, "model" | "modelRegistry">;
const pi = { getThinkingLevel: () => "high" as const };

test("未指定配置继承父模型与推理级别，显式选择分别覆盖且不改变父状态", () => {
	assert.deepEqual(selectChildAgent(pi, ctx), { model, thinking: "high", selectionReason: "继承父会话" });
	assert.deepEqual(selectChildAgent(pi, ctx, { thinking: "medium", reason: "边界明确的局部实现" }), { model, thinking: "medium", selectionReason: "边界明确的局部实现" });
	assert.deepEqual(selectChildAgent(pi, ctx, { model: { provider: light.provider, id: light.id }, thinking: "off", reason: "执行固定命令" }),
		{ model: light, thinking: "off", selectionReason: "执行固定命令" });
	assert.equal(ctx.model, model); assert.equal(pi.getThinkingLevel(), "high");
});

test("未知或未配置模型、不支持的级别和空白理由均拒绝，不静默降级", () => {
	assert.throws(() => selectChildAgent(pi, ctx, { model: { provider: "unknown", id: "reasoner" }, reason: "未配置" }), /不在 Pi 当前可用模型/);
	assert.throws(() => selectChildAgent(pi, ctx, { model: { provider: light.provider, id: light.id }, reason: "继承不支持的 high" }), /不支持 high/);
	assert.throws(() => selectChildAgent(pi, ctx, { thinking: "xhigh", reason: "模型没有扩展级别" }), /不支持 xhigh/);
	assert.throws(() => selectChildAgent(pi, ctx, { thinking: "medium", reason: " " }), /不能为空白/);
	const sparse = { ...model, thinkingLevelMap: { low: null, xhigh: "xhigh" } };
	assert.throws(() => selectChildAgent(pi, { ...ctx, model: sparse }, { thinking: "low", reason: "不支持的空档位" }), /不支持 low/);
	assert.equal(selectChildAgent(pi, { ...ctx, model: sparse }, { thinking: "xhigh", reason: "复杂方案审查" }).thinking, "xhigh");
});

test("模型目录仅返回公开标识与支持级别，不返回认证字段或费用", async () => {
	let tool: any;
	installModelCatalog({ registerTool: (value: unknown) => { tool = value; } } as ExtensionAPI);
	const result = await tool.execute("catalog", {}, undefined, undefined, { modelRegistry: { getAvailable: () => [{ ...model, headers: { authorization: "fixture-private-marker" } }, light] } });
	assert.deepEqual(result.details.models.map((item: any) => Object.keys(item)), Array(2).fill(["provider", "id", "name", "thinking"]));
	assert.deepEqual(result.details.models[1].thinking, ["off"]);
	assert.doesNotMatch(JSON.stringify(result), /fixture-private-marker|authorization|cost|baseUrl/);
});
