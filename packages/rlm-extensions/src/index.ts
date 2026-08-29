/**
 * @rlm/extensions — extension system.
 *
 * Clean Cordis Service. No prime-agent code.
 * Discovers and loads extensions from ~/.rlm/extensions.
 * Extensions can register tools, commands, and event handlers.
 *
 * Reference: DSH has dsh-tool-* and dsh-command-* as separate plugins.
 * rlm-extensions is simpler — extensions are JS/TS files that export
 * a register function receiving the Cordis context.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

export interface RlmExtensionsConfig {
	extensionsDir?: string;
	disabled?: boolean;
}

export class RlmExtensionsService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmExtensions" as const;

	declare config: RlmExtensionsConfig;
	private loaded: Map<string, any> = new Map();

	constructor(ctx: any, config: RlmExtensionsConfig = {}) {
		super(ctx, "rlmExtensions");
		this.config = config;
	}

	async [Service.init]() {
		if (this.config.disabled) {
			this.ctx.logger?.info("rlm-extensions: disabled");
			return;
		}
		const dir = this.config.extensionsDir ?? join(homedir(), ".rlm", "extensions");
		if (!existsSync(dir)) {
			this.ctx.logger?.info("rlm-extensions: no extensions dir");
			return;
		}
		await this.loadAll(dir);
	}

	private async loadAll(dir: string): Promise<void> {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (!statSync(path).isFile()) continue;
			if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) continue;
			try {
				const mod = await import(path);
				const register = mod.default ?? mod.register;
				if (typeof register === "function") {
					register(this.ctx);
					this.loaded.set(entry, mod);
					this.ctx.logger?.info(`rlm-extensions: loaded ${entry}`);
				}
			} catch (error) {
				this.ctx.logger?.warn(`rlm-extensions: failed to load ${entry}: ${error}`);
			}
		}
	}

	get list() {
		return [...this.loaded.keys()];
	}

	async [Symbol.dispose]() {
		this.loaded.clear();
	}
}

export default RlmExtensionsService;
export const name = "rlm-extensions";
export const inject = ["rlmAgent"] as const;
export { RlmExtensionsService as RlmExtensions };
