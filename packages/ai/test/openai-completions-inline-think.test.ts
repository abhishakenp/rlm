import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_THINK_SIGNATURE, InlineThinkSplitter, type InlineThinkSegment } from "../src/providers/inline-think.js";
import { complete } from "../src/stream.js";
import type { AssistantMessage, Context, Model, Tool } from "../src/types.js";

// Fixtures are real OmniRoute `auto/best-free` streams (MiniMax-M2.7 via dahl),
// captured 2026-09-25 and reduced to {choices, usage} per chunk.
const fixture = (name: string): unknown[] =>
	JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8"));

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
	lastParams: undefined as unknown,
	yielded: 0,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							mockState.yielded = 0;
							for (const chunk of chunks) {
								mockState.yielded++;
								yield chunk;
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const omniroute = (): Model<"openai-completions"> => ({
	id: "auto/best-free",
	name: "auto/best-free",
	api: "openai-completions",
	provider: "omniroute",
	baseUrl: "http://localhost:20128/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

const codeTool: Tool = {
	name: "code",
	description: "run js",
	parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } as Tool["parameters"],
};

const ask = (tools?: Tool[]): Context => ({
	messages: [{ role: "user", content: "Reply with exactly: pong", timestamp: Date.now() }],
	tools,
});

const visibleText = (message: AssistantMessage) =>
	message.content
		.filter((block) => block.type === "text")
		.map((block) => (block as { text: string }).text)
		.join("");

const thinkingText = (message: AssistantMessage) =>
	message.content
		.filter((block) => block.type === "thinking")
		.map((block) => (block as { thinking: string }).thinking)
		.join("");

const run = (splitter: InlineThinkSegment[][]) => {
	const merged: InlineThinkSegment[] = [];
	for (const segment of splitter.flat()) {
		const last = merged[merged.length - 1];
		if (last && last.kind === segment.kind) last.text += segment.text;
		else merged.push({ ...segment });
	}
	return merged;
};

describe("InlineThinkSplitter", () => {
	it("splits tags that arrive one character at a time", () => {
		const s = new InlineThinkSplitter();
		const input = "<think>plan it</think>\n\nanswer";
		const out = run([...[...input].map((ch) => s.push(ch)), s.flush()]);
		expect(out).toEqual([
			{ kind: "thinking", text: "plan it" },
			{ kind: "text", text: "answer" },
		]);
	});

	it("ends thinking on implicitClose when the route swallowed </think>", () => {
		const s = new InlineThinkSplitter();
		const out = run([s.push("<think>reasoning.\n"), s.implicitClose(), s.implicitClose(), s.push("\n\npong"), s.flush()]);
		expect(out).toEqual([
			{ kind: "thinking", text: "reasoning.\n" },
			{ kind: "text", text: "pong" },
		]);
	});

	it("treats an unclosed <think> at end of stream as thinking", () => {
		const s = new InlineThinkSplitter();
		expect(run([s.push("<think>still thinking"), s.flush()])).toEqual([{ kind: "thinking", text: "still thinking" }]);
	});

	it("routes a <think> after the answer into thinking", () => {
		const s = new InlineThinkSplitter();
		const out = run([s.push("pong<think>again</think>"), s.flush()]);
		expect(out).toEqual([
			{ kind: "text", text: "pong" },
			{ kind: "thinking", text: "again" },
		]);
	});

	it("drops a stray </think> with no opener", () => {
		const s = new InlineThinkSplitter();
		expect(run([s.push("a</think>b"), s.flush()])).toEqual([{ kind: "text", text: "ab" }]);
	});

	it("leaves ordinary text, including its whitespace and lone '<', untouched", () => {
		const s = new InlineThinkSplitter();
		expect(run([s.push("\n  a < b"), s.push(" <"), s.flush()])).toEqual([{ kind: "text", text: "\n  a < b <" }]);
		expect(s.active).toBe(false);
	});
});

describe("openai-completions inline <think> (real MiniMax-M2.7 streams)", () => {
	beforeEach(() => {
		mockState.chunks = [];
		mockState.lastParams = undefined;
	});

	it("balanced tags, answered twice: one thinking block, answer once, no tags", async () => {
		mockState.chunks = fixture("minimax-think-balanced-twice");
		const message = await complete(omniroute(), ask(), { apiKey: "test" });
		expect(message.stopReason).toBe("stop");
		expect(visibleText(message)).toBe("pong");
		expect(thinkingText(message)).toContain('The user says: "Reply with exactly: pong"');
		expect(JSON.stringify(message.content)).not.toContain("<think>");
		expect(message.content[0]).toMatchObject({ type: "thinking", thinkingSignature: INLINE_THINK_SIGNATURE });
	});

	it("tools request with </think> swallowed upstream: thinking ends at the empty deltas", async () => {
		mockState.chunks = fixture("minimax-think-tools-dropped-close");
		const message = await complete(omniroute(), ask([codeTool]), { apiKey: "test" });
		expect(message.content[0]).toMatchObject({ type: "thinking" });
		expect(message.content[1]).toMatchObject({ type: "text", text: "pong" });
		expect(thinkingText(message)).not.toContain("pong\n");
		expect(visibleText(message)).not.toContain("<think>");
		expect(visibleText(message)).not.toContain("The user");
	});

	it("a lone empty delta mid-reasoning does not end the thinking (answer is just pong)", async () => {
		// Live capture: `…exactly: pong` `{}` `" — so I just respond with…` — the
		// route swallowed one token inside the second <think>; only `{}{}` + "\n\npong"
		// was a real close. The old rule leaked `" — so I just respond…` as text.
		mockState.chunks = fixture("minimax-midthink-empty-delta");
		const message = await complete(omniroute(), ask([codeTool]), { apiKey: "test" });
		expect(visibleText(message)).toBe("pong");
		expect(visibleText(message)).not.toContain("so I just respond");
		expect(visibleText(message)).not.toContain("above");
		expect(visibleText(message)).not.toContain("Done");
		// The first reasoning survives; the model's restart after answering is dropped.
		expect(thinkingText(message)).toContain("The user wants me to reply");
		expect(message.content.at(-1)).toMatchObject({ type: "text", text: "pong" });
	});

	it("tool-call markup passed through as text ends the answer (live capture)", async () => {
		// `pong[/TOOL_CALL]No answer is expected of me here…`
		mockState.chunks = fixture("minimax-text-tool-marker");
		const message = await complete(omniroute(), ask([codeTool]), { apiKey: "test" });
		expect(visibleText(message)).toBe("pong");
		expect(visibleText(message)).not.toContain("TOOL_CALL");
		expect(visibleText(message)).not.toContain("No answer is expected");
	});

	it("thinking then a real tool call: thinking block + tool call, no leaked tags", async () => {
		mockState.chunks = fixture("minimax-think-then-tool-call");
		const message = await complete(omniroute(), ask([codeTool]), { apiKey: "test" });
		expect(message.stopReason).toBe("toolUse");
		expect(message.content.some((b) => b.type === "toolCall" && b.name === "code")).toBe(true);
		expect(message.content[0]).toMatchObject({ type: "thinking" });
		expect(visibleText(message)).not.toContain("<think>");
	});

	it("tool call swallowed upstream (107 empty deltas, finish=stop) becomes a retryable error", async () => {
		mockState.chunks = fixture("minimax-dropped-tool-call");
		const message = await complete(omniroute(), ask([codeTool]), { apiKey: "test" });
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/Upstream dropped a tool call/);
	});

	it("a long swallowed call is cut mid-stream instead of waited out (2,146 empty deltas, as the user hit)", async () => {
		const model = "MiniMaxAI/MiniMax-M2.7";
		mockState.chunks = [
			{ model, choices: [{ index: 0, delta: { role: "assistant", content: "I'll spawn subagents." } }] },
			...Array.from({ length: 2146 }, () => ({ model, choices: [{ index: 0, delta: {} }] })),
			{ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		const message = await complete(omniroute(), ask([codeTool]), { apiKey: "test" });
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(`Upstream dropped a tool call (${model})`);
		// Stopped reading at the cut-off, not after two thousand more chunks.
		expect(mockState.yielded).toBeLessThanOrEqual(34);
	});

	it("the long empty run without tools in the request is not cut", async () => {
		mockState.chunks = [
			{ choices: [{ index: 0, delta: { content: "hi" } }] },
			...Array.from({ length: 200 }, () => ({ choices: [{ index: 0, delta: {} }] })),
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		const message = await complete(omniroute(), ask(), { apiKey: "test" });
		expect(message.stopReason).toBe("stop");
		expect(mockState.yielded).toBe(202);
	});

	it("the same stream without tools in the request is left as a normal stop", async () => {
		mockState.chunks = fixture("minimax-dropped-tool-call");
		const message = await complete(omniroute(), ask(), { apiKey: "test" });
		expect(message.stopReason).toBe("stop");
	});

	it("replays inline thinking wrapped in <think> tags, in order, as plain content", async () => {
		mockState.chunks = fixture("minimax-think-balanced-twice");
		const first = await complete(omniroute(), ask(), { apiKey: "test" });
		mockState.chunks = fixture("minimax-think-balanced-twice");
		await complete(
			omniroute(),
			{ messages: [...ask().messages, first, { role: "user", content: "again", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);
		const params = mockState.lastParams as { messages: { role: string; content: unknown }[] };
		const assistant = params.messages.find((m) => m.role === "assistant") as Record<string, unknown>;
		expect(typeof assistant.content).toBe("string");
		expect(assistant.content as string).toMatch(/^<think>[\s\S]+<\/think>\n\npong$/);
		expect(assistant[INLINE_THINK_SIGNATURE]).toBeUndefined();
	});
});

describe("InlineThinkSplitter: empty deltas", () => {
	const collect = (steps: (string | null)[]) => {
		const splitter = new InlineThinkSplitter();
		const segments: InlineThinkSegment[] = [];
		for (const step of steps) segments.push(...(step === null ? splitter.implicitClose() : splitter.push(step)));
		segments.push(...splitter.flush());
		const of = (kind: string) => segments.filter((s) => s.kind === kind).map((s) => s.text).join("");
		return { text: of("text"), thinking: of("thinking") };
	};

	it("a lone {} inside the first <think> is a swallowed token, not the close", () => {
		// null = an empty delta `{}` from the route.
		const { text, thinking } = collect(['<think>The user asked for "pong', null, '" — so I respond with it.', null, null, "\n\npong"]);
		expect(text).toBe("pong");
		expect(thinking).toContain("so I respond with it.");
	});

	it("{} followed by content on a new line is the swallowed </think>", () => {
		const { text, thinking } = collect(["<think>Short reasoning.", null, "\n\npong"]);
		expect(text).toBe("pong");
		expect(thinking).toBe("Short reasoning.");
	});
});

describe("InlineThinkSplitter: pseudo chat-template markup after the answer", () => {
	const collect = (chunks: string[]) => {
		const splitter = new InlineThinkSplitter();
		const segments: InlineThinkSegment[] = [];
		for (const chunk of chunks) segments.push(...splitter.push(chunk));
		segments.push(...splitter.flush());
		return {
			text: segments.filter((s) => s.kind === "text").map((s) => s.text).join(""),
			restarted: splitter.startedOver,
		};
	};

	it("coordinator's live output: `pong <result>…</result>[/USER]? …` → pong", () => {
		const r = collect(["<think>Simple.</think>", "\n\npong\n\n<res", "ult>\npong\n</result>[/US", "ER]? No tools needed. Answer: pong."]);
		expect(r.text).toBe("pong");
		expect(r.restarted).toBe(true);
	});

	it("recognises unseen tags by shape: <|im_end|>, [INST], <tool_response>", () => {
		for (const tag of ["<|im_end|>", "[INST]", "<tool_response>", "[/ASSISTANT]"]) {
			expect(collect(["<think>x</think>", `pong${tag}more reasoning`]).text).toBe("pong");
		}
	});

	it("markup before any answer only wraps it", () => {
		expect(collect(["<think>x</think>", "<result>pong</result>"]).text).toBe("pong");
	});

	it("leaves ordinary answers alone: links, checkboxes, code", () => {
		const answer = "See [the docs](https://x.dev) and [ ] todo.\n```html\n<div>hi</div>\n```\nUse `<br>` inline.";
		expect(collect(["<think>x</think>", answer]).text).toBe(answer);
	});

	it("does nothing on routes that never used inline think tags", () => {
		expect(collect(["Plain <result>html</result> talk"]).text).toBe("Plain <result>html</result> talk");
	});
});

describe("degenerate repetition loop", () => {
	it("cuts a stream stuck repeating `✓ — ` and keeps what came before (live: 5 minutes, no finish)", async () => {
		const head = "<think>Done.</think>\n\npong [#1790374955214] ✓ context set to true — task done.";
		const chunk = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
		mockState.chunks = [chunk(head), ...Array.from({ length: 3000 }, () => chunk("✓ — "))];
		const message = await complete(omniroute(), ask(), { apiKey: "test" });
		expect(message.stopReason).toBe("stop");
		expect(visibleText(message).endsWith("task done.")).toBe(true);
		expect(mockState.yielded).toBeLessThan(200);
	});

	it("leaves ordinary long answers alone", async () => {
		const { degenerateLoopStart } = await import("../src/providers/openai-completions.js");
		const prose = Array.from({ length: 60 }, (_, i) => `Line ${i}: the value is ${i * 7}.`).join("\n");
		expect(degenerateLoopStart(prose)).toBe(-1);
		expect(degenerateLoopStart(`x${"ab".repeat(400)}`)).toBe(1);
	});
});

describe("InlineThinkSplitter: chat-transcript roleplay after the answer", () => {
	it("`pong\\n\\nUser: …\\n\\nModel: pong` (live) → pong; a role word mid-sentence is fine", () => {
		const run = (chunks: string[]) => {
			const splitter = new InlineThinkSplitter();
			const segs: InlineThinkSegment[] = [];
			for (const c of chunks) segs.push(...splitter.push(c));
			segs.push(...splitter.flush());
			return segs.filter((s) => s.kind === "text").map((s) => s.text).join("");
		};
		expect(run(["<think>x</think>", "\n\npong\n\nUse", "r: Reply with exactly: pong\n\nModel: pong"])).toBe("pong");
		expect(run(["<think>x</think>", "Ask the User: they know."])).toBe("Ask the User: they know.");
	});
});
