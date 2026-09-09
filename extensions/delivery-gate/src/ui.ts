import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, Text, truncateToWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

export const displayText = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

// 交付对话框：正文滚动，操作始终留在底部；只管理展示焦点。
export class DeliveryPanel {
	private offset = 0;
	private pageSize = 1;
	private total = 0;
	private optionsRow = 0;
	private expanded = false;
	private readonly select?: SelectList;
	constructor(readonly title: string, public body: string, readonly detail: string,
		readonly choices: string[], private readonly tui: TUI, private readonly theme: Theme,
		private readonly done: (choice: string | undefined) => void, initialIndex = 0) {
		if (choices.length) {
			this.select = new SelectList(choices.map((label) => ({ value: label, label })), choices.length, {
				selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text), scrollInfo: (text) => text, noMatch: (text) => text,
			});
			this.select.setSelectedIndex(initialIndex);
			this.select.onSelect = (item) => done(item.value);
			this.select.onCancel = () => done(undefined);
		}
	}
	invalidate() {}
	private scroll(delta: number) {
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.pageSize), this.offset + delta));
		this.tui.requestRender();
	}
	handleInput(data: string) {
		if (matchesKey(data, "escape")) { this.done(undefined); return; }
		if (this.detail && matchesKey(data, "tab")) { this.expanded = !this.expanded; this.offset = 0; }
		else if (matchesKey(data, "pageUp")) this.scroll(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.scroll(this.pageSize);
		else if (matchesKey(data, "home")) this.scroll(-this.total);
		else if (matchesKey(data, "end")) this.scroll(this.total);
		else if (this.select) this.select.handleInput(data);
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		this.tui.requestRender();
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type === "wheel") { this.scroll(event.wheelDelta ?? 0); return { handled: true }; }
		if (this.select && event.y >= this.optionsRow && event.y < this.optionsRow + this.choices.length) {
			return this.select.handleMouse({ ...event, y: event.y - this.optionsRow, height: this.choices.length });
		}
		return { handled: true };
	}
	render(width: number) {
		const body = new Text(displayText(this.expanded ? this.detail : this.body), 0, 0).render(width);
		const footer = new Text(this.detail ? `Tab ${this.expanded ? "返回摘要" : "完整内容"} · PgUp/PgDn 滚动 · ↑↓ 选择 · Enter 确认 · Esc 返回`
			: "↑↓ / PgUp/PgDn 滚动 · Home/End 首尾 · Esc 关闭", 0, 0).render(width);
		const options = this.select?.render(width) ?? [];
		this.pageSize = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85) - footer.length - options.length - 3);
		this.total = body.length;
		this.offset = Math.min(this.offset, Math.max(0, body.length - this.pageSize));
		const page = body.slice(this.offset, this.offset + this.pageSize);
		while (page.length < this.pageSize) page.push("");
		const position = `${this.offset + 1}–${Math.min(body.length, this.offset + this.pageSize)} / ${body.length} 行`;
		const lines = [truncateToWidth(this.theme.fg("accent", displayText(this.title)), width), ...page,
			truncateToWidth(this.theme.fg("muted", position), width)];
		this.optionsRow = lines.length;
		return [...lines, ...options, ...footer.map((line) => this.theme.fg("muted", line))];
	}
}
