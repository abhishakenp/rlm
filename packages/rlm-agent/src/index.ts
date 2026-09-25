/**
 * @rlm/agent — AgentSession runtime as a Cordis Service.
 *
 * Core plugin — wraps createAgentSessionRuntime behind a service so other
 * plugins (renderer, print) can build full agent runtimes via dependency
 * injection instead of importing coding-agent internals directly.
 *
 * Depends on:
 * - @rlm/config (rlmConfig) for settingsManager / modelRegistry / authStorage
 * - @rlm/session (rlmSession) for the SessionManager
 * - @rlm/tools (rlmTools) for the tool registry
 * - @rlm/refine (rlmRefine) for the refine runtime
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import type {
	AgentSessionServices,
	CreateAgentSessionServicesOptions,
	CreateAgentSessionFromServicesOptions,
} from "../../coding-agent/src/core/agent-session-services.js";
import type {
	AgentSessionRuntime,
	CreateAgentSessionRuntimeFactory,
} from "../../coding-agent/src/core/agent-session-runtime.js";
import type { AgentSession } from "../../coding-agent/src/core/agent-session.js";
import type { SessionManager } from "../../coding-agent/src/core/session-manager.js";
import type { CreateAgentSessionResult } from "../../coding-agent/src/core/sdk.js";

/**
 * Lazy-load the coding-agent module.
 *
 * The coding-agent is a large module (~143 MB RSS when loaded). Deferring
 * its import until the agent is actually needed means a composition that
 * includes @rlm/agent but never runs a task pays nothing — the module is
 * only loaded on the first call to createServices(), createSession(), or
 * createRuntime().
 *
 * Cached after the first load so repeated calls don't re-import.
 */
interface CodingAgentModule {
	createAgentSessionServices: (opts: CreateAgentSessionServicesOptions) => Promise<AgentSessionServices>;
	createAgentSessionFromServices: (opts: CreateAgentSessionFromServicesOptions) => Promise<CreateAgentSessionResult>;
}

interface AgentRuntimeModule {
	createAgentSessionRuntime: (factory: CreateAgentSessionRuntimeFactory, opts: any) => AgentSessionRuntime;
}

interface AgentConfigModule {
	getAgentDir: () => string;
}

let codingAgentPromise: Promise<CodingAgentModule> | null = null;
function loadCodingAgent(): Promise<CodingAgentModule> {
	if (!codingAgentPromise) {
		codingAgentPromise = import("../../coding-agent/src/core/agent-session-services.js") as Promise<CodingAgentModule>;
	}
	return codingAgentPromise;
}

let agentRuntimePromise: Promise<AgentRuntimeModule> | null = null;
function loadAgentRuntime(): Promise<AgentRuntimeModule> {
	if (!agentRuntimePromise) {
		agentRuntimePromise = import("../../coding-agent/src/core/agent-session-runtime.js") as Promise<AgentRuntimeModule>;
	}
	return agentRuntimePromise;
}

let agentConfigPromise: Promise<AgentConfigModule> | null = null;
function loadAgentConfig(): Promise<AgentConfigModule> {
	if (!agentConfigPromise) {
		agentConfigPromise = import("../../coding-agent/src/config.js") as Promise<AgentConfigModule>;
	}
	return agentConfigPromise;
}

/**
 * Extension factories published by other Cordis plugins.
 *
 * A plugin that needs to observe or rewrite tool calls pushes
 * `{ id, factory }` onto `globalThis.__rlmExtensionFactories`; the id lets a
 * hot-swap replace an entry instead of stacking duplicates. Read through a
 * global rather than dependency injection so @rlm/agent stays unaware of which
 * plugins exist, and so a contributor can come and go at runtime.
 */
function currentContributedFactories(): Array<(pi: any) => void> {
	try {
		const entries = (globalThis as any).__rlmExtensionFactories;
		if (!Array.isArray(entries)) return [];
		return entries.map((e: any) => e?.factory).filter((f: unknown) => typeof f === "function");
	} catch {
		return [];
	}
}

