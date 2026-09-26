/**
 * The Olympus pipeline, ordered by cost.
 *
 * Every stage left of `difficulty` runs locally and costs nothing. `difficulty`
 * is the only stage that consumes anything (a2's codex quota), and `submit` is
 * the only stage that spends shipd tokens. A candidate must be green all the
 * way along before either is allowed to run.
 */
export type StageId =
	| "eligibility"
	| "mine"
	| "originality"
	| "specLint"
	| "verify4Phase"
	| "prechecks"
	| "rubrics"
	| "deterministic"
	| "difficulty"
	| "submit";

export interface Stage {
	id: StageId;
	/** What it proves. */
	proves: string;
	/** What running it costs. */
	cost: "free" | "a2-codex" | "shipd-tokens";
	/** Blocks submission when it fails. */
	blocking: boolean;
	tool?: string;
}

export const PIPELINE: Stage[] = [
	{
		id: "eligibility",
		proves: "repo is 500+ stars, permissive licence, pushed within 12 months, allowed language, and not on the platform's blocklist",
		cost: "free",
		blocking: true,
		tool: "tools/mine.sh",
	},
	{
		id: "mine",
		proves: "candidate is hard by natural selection: a long-open, reproducible bug in a large codebase, not an invented feature",
		cost: "free",
		blocking: true,
		tool: "tools/mine.sh",
	},
	{
		id: "originality",
		proves: "no existing PR, issue or discussion already implements the idea",
		cost: "free",
		blocking: true,
	},
	{
		id: "specLint",
		proves: "the description pins every symbol it introduces (name, arity, return shape, error-vs-value), so the solver implements instead of stopping to ask",
		cost: "free",
		blocking: true,
	},
	{
		id: "verify4Phase",
		proves: "base PASS / new FAIL without the solution, base PASS / new PASS with it, inside the real Olympus image with --network none",
		cost: "free",
		blocking: true,
		tool: "tools/verify_4phase.sh",
	},
	{
		id: "prechecks",
		proves: "the platform's 12 test-patch sub-checks plus Dockerfile rules, run against their own extracted rubric text",
		cost: "free",
		blocking: true,
		tool: "tools/prechecks.sh",
	},
	{
		id: "rubrics",
		proves: "task quality, description conciseness, patch alignment, category and predictable-test-names, graded with the platform's shipped prompts",
		cost: "free",
		blocking: false,
	},
	{
		id: "deterministic",
		proves: "word count, AI-writing tells, UTF-8, absent URLs, valid unified diff, no banned markers",
		cost: "free",
		blocking: true,
		tool: "tools/det_checks.py",
	},
	{
		id: "difficulty",
		proves: "pass rate over n real codex rollouts at Nova parity; the only gate that cannot be replicated by a cheaper model",
		cost: "a2-codex",
		blocking: true,
		tool: "tools/codex_rollout.sh",
	},
	{
		id: "submit",
		proves: "nothing — it spends. Reached only when every gate above is green.",
		cost: "shipd-tokens",
		blocking: false,
		tool: "tools/oly.py",
	},
];

/** Thresholds. Tutorial values differ from live Olympus; both are enforced. */
export const CRITERIA = {
	// The PLATFORM bar for the tutorial is 50%, but the factory holds itself to
	// 20%. Two reasons: a task the grading agent solves more than one time in
	// five is a task AI can already do, which carries no signal; and at a true
	// 50% rate the chance of drawing >=4 passes in 6 platform runs -- failing
	// Difficulty -- is about 34%, which is unaffordable on a one-shot submission.
	// At 20% that risk falls to roughly 1.7%.
	tutorial: { maxPassRatePct: 20, platformBarPct: 50, minRuns: 6, minMedianLoc: 150, minMedianFiles: 2 },
	olympus: { maxPassRatePct: 20, minRuns: 10, minMedianLoc: 400, minMedianFiles: 3, minMedianMessages: 80 },
} as const;
