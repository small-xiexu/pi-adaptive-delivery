import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, SelectList, Text, truncateToWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

export const displayText = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export type DesignReviewResult = { feedback: string } | "确认方案" | undefined;

// 先阅读并选择操作，需要修改时再输入意见；发送意见不等于批准。
export class DesignReviewPanel {
	readonly title = "方案审阅";
	readonly choices = ["确认方案", "提出修改意见", "稍后再看"];
	private readonly editor: Editor;
	private readonly select: SelectList;
	private editing = false;
	private hasFocus = false;
	private expanded = false;
	private offset = 0;
	private pageSize = 1;
	private total = 0;
	private fits = true;
	private editorRow = 0;
	private editorHeight = 0;
	private optionsRow = 0;
	constructor(readonly body: string, readonly detail: string, private readonly tui: TUI,
		private readonly theme: Theme, private readonly done: (result: DesignReviewResult) => void, readonly notice = "") {
		const selectTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text), selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text), scrollInfo: (text: string) => text, noMatch: (text: string) => text,
		};
		this.editor = new Editor(tui, { borderColor: (text) => theme.fg(this.editing ? "accent" : "border", text), selectList: selectTheme });
		this.editor.onSubmit = (text) => this.submitFeedback(text);
		this.select = new SelectList(this.choices.map((label) => ({ value: label, label })), this.choices.length, selectTheme);
		this.select.setSelectedIndex(2);
		this.select.onSelect = ({ value }) => {
			if (value === "提出修改意见") { this.editing = true; this.focused = this.hasFocus; this.tui.requestRender(); }
			else this.done(value === "确认方案" ? value : undefined);
		};
	}
	get focused() { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.editor.focused = value && this.editing; }
	invalidate() { this.editor.invalidate(); }
	private submitFeedback(text: string) {
		if (text.trim()) this.done({ feedback: text.trim() });
		else { this.editing = true; this.focused = this.hasFocus; this.tui.requestRender(); }
	}
	private scroll(delta: number) {
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.pageSize), this.offset + delta));
	}
	handleInput(data: string) {
		if (!this.fits) { if (matchesKey(data, "escape")) this.done(undefined); return; }
		if (matchesKey(data, "escape")) {
			if (!this.editing) { this.done(undefined); return; }
			this.editing = false; this.focused = this.hasFocus;
		}
		else if (matchesKey(data, "ctrl+o")) { this.expanded = !this.expanded; this.offset = 0; }
		else if (matchesKey(data, "pageUp")) this.scroll(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.scroll(this.pageSize);
		else if (this.editing) this.editor.handleInput(data);
		else if (matchesKey(data, "home")) this.scroll(-this.total);
		else if (matchesKey(data, "end")) this.scroll(this.total);
		else this.select.handleInput(data);
		this.tui.requestRender();
	}
	handleMouse(event: TuiMouseEvent) {
		if (!this.fits) return { handled: true };
		if (event.type === "wheel" && (!this.editing || event.y < this.editorRow)) this.scroll(event.wheelDelta ?? 0);
		else if (!this.editing && event.y >= this.optionsRow && event.y < this.optionsRow + this.choices.length) {
			this.select.handleMouse({ ...event, y: event.y - this.optionsRow, height: this.choices.length });
		} else if (this.editing && event.y >= this.editorRow && event.y < this.editorRow + this.editorHeight) {
			this.editor.handleMouse({ ...event, y: event.y - this.editorRow, height: this.editorHeight });
		}
		this.tui.requestRender();
		return { handled: true };
	}
	render(width: number) {
		const body = new Text(displayText(this.expanded ? this.detail : this.body), 0, 0).render(width);
		const editor = this.editing ? this.editor.render(width) : [];
		const options = this.editing ? [] : this.select.render(width);
		const notice = this.notice && !this.editing ? new Text(displayText(this.notice), 0, 0).render(width) : [];
		const footer = new Text(`${this.editing ? "Enter 发送意见 · Shift+Enter 换行 · Esc 返回方案" : "↑↓ 选择 · Enter 确定 · Esc 稍后再看"}\nCtrl+O ${this.expanded ? "返回正文" : "查看详情"} · PgUp/PgDn 翻页`, 0, 0).render(width);
		const reserved = editor.length + options.length + notice.length + footer.length + (this.editing ? 3 : 2);
		this.fits = reserved + 1 < this.tui.terminal.rows;
		if (!this.fits) return [truncateToWidth("请放大终端 · Esc 稍后再看", width)];
		this.pageSize = Math.max(1, Math.min(body.length,
			Math.floor(this.tui.terminal.rows * 0.7) - reserved));
		this.total = body.length;
		this.scroll(0);
		const position = body.length > this.pageSize ? `${this.offset + 1}–${Math.min(body.length, this.offset + this.pageSize)} / ${body.length} 行` : "";
		const lines = [truncateToWidth(this.theme.fg("accent", `─ ${this.title} `) + this.theme.fg("border", "─".repeat(width)), width, ""),
			...body.slice(this.offset, this.offset + this.pageSize), this.theme.fg("muted", position),
			...notice.map((line) => this.theme.fg("muted", line))].map((line) => truncateToWidth(line, width, ""));
		if (this.editing) lines.push(this.theme.fg("accent", "你希望怎么改？"));
		this.editorRow = lines.length;
		this.editorHeight = editor.length;
		lines.push(...editor);
		this.optionsRow = lines.length;
		return [...lines, ...options, ...footer.map((line) => this.theme.fg("muted", line))];
	}
}

