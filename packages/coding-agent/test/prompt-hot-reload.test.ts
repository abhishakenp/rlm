import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * A skill or AGENTS.md edited while the agent works must reach the agent's
 * very next model request — between two tool calls of the same run — not the
 * next run, and never only after a restart.
 */

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason,
	timestamp: Date.now(),
});

const writeSkill = (agentDir: string, name: string, description: string) => {
	const dir = join(agentDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
};

/** The cordis event surface the session listens on, minus cordis. */
const createBus = () => {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on: (event: string, fn: (data: unknown) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
			return () => {};
		},
		emit: (event: string, data?: unknown) => {
			for (const fn of handlers.get(event) ?? []) fn(data);
		},
	};
};

describe("prompt inputs hot reload", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let session: AgentSession | undefined;
	const g = globalThis as { __rlmCordisContext?: unknown };
	let previousCtx: unknown;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prompt-hot-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		previousCtx = g.__rlmCordisContext;
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		g.__rlmCordisContext = previousCtx;
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("reloadPromptInputs picks up a new skill and context file without touching extensions", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
		await loader.reload();
		const extensionsBefore = loader.getExtensions();
		expect(loader.getSkills().skills.map((s) => s.name)).not.toContain("probe-skill");
		expect(loader.promptFilesChanged()).toBe(false);

		writeSkill(agentDir, "probe-skill", "PROBE_SKILL_MARKER");
		writeFileSync(join(cwd, "AGENTS.md"), "PROBE_AGENTS_MARKER\n");
		expect(loader.promptFilesChanged()).toBe(true);

		await loader.reloadPromptInputs();
		expect(loader.getSkills().skills.map((s) => s.name)).toContain("probe-skill");
		expect(loader.getAgentsFiles().agentsFiles.some((f) => f.content.includes("PROBE_AGENTS_MARKER"))).toBe(true);
		expect(loader.promptFilesChanged()).toBe(false);
		expect(loader.getExtensions()).toBe(extensionsBefore);
	});

	it("applies a skill and AGENTS.md changed during a tool call to the next request of the same run", async () => {
		const bus = createBus();
		g.__rlmCordisContext = bus;

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true });
		await loader.reload();

		const tool = {
			name: "edit_resources",
			label: "edit_resources",
			description: "Edits a skill and AGENTS.md mid-run",
			parameters: Type.Object({}),
			execute: async () => {
				writeSkill(agentDir, "probe-skill", "PROBE_SKILL_MARKER");
				writeFileSync(join(cwd, "AGENTS.md"), "PROBE_AGENTS_MARKER\n");
				// What rlm-hmr announces when a resource dir changes.
				bus.emit("rlm/resources-changed", { reason: "resources changed: skills/probe-skill/SKILL.md" });
				return { content: [{ type: "text" as const, text: "edited" }], details: {} };
			},
		};

		// Skills are listed in the prompt only when the model can read files.
		const code = {
			name: "code",
			label: "code",
			description: "No-op stand-in for the code kernel",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }),
		};

		const seenPrompts: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: "Test", tools: [tool, code] },
			streamFn: async (_model, context) => {
				seenPrompts.push(context.systemPrompt ?? "");
				const stream = new MockAssistantStream();
				const toolResults = context.messages.filter((m) => m.role === "toolResult").length;
				queueMicrotask(() => {
					const message =
						toolResults === 0
							? assistant([{ type: "toolCall", id: "t1", name: "edit_resources", arguments: {} }], "toolUse")
							: assistant([{ type: "text", text: "done" }], "stop");
					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: loader,
			baseToolsOverride: { edit_resources: tool, code },
		});

		await session.prompt("go");

		expect(seenPrompts.length).toBe(2);
		// First request: before the edit.
		expect(seenPrompts[0]).not.toContain("PROBE_SKILL_MARKER");
		expect(seenPrompts[0]).not.toContain("PROBE_AGENTS_MARKER");
		// Second request, same run, right after the tool call: already live.
		expect(seenPrompts[1]).toContain("PROBE_SKILL_MARKER");
		expect(seenPrompts[1]).toContain("PROBE_AGENTS_MARKER");
	});
});
