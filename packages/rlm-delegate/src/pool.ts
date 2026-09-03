/**
 * A few long-lived workers instead of one process per task.
 *
 * ## The measurement this exists because of
 *
 * A delegated child was `node … cordis-shell.mjs --headless --print … -- <prompt>`,
 * one process per task, ~110-125 MB RSS each. Eight of them is ~500 MB. Sampled
 * every 700 ms from spawn to exit, a real child reads:
 *
 *     t(s)   RSS   footprint
 *      0.7   114      80
 *      1.4   143     101     <- fully booted
 *      2.1   144     103
 *      2.8   144     103
 *      3.5   143      96
 *      4.2   144      86     <- the model call happened in here
 *
 * Peak at 1.4 s, flat through the work. **The task costs approximately
 * nothing.** All of it is module code loaded so the process is *ready* to do a
 * task, discarded five seconds later, and loaded again by the next child.
 *
 * His sentence, twice, the second time annoyed: *"in headless mode, it should
 * take less than 1 mb per agent so 8 children would be 10mb max. whats taking
 * so much ram?"* Per *process* that is not reachable — bare `node -e ''` is
 * 39 MB — and nobody is asking for it to be. Per *task* it is exactly right,
 * and it is what this file makes true: the 1.4-second, 143 MB boot is paid once
 * per fleet instead of once per task, and task N costs its messages, its tool
 * results and its live heap.
 *
 * ## The contract does not change
 *
 * `Runner` is `(task, graph) => Promise<string>` and the scheduler must not
 * need to know anything happened. Everything `AgentOptions` promised still
 * holds, and each one is load-bearing:
 *
 *   - **A per-task timeout that really stops it.** In a pool a runaway task
 *     cannot be stopped by ending the process, because the process is holding
 *     its siblings. So the first move is in-process: `connection.abort()` and
 *     `abortBash()`, which reach that session and no other. Only if the task
 *     will not let go inside `graceMs` is the worker retired as a group and
 *     replaced — and then its siblings are re-queued rather than lost.
 *   - **`signal`** takes the same path.
 *   - **`sessionFor(graph, task)`** now actually resumes. Until now the id went
 *     down the command line as `--session-id` and was read by nobody on this
 *     path; the worker turns it into a `SessionManager` pointed at that session
 *     file, so attempt two starts where attempt one stopped, whichever worker
 *     picks it up.
 *   - **`RLM_DELEGATE_CHILD=1`** is in the worker's environment at spawn, which
 *     is what `rlm-guard` reads once at module load and what `intake()` reads
 *     per call. A pooled worker is a delegated child by both tests.
 *   - **`confine`** is a `sandbox-exec` wrapper around one command line. A
 *     confined task cannot share a process with an unconfined one — the bound
 *     would mean nothing — so a runner built with `confine` gets a **pool of its
 *     own**, whose workers are themselves started inside the sandbox. Every task
 *     in that pool is under the same profile, which is the condition that makes
 *     sharing sound, and it holds here because there is one confined caller and
 *     it always asks for the same scope: `plannerScope()`.
 *
 *     This is not a detail. A live sweep measured with the first version of this
 *     file had **twenty** confined planner children running at once, each its own
 *     process, because "confined" was being spelled "one-shot" — the whole cost
 *     this file exists to remove, left in place in the one part of the sweep that
 *     was actually using it.
 *
 * ## Where this is switched on
 *
 * Nowhere here. `@rlm/headless` is the row that owns "nobody is watching this
 * run, so here is what it should cost" — it already answers `childNodeFlags()`
 * — and it answers `childPoolSlots()` too. No row, no pool: the delegate falls
 * back to `rlmAgent` and spawns exactly what it spawned before. That is the
 * whole of the switch, and it is deliberate: he asked that everything go
 * through the headless plugin so that removing it leaves rlm behaving as it
 * always did.
 *
 * ## Attention is per session, not per process
 *
 * One worker serves many sessions, so "is anybody watching" stopped being a
 * fact about a process the moment this file existed. `attend(sessionId)` moves
 * a single viewport: the named session becomes the watched one and every other
 * session in the fleet — including the one that was watched a moment ago — goes
 * back to headless. It is one message to every worker, and the worker hands it
 * to `rlmHeadless.attend()`, which is where the fact belongs.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { planLaunch, rlmAgent, sessionFor, withCriterion, type AgentOptions } from "./agent.ts";
import type { Graph, Task } from "./graph.ts";
import type { Runner } from "./scheduler.ts";

// ─── The wire ────────────────────────────────────────────────────────────────

/** Anything the pool says to a worker. */
export type WorkerBound =
	| { type: "task"; id: string; prompt: string; sessionId: string }
	| { type: "cancel"; id: string }
	| { type: "attend"; sessionId: string | null }
	| { type: "retire" };

