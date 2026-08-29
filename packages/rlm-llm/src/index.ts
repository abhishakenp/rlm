/**
 * @rlm/llm — OmniRoute-only LLM service.
 *
 * Clean Cordis Service. No prime-agent code.
 * Talks to OmniRoute's OpenAI-compatible endpoint (localhost:20128/v1).
 *
 * Reference: DSH's dsh-llm exposes an LlmRuntime service with stream/complete.
 * rlm-llm does the same, but OmniRoute-only — one client, one endpoint.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmLlmConfig {
	url?: string;
	apiKey?: string;
	defaultModel?: string;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_call_id?: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
}

export interface StreamOptions {
	model?: string;
	messages: ChatMessage[];
	temperature?: number;
	maxTokens?: number;
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			description: string;
			parameters: object;
		};
	}>;
	signal?: AbortSignal;
}

export interface CompleteResult {
	content: string;
	toolCalls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	finishReason: string;
	usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export class RlmLlmService extends Service {
	static inject = [] as const;
	static provide = "rlmLlm" as const;

	declare config: RlmLlmConfig;

	constructor(ctx: any, config: RlmLlmConfig = {}) {
		super(ctx, "rlmLlm");
		this.config = config;
	}

	async [Service.init]() {
		this.ctx.logger?.info(
			`rlm-llm: HMR RELOADED OmniRoute client ready (url=${this.config.url ?? "http://localhost:20128/v1"}, model=${this.config.defaultModel ?? "auto/best-free"})`,
		);
	}

	private get url() {
		return this.config.url ?? "http://localhost:20128/v1";
	}

	private get apiKey() {
		return this.config.apiKey ?? "omniroute-local";
	}

	private get defaultModel() {
		return this.config.defaultModel ?? "auto/best-free";
	}

	/** Stream a chat completion. Yields content deltas + tool call deltas. */
	async *stream(opts: StreamOptions): AsyncGenerator<{
		type: "content" | "tool_call" | "done";
		delta?: string;
		toolCall?: { id: string; name: string; arguments: string };
		result?: CompleteResult;
	}> {
		const model = opts.model ?? this.defaultModel;
		const body: any = {
			model,
			messages: opts.messages,
			stream: true,
		};
		if (opts.temperature !== undefined) body.temperature = opts.temperature;
		if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
		if (opts.tools?.length) body.tools = opts.tools;

		const response = await fetch(`${this.url}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: opts.signal,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`rlm-llm: OmniRoute ${response.status} ${response.statusText}: ${text}`);
		}

		if (!response.body) throw new Error("rlm-llm: no response body");

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let result: CompleteResult = { content: "", finishReason: "" };

		const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6).trim();
				if (data === "[DONE]") {
					result.toolCalls = [...toolCallBuffers.values()].map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: { name: tc.name, arguments: tc.arguments },
					}));
					yield { type: "done", result };
					return;
				}
				try {
					const chunk = JSON.parse(data);
					const delta = chunk.choices?.[0]?.delta;
					if (delta?.content) {
						result.content += delta.content;
						yield { type: "content", delta: delta.content };
					}
					if (delta?.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							const buf = toolCallBuffers.get(idx) ?? { id: tc.id ?? "", name: "", arguments: "" };
							if (tc.id) buf.id = tc.id;
							if (tc.function?.name) buf.name += tc.function.name;
							if (tc.function?.arguments) buf.arguments += tc.function.arguments;
							toolCallBuffers.set(idx, buf);
							yield { type: "tool_call", toolCall: buf };
						}
					}
					if (chunk.choices?.[0]?.finish_reason) {
						result.finishReason = chunk.choices[0].finish_reason;
					}
					if (chunk.usage) {
						result.usage = {
							promptTokens: chunk.usage.prompt_tokens,
							completionTokens: chunk.usage.completion_tokens,
							totalTokens: chunk.usage.total_tokens,
						};
					}
				} catch {
					// Skip malformed chunks.
				}
			}
		}
		result.toolCalls = [...toolCallBuffers.values()].map((tc) => ({
			id: tc.id,
			type: "function" as const,
			function: { name: tc.name, arguments: tc.arguments },
		}));
		yield { type: "done", result };
	}

	/** Complete a chat — returns the full result without streaming. */
	async complete(opts: StreamOptions): Promise<CompleteResult> {
		let result: CompleteResult = { content: "", finishReason: "" };
		for await (const event of this.stream(opts)) {
			if (event.type === "done" && event.result) {
				result = event.result;
			}
		}
		return result;
	}

	/** Simple prompt completion — convenience for one-shot queries. */
	async ask(prompt: string, opts?: Partial<StreamOptions>): Promise<string> {
		const result = await this.complete({
			messages: [{ role: "user", content: prompt }],
			...opts,
		});
		return result.content;
	}

	async [Symbol.dispose]() {
		// Stateless — nothing to dispose.
	}
}

export default RlmLlmService;
export const name = "rlm-llm";
export const inject = [] as const;
export { RlmLlmService as RlmLlm };
