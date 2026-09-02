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

		try {
			const gone = this.store.prune();
			if (gone.length) this.ctx.logger?.info?.(`rlm-delegate: forgot ${gone.length} finished journal(s)`);
		} catch {
			/* pruning is housekeeping; never let it stop the row starting */
		}

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
		const wounds = this.unverified();
		if (!open.length && !wounds.length) return "";
		const lines = open.flatMap((graph) => [
			`  ${graph.id} — ${graph.goal}`,
			...outstanding(graph.tasks).map(
				(t) =>
					`    [${t.state}] ${t.id}: ${t.title}${t.reason ? ` — ${t.reason.split("\n")[0]}` : ""}`,
			),
		]);
		const woundLines = wounds.length
			? [
					"",
					`### ${wounds.length} turn(s) in the last day ended with no way to check`,
					"",
					"Each of these was recorded at the door and never refined into anything a",
					"criterion could be run against, so nobody can say whether the work happened.",
					"That is the thing worth fixing, and `refine()` is how.",
					"",
					...wounds.slice(0, 8).map((w) => `  ${w.graph}/${w.task.id}: ${w.task.title}`),
				]
			: [];

		return [
			"## Still owed",
			"",
			"These were asked for and are not finished. They are on disk, written down when",
			"they arrived — they are not in your context because someone repeated them, and",
			"they survive you. Do not start new work while something here is `ready`, and",
			"never report a turn complete because the turn ended: a task is done when its",
			"criterion passes and at no other moment.",
			"",
			...lines,
			...woundLines,
			"",
			"Through rlmDelegate: `status()`, `run(graphId)`, `declare(goal, tasks)`, and",
			"`refine(graphId, taskId, tasks)` to break a recorded request into real tasks —",
			"each with `needs` for anything it must wait for, and a `proof` that some",
			"command, file, row or registry entry can settle without asking anybody.",
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

	/**
	 * Write down a request the moment it arrives, before anything intelligent
	 * has looked at it.
	 *
	 * This is the floor, and the reason it is here rather than in a prompt: a
	 * model that ignores an instruction loses the work exactly as before, so the
	 * recording cannot be something a model chooses to do. One task, the request
	 * verbatim, and the honest criterion — nobody has said how to tell yet. It
	 * needs no plan, no decomposition and no model, so it still happens when the
	 * model is unavailable, confused, or lying.
	 *
	 * What it is not is useful on its own. `refine()` turns it into real tasks
	 * with real criteria; until something does, the request ends `unproven`,
	 * which is a wound with a record rather than a wound without one.
	 */
	intake(request: string, options: { source?: string; taskId?: string } = {}): { graph: Graph; taskId: string } | null {
		if (this.config.enabled === false) return null;
		const text = String(request ?? "").trim();
		if (!text) return null;
		const taskId = options.taskId ?? "the-request";
		const title = (text.split("\n").find((l) => l.trim()) ?? text).trim().slice(0, 140);
		try {
			const graph = this.store.create(text, [
				{
					id: taskId,
					title,
					prompt: text,
					proof: {
						kind: "unstated",
						note: options.source
							? `arrived from ${options.source}; nobody has said how to tell it is finished`
							: undefined,
					},
				},
			]);
			this.ctx.emit?.("rlm/delegate-intake", { graph: graph.id, source: options.source, title });
			this.ctx.logger?.info?.(`rlm-delegate: recorded ${graph.id} at intake — ${title}`);
			return { graph, taskId };
		} catch (error: any) {
			// The floor must never be the thing that stops a request being
			// handled. A recording that fails is bad; a request refused because
			// the recording failed is worse.
			this.ctx.logger?.warn?.(`rlm-delegate: could not record the request: ${error?.message ?? error}`);
			return null;
		}
	}

	/**
	 * Break a recorded request into the tasks that actually do the work.
	 *
	 * The improvement on top of the mechanical floor, and optional by design:
	 * splitting a paragraph into jobs is a reading, and readings need a model.
	 * The parent becomes the sum of its children and needs nobody to run it.
	 */
	refine(graphId: string, taskId: string, tasks: TaskInput[]): Graph {
		const graph = this.store.refine(graphId, taskId, tasks);
		this.ctx.emit?.("rlm/delegate-refined", { graph: graphId, task: taskId, into: tasks.length });
		this.ctx.logger?.info?.(`rlm-delegate: ${graphId}/${taskId} refined into ${tasks.length} task(s)`);
		return graph;
	}

	/**
	 * Record how a recorded request turned out.
	 *
	 * If something refined it, this does nothing — the children already say. If
	 * nothing did, the turn ends `unproven` when it came back and `failed` when
	 * it did not, and either way the request is still on disk with the answer
	 * attached.
	 */
	close(graphId: string, taskId: string, outcome: { ok: boolean; detail?: string }): Graph | null {
		const graph = this.store.load(graphId);
		const task = graph?.tasks.find((t) => t.id === taskId);
		if (!graph || !task) return null;
		if (task.proof.kind === "rollup" || task.state === "done") return graph;

		const at = new Date().toISOString();
		const detail = String(outcome.detail ?? "").slice(0, 4000);
		if (outcome.ok) {
			this.store.ended(graphId, taskId, "unproven", { at, endedAt: at, ok: true, detail, proof: "unstated" }, {
				result: detail,
				reason: "it came back, and nobody had said how to tell whether it worked",
			});
			this.ctx.emit?.("rlm/delegate-unproven", { graph: graphId, task: taskId, title: task.title });
		} else {
			this.store.ended(graphId, taskId, "failed", { at, endedAt: at, ok: false, detail, shape: detail.split("\n")[0] }, {
				reason: detail || "the run did not come back cleanly",
			});
			this.ctx.emit?.("rlm/delegate-failed", { graph: graphId, task: taskId, reason: detail });
		}
		return this.store.load(graphId);
	}

	/** Turns that ended with no way to tell whether the work happened. */
	unverified(sinceMs?: number) {
		try {
			return this.store.unverified(sinceMs);
		} catch {
			return [];
		}
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