export type PoolRequest = Extract<WorkerBound, { type: "task" }>;

/** Anything a worker says back. */
export type PoolReply =
	| { type: "ready"; pid: number; slots: number }
	| { type: "chunk"; id: string; text: string }
	| { type: "done"; id: string; ok: boolean; text: string; error?: string; worker?: "lost" }
	| { type: "attention"; watching: string | null }
	| { type: "fatal"; error: string };

// ─── Options ─────────────────────────────────────────────────────────────────

export interface PoolOptions extends AgentOptions {
	/** Tasks one worker may hold at once. The marginal-cost number lives here. */
	slots?: number;
	/**
	 * Workers, at most.
	 *
	 * Not a new number: the caller passes what the `capacity()` verdict already
	 * computes, divided by the slots. Inventing a second limit beside that one
	 * is how a machine that reads healthy starts swapping.
	 */
	maxWorkers?: number;
	/** A worker with nothing to do for this long is shut down. */
	idleMs?: number;
	/** A worker is retired after this many tasks, whatever their outcome. */
	maxTasksPerWorker?: number;
	/** How long a worker gets to boot the composition before it is written off. */
	bootTimeoutMs?: number;
	/** How long a cancelled task gets to stop before its worker is retired. */
	graceMs?: number;
	/** Somewhere to say what the pool is doing. */
	log?: (line: string) => void;
}

interface Pending {
	id: string;
	task: Task;
	graph: Graph;
	prompt: string;
	sessionId: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onOutput?: (task: Task, chunk: string) => void;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	/** Set once the task has been handed to a worker. */
	worker?: Worker;
	timer?: NodeJS.Timeout;
	grace?: NodeJS.Timeout;
	detach?: () => void;
	/**
	 * Why this task is being stopped, fixed at the moment the decision was made.
	 *
	 * An in-process abort comes back from the worker as an ordinary answer, and
	 * reporting a timeout as an answer is how a bound stops being visible.
	 */
	why?: Error;
	/** A worker that died under this task gets it handed on exactly once. */
	requeued?: boolean;
	settled?: boolean;
}

interface Worker {
	id: number;
	child: ChildProcess;
	slots: number;
	/** Tasks currently in flight here. */
	holding: Set<string>;
	/** Tasks this worker has ever been given. */
	lifetime: number;
	ready: boolean;
	retiring: boolean;
	idle?: NodeJS.Timeout;
	/** The last of what it said, for when it dies without explaining. */
	tail: string[];
}

let nextWorkerId = 1;
let nextTaskId = 1;

const TAIL_LINES = 25;

// ─── The pool ────────────────────────────────────────────────────────────────

export class AgentPool {
	private readonly options: PoolOptions;
	private readonly workers = new Set<Worker>();
	private readonly queue: Pending[] = [];
	private readonly inFlight = new Map<string, Pending>();
	private closed = false;
	/** One sibling pool per distinct write scope. Usually exactly one: the planner's. */
	private readonly scoped = new Map<NonNullable<AgentOptions["confine"]>, AgentPool>();
	/** The one session being watched, as far as this pool knows. */
	private attention: string | null = null;

	constructor(options: PoolOptions) {
		this.options = options;
	}

	private get slots(): number {
		return Math.max(1, this.options.slots ?? 8);
	}

	private get maxWorkers(): number {
		return Math.max(1, this.options.maxWorkers ?? 4);
	}

	private say(line: string) {
		this.options.log?.(`rlm-delegate pool: ${line}`);
	}

