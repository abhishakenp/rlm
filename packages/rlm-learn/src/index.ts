/**
 * @rlm/learn — self-evolution plugin.
 *
 * Cordis Service. Tracks workflow execution outcomes, learns from
 * patterns, and proposes workflow modifications.
 *
 * What it does:
 * - Listens to rlm/workflow-* events from @rlm/workflow
 * - Records every workflow run: name, input, result, duration, success
 * - Writes to ~/.rlm/agent/workflows/learnings.jsonl
 * - Periodically reflects: "what patterns led to success?"
 * - Proposes workflow modifications via LLM → ~/.rlm/agent/workflows/proposals/
 * - Operator approves → proposal moves to workflows/ → HMR picks it up
 *
 * The learning loop:
 *   1. Workflow runs → outcome recorded
 *   2. After N runs, reflect on patterns
 *   3. LLM proposes modifications to workflow files
 *   4. Proposals written to proposals/ for operator review
 *   5. Operator approves → file moves to workflows/ → hot-reload
 *
 * Reference: prime-agent's LEARN coordinator owns memory-holders,
 * pattern-matcher, anticipation queue, decomposition lessons.
 * rlm-learn does the same but in TS, as a hot-swappable Cordis plugin.
 */
import { Service } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	existsSync,
	mkdirSync,
	appendFileSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	renameSync,
} from "node:fs";

export interface RlmLearnConfig {
	learningsDir?: string;
	proposalsDir?: string;
	reflectInterval?: number;
	maxLearningsBeforeReflect?: number;
}

/**
 * A stable, comparable summary of a tool failure: enough to tell two identical
 * refusals apart from two different ones, short enough to sit in a prompt.
 */
function errorSignature(event: any): string {
	const text = Array.isArray(event?.content)
		? event.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ")
		: String(event?.content ?? "");
	return text.replace(/\s+/g, " ").trim().slice(0, 160) || "unknown error";
}

export interface LearningEntry {
	timestamp: number;
	workflow: string;
	input: string;
	result?: string;
	error?: string;
	durationMs: number;
	success: boolean;
}

export interface Reflection {
	timestamp: number;
	patterns: string[];
	proposals: string[];
	summary: string;
}

export class RlmLearnService extends Service {
	static inject = [] as const;
	static provide = "rlmLearn" as const;

	declare config: RlmLearnConfig;
	private learningsPath: string = "";
	private proposalsDir: string = "";
	private runCount: number = 0;
	private reflectTimer: any = null;
	/** Code cells issued during the current turn, for cadence judgement. */
	private turnCells: string[] = [];
	/** Tool failures during the current turn, for loop detection. */
	private turnErrors: string[] = [];
	private promptHandle: any = null;

	constructor(ctx: any, config: RlmLearnConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		// Honour the declared config. These keys existed but were ignored, so
		// every instance — including tests — wrote into the one real learnings
		// file under the home directory.
		const baseDir = this.config.learningsDir ?? join(homedir(), ".rlm", "agent", "workflows");
		this.learningsPath = join(baseDir, "learnings.jsonl");
		this.proposalsDir = this.config.proposalsDir ?? join(baseDir, "proposals");

		if (!existsSync(this.proposalsDir)) {
			mkdirSync(this.proposalsDir, { recursive: true });
		}

		// Listen to workflow events.
		this.ctx.on("rlm/workflow-start", (data: any) => this.onWorkflowStart(data));
		this.ctx.on("rlm/workflow-complete", (data: any) => this.onWorkflowComplete(data));
		this.ctx.on("rlm/workflow-error", (data: any) => this.onWorkflowError(data));

		// Also listen to delegator-specific events for richer learning.
		this.ctx.on("rlm/delegator-review", (data: any) => this.recordReview(data));
		this.ctx.on("rlm/delegator-classified", (data: any) => this.recordClassification(data));

		// Periodic reflection.
		const interval = this.config.reflectInterval ?? 60000;
		this.reflectTimer = setInterval(() => this.maybeReflect(), interval);
		this.reflectTimer.unref?.(); // Don't keep process alive for reflection.

		// Register a prompt fragment so the agent sees past learnings
		// and doesn't make the same mistakes twice.
		this._registerPromptFragment();

		// Watch ordinary turns. Without this the plugin only ever hears about
		// workflows and delegator reviews — neither of which an interactive
		// session emits — so a normal session produced no learnings at all and
		// the feedback loop never closed.
		this._observeTurns();

		this.ctx.logger?.info(
			`rlm-learn: self-evolution ready (learnings=${this.learningsPath}, proposals=${this.proposalsDir})`,
		);
	}

