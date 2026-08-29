/**
 * @rlm/reflect — periodic reflection / self-learning.
 *
 * Every N turns, consolidates recent session insights into persistent memory.
 *
 * Reference: prime-agent's reflection concept — periodic LLM-backed
 * consolidation of learning into memory.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmReflectConfig {
	intervalTurns?: number;
}

export class RlmReflectService extends Service {
	static inject = ["rlmAgent", "rlmMemory", "rlmLlm"] as const;
	static provide = "rlmReflect" as const;

	declare config: RlmReflectConfig;
	private turnCount = 0;

	constructor(ctx: any, config: RlmReflectConfig = {}) {
		super(ctx, "rlmReflect");
		this.config = config;
	}

	async [Service.init]() {
		this.ctx.on("rlm/agent-turn-end", () => {
			this.turnCount++;
			const interval = this.config.intervalTurns ?? 10;
			if (this.turnCount >= interval) {
				this.turnCount = 0;
				this.reflect().catch((e) => this.ctx.logger?.warn(`rlm-reflect: ${e}`));
			}
		});
		this.ctx.logger?.info(`rlm-reflect: reflection ready (interval=${this.config.intervalTurns ?? 10})`);
	}

	private async reflect(): Promise<void> {
		const llm = this.ctx.get("rlmLlm");
		const memory = this.ctx.get("rlmMemory");
		if (!llm || !memory) return;

		this.ctx.logger?.info("rlm-reflect: starting reflection cycle");
		const existing = memory.get("reflections") ?? [];
		const result = await llm.ask(
			"Reflect on recent interactions. What patterns did you notice? " +
			"What could be improved? Be concise (2-3 sentences).",
			{ temperature: 0.7 },
		);
		existing.push({ timestamp: Date.now(), insight: result });
		memory.set("reflections", existing);
		this.ctx.logger?.info("rlm-reflect: stored reflection");
	}

	async [Symbol.dispose]() {
		// Stateless.
	}
}

export default RlmReflectService;
export const name = "rlm-reflect";
export const inject = ["rlmAgent", "rlmMemory", "rlmLlm"] as const;
export { RlmReflectService as RlmReflect };