	/**
	 * A `Runner`, which is the only thing the scheduler knows about.
	 *
	 * Per-call overrides exist because the drive builds a runner per sweep with
	 * that sweep's `AbortSignal`, and because a confined call has to leave the
	 * pool entirely.
	 */
	runner(overrides: Partial<AgentOptions> = {}): Runner {
		const confine = overrides.confine ?? this.options.confine;
		if (confine && confine !== this.options.confine) {
			// A bound on writing that half the tasks in a process do not share is
			// not a bound — so confined work gets its own workers, started inside
			// the sandbox, rather than sharing these. One pool per distinct scope:
			// tasks inside it are all under the same profile, which is exactly the
			// condition that makes sharing a process sound.
			return this.confined(confine).runner(overrides);
		}
		return (task: Task, graph: Graph) => this.run(task, graph, overrides);
	}

	/** The pool for one write scope, made the first time that scope is asked for. */
	private confined(confine: NonNullable<AgentOptions["confine"]>): AgentPool {
		const already = this.scoped.get(confine);
		if (already) return already;
		const made = new AgentPool({ ...this.options, confine });
		this.scoped.set(confine, made);
		this.say("a confined caller asked for work — it gets workers of its own, inside the sandbox");
		return made;
	}

	/**
	 * The one-shot spawner, kept reachable.
	 *
	 * Not used by default any more, and here because "confined means one process
	 * per task" was the honest fallback before the confined pool existed, and a
	 * caller that wants it — a scope used exactly once, where a warm worker would
	 * never be reused — should not have to rebuild it.
	 */
	oneShot(overrides: Partial<AgentOptions> = {}): Runner {
		return rlmAgent({ ...this.options, ...overrides } as AgentOptions);
	}

	run(task: Task, graph: Graph, overrides: Partial<AgentOptions> = {}): Promise<string> {
		const signal = overrides.signal ?? this.options.signal;
		const timeoutMs = overrides.timeoutMs ?? this.options.timeoutMs ?? 2_700_000;
		const onOutput = overrides.onOutput ?? this.options.onOutput;
		return new Promise<string>((resolve, reject) => {
			if (this.closed) return reject(new Error("the pool is closed"));
			if (signal?.aborted) return reject(new Error("stopped before this attempt started"));
			const pending: Pending = {
				id: `t${nextTaskId++}`,
				task,
				graph,
				prompt: withCriterion(task),
				sessionId: sessionFor(graph, task),
				timeoutMs,
				signal,
				onOutput,
				resolve,
				reject,
			};
			if (signal) {
				const onAbort = () => this.stopTask(pending, new Error("stopped mid-attempt"));
				signal.addEventListener("abort", onAbort, { once: true });
				pending.detach = () => signal.removeEventListener("abort", onAbort);
			}
			this.queue.push(pending);
			this.pump();
		});
	}

	// ─── Attention ───────────────────────────────────────────────────────────

	/**
	 * Watch one session, and by the same act stop watching every other one.
	 *
	 * A viewport, not a switch. There is one of him, so exactly one session is
	 * watched at a time and moving the viewport is what "opening" a different
	 * agent means. `null` closes it, and then nothing in the fleet is paying for
	 * a live surface.
	 *
	 * The message goes to every worker, not only the one holding that session:
	 * the others have to *stop* watching, and a worker that is not holding the
	 * named session records that nothing of its own is watched.
	 */
	attend(sessionId: string | null): string | null {
		this.attention = sessionId;
		for (const worker of this.workers) this.tell(worker, { type: "attend", sessionId });
		// A planner is an agent too, and one of them may be the one he opened.
		for (const sibling of this.scoped.values()) sibling.attend(sessionId);
		return this.attention;
	}

	/** The session being watched, as far as this pool has been told. */
	watching(): string | null {
		return this.attention;
	}

	/** The session id a task would run under, without running it. */
	sessionOf(task: Task, graph: Graph): string {
		return sessionFor(graph, task);
	}

	stats() {
		return {
			workers: [...this.workers].map((w) => ({
				id: w.id,
				pid: w.child.pid,
				ready: w.ready,
				holding: w.holding.size,
				lifetime: w.lifetime,
				retiring: w.retiring,
			})),
			queued: this.queue.length,
			inFlight: this.inFlight.size,
			watching: this.attention,
			confined: [...this.scoped.values()].map((p) => p.stats()),
		};
	}

