import assert from "node:assert/strict";
import test from "node:test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";

import { renderDiagramEntry } from "../../extensions/delivery-gate/src/diagram-view.ts";
import { extractMermaidDiagrams } from "../../extensions/delivery-gate/src/diagrams.ts";

function theme(name: string): Theme {
	const foreground = {
		accent: "#22d3ee", border: "#64748b", borderAccent: "#22d3ee", borderMuted: "#475569",
		success: "#22c55e", error: "#ef4444", warning: "#f59e0b", muted: "#94a3b8", dim: "#64748b",
		text: "#f8fafc", thinkingText: "#94a3b8", userMessageText: "#f8fafc", customMessageText: "#f8fafc",
		customMessageLabel: "#22d3ee", toolTitle: "#22d3ee", toolOutput: "#f8fafc", mdHeading: "#22d3ee",
		mdLink: "#38bdf8", mdLinkUrl: "#64748b", mdCode: "#f8fafc", mdCodeBlock: "#f8fafc",
		mdCodeBlockBorder: "#64748b", mdQuote: "#cbd5e1", mdQuoteBorder: "#64748b", mdHr: "#64748b",
		mdListBullet: "#22d3ee", toolDiffAdded: "#22c55e", toolDiffRemoved: "#ef4444", toolDiffContext: "#94a3b8",
		syntaxComment: "#64748b", syntaxKeyword: "#22d3ee", syntaxFunction: "#38bdf8", syntaxVariable: "#f8fafc",
		syntaxString: "#22c55e", syntaxNumber: "#f59e0b", syntaxType: "#38bdf8", syntaxOperator: "#cbd5e1",
		syntaxPunctuation: "#cbd5e1", thinkingOff: "#64748b", thinkingMinimal: "#64748b", thinkingLow: "#64748b",
		thinkingMedium: "#64748b", thinkingHigh: "#64748b", thinkingXhigh: "#64748b", thinkingMax: "#64748b",
		bashMode: "#f59e0b",
	} as const;
	const background = {
		selectedBg: "#1f2937", searchMatchBg: "#1f2937", userMessageBg: "#111827", customMessageBg: "#111827",
		toolPendingBg: "#111827", toolSuccessBg: "#111827", toolErrorBg: "#111827",
	} as const;
	return new Theme(foreground, background, "truecolor", { name });
}

test("renders a PNG component when terminal images are supported", () => {
	const entry = extractMermaidDiagrams("```mermaid\nsequenceDiagram\n  A->>B: 请求\n```")!;
	const component = renderDiagramEntry(entry, false, theme("github-dark"), true);
	assert.ok(component instanceof Container);
	const image = component.children.find((child) => child instanceof Image) as Image | undefined;
	assert.ok(image);
	assert.deepEqual((image as any).options, {
		maxWidthCells: 10_000,
		maxHeightCells: 1_000,
		filename: `sequence-${entry.diagrams[0]!.sourceDigest.slice(0, 12)}.png`,
	});
});

test("renders text fallback when terminal images are unavailable", () => {
	const entry = extractMermaidDiagrams("```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```")!;
	const component = renderDiagramEntry(entry, false, theme("github-dark"), false);
	assert.ok(component instanceof Container);
	assert.equal(component.children.some((child) => child instanceof Image), false);
	assert.equal(component.children.some((child) => child instanceof Text), true);
	assert.match(component.render(120).join("\n"), /开始/);
});

test("rejects malformed entries without throwing from the TUI renderer", () => {
	const component = renderDiagramEntry({ version: 1 }, false, theme("github-dark"), true);
	assert.ok(component instanceof Text);
	assert.match(component.render(80).join("\n"), /图表记录无效/);
});
