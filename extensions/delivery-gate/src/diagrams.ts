import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { renderMermaidASCII, renderMermaidSVG } from "beautiful-mermaid";

export const DIAGRAM_ENTRY_CUSTOM_TYPE = "pi-adaptive-delivery.diagrams";
export const DIAGRAM_ENTRY_VERSION = 1 as const;

const MAX_DIAGRAMS_PER_MESSAGE = 6;
const MAX_SOURCE_BYTES = 20_000;
const MAX_SOURCE_LINES = 300;
const MAX_ASCII_CHARS = 30_000;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_PNG_WIDTH = 2_400;
const MAX_PNG_HEIGHT = 4_800;
const PNG_RASTER_SCALE = 3;
const PNG_CACHE_LIMIT = 64;

export const SUPPORTED_DIAGRAM_KINDS = [
	"flowchart",
	"sequence",
	"state",
	"class",
	"er",
	"xy",
] as const;

export type SupportedDiagramKind = (typeof SUPPORTED_DIAGRAM_KINDS)[number];
export type DiagramKind = SupportedDiagramKind | "unsupported";

export interface DiagramRecord {
	index: number;
	kind: DiagramKind;
	label: string;
	source: string;
	sourceDigest: string;
	ascii?: string;
	error?: string;
}

export interface DiagramEntryData {
	version: typeof DIAGRAM_ENTRY_VERSION;
	messageDigest: string;
	diagrams: DiagramRecord[];
	omitted: number;
}

export interface RenderedDiagramPng {
	base64: string;
	width: number;
	height: number;
	bytes: number;
}

interface DiagramPalette {
	bg: string;
	fg: string;
	line: string;
	accent: string;
	muted: string;
	surface: string;
	border: string;
}

const LIGHT_PALETTE: DiagramPalette = {
	bg: "#ffffff",
	fg: "#0f172a",
	line: "#475569",
	accent: "#0369a1",
	muted: "#334155",
	surface: "#f8fafc",
	border: "#64748b",
};

const DARK_PALETTE: DiagramPalette = {
	bg: "#111827",
	fg: "#f8fafc",
	line: "#cbd5e1",
	accent: "#22d3ee",
	muted: "#e2e8f0",
	surface: "#1f2937",
	border: "#94a3b8",
};

const KIND_LABELS: Readonly<Record<DiagramKind, string>> = {
	flowchart: "流程图",
	sequence: "时序图",
	state: "状态图",
	class: "类图",
	er: "ER 图",
	xy: "XY 图",
	unsupported: "不支持的图表",
};

const pngCache = new Map<string, RenderedDiagramPng>();
const require = createRequire(import.meta.url);
let resvgConstructor: typeof import("@resvg/resvg-js")["Resvg"] | undefined;

