import assert from "node:assert/strict";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { DeliveryPanel } from "../../extensions/delivery-gate/src/ui.ts";

export const plainTheme = { fg: (_color: string, text: string) => text } as Theme;

// SDK 父的模拟交互宿主：实际创建产品组件，并用键盘选择；不是用户批准证据。
export function approvalUI(select: ExtensionUIContext["select"]): ExtensionUIContext["custom"] {
	return (async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
		let done!: (value: unknown) => void;
		const result = new Promise((resolve) => { done = resolve; });
		const panel = await factory({ terminal: { rows: 32 }, requestRender() {} } as any, plainTheme, {} as any, done) as DeliveryPanel & { dispose?(): void };
		try {
			assert.equal(panel.choices[1], "暂不批准");
			panel.render(100);
			const choice = await select(panel.title, panel.choices);
			if (choice === panel.choices[0]) panel.handleInput("\x1b[A");
			panel.handleInput(choice === panel.choices[0] || choice === panel.choices[1] ? "\r" : "\x1b");
			return await result;
		} finally { panel.dispose?.(); }
	}) as ExtensionUIContext["custom"];
}
