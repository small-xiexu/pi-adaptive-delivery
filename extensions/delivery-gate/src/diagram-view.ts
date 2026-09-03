import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text, getCapabilities, type Component } from "@earendil-works/pi-tui";

import {
	parseDiagramEntryData,
	renderDiagramPng,
	type DiagramEntryData,
	type DiagramRecord,
} from "./diagrams.ts";

// Image clamps width to the current viewport first; these only retain a bounded transcript-height guard.
const FULL_VIEWPORT_WIDTH_CELLS = 10_000;
const MAX_SCROLLABLE_HEIGHT_CELLS = 1_000;

function fallbackText(diagram: DiagramRecord, error?: string, expanded = false): string {
	const source = diagram.ascii || diagram.source;
	const limit = expanded ? 30_000 : 12_000;
	const visible = source.length <= limit ? source : `${source.slice(0, limit)}\n[显示已截断]`;
	return [
		error ? `无法显示图片：${error}` : diagram.error ? `无法渲染：${diagram.error}` : undefined,
		visible,
	].filter((value): value is string => Boolean(value)).join("\n\n");
}

function xtermColor(index: number): [number, number, number] | undefined {
	const base: Array<[number, number, number]> = [
		[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
		[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
		[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
		[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
	];
	if (index >= 0 && index < base.length) return base[index];
	if (index >= 16 && index <= 231) {
		const value = index - 16;
		const levels = [0, 95, 135, 175, 215, 255];
		return [levels[Math.floor(value / 36)]!, levels[Math.floor(value / 6) % 6]!, levels[value % 6]!];
	}
	if (index >= 232 && index <= 255) {
		const gray = 8 + (index - 232) * 10;
		return [gray, gray, gray];
	}
	return undefined;
}

function themeIsLight(theme: Theme): boolean {
	const ansi = theme.getFgAnsi("text");
	const trueColor = /38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
	const indexed = /38;5;(\d+)m/.exec(ansi);
	const rgb = trueColor
		? trueColor.slice(1, 4).map(Number) as [number, number, number]
		: indexed ? xtermColor(Number(indexed[1])) : undefined;
	if (rgb) {
		const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
		return luminance < 128;
	}
	return /(?:light|day|paper)/i.test(theme.name ?? "");
}

export function renderDiagramEntry(
	value: unknown,
	expanded: boolean,
	theme: Theme,
	imagesSupported = Boolean(getCapabilities().images),
): Component {
	const data = parseDiagramEntryData(value);
	if (!data) return new Text(theme.fg("error", "图表记录无效，已拒绝显示。"), 1, 0);
	const container = new Container();
	for (const [index, diagram] of data.diagrams.entries()) {
		if (index > 0) container.addChild(new Text("", 0, 0));
		container.addChild(new Text(
			`${theme.fg("accent", theme.bold(`[${diagram.label}]`))} ${index + 1}/${data.diagrams.length}`,
			1,
			0,
		));
		if (diagram.error || !diagram.ascii) {
			container.addChild(new Text(theme.fg("warning", fallbackText(diagram, undefined, expanded)), 1, 0));
			continue;
		}
		if (!imagesSupported) {
			container.addChild(new Text(theme.fg("toolOutput", fallbackText(diagram, undefined, expanded)), 1, 0));
			continue;
		}
		try {
			const rendered = renderDiagramPng(diagram.source, themeIsLight(theme));
			container.addChild(new Image(
				rendered.base64,
				"image/png",
				{ fallbackColor: (text) => theme.fg("muted", text) },
				{
					maxWidthCells: FULL_VIEWPORT_WIDTH_CELLS,
					maxHeightCells: MAX_SCROLLABLE_HEIGHT_CELLS,
					filename: `${diagram.kind}-${diagram.sourceDigest.slice(0, 12)}.png`,
				},
				{ widthPx: rendered.width, heightPx: rendered.height },
			));
		} catch (error) {
			container.addChild(new Text(
				theme.fg("warning", fallbackText(diagram, error instanceof Error ? error.message : String(error), expanded)),
				1,
				0,
			));
		}
		if (expanded) {
			container.addChild(new Text(theme.fg("dim", `Mermaid SHA-256: ${diagram.sourceDigest}`), 1, 0));
		}
	}
	if (data.omitted > 0) {
		container.addChild(new Text(theme.fg("warning", `另有 ${data.omitted} 张图超过单条消息显示上限，源码仍保留。`), 1, 0));
	}
	return container;
}

export type { DiagramEntryData };