// 交付对话框：正文滚动，操作始终留在底部；只管理展示焦点。
export class DeliveryPanel {
	private offset = 0;
	private pageSize = 1;
	private total = 0;
	private fits = true;
	private optionsRow = 0;
	private expanded = false;
	private readonly select?: SelectList;
	constructor(readonly title: string, public body: string, readonly detail: string,
		readonly choices: string[], private readonly tui: TUI, private readonly theme: Theme,
		private readonly done: (choice: string | undefined) => void, initialIndex = 0, readonly notice = "") {
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
		if (!this.fits) { if (matchesKey(data, "escape")) this.done(undefined); return; }
		if (matchesKey(data, "escape")) { this.done(undefined); return; }
		if (this.detail && matchesKey(data, "ctrl+o")) { this.expanded = !this.expanded; this.offset = 0; }
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
		if (!this.fits) return { handled: true };
		if (event.type === "wheel") { this.scroll(event.wheelDelta ?? 0); return { handled: true }; }
		if (this.select && event.y >= this.optionsRow && event.y < this.optionsRow + this.choices.length) {
			return this.select.handleMouse({ ...event, y: event.y - this.optionsRow, height: this.choices.length });
		}
		return { handled: true };
	}
	render(width: number) {
		const body = new Text(displayText(this.expanded ? this.detail : this.body), 0, 0).render(width);
		const footer = new Text(this.detail ? `↑↓ 选择 · Enter 确定 · Esc 取消\nCtrl+O ${this.expanded ? "返回正文" : "查看详情"} · PgUp/PgDn 翻页`
			: "↑↓ / PgUp/PgDn 滚动 · Home/End 首尾 · Esc 关闭", 0, 0).render(width);
		const options = this.select?.render(width) ?? [];
		const notice = this.notice ? new Text(displayText(this.notice), 0, 0).render(width) : [];
		const reserved = footer.length + options.length + notice.length + 2;
		this.fits = reserved + 1 < this.tui.terminal.rows;
		if (!this.fits) return [truncateToWidth("请放大终端 · Esc 取消", width)];
		this.pageSize = Math.max(1, Math.min(body.length,
			Math.floor(this.tui.terminal.rows * 0.7) - reserved));
		this.total = body.length;
		this.offset = Math.min(this.offset, Math.max(0, body.length - this.pageSize));
		const page = body.slice(this.offset, this.offset + this.pageSize);
		while (page.length < this.pageSize) page.push("");
		const position = body.length > this.pageSize ? `${this.offset + 1}–${Math.min(body.length, this.offset + this.pageSize)} / ${body.length} 行 · 可滚动查看` : "";
		const lines = [truncateToWidth(this.theme.fg("accent", `─ ${displayText(this.title)} `) + this.theme.fg("border", "─".repeat(width)), width, ""), ...page,
			truncateToWidth(this.theme.fg("muted", position), width), ...notice.map((line) => this.theme.fg("muted", line))];
		this.optionsRow = lines.length;
		return [...lines, ...options, ...footer.map((line) => this.theme.fg("muted", line))];
	}
}
