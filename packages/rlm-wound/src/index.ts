/**
 * @rlm/wound — failure detection / self-healing.
 *
 * Monitors agent errors. When patterns emerge, emits wound-detected events
 * that rlm-refinement listens for.
 *
 * Reference: DSH doesn't have a direct analog — this is rlm's self-healing
 * primitive, inspired by prime-agent's refinement trigger concept.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmWoundConfig {
	maxRefinePerPlugin?: number;
	cooldownTurns?: number;
}

export class RlmWoundService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmWound" as const;

	declare config: RlmWoundConfig;
	private woundCount: Map<string, number> = new Map();
	private turnsSinceLastRefine = 0;

	constructor(ctx: any, config: RlmWoundConfig = {}) {
		super(ctx, "rlmWound");
		this.config = config;
	}

	async [Service.init]() {
		this.ctx.on("rlm/agent-error", (event: { plugin?: string; error?: string }) => {
			this.recordWound(event?.plugin ?? "unknown", event);
		});
		this.ctx.on("rlm/agent-turn-end", () => this.tick());
		this.ctx.logger?.info("rlm-wound: failure detection ready");
	}

	recordWound(plugin: string, event: any): void {
		const count = (this.woundCount.get(plugin) ?? 0) + 1;
		this.woundCount.set(plugin, count);
		this.ctx.logger?.info(`rlm-wound: ${plugin} wound #${count}`);

		const max = this.config.maxRefinePerPlugin ?? 3;
		const cooldown = this.config.cooldownTurns ?? 5;
		if (count >= max && this.turnsSinceLastRefine >= cooldown) {
			this.turnsSinceLastRefine = 0;
			this.ctx.emit("rlm/wound-detected", { plugin, count, event });
		}
	}

	tick(): void {
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
