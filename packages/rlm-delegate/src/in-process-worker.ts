/**
 * In-process worker — runs pool tasks in the host process instead of
 * spawning a child.
 *
 * ## Why this exists
 *
 * The pool's child-process workers pay ~143 MB per worker for the boot
 * (module code loaded to be *ready* to do a task). For many workloads the
 * composition is already loaded in the host process — the rlmAgent service,
 * the coding-agent framework, the tool registry — so spawning a child to
 * hold a second copy of all of it is pure overhead.
 *
 * The in-process worker runs tasks using the same `runOne` logic as the
 * child-process worker, but in the host's event loop. It shares the
 * composition's `ctx` and the `rlmAgent` service. The marginal cost of a
 * task is its messages, tool results, and live heap — not a second copy
 * of the framework.
 *
 * ## The contract is the same
 *
 * The pool communicates with workers via `send`/`onMessage` — the same
 * wire protocol as child-process workers. This file provides an
 * `InProcessWorker` that simulates that interface:
 *
 *   - `send(message)` dispatches to the worker's message handler
 *   - `onMessage` is the callback the pool sets to receive replies
 *   - `pid` is the host process's pid
 *   - `kill(sig)` and `once("exit", cb)` simulate process lifecycle
 *
 * The pool's `hire()`, `heard()`, `lost()`, `retire()` all work unchanged.
 *
 * ## Isolation
 *
 * Each task gets its own `AgentSessionRuntime` — its own session, services,
 * tool registry, and connection. Tasks are isolated at the session level,
 * not the process level. A task that corrupts its own state cannot affect
 * another task's session, but a task that corrupts the *process* (e.g. by
 * overwriting a global) can. For crash-prone or untrusted tasks, use the
 * child-process fallback (`useInProcess: false` in `PoolOptions`).
 */
import type { PoolReply, PoolRequest, WorkerBound } from "./pool.ts";
import type { PoolWorkerAgent } from "./pool-worker.ts";
import { runOne, type Live } from "./pool-worker.ts";

/**
 * A simulated child-process interface for in-process workers.
 *
 * The pool's `Worker` type has `child: ChildProcess`. This class provides
 * the subset of that interface the pool actually uses:
 *
 *   - `send(message)` — dispatch to the worker
 *   - `on("message", cb)` — receive replies
 *   - `on("exit", cb)` — lifecycle (fires on retire)
 *   - `kill(sig)` — no-op (in-process; cancel is via IPC)
 *   - `pid` — host process pid
 *   - `stdout`/`stderr` — captured (in-process; no real streams)
 */
export class InProcessChild {
	readonly pid: number;
	private messageHandler: ((message: PoolReply) => void) | null = null;
	private exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
	private readonly stdout = { on: () => {} };
	private readonly stderr = { on: () => {} };

	constructor() {
		this.pid = process.pid;
	}

	send(message: WorkerBound): void {
		// Dispatch synchronously — the pool's tell() calls this.
		// The actual processing happens in the InProcessWorker.
		this.onSend?.(message);
	}

	on(event: string, handler: any): void {
		if (event === "message") this.messageHandler = handler;
		else if (event === "exit") this.exitHandler = handler;
	}

	once(event: string, handler: any): void {
		if (event === "exit") {
			this.exitHandler = (code, signal) => {
				this.exitHandler = null;
				handler(code, signal);
			};
		}
	}

	kill(_sig?: NodeJS.Signals): void {
		// In-process workers are stopped via IPC (cancel/retire), not signals.
		// This is a no-op to satisfy the interface.
	}

	emitExit(code: number = 0): void {
		this.exitHandler?.(code, null);
	}

	emitMessage(message: PoolReply): void {
		this.messageHandler?.(message);
	}

	/** Set by the InProcessWorker to receive messages from the pool. */
	onSend?: (message: WorkerBound) => void;

	get stdout$() { return this.stdout; }
	get stderr$() { return this.stderr; }
}

/**
 * An in-process pool worker.
 *
 * Manages task execution in the host process. Each task gets its own
 * `AgentSessionRuntime` via the shared `PoolWorkerAgent`. The worker
 * multiplexes multiple tasks up to `slots`.
 */
