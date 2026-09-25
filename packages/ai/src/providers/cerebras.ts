import OpenAI from "openai"; 
import { getEnvApiKey } from "../env-api-keys.js"; 
import { buildBaseOptions } from "./simple-options.js"; 
import { AssistantMessageEventStream } from "../utils/event-stream.js"; 
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ToolCall,
} from "../types.js"; 
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js"; 
import { parseStreamingJson } from "../utils/json-parse.js"; 

export interface CerebrasOptions extends StreamOptions {
	// Cerebras-specific options can be added here.
}

/** Streams Cerebras chat completions via OpenAI-compatible API. */
export const streamCerebras: StreamFunction<"cerebras-conversations", CerebrasOptions> = (
	model: Model<"cerebras-conversations">,
	context: Context,
	options?: CerebrasOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream(); 

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		}; 

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider); 
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`); 
			}

			const client = new OpenAI({
				apiKey,
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
			}); 

			const messages = transformMessages(context.messages); 
			const params = buildParams(model, context, messages, options); 

			const mistralStream = await client.chat.completions.create(params, { signal: options?.signal }); 
			stream.push({ type: "start", partial: output }); 
			await consumeChatStream(model, output, stream, mistralStream); 

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted"); 
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider error"); 
			}

			stream.push({ type: "done", reason: output.stopReason, message: output }); 
			stream.end(); 
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error"; 
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error); 
			stream.push({ type: "error", reason: output.stopReason, error: output }); 
			stream.end(); 
		}
	})(); 

	return stream; 
}; 

export const streamSimpleCerebras: StreamFunction<"cerebras-conversations", SimpleStreamOptions> = (
	model: Model<"cerebras-conversations">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider); 
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`); 
	}

	const base = buildBaseOptions(model, options, apiKey); 
	return streamCerebras(model, context, base); 
}; 

function transformMessages(messages: Context["messages"]) {
	// TODO: implement message transformation similar to openai-completions.ts
	// For now, just return messages as-is.
	return messages; 
}

function buildParams(
	model: Model<"cerebras-conversations">,
	context: Context,
	messages: any[],
	options?: CerebrasOptions,
) {
	const params: Record<string, any> = {
		model: model.id,
		messages,
		stream: true,
	}; 

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature; 
	}
	if (options?.maxTokens !== undefined) {
		params.max_tokens = options.maxTokens; 
	}

	return params; 
}

async function consumeChatStream(
	model: Model<"cerebras-conversations">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	openaiStream: AsyncIterable<any>,
): Promise<void> {
	let currentBlock: TextContent | null = null; 
	const blocks = output.content; 
	const blockIndex = () => blocks.length - 1; 

	const finishCurrentBlock = (block?: typeof currentBlock) => {
		if (!block) return; 
		if (block.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: blockIndex(),
				content: block.text,
				partial: output,
			}); 
		}
	}; 

	for await (const chunk of openaiStream) {
		const choice = chunk.choices?.[0]; 
		if (!choice) continue; 

		if (choice.finish_reason) {
			output.stopReason = mapStopReason(choice.finish_reason); 
		}

		const delta = choice.delta; 
		if (delta?.content) {
			const textDelta = sanitizeSurrogates(delta.content); 
			if (!currentBlock || currentBlock.type !== "text") {
				finishCurrentBlock(currentBlock); 
				currentBlock = { type: "text", text: "" }; 
				output.content.push(currentBlock); 
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output }); 
			}
			currentBlock.text += textDelta; 
			stream.push({
				type: "text_delta",
				contentIndex: blockIndex(),
				delta: textDelta,
				partial: output,
			}); 
		}

		if (delta?.tool_calls) {
			for (const toolCall of delta.tool_calls) {
				if (currentBlock) {
					finishCurrentBlock(currentBlock); 
					currentBlock = null; 
				}
				const callId = toolCall.id || ""; 
				let block = output.content.find((b) => b.type === "toolCall" && b.id === callId) as ToolCall | undefined; 
				if (!block) {
					block = {
						type: "toolCall",
						id: callId,
						name: toolCall.function?.name || "",
						arguments: {},
					}; 
					output.content.push(block); 
					stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output }); 
				}

				const argsDelta =
					typeof toolCall.function?.arguments === "string"
						? toolCall.function.arguments
						: JSON.stringify(toolCall.function?.arguments || {}); 
				block.arguments = parseStreamingJson(argsDelta); 
				stream.push({
					type: "toolcall_delta",
					contentIndex: output.content.length - 1,
					delta: argsDelta,
					partial: output,
				}); 
			}
		}
	}

	finishCurrentBlock(currentBlock); 
	for (let i = 0; i < output.content.length; i++) {
		const block = output.content[i]; 
		if (block.type === "toolCall") {
			stream.push({
				type: "toolcall_end",
				contentIndex: i,
				toolCall: block as ToolCall,
				partial: output,
			}); 
		}
	}
}

function mapStopReason(reason: string | null): StopReason {
	if (reason === null) return "stop"; 
	switch (reason) {
		case "stop":
			return "stop"; 
		case "length":
			return "length"; 
		case "tool_calls":
			return "toolUse"; 
		default:
			return "stop"; return 
	}
}
