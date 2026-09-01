/**
 * Learnings-in-prompt test — verifies the full pipeline:
 * 1. rlm-learn registers a prompt fragment with rlmPrompt
 * 2. buildLearningsPrompt() reads from learnings.jsonl
 * 3. Failures appear in the prompt content
 * 4. buildCompositePrompt() includes the learnings fragment
 * 5. onWorkflowError appends failure to learnings.jsonl
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const learningsPath = join(homedir(), ".rlm", "agent", "workflows", "learnings.jsonl");
const backupPath = learningsPath + ".test-backup";

function backupLearnings() {
	if (existsSync(learningsPath)) {
		writeFileSync(backupPath, readFileSync(learningsPath, "utf-8"), "utf-8");
	}
}

function restoreLearnings() {
	if (existsSync(backupPath)) {
		writeFileSync(learningsPath, readFileSync(backupPath, "utf-8"), "utf-8");
		try { rmSync(backupPath); } catch {}
	} else {
		try { rmSync(learningsPath); } catch {}
	}
}

function writeLearnings(entries: any[]) {
	const lines = entries.map((e) => JSON.stringify(e));
	writeFileSync(learningsPath, lines.join("\n") + "\n", "utf-8");
}

// Minimal Cordis context mock — Service base class needs ctx.reflect.provide.
const createMockCtx = () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
	emit: () => {},
	on: () => () => {},
	get: () => null,
	reflect: { provide: () => {} },
});

describe("learnings-in-prompt", () => {
	beforeEach(() => backupLearnings());
	afterEach(() => restoreLearnings());

	it("buildLearningsPrompt returns undefined when no learnings", async () => {
		writeLearnings([]);
		const { RlmLearnService } = await import("../src/index.ts");
		const svc = new RlmLearnService(createMockCtx() as any, {});
		(svc as any).learningsPath = learningsPath;
		expect(svc.buildLearningsPrompt()).toBeUndefined();
	});

	it("buildLearningsPrompt includes failures", async () => {
		writeLearnings([
			{ timestamp: Date.now(), workflow: "test-workflow", input: "test", error: "SyntaxError: unexpected token", durationMs: 100, success: false },
			{ timestamp: Date.now(), workflow: "test-workflow", input: "test", result: "OK", durationMs: 50, success: true },
		]);
		const { RlmLearnService } = await import("../src/index.ts");
		const svc = new RlmLearnService(createMockCtx() as any, {});
		(svc as any).learningsPath = learningsPath;
		const prompt = svc.buildLearningsPrompt();
		expect(prompt).toBeDefined();
		expect(prompt).toContain("Past Learnings");
		expect(prompt).toContain("[FAIL]");
		expect(prompt).toContain("test-workflow");
		expect(prompt).toContain("SyntaxError: unexpected token");
		expect(prompt).not.toContain("[OK]");
	});

	it("buildLearningsPrompt includes low-score reviews", async () => {
		writeLearnings([
			{ timestamp: Date.now(), type: "review", workflow: "delegator", step: "implement", score: 2, attempt: 1 },
			{ timestamp: Date.now(), type: "review", workflow: "delegator", step: "implement", score: 5, attempt: 2 },
		]);
		const { RlmLearnService } = await import("../src/index.ts");
		const svc = new RlmLearnService(createMockCtx() as any, {});
		(svc as any).learningsPath = learningsPath;
		const prompt = svc.buildLearningsPrompt();
		expect(prompt).toBeDefined();
		expect(prompt).toContain("[LOW SCORE]");
		expect(prompt).toContain("score 2/5");
		expect(prompt).not.toContain("score 5/5");
	});

	it("buildLearningsPrompt includes reflection patterns", async () => {
		writeLearnings([
			{ timestamp: Date.now(), type: "reflection", patterns: ["parallel spawns faster", "file fan-in more reliable"], proposals: 1, summary: "test" },
		]);
		const { RlmLearnService } = await import("../src/index.ts");
		const svc = new RlmLearnService(createMockCtx() as any, {});
		(svc as any).learningsPath = learningsPath;
		const prompt = svc.buildLearningsPrompt();
		expect(prompt).toBeDefined();
		expect(prompt).toContain("[PATTERNS]");
		expect(prompt).toContain("parallel spawns faster");
	});

	it("prompt fragment registers with rlmPrompt service", async () => {
		writeLearnings([]);
		const { RlmLearnService } = await import("../src/index.ts");
		const { RlmPromptService } = await import("../../rlm-prompt/src/index.ts");

		const promptSvc = new RlmPromptService(createMockCtx() as any, {});
		(globalThis as any).__rlmPrompt = promptSvc;

		const learnSvc = new RlmLearnService(createMockCtx() as any, {});
		(learnSvc as any).learningsPath = learningsPath;
		(learnSvc as any)._registerPromptFragment();

		const fragments = promptSvc.getFragments();
		expect(fragments.length).toBeGreaterThan(0);
		const learnFragment = fragments.find((f: any) => f.id === "past-learnings");
		expect(learnFragment).toBeDefined();
		expect(learnFragment.pluginId).toBe("rlm-learn");

		promptSvc.disposePlugin("rlm-learn");
		delete (globalThis as any).__rlmPrompt;
	});

	it("buildCompositePrompt includes learnings when failures exist", async () => {
		writeLearnings([
			{ timestamp: Date.now(), workflow: "failing-workflow", error: "TypeError: cannot read property", durationMs: 100, success: false },
		]);
		const { RlmLearnService } = await import("../src/index.ts");
		const { RlmPromptService } = await import("../../rlm-prompt/src/index.ts");

		const promptSvc = new RlmPromptService(createMockCtx() as any, {});
		(globalThis as any).__rlmPrompt = promptSvc;

		const learnSvc = new RlmLearnService(createMockCtx() as any, {});
		(learnSvc as any).learningsPath = learningsPath;
		(learnSvc as any)._registerPromptFragment();

		promptSvc.registerFragment("test-plugin", {
			id: "test-frag",
			priority: 100,
			content: "## Test Fragment\nThis is a test.",
		});

		const composite = promptSvc.buildCompositePrompt();
		expect(composite).toContain("Test Fragment");
		expect(composite).toContain("Past Learnings");
		expect(composite).toContain("failing-workflow");
		expect(composite).toContain("TypeError: cannot read property");

		promptSvc.disposePlugin("rlm-learn");
		promptSvc.disposePlugin("test-plugin");
		delete (globalThis as any).__rlmPrompt;
	});

	it("onWorkflowError appends failure to learnings.jsonl", async () => {
		writeLearnings([]);
		const { RlmLearnService } = await import("../src/index.ts");
		const svc = new RlmLearnService(createMockCtx() as any, {});
		(svc as any).learningsPath = learningsPath;

		(svc as any).onWorkflowError({ name: "test-err-workflow", error: "test error message" });

		const content = readFileSync(learningsPath, "utf-8");
		const entries = content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
		const lastEntry = entries[entries.length - 1];
		expect(lastEntry.workflow).toBe("test-err-workflow");
		expect(lastEntry.success).toBe(false);
		expect(lastEntry.error).toContain("test error message");
	});
});
