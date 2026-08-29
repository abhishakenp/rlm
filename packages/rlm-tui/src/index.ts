/**
 * @rlm/tui — terminal UI service.
 *
 * Wraps prime-agent's TUI as a Cordis Service.
 * Owns the terminal rendering surface — differential rendering, input,
 * scrollback, and the agent conversation view.
 *
 * On disposal (HMR): stops rendering, restores terminal state.
 * On reload: re-initializes the TUI with a fresh instance.
 *
 * This is the direct analog of DSH's dsh-host-frontend-static (web GUI plugin).
 * In DSH the web GUI is a plugin; in rlm the TUI is a plugin.
 */
import { Service } from "@deepseek-ai/cordis";

export interface RlmTuiConfig {
	/** Theme name (default: system). */
	theme?: string;
	/** Max output chars per cell (default: 65536). */
	maxOutputChars?: number;
}

export class RlmTuiService extends Service {
	static inject = ["rlmAgent"];

	declare config: RlmTuiConfig;
	private tui: any = null;

	constructor(ctx: any, config: RlmTuiConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmTui";
	}

	async [Service.init]() {
		this.ctx.logger?.info("rlm-tui: TUI service ready (lazy init)");
		// TUI is created on interactive start, not at boot.
	}

	/** Start the TUI. */
	async start(opts: any = {}) {
		if (this.tui) return this.tui;
		const { TUI } = await import("@earendil-works/pi-tui");
		this.tui = new TUI({
			maxOutputChars: this.config.maxOutputChars ?? 65536,
			...opts,
		});
		return this.tui;
	}

	/** Get the running TUI instance (if any). */
	get instance() {
		return this.tui;
	}

	/** Stop the TUI and restore terminal state. */
	async stop(opts?: any) {
		if (this.tui) {
			await this.tui.stop(opts);
			this.tui = null;
		}
	}

	async [Symbol.dispose]() {
		await this.stop();
	}
}

export default RlmTuiService;
export const name = "rlm-tui";
export const inject = ["rlmAgent"] as const;
export { RlmTuiService as RlmTui };