/**
 * A live view of the contributed factories, not a snapshot.
 *
 * The resource loader keeps whatever array it is handed for the life of the
 * session and re-reads it on `/reload`. Handing it a plain array would freeze
 * the set of contributors at session-creation time, so a plugin loaded later —
 * exactly what a hot-swap does — could never attach, even on an explicit
 * reload. This proxy reads the registry at the moment the loader looks.
 */
function getContributedExtensionFactories(): Array<(pi: any) => void> {
	if (process.env.RLM_VERBOSE || process.env.RLM_HMR_VERBOSE) {
		const ids = ((globalThis as any).__rlmExtensionFactories ?? []).map((e: any) => e?.id).join(", ");
		console.error(`[rlm] rlm-agent: contributed extension factories → [${ids || "none"}]`);
	}
	return new Proxy([] as Array<(pi: any) => void>, {
		get(_target, prop, receiver) {
			return Reflect.get(currentContributedFactories(), prop, receiver);
		},
		has(_target, prop) {
			return Reflect.has(currentContributedFactories(), prop);
		},
		ownKeys() {
			return Reflect.ownKeys(currentContributedFactories());
		},
		getOwnPropertyDescriptor(_target, prop) {
			const live = currentContributedFactories();
			const d = Reflect.getOwnPropertyDescriptor(live, prop);
			return d && { ...d, configurable: true };
		},
	});
}

export interface RlmAgentConfig {
	cwd?: string;
	agentDir?: string;
}

export class RlmAgentService extends Service {
	static inject = ["rlmConfig", "rlmSession", "rlmTools", "rlmRefine"] as const;
	static provide = "rlmAgent" as const;

	declare config: RlmAgentConfig;

	private services: AgentSessionServices | undefined;
	/** Config reference stored at init for lazy service creation. */
	private rlmConfigRef: {
		getSettingsManager: () => { getCwd?: () => string } | undefined;
		getModelRegistry: () => unknown;
		getAuthStorage: () => unknown;
	} | undefined;
	/** Session reference stored at init for lazy session creation. */
	private rlmSessionRef: { getSessionManager: () => SessionManager } | undefined;

	/**
	 * A default parameter does not catch `null`, and the composition hands one.
	 *
	 * `cordis.yml` writes this row as `config:` with nothing under it, which
	 * YAML reads as `null` rather than as an absent key — so `config = {}` never
	 * fires, `this.config` becomes null, and `[Service.init]` dies on
	 * `this.config.cwd`. The row is the one that spawns every delegated child,
	 * so the drive correctly refuses to sweep into a composition without it and
	 * the whole fleet stops. An empty config block must mean "no options", not
	 * "no object".
	 */
	constructor(ctx: any, config?: RlmAgentConfig | null) {
		super(ctx, undefined as any);
		this.config = config ?? {};
	}

	async [Service.init]() {
		const rlmConfig = this.ctx.get("rlmConfig") as {
			getSettingsManager: () => { getCwd?: () => string } | undefined;
			getModelRegistry: () => unknown;
			getAuthStorage: () => unknown;
		};
		const rlmSession = this.ctx.get("rlmSession") as {
			getSessionManager: () => SessionManager;
		};

		// Store config references for lazy initialization.
		// The actual coding-agent module is not loaded until createServices()
		// is called — so a composition that includes @rlm/agent but never runs
		// a task pays nothing for the ~143 MB coding-agent boot.
		this.rlmConfigRef = rlmConfig;
		this.rlmSessionRef = rlmSession;

		void rlmSession?.getSessionManager?.();

		const settingsManager = rlmConfig?.getSettingsManager?.();
		const cwd = this.config.cwd ?? (settingsManager?.getCwd?.() ?? process.cwd());
		this.ctx.logger?.info(`rlm-agent: ready (lazy — coding-agent not loaded yet, cwd=${cwd})`);
	}

