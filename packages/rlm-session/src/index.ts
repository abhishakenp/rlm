/**
 * @rlm/session — SessionManager as a Cordis Service.
 *
 * Depends on @rlm/config (rlmConfig) for agentDir/cwd. Exposes:
 * - sessionManager (SessionManager)
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import { SessionManager, getDefaultSessionDir } from "../../coding-agent/src/core/session-manager.js";

export interface RlmSessionConfig {
	sessionDir?: string;
}

export class RlmSessionService extends Service {
	static inject = ["rlmConfig"] as const;
	static provide = "rlmSession" as const;

	declare config: RlmSessionConfig;

	sessionManager!: SessionManager;

	constructor(ctx: any, config: RlmSessionConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		const rlmConfig = this.ctx.get("rlmConfig") as { config?: { cwd?: string } };
		const cwd = rlmConfig?.config?.cwd ?? process.cwd();

		const sessionDir = this.config.sessionDir ?? getDefaultSessionDir(cwd);
		this.sessionManager = SessionManager.create(cwd, sessionDir);

		this.ctx.logger?.info(`rlm-session: ready (sessionDir=${sessionDir})`);
	}

	getSessionManager(): SessionManager {
		return this.sessionManager;
	}
}

export default RlmSessionService;
export const name = "rlm-session";
export const inject = ["rlmConfig"] as const;
export { RlmSessionService as RlmSession };
