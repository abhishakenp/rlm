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
import { run as runGraph, type Runner } from "./scheduler.ts";
import { Gate, Stop } from "./stop.ts";
import type { Probe } from "./proof.ts";
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

			let open = store.open().filter((g) => !options.only || options.only.includes(g.id));
			const before = fingerprint(open);

			// Before anything is handed to anybody: a request nobody can judge is
			// broken into jobs somebody can. Only ever on `unstated`, only ever
			// written down if the graph accepts the plan, and bounded per sweep so
			// a planner that keeps producing refusable plans cannot become the
			// loop.
			if (planner) {
				let refined = 0;
				for (const graph of open) {
					if (refined >= (options.refineLimit ?? 4) || stop.reason()) break;
					for (const task of needsRefining(graph)) {
						if (refined >= (options.refineLimit ?? 4) || stop.reason()) break;
						say("rlm/drive-refining", { graph: graph.id, task: task.id, title: task.title });
						const into = await refineOne(store, graph, task, planner, say).catch((error: any) => {
							say("rlm/drive-graph-error", { graph: graph.id, error: String(error?.message ?? error) });
							return 0;
						});
						refined += 1;
						if (into) say("rlm/drive-refined", { graph: graph.id, task: task.id, into });
					}
				}
				if (refined) open = store.open().filter((g) => !options.only || options.only.includes(g.id));
			}

			for (const graph of open) touched.add(graph.id);
			const workable = open.filter((g) => runnable(g.tasks).length);

			if (!workable.length) {
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
				graphs: workable.map((g) => g.id),
				runnable: workable.reduce((n, g) => n + runnable(g.tasks).length, 0),
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

			const after = fingerprint(store.open().filter((g) => !options.only || options.only.includes(g.id)));
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
		.filter((g) => !options.only || options.only.includes(g.id));
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
		`the drive ${report.ended === "settled" ? "worked everything it could" : report.ended === "stopped" ? `was stopped — ${report.stoppedBy}` : `hit its bound of sweeps`}`,
		`  ${report.proven.length} proven done, ${report.owed.length} still owed, across ${report.graphs} graph(s), in ${report.sweeps} sweep(s)`,
		...(report.questions.length
			? [
					`  ${report.questions.length} waiting on one sentence from you${report.questionsPath ? ` — ${report.questionsPath}` : ""}`,
					...report.questions.slice(0, 15).map((q) => `    ${q.graph}/${q.task.id} — ${q.question}`),
				]
			: []),
	].join("\n");
