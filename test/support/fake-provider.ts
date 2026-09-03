import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DIAGRAM_ENTRY_CUSTOM_TYPE } from "../../extensions/delivery-gate/src/diagrams.ts";
import { SubagentBoundary } from "../../extensions/delivery-gate/src/subagents.ts";
import { runApprovedValidation } from "../../extensions/delivery-gate/src/validation.ts";

function baseMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function fakeStream(
	model: Model<any>,
	context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output = baseMessage(model);
		stream.push({ type: "start", partial: output });
		const availableTools = new Set((context.tools ?? []).map((tool) => tool.name));
		const began = context.messages.some(
			(message) => message.role === "toolResult" && message.toolName === "delivery_begin",
		);
		const delegatedReadonly = context.messages.some(
			(message) => message.role === "toolResult" && message.toolName === "delivery_delegate_readonly",
		);
		if (process.env.PI_ADAPTIVE_VALIDATION_PROBE === "1") {
			const text = "Validation probe parent idle.";
			output.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
			output.stopReason = "stop";
		} else if (
			process.env.PI_ADAPTIVE_READONLY_DELEGATION_PROBE === "1" &&
			!availableTools.has("delivery_begin")
		) {
			const text = "Fake read-only delegate completed.";
			output.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
			output.stopReason = "stop";
		} else if (!began) {
			const toolCall = {
				type: "toolCall" as const,
				id: "fake-delivery-begin",
				name: "delivery_begin",
				arguments: { goal: "Fake provider E2E delivery" },
			};
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
			output.stopReason = "toolUse";
		} else if (
			process.env.PI_ADAPTIVE_READONLY_DELEGATION_PROBE === "1" &&
			availableTools.has("delivery_delegate_readonly") &&
			!delegatedReadonly
		) {
			const toolCall = {
				type: "toolCall" as const,
				id: "fake-readonly-delegation",
				name: "delivery_delegate_readonly",
				arguments: { role: "oracle", task: "Review one bounded high-risk decision without modifying files." },
			};
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
			output.stopReason = "toolUse";
		} else {
			const text = process.env.PI_ADAPTIVE_DIAGRAM_PROBE === "1"
				? [
					"# 技术方案",
					"",
					"```mermaid",
					"sequenceDiagram",
					"  actor U as 用户",
					"  participant P as 父 Pi",
					"  U->>P: 提出需求",
					"  P-->>U: 技术方案",
					"```",
				].join("\n")
				: "Fake provider completed shaping startup.";
			output.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
			output.stopReason = "stop";
		}
		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end();
	});
	return stream;
}

export default function fakeProvider(pi: ExtensionAPI): void {
	pi.registerProvider("adaptive-fake", {
		name: "Adaptive Delivery Fake Provider",
		baseUrl: "http://127.0.0.1",
		apiKey: "fake-local-key",
		api: "adaptive-fake-api",
		models: [
			{
				id: "fake-model",
				name: "Fake Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 4096,
			},
		],
		streamSimple: fakeStream,
	});

	registerDiagramProbe(pi);
	registerSubagentOwnerProbe(pi);
	if (process.env.PI_ADAPTIVE_VALIDATION_PROBE !== "1") return;
	pi.registerCommand("adaptive-validation-probe", {
		description: "Run the local validation-runtime E2E probe",
		handler: async (_args, ctx) => {
			try {
				const result = await runApprovedValidation({
					pi,
					cwd: ctx.cwd,
					commands: [{
						id: "runtime-probe",
						command: "node -e \"process.stdout.write('validation-runtime-ok')\"",
						timeoutMs: 30_000,
					}],
				});
				ctx.ui.notify(JSON.stringify({ result }), result.status === "passed" ? "info" : "error");
			} catch (error) {
				ctx.ui.notify(`validation-probe-error:${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

function registerSubagentOwnerProbe(pi: ExtensionAPI): void {
	if (process.env.PI_ADAPTIVE_SUBAGENT_OWNER_PROBE !== "1") return;
	pi.registerCommand("adaptive-subagent-owner-probe", {
		description: "Inspect the bundled subagent runtime owner",
		handler: async (_args, ctx) => {
			try {
				const boundary = new SubagentBoundary(pi);
				await boundary.ping(1_000);
				const owners = pi.getAllTools()
					.filter((tool) => tool.name === "subagent")
					.map((tool) => tool.sourceInfo.path);
				ctx.ui.notify(JSON.stringify({ owners }), owners.length === 1 ? "info" : "error");
			} catch (error) {
				ctx.ui.notify(`subagent-owner-probe-error:${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

export function registerDiagramProbe(pi: ExtensionAPI): void {
	if (process.env.PI_ADAPTIVE_DIAGRAM_PROBE !== "1") return;
	pi.registerCommand("adaptive-diagram-probe-status", {
		description: "Inspect the local diagram-rendering E2E state",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const diagram = branch.find(
				(entry: any) => entry?.type === "custom" && entry.customType === DIAGRAM_ENTRY_CUSTOM_TYPE,
			) as any;
			const rawMermaid = branch.some(
				(entry: any) => entry?.type === "message" && entry.message?.role === "assistant" && JSON.stringify(entry.message.content).includes("sequenceDiagram"),
			);
			ctx.ui.notify(JSON.stringify({
				rawMermaid,
				diagramKind: diagram?.data?.diagrams?.[0]?.kind,
				customType: diagram?.customType,
			}), diagram && rawMermaid ? "info" : "error");
		},
	});
}
