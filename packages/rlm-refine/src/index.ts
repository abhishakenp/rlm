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

// ─── Prompt Doctrine (MANDATORY) ────────────────────────────────────────────
//
// Plugin-owned, hot-reloadable system-prompt fragment registered via the
// rlmPrompt service. Makes self-evolution MANDATORY without a second
// AGENTS.md source. Registered at priority 70 (context=100, sdk=80) and
// removed on dispose so fiber.restart() updates the prompt live via
// rlm/prompt-changed.

export const REFINE_DOCTRINE = [
	"# Refine — Self-evolution (MANDATORY: use when repeated error/discovery)",
	"",
	"You MUST persist learnings when you observe a repeated failure, a reusable tactic, a repeated delegation pattern, or behavior worth preserving. This is MANDATORY self-evolution — do NOT rely only on auto-refine; you MUST explicitly call `await refine.run()` when evidence warrants it.",
	"",
	"## API",
	"",
	"- `await refine.run()` — schedule refinement. Returns IMMEDIATELY `{ scheduled: true }` (or `{ scheduled: false, reason }`), runs when the current turn ends. You MUST call this after evidence; it never runs mid-cell.",
	"- `await refine.run(\"create a memory about always checking git status before committing\")` — focus refinement on a specific observation. You MUST provide instructions that describe the evidence.",
	"- `await refine.run(\"promote the error-handling pattern to a global skill\", global_=True)` — persist cross-session (global); omit `global_` for local (session-scoped). Local is the default for task progress; global only for stable lessons, durable preferences, or reusable skills/subagents.",
	"- `await refine.status()` — current refine state as `{ pending: boolean, in_flight: boolean }`. Check before scheduling if unsure.",
	"",
	"## When you MUST call `await refine.run()`",
	"",
	"- A repeated failure or error pattern emerges (you fix the same mistake twice).",
	"- A reusable tactic or workflow emerges that should be codified.",
	"- A repeated delegation role should become a subagent spec.",
	"- A repeated procedure should become a skill.",
	"- A durable fact, preference, or project-specific truth should become a memory.",
	"- A narrow behavioral policy should become a prompt addendum.",
	"- A user corrects behavior that should persist locally or globally.",
	"- Validation shows a harness entry is wrong and needs update, delete, or rollback.",
	"",
	"## MANDATORY Rules — You MUST obey",
	"",
	"- You MUST treat refinement as a small, evidence-backed update: diagnose the issue, update the SMALLEST relevant harness component (one memory, skill, prompt note, or subagent spec), validate on the next action, then record the outcome. Do NOT rewrite the whole harness when a focused edit is enough.",
	"- You MUST prefer local refinement for current task progress, temporary blockers, and session coordination. Use global (`global_=True`) ONLY for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
	"- You MUST continue working normally after calling `await refine.run()` — it runs when the turn ends; do NOT wait or poll.",
	"- One request per turn is enough; calling `run` again before the turn ends only updates the instructions. Do NOT spam the call.",
	"- Auto-refine also runs automatically on `tool_error` and `tool_discovery` (5+ tool calls) — but you MUST still explicitly call `await refine.run()` when you notice a pattern worth persisting; do NOT rely solely on auto-refine for important learnings.",
	"- You MUST keep edits small and evidence-backed; an empty edits array is valid when nothing reusable was found. Prefer empty over speculative entries.",
	"- The harness is hot-reloadable: refinement rebuilds the system prompt live without restart. The `rlmRefine` Cordis service itself is also hot-reloadable via `fiber.restart()` — you can update refine logic without losing session state.",
].join("\n");

export interface RlmRefineConfig {}

export class RlmRefineService extends Service {
	static inject = ["rlmConfig"] as const;
	static provide = "rlmRefine" as const;

	declare config: RlmRefineConfig;

	agentDir!: string;
	harnessState!: HarnessState;

	// ─── Prompt fragment (hot-reloadable) ─────────────────────────────────
	private promptHandle: any = null;
	private promptRetryTimer: ReturnType<typeof setTimeout> | null = null;

	private getPromptService(): any | null {
		try {
			const fromGlobal = (globalThis as any).__rlmPrompt;
			if (fromGlobal?.registerFragment) return fromGlobal;
		} catch {}
		try {
			const fromCtx = (this.ctx as any)?.get?.("rlmPrompt");
			if (fromCtx?.registerFragment) return fromCtx;
		} catch {}
		return null;
	}

	private registerPromptFragment(): void {
		const svc = this.getPromptService();
		if (!svc) {
			if (this.promptRetryTimer) clearTimeout(this.promptRetryTimer);
			this.promptRetryTimer = setTimeout(() => {
				this.promptRetryTimer = null;
				if (this.promptHandle) return;
				this.registerPromptFragment();
			}, 300);
			try {
				(this.ctx as any)?.once?.("internal/service", () => {
					if (!this.promptHandle) this.registerPromptFragment();
				});
			} catch {}
			return;
		}
		if (this.promptHandle) return;
		try {
			this.promptHandle = svc.registerFragment("rlm-refine", {
				id: "refine-doctrine",
				priority: 70,
				content: () => REFINE_DOCTRINE,
			});
			this.ctx.logger?.info("rlm-refine: registered prompt fragment (refine-doctrine, priority 70)");
		} catch (error) {
			this.ctx.logger?.warn(
				`rlm-refine: failed to register prompt fragment: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private disposePromptFragment(): void {
		if (this.promptRetryTimer) {
			clearTimeout(this.promptRetryTimer);
			this.promptRetryTimer = null;
		}
		if (this.promptHandle) {
			try {
				this.promptHandle.dispose();
			} catch {}
			this.promptHandle = null;
		} else {
			try {
				const svc = this.getPromptService();
				svc?.disposePlugin?.("rlm-refine");
			} catch {}
		}
	}

	constructor(ctx: any, config: RlmRefineConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		const rlmConfig = (this.ctx as any).rlmConfig;
		this.agentDir = rlmConfig?.config?.agentDir ?? rlmConfig?.getAgentDir?.() ?? process.cwd();
		const globalHarnessDir = getGlobalHarnessStateDir(this.agentDir);
		this.harnessState = loadHarnessState(globalHarnessDir, "global");

		(this.ctx as any).logger?.info(`rlm-refine: ready (agentDir=${this.agentDir})`);
		this.registerPromptFragment();
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

	async [Symbol.dispose]() {
		this.disposePromptFragment();
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