	/**
	 * Register a prompt fragment with the rlmPrompt service.
	 * This feeds past learnings into the system prompt so the agent
	 * doesn't make the same mistakes twice.
	 */
	private _registerPromptFragment() {
		const getPromptSvc = () => {
			try {
				const fromGlobal = (globalThis as any).__rlmPrompt;
				if (fromGlobal?.registerFragment) return fromGlobal;
			} catch {}
			try {
				const fromCtx = (this.ctx as any)?.get?.("rlmPrompt");
				if (fromCtx?.registerFragment) return fromCtx;
			} catch {}
			return null;
		};

		const svc = getPromptSvc();
		if (!svc?.registerFragment) {
			this.ctx.logger?.warn("rlm-learn: rlmPrompt service not available — learnings will not appear in system prompt");
			return;
		}

		this.promptHandle = svc.registerFragment("rlm-learn", {
			id: "past-learnings",
			priority: 5,
			content: () => this.buildLearningsPrompt() ?? "",
			when: "always",
		});

		this.ctx.logger?.info("rlm-learn: registered prompt fragment — past learnings visible to agent");
	}

	/**
	 * Contribute a session observer so real turns feed the learning loop.
	 *
	 * Published through the shared extension-factory registry rather than wired
	 * into @rlm/agent directly, and owned by a ctx.effect() so a fiber.restart()
	 * withdraws the old observer before the reloaded one registers — the loop
	 * improves itself while a session is running, without disturbing it.
	 */
	private _observeTurns() {
		this.ctx.effect(() => {
			const g = globalThis as any;
			if (!Array.isArray(g.__rlmExtensionFactories)) g.__rlmExtensionFactories = [];
			const reg = g.__rlmExtensionFactories as Array<{ id: string; factory: (pi: any) => void }>;
			const stale = reg.findIndex((e) => e.id === "rlm-learn");
			if (stale >= 0) reg.splice(stale, 1);

			const entry = {
				id: "rlm-learn",
				factory: (pi: any) => {
					pi.on("turn_start", () => {
						this.turnCells = [];
						this.turnErrors = [];
					});
					pi.on("tool_call", (event: any) => {
						if (event?.toolName === "code" && typeof event.input?.code === "string") {
							this.turnCells.push(event.input.code);
						}
					});
					pi.on("tool_result", (event: any) => {
						if (!event?.isError) return;
						this.turnErrors.push(errorSignature(event));
					});
					pi.on("turn_end", () => {
						this._judgeRepeatedFailure();
						this._judgeCadence();
					});
				},
			};
			reg.push(entry);
			return () => {
				const i = reg.indexOf(entry);
				if (i >= 0) reg.splice(i, 1);
			};
		});
	}

	/**
	 * Notice the same failure happening more than once in a turn.
	 *
	 * An agent that retries a refused call with different wording is not making
	 * progress; it is paying a full round trip to be told the same thing again.
	 * The second identical failure is the signal, and it is worth more than any
	 * success: recorded here, it reaches the next turn's prompt, so the loop
	 * ends within the session rather than repeating in the next one.
	 */
	private _judgeRepeatedFailure() {
		const errors = this.turnErrors;
		this.turnErrors = [];
		if (errors.length < 2) return;

		const counts = new Map<string, number>();
		for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
		for (const [error, count] of counts) {
			if (count < 2) continue;
			this.appendLearning({
				timestamp: Date.now(),
				type: "repeat-error",
				workflow: "interactive-turn",
				input: "",
				error,
				count,
				durationMs: 0,
				success: false,
			} as any);
		}
	}

	/**
	 * Notice a turn spent as a ladder of one-liners.
	 *
	 * A persistent kernel invites REPL habits: list a directory, stop, think,
	 * read one file, stop, think. Each pause is a full model round-trip bought
	 * for information a single cell would have returned together. When a turn
	 * shows that shape, record it — the prompt fragment feeds it back, so the
	 * next session starts already knowing.
	 */
	private _judgeCadence() {
		const cells = this.turnCells;
		this.turnCells = [];
		if (cells.length < 3) return;

		// A one-liner ladder: several cells, each a single short statement.
		const terse = cells.filter((c) => c.trim().split("\n").length <= 2 && c.trim().length < 200);
		if (terse.length < 3 || terse.length < cells.length) return;

		this.appendLearning({
			timestamp: Date.now(),
			type: "cadence",
			workflow: "interactive-turn",
			input: "",
			cells: cells.length,
			sample: terse.slice(0, 3).map((c) => c.trim().replace(/\s+/g, " ").slice(0, 80)),
			durationMs: 0,
			success: true,
		} as any);
	}

