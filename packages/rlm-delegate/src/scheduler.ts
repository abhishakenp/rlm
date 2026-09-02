/**
 * The loop that works the graph.
 *
 * Three things happen here that did not happen before, and each one is a thing
 * that went wrong on the night this was written:
 *
 *   - Everything runnable starts at once. "All non blocking and done parallelly"
 *     was asked for repeatedly; the graph is what makes it safe, because two
 *     tasks with no path between them cannot interfere by definition.
 *   - Coming back is not finishing. The criterion runs before the task is
 *     called done, and a criterion that does not pass turns the result into a
 *     failure with the criterion's own output attached.
 *   - A failure is written down. It becomes a state with a reason, in the
 *     journal, still in the graph, still blocking whatever depended on it —
 *     rather than a thing the process forgets on its way out.
 *
 * Every transition is journalled as it happens, not at the end, so killing this
 * mid-flight loses only the attempts that were actually in the air.
 */
import { capacity as measure } from "./capacity.ts";
import { runnable, settle, type Attempt, type Graph, type Task } from "./graph.ts";
import { diagnose, judge, shapeOf, wall, type Diagnosis } from "./lapse.ts";
import { check, type Probe } from "./proof.ts";
import type { Store } from "./store.ts";

/** Hand a task to whatever does the work. Return its result, or throw. */
export type Runner = (task: Task, graph: Graph) => Promise<string>;

export interface RunOptions {
	/**
	 * How many tasks may be in the air at once.
	 *
	 * A number pins it; a function is asked again between tasks, because the
	 * machine changes while somebody is working on it. Left out, it is measured
	 * from this machine — see capacity.ts. Whatever it returns, a task over the
	 * limit waits in the journal as `ready`; it is never refused, because a
	 * refusal that reaches nobody is how five of six jobs disappeared.
	 */
	concurrency?: number | (() => number | Promise<number>);
	/** Where a shell criterion runs, unless it names its own cwd. */
	cwd?: string;
	/** How the row/command criteria see the running rlm. */
	probe?: Probe;
	/** Retry policy — see lapse.ts. Small on purpose. */
	maxAttempts?: number;
	/**
	 * Whether anything is able to write a replacement criterion.
	 *
	 * Handing a task back is only progress if something picks it up. With no
	 * planner it just trades a precise dead end — "it failed the same way three
	 * times" — for a vague one, and loses the distinction between a check that
	 * never moved and a request nobody ever judged. Those need different
	 * answers from him, so they must not collapse into each other.
	 */
	replanCriterion?: boolean;
	/**
	 * me-2. Runs on work the criterion has already accepted.
	 *
	 * A criterion answers "did the thing happen". It cannot answer "is this
	 * redundant with what already exists", "is it wired such that anything
	 * reaches it", or "is it what he actually asked for" — and every defect
	 * that cost a night this week passed its criterion and failed one of those.
	 */
	reviewer?: { review(task: Task, graph: Graph): Promise<{ verdict: "accepted" | "rejected"; reason: string }> };
	/**
	 * Who is running the work, recorded on every attempt.
	 *
	 * Defaults to "unnamed", never to a guess. A journal that says "rlm" when
	 * a Claude subagent did the work is worse than one that admits it does not
	 * know — the whole reason this field exists is to be able to tell.
	 */
	executor?: string;
	repeatFloor?: number;
	similarity?: number;
	/** Called on every transition, for logging and for the event bus. */
	onEvent?: (event: string, data: Record<string, unknown>) => void;
	/** Stop early. Whatever was journalled stays journalled. */
	signal?: AbortSignal;
	/**
	 * One budget shared with everything else running.
	 *
	 * `concurrency` caps this graph; a machine working several graphs at once
	 * needs a cap across all of them, or three graphs of two tasks each is six
	 * agents on a laptop that measured room for two. The drive passes one gate
	 * to every graph it works; on its own, a graph does not need one.
	 */
	gate?: { take(): Promise<() => void> };
	/**
	 * Refuse a task before it is handed to anybody. Return a sentence and the
	 * task is left alone, still owed, with that sentence on it — never quietly
	 * dropped. This is where a fence plugs in.
	 */
	fence?: (task: Task, graph: Graph) => string | null | undefined;
}

