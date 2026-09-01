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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	declare,
	settle,
	type Attempt,
	type Graph,
	type Review,
	type Task,
	type TaskInput,
	type TaskState,
} from "./graph.ts";

type Entry =
	| { k: "declared"; at: string; goal: string; tasks: TaskInput[] }
	| { k: "added"; at: string; tasks: TaskInput[] }
	| { k: "began"; at: string; id: string }
	| { k: "ended"; at: string; id: string; state: TaskState; attempt: Attempt; result?: string; reason?: string }
	| { k: "reviewed"; at: string; id: string; review: Review }
	| { k: "recovered"; at: string; id: string; why: string };

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

	/** Every graph that still owes something. This is the answer to "what is left?". */
	open(): Graph[] {
		const out: Graph[] = [];
		for (const id of this.ids()) {
			const graph = this.load(id);
			if (graph && graph.tasks.some((t) => t.state !== "done")) out.push(graph);
		}
		return out;
	}
}

export type { Task, Graph, TaskInput };
