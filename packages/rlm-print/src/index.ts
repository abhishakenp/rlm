/**
 * @rlm/print — Print mode (single-shot) as a Cordis Service.
 *
 * Wraps runPrintMode behind a service. Creates the full agent runtime
 * via rlmAgent, then runs print mode with an InProcessAgentConnection.
 * No fallbacks.
 *
 * Depends on:
 * - @rlm/agent (rlmAgent) for createRuntime()
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import { runPrintMode, type PrintModeOptions } from "../../coding-agent/src/modes/print-mode.js";
import type { AgentSessionRuntime } from "../../coding-agent/src/core/agent-session-runtime.js";

export interface RlmPrintConfig {
	cwd?: string;
}

export class RlmPrintService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmPrint" as const;

	declare config: RlmPrintConfig;

	private runtime: AgentSessionRuntime | undefined;

	constructor(ctx: any, config: RlmPrintConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		this.ctx.logger?.info(`rlm-print: ready`);
	}

	/**
	 * Run print mode: create runtime, send prompt, output result, exit.
	 * Returns the exit code.
	 */
	async run(options: PrintModeOptions): Promise<number> {
		const rlmAgent = this.ctx.get("rlmAgent") as {
			createRuntime: (options: {
				sessionConfig?: Record<string, unknown>;
				sessionOptions?: Record<string, unknown>;
			}) => Promise<AgentSessionRuntime>;
		};

		if (!rlmAgent?.createRuntime) {
			throw new Error("rlm-print: rlmAgent.createRuntime not available");
		}

		this.runtime = await rlmAgent.createRuntime({});
		return runPrintMode(this.runtime, options);
	}

	async stop(): Promise<void> {
		if (this.runtime) {
			await this.runtime.dispose?.();
			this.runtime = undefined;
		}
	}
}

export default RlmPrintService;
export const name = "rlm-print";
export const inject = ["rlmAgent"] as const;
export { RlmPrintService as RlmPrint };
export type { PrintModeOptions };