/**
 * The prompt a retry actually gets, and why it is not the last one.
 *
 * Never the same text a second time, and — the part that matters — never the
 * same text with the error stapled on either. Which carrier of the guidance
 * failed decides what changes: a criterion that refused work the agent thought
 * it had finished is a different problem from a command that was not there, and
 * "here is the error, try again" is the right answer to neither.
 *
 * See `diagnose` in lapse.ts. The failure text is always included as well, at
 * the bottom, because a directive with no evidence under it is just an opinion.
 */
export const nextAttempt = (task: Task, options: { similarity?: number } = {}): {
	prompt: string;
	diagnosis: Diagnosis | null;
} => {
	const lastFailure = [...task.attempts].reverse().find((a) => !a.ok);
	if (!lastFailure) return { prompt: task.prompt, diagnosis: null };

	const earlier = task.attempts.filter((a) => a !== lastFailure);
	const diagnosis = diagnose(earlier, lastFailure.detail, options);
	return {
		prompt: [
			task.prompt,
			"",
			`## This is attempt ${task.attempts.length + 1}. The last one failed, and this is what has to be different.`,
			"",
			diagnosis.sentence.charAt(0).toUpperCase() + diagnosis.sentence.slice(1) + ".",
			"",
			...diagnosis.directive,
			"",
			"How the last attempt ended, verbatim:",
			"",
			lastFailure.detail.split("\n").slice(0, 20).join("\n").trim(),
		].join("\n"),
		diagnosis,
	};
};

/** Kept for callers that only want the text. */
export const effectivePrompt = (task: Task): string => nextAttempt(task).prompt;