	/**
	 * Build a concise prompt fragment from recent learnings.
	 * Shows failure patterns so the agent avoids repeating them.
	 */
	buildLearningsPrompt(): string | undefined {
		const learnings = this.readLearnings();
		if (learnings.length === 0) return undefined;

		// Focus on failures and reflections — those are the "don't repeat" signals.
		const failures = learnings.filter((l: any) => l.success === false && l.type !== "repeat-error");
		const reflections = learnings.filter((l: any) => l.type === "reflection");
		const reviews = learnings.filter((l: any) => l.type === "review" && (l.score ?? 0) < 4);
		const cadence = learnings.filter((l: any) => l.type === "cadence");
		const loops = learnings.filter((l: any) => l.type === "repeat-error");

		if (
			failures.length === 0 &&
			reflections.length === 0 &&
			reviews.length === 0 &&
			cadence.length === 0 &&
			loops.length === 0
		) {
			return undefined;
		}

		const lines: string[] = ["## Past Learnings (don't repeat these mistakes)"];

		// Loops first: they cost the most and are the easiest to avoid.
		for (const loop of loops.slice(-2) as any[]) {
			lines.push(
				`- [LOOP] this failed ${loop.count} times in one turn: ${String(loop.error).slice(0, 160)}. ` +
					"Retrying it with different wording fails the same way — change the approach or move on.",
			);
		}

		// Recent failures (last 5)
		const recentFailures = failures.slice(-5);
		for (const f of recentFailures) {
			const errMsg = (f.error ?? "unknown error").slice(0, 120);
			lines.push(`- [FAIL] ${f.workflow}: ${errMsg}`);
		}

		// Low-score reviews (last 3)
		const recentReviews = reviews.slice(-3);
		for (const r of recentReviews) {
			lines.push(`- [LOW SCORE] ${r.step ?? "review"}: score ${r.score}/5 (attempt ${r.attempt ?? "?"})`);
		}

		// Reflection patterns (last 1)
		const lastReflection = reflections[reflections.length - 1];
		if (lastReflection?.patterns?.length > 0) {
			lines.push(`- [PATTERNS] ${lastReflection.patterns.slice(0, 3).join("; ")}`);
		}

		// Cadence: turns that were spent as a ladder of one-liners.
		const lastCadence = cadence[cadence.length - 1] as any;
		if (lastCadence) {
			lines.push(
				`- [CADENCE] a recent turn used ${lastCadence.cells} separate code cells, each a one-liner ` +
					`(e.g. ${(lastCadence.sample ?? []).slice(0, 2).map((c: string) => `\`${c}\``).join(", ")}). ` +
					"Work that could be predicted belongs in one cell — the round-trips bought nothing.",
			);
		}

		return lines.join("\n");
	}

	/** Record a workflow start. */
	private onWorkflowStart(data: any) {
		this.runCount++;
	}

	/** Record a workflow completion. */
	private onWorkflowComplete(data: any) {
		const entry: LearningEntry = {
			timestamp: Date.now(),
			workflow: data.name,
			input: data.input ?? "",
			result: data.result?.slice(0, 500),
			durationMs: data.durationMs ?? 0,
			success: true,
		};
		this.appendLearning(entry);
	}

	/** Record a workflow error. */
	private onWorkflowError(data: any) {
		const entry: LearningEntry = {
			timestamp: Date.now(),
			workflow: data.name,
			input: "",
			error: data.error?.slice(0, 500),
			durationMs: 0,
			success: false,
		};
		this.appendLearning(entry);
	}

	/** Record a review score from the delegator. */
	private recordReview(data: any) {
		const entry = {
			timestamp: Date.now(),
			type: "review",
			workflow: "delegator",
			step: data.step,
			score: data.score,
			attempt: data.attempt,
		};
		this.appendLearning(entry as any);
	}

	/** Record an input classification. */
	private recordClassification(data: any) {
		const entry = {
			timestamp: Date.now(),
			type: "classification",
			workflow: "delegator",
			input: data.input?.slice(0, 200),
			classification: data.classification,
		};
		this.appendLearning(entry as any);
	}

	/** Append a learning entry to the JSONL file. */
	private appendLearning(entry: any) {
		try {
			appendFileSync(this.learningsPath, JSON.stringify(entry) + "\n", "utf-8");
		} catch (error) {
			this.ctx.logger?.warn(`rlm-learn: failed to append learning: ${error}`);
		}
	}

	/** Read all learnings. */
	readLearnings(): LearningEntry[] {
		if (!existsSync(this.learningsPath)) return [];
		const content = readFileSync(this.learningsPath, "utf-8");
		return content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean) as LearningEntry[];
	}

	/** Maybe reflect if enough learnings have accumulated. */
	private async maybeReflect() {
		const maxBeforeReflect = this.config.maxLearningsBeforeReflect ?? 10;
		if (this.runCount < maxBeforeReflect) return;

		await this.reflect();
		this.runCount = 0; // Reset counter.
	}

	/**
	 * Reflect on accumulated learnings.
	 * Uses the LLM (via rlmSdk) to identify patterns and propose
	 * workflow modifications.
	 */
	async reflect(): Promise<Reflection> {
		const learnings = this.readLearnings();
		if (learnings.length === 0) {
			return { timestamp: Date.now(), patterns: [], proposals: [], summary: "No learnings yet." };
		}

		// Summarize learnings for the LLM.
		const recent = learnings.slice(-20);
		const summary = recent
			.map(
				(l: any) =>
					`[${l.workflow}] ${l.success ? "OK" : "FAIL"} ${l.durationMs}ms ${l.type ?? ""} ${l.score ?? ""} ${l.classification ?? ""}`,
			)
			.join("\n");

		// Ask the LLM to identify patterns and propose modifications.
		const sdk = this.ctx.get("rlmSdk");
		let patterns: string[] = [];
		let proposals: string[] = [];
		let llmSummary = "";

		if (sdk) {
			try {
				const response = await sdk.spawn(
					`You are a self-evolution engine. Analyze these workflow execution learnings and identify:
1. Patterns that lead to success (5/5 reviews, fast completion)
2. Patterns that lead to failure (low scores, errors, slow)
3. Proposed modifications to workflow files

Reply as JSON: {"patterns": [...], "proposals": [...], "summary": "..."}

Learnings:
${summary}`,
					{ name: "reflector" },
				);

				const jsonMatch = response.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					const parsed = JSON.parse(jsonMatch[0]);
					patterns = parsed.patterns ?? [];
					proposals = parsed.proposals ?? [];
					llmSummary = parsed.summary ?? "";
				}
			} catch (error) {
				llmSummary = `Reflection failed: ${error}`;
			}
		}

		// Write proposals to proposals/ directory.
		for (const proposal of proposals) {
			const filename = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
			writeFileSync(
				join(this.proposalsDir, filename),
				`# Workflow Modification Proposal\n\nGenerated: ${new Date().toISOString()}\n\n${proposal}\n`,
				"utf-8",
			);
		}

		// Record the reflection.
		const reflection: Reflection = {
			timestamp: Date.now(),
			patterns,
			proposals,
			summary: llmSummary,
		};

		this.appendLearning({
			timestamp: Date.now(),
			type: "reflection",
			patterns,
			proposals: proposals.length,
			summary: llmSummary,
		});

		this.ctx.emit("rlm/learn-reflection", reflection);
		this.ctx.logger?.info(
			`rlm-learn: reflected on ${learnings.length} learnings → ${patterns.length} patterns, ${proposals.length} proposals`,
		);

		return reflection;
	}

	/** List pending proposals. */
	listProposals(): string[] {
		if (!existsSync(this.proposalsDir)) return [];
		return readdirSync(this.proposalsDir).filter((f) => f.endsWith(".md"));
	}

	/**
	 * Approve a proposal — moves it from proposals/ to workflows/.
	 * The workflow plugin's HMR will pick it up automatically.
	 */
	approveProposal(filename: string, workflowName: string) {
		const proposalPath = join(this.proposalsDir, filename);
		if (!existsSync(proposalPath)) {
			throw new Error(`rlm-learn: proposal ${filename} not found`);
		}

		const workflowsDir = join(homedir(), ".rlm", "agent", "workflows");
		const workflowPath = join(workflowsDir, `${workflowName}.ts`);
		renameSync(proposalPath, workflowPath);

		this.ctx.logger?.info(`rlm-learn: approved proposal ${filename} → ${workflowName}.ts`);
		this.ctx.emit("rlm/learn-proposal-approved", { filename, workflowName });

		// HMR will pick it up — but also trigger manual reload.
		const wf = this.ctx.get("rlmWorkflow");
		if (wf) {
			wf.reload(workflowName).catch(() => {});
		}
	}

	/** Get stats about learnings. */
	stats() {
		const learnings = this.readLearnings();
		const successes = learnings.filter((l: any) => l.success);
		const failures = learnings.filter((l: any) => !l.success);
		const reviews = learnings.filter((l: any) => l.type === "review");
		const avgScore =
			reviews.length > 0
				? reviews.reduce((sum: number, r: any) => sum + (r.score ?? 0), 0) / reviews.length
				: 0;

		return {
			total: learnings.length,
			successes: successes.length,
			failures: failures.length,
			successRate: learnings.length > 0 ? successes.length / learnings.length : 0,
			avgReviewScore: avgScore,
			proposals: this.listProposals().length,
		};
	}

	async [Symbol.dispose]() {
		if (this.reflectTimer) {
			clearInterval(this.reflectTimer);
			this.reflectTimer = null;
		}
		if (this.promptHandle) {
			try { this.promptHandle.dispose?.(); } catch {}
			this.promptHandle = null;
		}
	}
}

export default RlmLearnService;
export const name = "rlm-learn";
export const inject = [] as const;
export { RlmLearnService as RlmLearn };
