import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/** The info line (first line) of a tray with the given labels. */
const infoLine = (
	width: number,
	opts: { left?: string; context?: string; segments?: string[]; notice?: string; override?: string },
): string => {
	const line = new SubagentSummaryLine(
		() => opts.left,
		() => opts.context,
		() => opts.override,
	);
	if (opts.segments) line.setStatusSegmentsSource(() => opts.segments ?? []);
	if (opts.notice !== undefined) line.setNoticeSource(() => opts.notice);
	return stripAnsi(line.render(width)[0] ?? "");
};

describe("prompt tray status segments and notice", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("puts segments right of the context label, in order", () => {
		const out = infoLine(100, { left: "auto/best-free", context: "37k (4%)", segments: ["42 tok/s", "ctx:3"] });
		expect(out.endsWith("37k (4%) · 42 tok/s · ctx:3")).toBe(true);
		expect(out.length).toBe(100);
	});

	it("drops the farthest segment first when the line is tight, keeping the left intact", () => {
		const left = "← agents/resume  auto/best-free";
		const out = infoLine(55, { left, context: "37k (4%)", segments: ["42 tok/s", "ctx:30", "thinking: summary"] });
		expect(out.startsWith(left)).toBe(true);
		expect(out.endsWith("37k (4%) · 42 tok/s")).toBe(true);
		expect(out).not.toContain("ctx:30");
		expect(out.length).toBe(55);
	});

	it("shows the notice in the gap between the left labels and the context", () => {
		const out = infoLine(100, { left: "auto/best-free", context: "37k (4%)", segments: ["42 tok/s"], notice: "↻ reloaded rlm-pixel/index.ts" });
		expect(out).toMatch(/^auto\/best-free {3}↻ reloaded rlm-pixel\/index\.ts +37k \(4%\) · 42 tok\/s$/);
		expect(out.length).toBe(100);
	});

	it("cuts a long notice to the room left, never the right side", () => {
		const notice = `↻ reloaded ${"x".repeat(200)}.ts`;
		const out = infoLine(80, { left: "auto/best-free", context: "37k (4%)", segments: ["42 tok/s"], notice });
		expect(out.endsWith("37k (4%) · 42 tok/s")).toBe(true);
		expect(out).toContain("…");
		expect(out.length).toBe(80);
	});

	it("hides the notice when there is no room, and under an override label", () => {
		const tight = infoLine(40, { left: "← agents/resume  auto/best-free", context: "37k (4%)", notice: "↻ reloaded a.ts" });
		expect(tight).not.toContain("reloaded");
		const override = infoLine(100, { left: "x", override: "Press ctrl+c again to exit", context: "1k (0%)", notice: "↻ reloaded a.ts" });
		expect(override).not.toContain("reloaded");
	});

	it("renders exactly one line whatever the notice or segments", () => {
		const line = new SubagentSummaryLine(() => "m", () => "1k (0%)");
		line.setStatusSegmentsSource(() => ["a", "b"]);
		line.setNoticeSource(() => "↻ n");
		expect(line.render(100).length).toBe(1);
	});
});
