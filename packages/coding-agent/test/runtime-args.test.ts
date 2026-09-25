import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import {
	resourceLoaderOptionsFromConfig,
	runtimeConfigFromLine,
	sessionOptionsFromConfig,
} from "../src/cli/runtime-args.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * The Cordis launch path builds its runtime config with these, so a command line
 * means the same thing there as in `main()`. Before, only `main()` read these
 * flags: `rlm --print --model cliproxy/gpt-5.5 …` answered on the default model.
 */
describe("command-line runtime config on the plugin launch path", () => {
	let dir: string;
	const savedAgentDir = process.env.RLM_CODING_AGENT_DIR;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rlm-runtime-args-"));
		mkdirSync(join(dir, "agent"), { recursive: true });
		process.env.RLM_CODING_AGENT_DIR = join(dir, "agent");
		writeFileSync(
			join(dir, "agent", "models.json"),
			JSON.stringify({
				providers: {
					alpha: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "k",
						models: [{ id: "one" }, { id: "two" }],
					},
					beta: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "k",
						models: [{ id: "gpt-9" }],
					},
				},
			}),
		);
		writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ defaultProvider: "alpha", defaultModel: "one" }));
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.RLM_CODING_AGENT_DIR;
		else process.env.RLM_CODING_AGENT_DIR = savedAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	const resolveFor = async (argv: string[]) => {
		const config = await runtimeConfigFromLine(parseArgs(argv), dir, argv.includes("--print") ? "print" : "interactive");
		const agentDir = join(dir, "agent");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const services = {
			authStorage,
			settingsManager: SettingsManager.create(dir, agentDir),
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
		};
		const resolved = await sessionOptionsFromConfig({
			config,
			services,
			sessionManager: SessionManager.inMemory(dir),
		});
		return { config, ...resolved, authStorage };
	};

	test("--model provider/id selects that model", async () => {
		const { sessionOptions, diagnostics } = await resolveFor(["--print", "--model", "beta/gpt-9", "hi"]);
		expect(diagnostics.filter((d) => d.type === "error")).toEqual([]);
		expect(sessionOptions.model?.provider).toBe("beta");
		expect(sessionOptions.model?.id).toBe("gpt-9");
	});

	test("--provider with --model, and --thinking", async () => {
		const { sessionOptions } = await resolveFor(["--provider", "alpha", "--model", "two", "--thinking", "high"]);
		expect(`${sessionOptions.model?.provider}/${sessionOptions.model?.id}`).toBe("alpha/two");
		expect(sessionOptions.thinkingLevel).toBe("high");
	});

	test("--models scopes the cycle list and picks the first when the default is outside it", async () => {
		const { sessionOptions } = await resolveFor(["--models", "beta/gpt-9,alpha/two"]);
		expect(sessionOptions.scopedModels?.map((m) => `${m.model.provider}/${m.model.id}`)).toEqual([
			"beta/gpt-9",
			"alpha/two",
		]);
		expect(sessionOptions.model?.id).toBe("gpt-9");
	});

	test("--tools, --no-tools and --no-builtin-tools", async () => {
		expect((await resolveFor(["--tools", "read,bash"])).sessionOptions.tools).toEqual(["read", "bash"]);
		expect((await resolveFor(["--no-tools"])).sessionOptions.noTools).toBe("all");
		expect((await resolveFor(["--no-builtin-tools"])).sessionOptions.noTools).toBe("builtin");
	});

	test("--api-key is set as the runtime key for the chosen model's provider", async () => {
		const { authStorage } = await resolveFor(["--model", "beta/gpt-9", "--api-key", "sk-test-123"]);
		expect(await authStorage.getApiKey("beta")).toBe("sk-test-123");
	});

	test("system prompt, skills, extensions and context-file flags reach the resource loader", async () => {
		const { config } = await resolveFor([
			"--system-prompt",
			"S",
			"--append-system-prompt",
			"A",
			"--skill",
			"./skills/x",
			"--no-extensions",
			"--no-context-files",
		]);
		const options = resourceLoaderOptionsFromConfig(config);
		expect(options.systemPrompt).toBe("S");
		expect(options.appendSystemPrompt).toEqual(["A"]);
		expect(options.additionalSkillPaths).toEqual([join(dir, "skills/x")]);
		expect(options.noExtensions).toBe(true);
		expect(options.noContextFiles).toBe(true);
	});

	test("print runs get the print execution mode", async () => {
		const { config } = await resolveFor(["--print", "hi"]);
		expect(config.executionMode).toBe("print");
		expect(config.serializedRefine).toBe(true);
	});
});
