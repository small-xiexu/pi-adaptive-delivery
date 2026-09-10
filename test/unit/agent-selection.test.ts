import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { agentSelection, selectChildAgent } from "../../extensions/delivery-gate/src/agent-selection.ts";

const model: Model<Api> = { provider: "fixture", id: "reasoner", name: "测试推理模型", api: "openai-completions", baseUrl: "http://127.0.0.1",
	reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 };
const light: Model<Api> = { ...model, provider: "other-fixture", id: "light", reasoning: false };
const ctx: Pick<ExtensionContext, "model"> = { model };
const pi = { getThinkingLevel: () => "high" as const };

test("固定继承父模型，只覆盖子推理级别且不改变父状态", () => {
	assert.deepEqual(selectChildAgent(pi, ctx), { model, thinking: "high", selectionReason: "继承父会话" });
	assert.deepEqual(selectChildAgent(pi, ctx, { thinking: "medium", reason: "边界明确的局部实现" }), { model, thinking: "medium", selectionReason: "边界明确的局部实现" });
	assert.equal(ctx.model, model); assert.equal(pi.getThinkingLevel(), "high");
});

test("父切换 Provider 和模型后新任务跟随，已经选定的任务保持原模型", () => {
	const parent = { model };
	const running = selectChildAgent(pi, parent);
	parent.model = light;
	const next = selectChildAgent({ getThinkingLevel: () => "off" }, parent);
	assert.deepEqual(next, { model: light, thinking: "off", selectionReason: "继承父会话" });
	assert.equal(running.model, model);
	assert.equal(running.thinking, "high");
});

test("缺少父模型、不支持的级别和空白理由均拒绝，不静默降级", () => {
	assert.throws(() => selectChildAgent(pi, { model: undefined }), /父会话模型尚未确定/);
	assert.throws(() => selectChildAgent(pi, { model: light }), /不支持 high/);
	assert.throws(() => selectChildAgent(pi, ctx, { thinking: "xhigh", reason: "模型没有扩展级别" }), /不支持 xhigh/);
	assert.throws(() => selectChildAgent(pi, ctx, { thinking: "medium", reason: " " }), /不能为空白/);
	const sparse = { ...model, thinkingLevelMap: { low: null, xhigh: "xhigh" } };
	assert.throws(() => selectChildAgent(pi, { ...ctx, model: sparse }, { thinking: "low", reason: "不支持的空档位" }), /不支持 low/);
	assert.equal(selectChildAgent(pi, { ...ctx, model: sparse }, { thinking: "xhigh", reason: "复杂方案审查" }).thinking, "xhigh");
});

test("子任务参数只接受推理级别与理由，拒绝单独指定模型", () => {
	assert.equal(Value.Check(agentSelection, { thinking: "medium", reason: "局部实现" }), true);
	assert.equal(Value.Check(agentSelection, { reason: "继承父级别" }), true);
	assert.equal(Value.Check(agentSelection, { thinking: "medium" }), false);
	assert.equal(Value.Check(agentSelection, { model: { provider: light.provider, id: light.id }, thinking: "off", reason: "不能另选模型" }), false);
});
