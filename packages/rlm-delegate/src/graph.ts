/**
 * The graph — pure, no I/O, no Cordis.
 *
 * Two things are wrong with handing an agent a paragraph and reading back what
 * it says, and this file fixes both by making them structural rather than
 * hoped-for.
 *
 * First: a task is a thing that was asked for, and it exists from the moment it
 * is asked — not from the moment someone gets round to it, and not only for as
 * long as the process that received it. Six jobs used to arrive as one string,
 * one got done, and the other five ended when the process did. A string cannot
 * outlive its process. A row can.
 *
 * Second: a task is not done because a turn ended. On the night this was
 * written there were nine consecutive "Done" reports and not one job finished.
 * Every one of those was a true statement — a turn HAD ended — and nothing
 * anywhere asked whether the work had happened. `iris-dirsize` was announced as
 * a capability while its only command was still the template's `hello`. So a
 * criterion is not a field a task may have. It is part of what a task IS, and a
 * task declared without one is refused exactly like a cycle is refused: at
 * declaration, before anything is written down.
 *
 * Everything derived is derived in one function (`settle`), so "is this
 * runnable?" and "is this now out of reach?" are never re-decided by a model
 * reading a paragraph. They are computed from edges.
 */

export type TaskState =
	| "blocked" // waiting on something that has not finished
	| "ready" // every dependency is done; may be picked up
	| "running" // in an agent's hands right now
	| "done" // came back AND its criterion passed
	| "unproven" // came back, and nobody had said how to tell whether it worked
	| "failed" // tried, did not work, and says why
	| "rejected" // its criterion passed, and a reviewer disputed it anyway
	| "unreachable"; // cannot be tried, because something it needs died

/**
 * How the graph decides a task is finished, without asking the agent.
 *
 * Every kind here is mechanical and model-free on purpose. That is the whole
 * value: it still answers when the delegator is dead, the model is down, or the
 * agent is confidently wrong. A kind that asked a model whether the work looked
 * right would just be a second claim standing behind the first, and it would
 * fail in the same direction — a scaffold reads perfectly well.
 *
 * The mechanical check cannot catch a criterion written to be easy to pass.
 * That is a different question and it belongs to a reviewer; see `Review`.
 */
export type Proof =
	/** Exit zero. A test, a build, a command that actually does the thing. */
	| { kind: "shell"; run: string; cwd?: string; timeoutMs?: number }
	/** A file exists, and optionally contains something. */
	| { kind: "file"; path: string; contains?: string }
	/** A composition row reached a fiber state — mounted, not merely written. */
	| { kind: "row"; id: string; state?: string }
	/** A command or tool is actually in the live registry under this name. */
	| { kind: "command"; name: string }
	/**
	 * Done when everything it needs is done. Costs nothing to check and needs
	 * nobody to run it — it is what a task becomes once it has been broken into
	 * the tasks that actually do the work.
	 */
	| { kind: "rollup" }
	/**
	 * Nobody said how to tell. This is what the boundary writes down when a
	 * request arrives and no model has looked at it yet, and it is the one kind
	 * that can never pass: a task holding it ends `unproven`, which is a
	 * recorded wound rather than a claim. Refining it into real tasks is how it
	 * stops being one.
	 */
	| { kind: "unstated"; note?: string };

export interface Attempt {
	/** ISO, when the agent was handed the task. */
	at: string;
	/** ISO, when it came back. Both are kept, so overlap is provable. */
	endedAt?: string;
	ok: boolean;
	/** Result text on success; the error on failure. */
	detail: string;
	/** Normalised failure sentence — see lapse.ts. Absent on success. */
	shape?: string;
	/** What the criterion said, and what it printed. Data a reviewer can read. */
	proof?: "passed" | "failed" | "errored";
	proofDetail?: string;
}

/**
 * The seam a reviewer plugs into — his `me-2`, not built here.
 *
 * The contract in one sentence: a reviewer reads a `done` task together with
 * its `proof` and the `proofDetail` of the attempt that satisfied it, and
 * returns `accepted` or `rejected` with a reason; `rejected` is what a
 * criterion written to be easy to pass looks like from above, and the graph
 * treats it exactly like a failure — dependents that had not started become
 * unreachable, dependents already finished are marked tainted rather than
 * silently left standing on it.
 */
