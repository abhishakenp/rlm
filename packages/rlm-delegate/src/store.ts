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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendLine, closeAppend, HOT_APPEND_BYTES, writeAtomic } from "../../rlm-persist/src/durable.ts";
import {
	declare,
	findCycle,
	isFinished,
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

/**
 * How long a graph that ended badly is kept before its journal is reclaimed.
 *
 * A fortnight is the right life for a receipt and the wrong life for evidence,
 * so this is a second, much longer clock rather than a second use of the first.
 * The number matters because without one nothing was ever reclaimed at all:
 * 731 journals were sitting in quarantine, 607 of them graphs that had already
 * reached a terminal outcome that was not `done` — rejected, failed, unproven,
 * unreachable — and `prune` deleted a graph only when every task was proven
 * done, which was 14 of them. A store that keeps 98% of its history for ever is
 * one nobody can read, and an unreadable record is the same as no record.
 *
 * Ninety days, because a wound is worth going back to for about a quarter and
 * the lessons drawn from one (see lessons.ts) outlive the journal anyway.
 */
export const spentTtlMs = (): number =>
	Number(process.env.RLM_DELEGATE_SPENT_TTL_MS) || 90 * 24 * 60 * 60 * 1000;

/**
 * How long a graph may sit with work owed and nothing touching it before the
 * reconciler calls it abandoned.
 *
 * Twelve hours is longer than any single delegated turn and shorter than a
 * night, so a graph that crosses it was not slow — nothing is coming back for
 * it. `recover` already handles the narrower case of a task a dead process was
 * holding; this is the wider one, where the process that would have called
 * `recover` is itself gone.
 */
export const lostAfterMs = (): number =>
	Number(process.env.RLM_DELEGATE_LOST_AFTER_MS) || 12 * 60 * 60 * 1000;

/**
 * One entry, one line. Refused here rather than discovered later.
 *
 * The journal is a fold over lines, and `load` skips a line it cannot parse
 * because the only line that should ever be unparseable is the one a crash
 * interrupted. That tolerance is exactly what makes a multi-line record
 * invisible instead of loud: every line of a pretty-printed object fails to
 * parse on its own, the fold sees nothing, and the graph silently stops
 * existing. Two journals in quarantine are in precisely that state, written by
 * an agent that hand-rolled `JSON.stringify(graph, null, 2)` into the delegate
 * directory instead of going through this class.
 *
 * `JSON.stringify` cannot produce a raw newline on its own — it escapes them
 * inside strings — so this cannot fire for a well-formed `Entry` today. That
 * is the point: it is the guard that makes adding an indent argument, or
 * writing a pre-serialised line, fail at the write instead of at the next read
 * of a graph nobody can see any more.
 */
export const oneLine = (line: string): string => {
	const at = line.search(/[\n\r]/);
	if (at === -1) return line;
	throw new Error(
		`delegate journal: an entry must be one line, and this one breaks at character ${at}: ` +
			`${JSON.stringify(line.slice(0, 120))}`,
	);
};

/** A duration a person can read, for the reasons `reclaimable` gives. */
const days = (ms: number): string => `${Math.floor(ms / (24 * 60 * 60 * 1000))}d`;

const tryParse = (line: string): unknown | undefined => {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
};

/**
 * Split a file into the whole JSON values it is made of, or nothing.
 *
 * `JSON.parse` cannot do this — it demands the whole string be one value — so
 * the values are found by scanning for balanced braces outside of strings.
 * Returning `undefined` on anything left over is the important half: it is
 * what keeps `repair` from inventing a journal out of a file it did not
 * actually understand.
 */
const parseStream = (raw: string): unknown[] | undefined => {
	const out: unknown[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			continue;
		}
		if (c === "{" || c === "[") {
			if (depth === 0) start = i;
			depth++;
			continue;
		}
		if (c === "}" || c === "]") {
			depth--;
			if (depth !== 0) continue;
			const value = tryParse(raw.slice(start, i + 1));
			if (value === undefined) return undefined;
			out.push(value);
			start = -1;
			continue;
		}
		// Anything outside a value that is not whitespace means this file is
		// not the thing we think it is, and it must not be rewritten.
		if (depth === 0 && c.trim()) return undefined;
	}
	if (depth !== 0 || inString) return undefined;
	return out.length ? out : undefined;
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

	/**
	 * One line, appended, through the persistence seam.
	 *
	 * The seam holds one descriptor per journal instead of opening and closing
	 * the file for every entry, and it is what heals a torn tail now: a crash
	 * can leave a line without its newline, and the next append would run onto
	 * the end of it and take a second entry down with the first, turning one
	 * lost attempt into two. That check used to live here and was per-`Store`;
	 * in the seam it is per-descriptor, so it happens once per file per process
	 * however many `Store` instances point at it.
	 *
	 * Still `writeSync` underneath, and that is not an implementation detail:
	 * this journal's whole contract is that a process which dies halfway
	 * through a graph loses at most the line it was writing. A buffered stream
	 * would lose everything still in the buffer, and `load()` re-reading a file
	 * this process had just written would not see its own writes.
	 */
	private append(graphId: string, entry: Entry): void {
		// The 64 KB scratch buffer rather than the 4 KB default: this journal is
		// written on every task transition of every graph, and at that rate the
		// larger buffer halves the per-line cost for sixteen times a buffer.
		appendLine(this.path(graphId), oneLine(JSON.stringify(entry)), HOT_APPEND_BYTES);
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
	 * When the graph was last written to, in epoch milliseconds.
	 *
	 * From the journal, deliberately, and never from `task.updatedAt`. A task's
	 * `updatedAt` is partly derived: `settle` stamps it with the time of the
	 * *load* every time it moves a state, so a graph whose edges are re-derived
	 * on every read looks freshly touched for ever and can never age out of
	 * anything. Three of the abandoned graphs in quarantine report an
	 * `updatedAt` of "now" and have not actually been written to since the 5th.
	 * Only what somebody wrote down can say how old a graph is.
	 *
	 * The file's mtime is the fallback, for a journal whose entries are all
	 * unparseable — there is nothing else left to ask.
	 */
	private touchedAt(graphId: string): number {
		const file = this.path(graphId);
		let newest = 0;
		try {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const at = Date.parse(JSON.parse(line).at);
					if (at > newest) newest = at;
				} catch {
					/* a torn or hand-written line says nothing about the age */
				}
			}
		} catch {
			return 0;
		}
		if (newest) return newest;
		try {
			return statSync(file).mtimeMs;
		} catch {
			return 0;
		}
	}

	/**
	 * Every journal that can be let go of, and the reason it can be.
	 *
	 * Split out from `prune` so a caller can look before it deletes. Deleting
	 * from a store whose whole purpose is that nothing is forgotten is the one
	 * operation here that cannot be undone, and it should be possible to read
	 * the list first.
	 */
	reclaimable(
		maxAgeMs = 14 * 24 * 60 * 60 * 1000,
		spentMs = spentTtlMs(),
	): Array<{ id: string; kind: "receipt" | "spent"; why: string }> {
		const now = Date.now();
		const out: Array<{ id: string; kind: "receipt" | "spent"; why: string }> = [];
		for (const id of this.ids()) {
			const graph = this.load(id);
			// A journal nothing can be folded out of is kept, always. 104 of the
			// 731 in quarantine are like this — entries with no `declared` to
			// fold them onto — and not one of them can say what its outcome was.
			// A deletion has to be justified by a terminal state the graph
			// itself recorded, and an unreadable journal has recorded none.
			if (!graph || !graph.tasks.length) continue;
			const age = now - this.touchedAt(id);
			if (graph.tasks.every((t) => t.state === "done")) {
				if (age >= maxAgeMs) out.push({ id, kind: "receipt", why: `every task proven done, untouched for ${days(age)}` });
				continue;
			}
			// Terminal-but-not-done: every task has reached an outcome nothing
			// will move again on its own — `failed`, `rejected`, `unproven`,
			// `unreachable`. `isFinished` is the graph's own definition of that,
			// borrowed rather than restated so the two cannot drift apart.
			if (!isFinished(graph.tasks)) continue;
			if (age < spentMs) continue;
			const states = [...new Set(graph.tasks.filter((t) => t.state !== "done").map((t) => t.state))].sort();
			out.push({ id, kind: "spent", why: `ended ${states.join(", ")}, untouched for ${days(age)}` });
		}
		return out;
	}

	/**
	 * Forget the noise, never the wounds — but stop keeping the noise for ever.
	 *
	 * A journal whose every task is proven done, and which nothing has touched
	 * in a fortnight, is a receipt. A journal that reached an outcome and the
	 * outcome was bad is evidence, and evidence is kept far longer — but not
	 * without end, which is what it used to be. `prune` deleted only receipts,
	 * a graph reached one 2% of the time, and 607 spent graphs had accumulated
	 * in quarantine with no way out of it. Kept for ever and kept where nobody
	 * looks are the same thing.
	 *
	 * The two clocks are separate on purpose, so raising the life of evidence
	 * cannot shorten the life of anything and `prune(0)` still means "receipts
	 * only". Anything still owing work is kept whatever its age; that is
	 * unchanged, and `reconcile` is what turns a graph nobody is coming back
	 * for into something with a recorded outcome rather than deleting it here.
	 *
	 * `dryRun` returns exactly what a real run would remove, without removing
	 * it. Use `reclaimable` for the reasons.
	 */
	prune(
		maxAgeMs = 14 * 24 * 60 * 60 * 1000,
		spentMs = spentTtlMs(),
		options: { dryRun?: boolean } = {},
	): string[] {
		const removed: string[] = [];
		for (const { id } of this.reclaimable(maxAgeMs, spentMs)) {
			if (options.dryRun) {
				removed.push(id);
				continue;
			}
			try {
				// Let go of the descriptor first. A held fd follows the inode, so
				// an append after the unlink would succeed, write into an orphan
				// nothing can open, and report no error at all.
				closeAppend(this.path(id));
				rmSync(this.path(id));
				removed.push(id);
			} catch {
				/* somebody else may have taken it already */
			}
		}
		return removed;
	}

	/**
	 * Close the graphs nobody is coming back for, out loud.
	 *
	 * These are the ones that are neither finished nor alive: a graph left at
	 * `began` or `refined` with no terminal event and nothing written to it
	 * since. Nine of them were sitting in quarantine, invisible in both
	 * directions — not owed, because quarantine is where the sweep stops
	 * looking, and not prunable either, because a task that never ended is not
	 * a terminal state. A record that is neither acted on nor readable is the
	 * failure this package exists to prevent, so it is resolved rather than
	 * left: every task that has not reached an outcome gets an `ended` entry
	 * saying it was abandoned and when it was last touched.
	 *
	 * `failed` and not `unreachable`, and that is not a judgement call:
	 * `unreachable` is derived by `settle` from the state of what a task needs,
	 * so a task marked unreachable whose dependencies are intact would be moved
	 * straight back to `ready` by the next load and the mark would not stick.
	 * `failed` is one of the states `settle` will not recompute, because
	 * something happened to it. Something did: it was given up on, and the
	 * journal now says so.
	 *
	 * This is the wider sibling of `recover`, which puts back what a dead
	 * process was holding. `recover` needs somebody alive to call it; this is
	 * for the graphs where nobody was.
	 */
	reconcile(
		staleMs = lostAfterMs(),
		options: { dryRun?: boolean } = {},
	): Array<{ graph: string; tasks: string[]; since: string }> {
		const cutoff = Date.now() - staleMs;
		const out: Array<{ graph: string; tasks: string[]; since: string }> = [];
		for (const id of this.ids()) {
			const graph = this.load(id);
			if (!graph || isFinished(graph.tasks)) continue;
			const touched = this.touchedAt(id);
			if (!touched || touched >= cutoff) continue;
			const since = new Date(touched).toISOString();
			const stranded = graph.tasks.filter((t) => t.state !== "done" && !isFinished([t]));
			if (!stranded.length) continue;
			out.push({ graph: id, tasks: stranded.map((t) => t.id), since });
			if (options.dryRun) continue;
			const at = new Date().toISOString();
			const why = `abandoned: nothing has touched this graph since ${since}`;
			for (const task of stranded) {
				this.append(id, {
					k: "ended",
					at,
					id: task.id,
					state: "failed",
					attempt: {
						// The last thing written to the journal is the last moment
						// anybody can prove the work was still in hand, so that is
						// where the abandoned attempt is dated from.
						at: since,
						endedAt: at,
						ok: false,
						detail: why,
						shape: "abandoned",
						executor: "reconcile",
					},
					reason: why,
				});
			}
		}
		return out;
	}

	/**
	 * Rewrite a journal that was written as pretty-printed JSON back into one
	 * line per record, keeping every record.
	 *
	 * Not a nicety: a multi-line record is a graph that does not exist. `load`
	 * parses line by line and skips what will not parse, so a sixteen-line
	 * object folds to nothing and the request it recorded is gone without an
	 * error anywhere. Two journals in quarantine are in that state.
	 *
	 * It refuses to guess. The file is re-parsed as a stream of whole JSON
	 * values, and if what comes back does not account for every byte of it
	 * beyond whitespace, nothing is written — a journal that is merely damaged
	 * in some other way must stay damaged and readable rather than become
	 * tidy and wrong. Returns the number of records rewritten, and 0 when the
	 * file was already one line per entry, in which case it is not touched.
	 */
	repair(graphId: string): number {
		const file = this.path(graphId);
		const raw = readFileSync(file, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim());
		if (lines.every((l) => tryParse(l) !== undefined)) return 0;

		const records = parseStream(raw);
		if (!records) throw new Error(`cannot repair ${graphId}: it is not a sequence of whole JSON values`);

		// Let go of the descriptor before replacing the file, or the appends
		// that follow go into the inode this is about to orphan.
		closeAppend(file);
		writeAtomic(file, records.map((r) => `${oneLine(JSON.stringify(r))}\n`));
		return records.length;
	}

	/**
	 * Move graphs that have no actionable work out of the active queue.
	 *
	 * Unlike `prune`, which deletes only fully-done graphs, this moves graphs
	 * whose tasks are all in terminal or stuck states (`rejected`, `unproven`,
	 * `failed`, `unreachable`, `done`) to a quarantine directory. They stay on
	 * disk â nothing is ever thrown away â but they stop clogging the
	 * active queue and the drive's sweep.
	 *
	 * A graph is quarantinable when every task is in a state that will never
	 * produce runnable work on its own: `done`, `rejected`, `unproven`,
	 * `failed`, and `unreachable`. `blocked` and `ready` are excluded because
	 * they can still be worked â `blocked` may be waiting for a criterion
	 * answer, and `ready` is actively runnable.
	 */
	quarantine(): string[] {
		const quarantined: string[] = [];
		const qDir = join(this.dir, "quarantine");
		if (!existsSync(qDir)) mkdirSync(qDir, { recursive: true });
		const stuck: ReadonlySet<Task["state"]> = new Set(["done", "rejected", "unproven", "failed", "unreachable"]);
		for (const id of this.ids()) {
			const graph = this.load(id);
			// A graph that cannot be loaded is also garbage — an old format,
			// a torn write, a corrupted file. It stays on disk in quarantine
			// but stops appearing in the active queue.
			if (graph && !graph.tasks.every((t) => stuck.has(t.state))) continue;
			try {
				closeAppend(this.path(id));
				const dest = join(qDir, `${id}.jsonl`);
				renameSync(this.path(id), dest);
				quarantined.push(id);
			} catch {
				/* somebody else may have taken it, or the rename failed */
			}
		}
		return quarantined;
	}
}

export type { Task, Graph, TaskInput };
