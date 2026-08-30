/**
 * @rlm/tools — tool registry (code, edit) as a Cordis Service.
 *
 * Wraps the existing coding-agent tool definitions behind a service so other
 * plugins can resolve tools via dependency injection instead of importing the
 * coding-agent internals directly.
 *
 * Depends on @rlm/config for the default cwd.
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import { createAllToolDefinitions, type ToolsOptions } from "../../coding-agent/src/core/tools/index.js";
import {
	createCodeTool,
	createCodeToolDefinition,
	type CodeToolOptions,
} from "../../coding-agent/src/core/tools/code.js";

export interface RlmToolsConfig {
	timeout?: number;
	maxOutputChars?: number;
}

export class RlmToolsService extends Service {
	static inject = ["rlmConfig"] as const;
	static provide = "rlmTools" as const;

	declare config: RlmToolsConfig;

	private cwd: string | undefined;

	constructor(ctx: any, config: RlmToolsConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		const rlmConfig = this.ctx.get("rlmConfig") as {
			config?: { cwd?: string };
		};
		this.cwd = rlmConfig?.config?.cwd ?? process.cwd();

		this.ctx.logger?.info(`rlm-tools: ready (cwd=${this.cwd})`);
	}

	createTools(cwd?: string, options?: ToolsOptions) {
		return createAllToolDefinitions(cwd ?? this.cwd ?? process.cwd(), options);
	}

	createCodeTool(cwd?: string, options?: CodeToolOptions) {
		const merged: CodeToolOptions = {
			timeout: this.config.timeout,
			maxOutputChars: this.config.maxOutputChars,
			...options,
		};
		return createCodeTool(cwd ?? this.cwd ?? process.cwd(), merged);
	}

	createCodeToolDefinition(cwd?: string, options?: CodeToolOptions) {
		const merged: CodeToolOptions = {
			timeout: this.config.timeout,
			maxOutputChars: this.config.maxOutputChars,
			...options,
		};
		return createCodeToolDefinition(cwd ?? this.cwd ?? process.cwd(), merged);
	}
}

export default RlmToolsService;
export const name = "rlm-tools";
export const inject = ["rlmConfig"] as const;
export { RlmToolsService as RlmTools };
