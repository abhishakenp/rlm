/**
 * @rlm/delegate — the delegation loop's memory.
 *
 * The loop used to be a string handed to a process. Six jobs went in, one came
 * out done, and the other five ended when the process did — with no queue, no
 * list, no "still to do" anywhere on disk to say they had ever been asked for.
 * On the same night nine turns ended with the word "Done" and nothing had been
 * built; a scaffold was mounted and announced as a capability.
 *
 * So this row holds two things the loop never had:
 *
 *   1. A durable graph. What was asked is written down the moment it is asked,
 *      in rlm's own state directory, and it is still there after a crash, a
 *      restart, or an agent that simply stopped halfway down the list.
 *   2. A criterion per task, mandatory, mechanical. The graph runs it itself
 *      and decides `done`; the agent's report is only ever an input to that.
 *
 * And it puts both in front of the model every turn, because a memory nobody
 * reads is a log file. Two prompt fragments are contributed, and both read from
 * disk when the prompt is built rather than at mount: what is still owed, and
 * the current source of the delegator loop itself. The second one is read at
 * runtime on purpose — a pasted copy teaches a flow that no longer exists.
 */
import { Service } from "@deepseek-ai/cordis";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	describeProof,
	outstanding,
	render,
	type Graph,
	type Review,
	type Task,
	type TaskInput,
} from "./graph.ts";
import { capacity, explain as explainCapacity, type CapacityVerdict } from "./capacity.ts";
import { check, type Probe } from "./proof.ts";
import { run as runGraph, type Runner, type RunOptions } from "./scheduler.ts";
import { Store, defaultDir } from "./store.ts";

export const name = "rlm-delegate";

export interface RlmDelegateConfig {
	enabled?: boolean;
	dir?: string;
	concurrency?: number;
	parallelCeiling?: number;
	headroomFloor?: number;
	maxAttempts?: number;
	repeatFloor?: number;
	skeletonPath?: string;
	teachSkeleton?: boolean;
}

export const configFields = [
	{
		key: "enabled",
		type: "boolean",
		default: true,
		description: "Turn the task graph off. Nothing is lost when it is off — the file is still there — but nothing new is recorded either.",
	},
	{
		key: "dir",
		type: "string",
		description:
			"Where the task journals are kept. Defaults to a folder inside rlm's own home, never the working directory: delegations often run in a throwaway temp dir, and a list of jobs deleted along with the workspace is the bug this row exists to fix.",
	},
	{
		key: "concurrency",
		type: "number",
		description:
			"Pin how many independent tasks run at once. Leave it unset and the number is measured from the machine between tasks instead — descriptors, memory, load. Anything over the limit waits in the journal; it is never refused.",
	},
	{
		key: "parallelCeiling",
		type: "number",
		description: "The most the measured limit is ever allowed to reach, however idle the machine looks. Defaults to half the cores, capped at four.",
	},
	{
		key: "headroomFloor",
		type: "number",
		default: 0.2,
		description: "Below this much headroom on any one signal, drop to one task at a time. Twenty percent is the point at which the laptop starts to lag.",
	},
	{
		key: "maxAttempts",
		type: "number",
		default: 3,
		description: "Ceiling on attempts at one task. The usual reason a task stops is the one below, not this.",
	},
	{
		key: "repeatFloor",
		type: "number",
		default: 2,
		description:
			"Stop after a task has failed this many times the same way. An agent that failed identically twice will fail a third time; the attempt is spent to no purpose and the failure is more useful written down.",
	},
	{
		key: "skeletonPath",
		type: "string",
		description: "The delegator loop's own source, shown to the agent as the shape of the flow. Read when the prompt is built, never copied.",
	},
	{
		key: "teachSkeleton",
		type: "boolean",
		default: true,
		description: "Put the loop's own current code in the system prompt. Turn it off if the prompt is tight; what is still owed is contributed either way.",
	},
];

const DEFAULT_SKELETON = join(
	process.env.RLM_HOME || join(homedir(), ".rlm"),
	"agent",
	"workflows",
	"delegator.ts",
);

export class RlmDelegateService extends Service {
	static inject = [] as const;
	static provide = "rlmDelegate" as const;

	declare config: RlmDelegateConfig;

	private store!: Store;
	private teardowns = new Set<() => void>();

	constructor(ctx: any, config: RlmDelegateConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		this.store = new Store(this.config.dir ?? defaultDir());

		// One effect owns everything, because an effect registered later is
		// silently never released and this row re-attaches its fragments every
		// time the prompt row reloads.
		this.ctx.effect(() => {
			return () => {
				for (const off of this.teardowns) {
					try {
						off();
					} catch {
						/* teardown must not throw */
					}
				}
				this.teardowns.clear();
			};
		}, "rlm-delegate prompt fragments");

		this.attachPrompt();
		const reattach = this.ctx.on?.("internal/service", (key: string) => {
			if (key === "rlmPrompt") this.attachPrompt();
		});
		if (typeof reattach === "function") this.teardowns.add(reattach);

		const open = this.open();
		const owed = open.reduce((n, g) => n + outstanding(g.tasks).length, 0);
		this.ctx.logger?.info?.(
			owed
				? `rlm-delegate: ${owed} task(s) still owed across ${open.length} graph(s) in ${this.store.dir}`
				: `rlm-delegate: nothing outstanding (${this.store.dir})`,
		);
		if (owed) this.ctx.emit?.("rlm/delegate-outstanding", { graphs: open.length, tasks: owed });
	}

