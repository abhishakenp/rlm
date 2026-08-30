/**
 * @rlm/tui-renderer — InteractiveMode TUI as a Cordis Service.
 *
 * Wraps the coding-agent InteractiveMode behind a service so other plugins can
 * launch and stop the interactive TUI via dependency injection instead of
 * importing the coding-agent modes directly.
 *
 * Depends on:
 * - @rlm/agent (rlmAgent) for agent session services
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import {
	InteractiveMode,
	type InteractiveModeOptions,
	type InteractiveModeRunResult,
} from "../../coding-agent/src/modes/interactive/interactive-mode.js";

export interface RlmRendererConfig {
	cwd?: string;
}

export interface RlmRendererStartOptions {
	/** Full InteractiveMode options; agentConnection is required. */
	options: InteractiveModeOptions;
}

export class RlmRendererService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmRenderer" as const;

	declare config: RlmRendererConfig;

	private instance: InteractiveMode | undefined;

	constructor(ctx: any, config: RlmRendererConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		const cwd = this.config.cwd ?? process.cwd();
		this.ctx.logger?.info(`rlm-tui-renderer: ready (cwd=${cwd})`);
	}

	async start(opts: RlmRendererStartOptions): Promise<InteractiveModeRunResult> {
		if (this.instance) {
			throw new Error("rlm-tui-renderer: InteractiveMode already running");
		}
		this.instance = new InteractiveMode(opts.options);
		return this.instance.run();
	}

	async stop(): Promise<void> {
		if (!this.instance) return;
		this.instance.stop();
		this.instance = undefined;
	}
}

export default RlmRendererService;
export const name = "rlm-tui-renderer";
export const inject = ["rlmAgent"] as const;
export { RlmRendererService as RlmRenderer };
export type { InteractiveModeOptions, InteractiveModeRunResult };
