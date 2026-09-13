import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

// 哨兵：包不自己实现重试，依赖 Pi 把“空闲超时”判为可重试。
// Pi 通过 undici 的 bodyTimeout/headersTimeout 实现 httpIdleTimeoutMs（监控两次 body 数据之间的时间），
// 停顿触发后抛出的错误文本必须落在 Pi 的可重试词表内，否则本包无从依赖该机制。
// 实测：bodyTimeout=3000 对“只发响应头后沉默”的响应在约 3.5 秒后失败，message 为 "terminated"。
test("Pi 把空闲超时类错误判为可重试，普通 abort 不重试", () => {
	const retryable = ["Body Timeout Error", "Headers Timeout Error", "UND_ERR_BODY_TIMEOUT", "The operation was aborted due to timeout", "terminated", "socket hang up", "fetch failed", "server_error", "503 Service Unavailable"];
	for (const errorMessage of retryable) {
		assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage } as never), true, `应可重试：${errorMessage}`);
	}
	// 用户主动取消不是超时，不得被当成可重试。
	assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: "This operation was aborted" } as never), false);
	assert.equal(isRetryableAssistantError({ stopReason: "stop", errorMessage: "Body Timeout Error" } as never), false);
});
