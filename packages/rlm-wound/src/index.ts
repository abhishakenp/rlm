/**
 * @rlm/wound — wound detection / self-healing service.
 *
 * Monitors agent failures and triggers refinement when patterns emerge.
 * Subscribes to agent error events; emits rlm/wound-detected events that
 * rlm-refinement listens for.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmWoundConfig {
	/** Max refinements per plugin before cooldown (default: 3). */
	maxRefinePerPlugin?: number;
	/** Cooldown turns between refinements (default: 5). */
	cooldownTurns?: number;
}

export class RlmWoundService extends Service {
	static inject = ["rlmAgent"];

	declare config: RlmWoundConfig;
	private woundCount: Map<string, number> = new Map();
	private turnsSinceLastRefine: number = 0;

	constructor(ctx: any, config: RlmWoundConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmWound";
	}

	async [Service.init]() {
		this.ctx.logger?.info("rlm-wound: wound detection service ready");
		// Subscribe to agent error events.
		this.ctx.on("rlm/agent-error", (event: any) => {
			this.recordWound(event?.plugin ?? "unknown", event);
		});
	}

	/** Record a wound and potentially trigger refinement. */
	recordWound(plugin: string, event: any) {
		const count = (this.woundCount.get(plugin) ?? 0) + 1;
		this.woundCount.set(plugin, count);
		this.ctx.logger?.info(`rlm-wound: ${plugin} wound #${count}`);

		const maxRefine = this.config.maxRefinePerPlugin ?? 3;
		const cooldown = this.config.cooldownTurns ?? 5;

		if (count >= maxRefine && this.turnsSinceLastRefine >= cooldown) {
			this.turnsSinceLastRefine = 0;
			this.ctx.emit("rlm/wound-detected", { plugin, count, event });
		}
	}

	/** Increment turn counter (called after each agent turn). */
	tick() {
		this.turnsSinceLastRefine++;
	}

	async [Symbol.dispose]() {
		this.woundCount.clear();
	}
}

export default RlmWoundService;
export const name = "rlm-wound";
export const inject = ["rlmAgent"] as const;
export { RlmWoundService as RlmWound };
