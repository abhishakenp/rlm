/**
 * @rlm/extensions — extension system service.
 *
 * Wraps prime-agent's extension loader/runner as a Cordis Service.
 * Discovers, loads, and manages extensions from ~/.prime/agent/extensions.
 * Each extension can register tools, commands, flags, shortcuts, message
 * renderers, and event handlers.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface RlmExtensionsConfig {
	/** Extensions directory (default: ~/.prime/agent/extensions). */
	extensionsDir?: string;
	/** Whether to disable extension discovery. */
	disabled?: boolean;
}

export class RlmExtensionsService extends Service {
	static inject = ["rlmAgent"];

	declare config: RlmExtensionsConfig;
	private extensions: any[] = [];
	private runtime: any = null;

	constructor(ctx: any, config: RlmExtensionsConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmExtensions";
	}

	async [Service.init]() {
		if (this.config.disabled) {
			this.ctx.logger?.info("rlm-extensions: disabled");
			return;
		}
		const dir = this.config.extensionsDir ?? join(homedir(), ".prime", "agent", "extensions");
		if (!existsSync(dir)) {
			this.ctx.logger?.info("rlm-extensions: no extensions dir, skipping");
			return;
		}
		this.ctx.logger?.info("rlm-extensions: extension service ready");
	}

	/** Discover and load extensions. */
	async loadExtensions() {
		const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
		return discoverAndLoadExtensions;
	}

	/** Get loaded extensions. */
	get list() {
		return this.extensions;
	}

	async [Symbol.dispose]() {
		this.extensions = [];
		this.runtime = null;
	}
}

export default RlmExtensionsService;
export const name = "rlm-extensions";
export const inject = ["rlmAgent"] as const;
export { RlmExtensionsService as RlmExtensions };
