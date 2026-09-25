/**
 * What the command line asks of a runtime: model, provider, thinking, scoped
 * models, tools, system prompt, extensions, skills, prompt templates, themes,
 * context files, API key, autonomous mode.
 *
 * Moved out of `main.ts` so the Cordis launch path (`rlm-modes` → renderer /
 * print rows → `rlmAgent.createRuntime`) applies a command line exactly as
 * `main()` does. Before, only `main()` read these flags and the rows never call
 * it, so `rlm --print --model cliproxy/gpt-5.5 …` answered on the default model.
 */

import { modelsAreEqual } from "@earendil-works/pi-ai";
import type { AppMode } from "../main.js";
import { type AgentSessionRuntimeConfig, mergeAutonomousConfig } from "../core/agent-session-config.js";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "../core/agent-session-services.js";
import type { ModelRegistry } from "../core/model-registry.js";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "../core/model-resolver.js";
import type { CreateAgentSessionOptions } from "../core/sdk.js";
import type { SessionManager } from "../core/session-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";
import { isLocalPath } from "../utils/paths.js";
import type { Args } from "./args.js";
import { resolve } from "node:path";

export function buildSessionOptions(
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

export function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolve(cwd, value) : value));
}

export function runtimeAutonomousConfigFromArgs(parsed: Args): AgentSessionRuntimeConfig["autonomous"] {
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

export function runtimeConfigFromArgs(
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
		rlmParentSession: runtimeSessionOptions?.rlmParentSession,
		subagentRuntimeHost: runtimeSessionOptions?.subagentRuntimeHost,
	};
}

/** The resource-loader half of a runtime config, as `main()` hands it to the services. */
export function resourceLoaderOptionsFromConfig(config: AgentSessionRuntimeConfig) {
	return {
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
	};
}

/**
 * The session half: scoped models, the CLI model and thinking level, tools,
 * autonomous mode, and the runtime API key. `services` must already be built
 * with `resourceLoaderOptionsFromConfig(config)`.
 */
export async function sessionOptionsFromConfig(options: {
	config: AgentSessionRuntimeConfig;
	services: Pick<AgentSessionServices, "settingsManager" | "modelRegistry" | "authStorage">;
	sessionManager: SessionManager;
	sessionOptionsOverride?: CreateAgentSessionOptions;
}): Promise<{
	scopedModels: ScopedModel[];
	sessionOptions: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}> {
	const { config, sessionManager } = options;
	const { settingsManager, modelRegistry, authStorage } = options.services;
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
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


	return { scopedModels, sessionOptions, cliThinkingFromModel, diagnostics };
}

/**
 * The runtime config for a Cordis launch: the same `runtimeConfigFromArgs` call
 * `main()` makes, with the same agent dir, session dir and telemetry setting.
 */
export async function runtimeConfigFromLine(
	parsed: Args,
	cwd: string,
	appMode: AppMode,
	sessionManager?: SessionManager,
): Promise<AgentSessionRuntimeConfig> {
	const [{ getAgentDir }, { SettingsManager: Settings }, { isTelemetryEnabled }, { resolveStartupSessionDir }] =
		await Promise.all([
			import("../config.js"),
			import("../core/settings-manager.js"),
			import("../core/telemetry.js"),
			import("./session-startup.js"),
		]);
	applyFleetArgsToEnv(parsed);
	const agentDir = getAgentDir();
	const sessionCwd = sessionManager?.getCwd() ?? cwd;
	const settings = Settings.create(sessionCwd, agentDir);
	const telemetryDisabled = isTelemetryEnabled(settings) ? undefined : true;
	return runtimeConfigFromArgs(
		parsed,
		sessionCwd,
		agentDir,
		resolveStartupSessionDir(parsed, settings),
		appMode,
		telemetryDisabled,
	);
}

/** Headless/fleet args: inject into env so AgentSession picks them up. */
export function applyFleetArgsToEnv(parsed: Args): void {
	if (parsed.rlmDepth !== undefined) process.env.RLM_DEPTH = String(parsed.rlmDepth);
	if (parsed.parentAgentId) process.env.RLM_PARENT_NODE_ID = parsed.parentAgentId;
	if (parsed.parentHost) process.env.RLM_PARENT_HOST = parsed.parentHost;
	if (parsed.sessionId) process.env.PRIME_AGENT_SESSION_ID = parsed.sessionId;
}
