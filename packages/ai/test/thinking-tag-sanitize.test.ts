import { describe, expect, it, vi } from "vitest";
import { sanitizeThinkingBlocks, stripThinkTags } from "../src/providers/inline-think.js";
import { stream } from "../src/stream.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

// Raw reasoning delimiters must never be visible inside a thinking block, from
// any route: a second <think> MiniMax opens while one is open, and
// reasoning_content / reasoning fields that forward the model's own tags —
// including a tag split across two deltas.

const mockState = vi.hoisted(() => ({ chunks: [] as unknown[] }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const s = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(s) as Promise<typeof s> & { withResponse: () => Promise<unknown> };
					promise.withResponse = async () => ({ data: s, response: { status: 200, headers: new Headers() } });
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model = (reasoning: boolean): Model<"openai-completions"> => ({
	id: "auto/best-free",
	name: "auto/best-free",
	api: "openai-completions",
	provider: "omniroute",
	baseUrl: "http://localhost:20128/v1",
	reasoning,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

const ctx: Context = { messages: [{ role: "user", content: "Reply with exactly: pong", timestamp: 1 }] };

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});

/** Run a stream; return every thinking text any consumer could have seen, and the final message. */
const run = async (chunks: unknown[], reasoning = false) => {
	mockState.chunks = chunks;
	const seen: string[] = [];
	const s = stream(model(reasoning), ctx, { apiKey: "x" });
	for await (const event of s) {
		if (event.type === "thinking_delta" || event.type === "thinking_end") {
			for (const block of event.partial.content) if (block.type === "thinking") seen.push(block.thinking);
		}
		if (event.type === "thinking_end") seen.push(event.content);
	}
	const final = (await s.result()) as AssistantMessage;
	const thinking = final.content.filter((b) => b.type === "thinking").map((b) => (b as { thinking: string }).thinking);
	const text = final.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
	return { seen, thinking, text };
};

const noTags = (s: string) => expect(s).not.toMatch(/<\/?think/i);

describe("thinking tags never reach thinking blocks", () => {
	it("inline: a second <think> opened while one is open (MiniMax)", async () => {
		const r = await run([
			delta({ role: "assistant", content: "<think>Check the " }),
			delta({ content: "request.<thi" }),
			delta({ content: "nk>Despite the bug, some subagents completed." }),
			delta({ content: "</think>\n\npong" }),
			delta({}, "stop"),
		]);
		expect(r.thinking.join(" ")).toContain("Despite the bug, some subagents completed.");
		for (const t of [...r.seen, ...r.thinking]) noTags(t);
		expect(r.text).toBe("pong");
	});

	it("reasoning_content that forwards the model's tags, split across deltas", async () => {
		const r = await run(
			[
				delta({ role: "assistant", reasoning_content: "<thi" }),
				delta({ reasoning_content: "nk>Plan the answer." }),
				delta({ reasoning_content: " Done.</think" }),
				delta({ reasoning_content: ">" }),
				delta({ content: "pong" }),
				delta({}, "stop"),
			],
			true,
		);
		expect(r.thinking.join("")).toContain("Plan the answer. Done.");
		for (const t of r.thinking) noTags(t);
		expect(r.text).toBe("pong");
	});

	it("reasoning field (OpenRouter-style) with <thinking> tags", async () => {
		const r = await run(
			[
				delta({ role: "assistant", reasoning: "<thinking>Step one.</thinking>" }),
				delta({ content: "pong" }),
				delta({}, "stop"),
			],
			true,
		);
		expect(r.thinking.join("")).toBe("Step one.");
		for (const t of [...r.seen, ...r.thinking]) noTags(t);
	});

	it("any provider: the event stream strips tags from partials, thinking_end content and the final message", () => {
		const s = new AssistantMessageEventStream();
		const partial = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "<think>Anthropic-style trace</think>" }, { type: "text", text: "use <think> tags" }],
		} as unknown as AssistantMessage;
		s.push({ type: "thinking_end", contentIndex: 0, content: "<think>Anthropic-style trace</think>", partial });
		expect((partial.content[0] as { thinking: string }).thinking).toBe("Anthropic-style trace");
		// Text blocks are the answer and are left alone.
		expect((partial.content[1] as { text: string }).text).toBe("use <think> tags");
	});

	it("helpers leave tag-free text untouched", () => {
		expect(stripThinkTags("a < b and x<y")).toBe("a < b and x<y");
		const m = { content: [{ type: "thinking", thinking: "\n<think>\nhello" }] };
		sanitizeThinkingBlocks(m);
		expect(m.content[0].thinking).toBe("hello");
	});
});
