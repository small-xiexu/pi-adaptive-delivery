import assert from "node:assert/strict";
import test from "node:test";

import { renderMermaidSVG } from "beautiful-mermaid";

import {
	DIAGRAM_ENTRY_VERSION,
	detectDiagramKind,
	extractMermaidDiagrams,
	parseDiagramEntryData,
	renderDiagramPng,
	transformMermaidForDisplay,
} from "../../extensions/delivery-gate/src/diagrams.ts";

const DIAGRAMS = {
	flowchart: "flowchart LR\n  A[提出需求] --> B[生成方案]",
	sequence: "sequenceDiagram\n  actor U as 用户\n  participant P as 父 Pi\n  U->>P: 提出需求\n  P-->>U: 技术方案",
	state: "stateDiagram-v2\n  [*] --> 空闲\n  空闲 --> 方案梳理: 开始",
	class: "classDiagram\n  ParentPi --> DeliveryGate",
	er: "erDiagram\n  SESSION ||--o{ APPROVAL : contains",
	xy: "xychart-beta\n  x-axis [Unit, Integration, E2E]\n  bar [84, 58, 3]",
} as const;

test("detects and extracts the six supported Mermaid diagram kinds", () => {
	const markdown = Object.values(DIAGRAMS).map((source) => `\`\`\`mermaid\n${source}\n\`\`\``).join("\n\n");
	const entry = extractMermaidDiagrams(markdown);
	assert.ok(entry);
	assert.equal(entry.version, DIAGRAM_ENTRY_VERSION);
	assert.deepEqual(entry.diagrams.map((diagram) => diagram.kind), Object.keys(DIAGRAMS));
	assert.equal(entry.diagrams.every((diagram) => Boolean(diagram.ascii) && !diagram.error), true);
	assert.deepEqual(parseDiagramEntryData(entry), entry);
});

test("renders Chinese sequence diagrams to bounded nonblank light and dark PNGs", () => {
	for (const lightTheme of [false, true]) {
		const rendered = renderDiagramPng(DIAGRAMS.sequence, lightTheme);
		const svg = renderMermaidSVG(DIAGRAMS.sequence, { padding: 16 });
		const dimensions = /<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/.exec(svg);
		assert.ok(dimensions);
		assert.equal(Buffer.from(rendered.base64, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
		assert.equal(rendered.width >= Math.floor(Number(dimensions[1]) * 2.9), true);
		assert.equal(rendered.height >= Math.floor(Number(dimensions[2]) * 2.9), true);
		assert.equal(rendered.bytes > 1000 && rendered.bytes < 2 * 1024 * 1024, true);
	}
});

test("renders every supported diagram kind to a bounded PNG", () => {
	for (const [kind, source] of Object.entries(DIAGRAMS)) {
		const rendered = renderDiagramPng(source, false);
		assert.equal(Buffer.from(rendered.base64, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a", kind);
		assert.equal(rendered.width > 20 && rendered.height > 20, true, kind);
		assert.equal(rendered.bytes > 500 && rendered.bytes < 2 * 1024 * 1024, true, kind);
	}
});

test("replaces complete and streaming Mermaid fences only for display", () => {
	const complete = `说明\n\n\`\`\`mermaid\n${DIAGRAMS.flowchart}\n\`\`\`\n\n结束`;
	const transformed = transformMermaidForDisplay(complete);
	assert.doesNotMatch(transformed, /flowchart LR/);
	assert.match(transformed, /流程图 1 已在下方渲染/);
	assert.match(transformed, /说明/);
	assert.match(transformed, /结束/);
	assert.equal(extractMermaidDiagrams(complete)?.diagrams[0]?.source, DIAGRAMS.flowchart);

	const streaming = `说明\n\n\`\`\`mermaid\nflowchart LR\n A -->`;
	assert.equal(transformMermaidForDisplay(streaming), "说明\n\n> [图表生成中...]");
});

test("fails closed for unsupported, initialized, oversized, and malformed entry data", () => {
	for (const source of [
		"gantt\n  title Roadmap",
		"%%{init: {\"theme\": \"dark\"}}%%\nflowchart LR\n A --> B",
		`flowchart LR\n A[${"x".repeat(21_000)}] --> B`,
		`flowchart TD\n${Array.from({ length: 301 }, (_, index) => `  N${index} --> N${index + 1}`).join("\n")}`,
	]) {
		const entry = extractMermaidDiagrams(`\`\`\`mermaid\n${source}\n\`\`\``);
		assert.equal(entry?.diagrams[0]?.kind, "unsupported");
		assert.ok(entry?.diagrams[0]?.error);
		assert.ok(entry && parseDiagramEntryData(entry));
	}
	assert.equal(detectDiagramKind("pie\n title Unsupported"), undefined);
	const valid = extractMermaidDiagrams(`\`\`\`mermaid\n${DIAGRAMS.flowchart}\n\`\`\``)!;
	assert.equal(parseDiagramEntryData({ ...valid, messageDigest: "bad" }), undefined);
	assert.equal(parseDiagramEntryData({
		...valid,
		diagrams: [{ ...valid.diagrams[0], source: "flowchart LR\n A --> changed" }],
	}), undefined);
});
