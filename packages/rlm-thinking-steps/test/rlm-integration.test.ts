/**
 * rlm integration: the row, the live AssistantMessageComponent the TUI renders
 * with (packages/coding-agent/src, not dist), and rlm's thinking sources.
 *
 * Upstream's own suites (thinking-steps / summarizer-challenger) cover parsing
 * and rendering; this file covers what the port changed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InlineThinkSplitter } from "../../ai/src/providers/inline-think.ts";
import { AssistantMessageComponent } from "../../coding-agent/src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";
import { retainThinkingStepsPatch } from "../src/internal-patch.ts";
import { apply, liveModeFile } from "../src/row.ts";
import { getCurrentThinkingScopeKey, getThinkingStepsMode, setThinkingStepsMode } from "../src/state.ts";

const waitFor = async (check: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (c: { render(w: number): string[] }) => c.render(100).map(strip).join("\n");

/** A real MiniMax stream (captured by worker F) split the way the openai-completions provider does. */
const minimaxMessage = () => {
	const chunks = JSON.parse(
		readFileSync(join(import.meta.dir, "../../ai/test/fixtures/minimax-think-balanced-twice.json"), "utf8"),
	) as Array<{ choices: Array<{ delta?: { content?: string } }> }>;
	const splitter = new InlineThinkSplitter();
	const content: Array<{ type: "thinking"; thinking: string } | { type: "text"; text: string }> = [];
	const add = (kind: "thinking" | "text", text: string) => {
		const last = content[content.length - 1];
		if (kind === "thinking") {
			if (last?.type === "thinking") last.thinking += text;
			else content.push({ type: "thinking", thinking: text });
		} else if (last?.type === "text") last.text += text;
		else content.push({ type: "text", text });
	};
	for (const chunk of chunks) {
		const delta = chunk.choices?.[0]?.delta?.content;
		if (delta) for (const seg of splitter.push(delta)) add(seg.kind, seg.text);
	}
	for (const seg of splitter.flush()) add(seg.kind, seg.text);
	return {
		role: "assistant" as const,
		content,
		api: "openai-completions",
		provider: "omniroute",
		model: "auto/best-free",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: 1_790_000_000_000,
	};
};

