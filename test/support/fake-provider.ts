import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
		const began = context.messages.some(
			(message) => message.role === "toolResult" && message.toolName === "delivery_begin",
		);
		if (!began) {
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
		} else {
			const text = "Fake provider completed shaping startup.";
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
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 4096,
			},
		],
		streamSimple: fakeStream,
	});
}
