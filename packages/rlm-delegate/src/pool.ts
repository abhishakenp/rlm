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
import { freemem, totalmem } from "node:os";
import { planLaunch, rlmAgent, sessionFor, withCriterion, type AgentOptions } from "./agent.ts";
import type { Graph, Task } from "./graph.ts";
import type { Runner } from "./scheduler.ts";
import { InProcessWorker } from "./in-process-worker.ts";
import type { PoolWorkerAgent } from "./pool-worker.ts";

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
	/**
	 * "I am still here", every `heartbeatMs`.
	 *
	 * Not the same fact as "the process exists". A worker wedged in a native
	 * call, swapping, or spinning in a tool that never returns is a live pid
	 * holding live tasks and answering nothing, and until this existed the only
	 * bound on that was the per-task timeout — which is forty-five minutes by
	 * default, because it is sized for a real agent turn and not for a corpse.
	 */
	| { type: "heartbeat"; id: string; ts: number }
	| { type: "fatal"; error: string };

// ─── Options ─────────────────────────────────────────────────────────────────

export interface PoolOptions extends AgentOptions {
	/** Tasks one worker may hold at once. The marginal-cost number lives here. */
	slots?: number;
	/**
	 * Use in-process workers instead of child processes.
	 *
	 * Default: `true`. In-process workers run tasks in the host process,
	 * sharing the composition's `ctx` and `rlmAgent` service. The marginal
	 * cost of a task is its messages and tool results, not a second copy
	 * of the framework.
	 *
	 * Set to `false` for crash-prone or untrusted tasks — child-process
	 * workers provide process-level isolation and are the fallback.
	 *
	 * When `true`, the pool needs `ctx` and `agent` (the `PoolWorkerAgent`)
	 * to create runtimes in-process. When `false`, it spawns child processes
	 * via the entry point as before.
	 */
	useInProcess?: boolean;
	/**
	 * The Cordis context for in-process workers.
	 *
	 * When `useInProcess` is true, the pool uses this `ctx` to resolve
	 * `rlmAgent` and `rlmHeadless` services. The host composition's `ctx`
	 * is the right value here.
	 */
	ctx?: any;
	/**
	 * The agent factory for in-process workers.
	 *
	 * When `useInProcess` is true, the pool calls `agent.createRuntime()`
	 * to build a fresh runtime per task. This is the same `PoolWorkerAgent`
	 * interface the child-process worker uses.
	 */
	agent?: PoolWorkerAgent;
	/**
	 * Workers, at most.
	 *
	 * Not a new number: the caller passes what the `capacity()` verdict already
	 * computes, divided by the slots. Inventing a second limit beside that one
	 * is how a machine that reads healthy starts swapping.
	 *
	 * A function, if the caller has one, and it is read on every hiring
	 * decision. As a fixed number it was a snapshot taken when the pool was
	 * built: a pool that happened to be created while the laptop was tight got
	 * `maxWorkers` 1 and stayed pinned there for the rest of the drive, long
	 * after the gate had reopened — every other consumer of `capacity()`
	 * re-reads it between tasks, and this was the one that did not.
	 */
	maxWorkers?: number | (() => number);
	/** A worker with nothing to do for this long is shut down. */
	idleMs?: number;
	/** A worker is retired after this many tasks, whatever their outcome. */
	maxTasksPerWorker?: number;
	/** How long a worker gets to boot the composition before it is written off. */
	bootTimeoutMs?: number;
	/** How long a cancelled task gets to stop before its worker is retired. */
	graceMs?: number;
	/**
	 * Below this fraction of memory free, admit one task at a time.
	 *
	 * The whole of the admission rule, and config rather than a literal because
	 * every number in this repo that decides behaviour is. Twenty percent is the
	 * point the laptop starts to lag — the same figure `capacity()` uses for its
	 * headroom floor, and deliberately the same, because two floors that
	 * disagree is how a fleet ends up throttled by whichever one nobody
	 * remembered.
	 */
	memoryFloor?: number;
	/**
	 * How free memory is read, for a caller that measures it better.
	 *
	 * `freemem() / totalmem()` is honest on Linux and close to useless on macOS,
	 * where it counts only wholly free pages and a healthy machine reads one
	 * percent. `capacity.ts` already knows how to ask `vm_stat` and
	 * `memory_pressure`; this is the seam it plugs into, and it is also what
	 * lets the admission rule be tested with a number instead of a machine.
	 */
	freeFraction?: () => number;
	/**
	 * The queue is a safety valve, not a buffer.
	 *
	 * There was no bound here at all: `run()` pushed and `pump()` drained, so a
	 * caller that submits faster than the fleet retires holds every prompt, every
	 * graph and every closure alive in this heap for as long as it takes. That is
	 * a memory leak with a queue's name on it. Sixty-four is well past anything
	 * `capacity()` will admit at once and far short of a number that matters.
	 */
	queueLimit?: number;
	/** How often a worker says it is alive. */
	heartbeatMs?: number;
	/** No word from a worker for this long and it is treated as dead. */
	heartbeatTimeoutMs?: number;
	/**
	 * A worker that died under a task gets it handed on this many more times.
	 *
	 * One. A task that takes a process down is likely to take the next one down
	 * too, and a pool that re-queues for ever turns one bad task into a machine
	 * that does nothing but boot. Counted rather than flagged so the number is
	 * visible and changeable, but the default is the old boolean's meaning
	 * exactly.
	 */
	maxRequeues?: number;
	/** How long `drain()` waits for work in flight before it kills. */
	drainTimeoutMs?: number;
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
	/** How many times a dying worker has already handed this task on. */
	requeues: number;
	settled?: boolean;
}

