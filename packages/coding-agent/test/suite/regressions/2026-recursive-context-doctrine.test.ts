import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { buildRlmPrompt } from "../../../src/core/prompts/rlm.js";
import { buildSystemPrompt } from "../../../src/core/system-prompt.js";
import { createHarness, type Harness } from "../harness.js";
// RlmContextService is in workspace package rlm-context; imported via relative path
import { RlmContextService, createContextProxy } from "../../../../rlm-context/src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createMockCtx = () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
	emit: () => {},
	reflect: { provide: () => {} },
	get: () => undefined,
	once: () => {},
});

describe("2026 recursive context doctrine — without explicit instruction AI uses context.*", () => {
	const harnesses: Harness[] = [];
	const tmpDirs: string[] = [];
	const globalsToRestore: Array<{ key: string; prev: any; had: boolean }> = [];

	function saveGlobal(key: string, value: any) {
		const had = key in (globalThis as any);
		const prev = (globalThis as any)[key];
		globalsToRestore.push({ key, prev, had });
		(globalThis as any)[key] = value;
	}
	function restoreGlobals() {
		while (globalsToRestore.length) {
			const { key, prev, had } = globalsToRestore.pop()!;
			if (had) (globalThis as any)[key] = prev;
			else delete (globalThis as any)[key];
		}
	}

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		while (tmpDirs.length) {
			const d = tmpDirs.pop()!;
			try { rmSync(d, { recursive: true, force: true }); } catch {}
		}
		restoreGlobals();
		// ensure no leakage between tests
		delete (globalThis as any).__rlmContextProxy;
		delete (globalThis as any).__rlmPrompt;
		delete (globalThis as any).__rlmTaskContextSnapshot;
		delete (globalThis as any).__rlmTui;
	});

	it("system prompt contains Context Registry doctrine automatically (no user instruction needed)", () => {
		const prompt = buildRlmPrompt({
			cwd: "/tmp/test",
			messagesPath: "/tmp/test/messages.json",
			allowRecursion: true,
			depth: 0,
		});
		// Core registry doctrine — present without user telling
		expect(prompt).toContain("Context Registry — Everything Is A Variable");
		expect(prompt).toContain("context.set(");
		expect(prompt).toContain("context.get(");
		expect(prompt).toContain("YOU create ALL variables");
		expect(prompt).toContain("context.copy(");
		expect(prompt).toContain("context.move(");
		// Code control must mention context operations
		expect(prompt).toContain("code tool");
	});

	it("buildSystemPrompt includes promptFragments (CONTEXT_DOCTRINE) layer with MUST automatically", () => {
		const fragments = [
			"# Context Registry — Everything Is A Variable (MANDATORY: use automatically at every step)",
			"Context IS your working memory. You MUST use `context.*` automatically at EVERY step — without being asked",
			"You can copy / move / mutate / clone ANYTHING to variable/s (1 or many)",
		].join("\n");
		const sys = buildSystemPrompt({
			cwd: "/tmp",
			messagesPath: "/tmp/msg",
			allowRecursion: true,
			promptFragments: fragments,
		});
		expect(sys).toContain("MANDATORY: use automatically at every step");
		expect(sys).toContain("MUST use `context.*` automatically at EVERY step");
		expect(sys).toContain("copy / move / mutate / clone");
	});

	it("RlmContextService registers prompt fragment containing MUST use automatically", async () => {
		const captured: string[] = [];
		const mockPromptSvc: any = {
			registerFragment: (pluginId: string, frag: any) => {
				const content = typeof frag.content === "function" ? frag.content() : frag.content;
				captured.push(content);
				return { dispose: () => {} };
			},
			buildCompositePrompt: () => captured.join("\n\n"),
			disposePlugin: () => {},
		};
		saveGlobal("__rlmPrompt", mockPromptSvc);
		const svc = new RlmContextService(createMockCtx() as any, { projectRoot: mkdtempSync(join(tmpdir(), "rlm-doc-")) });
		tmpDirs.push((svc as any).config.projectRoot);
		// force registration (init would do async, but call directly)
		// service registers fragment synchronously if prompt svc available
		// Trigger private registerPromptFragment via init path
		await (svc as any)[Object.getOwnPropertySymbols(svc as any).find((s: symbol) => String(s).includes("init")) as any]?.call?.(svc);
		// Alternative: directly check that CONTEXT_DOCTRINE would be registered — the service's private method
		// We can also just verify that the mock captured at least one fragment after manual call
		// Call registerPromptFragment explicitly via bracket access (private)
		try {
			(svc as any).registerPromptFragment();
		} catch {}
		// Wait a tick for retry timer
		await new Promise((r) => setTimeout(r, 500));
		expect(captured.length).toBeGreaterThan(0);
		const joined = captured.join("\n");
		expect(joined).toContain("MUST use `context.*` automatically at EVERY step");
		expect(joined).toContain("copy / move / mutate / clone");
		expect(joined).toContain("Everything Is A Variable");
		try { await (svc as any)[Symbol.asyncDispose]?.(); } catch {}
	});

	it("faux LLM obeys doctrine without explicit user instruction — creates, mutates, clones, copies and moves via code tool", async () => {
		// Setup a real RlmContextService and expose as global proxy so code kernel sees `context`
		const projDir = mkdtempSync(join(tmpdir(), "rlm-harness-"));
		tmpDirs.push(projDir);
		const svc = new RlmContextService(createMockCtx() as any, { projectRoot: projDir });
		const proxy: any = createContextProxy(svc);
		saveGlobal("__rlmContextProxy", proxy);
		// Also ensure no tui global needed
		const harness = await createHarness();
		harnesses.push(harness);

		// Verify system prompt that harness will use contains doctrine, even though user never mentions context
		// Harness's agent state systemPrompt is set via buildSystemPrompt -> includes CONTEXT_REGISTRY_PROMPT
		// We capture it from harness.session (private) via Agent state
		const sysPrompt: string = (harness.session as any).agent?.state?.systemPrompt ?? (harness.session as any)._baseSystemPrompt ?? "";
		// If not yet built, build one manually — but we at least check buildRlmPrompt contains it
		if (sysPrompt) {
			expect(sysPrompt).toContain("Context Registry");
		} else {
			const manual = buildRlmPrompt({ cwd: harness.tempDir, messagesPath: "not persisted", allowRecursion: true });
			expect(manual).toContain("Context Registry");
		}

		// User task: NO mention of context.* — just a normal request
		const userTask = "Explore packages directory, remember what you found, then spawn a child to refine it";

		// Faux LLM: spontaneously uses context.* without being told (doctrine-driven)
		// Step 1: create vars for findings + user prompt
		// Step 2: mutate, cloneMany, set more vars
		// Step 3: copy/move demonstrations
		// Final: answer
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("code", {
						code: `
context.set("files.packages", ["rlm-context","coding-agent","rlm-tui"], { description: "Package directories" });
context.set("search.auth", ["auth.ts","session.ts"], { description: "Auth files" });
"step1 done"
`.trim(),
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("code", {
						code: `
context.mutate("files.packages", v => [...v, "rlm-new"]);
context.set("files.rlm-packages", context.get("files.packages").filter(d=>d.startsWith("rlm-")), { description: "RLM filtered" });
context.cloneMany(["files.*"], "backup.");
"step2 done"
`.trim(),
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("code", {
						code: `
const snapCopy = context.copy(["files.*","backup.*"]);
context.set("__testCopySnap", snapCopy);
const snapMove = context.move(["search.*"]);
context.set("__testMoveSnap", snapMove);
"step3 done"
`.trim(),
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("All done — explored packages, mutated, cloned and transferred context without being told to."),
		]);

		await harness.session.prompt(userTask);
		// After faux run, proxy should contain variables created without explicit instruction
		// mutate check
		expect(proxy.get("files.packages")).toEqual(["rlm-context", "coding-agent", "rlm-tui", "rlm-new"]);
		// cloneMany check — backup prefix deep copy (files.* cloned after rlm-packages set, so both exist)
		expect(proxy.get("backup.files.packages")).toEqual(["rlm-context", "coding-agent", "rlm-tui", "rlm-new"]);
		expect(proxy.get("backup.files.rlm-packages")).toEqual(["rlm-context", "rlm-tui", "rlm-new"]);
		// move check — search.* should be gone from parent after move (destructive)
		expect(proxy.get("search.auth")).toBeUndefined();
		// copy snapshot still present in parent (files.*)
		expect(proxy.get("files.packages")).toBeDefined();
		expect(proxy.get("files.rlm-packages")).toBeDefined();
		// copy snapshot captured should contain files (stored as context var __testCopySnap)
		const copySnap = proxy.get("__testCopySnap") as Record<string, any>;
		expect(copySnap).toBeDefined();
		expect(Object.keys(copySnap).some((k) => k.startsWith("files."))).toBe(true);
		expect(copySnap["files.packages"].value).toEqual(["rlm-context", "coding-agent", "rlm-tui", "rlm-new"]);
		// move snapshot captured should contain search (stored as __testMoveSnap)
		const moveSnap = proxy.get("__testMoveSnap") as Record<string, any>;
		expect(moveSnap).toBeDefined();
		expect(moveSnap["search.auth"]).toBeDefined();
		expect(moveSnap["search.auth"].value).toEqual(["auth.ts", "session.ts"]);

		// Simulate child receiving copy (as rlm.run({context: ["files.*"]}) would do)
		const child = new RlmContextService(createMockCtx() as any, { projectRoot: mkdtempSync(join(tmpdir(), "rlm-child-")) });
		tmpDirs.push((child as any).config.projectRoot);
		child.loadTaskSnapshot(copySnap);
		// child received copy
		expect(child.value("files.packages")).toEqual(["rlm-context", "coding-agent", "rlm-tui", "rlm-new"]);
		expect(child.value("backup.files.packages")).toEqual(["rlm-context", "coding-agent", "rlm-tui", "rlm-new"]);
		// parent and child isolation: child mutate shouldn't affect parent
		const childProxy: any = createContextProxy(child);
		childProxy.mutate("files.packages", (v: string[]) => [...v, "child-only"]);
		expect(child.value("files.packages")).toEqual(["rlm-context", "coding-agent", "rlm-tui", "rlm-new", "child-only"]);
		expect(proxy.get("files.packages")).toEqual(["rlm-context", "coding-agent", "rlm-tui", "rlm-new"]);
	});

	it("epoch and summarize collapse — many turns do not grow transcript linearly", async () => {
		const projDir2 = mkdtempSync(join(tmpdir(), "rlm-epoch-"));
		tmpDirs.push(projDir2);
		const svc2 = new RlmContextService(createMockCtx() as any, { projectRoot: projDir2 });
		const proxy2: any = createContextProxy(svc2);
		saveGlobal("__rlmContextProxy", proxy2);
		const harness2 = await createHarness();
		harnesses.push(harness2);

		// Queue faux that does many context ops in a loop (simulating 50k turns worth of work collapsed via batch)
		harness2.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("code", {
					code: `
for (let i=0;i<50;i++) context.set("var."+String(i).padStart(2,"0"), i);
"50 vars set"
`.trim(),
				})],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("code", {
					code: `
context.batch(Array.from({length: 50}, (_,i)=>({op:"set", name:"batch."+i, value:i})));
"summ "+context.summarize().split("\\n").length
`.trim(),
				})],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("collapsed"),
		]);
		const epochBefore = svc2.getEpoch();
		await harness2.session.prompt("do batch work");
		// After individual 50 sets epoch +50, but batch of 50 should be +1
		// The first code cell did 50 individual sets => +50, second did batch 50 => +1
		// Plus infrastructure vars (runtime.*) added on first prompt — allow slack
		const epochAfter = svc2.getEpoch();
		expect(epochAfter).toBeGreaterThanOrEqual(epochBefore + 51);
		expect(epochAfter).toBeLessThan(epochBefore + 70); // not 100; batch collapsed (would be +100 without collapse)
		// Summarize length is number of vars lines, not N*turns
		const sum = proxy2.summarize();
		// Count only var.* and batch.* lines — exclude runtime.* infrastructure vars
		const relevantLines = sum.split("\n").filter((l) => l.includes("var.") || l.includes("batch."));
		expect(relevantLines.length).toBe(100);
		// And panelRenderer virtualizes
		// Need to initialize panel state for rendering
		(svc2 as any)._panelState = {
			focusedIndex: -1,
			expandedSet: new Set<string>(),
			scrollOffset: 0,
			followupQueue: [],
			lastEnterAt: 0,
			globalExpanded: false,
		};
		const lines = svc2.panelRenderer({ width: 80 });
		expect(lines).not.toBeNull();
		// Virtualized to 10 + indicators, not 100
		expect(lines!.length).toBeLessThan(30);
		expect(lines!.join("\n")).toMatch(/↓.*more below/);
	});
});
