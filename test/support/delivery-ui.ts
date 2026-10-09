import assert from "node:assert/strict";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { DesignReviewPanel, DeliveryPanel } from "../../extensions/delivery-gate/src/ui.ts";

export const plainTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

// SDK 父的模拟交互宿主：实际创建产品组件，并用键盘选择；不是用户批准证据。
// rows 默认 32（历史上的最小验收尺寸）；关注“首屏能否看到正文”的用例可传全屏尺寸。
export function approvalUI(select: ExtensionUIContext["select"], feedback?: () => string | undefined, rows = 32,
	onPanel?: (panel: DeliveryPanel | DesignReviewPanel) => void): ExtensionUIContext["custom"] {
	return (async (factory: Parameters<ExtensionUIContext["custom"]>[0], options?: Parameters<ExtensionUIContext["custom"]>[1]) => {
		assert.notEqual(options?.overlay, true, "审批应使用原生底部输入区，不能覆盖主对话");
		let done!: (value: unknown) => void;
		const result = new Promise((resolve) => { done = resolve; });
		const panel = await factory({ terminal: { rows }, requestRender() {} } as any, plainTheme, {} as any, done) as (DeliveryPanel | DesignReviewPanel) & { dispose?(): void };
		try {
			const review = panel.title === "方案审阅", status = panel.title === "交付状态";
			if (status) assert.equal(panel.choices[0], "关闭");
			else assert.equal(panel.choices.at(-1), review ? "稍后再看" : panel.title === "解除上次任务的占用" ? "暂不处理" : "暂不批准");
			panel.render(100);
			onPanel?.(panel);
			const text = review ? feedback?.() : undefined;
			if (text !== undefined) {
				panel.handleInput("\x1b[A");
				panel.handleInput("\r");
				panel.handleInput(`\x1b[200~${text}\x1b[201~`);
				panel.handleInput("\r");
				return await result;
			}
			const choice = await select(panel.title, panel.choices);
			const index = choice === undefined ? -1 : panel.choices.indexOf(choice);
			if (index < 0) panel.handleInput("\x1b");
			else {
				const delta = index - (status ? 0 : panel.choices.length - 1);
				for (let i = 0; i < Math.abs(delta); i++) panel.handleInput(delta < 0 ? "\x1b[A" : "\x1b[B");
				panel.handleInput("\r");
			}
			return await result;
		} finally { panel.dispose?.(); }
	}) as ExtensionUIContext["custom"];
}
