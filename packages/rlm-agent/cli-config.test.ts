/**
 * The runtime hands rlm-agent's factory the command line as `sessionConfig`
 * (built by `runtimeConfigFromArgs`). The factory used to drop it, so on the
 * Cordis launch path `--model`, `--thinking`, `--tools`, `--system-prompt`,
 * `--skill` … were all ignored: `rlm --print --model cliproxy/gpt-5.5` answered
 * on the default model.
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

const chosenModel = { provider: "beta", id: "gpt-9" };
vi.mock("../coding-agent/src/cli/runtime-args.js", () => ({
	resourceLoaderOptionsFromConfig: (config: any) => ({ systemPrompt: config.systemPrompt }),
	sessionOptionsFromConfig: async ({ config }: any) => ({
		scopedModels: [],
		sessionOptions: config.model ? { model: chosenModel, thinkingLevel: config.thinking } : {},
		cliThinkingFromModel: false,
		diagnostics: [],
	}),
	resolveRuntimeSessionOptions: (fromConfig: any, override: any) => ({ ...fromConfig, ...(override ?? {}) }),
}));

describe("rlm-agent runtime factory and the command line", () => {
	const build = async () => {
		const { RlmAgentService } = await import("./src/index.ts");
		const service: any = {
			ctx: { get: () => undefined },
			config: { cwd: "/cwd" },
			rlmSessionRef: { getSessionManager: () => ({ id: "m" }) },
		};
		const servicesCalls: any[] = [];
		const sessionCalls: any[] = [];
		service.createServices = async (opts: any) => {
			servicesCalls.push(opts);
			return {};
		};
		service.createSession = async (opts: any) => {
			sessionCalls.push(opts);
			return { session: { model: opts.model, thinkingLevel: opts.thinkingLevel, setThinkingLevel: () => {} } };
		};
		await RlmAgentService.prototype.createRuntime.call(service, {});
		return { servicesCalls, sessionCalls };
	};

	it("applies sessionConfig: model, thinking, resource options, execution mode", async () => {
		const { servicesCalls, sessionCalls } = await build();
		await captured.factory!({
			cwd: "/cwd",
			agentDir: "/tmp/agent-dir",
			sessionConfig: { model: "beta/gpt-9", thinking: "high", systemPrompt: "S", executionMode: "print", serializedRefine: true },
		});
		expect(sessionCalls[0].model).toBe(chosenModel);
		expect(sessionCalls[0].thinkingLevel).toBe("high");
		expect(sessionCalls[0].executionMode).toBe("print");
		expect(sessionCalls[0].serializedRefine).toBe(true);
		expect(servicesCalls[0].resourceLoaderOptions).toEqual({ systemPrompt: "S" });
	});

	it("without a sessionConfig builds exactly as before", async () => {
		const { servicesCalls, sessionCalls } = await build();
		await captured.factory!({ cwd: "/cwd", agentDir: "/tmp/agent-dir", sessionOptions: { rlmDepth: 1 } });
		expect(servicesCalls[0].resourceLoaderOptions).toBeUndefined();
		expect(sessionCalls[0].model).toBeUndefined();
		expect(sessionCalls[0].rlmDepth).toBe(1);
	});
});
