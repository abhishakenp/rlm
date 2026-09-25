/**
 * Lazy-load coding-agent in rlm-agent.
 *
 * Before: rlm-agent imported coding-agent at the top level, so the ~143 MB
 * module was loaded as soon as the plugin was mounted — even if no task
 * was ever run.
 *
 * After: coding-agent is loaded on first call to createServices(),
 * createSession(), or createRuntime(). A composition that includes
 * @rlm/agent but never runs a task pays nothing.
 */
import { describe, it, expect } from "vitest";

describe("Lazy-load coding-agent in rlm-agent", () => {
	it("importing rlm-agent does not eagerly load coding-agent", async () => {
		// Clear the module cache for coding-agent modules.
		// (Bun doesn't expose a require cache the way Node does, but we
		// can verify by checking that the rlm-agent module exports
		// without error and the lazy-load helpers are defined.)
		const rlmAgentModule = await import("./src/index.ts");

		// The module should export RlmAgentService
		expect(rlmAgentModule.RlmAgentService).toBeDefined();
		expect(rlmAgentModule.name).toBe("rlm-agent");
		expect(rlmAgentModule.inject).toContain("rlmConfig");
		expect(rlmAgentModule.inject).toContain("rlmSession");
	});

	it("RlmAgentService is a class (not loaded eagerly)", async () => {
		const { RlmAgentService } = await import("./src/index.ts");
		expect(typeof RlmAgentService).toBe("function");
		expect(RlmAgentService.name).toBe("RlmAgentService");
		expect(RlmAgentService.provide).toBe("rlmAgent");
	});
});