interface Worker {
	id: number;
	/** Child process for child-process workers. */
	child: ChildProcess;
	/** In-process worker — present when useInProcess is true. */
	inProcess?: InProcessWorker;
	slots: number;
	/** Tasks currently in flight here. */
	holding: Set<string>;
	/** Tasks this worker has ever been given. */
	lifetime: number;
	ready: boolean;
	retiring: boolean;
	/** When this worker last said anything at all. See `heartbeat`. */
	lastSeen: number;
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
	closed = false;
	/** Set when the row that made this pool went away while it was still busy. */
	private draining = false;
	/** Tasks that have settled here, ever. What "the pool did the work" means. */
	private served = 0;
	/** One sibling pool per distinct write scope. Usually exactly one: the planner's. */
	private readonly scoped = new Map<NonNullable<AgentOptions["confine"]>, AgentPool>();
	/** The one session being watched, as far as this pool knows. */
	private attention: string | null = null;
	/** One task at a time per session id. See `withSessionLock`. */
	private readonly sessionLocks = new Map<string, Promise<void>>();
	/** Looks for workers that have stopped saying anything. Runs only when hired. */
	private beat?: NodeJS.Timeout;
	/**
	 * Nothing may be spawned before this instant.
	 *
	 * Set when the OS refuses a process — `EMFILE`, `ENOMEM`. Without it `pump()`
	 * retries `hire()` on every settle, which under descriptor exhaustion is a
	 * spin that makes the exhaustion worse.
	 */
	private spawnBlockedUntil = 0;
	/**
	 * Taking nothing new, but still finishing what it has. See `drain`.
	 *
	 * Distinct from `closed`, which also stops `pump()` hiring — and a queued
	 * task whose worker is busy needs a new worker to reach one, so a drain that
	 * set `closed` could not actually drain its own queue.
	 */
	private stopping = false;

	constructor(options: PoolOptions) {
		this.options = options;
	}

	/**
	 * How much of this machine's memory is free, as a fraction.
	 *
	 * The caller's reading when it has one — `capacity.ts` asks `vm_stat` and
	 * `memory_pressure`, which is the only honest answer on darwin — and the
	 * arithmetic otherwise. A reading that throws or comes back as nonsense is
	 * treated as "no room", because guessing generously is how a laptop starts
	 * swapping and guessing at all is what this rule exists to stop.
	 */
	private free(): number {
		try {
			const asked = this.options.freeFraction?.();
			if (typeof asked === "number" && Number.isFinite(asked)) return Math.max(0, Math.min(1, asked));
			const total = totalmem();
			if (!total) return 0;
			return Math.max(0, Math.min(1, freemem() / total));
		} catch {
			return 0;
		}
	}

