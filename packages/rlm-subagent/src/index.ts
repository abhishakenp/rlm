/**
 * @rlm/subagent — recursive subagent service.
 *
 * Clean Cordis Service. No prime-agent code.
 * Spawns child agent runs with depth enforcement.
 *
 * Reference: DSH's dsh-subagent exposes a SubagentRuntime service.
 * rlm-subagent does the same — spawns child agents via rlm-agent.run()
 * with incremented depth. Depth limit prevents infinite recursion.
 *
 * The subagent tool is registered with rlm-agent so the LLM can call it.
 */
import { Service } from "@deepseek-ai/cordis";
import type { ToolDefinition, AgentRunContext } from "@rlm/agent";

export interface RlmSubagentConfig {
	maxDepth?: number;
}

export class RlmSubagentService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmSubagent" as const;

	declare config: RlmSubagentConfig;
	private activeChildren: Map<string, AbortController> = new Map();

	constructor(ctx: any, config: RlmSubagentConfig = {}) {
		super(ctx, "rlmSubagent");
		this.config = config;
	}

	async [Service.init]() {
		// Register the subagent tool with rlm-agent.
		const agent = this.ctx.get("rlmAgent");
		if (agent) {
			agent.registerTool(this.getToolDefinition());
		}
		this.ctx.logger?.info(`rlm-subagent: recursive subagent ready (maxDepth=${this.config.maxDepth ?? 10})`);
	}

	private getToolDefinition(): ToolDefinition {
		return {
			name: "subagent",
			description: `Spawn a recursive subagent to handle a subtask.
The subagent runs its own agent loop with the same tools.
Use this for complex subtasks that benefit from focused attention.
The subagent inherits the current depth + 1.`,
			parameters: {
				type: "object",
				properties: {
					prompt: {
						type: "string",
						description: "The prompt for the subagent.",
					},
				},
				required: ["prompt"],
			},
			execute: async (args: { prompt: string }, runCtx: AgentRunContext) => {
				return this.spawn({
					prompt: args.prompt,
					depth: runCtx.depth + 1,
					maxDepth: runCtx.maxDepth,
					cwd: runCtx.cwd,
				});
			},
		};
	}

	/** Spawn a recursive subagent. Returns the subagent's final response. */
	async spawn(opts: {
		prompt: string;
		depth: number;
		maxDepth?: number;
		cwd?: string;
	}): Promise<string> {
		const maxDepth = opts.maxDepth ?? this.config.maxDepth ?? 10;
		if (opts.depth >= maxDepth) {
			return `subagent: max depth ${maxDepth} exceeded (current: ${opts.depth})`;
		}

		const childId = `child-${opts.depth}-${Date.now()}`;
		const controller = new AbortController();
		this.activeChildren.set(childId, controller);

		this.ctx.logger?.info(`rlm-subagent: spawning ${childId} at depth ${opts.depth}`);
		this.ctx.emit("rlm/subagent-spawn", { id: childId, depth: opts.depth, prompt: opts.prompt });

		try {
			const agent = this.ctx.get("rlmAgent");
			if (!agent) throw new Error("rlm-subagent: rlmAgent service not available");

			const result = await agent.run({
				prompt: opts.prompt,
				cwd: opts.cwd,
				depth: opts.depth,
				maxDepth,
				abortSignal: controller.signal,
				systemPrompt: `You are a recursive subagent of rlm (depth ${opts.depth}/${maxDepth}).
Be concise. Complete the subtask and return the result.`,
			});

			this.ctx.emit("rlm/subagent-complete", { id: childId, depth: opts.depth, result });
			return result;
		} finally {
			this.activeChildren.delete(childId);
		}
	}

	/** Cancel all active children. */
	cancelAll() {
		for (const [, controller] of this.activeChildren) {
			controller.abort();
		}
		this.activeChildren.clear();
	}

	async [Symbol.dispose]() {
		this.cancelAll();
	}
}

export default RlmSubagentService;
export const name = "rlm-subagent";
export const inject = ["rlmAgent"] as const;
export { RlmSubagentService as RlmSubagent };
