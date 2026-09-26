import { describe, expect, test } from "bun:test";
import { cleanCompletion, cleanStream, splitReply } from "../src/think.ts";

const sse = (chunks: unknown[]) =>
	chunks.map((c) => (c === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(c)}\n\n`));
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
	id: "x",
	object: "chat.completion.chunk",
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const collect = async (parts: string[]) => {
	const events: any[] = [];
	for await (const e of cleanStream((async function* () { yield* parts; })())) {
		for (const line of e.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			const p = line.slice(6);
			events.push(p === "[DONE]" ? p : JSON.parse(p));
		}
	}
	const content = events.flatMap((e) => (e === "[DONE]" ? [] : e.choices.map((c: any) => c.delta?.content ?? ""))).join("");
	const reasoning = events
		.flatMap((e) => (e === "[DONE]" ? [] : e.choices.map((c: any) => c.delta?.reasoning_content ?? "")))
		.join("");
	return { events, content, reasoning };
};

describe("splitReply", () => {
	test("inline think goes to reasoning, answer stays", () => {
		expect(splitReply("<think>The user wants pong.</think>\n\npong")).toEqual({
			content: "pong",
			reasoning: "The user wants pong.",
		});
	});
	test("a reply with no tags passes through untouched", () => {
		expect(splitReply("  plain answer\n")).toEqual({ content: "  plain answer\n", reasoning: "" });
	});
	test("a restart after the answer is reasoning, not content", () => {
		const { content } = splitReply("<think>x</think>pong <think>again</think> pong Done.");
		expect(content).toBe("pong");
	});
	test("namespaced pseudo markup (live MiniMax reply) is cut", () => {
		// Exact live non-streaming reply from auto/best-free through the SDK.
		const raw = '<think>The user wants pong.</think>\n\npong<minimax:tool_call>\nThe assistant\'s final output should be "pong" exactly.\n\n\npong';
		expect(splitReply(raw).content).toBe("pong");
	});
	test("pseudo markup after the answer is cut", () => {
		const { content } = splitReply("<think>a</think>pong\n\n<result>\npong\n</result>[/USER]? No tools needed.");
		expect(content).toBe("pong");
	});
});

describe("cleanCompletion", () => {
	test("rewrites message content and adds reasoning_content", () => {
		const out = cleanCompletion({ choices: [{ index: 0, message: { role: "assistant", content: "<think>r</think>\npong" } }] });
		expect(out.choices[0].message).toEqual({ role: "assistant", content: "pong", reasoning_content: "r" });
	});
});

describe("cleanStream", () => {
	test("tags split across chunks never reach content", async () => {
		const { content, reasoning, events } = await collect(
			sse([
				delta({ role: "assistant" }),
				delta({ content: "<thi" }),
				delta({ content: "nk>The user wants" }),
				delta({ content: " pong.</th" }),
				delta({ content: "ink>\n\npo" }),
				delta({ content: "ng" }),
				delta({}, "stop"),
				"[DONE]",
			]),
		);
		expect(content).toBe("pong");
		expect(reasoning).toBe("The user wants pong.");
		expect(content).not.toContain("<");
		expect(events.at(-1)).toBe("[DONE]");
		expect(events.some((e) => e !== "[DONE]" && e.choices.some((c: any) => c.finish_reason === "stop"))).toBe(true);
	});
	test("an empty delta after thinking acts as the swallowed </think>", async () => {
		const { content, reasoning } = await collect(
			sse([delta({ content: "<think>reason" }), delta({}), delta({ content: "\n\npong" }), delta({}, "stop"), "[DONE]"]),
		);
		expect(content).toBe("pong");
		expect(reasoning).toBe("reason");
	});
	test("tool calls and usage pass through", async () => {
		const tool = { index: 0, id: "t1", type: "function", function: { name: "calc", arguments: "{}" } };
		const { events } = await collect(
			sse([delta({ tool_calls: [tool] }), delta({}, "tool_calls"), { id: "x", choices: [], usage: { total_tokens: 3 } }, "[DONE]"]),
		);
		expect(events.some((e) => e !== "[DONE]" && e.choices[0]?.delta?.tool_calls?.[0]?.function?.name === "calc")).toBe(true);
		expect(events.some((e) => e !== "[DONE]" && e.usage?.total_tokens === 3)).toBe(true);
	});
	test("plain streams keep their text", async () => {
		const { content } = await collect(sse([delta({ content: "hello " }), delta({ content: "world" }), delta({}, "stop"), "[DONE]"]));
		expect(content).toBe("hello world");
	});
});
