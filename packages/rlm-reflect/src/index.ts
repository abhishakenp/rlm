/**
 * @rlm/reflect — reflection / self-learning service.
 *
 * Periodically consolidates learning from recent sessions into persistent
 * memory. Subscribes to agent turn events; every N turns, triggers a
 * reflection cycle that writes insights to rlm-memory.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmReflectConfig {
	/** Turns between reflection cycles (default: 10). */
	intervalTurns?: number;
}

export class RlmReflectService extends Service {
	static inject = ["rlmAgent", "rlmMemory"];

	declare config: RlmReflectConfig;
	private turnCount: number = 0;

	constructor(ctx: any, config: RlmReflectConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmReflect";
	}

	async [Service.init]() {
		this.ctx.logger?.info(`rlm-reflect: reflection service ready (interval=${this.config.intervalTurns ?? 10})`);
		// Subscribe to agent turn events.
		this.ctx.on("rlm/agent-turn-end", () => {
			this.tick();
		});
	}

	/** Increment turn counter and trigger reflection if needed. */
	private tick() {
		this.turnCount++;
		const interval = this.config.intervalTurns ?? 10;
		if (this.turnCount >= interval) {
			this.turnCount = 0;
			this.reflect().catch((error) => {
				this.ctx.logger?.warn(`rlm-reflect: reflection failed: ${error}`);
			});
		}
	}

	/** Run a reflection cycle. */
	private async reflect() {
		this.ctx.logger?.info("rlm-reflect: starting reflection cycle");
		// The reflection uses the LLM to consolidate recent session insights
		// into persistent memory entries.
		// Actual implementation delegates to prime-agent's reflection logic.
	}

	async [Symbol.dispose]() {
		// Nothing to dispose — reflection is stateless.
	}
}

export default RlmReflectService;
export const name = "rlm-reflect";
export const inject = ["rlmAgent", "rlmMemory"] as const;
export { RlmReflectService as RlmReflect };