	/** Let go of every worker. Anything still queued is failed, not forgotten. */
	async close(): Promise<void> {
		this.closed = true;
		for (const pending of [...this.queue]) this.settle(pending, new Error("the pool was closed"));
		this.queue.length = 0;
		for (const worker of [...this.workers]) this.retire(worker, "the pool was closed");
		await Promise.all([...this.scoped.values()].map((p) => p.close()));
		this.scoped.clear();
		// Not unref'd. An unref'd timer does not hold the loop open, so if this is
		// the last thing a process is waiting on, node exits *through* the await
		// and `close()` never resolves — which reads to the caller as a hang and
		// cost two probe runs to find. Fifty milliseconds is a drain, not a wait.
		await new Promise<void>((r) => setTimeout(r, 50));
	}

	// ─── Scheduling ──────────────────────────────────────────────────────────

	private pump() {
		while (this.queue.length) {
			const worker = this.pick();
			if (!worker) break;
			const pending = this.queue.shift() as Pending;
			this.give(worker, pending);
		}
		// Nothing free and room for another process: boot one. The queue is
		// drained again from `ready`. At most one is booting at a time, because a
		// burst of twenty tasks arriving together must not start twenty processes
		// when the first one to come up can take eight of them.
		if (
			!this.closed &&
			this.queue.length &&
			this.workers.size < this.maxWorkers &&
			![...this.workers].some((w) => !w.ready && !w.retiring)
		) {
			this.hire();
		}
	}

	private pick(): Worker | undefined {
		let best: Worker | undefined;
		for (const worker of this.workers) {
			if (!worker.ready || worker.retiring) continue;
			if (worker.holding.size >= worker.slots) continue;
			// Fill a worker before starting another one — the entire saving is in
			// not paying the boot again, so a warm process with room is always the
			// better answer than a cold one with more room.
			if (!best || worker.holding.size > best.holding.size) best = worker;
		}
		return best;
	}

	private give(worker: Worker, pending: Pending) {
		pending.worker = worker;
		worker.holding.add(pending.id);
		worker.lifetime += 1;
		if (worker.idle) {
			clearTimeout(worker.idle);
			worker.idle = undefined;
		}
		this.inFlight.set(pending.id, pending);
		pending.timer = setTimeout(() => {
			this.stopTask(pending, new Error(`the attempt ran past ${pending.timeoutMs}ms and was stopped`));
		}, pending.timeoutMs);
		pending.timer.unref?.();
		this.tell(worker, { type: "task", id: pending.id, prompt: pending.prompt, sessionId: pending.sessionId });
	}

	/**
	 * Stop one task without touching the others.
	 *
	 * In-process first, because that is the only way a pool can stop one of many
	 * things sharing a heap. If the session will not come back inside `graceMs`
	 * the worker is retired as a group — which does take the siblings, so they
	 * are re-queued and the reason is recorded against the task that caused it.
	 */
	private stopTask(pending: Pending, why: Error) {
		if (pending.settled) return;
		pending.why = why;
		const worker = pending.worker;
		if (!worker) {
			const at = this.queue.indexOf(pending);
			if (at !== -1) this.queue.splice(at, 1);
			return this.settle(pending, why);
		}
		this.tell(worker, { type: "cancel", id: pending.id });
		if (pending.grace) return;
		pending.grace = setTimeout(() => {
			if (pending.settled) return;
			this.say(`task ${pending.task.id} would not stop — retiring worker ${worker.id}`);
			this.settle(pending, why);
			this.retire(worker, `a task would not stop: ${why.message}`);
		}, this.options.graceMs ?? 20_000);
		pending.grace.unref?.();
	}

