/**
 * End-to-end tests for dynamic auto-refine:
 * - ANY tool error triggers tool_error refine (no hardcoded patterns)
 * - 5+ tool calls triggers tool_discovery refine
 * - Auto-refine works at any depth (subagents too)
 * - Pending reviews are drained on disposal (learning never lost)
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("auto-refine: dynamic error and discovery triggers", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	async function createSession(opts: { depth?: number } = {}) {
		const tempDir = join(tmpdir(), `rlm-autorefine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, ".rlm", "agent"), { recursive: true });
		cleanupPaths.push(tempDir);

		const settingsManager = SettingsManager.inMemory({
			autoRefine: { enabled: true, turnInterval: 25, compact: true, cooldownMs: 0 },
		});

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: join(tempDir, ".rlm", "agent"),
			settingsManager,
			telemetryDisabled: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		const sessionManager = SessionManager.create(tempDir, join(tempDir, ".rlm", "agent", "sessions"));
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: { id: "test", provider: "test" } as any,
			tools: ["code"],
			telemetryDisabled: true,
			rlmDepth: opts.depth ?? 0,
		});

		return { session: result.session, tempDir };
	}

	it("tool error sets pending review with tool_error reason", async () => {
		const { session } = await createSession();
		const s = session as any;

		s._toolCallsThisTurn = 0;
		s._toolErrorsThisTurn = 0;

		await s.agent.afterToolCall({
			toolCall: { name: "code", id: "tc1", input: {} } as any,
			args: { code: "JSON.parse(undefined)" },
			result: { content: [{ type: "text", text: "SyntaxError: Unexpected token" }] } as any,
			isError: true,
		});

		expect(s._toolCallsThisTurn).toBe(1);
		expect(s._toolErrorsThisTurn).toBe(1);
		expect(s._pendingAutoRefineReview).toBeDefined();
		expect(s._pendingAutoRefineReview.reason).toBe("tool_error");
		expect(s._pendingAutoRefineReview.review.shouldRefine).toBe(true);
		expect(s._pendingAutoRefineReview.review.rationale).toContain("code");
		expect(s._pendingAutoRefineReview.review.rationale).toContain("SyntaxError");
		session.dispose();
	});

	it("any tool error triggers refine — not just hardcoded patterns", async () => {
		const { session } = await createSession();
		const s = session as any;

		const errorCases = [
			{ code: "undefinedVar.foo()", error: "TypeError: Cannot read properties of undefined" },
			{ code: "fetch('http://nonexistent')", error: "fetch failed" },
			{ code: "const x = ", error: "SyntaxError: Unexpected end of input" },
			{ code: "JSON.parse('{invalid}')", error: "SyntaxError: Unexpected token" },
			{ code: "require('nonexistent-pkg')", error: "Cannot find module" },
		];

		for (const { code, error } of errorCases) {
			s._pendingAutoRefineReview = undefined;
			s._toolCallsThisTurn = 0;
			s._toolErrorsThisTurn = 0;

			await s.agent.afterToolCall({
				toolCall: { name: "code", id: "tc1", input: {} } as any,
				args: { code },
				result: { content: [{ type: "text", text: error }] } as any,
				isError: true,
			});

			expect(s._pendingAutoRefineReview).toBeDefined();
			expect(s._pendingAutoRefineReview.reason).toBe("tool_error");
		}
		session.dispose();
	});

	it("5+ tool calls without errors triggers tool_discovery refine", async () => {
		const { session } = await createSession();
		const s = session as any;

		s._toolCallsThisTurn = 0;
		s._toolErrorsThisTurn = 0;

		for (let i = 0; i < 6; i++) {
			await s.agent.afterToolCall({
				toolCall: { name: "code", id: `tc${i}`, input: {} } as any,
				args: { code: `const x${i} = ${i}` },
				result: { content: [{ type: "text", text: String(i) }] } as any,
				isError: false,
			});
		}

		s._maybeScheduleDiscoveryRefine();

		expect(s._pendingAutoRefineReview).toBeDefined();
		expect(s._pendingAutoRefineReview.reason).toBe("tool_discovery");
		expect(s._pendingAutoRefineReview.review.shouldRefine).toBe(true);
		expect(s._pendingAutoRefineReview.review.rationale).toContain("6 tool calls");
		session.dispose();
	});

	it("fewer than 5 tool calls does NOT trigger discovery refine", async () => {
		const { session } = await createSession();
		const s = session as any;

		s._toolCallsThisTurn = 4;
		s._toolErrorsThisTurn = 0;
		s._pendingAutoRefineReview = undefined;

		s._maybeScheduleDiscoveryRefine();

		expect(s._pendingAutoRefineReview).toBeUndefined();
		session.dispose();
	});

	it("tool error takes priority over discovery (error refine scheduled first)", async () => {
		const { session } = await createSession();
		const s = session as any;

		s._toolCallsThisTurn = 0;
		s._toolErrorsThisTurn = 0;

		for (let i = 0; i < 5; i++) {
			await s.agent.afterToolCall({
				toolCall: { name: "code", id: `tc${i}`, input: {} } as any,
				args: { code: `const x${i} = ${i}` },
				result: { content: [{ type: "text", text: String(i) }] } as any,
				isError: false,
			});
		}
		await s.agent.afterToolCall({
			toolCall: { name: "code", id: "tc-err", input: {} } as any,
			args: { code: "broken.code(" },
			result: { content: [{ type: "text", text: "SyntaxError" }] } as any,
			isError: true,
		});

		expect(s._pendingAutoRefineReview).toBeDefined();
		expect(s._pendingAutoRefineReview.reason).toBe("tool_error");

		s._maybeScheduleDiscoveryRefine();
		expect(s._pendingAutoRefineReview.reason).toBe("tool_error");
		session.dispose();
	});

	it("auto-refine is allowed at any depth (subagents learn too)", async () => {
		const { session } = await createSession({ depth: 3 });
		const s = session as any;

		expect(s._autoRefineAllowedForSession()).toBe(true);

		await s.agent.afterToolCall({
			toolCall: { name: "code", id: "tc1", input: {} } as any,
			args: { code: "broken" },
			result: { content: [{ type: "text", text: "ReferenceError: broken is not defined" }] } as any,
			isError: true,
		});

		expect(s._pendingAutoRefineReview).toBeDefined();
		expect(s._pendingAutoRefineReview.reason).toBe("tool_error");
		session.dispose();
	});

	it("refinement instructions include reason-specific context", async () => {
		const { session } = await createSession();
		const s = session as any;

		await s.agent.afterToolCall({
			toolCall: { name: "code", id: "tc1", input: {} } as any,
			args: { code: "broken" },
			result: { content: [{ type: "text", text: "ReferenceError" }] } as any,
			isError: true,
		});

		const review = s._pendingAutoRefineReview;
		expect(review.review.instructions).toContain("prompt note");
		expect(review.review.instructions).toContain("memory");
		expect(review.review.instructions).toContain("skill");
		session.dispose();
	});

	it("no hardcoded patterns remain in the source", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(join(__dirname, "..", "src", "core", "agent-session.ts"), "utf-8");

		expect(source).not.toContain('"shell-as-js"');
		expect(source).not.toContain('"top-level-return"');
		expect(source).not.toContain("instructionsByPattern");
		expect(source).not.toContain("_toolErrorPatterns");
		expect(source).not.toContain("patterns: Array<{ key: string; test: RegExp");
	});
});
