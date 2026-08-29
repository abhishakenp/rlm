/**
 * @rlm/refinement — LLM-backed self-improvement.
 *
 * When wounds are detected, proposes improvements to system prompt,
 * tools, or memory. Subscribes to rlm/wound-detected events.
 *
 * Reference: prime-agent's refinement engine — LLM-proposed edits to
 * persistent state. DSH's dsh-compaction for context management.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmRefinementConfig {
	maxProposals?: number;
	autoApply?: boolean;
}

export class RlmRefinementService extends Service {
	static inject = ["rlmAgent", "rlmLlm", "rlmMemory"] as const;
	static provide = "rlmRefinement" as const;

	declare config: RlmRefinementConfig;
	private proposals: any[] = [];

	constructor(ctx: any, config: RlmRefinementConfig = {}) {
		super(ctx, "rlmRefinement");
		this.config = config;
	}

	async [Service.init]() {
		this.ctx.on("rlm/wound-detected", (event: { plugin: string; count: number; event: any }) => {
			this.triggerRefinement(event).catch((e) =>
				this.ctx.logger?.warn(`rlm-refinement: ${e}`),
			);
		});
		this.ctx.logger?.info("rlm-refinement: self-improvement ready");
	}

	async triggerRefinement(event: { plugin: string; count: number; event: any }): Promise<void> {
		const llm = this.ctx.get("rlmLlm");
		const memory = this.ctx.get("rlmMemory");
		if (!llm) return;

		this.ctx.logger?.info(`rlm-refinement: triggered for ${event.plugin} (${event.count} wounds)`);

		const proposal = await llm.ask(
			`Plugin "${event.plugin}" has failed ${event.count} times. ` +
			`Last error: ${JSON.stringify(event.event)}. ` +
			`Propose a concrete fix in 1-2 sentences. Be specific.`,
			{ temperature: 0.3 },
		);

		this.proposals.push({
			timestamp: Date.now(),
			plugin: event.plugin,
			proposal,
			event: event.event,
		});

		if (this.proposals.length > (this.config.maxProposals ?? 5)) {
			this.proposals.shift();
		}

		if (this.config.autoApply && memory) {
			const existing = memory.get("refinement-proposals") ?? [];
			existing.push({ timestamp: Date.now(), plugin: event.plugin, proposal });
			memory.set("refinement-proposals", existing);
		}

		this.ctx.emit("rlm/refinement-proposed", { plugin: event.plugin, proposal });
	}

	get pendingProposals() {
		return this.proposals;
	}

	async [Symbol.dispose]() {
		this.proposals = [];
	}
}

export default RlmRefinementService;
export const name = "rlm-refinement";
export const inject = ["rlmAgent", "rlmLlm", "rlmMemory"] as const;
export { RlmRefinementService as RlmRefinement };