	async createServices(
		opts: Omit<CreateAgentSessionServicesOptions, "cwd" | "agentDir"> &
			Partial<Pick<CreateAgentSessionServicesOptions, "cwd" | "agentDir">>,
	): Promise<AgentSessionServices> {
		// rlmPrompt's fragments reach the system prompt through AgentSession
		// itself (`_getPromptFragments` → buildSystemPrompt's `promptFragments`),
		// depth-aware and rebuilt live. They used to be appended here as well,
		// through appendSystemPromptOverride, which put every fragment — ~41 KB
		// of context/SDK/refine/pixel/plugin guidance — into the prompt twice.

		// Lazy-load coding-agent on first use.
		const { createAgentSessionServices } = await loadCodingAgent();
		const { getAgentDir } = await loadAgentConfig();

		const defaultResourceLoaderOptions: NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]> = {
			// In-process extension factories contributed by other plugins
			// (see @rlm/pixel). Resolved lazily at session-creation time so
			// a fiber.restart() on the contributing plugin is picked up by the
			// next session without restarting the agent.
			extensionFactories: getContributedExtensionFactories(),
		};
		const base: CreateAgentSessionServicesOptions = {
			cwd: this.services?.cwd ?? this.config.cwd ?? process.cwd(),
			agentDir: this.services?.agentDir ?? this.config.agentDir ?? getAgentDir(),
			resourceLoaderOptions: defaultResourceLoaderOptions,
			...opts,
		};
		// Merged, not replaced: a caller's resource options (the command line's
		// --skill, --system-prompt, --no-extensions …) sit on top of the
		// contributed extension factories, not instead.
		base.resourceLoaderOptions = { ...defaultResourceLoaderOptions, ...opts.resourceLoaderOptions };
		return createAgentSessionServices(base);
	}

	async createSession(
		opts: Omit<CreateAgentSessionFromServicesOptions, "services" | "sessionManager"> &
			Partial<Pick<CreateAgentSessionFromServicesOptions, "services" | "sessionManager">>,
	): Promise<CreateAgentSessionResult> {
		const rlmSession = this.rlmSessionRef ?? this.ctx.get("rlmSession") as {
			getSessionManager: () => SessionManager;
		};
		const services = opts.services ?? this.services;
		if (!services) {
			throw new Error("rlm-agent: services not initialized");
		}
		const sessionManager = opts.sessionManager ?? rlmSession?.getSessionManager?.();
		if (!sessionManager) {
			throw new Error("rlm-agent: no SessionManager available");
		}
		// Lazy-load coding-agent on first use.
		const { createAgentSessionFromServices } = await loadCodingAgent();
		return createAgentSessionFromServices({
			...opts,
			services,
			sessionManager,
		});
	}

	/**
	 * Create a full AgentSessionRuntime — the complete agent runtime with
	 * session, services, and runtime metadata. This is what InteractiveMode
	 * and runPrintMode need.
	 */
	async createRuntime(options: {
		sessionConfig?: Record<string, unknown>;
		sessionOptions?: Record<string, unknown>;
		/**
		 * The session this runtime is for, when the caller has one of its own.
		 *
		 * `rlmSession` holds exactly one `SessionManager`. That is right for a
		 * process that is one agent and wrong for one that is eight: a worker in
		 * the delegate's pool runs several tasks at once and each of them is its
		 * own conversation with its own transcript on disk. Sharing one manager
		 * between them would put every task's messages in one file and hand each
		 * of them the others' history, which is the state leak pooling has to not
		 * have.
		 *
		 * It is also how a stable session id means anything. `sessionFor(graph,
		 * task)` derives `rlm-delegate-<graph>-<task>` so attempt two can resume
		 * attempt one; the caller turns that id into a manager pointed at that
		 * file and hands it here.
		 *
		 * Absent, everything is exactly as it was: the row's single manager.
		 */
		sessionManager?: SessionManager;
	}): Promise<AgentSessionRuntime> {
		const rlmSession = this.rlmSessionRef ?? this.ctx.get("rlmSession") as {
			getSessionManager: () => SessionManager;
		};
		const sessionManager = options.sessionManager ?? rlmSession?.getSessionManager?.();
		if (!sessionManager) {
			throw new Error("rlm-agent: no SessionManager available");
		}

		// Lazy-load coding-agent on first use.
		const { createAgentSessionRuntime } = await loadAgentRuntime();
		const { getAgentDir } = await loadAgentConfig();

		const cwd = this.services?.cwd ?? this.config.cwd ?? process.cwd();
		const agentDir = this.services?.agentDir ?? this.config.agentDir ?? getAgentDir();

		// The runtime calls this factory again for every in-process subagent,
		// each time with that child's own SessionManager. Using the closed-over
		// one instead built every child on the parent's manager: each spawn's
		// setSessionName renamed the parent, all children reported the last
		// name given, and child transcripts landed in the parent's session.
		//
		// `sessionConfig` is the command line (`--model`, `--thinking`, `--tools`,
		// `--skill`, `--system-prompt` …), built by `runtimeConfigFromArgs` and
		// applied here with the helpers `main()` uses. This factory used to drop
		// it, so every such flag was silently ignored on the Cordis launch path.
		const createRuntimeFn: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
			const config = runtimeOptions.sessionConfig;
			const runtimeArgs = config ? await import("../../coding-agent/src/cli/runtime-args.js") : undefined;
			const childSessionManager = runtimeOptions.sessionManager ?? sessionManager;
			const prepared = await this.createServices({
				cwd: runtimeOptions.cwd ?? cwd,
				agentDir: runtimeOptions.agentDir ?? agentDir,
				...(config && runtimeArgs
					? {
							resourceLoaderOptions: runtimeArgs.resourceLoaderOptionsFromConfig(config),
							extensionFlagValues: new Map(Object.entries(config.extensionFlagValues ?? {})),
							telemetryDisabled: config.telemetryDisabled,
						}
					: {}),
			});
			if (!config || !runtimeArgs) {
				const created = await this.createSession({
					services: prepared,
					sessionManager: childSessionManager,
					...(runtimeOptions.sessionOptions ?? {}),
				});
				return { ...created, services: prepared, diagnostics: [] };
			}
			const fromConfig = await runtimeArgs.sessionOptionsFromConfig({
				config,
				services: prepared,
				sessionManager: childSessionManager,
				sessionOptionsOverride: runtimeOptions.sessionOptions,
			});
			const created = await this.createSession({
				services: prepared,
				sessionManager: childSessionManager,
				...runtimeArgs.resolveRuntimeSessionOptions(fromConfig.sessionOptions, runtimeOptions.sessionOptions),
				serializedRefine: config.serializedRefine ?? false,
				executionMode: config.executionMode,
				telemetryDisabled: config.telemetryDisabled,
				// Only seed initial goal for top-level sessions (rlmDepth 0).
				initialGoal: (runtimeOptions.sessionOptions?.rlmDepth ?? 0) === 0 ? config.initialGoal : undefined,
			} as never);
			const cliThinkingOverride = config.thinking !== undefined || fromConfig.cliThinkingFromModel;
			if (created.session.model && cliThinkingOverride) {
				created.session.setThinkingLevel(created.session.thinkingLevel);
			}
			return { ...created, services: prepared, diagnostics: fromConfig.diagnostics };
		};

		return createAgentSessionRuntime(createRuntimeFn, {
			cwd,
			agentDir,
			sessionManager,
			sessionConfig: options.sessionConfig as never,
			sessionOptions: options.sessionOptions as never,
		});
	}

	getServices(): AgentSessionServices | undefined {
		return this.services;
	}
}

export default RlmAgentService;
export const name = "rlm-agent";
export const inject = ["rlmConfig", "rlmSession", "rlmTools", "rlmRefine"] as const;
export { RlmAgentService as RlmAgent };
// `SessionManager` is part of this row's public surface whether it was written
// down or not: `createRuntime` takes one, and the delegate's pool worker builds
// one per task so two tasks in one process cannot share a transcript. Re-exported
// here so a caller types itself against @rlm/agent rather than reaching past it
// into coding-agent internals and growing a second definition of the same thing.
export type { AgentSession, AgentSessionServices, CreateAgentSessionResult, AgentSessionRuntime, SessionManager };
