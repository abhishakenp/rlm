/**
 * @rlm/subagent — recursive subagent service.
 *
 * Wraps prime-agent's recursive subagent creation as a Cordis Service.
 * Depends on rlm-agent (for AgentSession) and rlm-kernel (for rlm.run).
 * Enforces rlmMaxDepth and manages child session lifecycle.
 *
 * This is the recursion primitive: rlm.run creates a child AgentSession
 * with inherited runtime behavior and explicit depth metadata.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmSubagentConfig {
	/** Maximum recursion depth (default: 10). */
	maxDepth?: number;
}

export class RlmSubagentService extends Service {
	static inject = ["rlmAgent", "rlmKernel"];

	declare config: RlmSubagentConfig;
	private activeChildren: Map<string, any> = new Map();

	constructor(ctx: any, config: RlmSubagentConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmSubagent";
	}

	async [Service.init]() {
		this.ctx.logger?.info(`rlm-subagent: recursive subagent service ready (maxDepth=${this.config.maxDepth ?? 10})`);
	}

	/** Spawn a recursive child agent. */
	async spawn(opts: {
		prompt: string;
		parentSession: any;
		rlmDepth: number;
		model?: any;
		cwd?: string;
	}) {
		const maxDepth = this.config.maxDepth ?? 10;
		if (opts.rlmDepth >= maxDepth) {
			throw new Error(`rlm-subagent: max depth ${maxDepth} exceeded (current: ${opts.rlmDepth})`);
		}
		// The actual spawn uses AgentSession._createInlineRlmSubagentRuntime
		// which creates a child SessionManager, Agent, and AgentSession.
		this.ctx.logger?.info(`rlm-subagent: spawning child at depth ${opts.rlmDepth + 1}`);
		// Return the prime-agent AgentSession class for the caller to construct.
		const { AgentSession } = await import("@earendil-works/pi-coding-agent");
		return AgentSession;
	}

	/** Get active child sessions. */
	get children() {
		return this.activeChildren;
	}

	async [Symbol.dispose]() {
		// Dispose all active child sessions.
		for (const [id, child] of this.activeChildren) {
			try {
				if (child?.dispose) await child.dispose();
			} catch {
				// Best-effort cleanup.
			}
		}
		this.activeChildren.clear();
	}
}

export default RlmSubagentService;
export const name = "rlm-subagent";
export const inject = ["rlmAgent", "rlmKernel"] as const;
export { RlmSubagentService as RlmSubagent };