describe("rlm row", () => {
	it("mounts live: contributes the extension, installs the render patch in this process, and removes both on dispose", async () => {
		const home = mkdtempSync(join(tmpdir(), "ts-row-"));
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			initTheme("dark", false);
			const disposers: Array<() => void> = [];
			const emitted: string[] = [];
			const ctx = { effect: (fn: () => () => void) => disposers.push(fn()), emit: (e: string) => emitted.push(e) };
			const message = minimaxMessage();
			expect(render(new AssistantMessageComponent(message as never))).not.toContain("Thinking Steps");

			apply(ctx);
			const reg = (globalThis as { __rlmExtensionFactories?: Array<{ id: string }> }).__rlmExtensionFactories ?? [];
			expect(reg.filter((e) => e.id === "rlm-thinking-steps")).toHaveLength(1);
			expect(emitted).toContain("rlm/resources-changed");
			// No session_start happened: the row itself patched the renderer.
			await waitFor(() => render(new AssistantMessageComponent(message as never)).includes("Thinking Steps"));

			for (const d of disposers) d();
			expect(reg.filter((e) => e.id === "rlm-thinking-steps")).toHaveLength(0);
			await waitFor(() => !render(new AssistantMessageComponent(message as never)).includes("Thinking Steps"));
		} finally {
			process.env.HOME = prevHome;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("carries a mode chosen in another rlm process to this one", async () => {
		const home = mkdtempSync(join(tmpdir(), "ts-live-"));
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		const disposers: Array<() => void> = [];
		try {
			apply({ effect: (fn: () => () => void) => disposers.push(fn()), emit: () => {} }, { syncIntervalMs: 20 });
			setThinkingStepsMode("summary", getCurrentThinkingScopeKey());
			mkdirSync(join(home, ".rlm", "agent", "state"), { recursive: true });
			writeFileSync(liveModeFile(), JSON.stringify({ mode: "expanded", pid: process.pid + 1, at: Date.now() + 1000 }));
			await waitFor(() => getThinkingStepsMode() === "expanded");
			// And a change here is published for the others.
			setThinkingStepsMode("collapsed", getCurrentThinkingScopeKey());
			expect(JSON.parse(readFileSync(liveModeFile(), "utf8"))).toMatchObject({ mode: "collapsed", pid: process.pid });
		} finally {
			for (const d of disposers) d();
			process.env.HOME = prevHome;
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("patch on rlm's live AssistantMessageComponent", () => {
	let release: (() => Promise<void>) | undefined;
	let before = "";
	const message = minimaxMessage();

	beforeAll(async () => {
		initTheme("dark", false);
		before = render(new AssistantMessageComponent(message as never));
		release = await retainThinkingStepsPatch();
	});
	afterAll(async () => {
		await release?.();
	});

	it("splits a real inline-<think> MiniMax stream into thinking + text blocks", () => {
		expect(message.content.some((c) => c.type === "thinking" && c.thinking.trim().length > 0)).toBe(true);
		expect(message.content.some((c) => c.type === "text" && c.text.includes("pong"))).toBe(true);
		expect(JSON.stringify(message.content)).not.toContain("<think>");
	});

	it("replaces rlm's thinking rendering with Thinking Steps in every mode, text untouched", () => {
		const out: Record<string, string> = {};
		for (const mode of ["collapsed", "summary", "expanded"] as const) {
			setThinkingStepsMode(mode);
			out[mode] = render(new AssistantMessageComponent(message as never));
			expect(out[mode]).toContain("pong");
			expect(out[mode]).not.toContain("<think>");
		}
		expect(before).not.toContain("Thinking Steps");
		expect(out.summary).toContain("Thinking Steps · Summary");
		expect(out.expanded).toContain("Thinking Steps · Expanded");
		expect(out.expanded.length).toBeGreaterThan(out.summary.length);
		console.log(`--- before (rlm default)\n${before}\n--- collapsed\n${out.collapsed}\n--- summary\n${out.summary}\n--- expanded\n${out.expanded}`);
	});

	it("keeps rlm's retried-error line, rendering lazily through reconcile()", () => {
		setThinkingStepsMode("summary");
		const c = new AssistantMessageComponent(undefined as never);
		c.updateContent({ ...message, stopReason: "error", errorMessage: "Connection error." } as never);
		(c as unknown as { markRetried(): void }).markRetried();
		const out = render(c);
		expect(out).toContain("Thinking Steps · Summary");
		expect(out).toContain("↻ Connection error. — retried");
		expect(out).not.toContain("Error: Connection error.");
	});

	it("streams: steps are throttled while thinking, exact once thinking ends; theme invalidate rebuilds", async () => {
		const { setActiveThinkingState, clearActiveThinkingState } = await import("../src/state.ts");
		setThinkingStepsMode("expanded");
		const c = new AssistantMessageComponent(undefined as never);
		const partial = (thinking: string) => ({ ...message, content: [{ type: "thinking", thinking }] }) as never;
		setActiveThinkingState({ active: true, messageTimestamp: message.timestamp, contentIndex: 0 });
		c.updateContent(partial("Inspect the renderer."));
		expect(render(c)).toContain("Inspect the renderer.");
		// Within the throttle window a new trace is not re-derived yet…
		c.updateContent(partial("Inspect the renderer.\n\nCompare the toggle path."));
		expect(render(c)).not.toContain("Compare the toggle path.");
		// …and once thinking ends the complete trace is always shown.
		clearActiveThinkingState(message.timestamp);
		c.updateContent(partial("Inspect the renderer.\n\nCompare the toggle path."));
		expect(render(c)).toContain("Compare the toggle path.");
		// A theme change clears rlm's signature; the next frame rebuilds from scratch.
		c.invalidate();
		expect(render(c)).toContain("Compare the toggle path.");
	});

	it("hideThinkingBlock=true shows the step tree, never rlm's collapsed row or raw <think> tags", () => {
		setThinkingStepsMode("summary");
		const leaky = {
			...message,
			content: [
				{ type: "thinking", thinking: "<think>Despite the bug, some subagents completed successfully.\n\nLet me check the research directory." },
				{ type: "text", text: "Checked." },
			],
		};
		const out = render(new AssistantMessageComponent(leaky as never, true));
		expect(out).toContain("Thinking Steps · Summary");
		expect(out).toContain("Despite the bug, some subagents completed successfully.");
		expect(out).not.toMatch(/<\/?think/);
		expect(out).not.toContain("Thinking...");
	});

	it("Ctrl+T maps to the plugin: hidden → summary tree, visible → expanded", () => {
		setThinkingStepsMode("summary");
		render(new AssistantMessageComponent(message as never, true)); // baseline: hidden
		// rlm rebuilds the chat on Ctrl+T, handing each component the new value.
		expect(render(new AssistantMessageComponent(message as never, false))).toContain("Thinking Steps · Expanded");
		expect(getThinkingStepsMode()).toBe("expanded");
		expect(render(new AssistantMessageComponent(message as never, true))).toContain("Thinking Steps · Summary");
		expect(getThinkingStepsMode()).toBe("summary");
	});

	it("keeps rendering after the patch is released (original renderer restored)", async () => {
		await release?.();
		release = undefined;
		const restored = render(new AssistantMessageComponent(message as never));
		expect(restored).not.toContain("Thinking Steps");
		expect(restored).toBe(before);
	});
});