	// ─── The prompt ──────────────────────────────────────────────────────────

	private attachPrompt() {
		const prompt = this.ctx.get?.("rlmPrompt");
		if (!prompt?.registerFragment) return;

		const owed = prompt.registerFragment("rlm-delegate", {
			id: "still-owed",
			priority: 92,
			when: "always",
			content: () => this.owedFragment(),
		});
		if (owed?.dispose) this.teardowns.add(() => owed.dispose());

		if (this.config.teachSkeleton !== false) {
			const skeleton = prompt.registerFragment("rlm-delegate", {
				id: "the-loop",
				priority: 40,
				when: "depth0",
				content: () => this.skeletonFragment(),
			});
			if (skeleton?.dispose) this.teardowns.add(() => skeleton.dispose());
		}
	}

	/** What is still owed, read from disk every time the prompt is built. */
	owedFragment(): string {
		const open = this.open();
		if (!open.length) return "";
		const lines = open.flatMap((graph) => [
			`  ${graph.id} — ${graph.goal}`,
			...outstanding(graph.tasks).map(
				(t) =>
					`    [${t.state}] ${t.id}: ${t.title}${t.reason ? ` — ${t.reason.split("\n")[0]}` : ""}`,
			),
		]);
		return [
			"## Still owed",
			"",
			"These were asked for and are not finished. They survive restarts; they are not",
			"in your context because someone repeated them. Do not start new work while",
			"something here is `ready`, and never report a turn complete because the turn",
			"ended — a task is done when its criterion passes.",
			"",
			...lines,
			"",
			"Work them with rlmDelegate: `status()`, `run(graphId)`, `declare(goal, tasks)`.",
		].join("\n");
	}

	/**
	 * The loop's own current code.
	 *
	 * Read here, at prompt-build time, from the file that is actually loaded —
	 * never a copy pasted into this string. A copy goes stale the first time
	 * somebody edits the workflow, and then the prompt is teaching a flow that
	 * does not exist any more, which is worse than teaching nothing.
	 */
	skeletonFragment(): string {
		const path = this.config.skeletonPath ?? DEFAULT_SKELETON;
		if (!existsSync(path)) return "";
		let source = "";
		try {
			source = readFileSync(path, "utf8");
		} catch {
			return "";
		}
		return [
			"## The delegation loop, as it currently is",
			"",
			`This is the live source of \`${path}\`, read just now. It is the shape to follow`,
			"and the thing to improve — if the flow should be different, change that file;",
			"it hot-reloads, and this section will then say something else.",
			"",
			"```ts",
			source.trimEnd(),
			"```",
		].join("\n");
	}

	// ─── The graph ───────────────────────────────────────────────────────────

	/**
	 * Write down what was asked. Throws — before anything reaches disk — on a
	 * cycle, an unknown dependency, or a task with no criterion.
	 */
	declare(goal: string, tasks: TaskInput[], graphId?: string): Graph {
		const graph = this.store.create(goal, tasks, graphId);
		this.ctx.emit?.("rlm/delegate-declared", { graph: graph.id, goal, tasks: graph.tasks.length });
		this.ctx.logger?.info?.(`rlm-delegate: declared ${graph.id} with ${graph.tasks.length} task(s)`);
		return graph;
	}

	/** Add to a graph that already exists, refusing a cycle across the whole thing. */
	add(graphId: string, tasks: TaskInput[]): Graph {
		const graph = this.store.add(graphId, tasks);
		this.ctx.emit?.("rlm/delegate-declared", { graph: graphId, added: tasks.length });
		return graph;
	}

	get(graphId: string): Graph | null {
		return this.store.load(graphId);
	}

	/** Every graph that still owes something. */
	open(): Graph[] {
		try {
			return this.store.open();
		} catch {
			return [];
		}
	}

	ids(): string[] {
		return this.store.ids();
	}

	/** A one-screen account, for a person or for a prompt. */
	status(graphId?: string): string {
		if (graphId) {
			const graph = this.store.load(graphId);
			return graph ? render(graph) : `no such graph: ${graphId}`;
		}
		const open = this.open();
		if (!open.length) return "nothing outstanding";
		return open.map(render).join("\n\n");
	}

	// ─── Working it ──────────────────────────────────────────────────────────

