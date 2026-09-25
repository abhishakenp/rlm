import { describe, expect, it } from "vitest";
import { createRepeatedAnswerGuard, REPEATED_ANSWER_LIMIT } from "../src/modes/print-mode.js";

const turn = (text: string, tool = true) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }, ...(tool ? [{ type: "toolCall" }] : [])] },
});

describe("headless repeated-answer guard", () => {
	it("stops after the same answer comes back with tool calls, markup ignored", () => {
		const guard = createRepeatedAnswerGuard();
		// Live shape: `pong` + varying `<function_calls>` junk, one tool call per turn.
		expect(guard.observe(turn("pong\n\n<function_calls>\n [.o(</function>"))).toBe(false);
		expect(guard.observe(turn("pong\n\n<function_calls>\n @nikola"))).toBe(false);
		expect(guard.observe(turn("pong\n\n<function_calls>\n [.o(k"))).toBe(true);
		expect(guard.answer).toBe("pong");
		expect(REPEATED_ANSWER_LIMIT).toBe(3);
	});

	const codeTurn = (text: string, ...codes: string[]) => ({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }, ...codes.map((code) => ({ type: "toolCall", name: "code", arguments: { code } }))],
		},
	});

	it("stops on the same lead answer with differently worded narration and bookkeeping cells (live)", () => {
		const guard = createRepeatedAnswerGuard();
		// Live, 22 calls until the 150s timeout: each turn `pong` + new narration + console.log/context.set.
		expect(guard.observe(codeTurn("pong\n\nDone. I replied with exactly \"pong\".", "console.log('pong');"))).toBe(false);
		expect(guard.observe(codeTurn("pong\n\nCompleted. The task is marked done.", "context.set('task.completed', true);"))).toBe(false);
		expect(guard.observe(codeTurn("pong\n\nTask completed successfully.", "console.log('Task completed successfully');"))).toBe(true);
		expect(guard.answer).toBe("pong");
	});

	it("does not stop a run doing real work, even if every turn opens the same way", () => {
		const guard = createRepeatedAnswerGuard();
		expect(guard.observe(codeTurn("Working on it.", "const t = fs.readFileSync('a.txt', 'utf8');"))).toBe(false);
		expect(guard.observe(codeTurn("Working on it.", "await rlm.run('check b', { name: 'b' });"))).toBe(false);
		expect(guard.observe(codeTurn("Working on it.", "%%bash\nls"))).toBe(false);
		expect(guard.observe(codeTurn("Working on it.", "const r = await fetch('https://x');"))).toBe(false);
		expect(guard.answer).toBeUndefined();
	});

	it("does not stop on different answers, final answers without tools, or other events", () => {
		const guard = createRepeatedAnswerGuard();
		expect(guard.observe(turn("step 1"))).toBe(false);
		expect(guard.observe(turn("step 2"))).toBe(false);
		expect(guard.observe(turn("step 2", false))).toBe(false);
		expect(guard.observe(turn("step 2"))).toBe(false);
		expect(guard.observe({ type: "message_update" })).toBe(false);
		expect(guard.answer).toBeUndefined();
	});
});

import { restatedEarlierAnswer } from "../src/modes/print-mode.js";

describe("restatedEarlierAnswer", () => {
	const user = { role: "user", content: "Reply with exactly: pong" };
	const first = { role: "assistant", content: [{ type: "text", text: "pong" }, { type: "toolCall" }] };

	it("returns the earlier answer when the final message restates it and narrates (live)", () => {
		const final = { role: "assistant", content: [{ type: "text", text: "pong**@user** — exactly `pong` as requested. ✓" }] };
		expect(restatedEarlierAnswer([user, first, { role: "toolResult" }, final], final, "pong**@user** — exactly `pong` as requested. ✓")).toBe("pong");
	});

	it("keeps the final answer when it differs or is the same", () => {
		const final = { role: "assistant", content: [{ type: "text", text: "Here is the full result." }] };
		expect(restatedEarlierAnswer([user, first, final], final, "Here is the full result.")).toBeUndefined();
		const same = { role: "assistant", content: [{ type: "text", text: "pong" }] };
		expect(restatedEarlierAnswer([user, first, same], same, "pong")).toBeUndefined();
	});

	it("only looks inside the current run", () => {
		const old = { role: "assistant", content: [{ type: "text", text: "Hi" }] };
		const final = { role: "assistant", content: [{ type: "text", text: "Hi there, new answer" }] };
		expect(restatedEarlierAnswer([old, user, final], final, "Hi there, new answer")).toBeUndefined();
	});
});