	private settle(pending: Pending, error: Error | null, text?: string) {
		if (pending.settled) return;
		pending.settled = true;
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.grace) clearTimeout(pending.grace);
		pending.detach?.();
		this.inFlight.delete(pending.id);
		if (pending.worker) {
			pending.worker.holding.delete(pending.id);
			this.maybeReap(pending.worker);
		}
		if (error) pending.reject(error);
		else pending.resolve(text ?? "");
		this.pump();
	}

	// ─── Workers ─────────────────────────────────────────────────────────────

	private hire(): Worker | undefined {
		// The same decisions `agent.ts` makes, in the same function, so a worker
		// and a one-shot can never be started differently by accident: skip rlm's
		// re-exec (a launcher that does nothing but exec and wait measured 28 MB),
		// hand the interpreter its sizing flags, and under bun leave out the tsx
		// loader it does not need and the `--expose-internals` it does not have.
		const { command, prefix } = planLaunch(this.options);
		const plain = [...prefix, this.options.entry, "--headless", "--pool-worker", "--slots", String(this.slots)];
		// The whole worker goes inside the sandbox, not each task. `sandbox-exec`
		// applies the profile and then `exec`s in place, so the IPC descriptor and
		// `NODE_CHANNEL_FD` survive it and the process that comes out is the same
		// worker under a write bound it cannot take off.
		const [bin, ...args] = this.options.confine ? this.options.confine(command, plain) : [command, ...plain];

		let child: ChildProcess;
		try {
			child = spawn(bin, args, {
				cwd: this.options.cwd,
				env: { ...process.env, ...this.options.env, RLM_DELEGATE_CHILD: "1" },
				// Its own process group, so a worker that has to be retired takes
				// everything it started with it — the same reason `agent.ts` does it.
				// `ipc` is the fourth descriptor: the answers come back addressed.
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				detached: true,
			});
		} catch (error: any) {
			this.say(`could not start a worker: ${error?.message ?? error}`);
			return undefined;
		}

		const worker: Worker = {
			id: nextWorkerId++,
			child,
			slots: this.slots,
			holding: new Set(),
			lifetime: 0,
			ready: false,
			retiring: false,
			tail: [],
		};
		this.workers.add(worker);

		const boot = setTimeout(() => {
			if (worker.ready) return;
			this.say(`worker ${worker.id} never booted`);
			this.retire(worker, "it never finished booting");
		}, this.options.bootTimeoutMs ?? 120_000);
		boot.unref?.();

		const remember = (chunk: unknown) => {
			for (const line of String(chunk).split("\n")) {
				if (!line.trim()) continue;
				worker.tail.push(line);
				if (worker.tail.length > TAIL_LINES) worker.tail.shift();
			}
		};
		child.stdout?.on("data", remember);
		child.stderr?.on("data", remember);

		child.on("message", (raw: unknown) => this.heard(worker, raw as PoolReply, boot));
		child.on("error", (error) => {
			this.say(`worker ${worker.id} errored: ${error.message}`);
			this.lost(worker, error.message);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(boot);
			this.lost(worker, `it exited ${signal ? `on ${signal}` : code}`);
		});
		return worker;
	}

	private heard(worker: Worker, message: PoolReply, boot: NodeJS.Timeout) {
		if (!message || typeof message !== "object") return;
		if (message.type === "ready") {
			clearTimeout(boot);
			worker.ready = true;
			worker.slots = message.slots || worker.slots;
			this.say(`worker ${worker.id} up as pid ${message.pid} with ${worker.slots} slot(s)`);
			// A worker that boots into a fleet where something is already being
			// watched has to be told, or attention would silently be a property of
			// when a process happened to start.
			if (this.attention !== null) this.tell(worker, { type: "attend", sessionId: this.attention });
			this.pump();
			this.maybeReap(worker);
			return;
		}
		if (message.type === "chunk") {
			const pending = this.inFlight.get(message.id);
			if (pending?.onOutput) pending.onOutput(pending.task, message.text);
			return;
		}
		if (message.type === "done") {
			const pending = this.inFlight.get(message.id);
			if (!pending) return;
			if (pending.why) return this.settle(pending, pending.why);
			if (message.ok) return this.settle(pending, null, message.text.trim() || "(the agent said nothing)");
			const tail = `${message.text}\n${message.error ?? ""}`.trim().split("\n").slice(-TAIL_LINES).join("\n");
			return this.settle(pending, new Error(`the agent failed\n${tail}`));
		}
		if (message.type === "attention") {
			this.attention = message.watching;
			return;
		}
		if (message.type === "fatal") {
			this.say(`worker ${worker.id} is gone: ${message.error.split("\n")[0]}`);
			worker.retiring = true;
			return;
		}
	}

	/**
	 * A worker died. Its tasks are somebody's, and they are not lost.
	 *
	 * Handed to another worker exactly once. Once, because a task that takes a
	 * process down is likely to take the next one down too, and a pool that
	 * re-queues for ever turns one bad task into a machine that never stops
	 * booting.
	 */
	private lost(worker: Worker, why: string) {
		if (!this.workers.delete(worker)) return;
		if (worker.idle) clearTimeout(worker.idle);
		const tail = worker.tail.slice(-8).join("\n");
		for (const id of [...worker.holding]) {
			const pending = this.inFlight.get(id);
			worker.holding.delete(id);
			if (!pending || pending.settled) continue;
			if (pending.why) {
				this.settle(pending, pending.why);
				continue;
			}
			if (pending.requeued) {
				this.settle(pending, new Error(`the worker died twice under this task — ${why}\n${tail}`));
				continue;
			}
			// Nothing is coming back for it: a closed pool starts no more
			// workers, so re-queueing here would leave the caller waiting on a
			// promise that can never settle.
			if (this.closed) {
				this.settle(pending, new Error(`the pool was closed while this was running — ${why}`));
				continue;
			}
			pending.requeued = true;
			pending.worker = undefined;
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.grace) clearTimeout(pending.grace);
			pending.grace = undefined;
			this.inFlight.delete(id);
			this.say(`worker ${worker.id} died holding ${pending.task.id} — handing it on (${why})`);
			this.queue.unshift(pending);
		}
		this.pump();
	}

	/** Nothing to do and nothing coming: give the memory back. */
	private maybeReap(worker: Worker) {
		if (worker.holding.size > 0 || worker.idle || worker.retiring) return;
		if (worker.lifetime >= (this.options.maxTasksPerWorker ?? 200)) {
			return this.retire(worker, `it has done ${worker.lifetime} task(s)`);
		}
		const after = this.options.idleMs ?? 300_000;
		if (!Number.isFinite(after) || after <= 0) return;
		worker.idle = setTimeout(() => {
			if (worker.holding.size === 0) this.retire(worker, `it sat idle for ${after}ms`);
		}, after);
		worker.idle.unref?.();
	}

	/**
	 * Shut a worker down: ask, then insist.
	 *
	 * `retire` is sent first so a worker with nothing in flight leaves cleanly
	 * and disposes the composition; the two signals that follow are for the case
	 * where it is wedged, and they go to the process group so nothing it started
	 * outlives it.
	 */
	private retire(worker: Worker, why: string) {
		if (worker.retiring) return;
		worker.retiring = true;
		if (worker.idle) clearTimeout(worker.idle);
		this.say(`retiring worker ${worker.id} — ${why}`);
		this.tell(worker, { type: "retire" });
		const group = (sig: NodeJS.Signals) => {
			try {
				if (worker.child.pid) process.kill(-worker.child.pid, sig);
			} catch {
				try {
					worker.child.kill(sig);
				} catch {
					/* already gone */
				}
			}
		};
		const term = setTimeout(() => group("SIGTERM"), 250);
		const hard = setTimeout(() => group("SIGKILL"), 2_250);
		term.unref?.();
		hard.unref?.();
		worker.child.once("exit", () => {
			clearTimeout(term);
			clearTimeout(hard);
		});
	}

	private tell(worker: Worker, message: WorkerBound) {
		try {
			worker.child.send?.(message);
		} catch {
			/* the channel is gone; `exit` is about to be heard */
		}
	}
}

/**
 * The pool as a plain `Runner`, for a caller that wants nothing else from it.
 *
 * `close()` hangs off the returned function so a row can let the workers go
 * when it unloads — a pool that outlives the row that made it is 143 MB of
 * nothing.
 */
export const pooledAgent = (options: PoolOptions): Runner & { pool: AgentPool; close: () => Promise<void> } => {
	const pool = new AgentPool(options);
	const runner = pool.runner() as Runner & { pool: AgentPool; close: () => Promise<void> };
	runner.pool = pool;
	runner.close = () => pool.close();
	return runner;
};
