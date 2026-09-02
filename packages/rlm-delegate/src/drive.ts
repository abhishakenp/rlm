/**
 * The loop that takes owed work and drives it to proven, or to an honest stop.
 *
 * Everything under this file already existed and none of it moved. A graph
 * could not forget; a criterion decided done; a failure was fingerprinted; the
 * machine's capacity was measured. And the backlog still did not shrink,
 * because every one of those things waited to be asked. `run(graphId)` needs a
 * graph id, from somebody who went and looked. Nothing ever went and looked.
 *
 * So this is the part that is not asked. It reads what is owed off the disk,
 * across every graph, works all of it against one shared budget, and comes back
 * with each task either proven done or stopped with a specific question against
 * its name. It is bounded in three independent ways — attempts per task, sweeps
 * per run, and a stop file it re-reads before every single task — because
 * something that drives an agent unattended on somebody's laptop while he is
 * asleep has to be easier to stop than to start.
 *
 * The three rules it exists to enforce, in the order they were violated:
 *
 *   1. Nobody has to ask. Owed work is picked up because it is owed.
 *   2. A turn ending is not the exit condition; the criterion is. A task that
 *      came back without its criterion passing has had an attempt, not a
 *      result.
 *   3. Nothing is tried the same way twice, and nothing is tried forever. When
 *      the loop runs out of things it knows, it produces a question — see
 *      impasse.ts, which is where that judgement is written down.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capacity } from "./capacity.ts";
import { outstanding, runnable, type Graph, type Task } from "./graph.ts";
import { impasses, renderImpasses, type Impasse } from "./impasse.ts";
import { needsRefining, refineOne, type Planner } from "./refine.ts";
import { run as runGraph, type RunOptions, type Runner } from "./scheduler.ts";
import { Gate, Stop } from "./stop.ts";
import { check, type Probe } from "./proof.ts";
import type { Store } from "./store.ts";

export interface DriveOptions {
	runner?: Runner;
	/**
	 * Build the runner once the drive's own stop signal exists.
	 *
	 * A stop that only refuses the *next* task is not a stop — a fifteen-minute
	 * attempt already in the air has to die too, and only the thing that spawned
	 * it can kill it. So the runner is handed the signal rather than being asked
	 * to find one.
	 */
	makeRunner?: (signal: AbortSignal) => Runner;
	/** Cap across every graph at once. A number pins it; left out, it is measured. */
	concurrency?: number | (() => number);
	probe?: Probe;
	cwd?: string;
	maxAttempts?: number;
	/** me-2, if there is one. Nothing is called done without it when there is. */
	reviewer?: RunOptions["reviewer"];
	/**
	 * Build me-2 once the drive's stop signal exists.
	 *
	 * Same reason as `makeRunner`: a review in the air when the stop file
	 * appears has to die with everything else. A reviewer that keeps holding a
	 * model call after a stop is a drive that has not stopped.
	 */
	makeReviewer?: (signal: AbortSignal) => RunOptions["reviewer"];
	/** Who is running this drive, stamped on every attempt it records. */
	executor?: string;
	repeatFloor?: number;
	similarity?: number;
	/** How the stop is read. Defaults to the Desktop files. */
	stop?: Stop;
	/** How often the stop file is re-read while work is in the air. */
	pollMs?: number;
	/**
	 * The hard bound on the whole run. A sweep is one pass over everything owed;
	 * a second sweep only happens because the first one changed something.
	 */
	maxSweeps?: number;
	/** Keep going after the backlog settles, waiting for new work to arrive. */
	follow?: boolean;
	/** How long to wait between sweeps when following. */
	idleMs?: number;
	/** Where the questions are written for him to read. */
	questionsPath?: string;
	/** Refuse a task before anybody is handed it. Return a sentence. */
	fence?: (task: Task, graph: Graph) => string | null | undefined;
	onEvent?: (event: string, data: Record<string, unknown>) => void;
	/** Only these graphs. Left out, everything that is owed. */
	only?: string[];
	/**
	 * Read a recorded request and say what the separate jobs are.
	 *
	 * Optional, and the drive works without it — but without it a request that
	 * nobody could read a criterion out of can only ever become a question, and
	 * on real traffic that is every request, because what arrives is fifteen
	 * jobs in one paragraph. See refine.ts.
	 */
	planner?: Planner;
	/** Build the planner once the drive's stop signal exists. */
	makePlanner?: (signal: AbortSignal) => Planner;
	/** Refine at most this many recorded requests per sweep. */
	refineLimit?: number;
}

