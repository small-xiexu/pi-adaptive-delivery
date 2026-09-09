import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { installStreamRetry } from "../../extensions/delivery-gate/src/stream-retry.ts";

function handler() {
	let callback!: (event: MessageEndEvent) => { message?: MessageEndEvent["message"] } | undefined;
	installStreamRetry({ on(event: string, fn: typeof callback) { assert.equal(event, "message_end"); callback = fn; } } as ExtensionAPI);
	return (message: any) => callback({ type: "message_end", message })?.message;
}

test("断流消息保留原始内容与错误，只补充原生可识别说明，重复处理不叠加", () => {
	const transform = handler();
	const message: any = { role: "assistant", stopReason: "error", errorMessage: "stream_read_error", timestamp: 1,
		content: [{ type: "text", text: "半截正文" }, { type: "toolCall", id: "partial", name: "write", arguments: { path: "x" } }],
		usage: { input: 123 }, provider: "fake" };
	const before = structuredClone(message);
	assert.equal(isRetryableAssistantError(message), false, "固定开发版本的原生漏匹配复现");
	const result = transform(message);
	assert.ok(result?.role === "assistant");
	assert.equal(isRetryableAssistantError(result), true);
	assert.match(result.errorMessage!, /^stream_read_error\n/);
	assert.deepEqual({ ...result, errorMessage: message.errorMessage }, before);
	assert.deepEqual(message, before);
	assert.equal(transform(result), undefined);
});

test("非目标错误、主动取消、成功文本和工具失败不触发断流补充", () => {
	const transform = handler();
	for (const message of [
		{ role: "assistant", stopReason: "aborted", errorMessage: "stream_read_error" },
		{ role: "assistant", stopReason: "stop", errorMessage: "stream_read_error" },
		{ role: "assistant", stopReason: "error", errorMessage: "invalid_api_key" },
		{ role: "assistant", stopReason: "error", errorMessage: "billing stream_read_error" },
		{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" },
		{ role: "assistant", stopReason: "error" },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stream_read_error" }] },
		{ role: "toolResult", isError: true, content: [{ type: "text", text: "stream_read_error" }] },
		{ role: "user", content: "stream_read_error" },
	]) assert.equal(transform(message), undefined);
});
