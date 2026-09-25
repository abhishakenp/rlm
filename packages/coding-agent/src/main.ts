/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { join, resolve } from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { registerBuiltinMcpOAuthProviders } from "@earendil-works/pi-ai/mcp";
import chalk from "chalk";
import { type Args, type Mode, parseArgs } from "./cli/args.js";
import { formatTopLevelHelp } from "./cli/command-registry.js";
import { processFileArguments } from "./cli/file-processor.js";
import { buildInitialMessage } from "./cli/initial-message.js";
import { handlePublicCommand } from "./cli/public-command.js";
import {
	applyFleetArgsToEnv,
	resolveRuntimeSessionOptions,
	resourceLoaderOptionsFromConfig,
	runtimeConfigFromArgs,
	sessionOptionsFromConfig,
} from "./cli/runtime-args.js";
import { createSessionManager, validateForkFlags } from "./cli/session-startup.js";
import {
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
import type { ExtensionFactory } from "./core/extensions/types.js";
import { installFileLogSink, setLogContext } from "./core/logging.js";
import { findInitialModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
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
import { runPrintMode } from "./modes/print-mode.js";
import { initTheme, preloadCodeHighlighter, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { handleConfigCommand } from "./package-manager-cli.js";

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

export { createSessionManager } from "./cli/session-startup.js";
export { resolveRuntimeSessionOptions } from "./cli/runtime-args.js";

interface PreparedRuntimeServices {
	services: AgentSessionServices;
	scopedModels: ScopedModel[];
	sessionOptions: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
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
			...resourceLoaderOptionsFromConfig(config),
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

	const {
		scopedModels,
		sessionOptions,
		cliThinkingFromModel,
		diagnostics: sessionOptionDiagnostics,
	} = await sessionOptionsFromConfig({
		config,
		services: { settingsManager, modelRegistry, authStorage },
		sessionManager,
		sessionOptionsOverride: options.sessionOptionsOverride,
	});
	diagnostics.push(...sessionOptionDiagnostics);
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
	// Loaded here rather than at the top of the file: this prompt is the only
	// thing in a non-interactive run that could ever want a terminal, and it
	// fires only when a session's cwd has gone missing. A `--print` child that
	// imported the TUI to never draw with it paid 366 KB of interactive-mode
	// source and the whole of pi-tui on the way up, every time.
	const [{ ProcessTerminal, setKeybindings, TUI }, { KeybindingsManager }, { ExtensionSelectorComponent }] =
		await Promise.all([
			import("@earendil-works/pi-tui"),
			import("./core/keybindings.js"),
			import("./modes/interactive/components/extension-selector.js"),
		]);
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
	// This is the *only* structured log of the standalone CLI host, and it
	// stays. It used to be a second one: packages/rlm-log installed this same
	// sink under the Cordis shell as well, so a host that already wrote
	// ~/.rlm/agent/logs/rlm.jsonl also pointed pi-ai at agent.jsonl — a file
	// nothing reads and which, once the daemon architecture went away, nothing
	// meaningfully wrote either. rlm-log now folds pi-ai into its own recorder
	// instead of forking it here, so each host has exactly one log. Do not
	// re-add a call to this from a Cordis row.
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

	applyFleetArgsToEnv(parsed);

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
			const { exportFromFile } = await import("./core/export-html/index.js");
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
		const { listModels } = await import("./cli/list-models.js");
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

		// The interactive mode graph — 366 KB of `interactive-mode.ts` alone, plus
		// eighty-odd components — is reached only from here. Imported at the top of
		// the file it was reached by every `--print` child too, which is a terminal
		// UI built, parsed and compiled for a process with no terminal.
		const { InteractiveMode, createInteractiveModeLocalSessionHost, ClientPromptStashStore, InProcessAgentConnection } =
			await import("./modes/index.js");
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
