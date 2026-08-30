/**
 * End-to-end integration test: tool error → auto-refine → harness entry created.
 *
 * This test verifies the FULL chain:
 * 1. Tool errors (any error, no hardcoded patterns)
 * 2. Pending review is set with tool_error reason
 * 3. _runApprovedRefine is called (via disposal drain)
 * 4. refine() calls planRefinement() which calls completeSimple (mocked)
 * 5. The returned proposal is applied to the harness
 * 6. The harness entry persists on disk
 *
 * Also tests:
 * - tool_discovery trigger (5+ tool calls)
 * - Subagent depth (auto-refine at depth > 0)
 * - Cross-session persistence (global harness entry survives new session)
 * - Disposal drain (pending review runs before session ends)
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PiAi from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { loadHarnessState } from "../src/core/refinement/index.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function assistantText(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		stopReason: "end_turn" as const,
		usage: { inputTokens: 10, outputTokens: 5 },
	};
}

function refinementProposal(edits: any[], summary = "Learn from error", rationale = "Tool error occurred") {
	return assistantText(
		JSON.stringify({
			summary,
			rationale,
			expectedOutcome: "Future sessions avoid this error.",
			edits,
		}),
	);
}

describe("auto-refine end-to-end: error → learn → persist", () => {
	let tempDir: string | undefined;
	const unregisters: Array<() => void> = [];
	const tempDirs: string[] = [];

	beforeEach(() => {
		completeSimpleMock.mockReset();
	});

	afterEach(() => {
		while (unregisters.length > 0) {
			unregisters.pop()?.();
		}
		for (const dir of tempDirs) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		tempDirs.length = 0;
		tempDir = undefined;
	});

	async function createSession(opts: { depth?: number; agentDir?: string } = {}) {
		const dir = opts.agentDir ?? mkdtempSync(join(tmpdir(), "rlm-autorefine-e2e-"));
		if (!tempDirs.includes(dir)) tempDirs.push(dir);
		mkdirSync(join(dir, ".rlm", "agent"), { recursive: true });

		const settingsManager = SettingsManager.inMemory({
			autoRefine: { enabled: true, turnInterval: 25, compact: true, cooldownMs: 0 },
		});

		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: join(dir, ".rlm", "agent"),
			settingsManager,
			telemetryDisabled: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		// Register faux provider with the model registry (not just auth storage).
		const faux = registerFauxProvider();
		unregisters.push(() => faux.unregister());
		services.authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		services.modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});

		const sessionManager = SessionManager.create(dir, join(dir, ".rlm", "agent", "sessions"));
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
			tools: ["code"],
			telemetryDisabled: true,
			rlmDepth: opts.depth ?? 0,
		});

		return { session: result.session, dir, services, faux };
	}

	function getLocalHarnessDir(session: any): string {
		const sessionArtifactDir = session.sessionManager?.getSessionArtifactDir?.();
		return sessionArtifactDir ? join(sessionArtifactDir, "harness") : join(session._cwd ?? ".", ".rlm", "agent");
	}

	it("FULL CHAIN: tool error → refine runs → memory created on disk", async () => {
		const { session } = await createSession();
		const s = session as any;

		completeSimpleMock.mockResolvedValueOnce(
			refinementProposal([
				{
					action: "create",
					kind: "memory",
					id: "js_json_parse_needs_valid_string",
					title: "JSON.parse requires valid string input",
					content: "JSON.parse(undefined) throws SyntaxError. Always pass a valid JSON string.",
				},
			]),
		);

		// 1. Trigger a tool error.
		await s.agent.afterToolCall({
			toolCall: { name: "code", id: "tc1", input: {} } as any,
			args: { code: "JSON.parse(undefined)" },
			result: { content: [{ type: "text", text: "SyntaxError: Unexpected token" }] } as any,
			isError: true,
		});

		// 2. Verify pending review is set.
		expect(s._pendingAutoRefineReview).toBeDefined();
		expect(s._pendingAutoRefineReview.reason).toBe("tool_error");

		// 3. Run the approved refine directly.
		const review = s._pendingAutoRefineReview;
		await s._runApprovedRefine(review.reason, review.review);

		// 4. Verify completeSimple was called (model was invoked for refinement).
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);

		// 5. Verify the harness entry was created on disk (local harness).
		const localHarnessDir = getLocalHarnessDir(s);
		const state = loadHarnessState(localHarnessDir, "local");
		expect(state.entries.memory?.js_json_parse_needs_valid_string).toBeDefined();
		expect(state.entries.memory?.js_json_parse_needs_valid_string?.title).toBe(
			"JSON.parse requires valid string input",
		);

		// 6. Verify pending review was cleared.
		expect(s._pendingAutoRefineReview).toBeUndefined();

		session.dispose();
	});

	it("FULL CHAIN: discovery (5+ tool calls) → refine runs → memory created", async () => {
		const { session } = await createSession();
		const s = session as any;

		completeSimpleMock.mockResolvedValueOnce(
			refinementProposal(
				[
					{
						action: "create",
						kind: "memory",
						id: "project_uses_cordis_loader",
						title: "Project uses Cordis Loader for plugin management",
						content: "Plugins are loaded via @deepseek-ai/cordis-plugin-loader, not manual imports.",
					},
				],
				"Persist project structure discovery",
				"Discovered project uses Cordis Loader after multiple tool calls",
			),
		);

		// Simulate 6 successful tool calls (discovery).
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

		// Trigger discovery refine.
		s._maybeScheduleDiscoveryRefine();
		expect(s._pendingAutoRefineReview).toBeDefined();
		expect(s._pendingAutoRefineReview.reason).toBe("tool_discovery");

		// Run the approved refine.
		const review = s._pendingAutoRefineReview;
		await s._runApprovedRefine(review.reason, review.review);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);

		const localHarnessDir = getLocalHarnessDir(s);
		const state = loadHarnessState(localHarnessDir, "local");
		expect(state.entries.memory?.project_uses_cordis_loader).toBeDefined();

		session.dispose();
	});

	it("FULL CHAIN: subagent at depth 3 → tool error → refine runs → memory created", async () => {
		const { session } = await createSession({ depth: 3 });
		const s = session as any;

		completeSimpleMock.mockResolvedValueOnce(
			refinementProposal([
				{
					action: "create",
					kind: "memory",
					id: "subagent_lesson_avoids_undefined_vars",
					title: "Avoid undefined variables in subagent code",
					content: "Subagent at depth 3 learned: always check variables before use.",
				},
			]),
		);

		// Trigger tool error at depth 3.
		await s.agent.afterToolCall({
			toolCall: { name: "code", id: "tc1", input: {} } as any,
			args: { code: "undefinedVar.foo()" },
			result: { content: [{ type: "text", text: "TypeError: Cannot read properties of undefined" }] } as any,
			isError: true,
		});

		expect(s._pendingAutoRefineReview).toBeDefined();
		expect(s._pendingAutoRefineReview.reason).toBe("tool_error");

		const review = s._pendingAutoRefineReview;
		await s._runApprovedRefine(review.reason, review.review);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);

		const localHarnessDir = getLocalHarnessDir(s);
		const state = loadHarnessState(localHarnessDir, "local");
		expect(state.entries.memory?.subagent_lesson_avoids_undefined_vars).toBeDefined();

		session.dispose();
	});

	it("CROSS-SESSION: global memory created in session 1 is visible in session 2", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rlm-autorefine-cross-session-"));
		if (!tempDirs.includes(dir)) tempDirs.push(dir);
		const agentDir = join(dir, ".rlm", "agent");
		mkdirSync(agentDir, { recursive: true });

		// Point the global agent dir at our temp dir so global harness state is isolated.
		vi.stubEnv("RLM_CODING_AGENT_DIR", agentDir);

		// Session 1: create a global memory via tool error refine.
		const { session: session1 } = await createSession({ agentDir: dir });
		const s1 = session1 as any;

		completeSimpleMock.mockResolvedValueOnce(
			refinementProposal([
				{
					action: "create",
					kind: "memory",
					id: "cross_session_lesson",
					title: "Always validate file existence before reading",
					content: "Use fs.existsSync() before fs.readFileSync() to avoid ENOENT errors.",
				},
			]),
		);

		await s1.agent.afterToolCall({
			toolCall: { name: "code", id: "tc1", input: {} } as any,
			args: { code: "fs.readFileSync('/nonexistent')" },
			result: { content: [{ type: "text", text: "Error: ENOENT" }] } as any,
			isError: true,
		});

		// Use global refinement so the memory persists across sessions.
		const review1 = s1._pendingAutoRefineReview;
		await s1.refine({
			instructions: `Automatic refine review triggered by tool_error. ${review1.review.instructions}`,
			global: true,
		}, { trigger: "auto" });

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		session1.dispose();

		// Verify global memory exists on disk (global harness dir is agentDir/harness).
		const globalHarnessDir = join(agentDir, "harness");
		const state1 = loadHarnessState(globalHarnessDir, "global");
		expect(state1.entries.memory?.cross_session_lesson).toBeDefined();

		// Session 2: load the same agent dir — global memory should be visible.
		const { session: session2 } = await createSession({ agentDir: dir });
		const s2 = session2 as any;

		// The merged harness state should include the global memory.
		const mergedState = s2._loadMergedHarnessState();
		expect(mergedState.entries.memory?.cross_session_lesson).toBeDefined();
		expect(mergedState.entries.memory?.cross_session_lesson?.title).toBe(
			"Always validate file existence before reading",
		);

		session2.dispose();
		vi.unstubAllEnvs();
	});

	it("DISPOSAL DRAIN: pending review runs on disposeAsync (learning never lost)", async () => {
		const { session } = await createSession();
		const s = session as any;

		completeSimpleMock.mockResolvedValueOnce(
			refinementProposal([
				{
					action: "create",
					kind: "memory",
					id: "disposal_drain_lesson",
					title: "Disposal drain preserves pending reviews",
					content: "Pending auto-refine reviews are drained before disposal.",
				},
			]),
		);

		// Trigger tool error.
		await s.agent.afterToolCall({
			toolCall: { name: "code", id: "tc1", input: {} } as any,
			args: { code: "broken" },
			result: { content: [{ type: "text", text: "ReferenceError" }] } as any,
			isError: true,
		});

		expect(s._pendingAutoRefineReview).toBeDefined();

		// Dispose — should drain the pending review.
		await session.disposeAsync();

		// Verify the model was called during disposal.
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);

		// Verify memory was created in the session artifact harness dir.
		const localHarnessDir = getLocalHarnessDir(s);
		const state = loadHarnessState(localHarnessDir, "local");
		expect(state.entries.memory?.disposal_drain_lesson).toBeDefined();
	});

	it("REPEATED ERRORS: different error types all trigger refine (no hardcode)", async () => {
		const { session } = await createSession();
		const s = session as any;

		const errorTypes = [
			{ code: "x.y.z()", error: "TypeError: x.y is undefined" },
			{ code: "fetch('bad-url')", error: "fetch failed" },
			{ code: "const = = ", error: "SyntaxError" },
			{ code: "JSON.parse('')", error: "SyntaxError: Unexpected end" },
			{ code: "require('nonexistent')", error: "MODULE_NOT_FOUND" },
			{ code: "process.exit(1)", error: "process exited" },
			{ code: "await x", error: "await outside async" },
		];

		for (const { code, error } of errorTypes) {
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
			expect(s._pendingAutoRefineReview.review.rationale).toContain(error.slice(0, 20));
		}

		session.dispose();
	});
});