export class InProcessWorker {
	private readonly ctx: any;
	private readonly agent: PoolWorkerAgent;
	private readonly cwd: string;
	readonly slots: number;
	private readonly heartbeatMs: number;
	private readonly live = new Map<string, Live>();
	private readonly child: InProcessChild;
	private watched: string | null = null;
	private closing = false;
	private beat?: NodeJS.Timeout;

	constructor(opts: {
		ctx: any;
		agent: PoolWorkerAgent;
		cwd: string;
		slots: number;
		heartbeatMs?: number;
	}) {
		this.ctx = opts.ctx;
		this.agent = opts.agent;
		this.cwd = opts.cwd;
		this.slots = opts.slots;
		this.heartbeatMs = opts.heartbeatMs ?? 5_000;

		this.child = new InProcessChild();
		this.child.onSend = (message) => this.handleMessage(message);
	}

	/** The simulated child process — the pool stores this on `Worker.child`. */
	getChild(): InProcessChild {
		return this.child;
	}

	/** Start the worker — emit "ready" immediately (composition is already loaded). */
	start(): void {
		// Start heartbeat
		if (this.heartbeatMs > 0) {
			this.beat = setInterval(() => {
				this.child.emitMessage({ type: "heartbeat", id: String(process.pid), ts: Date.now() });
			}, this.heartbeatMs);
			this.beat.unref?.();
		}
		// Emit ready — the composition is already booted in-process
		this.child.emitMessage({ type: "ready", pid: process.pid, slots: this.slots });
	}

	/** Stop the worker — dispose all live tasks and stop the heartbeat. */
	dispose(): void {
		if (this.beat) {
			clearInterval(this.beat);
			this.beat = undefined;
		}
		this.closing = true;
		// Dispose all live tasks
		for (const [, live] of this.live) {
			live.dispose().catch(() => {});
		}
		this.live.clear();
		this.child.emitExit(0);
	}

	private handleMessage(message: WorkerBound): void {
		if (!message || typeof message !== "object") return;
		if (message.type === "task") return this.startTask(message);
		if (message.type === "cancel") {
			this.live.get(message.id)?.cancel().catch(() => {});
			return;
		}
		if (message.type === "attend") {
			this.watched = message.sessionId;
			this.applyAttention();
			return;
		}
		if (message.type === "retire") {
			this.closing = true;
			if (this.live.size === 0) this.dispose();
			return;
		}
	}

	private startTask(request: PoolRequest): void {
		if (this.live.size >= this.slots) {
			this.child.emitMessage({ type: "done", id: request.id, ok: false, text: "", error: "the worker was already full" });
			return;
		}
		// Reserve the slot before the first await
		this.live.set(request.id, { sessionId: request.sessionId, cancel: async () => {}, dispose: async () => {} });
		if (this.watched === request.sessionId) this.applyAttention();

		void runOne(
			this.ctx,
			request,
			this.cwd,
			(handle: Live) => {
				this.live.set(request.id, handle);
				if (this.watched === handle.sessionId) this.applyAttention();
			},
			(text: string) => this.child.emitMessage({ type: "chunk", id: request.id, text }),
			this.agent,
		).then(
			(result) => this.settle(request.id, result),
			(error: any) => this.settle(request.id, { ok: false, text: "", error: String(error?.stack ?? error?.message ?? error) }),
		);
	}

	private settle(id: string, result: { ok: boolean; text: string; error?: string }): void {
		const held = this.live.get(id);
		this.live.delete(id);
		held?.dispose().catch(() => {});
		this.child.emitMessage({ type: "done", id, ...result });
		if (this.watched !== null && held?.sessionId === this.watched) this.applyAttention();
		if (this.closing && this.live.size === 0) this.dispose();
	}

	private applyAttention(): void {
		const mine = this.watched !== null && [...this.live.values()].some((l) => l.sessionId === this.watched) ? this.watched : null;
		const headless = this.ctx.get?.("rlmHeadless") as { attend?: (id: string | null) => unknown } | undefined;
		try {
			headless?.attend?.(mine);
		} catch {
			// headless service may not be available
		}
		this.child.emitMessage({ type: "attention", watching: this.watched });
	}
}
