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
import { derive } from "./derive.ts";
import { check, type Probe } from "./proof.ts";
import { run as runGraph, type Runner, type RunOptions } from "./scheduler.ts";
import { drive as driveGraphs, renderReport, type DriveOptions, type DriveReport } from "./drive.ts";
import { impasses, renderImpasses, type Impasse } from "./impasse.ts";
import { rlmAgent } from "./agent.ts";
import { Stop } from "./stop.ts";
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
	cwd?: string;
	stopFile?: string;
	entry?: string;
	attemptTimeoutMs?: number;
	maxSweeps?: number;
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
		key: "cwd",
		type: "string",
		description: "Where relative paths in a request are resolved from when reading a criterion out of it. Defaults to the process working directory.",
	},
	{
		key: "stopFile",
		type: "string",
		description:
			"The file that stops the drive. Defaults to ~/Desktop/.rlm-drive-off, next to Iris's own kill switch and for the same reason: it has to work when you are annoyed and not at a terminal. ~/Desktop/.iris-autonomy-off stops it too, and is never written by rlm.",
	},
	{
		key: "entry",
		type: "string",
		description: "rlm's own entry point, used by the default runner to hand a task to a fresh rlm in print mode. Defaults to the cordis-shell.mjs this process was started from.",
	},
	{
		key: "attemptTimeoutMs",
		type: "number",
		default: 2700000,
		description:
			"Give up on one attempt after this long and kill the whole process group. Forty-five minutes, not the fifteen that was there before: a fifteen-minute ceiling killed every multi-task delegation partway through and every one of them came back reading like incapacity.",
	},
	{
		key: "maxSweeps",
		type: "number",
		default: 25,
		description: "The hard bound on one drive. A sweep only happens because the last one changed something, so reaching this means something is oscillating.",
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
	private mode: { dispose(): void } | null = null;
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
				this.mode = null;
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
		this.attachMode();
		const reattach = this.ctx.on?.("internal/service", (key: string) => {
			if (key === "rlmPrompt") this.attachPrompt();
			if (key === "rlmModes") this.attachMode();
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

	/**
	 * `rlm drive`, `rlm drive stop`, `rlm drive status` — one obvious command.
	 *
	 * A surface rather than a script, so the stop is reachable through the
	 * binary he already has on PATH. Priority above `print` because `print`
	 * claims any invocation with nothing on a TTY, which includes this one.
	 */
	private attachMode() {
		const modes = this.ctx.get?.("rlmModes") as any;
		if (!modes?.register || this.mode) return;
		const handle = modes.register({
			id: "drive",
			priority: 60,
			claims: (argv: string[]) => argv[0] === "drive",
			run: async (argv: string[]) => {
				const verb = argv[1] ?? "start";
				if (verb === "stop") {
					console.log(`stopped — ${this.stop(argv.slice(2).join(" ") || "stopped by hand")} is now there; delete it to resume`);
					return 0;
				}
				if (verb === "resume") {
					console.log(this.resume() ? "resumed" : "it was not stopped");
					return 0;
				}
				if (verb === "status") {
					const halted = this.stopped();
					console.log(halted ? `STOPPED — ${halted}` : "running is allowed");
					console.log(this.status());
					const asking = this.impasses();
					if (asking.length) console.log(renderImpasses(asking));
					return 0;
				}
				const report = await this.drive({
					follow: argv.includes("--follow"),
					only: argv.filter((a) => a.startsWith("g-")),
				});
				console.log(renderReport(report));
				return report.owed.length ? 1 : 0;
			},
		});
		this.mode = handle;
		if (handle?.dispose) this.teardowns.add(() => handle.dispose());
	}

	/** What is still owed, read from disk every time the prompt is built. */
	owedFragment(): string {
		const open = this.open();
		const questions = this.questions();
		if (!open.length && !questions.length) return "";

		const all = open.flatMap((graph) => graph.tasks.map((task) => ({ graph, task })));
		const live = all.filter(({ task }) => ["ready", "blocked", "running"].includes(task.state));
		const stopped = all.filter(({ task }) => ["failed", "unreachable", "rejected"].includes(task.state));
		const unchecked = all.filter(({ task }) => task.state === "unproven");

		const line = ({ graph, task }: { graph: Graph; task: Task }) =>
			`  ${graph.id}/${task.id} — ${task.title}${task.reason ? `\n      ${task.reason.split("\n")[0]}` : ""}`;

		const section = (heading: string, rows: typeof all, note?: string) =>
			rows.length ? ["", `### ${heading}`, ...(note ? ["", note] : []), "", ...rows.map(line)] : [];

		return [
			"## Still owed",
			"",
			`${all.length} task(s) are not proven done. They were written down when they arrived, they are`,
			"on disk, and they outlive you — none of this is here because somebody repeated it.",
			"A task is finished when its criterion passes and at no other moment.",
			...section("Live — something can pick these up now", live),
			...section(
				"Stopped — these need a decision",
				stopped,
				"Each one has a reason on it. Fix the cause and it becomes runnable again on its own.",
			),
			...section(
				`Ran, but nobody can tell whether it worked — ${unchecked.length}`,
				unchecked,
				"These are the dangerous ones. A turn ended and no criterion was ever run, which is exactly " +
					"what nine \"Done\" reports in one night turned out to be. They are not finished. Give one a " +
					"criterion with `answer()` and it goes back into the pool, or refine it into tasks that have one.",
			),
			...(questions.length
				? [
						"",
						`### ${questions.length} waiting on one sentence from him`,
						"",
						"Nothing could be read out of the request that a machine could check. Ask — being asked",
						"ten times is better than finding out tomorrow that everything stopped. Then record the",
						"answer with `answer(graphId, taskId, proof)`.",
						"",
						...questions.slice(0, 10).map((q) => `  ${q.graph}/${q.task.id} — ${q.question}`),
					]
				: []),
			"",
			"Through rlmDelegate: `status()`, `run(graphId)`, `declare(goal, tasks)`,",
			"`refine(graphId, taskId, tasks)` to break a recorded request into real tasks — each with",
			"`needs` for anything it must wait for and a `proof` some command, file, row or registry",
			"entry can settle without asking anybody — and `answer(graphId, taskId, proof)` once he says how.",
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
		// An attempt the drive is making is already journalled against the task
		// it belongs to. Recording it again here as a fresh top-level request
		// would mean working the backlog lengthens it, once per attempt, without
		// end — see agent.ts.
		if (process.env.RLM_DELEGATE_CHILD) return null;
		const text = String(request ?? "").trim();
		if (!text) return null;
		const taskId = options.taskId ?? "the-request";
		const title = (text.split("\n").find((l) => l.trim()) ?? text).trim().slice(0, 140);

		// Read a criterion out of the request before settling for "nobody said".
		// Much of what arrives says how it could be checked, in words — a plugin
		// that has to reach ACTIVE, a command that has to be in the registry, a
		// file that has to stop being the file it was. Deriving one costs no
		// model call and turns a question into a check. Where nothing is
		// confident, `unstated` is still the answer, but as a last resort.
		//
		// This must never be able to refuse the request: a bad guess produces a
		// task that fails loudly, which is recoverable, while a throw here would
		// stop work from being handed over at all.
		let read: ReturnType<typeof derive> = null;
		try {
			read = derive(text, { cwd: this.config.cwd });
		} catch (error: any) {
			this.ctx.logger?.warn?.(`rlm-delegate: could not read a criterion: ${error?.message ?? error}`);
		}
		const proof = read?.proof ?? {
			kind: "unstated" as const,
			note: `nobody has said how to tell this is finished${options.source ? `; it arrived from ${options.source}` : ""}`,
		};

		try {
			const graph = this.store.create(text, [{ id: taskId, title, prompt: text, proof }]);
			this.ctx.emit?.("rlm/delegate-intake", {
				graph: graph.id,
				source: options.source,
				title,
				criterion: proof.kind,
				why: read?.why,
			});
			this.ctx.logger?.info?.(
				read
					? `rlm-delegate: recorded ${graph.id} — ${title} (${read.why})`
					: `rlm-delegate: recorded ${graph.id} — ${title} (no criterion could be read; this is a question)`,
			);
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

	/**
	 * Every job waiting on one sentence from a person, as data.
	 *
	 * The asking is not done here — it belongs to whatever is actually talking
	 * to him. What is guaranteed here is that the question exists, is specific,
	 * and does not go away on its own.
	 */
	questions() {
		try {
			return this.store.questions();
		} catch {
			return [];
		}
	}

	/**
	 * Somebody said how to tell. Replace the criterion and put the task back
	 * into the pool, so something tries again against the real thing.
	 */
	answer(graphId: string, taskId: string, proof: Task["proof"], by = "a person"): Graph {
		const graph = this.store.answered(graphId, taskId, proof, by);
		this.ctx.emit?.("rlm/delegate-answered", { graph: graphId, task: taskId, criterion: proof.kind, by });
		return graph;
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

	// ─── The drive ───────────────────────────────────────────────────────────

	/** How this drive is stopped, and by whom. */
	stopper(): Stop {
		return new Stop({ file: this.config.stopFile });
	}

	/** Stop the drive, right now, whatever is running. Creates the file. */
	stop(why = "stopped by hand"): string {
		const file = this.stopper().raise(why);
		this.ctx.emit?.("rlm/drive-halted", { file, why });
		this.ctx.logger?.warn?.(`rlm-delegate: stopped — ${file} is now there; delete it to resume`);
		return file;
	}

	/** Take our own stop file away. Iris's is hers. */
	resume(): boolean {
		const lowered = this.stopper().lower();
		if (lowered) this.ctx.emit?.("rlm/drive-halted", { file: this.config.stopFile, why: null });
		return lowered;
	}

	stopped(): string | null {
		return this.stopper().reason();
	}

	/** Every job that is stopped and needs one sentence from a person. */
	impasses(): Impasse[] {
		return impasses(this.open());
	}

	/**
	 * Work everything that is owed, without being asked which.
	 *
	 * This is the half that was missing. The graph could not forget and the
	 * criterion could tell done from claimed, and the backlog still did not
	 * move, because both of them waited for somebody to name a graph id.
	 *
	 * The default runner hands each task to a fresh rlm in print mode, in its
	 * own process, so a task that wedges takes a child down rather than the
	 * thing keeping the list.
	 */
	async drive(options: Partial<DriveOptions> = {}): Promise<DriveReport> {
		if (this.config.enabled === false) throw new Error("rlm-delegate is switched off");
		const stop = options.stop ?? this.stopper();
		const makeRunner =
			options.makeRunner ??
			((signal: AbortSignal) =>
				rlmAgent({
					entry: this.config.entry ?? process.argv[1],
					cwd: this.config.cwd ?? process.cwd(),
					timeoutMs: this.config.attemptTimeoutMs ?? 2_700_000,
					signal,
				}));

		// The planner is the same agent, asked a different question. Cheap to
		// build here and worth having by default: without one, a request that is
		// fifteen jobs in a paragraph can only become a question.
		const makePlanner =
			options.makePlanner ??
			((signal: AbortSignal) => {
				const ask = rlmAgent({
					entry: this.config.entry ?? process.argv[1],
					cwd: this.config.cwd ?? process.cwd(),
					timeoutMs: Math.min(this.config.attemptTimeoutMs ?? 2_700_000, 600_000),
					signal,
				});
				return (prompt: string, task: any, graph: any) => ask({ ...task, prompt }, graph);
			});

		const report = await driveGraphs(this.store, {
			probe: this.probe(),
			cwd: this.config.cwd,
			maxAttempts: this.config.maxAttempts ?? 3,
			repeatFloor: this.config.repeatFloor ?? 2,
			maxSweeps: this.config.maxSweeps ?? 25,
			concurrency:
				typeof this.config.concurrency === "number" ? this.config.concurrency : () => this.capacity().limit,
			onEvent: (event, data) => this.ctx.emit?.(event, data),
			...options,
			makeRunner: options.runner ? undefined : makeRunner,
			makePlanner: options.planner ? undefined : makePlanner,
			stop,
		});
		this.ctx.logger?.info?.(renderReport(report));
		return report;
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
export { drive, renderReport, type DriveOptions, type DriveReport } from "./drive.ts";
export { impasses, renderImpasses, type Impasse, type ImpasseKind } from "./impasse.ts";
export { Stop, Gate, DESKTOP_STOP, IRIS_STOP } from "./stop.ts";
export { rlmAgent, type AgentOptions } from "./agent.ts";
export { refineOne, needsRefining, parsePlan, PLAN_INSTRUCTIONS, type Planner } from "./refine.ts";
export { askIn } from "./derive.ts";
export { diagnose, type Diagnosis, type Carrier, type CauseKind } from "./lapse.ts";
export { nextAttempt } from "./scheduler.ts";
