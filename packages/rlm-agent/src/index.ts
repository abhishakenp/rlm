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
		const base: CreateAgentSessionServicesOptions = {
			cwd: this.services?.cwd ?? this.config.cwd ?? process.cwd(),
			agentDir: this.services?.agentDir ?? this.config.agentDir ?? getAgentDir(),
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
