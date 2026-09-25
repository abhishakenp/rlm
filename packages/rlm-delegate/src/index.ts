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
import type { ElekshaSession } from "./eleksha.ts";
import { execFileSync } from "node:child_process";
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
import { add as addLesson, load as loadLessons } from "./lessons.ts";
import { derive } from "./derive.ts";
import { check, type Probe } from "./proof.ts";
import { run as runGraph, type Runner, type RunOptions } from "./scheduler.ts";
import { drive as driveGraphs, renderReport, type DriveOptions, type DriveReport } from "./drive.ts";
import { impasses, renderImpasses, type Impasse } from "./impasse.ts";
import { rlmAgent, sessionFor } from "./agent.ts";
import { AgentPool } from "./pool.ts";
import { askModel, route as modelRoute } from "./ask.ts";
import { confineTo, plannerScope } from "./confine.ts";
import { me2 } from "./me2.ts";
import { Stop } from "./stop.ts";
import { Store, defaultDir, mintId } from "./store.ts";

/**
 * The events this row emits, declared to the kernel.
 *
 * Cordis types `emit` against its own `Events` interface, so an undeclared
 * name is a type error — fifteen of them here, every one a real event that has
 * been firing all along. The kernel is asking a fair question: if nothing
 * declares the name, nothing can subscribe to it with any confidence about
 * what it carries.
 *
 * Declaring them is not paperwork. It is what makes an event part of the
 * contract rather than a string two files happen to agree on, and it is how
 * every healthy row in Iris does it.
 */
declare module "@deepseek-ai/cordis" {
	interface Events {
		/** A request was recorded as a task before anybody worked it. @mode emit */
		"rlm/delegate-intake"(data: { graph: string; source?: string; title: string; criterion: string; why?: string }): void;
		/** A graph was declared, with the tasks it was broken into. @mode emit */
		"rlm/delegate-declared"(data: { graph: string; goal?: string; tasks?: number; added?: number }): void;
		/** How much is still owed, across how many graphs. @mode emit */
		"rlm/delegate-outstanding"(data: { graphs: number; tasks: number }): void;
		/** A task nobody could judge was broken into ones somebody can. @mode emit */
		"rlm/delegate-refined"(data: { graph: string; task: string; into: number }): void;
		/** A turn ended and no criterion was ever run — not a verdict, the absence of one. @mode emit */
		"rlm/delegate-unproven"(data: { graph: string; task: string; title?: string; why?: string }): void;
		/** A task exhausted its attempts. @mode emit */
		"rlm/delegate-failed"(data: { graph: string; task: string; repeats?: number; reason?: string }): void;
		/** He said how to tell whether something was done. @mode emit */
		"rlm/delegate-answered"(data: { graph: string; task: string; criterion?: string; by?: string }): void;
		/** me-2 looked at finished work before it was called done. @mode emit */
		"rlm/delegate-reviewed"(data: { graph: string; task: string; verdict: "accepted" | "rejected"; by: string; reason: string }): void;
		/** The drive stood down, or was released. @mode emit */
		"rlm/drive-halted"(data: { file?: string; why: string | null }): void;
	}
}

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
	review?: boolean;
	reviewModel?: string;
	reviewMaxTokens?: number;
	/** The most tasks that may wait for a worker at once. */
	queueLimit?: number;
	/** How often a pooled worker says it is still alive. */
	workerHeartbeatMs?: number;
	/** No word from a pooled worker for this long and it is treated as dead. */
	workerHeartbeatTimeoutMs?: number;
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
		description:
			"The most the measured limit is ever allowed to reach, however much room the machine has. Leave it unset and the ceiling is asked of the provider layer instead — omniroute reports what it will carry at once on /health — falling back to one per core when it cannot be reached.",
	},
	{
		key: "headroomFloor",
		type: "number",
		default: 0.2,
		description: "Below this much headroom on any one signal, drop to one task at a time. Twenty percent is the point at which the laptop starts to lag.",
	},
	{
		key: "queueLimit",
		type: "number",
		default: 64,
		description:
			"The most tasks that may sit waiting for a pooled worker at once. There was no bound here at all, which is a memory leak with a queue's name on it: every waiting task holds its prompt, its graph and its closures in the host's heap for as long as the fleet takes. Sixty-four is well past anything the machine will admit at once and far short of a number that matters. Over it, the task is refused with a sentence rather than accepted and forgotten — the graph on disk still owes it either way.",
	},
	{
		key: "workerHeartbeatMs",
		type: "number",
		default: 5000,
		description:
			"How often a pooled worker says it is still alive. A pid that exists is not a worker that works: wedged in a native call, swapping, or spinning inside a tool that never returns, it holds its tasks and answers nothing, and the only bound on that used to be the forty-five-minute per-attempt timeout — a number sized for a real agent turn, not for a corpse. 0 switches the heartbeat off.",
	},
	{
		key: "workerHeartbeatTimeoutMs",
		type: "number",
		default: 15000,
		description:
			"Silence this long from a pooled worker and it is killed and its task handed to another one, exactly as if it had crashed. Three missed beats by default. Set it below twice the heartbeat interval and it will be raised to that, because a bound tighter than the thing it measures fires on healthy workers.",
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
	{
		key: "review",
		type: "boolean",
		default: true,
		description:
			"Show finished work to me-2 before it is called done. It reviews against what he actually asked for and against the lessons in `rlm lesson`, and a rejection puts the task back in the pool carrying the reason. Turning it off means the criterion is the only thing between an attempt and `done`, which is the arrangement that produced nine \"Done\" reports in one night.",
	},
	{
		key: "reviewModel",
		type: "string",
		description: "Which model me-2 is. Defaults to the first model of the configured provider in ~/.rlm/agent/models.json — the same registry rlm's own agent reads.",
	},
	{
		key: "reviewMaxTokens",
		type: "number",
		default: 4000,
		description:
			"How much room me-2 gets. Reasoning models spend most of it inside <think> before saying anything, and a budget too small to reach a verdict is indistinguishable from a reviewer that will not answer. Below about three thousand it never gets there.",
	},
];

const DEFAULT_SKELETON = join(
	process.env.RLM_HOME || join(homedir(), ".rlm"),
	"agent",
	"workflows",
	"delegator.ts",
);

/**
 * Another drive already sweeping this store, by pid, or nothing.
 *
 * There is no cross-process lock on the store, so two drives both claim the
 * same `ready` tasks, both spawn children for them, and both write that task's
 * state into one journal. `scripts/drive-supervisor.sh` has held this line with
 * a `pgrep` since a supervisor died and left its sweep running with ppid 1 —
 * but it can only guard the loop it runs, and a drive started by hand, by an
 * agent, or by anything that is not that loop walks straight past it. It
 * happened while this file was being written.
 *
 * So the guard belongs here too, where every drive goes through it whoever
 * started it. Ancestors are excluded rather than just `process.pid`: rlm
 * re-execs itself under tsx and the supervisor wraps it in `timeout`, so a
 * single drive shows up as three processes all carrying the same command line,
 * and a guard that only knew its own pid would refuse to start on the strength
 * of its own parent.
 *
 * A guard that cannot look does not refuse. No `ps`, no opinion — an
 * unavailable check must not be able to stop the fleet.
 */