export interface Review {
	by: string;
	at: string;
	verdict: "accepted" | "rejected";
	reason: string;
}

export interface Reviewer {
	review(task: Task, graph: Graph): Promise<{ verdict: "accepted" | "rejected"; reason: string }>;
}

export interface Task {
	id: string;
	/**
	 * One line, in the asker's words. This is the record that has to survive:
	 * a task nobody ever picked up still shows up as this line.
	 */
	title: string;
	/** What the agent is actually handed. */
	prompt: string;
	/** Real edges. Every id resolves, or the whole graph is refused. */
	needs: string[];
	/** Mandatory. A task nobody can tell is finished is not a task. */
	proof: Proof;
	state: TaskState;
	attempts: Attempt[];
	result?: string;
	/** Why it failed, or which death put it out of reach. */
	reason?: string;
	/** For `unreachable`: the ids it is waiting on that will never arrive. */
	blockedBy?: string[];
	/** A reviewer's verdict on a criterion that already passed. */
	review?: Review;
	/** Finished, but standing on something that has since died. */
	tainted?: string;
	createdAt: string;
	updatedAt: string;
}

export interface TaskInput {
	id: string;
	title: string;
	prompt?: string;
	needs?: string[];
	proof: Proof;
}

export interface Graph {
	id: string;
	/** The request as it arrived, kept verbatim. */
	goal: string;
	createdAt: string;
	tasks: Task[];
}

export class DeclarationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeclarationError";
	}
}

export class CycleError extends DeclarationError {
	readonly cycle: string[];
	constructor(cycle: string[]) {
		super(`cycle declared: ${cycle.join(" -> ")}`);
		this.name = "CycleError";
		this.cycle = cycle;
	}
}

/**
 * The prefix on reasons this file authors. Everything else on `reason` was put
 * there by something that actually happened — an attempt, a crash, a reviewer —
 * and re-deriving the edges must not wipe it out.
 */
const DERIVED = "never runnable:";

/** States `settle` will not recompute — they were decided by something happening. */
const SETTLED: TaskState[] = ["done", "unproven", "failed", "rejected"];
/**
 * States that stop everything downstream.
 *
 * `unproven` is in here deliberately. Work that came back with no way to check
 * it is not a foundation; building the next thing on top of it is how a
 * scaffold ends up announced as a capability.
 */
const DEAD: TaskState[] = ["failed", "rejected", "unreachable", "unproven"];

/** What is still owed to the asker — the answer to "what is left?". */
export const outstanding = (tasks: Task[]): Task[] => tasks.filter((t) => t.state !== "done");

/**
 * Work that still has somewhere to go: something could pick it up, or somebody
 * needs to look at why it stopped.
 */
export const owed = (tasks: Task[]): Task[] =>
	tasks.filter((t) => t.state !== "done" && t.state !== "unproven");

/**
 * Turns that ended with nobody able to say whether the work happened.
 *
 * Not "still owed" — nothing more is going to be done about them on their own,
 * and listing them beside live work would drown it. They are the wounds: a
 * request was received, something ran, and there was never a way to check. The
 * record exists whether or not anything intelligent noticed at the time.
 */
export const unverified = (tasks: Task[]): Task[] => tasks.filter((t) => t.state === "unproven");

/** No task can move again without someone intervening. */
export const isFinished = (tasks: Task[]): boolean =>
	tasks.every((t) => t.state === "done" || DEAD.includes(t.state));

