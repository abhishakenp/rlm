/**
 * Where the tasks live — an append-only journal, one file per graph.
 *
 * This is the part that makes forgetting impossible, so it is deliberately the
 * dullest thing in the package: every change is one line appended to a file,
 * and the state is a fold over those lines. Nothing is held only in memory,
 * nothing is rewritten in place, and a process that dies halfway through a
 * graph loses at most the line it was writing. On the way back up the fold
 * reads what is there, a torn last line is dropped, and the rest of the work is
 * still owed.
 *
 * It lives in rlm's own state directory rather than the working directory,
 * because the delegator is routinely run inside a throwaway temp dir — a graph
 * kept next to the work would be deleted along with it, which is the same bug
 * wearing a different hat.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	declare,
	findCycle,
	owed,
	settle,
	type Attempt,
	type Graph,
	type Review,
	type Task,
	type TaskInput,
	type TaskState,
} from "./graph.ts";
import { CycleError, unanswerable, validateProof } from "./graph.ts";

type Entry =
	| { k: "declared"; at: string; goal: string; tasks: TaskInput[] }
	| { k: "added"; at: string; tasks: TaskInput[] }
	| { k: "began"; at: string; id: string }
	| { k: "ended"; at: string; id: string; state: TaskState; attempt: Attempt; result?: string; reason?: string }
	| { k: "reviewed"; at: string; id: string; review: Review }
	| { k: "recovered"; at: string; id: string; why: string }
	| { k: "refined"; at: string; id: string; tasks: TaskInput[] }
	| { k: "answered"; at: string; id: string; proof: Task["proof"]; by: string }
	| { k: "prioritised"; at: string; id: string; priority: number; by: string };

/** `~/.rlm/agent/delegate`, honouring $RLM_HOME the way the rest of rlm does. */
export const defaultDir = (): string =>
	join(process.env.RLM_HOME || join(homedir(), ".rlm"), "agent", "delegate");

