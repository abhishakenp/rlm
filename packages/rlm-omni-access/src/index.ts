/**
 * @rlm/omni-access — Omni model access as a Cordis service.
 *
 * Exposes the omni model API as a Cordis service callable by rlm-delegate.
 * No file, FS, or shell capabilities — only model access via fetch.
 */
import { Service, symbols } from "@deepseek-ai/cordis";

export const PLUGIN_ID = "rlm-omni-access";

export interface OmniAccessConfig {
	modelId?: string;
	baseUrl?: string;
	apiKey?: string;
}

export class OmniAccessService extends Service {
	static readonly id = PLUGIN_ID;
	static readonly provide = "rlmOmniAccess" as const;
	static readonly inject = [] as const;
	static init = symbols.init;

	declare config: OmniAccessConfig;

	private modelId = "auto/omni";
	private baseUrl = "http://localhost:20128/v1";
	private apiKey = "omniroute-local";

	constructor(ctx: any) {
		super(ctx, undefined as any);
	}

	async [Service.init]() {
		this.modelId = this.config?.modelId ?? this.modelId;
		this.baseUrl = this.config?.baseUrl ?? this.baseUrl;
		this.apiKey = this.config?.apiKey ?? this.apiKey;
	}

	/** Send a prompt to the omni model and return the full response text. */
	async chat(prompt: string): Promise<string> {
		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}),
		});

		if (!response.ok) {
			throw new Error(`omni API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		return data.choices?.[0]?.message?.content ?? "";
	}

	/** Send a prompt and stream the response chunks. */
	async *stream(prompt: string): AsyncIterable<string> {
		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.modelId,
				messages: [{ role: "user", content: prompt }],
				stream: true,
			}),
		});

		if (!response.ok) {
			throw new Error(`omni API error: ${response.status} ${response.statusText}`);
		}

		const reader = response.body?.getReader();
		if (!reader) throw new Error("No response body");

		const decoder = new TextDecoder();
		let leftover = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const chunk = leftover + decoder.decode(value, { stream: true });
			const lines = chunk.split("\n");
			leftover = lines.pop() ?? "";

			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const data = line.slice(6);
					if (data === "[DONE]") return;
					try {
						const parsed = JSON.parse(data);
						if (parsed.choices?.[0]?.delta?.content) {
							yield parsed.choices[0].delta.content;
						}
					} catch {
						// skip malformed JSON
					}
				}
			}
		}
	}
}

export default OmniAccessService;
