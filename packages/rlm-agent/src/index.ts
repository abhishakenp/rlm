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
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	type AgentSessionServices,
	type CreateAgentSessionServicesOptions,
	type CreateAgentSessionFromServicesOptions,
} from "../../coding-agent/src/core/agent-session-services.js";
import {
	createAgentSessionRuntime,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
} from "../../coding-agent/src/core/agent-session-runtime.js";
import type { AgentSession } from "../../coding-agent/src/core/agent-session.js";
import type { SessionManager } from "../../coding-agent/src/core/session-manager.js";
import type { CreateAgentSessionResult } from "../../coding-agent/src/core/sdk.js";
import { getAgentDir } from "../../coding-agent/src/config.js";

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

	constructor(ctx: any, config: RlmAgentConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
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

		const settingsManager = rlmConfig?.getSettingsManager?.();
		const cwd = this.config.cwd ?? settingsManager?.getCwd?.() ?? process.cwd();
		const agentDir = this.config.agentDir ?? getAgentDir();

		this.services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: rlmConfig?.getAuthStorage?.() as never,
			settingsManager: settingsManager as never,
			modelRegistry: rlmConfig?.getModelRegistry?.() as never,
		});

		void rlmSession?.getSessionManager?.();

		this.ctx.logger?.info(`rlm-agent: ready (cwd=${cwd}, agentDir=${agentDir})`);
	}

	async createServices(
		opts: Omit<CreateAgentSessionServicesOptions, "cwd" | "agentDir"> &
			Partial<Pick<CreateAgentSessionServicesOptions, "cwd" | "agentDir">>,
	): Promise<AgentSessionServices> {
		// Wire rlmPrompt's buildCompositePrompt() into the AgentSession's
		// system prompt via appendSystemPromptOverride. This makes all
		// registered prompt fragments (context registry, learnings, refine,
		// SDK subagent guidance, etc.) visible to the AI on every turn.
		const getPromptSvc = () => {
			try {
				const fromGlobal = (globalThis as any).__rlmPrompt;
				if (fromGlobal?.buildCompositePrompt) return fromGlobal;
			} catch {}
			try {
				const fromCtx = (this.ctx as any)?.get?.("rlmPrompt");
				if (fromCtx?.buildCompositePrompt) return fromCtx;
			} catch {}
			return null;
		};

		const base: CreateAgentSessionServicesOptions = {
			cwd: this.services?.cwd ?? this.config.cwd ?? process.cwd(),
			agentDir: this.services?.agentDir ?? this.config.agentDir ?? getAgentDir(),
			resourceLoaderOptions: {
				// In-process extension factories contributed by other plugins
				// (see @rlm/gitpixel). Resolved lazily at session-creation time so
				// a fiber.restart() on the contributing plugin is picked up by the
				// next session without restarting the agent.
				extensionFactories: getContributedExtensionFactories(),
				appendSystemPromptOverride: (baseAppend: string[]) => {
					const svc = getPromptSvc();
					const composite = svc?.buildCompositePrompt?.() ?? "";
					return [...baseAppend, composite];
				},
			},
			...opts,
		};
		return createAgentSessionServices(base);
	}

	async createSession(
		opts: Omit<CreateAgentSessionFromServicesOptions, "services" | "sessionManager"> &
			Partial<Pick<CreateAgentSessionFromServicesOptions, "services" | "sessionManager">>,
	): Promise<CreateAgentSessionResult> {
		const rlmSession = this.ctx.get("rlmSession") as {
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
	}): Promise<AgentSessionRuntime> {
		const rlmSession = this.ctx.get("rlmSession") as {
			getSessionManager: () => SessionManager;
		};
		const sessionManager = rlmSession?.getSessionManager?.();
		if (!sessionManager) {
			throw new Error("rlm-agent: no SessionManager available");
		}
		const cwd = this.services?.cwd ?? this.config.cwd ?? process.cwd();
		const agentDir = this.services?.agentDir ?? this.config.agentDir ?? getAgentDir();

		const createRuntimeFn: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
			const prepared = await this.createServices({
				cwd,
				agentDir,
			});
			const created = await this.createSession({
				services: prepared,
				sessionManager,
				...(runtimeOptions.sessionOptions ?? {}),
			});
			return {
				...created,
				services: prepared,
				diagnostics: [],
			};
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
export type { AgentSession, AgentSessionServices, CreateAgentSessionResult, AgentSessionRuntime };