	/**
	 * How many workers may exist, and it is a memory question rather than an
	 * arithmetic one.
	 *
	 * Two static numbers used to answer this: `slots ?? 8` and `maxWorkers ?? 4`.
	 * Both were guesses about a machine neither of them had looked at, and a
	 * guess about a machine is wrong on every machine except the one it was
	 * written on. The OS already refuses what it cannot give — `EMFILE`,
	 * `ENOMEM`, and `hire()` catches both — so the only pre-emptive question
	 * worth asking is whether this machine is in trouble *now*: below the floor
	 * we do one thing at a time, above it we do not cap and let the work and the
	 * kernel decide.
	 *
	 * An explicit `maxWorkers` still wins, because a caller that has measured
	 * something outranks a rule that has not. `rlm-delegate` passes
	 * `capacity()`'s live verdict through it, so the fleet-wide budget is
	 * unaffected by any of this.
	 */
	private ceiling(): number {
		const asked = this.options.maxWorkers;
		const configured = typeof asked === "function" ? asked() : asked;
		if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
			return Math.max(1, Math.floor(configured));
		}
		return this.free() < (this.options.memoryFloor ?? 0.2) ? 1 : Number.MAX_SAFE_INTEGER;
	}

	/**
	 * Tasks one worker may hold at once.
	 *
	 * Said by the caller, or the same memory question again: one at a time while
	 * the machine is tight, uncapped while it is not. `maxTasksPerWorker` is
	 * what still bounds a worker's life, and it is a different question —
	 * memory-leak prevention, not concurrency.
	 */
	private get slots(): number {
		const asked = this.options.slots;
		if (typeof asked === "number" && Number.isFinite(asked) && asked > 0) return Math.max(1, Math.floor(asked));
		return this.free() < (this.options.memoryFloor ?? 0.2) ? 1 : Number.MAX_SAFE_INTEGER;
	}

	private get maxWorkers(): number {
		return this.ceiling();
	}

	private say(line: string) {
		this.options.log?.(`rlm-delegate pool: ${line}`);
	}

	/** Whether this pool is a corpse — a caller holding one must get a new one. */
	isClosed(): boolean {
		return this.closed;
	}
	status(): object {
		return { open: !this.closed };
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

	/**
	 * One session, one task at a time.
	 *
	 * A session is a transcript on disk and a conversation in memory, and two
	 * tasks appending to it at once do not produce two conversations — they
	 * produce one file with both halves of two different arguments in it. Nothing
	 * stopped that before: `sessionFor(graph, task)` is derived, so a retry, a
	 * planner call and a runner call can all name the same session, and the pool
	 * would hand them to whichever workers had room.
	 *
	 * The lock is per session id and it is a promise chain, not a flag: a waiter
	 * queues behind whatever is already there and the map entry is dropped only
	 * when the last waiter leaves, so the map is not a leak either.
	 */
	run(task: Task, graph: Graph, overrides: Partial<AgentOptions> = {}): Promise<string> {
		const sessionId = sessionFor(graph, task);
		return this.withSessionLock(sessionId, () => this.submit(task, graph, overrides, sessionId));
	}

	private withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((r) => (release = r));
		this.sessionLocks.set(sessionId, prev.then(() => next));
		return prev.then(async () => {
			try {
				return await fn();
			} finally {
				release();
				// Only if nothing queued behind it, or the next waiter's own entry
				// is deleted out from under it and two of them run together — which
				// is the exact thing this exists to stop.
				if (this.sessionLocks.get(sessionId) === next) this.sessionLocks.delete(sessionId);
			}
		});
	}

	private submit(task: Task, graph: Graph, overrides: Partial<AgentOptions>, sessionId: string): Promise<string> {
		const signal = overrides.signal ?? this.options.signal;
		const timeoutMs = overrides.timeoutMs ?? this.options.timeoutMs ?? 2_700_000;
		const onOutput = overrides.onOutput ?? this.options.onOutput;
		return new Promise<string>((resolve, reject) => {
			if (this.closed) return reject(new Error("the pool is closed"));
			if (this.stopping) return reject(new Error("the pool is draining and is not taking new work"));
			// Work arriving is the answer to "is anyone still using this": a pool
			// that was draining towards a close is wanted again, so it stops.
			this.draining = false;
			if (signal?.aborted) return reject(new Error("stopped before this attempt started"));
			// A queue nobody bounds is a heap nobody bounds. Refused loudly rather
			// than accepted and forgotten: the caller can re-offer the task, and
			// the graph on disk still owes it either way.
			const limit = this.options.queueLimit ?? 64;
			if (this.queue.length >= limit) {
				return reject(
					new Error(`the pool queue is full (${this.queue.length}/${limit}) — nothing was lost, offer it again`),
				);
			}
			const pending: Pending = {
				id: `t${nextTaskId++}`,
				task,
				graph,
				prompt: withCriterion(task),
				sessionId,
				timeoutMs,
				signal,
				onOutput,
				resolve,
				reject,
				requeues: 0,
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
				inProcess: !!w.inProcess,
				ready: w.ready,
				holding: w.holding.size,
				lifetime: w.lifetime,
				retiring: w.retiring,
			})),
			queued: this.queue.length,
			inFlight: this.inFlight.size,
			served: this.served,
			closed: this.closed,
			watching: this.attention,
			confined: [...this.scoped.values()].map((p) => p.stats()),
		};
	}

	/**
	 * Stop — but not out from under work that is still running.
	 *
	 * `close()` is the right answer when nothing is in flight and the wrong one
	 * when something is. The row's teardown fires on every hot reload, and a
	 * sweep already in progress is *not* torn down with the row that started it:
	 * `driveGraphs` is an async call already in the air. So the teardown was
	 * taking the pool away from a drive that was still using it, and every task
	 * that drive submitted afterwards was refused with "the pool is closed" —
	 * 883 of them across 42 graphs in the store at the time this was found, each
	 * one a task that had a warm worker available and was told there was none.
	 *
	 * So: close now if there is nothing to lose, and otherwise close when the
	 * last task settles. A `run()` arriving in the meantime cancels the drain,
	 * because work arriving is the answer to "is anybody still using this".
	 */
	closeWhenIdle(): void {
		if (this.closed) return;
		if (!this.inFlight.size && !this.queue.length) {
			void this.close().catch(() => {});
			return;
		}
		this.draining = true;
		this.say(`asked to stop with ${this.inFlight.size} in flight and ${this.queue.length} queued — finishing those first`);
		for (const sibling of this.scoped.values()) sibling.closeWhenIdle();
	}

	/**
	 * Stop taking work, let what is running finish, and only then kill.
	 *
	 * The disposer's answer, and not the same as `close()`. A row unloading is
	 * not a reason to take a forty-minute agent turn away from the graph that is
	 * waiting on it — but it is also not a licence to wait for ever, so the wait
	 * is bounded and the two outcomes are named out loud, because "unload
	 * orphaned the fleet" and "unload waited politely" look identical in a log
	 * that only says "closed".
	 */
	async drain(timeoutMs?: number): Promise<"drained" | "timed-out"> {
		const limit = Math.max(0, timeoutMs ?? this.options.drainTimeoutMs ?? 30_000);
		if (this.closed) return "drained";
		// `stopping`, not `closed`. Refusing new work and refusing to hire are two
		// different decisions, and conflating them is how a drain fails to drain:
		// a queued task whose worker is busy needs a *new* worker to reach one, and
		// `pump()` will not start one while `closed`. So this pool takes nothing
		// new and still finishes everything it already accepted.
		this.stopping = true;
		this.say(`draining — ${this.inFlight.size} in flight, ${this.queue.length} queued, ${limit}ms to finish`);
		const deadline = Date.now() + limit;
		while ((this.inFlight.size || this.queue.length) && Date.now() < deadline) {
			await new Promise<void>((r) => {
				const t = setTimeout(r, 50);
				t.unref?.();
			});
		}
		const outcome = this.inFlight.size || this.queue.length ? "timed-out" : "drained";
		this.stopping = false;
		this.say(
			outcome === "drained"
				? "drained — everything in flight finished before the workers were let go"
				: `drain timed out after ${limit}ms with ${this.inFlight.size} in flight and ${this.queue.length} queued — killing anyway`,
		);
		await Promise.all([...this.scoped.values()].map((p) => p.drain(Math.max(0, deadline - Date.now()))));
		await this.close();
		return outcome;
	}

	/** Let go of every worker. Anything still queued is failed, not forgotten. */
	async close(): Promise<void> {
		this.closed = true;
		if (this.beat) {
			clearInterval(this.beat);
			this.beat = undefined;
		}
		for (const pending of [...this.queue]) this.settle(pending, new Error("the pool was closed"));
		this.queue.length = 0;
		for (const worker of [...this.workers]) this.retire(worker, "the pool was closed");
		// The chains are per session and every one of them has settled by now, or
		// its task was just failed above. Holding them would be a map that only
		// grows across reloads.
		this.sessionLocks.clear();
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
			Date.now() >= this.spawnBlockedUntil &&
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
			this.served += 1;
			pending.worker.holding.delete(pending.id);
			this.maybeReap(pending.worker);
		}
		if (error) pending.reject(error);
		else pending.resolve(text ?? "");
		this.pump();
		// The row asked to stop while this was still running. Now it is not.
		if (this.draining && !this.inFlight.size && !this.queue.length) {
			this.draining = false;
			void this.close().catch(() => {});
		}
	}

	// ─── Workers ─────────────────────────────────────────────────────────────

	private hire(): Worker | undefined {
		// In-process workers: run tasks in the host process, sharing the
		// composition's ctx and rlmAgent service. Default when useInProcess
		// is not explicitly false and the required ctx/agent are available.
		const useInProcess = this.options.useInProcess ?? true;
		if (useInProcess && this.options.ctx && this.options.agent && !this.options.confine) {
			return this.hireInProcess();
		}
		return this.hireChild();
	}

	/** Hire an in-process worker — no child process spawned. */
	private hireInProcess(): Worker | undefined {
		const inProc = new InProcessWorker({
			ctx: this.options.ctx,
			agent: this.options.agent!,
			cwd: this.options.cwd ?? process.cwd(),
			slots: this.slots,
			heartbeatMs: this.options.heartbeatMs ?? 5_000,
		});
		const child = inProc.getChild();
		const worker: Worker = {
			id: nextWorkerId++,
			child: child as unknown as ChildProcess,
			inProcess: inProc,
			slots: this.slots,
			holding: new Set(),
			lifetime: 0,
			ready: false,
			retiring: false,
			lastSeen: Date.now(),
			tail: [],
		};
		this.workers.add(worker);
		this.heartbeat();

		const boot = setTimeout(() => {
			if (worker.ready) return;
			this.say(`worker ${worker.id} never booted`);
			this.retire(worker, "it never finished booting");
		}, this.options.bootTimeoutMs ?? 120_000);
		boot.unref?.();

		// Wire message handling — same as child-process path
		child.on("message", (raw: unknown) => this.heard(worker, raw as PoolReply, boot));
		child.on("exit", (code, signal) => {
			clearTimeout(boot);
			this.lost(worker, `it exited ${signal ? `on ${signal}` : code}`);
		});

		// Start the worker — emits "ready" immediately
		inProc.start();
		return worker;
	}

	/** Hire a child-process worker — the original spawn-based path. */
	private hireChild(): Worker | undefined {
		// The same decisions `agent.ts` makes, in the same function, so a worker
		// and a one-shot can never be started differently by accident: skip rlm's
		// re-exec (a launcher that does nothing but exec and wait measured 28 MB),
		// hand the interpreter its sizing flags, and under bun leave out the tsx
		// loader it does not need and the `--expose-internals` it does not have.
		const { command, prefix } = planLaunch(this.options);
		// The heartbeat interval goes down the command line beside the slots, so a
		// worker and the parent watching it can never disagree about how often it
		// is supposed to speak — which is the only way a timeout means anything.
		const plain = [
			...prefix,
			this.options.entry,
			"--headless",
			"--pool-worker",
			"--slots",
			String(this.slots),
			"--heartbeat-ms",
			String(Math.max(250, this.options.heartbeatMs ?? 5_000)),
		];
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
			this.refused(error);
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
			lastSeen: Date.now(),
			tail: [],
		};
		this.workers.add(worker);
		this.heartbeat();

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
			// `spawn` reports some refusals asynchronously, so the descriptor and
			// memory cases have to be recognised on this path too, or the cooldown
			// only ever arms half the time.
			this.refused(error, worker.id);
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
		// Anything at all counts as a sign of life; the heartbeat is only what a
		// worker says when it has nothing else to say.
		worker.lastSeen = Date.now();
		if (message.type === "heartbeat") return;
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
			if (pending.requeues >= (this.options.maxRequeues ?? 1)) {
				this.settle(
					pending,
					new Error(`the worker died ${pending.requeues + 1} time(s) under this task — ${why}\n${tail}`),
				);
				continue;
			}
			// Nothing is coming back for it: a closed pool starts no more
			// workers, so re-queueing here would leave the caller waiting on a
			// promise that can never settle.
			if (this.closed) {
				this.settle(pending, new Error(`the pool was closed while this was running — ${why}`));
				continue;
			}
			pending.requeues += 1;
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
		// In-process workers are disposed via the InProcessWorker, not signals.
		if (worker.inProcess) {
			// Give it a moment to drain, then dispose.
			const term = setTimeout(() => worker.inProcess?.dispose(), 250);
			term.unref?.();
			worker.child.once("exit", () => clearTimeout(term));
			return;
		}
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

	/**
	 * Watch for workers that have stopped saying anything.
	 *
	 * A pid that exists is not a worker that works. Wedged in a native call,
	 * swapping, or spinning inside a tool that never returns, a worker holds its
	 * tasks and answers nothing, and until this existed the only bound on that
	 * was the per-task timeout — forty-five minutes by default, because it is
	 * sized for a real agent turn rather than for a corpse.
	 *
	 * One timer for the whole pool, started when the first worker is hired and
	 * stopped when the last one goes, and `unref`'d so it can never be the reason
	 * a process stays up. Killing the worker is the whole of the repair: `exit`
	 * reaches `lost()`, which re-queues what it was holding exactly as it does
	 * for any other death, and the session lock is released by the task's own
	 * `finally` when it eventually settles.
	 */
	private heartbeat() {
		if (this.beat) return;
		const every = Math.max(250, this.options.heartbeatMs ?? 5_000);
		const dead = Math.max(every * 2, this.options.heartbeatTimeoutMs ?? 15_000);
		this.beat = setInterval(() => {
			if (!this.workers.size) {
				clearInterval(this.beat);
				this.beat = undefined;
				return;
			}
			const now = Date.now();
			for (const worker of [...this.workers]) {
				// A worker still booting is bounded by `bootTimeoutMs`, which is a
				// different and much longer question — it has not promised to
				// speak yet.
				if (!worker.ready || worker.retiring) continue;
				const silent = now - worker.lastSeen;
				if (silent <= dead) continue;
				this.say(
					`worker ${worker.id} has said nothing for ${silent}ms (${dead}ms is the bound) — treating it as dead`,
				);
				this.retire(worker, `it stopped answering for ${silent}ms`);
			}
		}, every);
		this.beat.unref?.();
	}

	/**
	 * The OS said no. Stop asking for a bit.
	 *
	 * `EMFILE` and `ENOMEM` are the two refusals a fleet actually meets, and both
	 * get worse the harder you retry: `pump()` calls `hire()` again on every
	 * settle, so without a cooldown descriptor exhaustion becomes a spin that
	 * consumes the descriptors freed by the tasks finishing. Nothing is lost —
	 * whatever was queued stays queued and is handed to the next worker that has
	 * room, or to a new one once the cooldown lapses.
	 */
	private refused(error: any, workerId?: number) {
		const code = String(error?.code ?? "");
		const who = workerId === undefined ? "a worker" : `worker ${workerId}`;
		if (code === "EMFILE" || code === "ENFILE" || code === "ENOMEM") {
			this.spawnBlockedUntil = Date.now() + 5_000;
			this.say(
				`the OS refused ${who} with ${code} — not starting another for 5s; ${this.queue.length} task(s) stay queued`,
			);
			return;
		}
		// Every other refusal gets the same cooldown. A missing or unrunnable
		// interpreter (`ENOENT`, `EACCES`) fails instantly, so without one `pump()`
		// re-hires on the same tick and the loop never yields — the process spins
		// on spawns and no timer, close or settle ever runs.
		this.spawnBlockedUntil = Date.now() + 5_000;
		this.say(`could not start ${who}: ${error?.message ?? error} — not starting another for 5s`);
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
export const pooledAgent = (
	options: PoolOptions,
): Runner & { pool: AgentPool; close: () => Promise<void>; drain: (ms?: number) => Promise<"drained" | "timed-out"> } => {
	const pool = new AgentPool(options);
	const runner = pool.runner() as Runner & {
		pool: AgentPool;
		close: () => Promise<void>;
		drain: (ms?: number) => Promise<"drained" | "timed-out">;
	};
	runner.pool = pool;
	runner.close = () => pool.close();
	// The disposer's answer, and the one a row should reach for: `close()` takes
	// the workers away from whatever they are holding, `drain()` gives that work
	// a bounded chance to finish first.
	runner.drain = (ms?: number) => pool.drain(ms);
	return runner;
};
