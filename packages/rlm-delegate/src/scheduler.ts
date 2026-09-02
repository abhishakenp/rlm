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
import { carry, judge, shapeOf } from "./lapse.ts";
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
	repeatFloor?: number;
	similarity?: number;
	/** Called on every transition, for logging and for the event bus. */
	onEvent?: (event: string, data: Record<string, unknown>) => void;
	/** Stop early. Whatever was journalled stays journalled. */
	signal?: AbortSignal;
}

/**
 * The prompt a retry actually gets.
 *
 * Never the same text a second time. If the last attempt failed, how it failed
 * is carried into the task text itself — next to the decision, not up in a
 * system prompt somewhere above it. Handing back an identical prompt is how an
 * agent fails the same way six times.
 */
export const effectivePrompt = (task: Task): string => {
	const lastFailure = [...task.attempts].reverse().find((a) => !a.ok);
	return lastFailure ? carry(task.prompt, lastFailure.detail) : task.prompt;
};

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
		store.began(graphId, task.id, at);
		say("rlm/delegate-began", { graph: graphId, task: task.id, title: task.title, at });

		let ok = false;
		let detail = "";
		try {
			detail = await runner({ ...task, prompt: effectivePrompt(task) }, graph);
			ok = true;
		} catch (error: any) {
			detail = String(error?.stack ?? error?.message ?? error);
		}

		// Coming back is not finishing.
		let record: Attempt = { at, endedAt: new Date().toISOString(), ok, detail };
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

			if (verdict.verdict !== "passed") {
				ok = false;
				detail = `it reported done, but the criterion did not hold — ${verdict.detail}`;
				record = { ...record, ok: false, detail };
			}
		}

		if (ok) {
			store.ended(graphId, task.id, "done", record, { result: detail });
			say("rlm/delegate-done", { graph: graphId, task: task.id, proof: record.proofDetail });
			return;
		}

		record = { ...record, shape: shapeOf(detail) };
		const verdict = judge(task.attempts, detail, {
			maxAttempts: options.maxAttempts,
			floor: options.repeatFloor,
			similarity: options.similarity,
		});

		if (verdict.retry) {
			store.ended(graphId, task.id, "ready", record, { reason: `${verdict.why}: ${record.shape}` });
			say("rlm/delegate-retry", { graph: graphId, task: task.id, repeats: verdict.repeats, why: verdict.why });
		} else {
			store.ended(graphId, task.id, "failed", record, { reason: `${verdict.why}\n${detail}`.trim() });
			say("rlm/delegate-failed", { graph: graphId, task: task.id, repeats: verdict.repeats, reason: verdict.why });
		}
	};

	// Anything a previous run died holding comes back into the pool first. This
	// is the moment the crashed graph stops being a museum piece.
	const stranded = store.recover(graphId);
	if (stranded.length) say("rlm/delegate-recovered", { graph: graphId, tasks: stranded });

	for (;;) {
		if (options.signal?.aborted) break;

		const graph = load();
		const ready = runnable(graph.tasks).filter((t) => !inFlight.has(t.id));
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