	/** How the row/command criteria see the running rlm. */
	probe(): Probe {
		return {
			rowState: (id: string) => (this.ctx.get?.("rlmCompose") as any)?.row?.(id)?.state ?? null,
			commands: () => {
				const tools = (this.ctx.get?.("rlmTools") as any)?.createTools?.();
				if (!tools) throw new Error("rlm-tools is not mounted");
				return (Array.isArray(tools) ? tools : Object.values(tools)).map(
					(t: any) => t?.name ?? t?.function?.name ?? String(t),
				);
			},
		};
	}

	/**
	 * How many tasks this machine will carry right now, and why.
	 *
	 * Inspectable on purpose: "rlm is already busy with 1 delegation" was a
	 * refusal nobody could argue with because nobody could see the reasoning.
	 */
	capacity(): CapacityVerdict {
		return capacity({ ceiling: this.config.parallelCeiling, floor: this.config.headroomFloor });
	}

	explainCapacity(): string {
		return explainCapacity(this.capacity());
	}

	/** Run one task's criterion now, without touching the graph. */
	async verify(graphId: string, taskId: string) {
		const graph = this.store.load(graphId);
		const task = graph?.tasks.find((t) => t.id === taskId);
		if (!task) throw new Error(`no such task: ${graphId}/${taskId}`);
		return check(task.proof, { probe: this.probe() });
	}

	/**
	 * Work the graph until nothing is runnable.
	 *
	 * The default runner hands a task to a subagent. Pass your own to drive
	 * something else; the graph does not care what does the work, only whether
	 * the criterion held afterwards.
	 */
	async run(graphId: string, runner?: Runner, options: RunOptions = {}): Promise<Graph> {
		if (this.config.enabled === false) throw new Error("rlm-delegate is switched off");
		const use: Runner =
			runner ??
			(async (task: Task) => {
				const sdk = this.ctx.get?.("rlmSdk") as any;
				if (!sdk?.spawn) throw new Error("no runner given and rlm-sdk is not mounted");
				return await sdk.spawn(task.prompt, { name: task.id });
			});

		return runGraph(this.store, graphId, use, {
			concurrency:
				typeof this.config.concurrency === "number" ? this.config.concurrency : () => this.capacity().limit,
			maxAttempts: this.config.maxAttempts ?? 3,
			repeatFloor: this.config.repeatFloor ?? 2,
			probe: this.probe(),
			onEvent: (event, data) => this.ctx.emit?.(event, data),
			...options,
		});
	}

	// ─── The reviewer's seam ─────────────────────────────────────────────────

	/**
	 * A reviewer's verdict on work whose criterion already passed.
	 *
	 * The graph can only ask "did the criterion hold?". It cannot ask whether
	 * the criterion was worth passing — a criterion written to be easy is
	 * invisible from down here. That is a judgement, it belongs above, and this
	 * is where it lands. A rejection is treated exactly like a failure:
	 * dependents that had not started become unreachable, and dependents that
	 * had already finished are marked tainted rather than left quietly standing
	 * on it.
	 */
	review(graphId: string, taskId: string, verdict: "accepted" | "rejected", by: string, reason: string): Graph {
		const graph = this.store.load(graphId);
		const task = graph?.tasks.find((t) => t.id === taskId);
		if (!graph || !task) throw new Error(`no such task: ${graphId}/${taskId}`);
		const review: Review = { by, at: new Date().toISOString(), verdict, reason };
		this.store.reviewed(graphId, taskId, review);
		this.ctx.emit?.("rlm/delegate-reviewed", { graph: graphId, task: taskId, verdict, by, reason });
		return this.store.load(graphId)!;
	}

	/** What a reviewer needs in order to dispute a criterion, as plain data. */
	forReview(graphId: string): Array<{
		id: string;
		title: string;
		criterion: string;
		proof: Task["proof"];
		evidence?: string;
		result?: string;
		reviewed?: Review;
	}> {
		const graph = this.store.load(graphId);
		if (!graph) return [];
		return graph.tasks
			.filter((t) => t.state === "done")
			.map((t) => ({
				id: t.id,
				title: t.title,
				criterion: describeProof(t.proof),
				proof: t.proof,
				evidence: [...t.attempts].reverse().find((a) => a.proof === "passed")?.proofDetail,
				result: t.result,
				reviewed: t.review,
			}));
	}
}

export default RlmDelegateService;
export const inject = [] as const;
export { RlmDelegateService as RlmDelegate };
export * from "./graph.ts";
export { Store, defaultDir, mintId } from "./store.ts";
export { run as runGraph, effectivePrompt, type Runner, type RunOptions } from "./scheduler.ts";
export { check as checkProof, type Probe, type ProofResult } from "./proof.ts";
export { judge, shapeOf, similarity, normalise, carry } from "./lapse.ts";
export { capacity, readings, explain as explainCapacity, type CapacityVerdict, type Reading } from "./capacity.ts";