/** Reject a criterion at declaration if nothing mechanical could ever check it. */
export const validateProof = (proof: Proof | undefined, id: string): void => {
	if (!proof || typeof proof !== "object" || !(proof as any).kind) {
		throw new DeclarationError(
			`task "${id}" declares no criterion. A turn ending is not evidence the work happened — ` +
				`say what must be true afterwards: a command that exits zero, a file that contains something, ` +
				`a row that reaches ACTIVE, or a command that appears in the registry.`,
		);
	}
	const p = proof as any;
	switch (p.kind) {
		case "shell":
			if (!p.run || typeof p.run !== "string") throw new DeclarationError(`task "${id}": shell criterion needs a command to run`);
			return;
		case "file":
			if (!p.path || typeof p.path !== "string") throw new DeclarationError(`task "${id}": file criterion needs a path`);
			return;
		case "row":
			if (!p.id || typeof p.id !== "string") throw new DeclarationError(`task "${id}": row criterion needs a row id`);
			return;
		case "command":
			if (!p.name || typeof p.name !== "string") throw new DeclarationError(`task "${id}": command criterion needs a name`);
			return;
		case "rollup":
		case "unstated":
			return;
		default:
			throw new DeclarationError(`task "${id}": unknown criterion kind "${p.kind}"`);
	}
};

/**
 * Refuse a cycle when it is declared, not when it is discovered at run time.
 * Returns the offending path, so the caller can say which edge to remove.
 */
export const findCycle = (tasks: Array<{ id: string; needs?: string[] }>): string[] | null => {
	const needs = new Map(tasks.map((t) => [t.id, t.needs ?? []]));
	const colour = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on the stack, 2 finished
	const stack: string[] = [];

	const walk = (id: string): string[] | null => {
		colour.set(id, 1);
		stack.push(id);
		for (const need of needs.get(id) ?? []) {
			if (!needs.has(need)) continue; // an unknown id is a different complaint
			const seen = colour.get(need) ?? 0;
			if (seen === 1) return [...stack.slice(stack.indexOf(need)), need];
			if (seen === 0) {
				const found = walk(need);
				if (found) return found;
			}
		}
		stack.pop();
		colour.set(id, 2);
		return null;
	};

	for (const task of tasks) {
		if ((colour.get(task.id) ?? 0) === 0) {
			const found = walk(task.id);
			if (found) return found;
		}
	}
	return null;
};

/**
 * Turn declared inputs into tasks, or refuse the whole lot.
 *
 * Nothing is written anywhere until this returns, so a graph that would be
 * malformed never reaches disk and can never be half-declared — which would be
 * its own way of forgetting.
 */
export const declare = (
	graphId: string,
	goal: string,
	inputs: TaskInput[],
	now = new Date().toISOString(),
	existing: Task[] = [],
): Graph => {
	if (!inputs.length) throw new DeclarationError("nothing declared: a graph needs at least one task");

	const seen = new Set(existing.map((t) => t.id));
	for (const input of inputs) {
		if (!input.id || typeof input.id !== "string") throw new DeclarationError("every task needs an id");
		if (!input.title || typeof input.title !== "string") {
			throw new DeclarationError(`task "${input.id}" needs a title — it is the record that survives`);
		}
		if (seen.has(input.id)) throw new DeclarationError(`duplicate task id "${input.id}"`);
		seen.add(input.id);
		validateProof(input.proof, input.id);
	}

	const all = [
		...existing.map((t) => ({ id: t.id, needs: t.needs })),
		...inputs.map((i) => ({ id: i.id, needs: i.needs ?? [] })),
	];
	const known = new Set(all.map((t) => t.id));
	for (const input of inputs) {
		for (const need of input.needs ?? []) {
			if (!known.has(need)) {
				throw new DeclarationError(`task "${input.id}" needs "${need}", which was never declared`);
			}
		}
	}

	const cycle = findCycle(all);
	if (cycle) throw new CycleError(cycle);

	const tasks: Task[] = [
		...existing,
		...inputs.map((input) => ({
			id: input.id,
			title: input.title,
			prompt: input.prompt ?? input.title,
			needs: input.needs ?? [],
			proof: input.proof,
			state: "blocked" as TaskState,
			attempts: [] as Attempt[],
			createdAt: now,
			updatedAt: now,
		})),
	];

	return { id: graphId, goal, createdAt: now, tasks: settle(tasks, now) };
};

/**
 * Recompute every derived state from the edges.
 *
 * `unreachable` is derived, never stored as a decision — so if the dependency
 * that died is later retried and passes, or a rejection is overturned, its
 * dependents come back on their own. A dependent is never deleted and never
 * quietly counted as done. It sits there naming the thing that stopped it.
 *
 * A dependent that already finished keeps its `done`: its own criterion did
 * pass, and that is a fact about the world, not an opinion. But it is marked
 * `tainted` naming what it is standing on, because a finished thing built on a
 * rejected thing is the exact shape of a report that is true and useless.
 */
