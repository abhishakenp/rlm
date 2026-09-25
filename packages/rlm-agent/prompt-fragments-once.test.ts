/**
 * rlmPrompt's fragments reach the system prompt through AgentSession itself
 * (`_getPromptFragments` → buildSystemPrompt's `promptFragments`). rlm-agent
 * used to append `buildCompositePrompt()` a second time through
 * `appendSystemPromptOverride`, so every fragment — context doctrine, SDK,
 * refine, pixel, plugin shelf, "how you are built" — was in the prompt twice
 * (measured: 85.6 KB → 56.6 KB once it went).
 */
import { describe, expect, it, vi } from "vitest";

const captured: any[] = [];
vi.mock("../coding-agent/src/core/agent-session-services.js", () => ({
	createAgentSessionServices: async (options: any) => {
		captured.push(options);
		return {};
	},
}));
vi.mock("../coding-agent/src/config.js", () => ({ getAgentDir: () => "/tmp/agent-dir" }));

describe("rlm-agent services and prompt fragments", () => {
	it("does not append the rlmPrompt composite itself (AgentSession already adds it)", async () => {
		(globalThis as any).__rlmPrompt = { buildCompositePrompt: () => "# FRAGMENT" };
		try {
			const { RlmAgentService } = await import("./src/index.ts");
			const self: any = { ctx: { get: () => undefined }, config: { cwd: "/cwd" }, services: undefined };
			await RlmAgentService.prototype.createServices.call(self, {});
			const loader = captured.at(-1)?.resourceLoaderOptions ?? {};
			const appended = loader.appendSystemPromptOverride?.([]) ?? [];
			expect(appended.join("\n")).not.toContain("# FRAGMENT");
			expect("extensionFactories" in loader).toBe(true);
		} finally {
			delete (globalThis as any).__rlmPrompt;
		}
	});
});
