/**
 * @rlm/agent — agent session/loop service.
 *
 * Wraps prime-agent's AgentSession as a Cordis Service.
 * Depends on rlm-session, rlm-llm, rlm-kernel.
 * Owns the agent loop, tool dispatch, and model cycling.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmAgentConfig {
	/** Maximum RLM recursion depth (default: 10). */
	maxDepth?: number;
	/** Default provider. */
	defaultProvider?: string;
	/** Default model. */
	defaultModel?: string;
	/** Default thinking level. */
	defaultThinking?: string;
}

export class RlmAgentService extends Service {
	static inject = ["rlmSession", "rlmLlm"];

	declare config: RlmAgentConfig;
	private session: any = null;

	constructor(ctx: any, config: RlmAgentConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmAgent";
	}

	async [Service.init]() {
		this.ctx.logger?.info("rlm-agent: AgentSession service ready");
		// AgentSession is created per-interaction, not at boot.
		// This service provides the factory + config.
	}

	/** Create an AgentSession for a new interaction. */
	async createSession(opts: any = {}) {
		const { AgentSession } = await import("@earendil-works/pi-coding-agent");
		const config = {
			rlmMaxDepth: this.config.maxDepth ?? 10,
			defaultProvider: this.config.defaultProvider ?? "omniroute",
			defaultModel: this.config.defaultModel ?? "auto/best-free",
			defaultThinkingLevel: this.config.defaultThinking ?? "high",
			...opts,
		};
		return AgentSession;
	}

	/** Get the current active session (if any). */
	get current() {
		return this.session;
	}

	async [Symbol.dispose]() {
		if (this.session?.dispose) {
			await this.session.dispose();
		}
		this.session = null;
	}
}

export default RlmAgentService;
export const name = "rlm-agent";
export const inject = ["rlmSession", "rlmLlm"] as const;
export { RlmAgentService as RlmAgent };
