/**
 * The runtime calls rlm-agent's factory again for every in-process subagent,
 * passing that child's own SessionManager. The factory used to ignore it and
 * build every child on the parent's manager: each spawn's setSessionName
 * renamed the parent, concurrent children all reported the last name given
 * ({name:'s1'} and {name:'s2'} both listed as "s2"), and child transcripts
 * were written into the parent's session.
 */
import { describe, expect, it, vi } from "vitest";

const captured: { factory?: (options: any) => Promise<any> } = {};

vi.mock("../coding-agent/src/core/agent-session-runtime.js", () => ({
	createAgentSessionRuntime: async (factory: (options: any) => Promise<any>) => {
		captured.factory = factory;
		return {};
	},
}));

vi.mock("../coding-agent/src/config.js", () => ({ getAgentDir: () => "/tmp/agent-dir" }));

describe("rlm-agent runtime factory", () => {
	it("builds each runtime on the SessionManager the runtime passes in", async () => {
		const { RlmAgentService } = await import("./src/index.ts");
		const parentManager = { id: "parent" };
		const childManager = { id: "child" };
		// Plain `this`: the cordis Service constructor needs a live context.
		const service: any = {
			ctx: { get: () => undefined },
			config: { cwd: "/parent/cwd" },
			rlmSessionRef: { getSessionManager: () => parentManager },
		};
		const servicesCalls: any[] = [];
		const sessionCalls: any[] = [];
		service.createServices = async (opts: any) => {
			servicesCalls.push(opts);
			return { cwd: opts.cwd };
		};
		service.createSession = async (opts: any) => {
			sessionCalls.push(opts);
			return { session: { manager: opts.sessionManager } };
		};

		await RlmAgentService.prototype.createRuntime.call(service, {});
		expect(captured.factory).toBeDefined();

		// The parent runtime's own build: no override, so the row's manager.
		await captured.factory!({ cwd: "/parent/cwd", agentDir: "/tmp/agent-dir", sessionManager: parentManager });
		// A subagent build: its own manager and cwd must win.
		const child = await captured.factory!({ cwd: "/child/cwd", agentDir: "/tmp/agent-dir", sessionManager: childManager });

		expect(sessionCalls[0].sessionManager).toBe(parentManager);
		expect(sessionCalls[1].sessionManager).toBe(childManager);
		expect(child.session.manager).toBe(childManager);
		expect(servicesCalls[1].cwd).toBe("/child/cwd");
	});
});
