import assert from "node:assert/strict";
import test from "node:test";
import { deliveryStage, formatExecutionPaths, EXECUTION_PATH_ENTRY } from "../../extensions/delivery-gate/src/execution-path.ts";

const custom = (customType: string, data: unknown) => ({ type: "custom" as const, customType, data });
const assistant = (parts: unknown[]) => ({ type: "message" as const, message: { role: "assistant" as const, content: parts } });
const result = (toolCallId: string, toolName: string, text: string, isError = false) => ({ type: "message" as const,
	message: { role: "toolResult" as const, toolCallId, toolName, content: [{ type: "text" as const, text }], isError } });

test("执行路径投影区分父直改声明、委派结果和未声明普通工具", () => {
	const entries: any[] = [
		custom("delivery-activation", { enabled: true }),
		custom(EXECUTION_PATH_ENTRY, { id: "direct", path: "parent_direct", phase: "declared", node: "局部配置迁移", reason: "范围清楚", independentReview: true }),
		assistant([{ type: "toolCall", id: "dev", name: "delivery_develop", arguments: { task: "跨文件实现 Worker 健康检查" } }]),
		custom("delivery-development", { id: "dev", childSessionFile: "/tmp/dev.jsonl" }),
		result("dev", "delivery_develop", "开发执行已结束；检查结论由父 Pi 核对"),
		assistant([{ type: "toolCall", id: "review", name: "delivery_review", arguments: { task: "独立检查 Worker 健康检查" } }]),
		result("review", "delivery_review", "Provider stream error", true),
	];
	const text = formatExecutionPaths(entries, []);
	assert.match(text, /parent_direct.*局部配置迁移/);
	assert.match(text, /delivery_develop.*跨文件实现 Worker 健康检查.*已返回/);
	assert.match(text, /原始子 Session：\/tmp\/dev\.jsonl/);
	assert.match(text, /delivery_review.*未形成有效结果/);
	assert.match(text, /父侧普通检查见原生工具结果/);
	const undeclared = formatExecutionPaths([custom("delivery-activation", { enabled: true }), assistant([{ type: "toolCall", id: "ordinary", name: "edit", arguments: { path: "src/a.ts" } }])] as any, []);
	assert.match(undeclared, /父侧直接实施路径：未声明/);
});

test("状态阶段把交付启用和实际运行分开", () => {
	assert.equal(deliveryStage(false, false, false), "等待方案确认");
	assert.equal(deliveryStage(true, true, false), "实施进行中（父 Pi 回合运行中）");
	assert.equal(deliveryStage(true, false, true), "交付已启用，仍有排队消息");
	assert.equal(deliveryStage(true, false, false), "交付已启用，当前无在途任务");
});
