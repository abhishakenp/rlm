/**
 * @rlm/refine — the continual harness refinement system as a Cordis Service.
 *
 * Wraps the existing refinement functions from the coding-agent source so they
 * can be resolved through the Cordis service container. Depends on @rlm/config
 * for the agent dir used to locate the global harness state directory.
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	planRefinement,
	refineHarness,
	reviewAutoRefine,
	loadHarnessState,
	saveHarnessState,
	applyRefinementProposal,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
} from "../../coding-agent/src/core/refinement/refinement.js";
import type {
	HarnessState,
	HarnessScope,
	RefineOptions,
	RefinementProposal,
	RefinementResult,
	RefinementPlan,
	AutoRefineReview,
	AutoRefineReviewContext,
} from "../../coding-agent/src/core/refinement/refinement.js";

export interface RlmRefineConfig {}

export class RlmRefineService extends Service {
	static inject = ["rlmConfig"] as const;
	static provide = "rlmRefine" as const;

	declare config: RlmRefineConfig;

	agentDir!: string;
	harnessState!: HarnessState;

	constructor(ctx: any, config: RlmRefineConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		const rlmConfig = this.ctx.rlmConfig;
		this.agentDir = rlmConfig?.config?.agentDir ?? rlmConfig?.getAgentDir?.() ?? process.cwd();
		const globalHarnessDir = getGlobalHarnessStateDir(this.agentDir);
		this.harnessState = loadHarnessState(globalHarnessDir, "global");

		this.ctx.logger?.info(`rlm-refine: ready (agentDir=${this.agentDir})`);
	}

	planRefinement(
		messages: AgentMessage[],
		state: HarnessState,
		history: RefinementResult[],
		model: Model<any>,
		apiKey: string,
		options: RefineOptions = {},
		headers?: Record<string, string>,
		signal?: AbortSignal,
		thinkingLevel?: ThinkingLevel,
	): Promise<RefinementPlan> {
		return planRefinement(messages, state, history, model, apiKey, options, headers, signal, thinkingLevel);
	}

	refineHarness(
		messages: AgentMessage[],
		state: HarnessState,
		history: RefinementResult[],
		model: Model<any>,
		apiKey: string,
		options: RefineOptions = {},
		headers?: Record<string, string>,
		signal?: AbortSignal,
		thinkingLevel?: ThinkingLevel,
	): Promise<RefinementResult> {
		return refineHarness(messages, state, history, model, apiKey, options, headers, signal, thinkingLevel);
	}

	reviewAutoRefine(
		messages: AgentMessage[],
		state: HarnessState,
		history: RefinementResult[],
		model: Model<any>,
		apiKey: string,
		context: AutoRefineReviewContext,
		headers?: Record<string, string>,
		signal?: AbortSignal,
		thinkingLevel?: ThinkingLevel,
	): Promise<AutoRefineReview> {
		return reviewAutoRefine(messages, state, history, model, apiKey, context, headers, signal, thinkingLevel);
	}

	loadHarnessState(harnessStateDir?: string, scope: HarnessScope = "global"): HarnessState {
		return loadHarnessState(harnessStateDir ?? getGlobalHarnessStateDir(this.agentDir), scope);
	}

	saveHarnessState(harnessStateDir: string, state: HarnessState): string {
		return saveHarnessState(harnessStateDir, state);
	}

	applyRefinementProposal(
		proposal: RefinementProposal,
		state: HarnessState,
		options: { id: string; rollbackOf?: string; scope?: HarnessScope; baselineState?: HarnessState },
	): RefinementResult {
		return applyRefinementProposal(state, proposal, options);
	}

	getGlobalHarnessStateDir(): string {
		return getGlobalHarnessStateDir(this.agentDir);
	}

	getLocalHarnessStateDir(sessionDir: string | undefined): string | undefined {
		return getLocalHarnessStateDir(sessionDir);
	}
}

export default RlmRefineService;
export const name = "rlm-refine";
export const inject = ["rlmConfig"] as const;
export { RlmRefineService as RlmRefine };
export type {
	HarnessState,
	HarnessScope,
	RefineOptions,
	RefinementProposal,
	RefinementResult,
	RefinementPlan,
	AutoRefineReview,
	AutoRefineReviewContext,
};