export interface DriveReport {
	sweeps: number;
	/** Why it came back: the backlog settled, it was stopped, or it hit its bound. */
	ended: "settled" | "stopped" | "bound";
	stoppedBy?: string;
	graphs: number;
	proven: string[];
	owed: string[];
	questions: Impasse[];
	questionsPath?: string;
}

/** What the graph looked like, so "did anything move?" is a comparison and not a feeling. */
const fingerprint = (graphs: Graph[]): string =>
	graphs
		.flatMap((g) => g.tasks.map((t) => `${g.id}/${t.id}:${t.state}:${t.attempts.length}`))
		.sort()
		.join("|");

export const drive = async (store: Store, options: DriveOptions): Promise<DriveReport> => {
	const say = options.onEvent ?? (() => {});
	const stop = options.stop ?? new Stop();
	const maxSweeps = options.maxSweeps ?? 25;
	const limit =
		typeof options.concurrency === "number"
			? () => Math.max(1, options.concurrency as number)
			: (options.concurrency ?? (() => capacity().limit));
	const gate = new Gate(limit);

	// One controller for the whole drive. The stop file, a stop in process and
	// a stop between sweeps all come out here, so a runner that honours the
	// signal is killed by all three without knowing about any of them.
	const abort = new AbortController();
	let stoppedBy: string | null = stop.reason();
	if (stoppedBy) abort.abort();

	const poll = setInterval(() => {
		const why = stop.reason();
		if (why && !abort.signal.aborted) {
			stoppedBy = why;
			say("rlm/drive-stopped", { why });
			abort.abort();
		}
	}, options.pollMs ?? 1_000);
	poll.unref?.();

	// The stop is also checked at the door of every single task, not only on the
	// poll. A file that appears while eight tasks are queued must stop task two,
	// not task two-thousand milliseconds later.
	const fence = (task: Task, graph: Graph): string | null | undefined => {
		const why = stop.reason();
		if (why) {
			if (!abort.signal.aborted) {
				stoppedBy = why;
				abort.abort();
			}
			return `not started: ${why}`;
		}
		return options.fence?.(task, graph);
	};

	const planner = options.planner ?? options.makePlanner?.(abort.signal);
	const reviewer = options.reviewer ?? options.makeReviewer?.(abort.signal);
	const runner = options.runner ?? options.makeRunner?.(abort.signal);
	if (!runner) throw new Error("the drive needs a runner: pass `runner`, or `makeRunner` to get the stop signal");

	let sweeps = 0;
	let ended: DriveReport["ended"] = "settled";
	/**
	 * Graphs this run actually looked at.
	 *
	 * The account has to be about this run. Counting every `done` task in the
	 * store would have the drive taking credit for work finished last week,
	 * which is the same species of lie as counting a turn ending as a result.
	 */
	const touched = new Set<string>();

	/** The graphs this drive is allowed to look at, read fresh off the disk. */
	const read = (): Graph[] => store.open().filter((g) => !options.only?.length || options.only.includes(g.id));

	/**
	 * Refinement finished something, so there may be work now.
	 *
	 * The work loop below runs *beside* refinement rather than after it, so it
	 * has to hear that a plan landed at the moment it lands rather than on a
	 * timer. One waiter, because there is one work loop.
	 */
	let wake: (() => void) | null = null;
	const produced = (): void => {
		const woken = wake;
		wake = null;
		woken?.();
	};
	const waitForWork = (ms: number): Promise<void> =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				wake = null;
				resolve();
			}, ms);
			timer.unref?.();
			wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});

	/**
	 * Refinement, several at a time, against the same budget the work uses.
	 *
	 * It used to be one at a time — a plain double `for` loop `await`ing
	 * `refineOne`, with the whole of execution waiting below it. Measured on
	 * the real backlog: 229 requests needing a criterion and 3 tasks runnable,
	 * because with a planner mounted an `unstated` task is deliberately not
	 * runnable. Every runner on the machine therefore sat idle behind a
	 * single-file queue of planner calls, each of which is a spawned child with
	 * a ten-minute cap. That is not a slow loop, it is a stopped one.
	 *
	 * Three things make running them together safe, and none of them is
	 * optimism:
	 *
	 *   - **The journal cannot be raced from here.** `store.refine` loads the
	 *     graph, validates the plan against it and appends the line with no
	 *     `await` anywhere in between — there is not one in the whole of
	 *     store.ts — so on one thread it is a single indivisible step. Two
	 *     plans for two tasks of the SAME graph are each validated against
	 *     what is on disk at the instant they are written, so a second plan
	 *     that collides on an id is refused exactly as it would have been in a
	 *     serial loop, and the planner is handed that objection to fix.
	 *   - **The bound is unchanged.** `refineLimit` bounds refusals, not
	 *     refinements. Once the cap is reached nothing further is picked up and
	 *     what is already in the air finishes. A planner producing refusable
	 *     plans still cannot become the loop.
	 *   - **The stop is unchanged.** It is re-read before every task is picked
	 *     up and again after the gate is taken, so a stop file appearing while
	 *     eight plans are in the air refuses the ninth at once and kills the
	 *     eight through the abort signal the planner was built with.
	 *
	 * The gate is the one the work uses, so planning and running compete for a
	 * single measured budget rather than refinement being free and unbounded
	 * beside a capped runner.
	 */
	const refineAll = async (open: Graph[], state: { active: number; done: boolean }): Promise<void> => {
		try {
			if (!planner) return;
			// Bound the refusals, not the refinements.
			//
			// A refusal is the thing that can spin, so that is what is counted.
			// Refinements the graph accepts are progress and cost one model call
			// each, which is cheap beside a delegation.
			const refusalCap = options.refineLimit ?? 4;
			let refused = 0;

			// Most wanted first, here as well as at the door of the runner.
			// `runnable()` has sorted by priority since me-1 and me-2 sat behind
			// fashion trends — but with two hundred requests waiting for a
			// criterion, WHICH of them gets one is what decides what is runnable
			// at all, so the same ordering has to be applied a step earlier or
			// the priority never gets the chance to matter. Stable, so an
			// unprioritised backlog is refined in the order it was written down.
			const queue = open
				.flatMap((graph) => needsRefining(graph).map((task) => ({ graph, task })))
				.sort((a, b) => (b.task.priority ?? 0) - (a.task.priority ?? 0));
			let next = 0;

			const worker = async (): Promise<void> => {
				for (;;) {
					if (refused >= refusalCap || stop.reason() || abort.signal.aborted) return;
					const item = queue[next++];
					if (!item) return;
					const release = await gate.take();
					// Re-read after the wait: this may have queued behind a
					// forty-minute delegation, and the stop file is never cached.
					if (stop.reason() || abort.signal.aborted) {
						release();
						return;
					}
					state.active += 1;
					say("rlm/drive-refining", {
						graph: item.graph.id,
						task: item.task.id,
						title: item.task.title,
						atOnce: state.active,
					});
					let into = 0;
					try {
						into = await refineOne(store, item.graph, item.task, planner, say, { cwd: options.cwd });
					} catch (error: any) {
						say("rlm/drive-graph-error", { graph: item.graph.id, error: String(error?.message ?? error) });
					} finally {
						state.active -= 1;
						release();
					}
					if (into) {
						say("rlm/drive-refined", { graph: item.graph.id, task: item.task.id, into });
						// Said at once. The work loop is running beside this, and
						// the whole point is that it starts on the first plan that
						// lands rather than on the two hundredth.
						produced();
					} else refused += 1;
				}
			};

			// The pool is sized to the same measured limit, and re-sized as the
			// machine changes under it. The gate is the real cap — an extra
			// worker only ever waits — but too few workers would leave the
			// budget unspent, which is the whole bug this is about.
			const alive = new Set<Promise<void>>();
			for (;;) {
				while (
					alive.size < Math.max(1, limit()) &&
					next < queue.length &&
					refused < refusalCap &&
					!stop.reason() &&
					!abort.signal.aborted
				) {
					const running: Promise<void> = worker().finally(() => alive.delete(running));
					alive.add(running);
				}
				if (!alive.size) break;
				const tick = new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 2_000);
					timer.unref?.();
				});
				await Promise.race([...alive, tick]);
			}
		} finally {
			state.done = true;
			produced();
		}
	};

	/**
	 * The work, run beside refinement rather than after it.
	 *
	 * Refinement's product IS runnable work, so a phase that has to finish
	 * first is a phase that holds every runner idle for as long as the planner
	 * takes. This loops instead: it re-reads the graphs, runs everything that
	 * is runnable, and — while refinement is still going — waits to be told a
	 * plan has landed rather than ending the sweep.
	 *
	 * Nothing unrefined can reach a runner through this, and that is
	 * structural rather than careful. The rule lives in `runnable(tasks,
	 * canRefine)`, which excludes `unstated` whenever there is a planner to
	 * give it a criterion instead, and the scheduler applies it itself on every
	 * pass of its own loop. This decides only WHEN the scheduler is asked,
	 * never WHAT it may hand out.
	 */
	const work = async (refining: { done: boolean }): Promise<void> => {
		// The store's fingerprint the last time a pass moved nothing. A graph
		// whose tasks the fence refuses stays workable for ever; without this it
		// would be handed to the scheduler in a tight loop.
		let idleAt: string | null = null;
		for (;;) {
			if (abort.signal.aborted || stoppedBy) return;
			const open = read();
			const mark = fingerprint(open);
			const workable = mark === idleAt ? [] : open.filter((g) => runnable(g.tasks, Boolean(planner)).length);

			if (!workable.length) {
				idleAt = mark;
				// Nothing to run yet. If something is still turning requests into
				// runnable work, wait for it rather than ending the sweep holding
				// work that is one planner call away from being startable.
				if (refining.done) return;
				await waitForWork(2_000);
				continue;
			}

			for (const graph of workable) touched.add(graph.id);
			say("rlm/drive-working", {
				graphs: workable.map((g) => g.id),
				runnable: workable.reduce((n, g) => n + runnable(g.tasks, Boolean(planner)).length, 0),
				limit: limit(),
			});

			// Every graph at once, one budget between them. Two graphs with no
			// relationship are as independent as two tasks with no edge, and the
			// gate is what makes that safe rather than optimistic.
			await Promise.all(
				workable.map((graph) =>
					runGraph(store, graph.id, runner, {
						concurrency: () => Math.max(1, limit()),
						gate,
						fence,
						signal: abort.signal,
						probe: options.probe,
						cwd: options.cwd,
						maxAttempts: options.maxAttempts,
						// A dead-end criterion is only worth handing back if there is
						// somebody to write a better one.
						replanCriterion: Boolean(planner),
						reviewer,
						executor: options.executor,
						repeatFloor: options.repeatFloor,
						similarity: options.similarity,
						onEvent: say,
					}).catch((error: any) => {
						// A graph that throws is a graph, not the drive. The others
						// carry on and this one is still on disk saying what it owes.
						say("rlm/drive-graph-error", { graph: graph.id, error: String(error?.message ?? error) });
					}),
				),
			);

			idleAt = fingerprint(read()) === mark ? mark : null;
		}
	};

	try {
		for (;;) {
			if (stoppedBy) {
				ended = "stopped";
				break;
			}
			if (sweeps >= maxSweeps) {
				ended = "bound";
				say("rlm/drive-bound", { sweeps, bound: maxSweeps });
				break;
			}

			let open = store.open().filter((g) => !options.only?.length || options.only.includes(g.id));
			const before = fingerprint(open);

			// Tasks that were given up on before any of this existed are not
			// runnable, so nothing ever reaches them again — they just sit in
			// `failed` with everything behind them unreachable. The scheduler
			// hands a dead end back as it runs; this is the same rule applied to
			// the ones that already stopped, every sweep, so it is the drive's
			// own job rather than a repair somebody has to remember to run.
			// First, and regardless of whether anybody can re-plan: a stopped task
			// whose criterion passes now is done. The criterion is the arbiter
			// everywhere else in this file, and it does not stop being the
			// arbiter because an earlier attempt was judged against a broken
			// version of it. `read-spec` failed twice on
			// `~/proj/rlm/docs/outloop.md` while the file sat plainly there,
			// because `~` was never expanded; fixing that must be enough to free
			// it, without anybody re-running the work.
			let settledLate = 0;
			for (const graph of open) {
				for (const task of graph.tasks) {
					if (task.state !== "failed") continue;
					const settled = await check(task.proof, { cwd: options.cwd, probe: options.probe }).catch(() => null);
					if (settled?.verdict !== "passed") continue;
					// This is a way to reach `done`, so it goes past me-2 like the
					// other one does. It was not, and that is not a small gap: a
					// criterion passing is exactly the evidence me-2 exists to
					// distrust, and this branch is the place where a criterion
					// passing is the *only* evidence there is — nobody ran the work
					// this sweep, so there is not even an agent's report under it.
					// Rare enough to cost nothing: it fires only when a check that
					// was failing has started to pass.
					if (reviewer) {
						const seen = await reviewer
							.review(task, graph)
							.catch((error: any) => ({ verdict: "rejected" as const, reason: `me-2 threw: ${error?.message ?? error}` }));
						if (seen.verdict === "rejected") {
							// Left exactly where it was. Nothing was attempted, so
							// nothing is spent, and it does not become a second way for
							// a stopped task to churn.
							store.reviewed(graph.id, task.id, {
								by: "me-2",
								at: new Date().toISOString(),
								verdict: "rejected",
								reason: `its criterion passes now, and that is all: ${seen.reason}`,
							});
							say("rlm/drive-settled-late-refused", { graph: graph.id, task: task.id, why: seen.reason.slice(0, 400) });
							continue;
						}
					}
					store.ended(graph.id, task.id, "done", { ok: true, detail: settled.detail, proofDetail: settled.detail } as any, {
						result: `its criterion passes now: ${settled.detail}`,
					});
					say("rlm/drive-settled-late", { graph: graph.id, task: task.id, detail: settled.detail });
					settledLate += 1;
				}
			}
			// `unreachable` is derived from what a task stands on, so freeing the
			// parent frees the children — but only on a fresh read. Working from
			// the list loaded before the repair would leave them unreachable for
			// the rest of the sweep, which is the whole bug wearing a new hat.
			if (settledLate) open = store.open().filter((g) => !options.only?.length || options.only.includes(g.id));

			if (planner) {
				for (const graph of open) {
					for (const task of graph.tasks) {
						// His rule, 2026-09-02: nothing rests in a stopped state. A
						// task may wait for HIM; it may never wait for nobody.
						//
						// `unproven` belongs here as much as `failed` does — a turn
						// ended and no criterion was ever run, which is not a
						// verdict, it is the absence of one. Fourteen of them were
						// sitting untouched because only `failed` was reconsidered.
						// `unreachable` is derived, so freeing what it stands on
						// frees it without anything being done to it directly.
						const stopped = task.state === "failed" || task.state === "unproven";
						if (!stopped) continue;
						// A shell criterion can be replaced; an unstated one is
						// already back in the planner's hands.
						// Any criterion a planner can rewrite — the same rule the
						// scheduler uses. I fixed it there and not here, and these
						// two are not interchangeable: the scheduler acts when a task
						// exhausts while running, this acts on tasks that already
						// stopped and are therefore never runnable again. Three
						// `kind: "file"` tasks sat failed across two fixes because of
						// it — check-omniroute-selection-logic,
						// inspect-omniroute-timeout-config, analyze-triggerless-skills
						// — and `stuck` went 73 to 84 behind them.
						if (task.proof?.kind === undefined || task.proof.kind === "rollup") continue;
						if (task.proof?.kind === "unstated" && task.state === "unproven" && !task.attempts.length) continue;
						if (task.attempts.length >= 2 * (options.maxAttempts ?? 3)) continue;
						try {
							store.answered(
								graph.id,
								task.id,
								{ kind: "unstated" },
								task.state === "unproven"
									? "the drive, because a turn ended and no criterion was ever run"
									: "the drive, because this check never once moved",
							);
							say("rlm/drive-replanning", { graph: graph.id, task: task.id, was: task.proof.kind === "shell" ? task.proof.run : task.state });
						} catch (error: any) {
							say("rlm/drive-graph-error", { graph: graph.id, error: String(error?.message ?? error) });
						}
					}
				}
				open = store.open().filter((g) => !options.only?.length || options.only.includes(g.id));
			}

			for (const graph of open) touched.add(graph.id);

			// What there is to do, in both currencies. Refinement turns the
			// first into the second, which is exactly why they no longer take
			// turns: a sweep that refines two hundred requests before it runs
			// anything is a sweep in which nothing runs.
			const refinable = planner ? open.reduce((n, g) => n + needsRefining(g).length, 0) : 0;
			const ready = open.reduce((n, g) => n + runnable(g.tasks, Boolean(planner)).length, 0);

			if (!refinable && !ready) {
				// Nothing runnable and nothing anybody could make runnable. This
				// is as far as it goes.
				if (!options.follow) break;
				say("rlm/drive-idle", { owed: open.reduce((n, g) => n + outstanding(g.tasks).length, 0) });
				await new Promise((r) => setTimeout(r, options.idleMs ?? 15_000));
				if (stop.reason()) {
					stoppedBy = stop.reason();
					ended = "stopped";
					break;
				}
				continue;
			}

			sweeps += 1;
			say("rlm/drive-sweep", {
				sweep: sweeps,
				graphs: open.map((g) => g.id),
				runnable: ready,
				refinable,
				limit: limit(),
			});

			// The two at once, on one budget. Refinement is not a phase ahead of
			// execution any more: it is work of a second kind, competing for the
			// same gate, and what it produces is picked up by the loop beside it
			// as soon as it is written down.
			const refining = { active: 0, done: !refinable };
			await Promise.all([refinable ? refineAll(open, refining) : Promise.resolve(), work(refining)]);

			const after = fingerprint(store.open().filter((g) => !options.only?.length || options.only.includes(g.id)));
			if (after === before) {
				// Nothing moved. Another identical sweep is the loop this file
				// exists to not be.
				say("rlm/drive-settled", { sweep: sweeps });
				if (!options.follow) break;
				await new Promise((r) => setTimeout(r, options.idleMs ?? 15_000));
			}
		}
	} finally {
		clearInterval(poll);
	}

	const all = store
		.ids()
		.filter((id) => touched.has(id))
		.map((id) => store.load(id))
		.filter((g): g is Graph => !!g)
		.filter((g) => !options.only?.length || options.only.includes(g.id));
	const found = impasses(all.filter((g) => outstanding(g.tasks).length));

	let questionsPath: string | undefined;
	try {
		questionsPath = options.questionsPath ?? join(store.dir, "QUESTIONS.md");
		mkdirSync(store.dir, { recursive: true });
		writeFileSync(questionsPath, renderImpasses(found), "utf8");
	} catch {
		// A question that could not be written down is still returned in the
		// report; failing to write the file must not lose it.
		questionsPath = undefined;
	}

	const report: DriveReport = {
		sweeps,
		ended,
		stoppedBy: stoppedBy ?? undefined,
		graphs: all.length,
		proven: all.flatMap((g) => g.tasks.filter((t) => t.state === "done").map((t) => `${g.id}/${t.id}`)),
		owed: all.flatMap((g) => outstanding(g.tasks).map((t) => `${g.id}/${t.id}`)),
		questions: found,
		questionsPath,
	};
	say("rlm/drive-done", {
		sweeps: report.sweeps,
		ended: report.ended,
		proven: report.proven.length,
		owed: report.owed.length,
		questions: report.questions.length,
	});
	return report;
};

/** The report as a person reads it. */
export const renderReport = (report: DriveReport): string =>
	[
		// "Settled" over nothing at all is not a result, it is a filter that ate
		// the work. Say so, because the sentence that reads like success is the
		// one nobody checks.
		report.ended === "settled" && report.graphs === 0
			? "the drive looked at no graphs at all — that is a fault, not an empty backlog: check what is restricting it"
			: `the drive ${report.ended === "settled" ? "worked everything it could" : report.ended === "stopped" ? `was stopped — ${report.stoppedBy}` : `hit its bound of sweeps`}`,
		`  ${report.proven.length} proven done, ${report.owed.length} still owed, across ${report.graphs} graph(s), in ${report.sweeps} sweep(s)`,
		...(report.questions.length
			? [
					`  ${report.questions.length} waiting on one sentence from you${report.questionsPath ? ` — ${report.questionsPath}` : ""}`,
					...report.questions.slice(0, 15).map((q) => `    ${q.graph}/${q.task.id} — ${q.question}`),
				]
			: []),
	].join("\n");
