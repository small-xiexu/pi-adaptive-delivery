import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi 0.85.1 未将该错误识别为可重试；只补充说明，调度与取消仍由原生流程负责。
export function installStreamRetry(pi: ExtensionAPI): void {
	pi.on("message_end", ({ message }) => {
		if (message.role !== "assistant" || message.stopReason !== "error" || message.errorMessage !== "stream_read_error") return;
		return { message: { ...message,
			errorMessage: `${message.errorMessage}\n模型响应流读取中断，可重试本次请求（you can retry your request）；由 Pi 原生重试设置控制。`,
		} };
	});
}
