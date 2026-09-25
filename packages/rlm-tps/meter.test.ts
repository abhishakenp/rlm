import { describe, expect, test } from "bun:test";
import { formatTps, streamedChars, TpsMeter, usageOutputOf } from "./src/meter.ts";

const msg = (text: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text }], ...extra });

describe("TpsMeter", () => {
	test("nothing to show before the first response", () => {
		const m = new TpsMeter();
		expect(formatTps(m.state)).toBeUndefined();
		m.start(0);
		expect(formatTps(m.state)).toBeUndefined();
	});

	test("time to first token is excluded from the rate", () => {
		const m = new TpsMeter();
		m.start(0);
		// First token after 5s, then 400 chars (100 tokens) over the next 2s.
		m.update({ chars: 4 }, 5000);
		m.update({ chars: 400 }, 7000);
		m.end({ chars: 400 }, 7000);
		expect(m.state).toEqual({ phase: "done", tps: 50 });
		expect(m.ttftMs).toBe(5000);
		expect(formatTps(m.state)).toBe("50 tok/s");
	});

	test("provider usage wins over the character estimate at the end", () => {
		const m = new TpsMeter();
		m.start(0);
		m.update({ chars: 8 }, 100);
		m.update({ chars: 800 }, 1100);
		m.end({ chars: 800, usageOutput: 300 }, 1100);
		expect(m.state).toEqual({ phase: "done", tps: 300 });
	});

	test("live value appears only after enough time and tokens, and is smoothed", () => {
		const m = new TpsMeter();
		m.start(0);
		m.update({ chars: 40 }, 1000);
		m.update({ chars: 80 }, 1100); // 100ms after first token: too early
		expect(m.state).toEqual({ phase: "live", tps: undefined });
		expect(formatTps(m.state)).toBe("… tok/s");
		m.update({ chars: 400 }, 2000); // 100 tokens / 1s
		expect(m.state).toEqual({ phase: "live", tps: 100 });
		// A burst: 4x the tokens in 10ms moves the shown value only a little.
		m.update({ chars: 1600 }, 2010);
		const s = m.state;
		expect(s.phase).toBe("live");
		const tps = (s as { tps: number }).tps;
		expect(tps).toBeGreaterThan(100);
		expect(tps).toBeLessThan(110);
	});

	test("value freezes after completion and stays while the next request waits", () => {
		const m = new TpsMeter();
		m.start(0);
		m.update({ chars: 4 }, 0);
		m.update({ chars: 404 }, 1000);
		m.end({ chars: 404 }, 1000);
		expect(formatTps(m.state)).toBe("101 tok/s");
		m.start(5000); // next response requested, no tokens yet
		expect(formatTps(m.state)).toBe("101 tok/s");
		m.update({ chars: 4 }, 6000);
		expect(m.state).toEqual({ phase: "live", tps: undefined });
	});

	test("a burst-delivered reply is rated over the whole response time", () => {
		const m = new TpsMeter();
		m.start(0);
		// 86 tokens after 5.9s of silence, all delivered within 750ms.
		m.update({ chars: 40 }, 5900);
		m.update({ chars: 344 }, 6650);
		m.end({ chars: 344, usageOutput: 86 }, 6650);
		const s = m.state as { tps: number };
		expect(s.tps).toBeCloseTo(86 / 6.65, 5);
		expect(formatTps(m.state)).toBe("13 tok/s");
	});

	test("a single-chunk response keeps the previous value", () => {
		const m = new TpsMeter();
		m.start(0);
		m.update({ chars: 4 }, 0);
		m.update({ chars: 404 }, 1000);
		m.end({ chars: 404 }, 1000);
		m.start(2000);
		m.update({ chars: 20 }, 2500);
		m.end({ chars: 20 }, 2500);
		expect(formatTps(m.state)).toBe("101 tok/s");
	});

	test("active is true only between start and end", () => {
		const m = new TpsMeter();
		expect(m.active).toBe(false);
		m.start(0);
		expect(m.active).toBe(true);
		m.update({ chars: 40 }, 100);
		expect(m.active).toBe(true);
		m.end({ chars: 40 }, 2000);
		expect(m.active).toBe(false);
	});

	test("reset clears", () => {
		const m = new TpsMeter();
		m.start(0);
		m.update({ chars: 4 }, 0);
		m.update({ chars: 404 }, 1000);
		m.end({ chars: 404 }, 1000);
		m.reset();
		expect(formatTps(m.state)).toBeUndefined();
	});

	test("the 10 boundary reads as a whole number", () => {
		expect(formatTps({ phase: "done", tps: 9.97 })).toBe("10 tok/s");
		expect(formatTps({ phase: "done", tps: 9.94 })).toBe("9.9 tok/s");
	});

	test("small rates keep a decimal", () => {
		const m = new TpsMeter();
		m.start(0);
		m.update({ chars: 4 }, 0);
		m.update({ chars: 40 }, 4000);
		m.end({ chars: 40 }, 4000);
		expect(formatTps(m.state)).toBe("2.5 tok/s");
	});
});

describe("message helpers", () => {
	test("streamedChars counts text, thinking and tool-call args", () => {
		expect(
			streamedChars({
				content: [
					{ type: "text", text: "abcd" },
					{ type: "thinking", thinking: "xy" },
					{ type: "toolCall", arguments: { a: 1 } },
					{ type: "image", data: "zzzz" },
				],
			}),
		).toBe(4 + 2 + JSON.stringify({ a: 1 }).length);
		expect(streamedChars(undefined)).toBe(0);
	});

	test("usageOutputOf", () => {
		expect(usageOutputOf(msg("x", { usage: { output: 12 } }))).toBe(12);
		expect(usageOutputOf(msg("x"))).toBe(0);
	});
});
