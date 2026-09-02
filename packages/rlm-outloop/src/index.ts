/**
 * @rlm/outloop — the me-2 reviewer loop as a standalone service.
 *
 * Plugs into rlm-delegate's forReview seam and provides the reviewer (me-2)
 * that judges whether finished work actually fulfills the request. Pure
 * function: text in, judgement out. No disk, no graph, no side effects.
 */
import { Service } from "@deepseek-ai/cordis";

export * from "./contract.ts";
export { review } from "./reviewer.ts";
export { loadRubric, getCachedRubric, rebuildRubric } from "./rubric.ts";
export { survey, describeProof, floorF1, floorF2, identifiers, proofIdentifiers, verbCategory } from "./survey.ts";
export { readTranscripts, readIris, readDelegate } from "./transcripts.ts";

export const name = "rlm-outloop";

export interface RlmOutloopConfig {
	/** Base path for iris transcripts. Defaults to ~/.iris/mind/sessions */
	irisPath?: string;
	/** Base path for delegate transcripts. Defaults to ~/.rlm/agent/delegate */
	delegatePath?: string;
}

export const configFields = [
	{
		key: "irisPath",
		type: "string",
		description: "Base path for iris transcripts",
	},
	{
		key: "delegatePath",
		type: "string",
		description: "Base path for delegate transcripts",
	},
];

export class RlmOutloopService extends Service {
	static inject = [] as const;
	static provide = "rlmOutloop" as const;

	declare config: RlmOutloopConfig;

	constructor(ctx: any, config: RlmOutloopConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		// Nothing to initialize — all functions are pure and stateless.
	}
}

export default RlmOutloopService;
export { RlmOutloopService as RlmOutloop };
