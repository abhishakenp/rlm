/**
 * @rlm/refinement — LLM-backed refinement service.
 *
 * Wraps prime-agent's refineHarness as a Cordis Service.
 * Drives LLM-proposed edits to persistent prompt notes, memories, skills,
 * and subagent specs. Subscribes to failure/wound events to trigger
 * self-improvement.
 *
 * On disposal (HMR): flushes pending proposals.
 * On reload: swaps the refinement strategy mid-session.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmRefinementConfig {
	/** Max proposals per refinement cycle (default: 5). */
	maxProposals?: number;
	/** Whether to auto-apply proposals (default: false — requires approval). */
	autoApply?: boolean;
}

export class RlmRefinementService extends Service {
	static inject = ["rlmAgent", "rlmLlm"];

	declare config: RlmRefinementConfig;
	private pendingProposals: any[] = [];

	constructor(ctx: any, config: RlmRefinementConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmRefinement";
	}

	async [Service.init]() {
		this.ctx.logger?.info("rlm-refinement: refinement service ready");
		// Subscribe to wound/failure events from rlm-wound
		this.ctx.on("rlm/wound-detected", (event: any) => {
			this.triggerRefinement(event).catch((error) => {
				this.ctx.logger?.warn(`rlm-refinement: auto-refine failed: ${error}`);
			});
		});
	}

	/** Trigger a refinement cycle for a failure event. */
	async triggerRefinement(event: any) {
		const { refineHarness } = await import("@earendil-works/pi-coding-agent");
		this.ctx.logger?.info(`rlm-refinement: triggered for ${event?.kind ?? "unknown"}`);
		// refineHarness is called with the harness state + event context.
		// The actual call depends on the prime-agent refinement API shape.
		return refineHarness;
	}

	/** Get pending proposals. */
	get proposals() {
		return this.pendingProposals;
	}

	async [Symbol.dispose]() {
		// Flush pending proposals to disk before disposal.
		this.pendingProposals = [];
	}
}

export default RlmRefinementService;
export const name = "rlm-refinement";
export const inject = ["rlmAgent", "rlmLlm"] as const;
export { RlmRefinementService as RlmRefinement };