export const settle = (tasks: Task[], now = new Date().toISOString()): Task[] => {
	const out = tasks.map((t) => ({ ...t }));
	const byId = new Map(out.map((t) => [t.id, t]));

	// Repeat until nothing moves: death travels along the edges.
	for (let pass = 0; pass <= out.length; pass++) {
		let moved = false;
		for (const task of out) {
			if (task.state === "running") continue;

			const dead: string[] = [];
			let pending = false;
			for (const id of task.needs) {
				const need = byId.get(id);
				if (!need) {
					dead.push(id); // declared against something that is no longer here
					continue;
				}
				if (DEAD.includes(need.state) || need.tainted) dead.push(id);
				else if (need.state !== "done") pending = true;
			}

			if (SETTLED.includes(task.state)) {
				// Finished work is not undone, but it stops claiming to be sound.
				const tainted = dead.length && task.state === "done"
					? `stands on ${dead.join(", ")}, which did not hold`
					: undefined;
				if (task.tainted !== tainted) {
					task.tainted = tainted;
					task.updatedAt = now;
					moved = true;
				}
				continue;
			}

			const next: TaskState = dead.length ? "unreachable" : pending ? "blocked" : "ready";
			const reason = dead.length
				? `${DERIVED} ${dead
						.map((id) => `${id} ${byId.get(id) ? byId.get(id)!.state : "is missing"}`)
						.join(", ")}`
				: task.reason?.startsWith(DERIVED)
					? undefined
					: task.reason;

			if (task.state !== next || task.reason !== reason) {
				task.state = next;
				task.reason = reason;
				task.blockedBy = dead.length ? dead : undefined;
				task.updatedAt = now;
				moved = true;
			}
		}
		if (!moved) break;
	}

	return out;
};

/** Everything that could start right now. Independent tasks come back together. */
export const runnable = (tasks: Task[]): Task[] => tasks.filter((t) => t.state === "ready");

/** How a criterion reads to a person, so a reviewer can dispute it. */
export const describeProof = (proof: Proof): string => {
	switch (proof.kind) {
		case "shell":
			return `\`${proof.run}\` exits 0`;
		case "file":
			return proof.contains ? `${proof.path} contains ${JSON.stringify(proof.contains)}` : `${proof.path} exists`;
		case "row":
			return `row ${proof.id} reaches ${proof.state ?? "ACTIVE"}`;
		case "command":
			return `command ${proof.name} is in the registry`;
		case "rollup":
			return "everything it was broken into is done";
		case "unstated":
			return proof.note ?? "nobody said how to tell — this cannot pass until it is refined";
	}
};

/** A one-screen account of what was asked and what became of it. */
export const render = (graph: Graph): string => {
	const mark: Record<TaskState, string> = {
		done: "done       ",
		unproven: "UNPROVEN   ",
		failed: "FAILED     ",
		rejected: "REJECTED   ",
		unreachable: "unreachable",
		running: "running    ",
		ready: "ready      ",
		blocked: "blocked    ",
	};
	const lines = graph.tasks.map((task) => {
		const needs = task.needs.length ? `  (needs ${task.needs.join(", ")})` : "";
		const why = task.reason ? `\n                 ${task.reason}` : "";
		const taint = task.tainted ? `\n                 tainted: ${task.tainted}` : "";
		const judged = task.review ? `\n                 ${task.review.verdict} by ${task.review.by}: ${task.review.reason}` : "";
		return `  ${mark[task.state]}  ${task.id}: ${task.title}${needs}\n                 criterion: ${describeProof(task.proof)}${why}${taint}${judged}`;
	});
	const left = outstanding(graph.tasks).length;
	const unchecked = unverified(graph.tasks).length;
	return [
		`${graph.id} — ${graph.goal}`,
		...lines,
		`  ${graph.tasks.length - left}/${graph.tasks.length} done, ${left} still owed` +
			(unchecked ? `, ${unchecked} of those never checkable` : ""),
	].join("\n");
};
