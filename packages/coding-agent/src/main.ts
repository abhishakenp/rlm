/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Api, type ImageContent, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import { registerBuiltinMcpOAuthProviders } from "@earendil-works/pi-ai/mcp";
import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Args, type Mode, parseArgs } from "./cli/args.js";
import { formatTopLevelHelp } from "./cli/command-registry.js";
import { processFileArguments } from "./cli/file-processor.js";
import { buildInitialMessage } from "./cli/initial-message.js";
import { listModels } from "./cli/list-models.js";
import { handlePublicCommand } from "./cli/public-command.js";
import {
	resolveSessionPath,
	SessionSelectorError,
	SessionSelectorNotFoundError,
} from "./cli/session-resolver.js";
import { APP_NAME, expandTildePath, getAgentDir, getSessionDirEnvOverride, VERSION } from "./config.js";
import {
	type AgentExecutionMode,
	type AgentSessionRuntimeConfig,
	mergeAgentSessionRuntimeConfig,
	mergeAutonomousConfig,
} from "./core/agent-session-config.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.js";
import {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.js";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import type { ExtensionFactory } from "./core/extensions/types.js";
import { KeybindingsManager } from "./core/keybindings.js";
import { installFileLogSink, setLogContext } from "./core/logging.js";
import type { ModelRegistry } from "./core/model-registry.js";
import { findInitialModel, resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
import { restoreStdout, takeOverStdout } from "./core/output-guard.js";
import type { CreateAgentSessionOptions } from "./core/sdk.js";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.js";
import { SessionAlreadyActiveError } from "./core/session-lease.js";
import { SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { isTelemetryEnabled } from "./core/telemetry.js";
import { printTimings, resetTimings, time } from "./core/timings.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import {
	ClientPromptStashStore,
	createInteractiveModeLocalSessionHost,
	InProcessAgentConnection,
	InteractiveMode,
	runPrintMode,
} from "./modes/index.js";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.js";
import { initTheme, preloadCodeHighlighter, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { handleConfigCommand } from "./package-manager-cli.js";
import { isLocalPath } from "./utils/paths.js";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export type ClientMode = AgentExecutionMode;
export type AppMode = ClientMode;

export function shouldRejectNonInteractiveAttach(attachAgent: string | undefined, appMode: AppMode): boolean {
	return attachAgent !== undefined && appMode !== "interactive";
}

export function shouldRejectNonInteractiveBareResume(resume: true | string | undefined, appMode: AppMode): boolean {
	return resume === true && appMode !== "interactive";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Mode {
	return appMode === "json" ? "json" : "text";
}

// `prime-agent agents` opens the agents view directly.
export function parseAgentsViewCommand(args: string[]): { explicitAgentsView: boolean; args: string[] } {
	if (args[0] === "agents") {
		return { explicitAgentsView: true, args: args.slice(1) };
	}
	return { explicitAgentsView: false, args };
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function getResumeSelector(parsed: Pick<Args, "resume">): string | undefined {
	return typeof parsed.resume === "string" ? parsed.resume : undefined;
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
): Promise<SessionManager> {
	const explicitCwdOverride = parsed.cwd ? cwd : undefined;

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}

	if (parsed.fork) {
		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
		}
	}

	const resumeSelector = getResumeSelector(parsed);
	if (resumeSelector) {
		const resolved = await resolveSessionPath(resumeSelector, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, sessionDir, explicitCwdOverride);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	return SessionManager.create(cwd, sessionDir);
}

function buildSessionOptions(
	config: AgentSessionRuntimeConfig,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (config.model) {
		const resolved = resolveCliModel({
			cliProvider: config.provider,
			cliModel: config.model,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!config.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!config.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!config.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (config.thinking) {
		options.thinkingLevel = config.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (config.noTools) {
		options.noTools = "all";
	} else if (config.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (config.tools) {
		options.tools = [...config.tools];
	}
	if (config.autonomous) {
		options.autonomous = mergeAutonomousConfig(undefined, config.autonomous);
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolve(cwd, value) : value));
}

function runtimeAutonomousConfigFromArgs(parsed: Args): AgentSessionRuntimeConfig["autonomous"] {
	const hasAutonomousOptions =
		parsed.autonomous === true ||
		parsed.autonomousGates !== undefined ||
		parsed.autonomousGateRetries !== undefined ||
		parsed.autonomousGateTimeoutMs !== undefined ||
		parsed.autonomousMaxContinuations !== undefined ||
		parsed.autonomousMaxTurns !== undefined ||
		parsed.autonomousMaxTokens !== undefined ||
		parsed.autonomousTimeoutMs !== undefined;
	if (!hasAutonomousOptions) {
		return undefined;
	}
	const hasGateOptions =
		parsed.autonomousGates !== undefined ||
		parsed.autonomousGateRetries !== undefined ||
		parsed.autonomousGateTimeoutMs !== undefined;
	return {
		enabled: true,
		maxContinuations: parsed.autonomousMaxContinuations,
		maxTurns: parsed.autonomousMaxTurns,
		maxTokens: parsed.autonomousMaxTokens,
		timeoutMs: parsed.autonomousTimeoutMs,
		gates: hasGateOptions
			? {
					commands: parsed.autonomousGates,
					maxRetries: parsed.autonomousGateRetries,
					timeoutMs: parsed.autonomousGateTimeoutMs,
				}
			: undefined,
	};
}

function runtimeConfigFromArgs(
	parsed: Args,
	cwd: string,
	agentDir: string,
	sessionDir: string | undefined,
	appMode: AppMode,
	telemetryDisabled?: true,
): AgentSessionRuntimeConfig {
	return {
		cwd,
		agentDir,
		sessionDir,
		provider: parsed.provider,
		model: parsed.model,
		apiKey: parsed.apiKey,
		systemPrompt: parsed.systemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompt,
		thinking: parsed.thinking,
		models: parsed.models,
		tools: parsed.tools,
		noTools: parsed.noTools,
		noBuiltinTools: parsed.noBuiltinTools,
		extensions: resolveCliPaths(cwd, parsed.extensions),
		noExtensions: parsed.noExtensions,
		skills: resolveCliPaths(cwd, parsed.skills),
		noSkills: parsed.noSkills,
		promptTemplates: resolveCliPaths(cwd, parsed.promptTemplates),
		noPromptTemplates: parsed.noPromptTemplates,
		themes: resolveCliPaths(cwd, parsed.themes),
		noThemes: parsed.noThemes,
		noContextFiles: parsed.noContextFiles,
		autonomous: runtimeAutonomousConfigFromArgs(parsed),
		extensionFlagValues: parsed.unknownFlags.size > 0 ? Object.fromEntries(parsed.unknownFlags.entries()) : undefined,
		executionMode: appMode,
		telemetryDisabled,
		// Serialized refine for print/json: the client's appMode is NOT
		// "interactive" here — it's "print" or "json".
		serializedRefine: appMode !== "interactive",
		initialGoal: parsed.goal ? { objective: parsed.goal, tokenBudget: parsed.goalTokenBudget } : undefined,
	};
}

interface PreparedRuntimeServices {
	services: AgentSessionServices;
	scopedModels: ScopedModel[];
	sessionOptions: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export function resolveRuntimeSessionOptions(
	sessionOptions: CreateAgentSessionOptions,
	runtimeSessionOptions?: CreateAgentSessionOptions,
): CreateAgentSessionOptions {
	return {
		model: runtimeSessionOptions?.model ?? sessionOptions.model,
		thinkingLevel: runtimeSessionOptions?.thinkingLevel ?? sessionOptions.thinkingLevel,
		serviceTier: runtimeSessionOptions?.serviceTier ?? sessionOptions.serviceTier,
		scopedModels: runtimeSessionOptions?.scopedModels ?? sessionOptions.scopedModels,
		tools: runtimeSessionOptions?.tools ?? sessionOptions.tools,
		noTools: runtimeSessionOptions?.noTools ?? sessionOptions.noTools,
		customTools: runtimeSessionOptions?.customTools ?? sessionOptions.customTools,
		baseToolsOverride: runtimeSessionOptions?.baseToolsOverride ?? sessionOptions.baseToolsOverride,
		initialActiveToolNames: runtimeSessionOptions?.initialActiveToolNames,
		allowedToolNames: runtimeSessionOptions?.allowedToolNames,
		includeGoals: runtimeSessionOptions?.includeGoals,
		includeCompactSkill: runtimeSessionOptions?.includeCompactSkill,
		rlmHeartbeatController: runtimeSessionOptions?.rlmHeartbeatController,
		agentMessageController: runtimeSessionOptions?.agentMessageController,
		agentObserveController: runtimeSessionOptions?.agentObserveController,
		autonomous:
			(runtimeSessionOptions?.rlmDepth ?? 0) > 0
				? mergeAutonomousConfig(sessionOptions.autonomous, { ...runtimeSessionOptions?.autonomous, enabled: false })
				: mergeAutonomousConfig(sessionOptions.autonomous, runtimeSessionOptions?.autonomous),
		rlmDepth: runtimeSessionOptions?.rlmDepth,
		rlmMaxDepth: runtimeSessionOptions?.rlmMaxDepth,
		rlmSessionDir: runtimeSessionOptions?.rlmSessionDir,
		rlmParentNodeId: runtimeSessionOptions?.rlmParentNodeId,
		rlmParentAgent: runtimeSessionOptions?.rlmParentAgent,
		subagentRuntimeHost: runtimeSessionOptions?.subagentRuntimeHost,
	};
}

async function prepareRuntimeServices(options: {
	config: AgentSessionRuntimeConfig;
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	extensionFactories?: ExtensionFactory[];
	sessionOptionsOverride?: CreateAgentSessionOptions;
}): Promise<PreparedRuntimeServices> {
	const { config, sessionManager } = options;
	const effectiveAgentDir = config.agentDir ?? options.agentDir;
	const authStorage = AuthStorage.create(join(effectiveAgentDir, "auth.json"), {
		usePrimeCliConfig: effectiveAgentDir === options.agentDir,
	});
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: effectiveAgentDir,
		authStorage,
		extensionFlagValues: new Map(Object.entries(config.extensionFlagValues ?? {})),
		// Subagents share the parent's Herdr pane; their own reporter would race
		// the parent's and a subagent quit would release the still-active pane.
		noBuiltinHerdrReporter: (options.sessionOptionsOverride?.rlmDepth ?? 0) > 0,
		telemetryDisabled: config.telemetryDisabled,
		resourceLoaderOptions: {
			additionalExtensionPaths: config.extensions,
			additionalSkillPaths: config.skills,
			additionalPromptTemplatePaths: config.promptTemplates,
			additionalThemePaths: config.themes,
			noExtensions: config.noExtensions,
			noSkills: config.noSkills,
			noPromptTemplates: config.noPromptTemplates,
			noThemes: config.noThemes,
			noContextFiles: config.noContextFiles,
			systemPrompt: config.systemPrompt,
			appendSystemPrompt: config.appendSystemPrompt,
			extensionFactories: options.extensionFactories,
		},
	});
	const { settingsManager, modelRegistry, resourceLoader } = services;
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [
		...services.diagnostics,
		...collectSettingsDiagnostics(settingsManager, "runtime creation"),
		...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
			type: "error" as const,
			message: `Failed to load extension "${path}": ${error}`,
		})),
	];

	const modelPatterns = config.models ?? settingsManager.getEnabledModels();
	const scopedModels =
		modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];

	const {
		options: sessionOptions,
		cliThinkingFromModel,
		diagnostics: sessionOptionDiagnostics,
	} = buildSessionOptions(
		config,
		scopedModels,
		sessionManager.buildSessionContext().messages.length > 0,
		modelRegistry,
		settingsManager,
	);
	diagnostics.push(...sessionOptionDiagnostics);

	const effectiveSessionModel = options.sessionOptionsOverride?.model ?? sessionOptions.model;
	if (config.apiKey) {
		if (!effectiveSessionModel) {
			diagnostics.push({
				type: "error",
				message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
			});
		} else {
			authStorage.setRuntimeApiKey(effectiveSessionModel.provider, config.apiKey);
		}
	}

	return {
		services,
		scopedModels,
		sessionOptions,
		cliThinkingFromModel,
		diagnostics,
	};
}

async function resolvePreparedStartupModel(options: {
	prepared: PreparedRuntimeServices;
	sessionManager: SessionManager;
}): Promise<{ model: Model<Api> | undefined; modelFallbackMessage: string | undefined }> {
	const { prepared, sessionManager } = options;
	const { modelRegistry, settingsManager } = prepared.services;
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;

	let model = prepared.sessionOptions.model;
	let modelFallbackMessage: string | undefined;

	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	if (!model) {
		const result = await findInitialModel({
			scopedModels: prepared.scopedModels,
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	return { model, modelFallbackMessage };
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	installFileLogSink();
	registerBuiltinMcpOAuthProviders();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	const publicCommand = await handlePublicCommand(args);
	if (publicCommand.handled) {
		return;
	}
	args = publicCommand.args;

	if (await handleConfigCommand(args)) {
		return;
	}

	const explicitAgentsView = publicCommand.explicitAgentsView;

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");
	const appMode = resolveAppMode(parsed, process.stdin.isTTY);

	// Headless/fleet args: inject into env so AgentSession picks them up
	if (parsed.rlmDepth !== undefined) process.env.RLM_DEPTH = String(parsed.rlmDepth);
	if (parsed.parentAgentId) process.env.RLM_PARENT_NODE_ID = parsed.parentAgentId;
	if (parsed.parentHost) process.env.RLM_PARENT_HOST = parsed.parentHost;
	if (parsed.sessionId) process.env.PRIME_AGENT_SESSION_ID = parsed.sessionId;

	if (shouldRejectNonInteractiveAttach(publicCommand.attachAgent, appMode)) {
		console.error(chalk.red("Error: attach requires an interactive terminal"));
		process.exit(1);
	}
	if (shouldRejectNonInteractiveBareResume(parsed.resume, appMode)) {
		console.error(chalk.red("Error: --resume without a session selector requires an interactive terminal"));
		process.exit(1);
	}
	setLogContext({ mode: appMode });
	const shouldTakeOverStdout = appMode !== "interactive";
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}
	if (parsed.help) {
		console.log(formatTopLevelHelp());
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	validateForkFlags(parsed);

	const cwd = parsed.cwd ? resolve(expandTildePath(parsed.cwd)) : process.cwd();
	if (parsed.cwd) {
		try {
			process.chdir(cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: Cannot use cwd ${cwd}: ${message}`));
			process.exit(1);
		}
	}

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const agentDir = getAgentDir();
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));
	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const sessionDir =
		(parsed.sessionDir ? expandTildePath(parsed.sessionDir) : undefined) ??
		getSessionDirEnvOverride() ??
		startupSettingsManager.getSessionDir();

	let sessionManager: SessionManager;
	try {
		sessionManager = await createSessionManager(parsed, cwd, sessionDir);
	} catch (error) {
		if (!(error instanceof SessionSelectorError)) {
			throw error;
		}
		const suggestion =
			error instanceof SessionSelectorNotFoundError && error.suggestion
				? ` Did you mean '${error.suggestion}'?`
				: "";
		console.error(chalk.red(`Error: ${error.message}.${suggestion}`));
		console.error(chalk.dim(`Open ${APP_NAME} and press left-arrow to browse sessions.`));
		process.exit(1);
	}
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	time("createSessionManager");

	const telemetrySettingsManager =
		sessionManager.getCwd() === cwd
			? startupSettingsManager
			: SettingsManager.create(sessionManager.getCwd(), agentDir);
	const telemetryDisabled = isTelemetryEnabled(telemetrySettingsManager) ? undefined : true;
	const defaultSessionConfig = runtimeConfigFromArgs(
		parsed,
		sessionManager.getCwd(),
		agentDir,
		sessionDir,
		appMode,
		telemetryDisabled,
	);
	const runtimeDefaultSessionConfig = defaultSessionConfig;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		sessionConfig,
		sessionOptions: runtimeSessionOptions,
	}) => {
		const config = mergeAgentSessionRuntimeConfig(runtimeDefaultSessionConfig, sessionConfig);
		const prepared = await prepareRuntimeServices({
			config,
			cwd,
			agentDir,
			sessionManager,
			extensionFactories: options?.extensionFactories,
			sessionOptionsOverride: runtimeSessionOptions,
		});
		const { services, sessionOptions, diagnostics } = prepared;
		const resolvedSessionOptions = resolveRuntimeSessionOptions(sessionOptions, runtimeSessionOptions);

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			...resolvedSessionOptions,
			// Main agents boot their kernel in the background at session creation;
			// subagent sessions (rlmDepth > 0) keep the lazy first-call start.
			prewarmCodeKernel: true,
			// Read serializedRefine from the merged runtime config (passed
			// from the JSON/print client through AgentSessionRuntimeConfig).
			serializedRefine: config.serializedRefine ?? false,
			executionMode: config.executionMode,
			telemetryDisabled: config.telemetryDisabled,
			// Only seed initial goal for top-level sessions (rlmDepth 0).
			initialGoal: (runtimeSessionOptions?.rlmDepth ?? 0) === 0 ? config.initialGoal : undefined,
		});
		const cliThinkingOverride = config.thinking !== undefined || prepared.cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");

	let runtime: AgentSessionRuntime;
	try {
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
			sessionConfig: defaultSessionConfig,
		});
	} catch (error) {
		if (error instanceof SessionAlreadyActiveError) {
			console.error(chalk.red(`Error: ${error.message}`));
			process.exit(1);
		}
		throw error;
	}
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRegistry } = services;

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// Read piped stdin content (if any)
	let stdinContent: string | undefined;
	stdinContent = await readPipedStdin();
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	const scopedModels = [...session.scopedModels];
	time("resolveModelScope");
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	if (appMode === "interactive") {
		if (explicitAgentsView || parsed.resume === true) {
			console.error(chalk.yellow("Warning: the agents view is not available; opening a normal chat instead"));
		}
		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		const interactiveMode = new InteractiveMode({
			agentConnection: new InProcessAgentConnection(runtime),
			localSessionHost: createInteractiveModeLocalSessionHost(runtime),
			promptStashStore: new ClientPromptStashStore(),
			promptStashSessionId: session.sessionId,
			bindLocalSessionExtensions: true,
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		await preloadCodeHighlighter();
		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
