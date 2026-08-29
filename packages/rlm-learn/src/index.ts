/**
 * @rlm/learn — self-evolution plugin.
 *
 * Cordis Service. Tracks workflow execution outcomes, learns from
 * patterns, and proposes workflow modifications.
 *
 * What it does:
 * - Listens to rlm/workflow-* events from @rlm/workflow
 * - Records every workflow run: name, input, result, duration, success
 * - Writes to ~/.prime/agent/workflows/learnings.jsonl
 * - Periodically reflects: "what patterns led to success?"
 * - Proposes workflow modifications via LLM → ~/.prime/agent/workflows/proposals/
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

	constructor(ctx: any, config: RlmLearnConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		const baseDir = join(homedir(), ".prime", "agent", "workflows");
		this.learningsPath = join(baseDir, "learnings.jsonl");
		this.proposalsDir = join(baseDir, "proposals");

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

		this.ctx.logger?.info(
			`rlm-learn: self-evolution ready (learnings=${this.learningsPath}, proposals=${this.proposalsDir})`,
		);
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

		const workflowsDir = join(homedir(), ".prime", "agent", "workflows");
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
	}
}

export default RlmLearnService;
export const name = "rlm-learn";
export const inject = [] as const;
export { RlmLearnService as RlmLearn };