export const mintId = (now = new Date()): string => {
	const stamp = now.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
	return `g-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
};

export class Store {
	readonly dir: string;

	constructor(dir: string = defaultDir()) {
		this.dir = dir;
		if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
	}

	private path(graphId: string): string {
		if (!/^[A-Za-z0-9._-]+$/.test(graphId)) throw new Error(`bad graph id: ${graphId}`);
		return join(this.dir, `${graphId}.jsonl`);
	}

	/** Files this instance has already checked for a torn tail. */
	private healed = new Set<string>();

	/**
	 * One line, appended.
	 *
	 * A crash can leave a line without its newline. The next append would then
	 * run onto the end of it and take a second entry down with the first, which
	 * turns one lost attempt into two — so before this process writes to a
	 * journal for the first time, it closes any half-written line it finds.
	 */
	private append(graphId: string, entry: Entry): void {
		const file = this.path(graphId);
		if (!this.healed.has(file)) {
			this.healed.add(file);
			try {
				const size = statSync(file).size;
				if (size > 0) {
					const tail = readFileSync(file, "utf8").slice(-1);
					if (tail !== "\n") appendFileSync(file, "\n", "utf8");
				}
			} catch {
				/* the file does not exist yet, which is the normal case */
			}
		}
		appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
	}

	/** Every graph id on disk, newest first. */
	ids(): string[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.slice(0, -6))
			.sort()
			.reverse();
	}

	/**
	 * Rebuild a graph from its journal.
	 *
	 * A line that will not parse is skipped rather than fatal: the only line
	 * that can be malformed is the one a crash interrupted, and losing the rest
	 * of the graph over it would be the original bug all over again.
	 */
	load(graphId: string, options: { recoverRunning?: boolean } = {}): Graph | null {
		const file = this.path(graphId);
		if (!existsSync(file)) return null;

		const entries: Entry[] = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				/* a torn tail; everything before it still counts */
			}
		}

		const first = entries.find((e) => e.k === "declared") as Extract<Entry, { k: "declared" }> | undefined;
		if (!first) return null;

		let graph = declare(graphId, first.goal, first.tasks, first.at);

		for (const entry of entries) {
			switch (entry.k) {
				case "declared":
					break;
				case "added":
					graph = declare(graphId, graph.goal, entry.tasks, entry.at, graph.tasks);
					break;
				case "began": {
					const task = graph.tasks.find((t) => t.id === entry.id);
					if (task) {
						task.state = "running";
						task.updatedAt = entry.at;
					}
					break;
				}
				case "ended": {
					const task = graph.tasks.find((t) => t.id === entry.id);
					if (task) {
						task.attempts = [...task.attempts, entry.attempt];
						task.state = entry.state;
						task.result = entry.result ?? task.result;
						task.reason = entry.reason;
						task.updatedAt = entry.at;
					}
					break;
				}
				case "prioritised": {
					const task = graph.tasks.find((t) => t.id === entry.id);
					if (!task) break;
					// Ordering only. It cannot start a task, unstick one, or change
					// what is true about it — a priority that could do any of those
					// would be a way to get work marked done by wanting it more.
					task.priority = entry.priority;
					task.updatedAt = entry.at;
					break;
				}
				case "answered": {
					const task = graph.tasks.find((t) => t.id === entry.id);
					if (!task) break;
					task.proof = entry.proof;
					// Somebody has now said how to tell. The task goes back into the
					// pool so something tries again against the real criterion —
					// an answered question that nothing acts on is still a task
					// nobody finished.
					if (task.state !== "done" && task.state !== "running") {
						task.state = "blocked";
						task.reason = `${entry.by} said how to tell, on ${entry.at.slice(0, 10)}`;
					}
					task.updatedAt = entry.at;
					break;
				}
				case "refined": {
					const parent = graph.tasks.find((t) => t.id === entry.id);
					if (!parent) break;
					graph = declare(graphId, graph.goal, entry.tasks, entry.at, graph.tasks);
					const reopened = graph.tasks.find((t) => t.id === entry.id)!;
					reopened.needs = [...reopened.needs, ...entry.tasks.map((t) => t.id)];
					// It is no longer a thing anybody does; it is the sum of the
					// things somebody does. And it stops being unproven, because
					// there is now something to prove.
					reopened.proof = { kind: "rollup" };
					reopened.state = "blocked";
					reopened.reason = undefined;
					reopened.updatedAt = entry.at;
					break;
				}
				case "recovered": {
					const task = graph.tasks.find((t) => t.id === entry.id);
					if (task) {
						task.state = "ready";
						task.reason = entry.why;
						task.updatedAt = entry.at;
					}
					break;
				}
				case "reviewed": {
					const task = graph.tasks.find((t) => t.id === entry.id);
					if (task) {
						task.review = entry.review;
						if (entry.review.verdict === "rejected") {
							task.state = "rejected";
							task.reason = `rejected on review by ${entry.review.by}: ${entry.review.reason}`;
						} else if (task.state === "rejected") {
							task.state = "done";
							task.reason = undefined;
						}
						task.updatedAt = entry.at;
					}
					break;
				}
			}
		}

		// A task left `running` by a crash was never finished. It goes back into
		// the pool rather than sitting forever in a state only a live process
		// could leave — that is precisely how work disappears. A scheduler that
		// is mid-run passes `recoverRunning: false`, because there the running
		// tasks belong to somebody who is still holding them.
		for (const task of graph.tasks) {
			if (task.state === "running" && options.recoverRunning !== false) {
				task.state = "ready";
				task.reason = "picked up by a run that died before it came back";
			}
		}

		return { ...graph, tasks: settle(graph.tasks) };
	}

	/** Declare a new graph. Throws before writing anything if it is malformed. */
	create(goal: string, tasks: TaskInput[], graphId = mintId()): Graph {
		const at = new Date().toISOString();
		const graph = declare(graphId, goal, tasks, at); // refuses first
		this.append(graphId, { k: "declared", at, goal, tasks });
		return graph;
	}

	/** Add tasks to a graph that already exists, refusing a cycle across both. */
	add(graphId: string, tasks: TaskInput[]): Graph {
		const existing = this.load(graphId);
		if (!existing) throw new Error(`no such graph: ${graphId}`);
		const at = new Date().toISOString();
		const graph = declare(graphId, existing.goal, tasks, at, existing.tasks); // refuses first
		this.append(graphId, { k: "added", at, tasks });
		return graph;
	}

	/**
	 * Break one task into the tasks that actually do the work.
	 *
	 * This is the seam between the mechanical floor and the useful version. The
	 * boundary writes down one task with no criterion because that needs no
	 * model and cannot fail; a model that reads it can turn it into several with
	 * real criteria and real edges. If none ever does, the floor still holds —
	 * the request is on disk either way.
	 *
	 * Refused, before writing, if the children would close a loop.
	 */
	refine(graphId: string, taskId: string, tasks: TaskInput[]): Graph {
		const existing = this.load(graphId);
		if (!existing) throw new Error(`no such graph: ${graphId}`);
		const parent = existing.tasks.find((t) => t.id === taskId);
		if (!parent) throw new Error(`no such task: ${graphId}/${taskId}`);

		const at = new Date().toISOString();
		// Validate the children on their own first — ids, titles, criteria.
		declare(graphId, existing.goal, tasks, at, existing.tasks);
		// Then the edge the refinement itself adds, which the line above cannot
		// see: the parent comes to depend on every child.
		const proposed = [
			...existing.tasks.map((t) => ({
				id: t.id,
				needs: t.id === taskId ? [...t.needs, ...tasks.map((c) => c.id)] : t.needs,
			})),
			...tasks.map((t) => ({ id: t.id, needs: t.needs ?? [] })),
		];
		const cycle = findCycle(proposed);
		if (cycle) throw new CycleError(cycle);

		this.append(graphId, { k: "refined", at, id: taskId, tasks });
		return this.load(graphId)!;
	}

	/**
	 * Record the answer to "how will we know this is done?".
	 *
	 * The criterion is replaced and the task goes back into the pool, because
	 * being told how to check something is only worth anything if something then
	 * checks it.
	 */
	answered(graphId: string, id: string, proof: Task["proof"], by = "a person"): Graph {
		const existing = this.load(graphId);
		if (!existing?.tasks.some((t) => t.id === id)) throw new Error(`no such task: ${graphId}/${id}`);
		validateProof(proof, id);
		this.append(graphId, { k: "answered", at: new Date().toISOString(), id, proof, by });
		return this.load(graphId)!;
	}

	/** Move a task up or down the queue. Ordering only; nothing else changes. */
	prioritised(graphId: string, id: string, priority: number, by = "a person"): Graph {
		const existing = this.load(graphId);
		if (!existing?.tasks.some((t) => t.id === id)) throw new Error(`no such task: ${graphId}/${id}`);
		this.append(graphId, { k: "prioritised", at: new Date().toISOString(), id, priority, by });
		return this.load(graphId)!;
	}

	began(graphId: string, id: string, at = new Date().toISOString()): void {
		this.append(graphId, { k: "began", at, id });
	}

	ended(
		graphId: string,
		id: string,
		state: TaskState,
		attempt: Attempt,
		extra: { result?: string; reason?: string } = {},
		at = new Date().toISOString(),
	): void {
		this.append(graphId, { k: "ended", at, id, state, attempt, ...extra });
	}

	reviewed(graphId: string, id: string, review: Review, at = new Date().toISOString()): void {
		this.append(graphId, { k: "reviewed", at, id, review });
	}

	/**
	 * Put back anything a dead process was holding.
	 *
	 * `load` already shows such a task as runnable, but showing is not enough:
	 * a scheduler reading the graph mid-run deliberately does not touch other
	 * people's running tasks, so without this the work a crash was holding
	 * would be visible and still never picked up. Writing the recovery down
	 * makes it a fact about the graph rather than a rendering of it.
	 */
	recover(graphId: string): string[] {
		const graph = this.load(graphId, { recoverRunning: false });
		if (!graph) return [];
		const stranded = graph.tasks.filter((t) => t.state === "running").map((t) => t.id);
		const at = new Date().toISOString();
		for (const id of stranded) {
			this.append(graphId, { k: "recovered", at, id, why: "picked up by a run that died before it came back" });
		}
		return stranded;
	}

	/**
	 * Every graph that still owes something.
	 *
	 * `unproven` does not count as owed. Nothing more is going to happen to it
	 * on its own, and a request that arrived, ran, and had no criterion would
	 * otherwise sit in front of the model for ever and drown the live work. It
	 * is still on disk and still readable through `unverified()`.
	 */
	open(): Graph[] {
		const out: Graph[] = [];
		for (const id of this.ids()) {
			const graph = this.load(id);
			if (graph && owed(graph.tasks).length) out.push(graph);
		}
		return out;
	}

	/**
	 * Every task nobody could work out a criterion for — one question each,
	 * waiting for a person.
	 *
	 * Exposed as data rather than asked here: the asking belongs to whatever is
	 * actually talking to him.
	 */
	questions(): Array<{ graph: string; goal: string; task: Task; question: string }> {
		const out: Array<{ graph: string; goal: string; task: Task; question: string }> = [];
		for (const id of this.ids()) {
			const graph = this.load(id);
			if (!graph) continue;
			for (const task of unanswerable(graph.tasks)) {
				out.push({
					graph: graph.id,
					goal: graph.goal,
					task,
					question:
						`How will we know "${task.title}" is done? Name a command that exits 0, a file that must ` +
						`exist or change, a row that must reach ACTIVE, or a command that must be in the registry.`,
				});
			}
		}
		return out;
	}

	/** Turns that ended with no way to tell whether the work happened. */
	unverified(sinceMs = 24 * 60 * 60 * 1000): Array<{ graph: string; goal: string; task: Task }> {
		const cutoff = Date.now() - sinceMs;
		const out: Array<{ graph: string; goal: string; task: Task }> = [];
		for (const id of this.ids()) {
			const graph = this.load(id);
			if (!graph) continue;
			for (const task of graph.tasks) {
				if (task.state === "unproven" && Date.parse(task.updatedAt) >= cutoff) {
					out.push({ graph: graph.id, goal: graph.goal, task });
				}
			}
		}
		return out;
	}

	/**
	 * Forget the noise, never the wounds.
	 *
	 * A journal whose every task is proven done, and which nothing has touched
	 * in a fortnight, is a receipt. Anything else is evidence and stays whatever
	 * its age — `unproven` included, and `unproven` especially: a turn nobody
	 * could check is the thing to go and look at, not the thing to tidy away.
	 */
	prune(maxAgeMs = 14 * 24 * 60 * 60 * 1000): string[] {
		const cutoff = Date.now() - maxAgeMs;
		const removed: string[] = [];
		for (const id of this.ids()) {
			const graph = this.load(id);
			if (!graph) continue;
			const keep =
				graph.tasks.some((t) => t.state !== "done") ||
				graph.tasks.some((t) => Date.parse(t.updatedAt) >= cutoff);
			if (keep) continue;
			try {
				rmSync(this.path(id));
				removed.push(id);
			} catch {
				/* somebody else may have taken it already */
			}
		}
		return removed;
	}
}

export type { Task, Graph, TaskInput };
