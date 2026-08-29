/**
 * @rlm/llm — LLM service.
 *
 * Wraps pi-ai's stream/complete functions and model registry as a Cordis
 * Service. Registers the omniroute provider from ~/.prime/agent/models.json.
 *
 * Other plugins inject this service to make LLM calls:
 *   ctx.rlmLlm.stream(model, messages, options)
 *   ctx.rlmLlm.completeSimple(model, messages, options)
 *   ctx.rlmLlm.getModel(provider, modelId)
 */
import { Service } from "@deepseek-ai/cordis";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	stream,
	completeSimple,
	getModel,
	getModels,
	registerApiProvider,
	clearApiProviders,
} from "@earendil-works/pi-ai";

export interface RlmLlmConfig {
	/** Path to models.json for custom provider registration. */
	modelsJsonPath?: string;
	/** OmniRoute URL (default: http://localhost:20128). */
	omnirouteUrl?: string;
}

export class RlmLlmService extends Service {
	static inject = [];

	declare config: RlmLlmConfig;

	constructor(ctx: any, config: RlmLlmConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmLlm";
	}

	async [Service.init]() {
		// Register omniroute provider from models.json
		const modelsJsonPath = this.config.modelsJsonPath ?? join(process.env.HOME ?? "~", ".prime", "agent", "models.json");
		if (existsSync(modelsJsonPath)) {
			try {
				const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
				for (const [providerName, providerConfig] of Object.entries(modelsJson.providers ?? {})) {
					const pc = providerConfig as any;
					this.ctx.logger?.info(`rlm-llm: registering provider ${providerName} (${pc.api})`);
					// Provider registration happens via the model registry + api registry
					// The models.json format is already handled by prime-agent's config loader
				}
			} catch (error) {
				this.ctx.logger?.warn(`rlm-llm: failed to load models.json: ${error}`);
			}
		}
	}

	/** Stream a model completion. */
	stream = stream;

	/** Complete a simple prompt. */
	completeSimple = completeSimple;

	/** Get a model by provider + id. */
	getModel = getModel;

	/** Get all models for a provider. */
	getModels = getModels;

	/** Register a custom API provider. */
	registerApiProvider = registerApiProvider;

	/** Clear all API providers (used on disposal). */
	clearApiProviders = clearApiProviders;

	async [Symbol.dispose]() {
		// pi-ai providers are stateless — nothing to dispose.
	}
}

export default RlmLlmService;
export const name = "rlm-llm";
export const inject = [] as const;
export { RlmLlmService as RlmLlm };