function loadResvg(): typeof import("@resvg/resvg-js")["Resvg"] {
	if (resvgConstructor) return resvgConstructor;
	try {
		resvgConstructor = (require("@resvg/resvg-js") as typeof import("@resvg/resvg-js")).Resvg;
		return resvgConstructor;
	} catch (error) {
		throw new Error(`当前平台无法加载 PNG 渲染器：${error instanceof Error ? error.message : String(error)}`);
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function firstSourceLine(source: string): string | undefined {
	return source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("%%"));
}

export function detectDiagramKind(source: string): SupportedDiagramKind | undefined {
	const first = firstSourceLine(source);
	if (!first) return undefined;
	if (/^(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b/i.test(first)) return "flowchart";
	if (/^sequenceDiagram\b/i.test(first)) return "sequence";
	if (/^stateDiagram(?:-v2)?\b/i.test(first)) return "state";
	if (/^classDiagram\b/i.test(first)) return "class";
	if (/^erDiagram\b/i.test(first)) return "er";
	if (/^xychart-beta\b/i.test(first)) return "xy";
	return undefined;
}

function validateSource(source: string): SupportedDiagramKind {
	if (!source.trim()) throw new Error("图表源码为空");
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw new Error("图表源码超过 20 KB 上限");
	if (source.split(/\r?\n/).length > MAX_SOURCE_LINES) throw new Error("图表源码超过 300 行上限");
	if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source)) {
		throw new Error("图表源码包含控制字符");
	}
	if (/^\s*%%\{/m.test(source)) throw new Error("图表不允许 Mermaid 初始化指令");
	const kind = detectDiagramKind(source);
	if (!kind) throw new Error("仅支持流程图、时序图、状态图、类图、ER 图和 XY 图");
	return kind;
}

function boundedAscii(value: string): string {
	return value.length <= MAX_ASCII_CHARS
		? value
		: `${value.slice(0, MAX_ASCII_CHARS)}\n[字符图已截断]`;
}

function boundedSource(value: string): string {
	const lineBounded = value.split(/\r?\n/).slice(0, MAX_SOURCE_LINES).join("\n");
	if (Buffer.byteLength(lineBounded, "utf8") <= MAX_SOURCE_BYTES) return lineBounded;
	return Buffer.from(lineBounded, "utf8").subarray(0, MAX_SOURCE_BYTES - 4).toString("utf8");
}

export function extractMermaidDiagrams(markdown: string): DiagramEntryData | undefined {
	const matches = [...markdown.matchAll(/```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
	if (matches.length === 0) return undefined;
	const diagrams: DiagramRecord[] = [];
	for (const [index, match] of matches.slice(0, MAX_DIAGRAMS_PER_MESSAGE).entries()) {
		const source = match[1]!.trim();
		try {
			const kind = validateSource(source);
			diagrams.push({
				index,
				kind,
				label: KIND_LABELS[kind],
				source,
				sourceDigest: sha256(source),
				ascii: boundedAscii(renderMermaidASCII(source, { colorMode: "none" })),
			});
		} catch (error) {
			const storedSource = boundedSource(source);
			diagrams.push({
				index,
				kind: "unsupported",
				label: KIND_LABELS.unsupported,
				source: storedSource,
				sourceDigest: sha256(storedSource),
				error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
			});
		}
	}
	return {
		version: DIAGRAM_ENTRY_VERSION,
		messageDigest: sha256(markdown),
		diagrams,
		omitted: Math.max(0, matches.length - diagrams.length),
	};
}

export function transformMermaidForDisplay(markdown: string): string {
	let index = 0;
	let transformed = markdown.replace(/```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```/gi, (_match, source: string) => {
		index += 1;
		const kind = detectDiagramKind(source) ?? "unsupported";
		return `> [${KIND_LABELS[kind]} ${index} 已在下方渲染；Mermaid 源码已保留]`;
	});
	const incomplete = /```mermaid[ \t]*\r?\n[\s\S]*$/i.exec(transformed);
	if (incomplete) {
		transformed = `${transformed.slice(0, incomplete.index)}> [图表生成中...]`;
	}
	return transformed;
}

function hexChannel(value: string, offset: number): number {
	return Number.parseInt(value.slice(offset, offset + 2), 16);
}

function mixHex(foreground: string, background: string, foregroundPercent: number): string {
	const weight = foregroundPercent / 100;
	const channel = (offset: number) => Math.round(
		hexChannel(foreground, offset) * weight + hexChannel(background, offset) * (1 - weight),
	).toString(16).padStart(2, "0");
	return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function replaceVariable(svg: string, name: string, value: string): string {
	return svg.split(`var(${name})`).join(value);
}

function flattenSvgColors(svg: string, palette: DiagramPalette): string {
	const variables: Record<string, string> = {
		"--bg": palette.bg,
		"--fg": palette.fg,
		"--line": palette.line,
		"--accent": palette.accent,
		"--muted": palette.muted,
		"--surface": palette.surface,
		"--border": palette.border,
		"--_text": palette.fg,
		"--_text-sec": palette.muted,
		"--_text-muted": palette.muted,
		"--_text-faint": mixHex(palette.fg, palette.bg, 25),
		"--_line": palette.line,
		"--_arrow": palette.accent,
		"--_node-fill": palette.surface,
		"--_node-stroke": palette.border,
		"--_group-fill": palette.bg,
		"--_group-hdr": mixHex(palette.fg, palette.bg, 8),
		"--_inner-stroke": mixHex(palette.fg, palette.bg, 14),
		"--_key-badge": mixHex(palette.fg, palette.bg, 12),
	};

	for (const match of svg.matchAll(/--xychart-color-(\d+):\s*([^;]+);/g)) {
		const name = `--xychart-color-${match[1]}`;
		const raw = match[2]!.trim();
		const color = raw.startsWith("var(--accent") ? palette.accent : /^#[a-f0-9]{6}$/i.test(raw) ? raw : palette.accent;
		variables[name] = color;
		variables[`--xychart-bar-fill-${match[1]}`] = mixHex(color, palette.bg, 25);
	}

	let result = svg.replace(/@import\s+url\([^;]+;\s*/gi, "");
	for (const [name, value] of Object.entries(variables).sort(([left], [right]) => right.length - left.length)) {
		result = replaceVariable(result, name, value);
	}
	result = result.replace(/--[a-z0-9_-]+\s*:[^;]+;/gi, "");
	if (/var\(|color-mix\(|@import/i.test(result)) throw new Error("SVG 仍包含不受支持的动态 CSS");
	if (/<(?:script|foreignObject)\b|\b(?:href|xlink:href)\s*=|url\(\s*["']?(?:https?:|data:|file:|\/\/)/i.test(result)) {
		throw new Error("SVG 包含外部或可执行资源");
	}
	return result.replace(
		/<svg\b/,
		'<svg shape-rendering="geometricPrecision" text-rendering="optimizeLegibility"',
	);
}

export function renderDiagramPng(source: string, lightTheme: boolean): RenderedDiagramPng {
	validateSource(source);
	const sourceDigest = sha256(source);
	const cacheKey = `${sourceDigest}:${lightTheme ? "light" : "dark"}`;
	const cached = pngCache.get(cacheKey);
	if (cached) return cached;
	const palette = lightTheme ? LIGHT_PALETTE : DARK_PALETTE;
	const Resvg = loadResvg();
	const svg = flattenSvgColors(renderMermaidSVG(source, {
		...palette,
		font: "sans-serif",
		padding: 16,
		nodeSpacing: 18,
		layerSpacing: 30,
		componentSpacing: 18,
	}), palette);
	const probe = new Resvg(svg, {
		background: palette.bg,
		font: { loadSystemFonts: true, defaultFontFamily: "sans-serif", sansSerifFamily: "sans-serif" },
		logLevel: "error",
	});
	if (probe.imagesToResolve().length > 0) throw new Error("图表包含外部图片资源");
	const scale = Math.min(PNG_RASTER_SCALE, MAX_PNG_WIDTH / probe.width, MAX_PNG_HEIGHT / probe.height);
	const renderer = scale !== 1
		? new Resvg(svg, {
				background: palette.bg,
				fitTo: { mode: "zoom", value: scale },
				font: { loadSystemFonts: true, defaultFontFamily: "sans-serif", sansSerifFamily: "sans-serif" },
				logLevel: "error",
			})
			: probe;
	const image = renderer.render();
	const pixels = image.pixels;
	const sampledColors = new Set<string>();
	const stride = Math.max(4, Math.floor(pixels.length / 4096 / 4) * 4);
	for (let offset = 0; offset + 3 < pixels.length && sampledColors.size < 8; offset += stride) {
		sampledColors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`);
	}
	if (sampledColors.size < 3) throw new Error("图表 PNG 像素内容为空或不可辨识");
	const png = image.asPng();
	if (png.length > MAX_PNG_BYTES) throw new Error("图表 PNG 超过 2 MB 上限");
	const rendered = { base64: png.toString("base64"), width: image.width, height: image.height, bytes: png.length };
	if (pngCache.size >= PNG_CACHE_LIMIT) pngCache.delete(pngCache.keys().next().value!);
	pngCache.set(cacheKey, rendered);
	return rendered;
}

export function parseDiagramEntryData(value: unknown): DiagramEntryData | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		input.version !== DIAGRAM_ENTRY_VERSION ||
		typeof input.messageDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.messageDigest) ||
		!Array.isArray(input.diagrams) ||
		input.diagrams.length === 0 ||
		input.diagrams.length > MAX_DIAGRAMS_PER_MESSAGE ||
		typeof input.omitted !== "number" ||
		!Number.isInteger(input.omitted) ||
		input.omitted < 0
	) return undefined;
	const diagrams: DiagramRecord[] = [];
	for (const [index, value] of input.diagrams.entries()) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (
			record.index !== index ||
			typeof record.kind !== "string" ||
			![...SUPPORTED_DIAGRAM_KINDS, "unsupported"].includes(record.kind as DiagramKind) ||
			typeof record.label !== "string" ||
			record.label !== KIND_LABELS[record.kind as DiagramKind] ||
			typeof record.source !== "string" ||
			Buffer.byteLength(record.source, "utf8") > MAX_SOURCE_BYTES ||
			record.source.split(/\r?\n/).length > MAX_SOURCE_LINES ||
			typeof record.sourceDigest !== "string" ||
			record.sourceDigest !== sha256(record.source) ||
			(record.ascii !== undefined && (typeof record.ascii !== "string" || record.ascii.length > MAX_ASCII_CHARS + 30)) ||
			(record.error !== undefined && (typeof record.error !== "string" || record.error.length > 1000))
		) return undefined;
		diagrams.push({
			index,
			kind: record.kind as DiagramKind,
			label: record.label,
			source: record.source,
			sourceDigest: record.sourceDigest,
			...(typeof record.ascii === "string" ? { ascii: record.ascii } : {}),
			...(typeof record.error === "string" ? { error: record.error } : {}),
		});
	}
	return { version: DIAGRAM_ENTRY_VERSION, messageDigest: input.messageDigest, diagrams, omitted: input.omitted };
}