const anotherDriveSweeping = (): number | null => {
	try {
		const out = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16e6, timeout: 4000 });
		const parents = new Map<number, number>();
		const drives: number[] = [];
		for (const raw of out.split("\n")) {
			const row = raw.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
			if (!row) continue;
			const pid = Number(row[1]);
			parents.set(pid, Number(row[2]));
			// Flags may sit between the entry and the subcommand — the supervisor
			// now passes `--headless` there, and a pattern that demanded them
			// adjacent would have stopped matching the moment it did, switching
			// this guard off in silence.
			if (/cordis-shell\.mjs(\s+\S+)*\s+drive(\s|$)/.test(row[3])) drives.push(pid);
		}
		const mine = new Set<number>();
		for (let pid = process.pid; pid > 1 && !mine.has(pid); pid = parents.get(pid) ?? 0) mine.add(pid);
		return drives.find((pid) => !mine.has(pid)) ?? null;
	} catch {
		return null;
	}
};

export class RlmDelegateService extends Service {
	static inject = [] as const;
	static provide = "rlmDelegate" as const;

	declare config: RlmDelegateConfig;

	private store!: Store;
	private mode: { dispose(): void } | null = null;
	/**
	 * The warm workers, made on the first sweep that wants them.
	 *
	 * One per row rather than one per sweep: the whole saving is in not paying
	 * the composition boot again, and a pool rebuilt for every sweep pays it
	 * every time. It is closed by the row's own teardown, because a pool that
	 * outlives the row that made it is 143 MB of nothing.
	 */
	private pool: AgentPool | null = null;
	/** So "no rlmAgent, so no pool" is said once a sweep rather than once a task. */
	private saidNoAgent = false;
	private teardowns = new Set<() => void>();
	/**
	 * Requests this process recorded at the door and is answering right now.
	 *
	 * Kept out of the owed list while the turn runs. The floor records the
	 * request before the model sees it, so without this the prompt for the turn
	 * that is supposed to answer "Reply with exactly: pong" listed that same
	 * request as waiting on a sentence from him — and the model, told to ask,
	 * asked instead of answering. It is still on disk the whole time; `close()`
	 * lets it back into the list with whatever it ended as.
	 */
	private inFlight = new Set<string>();
	/** Set when a request arrived with nobody reading the run live (`--print`). */
	private headless = false;

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
				const pool = this.pool;
				this.pool = null;
				// Not `close()`. This teardown fires on every hot reload, and a
				// sweep already running is not torn down with the row that
				// started it — `driveGraphs` is an async call already in the air.
				// Closing outright took the pool out from under a live drive and
				// every task it submitted afterwards was refused "the pool is
				// closed". So the work in flight is given its own per-attempt bound
				// to finish in and not a task sooner — and then the workers do go,
				// because "wait until it is idle" with no bound on it is how an
				// unloaded row leaves 143 MB children behind for ever. Detaching
				// `this.pool` first is what makes that safe: a sweep still in the
				// air resolves its pool per task and builds a fresh one, so nothing
				// can submit to this object again.
				if (pool) {
					const bound = this.config.attemptTimeoutMs ?? 2_700_000;
					void pool.drain(bound).then(
						(how) =>
							this.ctx.logger?.info?.(
								how === "drained"
									? "rlm-delegate: the pool went with the row — everything in flight finished first"
									: `rlm-delegate: the pool went with the row — work was still in flight after ${bound}ms and the workers were killed`,
							),
						(error: any) => this.ctx.logger?.warn?.(`rlm-delegate: the pool would not drain: ${error?.message ?? error}`),
					);
				}
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
			// A graph that began and then lost whoever was driving it never records a
			// terminal event, so it is neither finished nor actionable — it just sits in
			// the store forever: prune() only reclaims settled journals, and open() below
			// keeps counting its tasks as owed. Reconciling first ends those stranded
			// tasks with a recorded reason, which both stops them inflating the "still
			// owed" figure and makes the journal reclaimable by the prune() immediately
			// after — in this same sweep rather than the next one.
			const lost = this.store.reconcile();
			if (lost.length) {
				const tasks = lost.reduce((n, g) => n + g.tasks.length, 0);
				this.ctx.logger?.info?.(
					`rlm-delegate: gave up on ${tasks} task(s) across ${lost.length} abandoned graph(s) — nothing has touched them since they were begun`,
				);
			}
		} catch {
			/* reconciling is housekeeping; never let it stop the row starting */
		}

		try {
			const gone = this.store.prune();
			if (gone.length) this.ctx.logger?.info?.(`rlm-delegate: forgot ${gone.length} finished journal(s)`);
		} catch {
			/* pruning is housekeeping; never let it stop the row starting */
		}

		try {
			const quarantined = this.store.quarantine();
			if (quarantined.length) this.ctx.logger?.info?.(`rlm-delegate: quarantined ${quarantined.length} stuck graph(s) — nothing actionable, moved out of the active queue`);
		} catch {
			/* quarantine is housekeeping; never let it stop the row starting */
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
			// Never to a child. A delegated agent has been handed exactly one task
			// and can do nothing about the other two hundred and eighty — so the
			// whole backlog is 47,091 characters of context it cannot act on,
			// wrapped around a 619-character job. Seventy-six to one, rebuilt from
			// disk on every prompt, on every attempt.
			//
			// `intake()` already refuses for children, for the neighbouring reason
			// that a child recording new top-level requests makes the backlog grow
			// by working it. Same guard, same env var, same argument.
			content: () => (process.env.RLM_DELEGATE_CHILD ? "" : this.owedFragment()),
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
		// `rlm tasks` — every task there is, on one screen.
		//
		// He asked for this twice: "a command that lists all the tasks so I can
		// confirm nothing was lost", and again the next day. `drive status` says
		// the same things at length, per graph, with reasons — which is the wrong
		// shape for the question "is anything missing?". This is one line per
		// task, sorted so the stopped work cannot hide under the finished work.
		// `rlm lesson "<his words>" -- <what happened>` — a correction becomes a
		// standing criterion. This is the growth path, and it is the point: the
		// reviewer's criteria have to come from him, and he changes his mind
		// every second, so a thing he said once must start being checked without
		// anybody editing code.
		modes.register({
			id: "lesson",
			priority: 62,
			claims: (argv: string[]) => argv[0] === "lesson",
			run: async (argv: string[]) => {
				const rest = argv.slice(1);
				if (!rest.length || rest[0] === "list") {
					const all = loadLessons();
					for (const l of all) {
						console.log(`  ${l.id}`);
						console.log(`      ${l.rule}`);
						console.log(`      he said: "${l.said}"`);
					}
					console.log(`\n  ${all.length} lesson(s) — every one a thing that already went wrong`);
					return 0;
				}
				const split = rest.indexOf("--");
				const said = (split === -1 ? rest : rest.slice(0, split)).join(" ").trim();
				const incident = split === -1 ? "" : rest.slice(split + 1).join(" ").trim();
				if (!said) {
					console.log('  say what he said: rlm lesson "<his words>" -- <what happened>');
					return 2;
				}
				// The rule is his sentence. A paraphrase of mine is the exact thing
				// this exists to avoid.
				const id =
					said.toLowerCase().replace(/[^a-z0-9]+/g, "-").split("-").filter(Boolean).slice(0, 5).join("-") ||
					`lesson-${Date.now()}`;
				const lesson = addLesson({ id, rule: said, said, incident: incident || "(not recorded)" });
				console.log(`  recorded ${lesson.id}`);
				console.log(`      "${lesson.said}"`);
				return 0;
			},
		});

		modes.register({
			id: "test-task",
			priority: 63,
			claims: (argv: string[]) => argv[0] === "test-task",
			run: async (argv: string[]) => {
				const at = argv.indexOf("--id");
				if (at === -1 || !argv[at + 1]) {
					console.log("  usage: rlm test-task --id <id>");
					return 1;
				}
				const taskId = argv[at + 1];
				const req = "test-task " + taskId;
				const graph = this.store.create(req, [{
					id: taskId,
					title: "test: " + taskId,
					prompt: "echo " + taskId,
					proof: { kind: "shell", run: "echo ok" }
				}]);
				const report = await this.drive({ follow: false, executor: process.env.RLM_EXECUTOR || "rlm" });
				console.log(this.store.status(graph.id));
				return report.owed.length ? 1 : 0;
			},
		});

		modes.register({
			id: "tasks",
			priority: 61,
			claims: (argv: string[]) => argv[0] === "tasks",
			run: async (argv: string[]) => {
				const rank: Record<string, number> = { running: 0, ready: 1, blocked: 2, failed: 3, unproven: 4, rejected: 5, unreachable: 6, done: 7 };
				const mark: Record<string, string> = { done: "done", running: "RUNNING", ready: "ready", blocked: "blocked", failed: "FAILED", unproven: "UNPROVEN", rejected: "parked", unreachable: "stuck" };
				const rows: Array<{ state: string; id: string; title: string; graph: string; why?: string }> = [];
				for (const id of this.store.ids()) {
					const graph = this.store.load(id);
					if (!graph) continue;
					for (const task of graph.tasks) {
						rows.push({ state: task.state, id: task.id, title: task.title, graph: id, why: task.reason?.split("\n")[0] });
					}
				}
				// Matched against the label he can see as well as the state
				// underneath it, and case-insensitively: `rlm tasks FAILED`
				// silently matched nothing because the label is shouted and the
				// state is not, which is a filter that lies about an empty result.
				const only = argv.slice(1).filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase());
				const shown = only.length
					? rows.filter((r) => only.some((o) => r.state.toLowerCase() === o || (mark[r.state] ?? "").toLowerCase() === o || r.id.toLowerCase().includes(o)))
					: rows;
				if (only.length && !shown.length) console.log(`  nothing matches ${only.join(", ")} — states are: ${[...new Set(rows.map((r) => mark[r.state] ?? r.state))].join(", ")}`);
				shown.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.id.localeCompare(b.id));

				const verbose = argv.includes("--why");
				for (const row of shown) {
					console.log(`  ${(mark[row.state] ?? row.state).padEnd(9)} ${row.id.slice(0, 30).padEnd(31)} ${row.title.slice(0, 62)}`);
					if (verbose && row.why) console.log(`  ${" ".repeat(9)} ${" ".repeat(31)} ${row.why.slice(0, 100)}`);
				}
				// Who has been doing the work. This is the number he is actually
				// waiting on: "Iris is doing her own work now" has to be watchable
				// going up, not a claim somebody makes at the end of a night.
				const by: Record<string, number> = {};
				for (const id of this.store.ids()) {
					for (const task of this.store.load(id)?.tasks ?? []) {
						for (const attempt of task.attempts ?? []) by[attempt.executor ?? "unnamed"] = (by[attempt.executor ?? "unnamed"] ?? 0) + 1;
					}
				}
				const attempts = Object.values(by).reduce((a, b) => a + b, 0);
				if (attempts) {
					console.log(
						`\n  ${attempts} attempt(s) — ` +
							Object.entries(by)
								.sort((a, b) => b[1] - a[1])
								.map(([who, n]) => `${who} ${n}`)
								.join(", "),
					);
				}

				const count: Record<string, number> = {};
				for (const row of rows) count[row.state] = (count[row.state] ?? 0) + 1;
				const order = Object.keys(count).sort((a, b) => (rank[a] ?? 9) - (rank[b] ?? 9));
				console.log(
					`\n  ${rows.length} task(s) across ${new Set(rows.map((r) => r.graph)).size} graph(s) — ` +
						order.map((k) => `${mark[k] ?? k} ${count[k]}`).join(", "),
				);
				// Nothing is ever dropped, so this total is the answer to "did we
				// lose anything": it only ever goes up.
				return 0;
			},
		});

		// The other end of the pool. Not a surface for a person — it is what a
		// worker process runs instead of `print`, and it only means anything with
		// an IPC channel to a parent, which is exactly what it checks.
		//
		// A mode rather than a second entry point because `cordis-shell.mjs` is
		// the only thing that can boot the composition and its own header asks to
		// be left alone. `pool-worker.ts` is imported here rather than at the top
		// of this file on purpose: it reaches into coding-agent internals, and
		// this package's tests run under bare `node --experimental-strip-types`
		// with none of that on the path.
		modes.register({
			id: "pool-worker",
			priority: 70,
			claims: (argv: string[]) => argv.includes("--pool-worker"),
			run: async (argv: string[]) => {
				const number = (flag: string) => {
					const at = argv.indexOf(flag);
					return at === -1 ? Number.NaN : Number(argv[at + 1]);
				};
				const asked = number("--slots");
				const beat = number("--heartbeat-ms");
				// The service, not the factory.
				//
				// This said `agent: rlmAgent` — the `(options) => Runner` factory from
				// `agent.ts`, whose whole job is to *spawn another process*. The worker
				// calls `agent.createRuntime({ sessionManager })`, which a `Runner` does
				// not have, so every pooled task would have died on
				// `agent.createRuntime is not a function`. The types agreed because
				// `PoolWorkerOptions.agent` was also declared `Runner`; correcting that
				// declaration is what made this line visible.
				const agent = this.ctx.get("rlmAgent") as
					| { createRuntime?: (opts: { sessionManager?: any }) => Promise<any> }
					| undefined;
				if (typeof agent?.createRuntime !== "function") {
					// Refused rather than run half-built. A worker that boots without an
					// agent answers every task with the same internal error while the
					// parent counts it as a live worker and keeps feeding it — which is
					// worse than no pool at all. The parent's own guard (see `workers()`)
					// keeps it from building a pool in this composition in the first
					// place, so this is the second line of the same defence.
					const why =
						"rlm-delegate: --pool-worker needs the rlmAgent service and this composition has none — refusing to boot a worker that could not run a task";
					this.ctx.logger?.error?.(why);
					console.error(`[rlm] ${why}`);
					return 78;
				}
				const { runPoolWorker } = await import("./pool-worker.ts");
				return await runPoolWorker(this.ctx, {
					...(Number.isFinite(asked) && asked > 0 ? { slots: asked } : {}),
					...(Number.isFinite(beat) && beat >= 0 ? { heartbeatMs: beat } : {}),
					cwd: this.config.cwd ?? process.cwd(),
					agent: agent as never,
				});
			},
		});

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
				// One sweep at a time across processes, whoever started it.
				const already = anotherDriveSweeping();
				if (already !== null) {
					console.log(`  a drive is already sweeping this store (pid ${already}) — standing down`);
					return 0;
				}
				// Said out loud before the sweep, because "me-2 is wired in" is
				// exactly the kind of claim that is invisible when it is false.
				if (this.config.review === false) console.log("  me-2 is off — the criterion is the only gate");
				else console.log(`  me-2 reviewing through ${modelRoute({ model: this.config.reviewModel }).model}`);
				const report = await this.drive({
					follow: argv.includes("--follow"),
					// Named so the journal can answer "did Iris do this herself".
					executor: process.env.RLM_EXECUTOR || "rlm-drive",
					// No graph ids on the line means every graph, not none. An empty
					// array is truthy, so passing it through as `only` would have
					// restricted the drive to zero graphs and then reported that it
					// had worked everything it could.
					only: argv.filter((a) => a.startsWith("g-")).length ? argv.filter((a) => a.startsWith("g-")) : undefined,
				});
				console.log(renderReport(report));
				// A sweep that ended itself because it had stopped working is not
				// the same outcome as one that worked everything it could, and the
				// supervisor's log is where the difference has to be visible. 75 is
				// EX_TEMPFAIL: distinct from the 1 that means "settled, still owed",
				// from the 78 a broken composition exits, and from the 124 the
				// external timeout leaves behind.
				if (report.ended === "stalled") return 75;
				return report.owed.length ? 1 : 0;
			},
		});
		this.mode = handle;
		if (handle?.dispose) this.teardowns.add(() => handle.dispose());
	}

	/** What is still owed, read from disk every time the prompt is built. */
	owedFragment(): string {
		const open = this.open().filter((graph) => !this.inFlight.has(graph.id));
		const questions = this.questions().filter((q) => !this.inFlight.has(q.graph));
		if (!open.length && !questions.length) return "";

		const all = open.flatMap((graph) => graph.tasks.map((task) => ({ graph, task })));
		// A --print run records its own request (inFlight, excluded above) and must
		// end on its answer. Listing everyone else's open tasks as "something can
		// pick these up now" made it pick them up. The drive and the interactive
		// session still get the full list.
		if (this.headless && this.inFlight.size > 0) {
			return all.length
				? `## Still owed\n\n${all.length} task(s) are owed elsewhere — not this run's job. They are on disk and in QUESTIONS.md. Answer what this run was asked and stop.`
				: "";
		}
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
						...(this.headless
							? [
									"Nobody is reading this run live, so nobody can answer a question put in the reply.",
									"Do what this run was asked first and end on the answer, never on one of these. They",
									"are already on disk and in QUESTIONS.md, where he reads them; if you can derive a",
									"criterion yourself, record it with `answer(graphId, taskId, proof)`.",
								]
							: [
									"Nothing could be read out of the request that a machine could check. Ask — being asked",
									"ten times is better than finding out tomorrow that everything stopped. Then record the",
									"answer with `answer(graphId, taskId, proof)`.",
								]),
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
	intake(
		request: string,
		options: { source?: string; taskId?: string; priority?: number; headless?: boolean } = {},
	): { graph: Graph; taskId: string } | null {
		if (this.config.enabled === false) return null;
		if (options.headless) this.headless = true;
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

		// Priority from the caller, or from the env var Iris sets when she
		// spawns this child. Direct wake-word requests get 10; recall/missed
		// gets 1; anything that does not say gets 0 (the default, which means
		// FIFO among unspecified tasks). The drive sorts by priority before
		// picking what to run, so higher-priority tasks jump the queue.
		const priority = options.priority ?? (Number(process.env.IRIS_DELEGATE_PRIORITY) || 0);

		try {
			const graph = this.store.create(text, [{ id: taskId, title, prompt: text, proof, priority }]);
			this.inFlight.add(graph.id);
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
		this.inFlight.delete(graphId);
		const graph = this.store.load(graphId);
		const task = graph?.tasks.find((t) => t.id === taskId);
		if (!graph || !task) return null;
		if (task.proof.kind === "rollup" || task.state === "done") return graph;

		const at = new Date().toISOString();
		const detail = String(outcome.detail ?? "").slice(0, 4000);
		// The last two attempts in the codebase that went into the journal with no
		// name on them. Every other site builds its record from the one literal in
		// `scheduler.ts`, which defaults to "unnamed"; these two were written by
		// hand and simply left the field off, so a turn that came in through the
		// door rather than through the drive was indistinguishable in the journal
		// from a stamping bug. "the turn itself" says what it actually was: not a
		// delegation, a person or a program talking to rlm directly.
		const executor = "the turn itself";
		if (outcome.ok) {
			this.store.ended(graphId, taskId, "unproven", { at, endedAt: at, ok: true, detail, proof: "unstated", executor }, {
				result: detail,
				reason: "it came back, and nobody had said how to tell whether it worked",
			});
			this.ctx.emit?.("rlm/delegate-unproven", { graph: graphId, task: taskId, title: task.title });
		} else {
			this.store.ended(graphId, taskId, "failed", { at, endedAt: at, ok: false, detail, shape: detail.split("\n")[0], executor }, {
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

	// ─── The public delegation API ───────────────────────────────────────────

	/**
	 * One request in, one answer out, with the journal underneath it.
	 *
	 * The seam an HTTP caller — Iris, over `POST /v1/delegate` — needs, and
	 * deliberately not a second delegation engine. It is `intake()` and
	 * `drive()`, which are the two halves that already exist and are already the
	 * only things that write to the journal: the request is recorded before
	 * anybody works it, so a caller that disconnects, a process that dies, or a
	 * timeout that fires leaves the work *still owed* on disk rather than gone.
	 * That is the whole reason this row exists and an API that bypassed it would
	 * be the pre-journal loop with a port number.
	 *
	 * `timeout` stops this call, not the work: it is an `AbortSignal` handed to
	 * the drive's own `Stop`, which is what a `drive stop` writes on disk, so the
	 * sweep unwinds the way it does for a person. The task stays owed and the
	 * next sweep picks it up.
	 */
	async delegate(opts: {
		prompt: string;
		/** An existing graph to add this to, so the work has somewhere to belong. */
		session?: string;
		/** Give up waiting after this long. The task stays owed either way. */
		timeout?: number;
		/** Who asked, stamped on every attempt. */
		source?: string;
	}): Promise<{ ok: boolean; output: string; ms: number; events: string[]; graph?: string; task?: string }> {
		const began = Date.now();
		const events: string[] = [];
		const answer = (ok: boolean, output: string, extra: { graph?: string; task?: string } = {}) => ({
			ok,
			output,
			ms: Date.now() - began,
			events,
			...extra,
		});

		const prompt = String(opts?.prompt ?? "").trim();
		if (!prompt) return answer(false, "a delegation needs a prompt");
		if (this.config.enabled === false) return answer(false, "rlm-delegate is switched off");
		const halted = this.stopped();
		if (halted) return answer(false, `the drive is stopped — ${halted}`);

		let graphId: string;
		let taskId: string;
		if (opts.session) {
			const existing = this.get(opts.session);
			if (!existing) return answer(false, `no such session: ${opts.session}`);
			graphId = existing.id;
			taskId = `ask-${mintId()}`;
			try {
				this.add(graphId, [
					{
						id: taskId,
						title: (prompt.split("\n").find((l) => l.trim()) ?? prompt).trim().slice(0, 140),
						prompt,
						proof: { kind: "unstated", note: `it arrived from ${opts.source ?? "the delegate API"}` },
					},
				]);
			} catch (error: any) {
				return answer(false, `could not add to ${graphId}: ${error?.message ?? error}`, { graph: graphId });
			}
		} else {
			// `intake()` and not `store.create()`: it reads a criterion out of the
			// request before settling for "nobody said", refuses to record an
			// attempt a delegated child is already journalling, and is the one place
			// the intake event is emitted from.
			const recorded = this.intake(prompt, { source: opts.source ?? "the delegate API" });
			if (!recorded) {
				return answer(
					false,
					process.env.RLM_DELEGATE_CHILD
						? "this process is itself a delegated child — its attempt is already journalled against the task it belongs to"
						: "the request could not be recorded, so it was not started",
				);
			}
			graphId = recorded.graph.id;
			taskId = recorded.taskId;
		}

		// The caller's bound, expressed the way the drive already understands one.
		// `Stop` is re-read live by the sweep, so this reaches queued work as well
		// as work in the air — which a plain `Promise.race` would not.
		const stop = new Stop({
			file: this.config.stopFile,
			...(opts.timeout && opts.timeout > 0 ? { signal: AbortSignal.timeout(opts.timeout) } : {}),
		});

		let report: DriveReport | null = null;
		try {
			report = await this.drive({
				only: [graphId],
				stop,
				executor: opts.source ?? "the delegate API",
				onEvent: (event, data) => {
					events.push(`${event} ${JSON.stringify(data)}`.slice(0, 500));
					(this.ctx.emit as unknown as (n: string, d: unknown) => void)?.(event, data);
				},
			});
		} catch (error: any) {
			return answer(false, `the drive would not run: ${error?.message ?? error}`, { graph: graphId, task: taskId });
		}
		// How the sweep itself ended is part of the account: "stopped" and
		// "settled" are different answers to a caller whose timeout may have been
		// the thing that stopped it.
		events.push(`drive/ended ${JSON.stringify({ ended: report.ended, sweeps: report.sweeps, stoppedBy: report.stoppedBy })}`);

		// What the journal says, not what the drive said on the way out. The two
		// are different questions and only the first one is durable.
		const graph = this.get(graphId);
		const task = graph?.tasks.find((t) => t.id === taskId);
		if (!task) return answer(false, `the task went missing from ${graphId}`, { graph: graphId, task: taskId });
		const last = task.attempts?.[task.attempts.length - 1];
		const text = task.result ?? last?.detail ?? "";
		if (task.state === "done" || task.state === "unproven") {
			return answer(true, text || "(the agent said nothing)", { graph: graphId, task: taskId });
		}
		// Refined into children: the parent is the sum of them and has no answer of
		// its own. Say what happened rather than reporting an empty success.
		const owed = graph ? outstanding(graph.tasks).length : 0;
		const why = task.reason ?? (owed ? `still owed — ${owed} task(s) outstanding in ${graphId}` : `it ended ${task.state}`);
		return answer(false, text ? `${why}\n\n${text}` : why, { graph: graphId, task: taskId });
	}

	/**
	 * Every graph that still owes something, as data rather than as a screen.
	 *
	 * A "session" over HTTP is a graph: it is the thing that holds a run's tasks,
	 * survives the process, and can be added to. Nothing new is invented for the
	 * API to have a noun.
	 */
	sessions(): Array<{ id: string; goal: string; status: string; tasks: Array<{ id: string; state: string; title: string }> }> {
		return this.open().map((graph) => ({
			id: graph.id,
			goal: graph.goal,
			status: outstanding(graph.tasks).length ? "owed" : "settled",
			tasks: graph.tasks.map((t) => ({ id: t.id, state: t.state, title: t.title })),
		}));
	}

	/**
	 * Stop caring about everything a graph still owes.
	 *
	 * Every unsettled task is closed as failed with the reason on it — which is
	 * what `close()` is for — rather than deleted. The journal is the point of
	 * this row: a cancelled task is a task with a recorded ending, and a task
	 * with no record is the bug the journal was written to remove.
	 */
	cancel(graphId: string, why = "cancelled through the delegate API"): { ok: boolean; cancelled: string[] } {
		const graph = this.get(graphId);
		if (!graph) return { ok: false, cancelled: [] };
		const cancelled: string[] = [];
		for (const task of outstanding(graph.tasks)) {
			if (this.close(graphId, task.id, { ok: false, detail: why })) cancelled.push(task.id);
		}
		return { ok: true, cancelled };
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
			onEvent: (event, data) => (this.ctx.emit as unknown as (n: string, d: unknown) => void)?.(event, data),
			// An unstated task has no criterion, so running it can only end
			// `unproven` — and the drive sets every `unproven` task back to
			// `unstated` each sweep, which means a task run through this path
			// comes back `unproven`, gets reset, and is run again, forever.
			// This was 80% of all negative outcomes in six hours. With
			// `replanCriterion` set, `runnable()` filters `unstated` tasks out:
			// they are left for the drive's planner to refine, not handed to an
			// agent that cannot prove them. A caller who wants the old behaviour
			// can pass `{ replanCriterion: false }` explicitly.
			replanCriterion: true,
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

		// What an unwatched child costs, asked of the row that owns that
		// question. Probed with `ctx.get` and not `inject`: cordis 4 has no
		// optional inject, and a composition without `@rlm/headless` must still
		// be able to spawn a child — it would simply spawn a more expensive one.
		const headless = this.ctx.get("rlmHeadless") as
			| {
					childNodeFlags?: () => string[];
					childRuntimeFlags?: () => string[];
					childRuntime?: () => { command: string; kind: "node" | "bun" };
					childPoolSlots?: () => number;
					childHeartbeatMs?: () => number;
					childHeartbeatTimeoutMs?: () => number;
			  }
			| undefined;
		// What *runs* an unwatched child, asked of the same row and for the same
		// reason the flags are. Measured: the interpreter floor is 39 MB for node
		// and 21 MB for bun, and a node child also carries the tsx loader and the
		// `esbuild --service` process tsx starts beside it. A composition without
		// the row keeps the interpreter running this one, which is what it always
		// did.
		const runtime = headless?.childRuntime?.() ?? { command: process.execPath, kind: "node" as const };
		const childFlags = headless?.childRuntimeFlags?.() ?? headless?.childNodeFlags?.() ?? [];

		// Whether children are pooled is the headless row's answer too, for the
		// same reason the flags are: what an unwatched child costs is a fact
		// about unwatched children. Probed with `ctx.get`, so a composition
		// without `@rlm/headless` spawns one process per task exactly as before —
		// that is the whole of the switch, and it is the one he asked for.
		const slots = headless?.childPoolSlots?.() ?? 0;
		/**
		 * The pool, resolved at the moment work is handed over rather than once
		 * per sweep.
		 *
		 * A sweep used to capture the pool object in a closure. The row's
		 * teardown then closed that object on the next hot reload — and a sweep
		 * is not torn down with the row that started it, because `driveGraphs`
		 * is an async call already in the air. So the sweep went on submitting
		 * tasks to a corpse, and every one came back "the pool is closed": 883
		 * of them across 42 graphs in the store when this was found, which is
		 * also why the fleet was nothing but planners — a runner path that
		 * refuses every task leaves the drive with nothing to do except ask the
		 * planner to rewrite the criteria it keeps failing.
		 *
		 * Resolving per call fixes it at the root: a closed pool is dropped and
		 * a live one is built, so no caller can be left holding a dead one.
		 */
		const poolNow = (): AgentPool | null => {
			// `0` is still the whole of the switch: no headless row, no pool. `1`
			// used to mean the same thing, and that was a real defect once slots
			// became resource-based — a tight machine would answer "one task per
			// worker", which is the moment pooling matters most, and be read as
			// "spawn a fresh 143 MB process per task" instead.
			if (slots < 1) return null;
			// A pool with no agent behind it is a fleet of workers that answer every
			// task with the same internal error. Refuse to build one and let the
			// one-shot path stand — that path spawns `cordis-shell.mjs`, which
			// composes its own agent, so it works in compositions this does not.
			if (typeof (this.ctx.get("rlmAgent") as any)?.createRuntime !== "function") {
				if (!this.saidNoAgent) {
					this.saidNoAgent = true;
					const why =
						"rlm-delegate: no rlmAgent service in this composition — children stay one process per task instead of pooling";
					this.ctx.logger?.warn?.(why);
					console.log(`  ${why}`);
				}
				return null;
			}
			if (this.pool?.isClosed()) this.pool = null;
			return this.workers(slots, childFlags, runtime, {
				// The headless row owns "what an unwatched child costs", and how
				// often one is expected to speak is part of that. This row's own
				// config stands in when there is no headless row to ask.
				every: headless?.childHeartbeatMs?.() ?? this.config.workerHeartbeatMs ?? 5_000,
				dead: headless?.childHeartbeatTimeoutMs?.() ?? this.config.workerHeartbeatTimeoutMs ?? 15_000,
			});
		};
		const pool = poolNow();
		// Said out loud on the way in, beside the me-2 line, for the same reason:
		// "children are pooled" is exactly the kind of claim that is invisible
		// when it is false, and the whole point of the pool is a number he can
		// see. `console.log` and not the logger — the logger does not reach the
		// drive's own log, which is where somebody looks.
		//
		// Per path, and never as one blanket sentence. The blanket sentence is
		// what made this defect survive: the log read "children are pooled" for
		// hours while `ps` showed twenty-five one-shot planners and zero pool
		// workers, because the runner path was pooled and the planner path —
		// which was doing all of the actual spawning — was not, and one claim
		// covering both paths reported the half that was true. A line that can
		// be checked against `ps` has to name the path it is talking about.
		// One place computes it, three lines say it. It used to be computed three
		// times from the same expression, which is three chances for the log and
		// the pool to disagree about the number the log exists to make checkable.
		const ceiling = this.workerCeiling(slots)();
		const atMost = ceiling >= Number.MAX_SAFE_INTEGER ? "as many as the machine will carry" : `at most ${ceiling}`;
		console.log(
			pool
				? `  runners are pooled on ${runtime.kind} — ${slots} task(s) per worker, ${atMost} worker(s)`
				: `  runners are one ${runtime.kind} process each — no headless row asked for a pool`,
		);

		const makeRunner =
			options.makeRunner ??
			((signal: AbortSignal) => {
				// Built once and used only if there is no pool to use, so the
				// fallback costs nothing while pooling is on.
				const alone = () =>
					rlmAgent({
						entry: this.config.entry ?? process.argv[1],
						cwd: this.config.cwd ?? process.cwd(),
						timeoutMs: this.config.attemptTimeoutMs ?? 2_700_000,
						node: runtime.command,
						runtime: runtime.kind,
						nodeFlags: childFlags,
						signal,
					});
				return (task: any, graph: any) => {
					const live = poolNow();
					return (live ? live.runner({ signal }) : alone())(task, graph);
				};
			});

		// The planner is the same agent, asked a different question. Cheap to
		// build here and worth having by default: without one, a request that is
		// fifteen jobs in a paragraph can only become a question.
		//
		// It is the same agent, and it is deliberately not given the same reach.
		// Asked to write a plan, a planner with the repo in its write scope does
		// the work instead — `install-and-wire-the-iris-17` is the recorded case:
		// a planning call in which the child did the job, deleted a correct file
		// as "wrong place", and was killed at its ten-minute ceiling. A plan is a
		// paragraph. So the child is wrapped in a kernel-enforced write scope that
		// contains `~/.plans` and what its own boot needs, and does not contain
		// the repo, PATH, or the graphs — see confine.ts. It keeps a write tool,
		// pointed somewhere a plan belongs.
		//
		// If the machine cannot enforce it, the planner runs as it always did and
		// says so once. A bound nobody can see failing is worse than none.
		const bound = confineTo(plannerScope());
		if (!bound) this.ctx.logger?.warn?.("rlm-delegate: no sandbox-exec here, so the planner runs with the same reach as the runner");
		// The planner's own line, because the planner's own answer is different
		// from the runner's: it gets a separate pool when it is confined, and
		// separate workers are a separate number in `ps`.
		console.log(
			!pool
				? `  planners are one ${runtime.kind} process each — no headless row asked for a pool`
				: bound
					? `  planners are pooled on ${runtime.kind} in their own sandbox-exec workers — ${slots} plan(s) per worker, ${atMost} worker(s), writes bound to ~/.plans`
					: `  planners are pooled on ${runtime.kind} and UNCONFINED — sandbox-exec is not on this machine, so they share the runners' workers and the runners' reach`,
		);
		// The planner is pooled too, and this is where the whole cost was.
		//
		// It was not. `makePlanner` built a `rlmAgent` directly and never touched
		// the pool, so every planning call was its own 138 MB process — while the
		// log said "children are pooled", because the runner path was and this
		// one was not. Measured on the live fleet the moment this was found:
		// twenty-five one-shot children, 3005 MB, and every single one of them a
		// planner. Zero pool workers. The refine phase runs planner calls up to
		// `capacity().limit` at once by design (drive.ts), so the unpooled path
		// was the one doing essentially all of the spawning in the fleet.
		//
		// Going through the pool changes nothing about what the planner is asked
		// or where it resumes from: `pool.run()` builds its prompt with the same
		// `withCriterion(task)` and its session with the same `sessionFor(graph,
		// task)` that `rlmAgent` uses, so the prompt and the session id are
		// identical on both paths. What changes is that the boot is paid once per
		// worker instead of once per plan.
		//
		// The bound still holds, and it holds *more* tightly than a comment: a
		// confined runner does not share these workers. `pool.runner({confine})`
		// routes to a sibling pool of its own whose workers are themselves
		// started inside `sandbox-exec` (pool.ts `hire()` wraps the worker argv,
		// not each task), so every task in that pool is under one profile — which
		// is the condition that makes sharing a process sound at all. A planner
		// still cannot write outside `~/.plans`.
		const plannerTimeoutMs = Math.min(this.config.attemptTimeoutMs ?? 2_700_000, 600_000);
		const makePlanner =
			options.makePlanner ??
			((signal: AbortSignal) => {
				const alone = () =>
					rlmAgent({
						entry: this.config.entry ?? process.argv[1],
						cwd: this.config.cwd ?? process.cwd(),
						timeoutMs: plannerTimeoutMs,
						node: runtime.command,
						runtime: runtime.kind,
						nodeFlags: childFlags,
						signal,
						...(bound ? { confine: bound } : {}),
					});
				return (prompt: string, task: any, graph: any) => {
					const live = poolNow();
					const ask = live
						? live.runner({ signal, timeoutMs: plannerTimeoutMs, ...(bound ? { confine: bound } : {}) })
						: alone();
					// A planning turn is not a doing turn, and it must not resume
					// one.
					//
					// `sessionFor` is `rlm-delegate-${graph.id}-${task.id}` and the
					// planner is handed the *same task*, so planner and runner
					// derive a byte-identical session id. On the one-shot path
					// that was harmless because the id went down the command line
					// and was read by nobody. A pooled worker reads it: it turns
					// the id into a `SessionManager` pointed at
					// `~/.rlm/agent/sessions/<id>.jsonl` and resumes the file if
					// it exists. So pooling the planner — and only pooling it —
					// would have made the two share a transcript.
					//
					// It is reachable, not theoretical: a failed task has its
					// criterion written back to `unstated` and is handed to the
					// planner (drive.ts), whose session file is then full of the
					// runner's failed attempts; and a thrice-refused plan goes
					// back to the runner carrying the planner's transcript.
					//
					// Namespacing the id at the one place both paths derive it
					// from — the task id — fixes pooled and one-shot together and
					// needs no new seam. Nothing downstream reads this id: it is
					// used for `sessionFor` and nothing else on this call.
					//
					// The proof is dropped for the same reason, and it is the
					// other half of the same seam. `withCriterion(task)` — which
					// both paths use to build the prompt — appends the runner's
					// judging boilerplate ("Make that true. If it names a file,
					// write that file") to anything whose proof is not `unstated`.
					// A planning prompt ends by demanding a JSON array, so that
					// text landing on it produces unparseable output and reads as
					// a bad planner rather than a corrupted prompt. Today it
					// cannot happen, because everything reaching the planner is
					// written back to `unstated` first — but that is an invariant
					// of a call graph three files away, unstated and unenforced.
					// Saying so here costs one field and makes the planning prompt
					// verbatim by construction.
					return ask(
						{ ...task, id: `${task.id}::plan`, proof: { kind: "unstated", note: "a planning turn" }, prompt },
						graph,
					);
				};
			});

		// me-2, built here for the same reason the planner is: a default that
		// exists. Without one the criterion is the only thing between an attempt
		// and `done`, and every defect that cost a night this week passed its
		// criterion — the flag nothing read, the guard that could not be true,
		// the filter that ate every graph and reported success.
		//
		// It reaches the model through `askModel`, which is one chat completion
		// with no `tools` field, so the reviewer structurally cannot go and fix
		// what it finds. A reviewer with hands is a second author.
		const makeReviewer =
			options.makeReviewer ??
			(this.config.review === false
				? undefined
				: (signal: AbortSignal) =>
						me2({
							ask: askModel({
								model: this.config.reviewModel,
								maxTokens: this.config.reviewMaxTokens ?? 4000,
								signal,
							}),
						}));

		const report = await driveGraphs(this.store, {
			probe: this.probe(),
			cwd: this.config.cwd,
			maxAttempts: this.config.maxAttempts ?? 3,
			repeatFloor: this.config.repeatFloor ?? 2,
			maxSweeps: this.config.maxSweeps ?? 25,
			concurrency:
				typeof this.config.concurrency === "number" ? this.config.concurrency : () => this.capacity().limit,
			onEvent: (event, data) => (this.ctx.emit as unknown as (n: string, d: unknown) => void)?.(event, data),
			...options,
			makeReviewer: options.reviewer ? undefined : makeReviewer,
			makeRunner: options.runner ? undefined : makeRunner,
			makePlanner: options.planner ? undefined : makePlanner,
			stop,
		});
		// What actually happened, as opposed to what was announced on the way in.
		//
		// The line at the top of a sweep is a statement of intent — it says what
		// the drive means to do. This one is a count of what it did, and the two
		// disagreeing is the whole defect this was written for: "children are
		// pooled" printed for hours over a fleet of twenty-five one-shot
		// planners. Worker pids are named so the claim can be checked against
		// `ps` by somebody who does not trust the log, which is the correct
		// attitude to a log.
		const ran = this.pool?.stats();
		if (ran) {
			const say = (what: string, st: { served: number; workers: { pid?: number }[] }) =>
				`${what}: ${st.served} task(s) through ${st.workers.length} live worker(s)` +
				(st.workers.length ? ` [pid ${st.workers.map((w) => w.pid ?? "?").join(", ")}]` : "");
			type Ran = { served: number; workers: { pid?: number }[] };
			const parts = [say("runners", ran), ...ran.confined.map((c: Ran) => say("planners (confined)", c))];
			const total = ran.served + ran.confined.reduce((n: number, c: Ran) => n + c.served, 0);
			console.log(
				total
					? `  pooled this sweep — ${parts.join("; ")}`
					: `  pooled this sweep — nothing went through the pool (no task reached a worker)`,
			);
		} else if (slots > 1) {
			console.log("  pooled this sweep — no pool was ever built, so every child was its own process");
		}
		this.ctx.logger?.info?.(renderReport(report));
		return report;
	}

	/**
	 * The warm workers, made once.
	 *
	 * `maxWorkers` is not a new number. `capacity()` already decides how many
	 * tasks may be in flight at once, off the machine rather than off a setting,
	 * and the scheduler already holds the fleet to it; this is that same ceiling
	 * divided by how many tasks fit in one process. Inventing a second limit
	 * beside `capacity()` is exactly what the guard row exists to stop.
	 */
	/**
	 * How many worker processes the pool may hold, re-read as the machine moves.
	 *
	 * Held for three seconds because `capacity()` shells out to `ps` and the
	 * pool asks on every hiring decision.
	 */
	private workerCeiling(slots: number): () => number {
		let held: { at: number; n: number } | null = null;
		return () => {
			const now = Date.now();
			if (held && now - held.at < 3000) return held.n;
			// `capacity()` pinned to a number is still the fleet-wide budget and
			// still outranks everything else. What changed is what happens when it
			// is *not* pinned: `capacity().limit` is itself a live reading, so
			// dividing it by a slot count that is now also live produced a ceiling
			// derived from two moving numbers and meaning neither. Unpinned, the
			// pool asks its own memory question — one worker while the machine is
			// tight, uncapped while it is not — and the OS refuses the rest.
			if (typeof this.config.concurrency === "number") {
				const n = Math.max(1, Math.ceil(this.config.concurrency / Math.max(1, slots)));
				held = { at: now, n };
				return n;
			}
			const n = Number.MAX_SAFE_INTEGER;
			held = { at: now, n };
			return n;
		};
	}

	private workers(
		slots: number,
		childFlags: string[],
		runtime: { command: string; kind: "node" | "bun" },
		beats: { every: number; dead: number } = { every: 5_000, dead: 15_000 },
	): AgentPool {
		if (this.pool) return this.pool;
		this.pool = new AgentPool({
			entry: this.config.entry ?? process.argv[1],
			cwd: this.config.cwd ?? process.cwd(),
			timeoutMs: this.config.attemptTimeoutMs ?? 2_700_000,
			node: runtime.command,
			runtime: runtime.kind,
			nodeFlags: childFlags,
			slots,
			// Read on every hiring decision, not once here. Held for three seconds
			// inside `workerCeiling` — long enough that a burst of tasks does not
			// re-measure twenty times, short enough that the pool follows the
			// machine.
			maxWorkers: this.workerCeiling(slots),
			// The admission rule's own floor, and deliberately the same number
			// `capacity()` uses: two floors that disagree is how a fleet ends up
			// throttled by whichever one nobody remembered.
			memoryFloor: this.config.headroomFloor ?? 0.2,
			// The pool asks `capacity.ts` how much memory there is rather than
			// `freemem()`, because on darwin `freemem()` counts only wholly free
			// pages and a healthy machine reads one percent.
			freeFraction: () => this.capacity().readings.find((r) => r.name === "memory")?.headroom ?? 1,
			queueLimit: this.config.queueLimit ?? 64,
			heartbeatMs: beats.every,
			heartbeatTimeoutMs: beats.dead,
			log: (line) => this.ctx.logger?.info?.(line),
		});
		const ceiling = this.workerCeiling(slots)();
		this.ctx.logger?.info?.(
			`rlm-delegate: pooling children — ${slots} task(s) per worker, ${ceiling >= Number.MAX_SAFE_INTEGER ? "as many as the machine will carry" : `at most ${ceiling}`} worker(s)`,
		);
		return this.pool;
	}

	/**
	 * Open one agent, and by the same act close every other one.
	 *
	 * *"when i open 1 delegator agent, the other 900 subagents are still
	 * headless, and when i open one of the subagents, all other 900-1 subagents
	 * and the main delegator agents are headless?"* — yes, and this is where it
	 * is said. One session in the whole fleet is watched at a time; the worker
	 * holding it hands out `rlmLive` and the rows that exist for a person mount
	 * inside it, and every other worker, including the one that was watched a
	 * moment ago, does not. Nothing restarts.
	 *
	 * With no pool there is nothing to route to, so it moves this process's own
	 * attention instead — which is the same fact, in the one process there is.
	 */
	attend(sessionId: string | null): string | null {
		if (this.pool) return this.pool.attend(sessionId);
		const headless = this.ctx.get?.("rlmHeadless") as { attend?: (id: string | null) => unknown } | undefined;
		headless?.attend?.(sessionId);
		return sessionId;
	}

	/** The session a given task runs as, so `attend` can be given a task. */
	sessionOf(graphId: string, taskId: string): string | null {
		const graph = this.store.load(graphId);
		const task = graph?.tasks.find((t) => t.id === taskId);
		return graph && task ? sessionFor(graph, task) : null;
	}

	/** What the pool is doing, for anyone asking why the fleet costs what it does. */
	poolStats() {
		return this.pool?.stats() ?? null;
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
export { rlmAgent, sessionFor, withCriterion, type AgentOptions } from "./agent.ts";
export { AgentPool, pooledAgent, type PoolOptions } from "./pool.ts";
export { refineOne, needsRefining, parsePlan, reopenForged, PLAN_INSTRUCTIONS, type Planner } from "./refine.ts";
export { confineTo, plannerScope, bootPaths, profileFor, available as canConfine, type Scope } from "./confine.ts";
export { forgeable, forgeryIn, reachOf, gripOn, whichIs, type Forgery, type Grip, type Reach } from "./forgeable.ts";
export { askIn } from "./derive.ts";
export { diagnose, type Diagnosis, type Carrier, type CauseKind } from "./lapse.ts";
export { nextAttempt } from "./scheduler.ts";
export { me2, type Me2Options } from "./me2.ts";
export { askModel, route as modelRoute, type AskOptions, type Route } from "./ask.ts";
export { load as loadLessons, add as addLesson, brief as lessonBrief, SEED as LESSONS, type Lesson } from "./lessons.ts";


export type { ElekshaSession, ElekshaConnectionOptions } from "./eleksha.ts";
export { connectToEleksha, canConnectToEleksha, sendToEleksha, disconnectFromEleksha } from "./eleksha.ts";