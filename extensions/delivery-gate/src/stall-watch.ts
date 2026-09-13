import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD_MS = 120_000;
const DEFAULT_TICK_MS = 5_000;
const MAX_RECOVERIES = 2;

export interface StallWatchOptions {
	thresholdMs?: number;
	tickMs?: number;
	now?: () => number;
	send?: (pi: ExtensionAPI) => void;
}

// 只观测公开消息事件：仅在 assistant 正在流式输出时计时，工具执行期间计时器停止，
// 因此长时间运行的命令不会被误判为停顿。停顿判定基于“内容增量间隔”，不依赖字节级
// 空闲超时，也不依赖 provider 的传输实现。
export function installStallWatch(pi: ExtensionAPI, options: StallWatchOptions = {}): void {
	const thresholdMs = options.thresholdMs ?? Number(process.env.PI_ADAPTIVE_STALL_MS ?? DEFAULT_THRESHOLD_MS);
	const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
	const now = options.now ?? (() => Date.now());
	if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return;

	let streaming = false;
	let lastProgress = 0;
	let recoveries = 0;
	let resumePending = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const notify = (ctx: ExtensionContext, text: string) => {
		try { ctx.ui.notify(text, "warning"); } catch { /* 非 TUI 或界面不可用时不阻塞执行 */ }
	};
	const stop = () => {
		streaming = false;
		if (timer) { clearInterval(timer); timer = undefined; }
	};
	const check = (ctx: ExtensionContext) => {
		if (!streaming || now() - lastProgress < thresholdMs) return;
		if (recoveries >= MAX_RECOVERIES) {
			stop();
			notify(ctx, `模型请求已停顿超过 ${Math.round(thresholdMs / 1000)} 秒，且已达到自动恢复上限 ${MAX_RECOVERIES} 次，未再重试；请手动重试或检查网络。`);
			return;
		}
		recoveries += 1;
		stop();
		resumePending = true;
		notify(ctx, `模型请求已停顿超过 ${Math.round(thresholdMs / 1000)} 秒：已中断本次请求并自动继续（第 ${recoveries}/${MAX_RECOVERIES} 次）。`);
		try { ctx.abort(); }
		catch (error) {
			resumePending = false;
			notify(ctx, `中断停顿请求失败：${error instanceof Error ? error.message : String(error)}`);
		}
	};

	pi.on("message_start", (event, ctx) => {
		if ((event.message as { role?: string }).role !== "assistant") return;
		streaming = true;
		lastProgress = now();
		timer ??= setInterval(() => check(ctx), tickMs);
	});
	pi.on("message_update", () => { lastProgress = now(); });
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string };
		if (message.role !== "assistant") return;
		// 只有真正产出了完整回复（非 aborted/error）才算进展，避免“停顿→重试→再停顿”无限循环。
		if (message.stopReason !== "aborted" && message.stopReason !== "error") recoveries = 0;
		stop();
	});
	// 等本次（被中断的）回合真正收尾后再续跑，排队消息不会丢。
	pi.on("agent_settled", () => {
		if (!resumePending) return;
		resumePending = false;
		if (options.send) { options.send(pi); return; }
		pi.sendMessage({ customType: "delivery-stall-resume", display: false,
			content: `上一次模型请求因长时间没有响应已被中断。请从中断处继续当前任务：不要重复已经完成的工具调用或写入，先核对现场再继续。` },
			{ deliverAs: "followUp", triggerTurn: true });
	});
	pi.on("session_shutdown", () => { stop(); resumePending = false; });
}