export const run = async (
	store: Store,
	graphId: string,
	runner: Runner,
	options: RunOptions = {},
): Promise<Graph> => {
	const say = options.onEvent ?? (() => {});
	const limitNow = async (): Promise<number> => {
		const asked = options.concurrency;
		if (typeof asked === "number") return Math.max(1, asked);
		if (typeof asked === "function") return Math.max(1, Math.floor((await asked()) || 1));
		return measure().limit;
	};
	let announced = -1;
	const inFlight = new Map<string, Promise<void>>();
	/** Refused by the fence this run. Still owed; simply not touched by us. */
	const fenced = new Map<string, string>();

	const load = (): Graph => {
		const graph = store.load(graphId, { recoverRunning: false });
		if (!graph) throw new Error(`no such graph: ${graphId}`);
		return graph;
	};

	/**
	 * A task that is only the sum of its parts is not handed to anybody.
	 *
	 * By the time a rollup is `ready` every task it was broken into is done, so
	 * there is nothing left to do and nobody to ask. Spawning an agent to
	 * discover that would cost a model call to learn something the edges
	 * already say.
	 */
	const closeRollup = (task: Task): void => {
		const at = new Date().toISOString();
		store.ended(graphId, task.id, "done", {
			at,
			endedAt: at,
			ok: true,
			detail: "everything it was broken into is done",
			proof: "passed",
			proofDetail: "everything it was broken into is done",
		}, { result: "everything it was broken into is done" });
		say("rlm/delegate-done", { graph: graphId, task: task.id, proof: "rollup" });
	};

	const attempt = async (task: Task, graph: Graph): Promise<void> => {
		const at = new Date().toISOString();
		const { prompt, diagnosis } = nextAttempt(task, { similarity: options.similarity });
		store.began(graphId, task.id, at);
		say("rlm/delegate-began", {
			graph: graphId,
			task: task.id,
			title: task.title,
			at,
			attempt: task.attempts.length + 1,
			approach: diagnosis?.cause,
		});

		let ok = false;
		let detail = "";
		const release = options.gate ? await options.gate.take() : () => {};
		try {
			if (options.signal?.aborted) throw new Error("stopped before this attempt started");
			detail = await runner({ ...task, prompt }, graph);
			ok = true;
		} catch (error: any) {
			detail = String(error?.stack ?? error?.message ?? error);
		} finally {
			release();
		}

		// Coming back is not finishing.
		let record: Attempt = { at, endedAt: new Date().toISOString(), ok, detail, approach: diagnosis?.cause, executor: options.executor ?? "unnamed" };
		if (ok) {
			const verdict = await check(task.proof, { cwd: options.cwd, probe: options.probe, needsAllDone: true });
			record = { ...record, proof: verdict.verdict as Attempt["proof"], proofDetail: verdict.detail };

			// A criterion nobody ever wrote is its own outcome. Calling it a
			// failure would cry wolf on every request that arrived before a model
			// had looked at it; calling it done is the original lie.
			if (verdict.verdict === "unstated") {
				store.ended(graphId, task.id, "unproven", record, {
					result: detail,
					reason: `it came back, and ${verdict.detail}`,
				});
				say("rlm/delegate-unproven", { graph: graphId, task: task.id, title: task.title });
				return;
			}

			// A criterion that could not be RUN is a different thing from one that
			// ran and said no. Blaming the agent for a blind checker spends the
			// whole attempt budget on work that may well already be finished, and
			// the next attempt cannot possibly change it — nothing an agent does
			// makes this process able to see a registry it is not connected to.
			// So it stops here, with the question pointed at the criterion.
			if (verdict.verdict === "errored") {
				detail = `the criterion could not be checked — ${verdict.detail}`;
				record = { ...record, ok: false, detail, shape: shapeOf(detail) };
				store.ended(graphId, task.id, "failed", record, {
					reason:
						`no attempt can settle this: ${verdict.detail}. The work may well be done; nothing here ` +
						`can tell. Give it a criterion this process can run, with answer().`,
				});
				say("rlm/delegate-asked", {
					graph: graphId,
					task: task.id,
					title: task.title,
					why: "the criterion cannot be checked from here",
					detail: verdict.detail,
				});
				return;
			}

			// A criterion that fails byte-identically to how it failed before any
			// of the work existed has been shown, not guessed, to be independent
			// of the work. Charging that to the agent is how a broken check turns
			// into a failed task and a cascade of unreachable ones behind it —
			// `agent-browser … search …` has no `search` subcommand, so no amount
			// of runway data was ever going to move it. Stop here and ask about
			// the criterion, exactly as when it could not be run at all.
			if (
				verdict.verdict === "failed" &&
				task.proof?.kind === "shell" &&
				task.proof.inertIf &&
				verdict.detail === task.proof.inertIf &&
				options.replanCriterion
			) {
				detail = `the criterion cannot tell whether this was done — ${verdict.detail}`;
				record = { ...record, ok: false, detail, shape: shapeOf(detail) };
				store.ended(graphId, task.id, "failed", record, {
					reason:
						`this check failed in exactly the same way before anybody started, so it is not ` +
						`measuring the work: ${verdict.detail}. The work may well be done. Replace the ` +
						`criterion with one whose answer can depend on it, using answer().`,
				});
				say("rlm/delegate-asked", {
					graph: graphId,
					task: task.id,
					title: task.title,
					why: "the criterion is inert — it fails the same with and without the work",
					detail: verdict.detail,
				});
				// And then hand it back rather than leaving it stopped. A question
				// nobody is awake to answer is still a task nobody finished, and
				// what is wrong here is knowable without him: the check does not
				// measure the work. Clearing it to `unstated` puts the task back in
				// the pool for the planner to give it a criterion that can move.
				// This cannot loosen anything — a replacement that already passes
				// is refused as vacuous, and one that still cannot move is refused
				// again as inert. The two guards close on each other.
				try {
					store.answered(graphId, task.id, { kind: "unstated" }, "the drive, because the criterion was inert");
				} catch (error: any) {
					say("rlm/delegate-graph-error", { graph: graphId, task: task.id, error: String(error?.message ?? error) });
				}
				return;
			}

			if (verdict.verdict !== "passed") {
				ok = false;
				detail = `it reported done, but the criterion did not hold — ${verdict.detail}`;
				record = { ...record, ok: false, detail };
			}
		}

		if (ok) {
			// The criterion passed. That is necessary and has repeatedly not been
			// sufficient, so me-2 looks before it is called done.
			let reviewed = "";
			if (options.reviewer) {
				const seen = await options.reviewer
					.review(task, load())
					.catch((error: any) => ({ verdict: "rejected" as const, reason: `me-2 threw: ${error?.message ?? error}` }));
				if (seen.verdict === "rejected") {
					// A rejection is a failed attempt, and it is spent like one.
					//
					// It goes back in the pool carrying what the reviewer said, so the
					// next attempt is told exactly what — but through `judge()`, the
					// same bound every other failure passes through, and not for
					// tidiness. A reviewer that rejects everything — a model that will
					// not answer, one that cannot be reached, one that has simply
					// decided — returns the task straight to `ready`, and the loop
					// below picks it up again in the same breath: an agent spawned
					// forever against work that is already finished, all night, with
					// the drive reporting itself busy the whole time. Nothing else
					// bounded this, because the criterion keeps passing and the
					// exhaustion checks further down are never reached from here.
					//
					// Routed through `judge()` the attempt is spent: an identical
					// rejection twice hits `repeatFloor`, a varied one still hits
					// `maxAttempts`, and the task stops instead of the drive.
					const why = `me-2 rejected it: ${seen.reason}`;
					record = { ...record, ok: false, detail: why, shape: shapeOf(why) };
					const bound = judge(task.attempts, why, {
						maxAttempts: options.maxAttempts,
						floor: options.repeatFloor,
						similarity: options.similarity,
					});
					say("rlm/delegate-rejected", {
						graph: graphId,
						task: task.id,
						why: seen.reason.slice(0, 400),
						retrying: bound.retry,
					});
					if (bound.retry) {
						store.ended(graphId, task.id, "ready", record, { reason: why });
						return;
					}
					// Out of attempts, and it lands in `rejected` rather than
					// `failed` — the state this package has had all along for work a
					// reviewer would not pass, and not a synonym for it.
					//
					// `failed` would be actively wrong here, and not as a matter of
					// vocabulary: the drive re-checks every `failed` task's criterion
					// at the top of each sweep and marks it done the moment it
					// passes. This criterion never stopped passing — that is why me-2
					// was asked at all — so a rejection parked in `failed` is undone
					// by the very next sweep, and the reviewer becomes a thing that
					// prints an objection and changes nothing. Observed, not
					// theorised: the first run of this went `failed`, then `done`,
					// one sweep later, with no agent touching it.
					store.ended(graphId, task.id, "failed", record, { reason: `${bound.why}\n${why}`.trim() });
					store.reviewed(graphId, task.id, {
						by: "me-2",
						at: new Date().toISOString(),
						verdict: "rejected",
						reason: `${seen.reason}\n\n(${bound.why})`.trim(),
					});
					say("rlm/delegate-failed", { graph: graphId, task: task.id, repeats: bound.repeats, reason: bound.why });
					say("rlm/delegate-asked", {
						graph: graphId,
						task: task.id,
						title: task.title,
						why: `me-2 kept rejecting it — ${bound.why}`,
						detail: seen.reason.slice(0, 400),
					});
					return;
				}
				reviewed = seen.reason || "(accepted with no reason given)";
				say("rlm/delegate-reviewed", { graph: graphId, task: task.id, by: "me-2", reason: seen.reason.slice(0, 400) });
			}
			store.ended(graphId, task.id, "done", record, { result: detail });
			// An acceptance is written down too, and not only the refusals.
			//
			// Without this the only durable evidence me-2 ever ran is the absence
			// of a rejection, which is not evidence of anything — and tomorrow the
			// question "was this reviewed, and what did it say?" has the same
			// answer for work me-2 passed and for work it never saw. `forReview()`
			// and `rlm tasks` read `task.review`, so this is also what makes the
			// verdict something he can go and look at rather than something a log
			// line claimed at the time.
			if (options.reviewer && reviewed) {
				store.reviewed(graphId, task.id, { by: "me-2", at: new Date().toISOString(), verdict: "accepted", reason: reviewed });
			}
			say("rlm/delegate-done", { graph: graphId, task: task.id, proof: record.proofDetail });
			return;
		}

		record = { ...record, shape: shapeOf(detail) };
		const verdict = judge(task.attempts, detail, {
			maxAttempts: options.maxAttempts,
			floor: options.repeatFloor,
			similarity: options.similarity,
		});

		// A wall is not a failure of the work.
		//
		// Twenty-four delegations were recorded as the agent failing when the
		// entire output was "You have run out of credits for <his account>".
		// `build-me-2-reviewer` is one of them: it burned its attempts, went
		// `unproven`, and took the tasks behind it down — for a fault nothing on
		// this machine could have fixed.
		//
		// So it spends no attempt and becomes no shape to diagnose. Straight back
		// in the pool, and said loudly, because this is exactly the kind of stop
		// that is invisible until morning.
		if (!ok && wall(detail)) {
			store.ended(graphId, task.id, "ready", { ...record, ok: false, detail, shape: "blocked on a resource" }, {
				reason: `not this task's fault — ${detail.split("\n")[0].slice(0, 200)}`,
			});
			say("rlm/delegate-blocked", {
				graph: graphId,
				task: task.id,
				title: task.title,
				why: "a provider refused the work — credits, quota, or rate limit",
				detail: detail.slice(0, 300),
			});
			return;
		}

		if (verdict.retry) {
			store.ended(graphId, task.id, "ready", record, { reason: `${verdict.why}: ${record.shape}` });
			say("rlm/delegate-retry", { graph: graphId, task: task.id, repeats: verdict.repeats, why: verdict.why });
		} else if (
			// Exhausted against a shell criterion that has never once moved. The
			// attempts all failed the same way, which is as much evidence about
			// the check as about the work — and unlike the inert case there is no
			// baseline to settle it either way, because these criteria predate
			// baselines being recorded.
			//
			// Giving up here is what put four `agent-browser … search …` tasks in
			// `failed` and twenty-three behind them in `unreachable`. So the
			// criterion is re-planned exactly once instead. Bounded by the attempt
			// count, which keeps accumulating across both criteria: a second
			// exhaustion stops for real. Nothing can be weakened by this — the
			// replacement is refused if it already passes, and refused again if it
			// cannot move.
			options.replanCriterion &&
			task.proof?.kind === "shell" &&
			task.attempts.length < 2 * (options.maxAttempts ?? 3)
		) {
			store.ended(graphId, task.id, "failed", record, { reason: `${verdict.why}\n${detail}`.trim() });
			say("rlm/delegate-failed", { graph: graphId, task: task.id, repeats: verdict.repeats, reason: verdict.why });
			try {
				store.answered(graphId, task.id, { kind: "unstated" }, "the drive, because every attempt failed the same way against this check");
				say("rlm/delegate-asked", {
					graph: graphId,
					task: task.id,
					title: task.title,
					why: "exhausted against a check that never moved — asking for a different one",
					detail: record.shape,
				});
			} catch (error: any) {
				say("rlm/delegate-graph-error", { graph: graphId, task: task.id, error: String(error?.message ?? error) });
			}
		} else {
			store.ended(graphId, task.id, "failed", record, { reason: `${verdict.why}\n${detail}`.trim() });
			say("rlm/delegate-failed", { graph: graphId, task: task.id, repeats: verdict.repeats, reason: verdict.why });
			say("rlm/delegate-asked", {
				graph: graphId,
				task: task.id,
				title: task.title,
				why: verdict.why,
				detail: record.shape,
			});
		}
	};

	// Anything a previous run died holding comes back into the pool first. This
	// is the moment the crashed graph stops being a museum piece.
	const stranded = store.recover(graphId);
	if (stranded.length) say("rlm/delegate-recovered", { graph: graphId, tasks: stranded });

	for (;;) {
		if (options.signal?.aborted) break;

		const graph = load();
		const ready = runnable(graph.tasks).filter((t) => !inFlight.has(t.id) && !fenced.has(t.id));
		const concurrency = await limitNow();
		if (concurrency !== announced) {
			announced = concurrency;
			say("rlm/delegate-capacity", { graph: graphId, limit: concurrency, waiting: Math.max(0, ready.length - concurrency) });
		}

		// Rollups first and for free: they cost nothing and unblock real work.
		const rollups = ready.filter((t) => t.proof.kind === "rollup");
		if (rollups.length) {
			for (const task of rollups) closeRollup(task);
			continue;
		}

		while (ready.length && inFlight.size < concurrency) {
			const task = ready.shift()!;
			const refusal = options.fence?.(task, graph);
			if (refusal) {
				// Left alone, still `ready`, with the refusal on it. A fence that
				// makes work disappear is the same bug as no queue at all.
				fenced.set(task.id, refusal);
				say("rlm/delegate-fenced", { graph: graphId, task: task.id, refusal });
				continue;
			}
			const promise = attempt(task, graph).finally(() => inFlight.delete(task.id));
			inFlight.set(task.id, promise);
		}

		if (!inFlight.size) break; // nothing running and nothing runnable: this is as far as it goes
		// Anything still in `ready` is queued, not dropped — it is on disk, and
		// the next pass picks it up the moment something finishes.
		await Promise.race(inFlight.values());
	}

	const final = load();
	const graph = { ...final, tasks: settle(final.tasks) };
	const left = graph.tasks.filter((t) => t.state !== "done");
	say("rlm/delegate-settled", {
		graph: graphId,
		done: graph.tasks.length - left.length,
		total: graph.tasks.length,
		unreachable: graph.tasks.filter((t) => t.state === "unreachable").map((t) => t.id),
		failed: graph.tasks.filter((t) => t.state === "failed").map((t) => t.id),
	});
	return graph;
};
