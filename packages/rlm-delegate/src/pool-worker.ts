/**
 * The other half of the pool: one long-lived process that boots the
 * composition once and then does tasks until it is told to stop.
 *
 * ## Why this exists
 *
 * A delegated child was one process per task. Sampled every 700 ms from spawn
 * to exit, a real one reads:
 *
 *     t(s)   RSS   footprint
 *      0.7   114      80
 *      1.4   143     101     <- fully booted
 *      2.1   144     103
 *      2.8   144     103
 *      3.5   143      96
 *      4.2   144      86     <- the model call happened in here
 *
 * It reaches its peak at 1.4 s and is flat through the actual work. The task
 * costs approximately nothing; every megabyte is module code loaded to be
 * *ready* to do a task, thrown away five seconds later, and loaded again by
 * the next child. Twenty children are not twenty workloads, they are the same
 * program loaded twenty times.
 *
 * So the fixed cost is paid once, here, and the marginal cost of task N is its
 * messages, its tool results and its live heap — which the flat part of that
 * curve says is small.
 *
 * ## Why it is a mode and not a second entry point
 *
 * `cordis-shell.mjs` is the only thing that can boot the composition, and its
 * own header says it should need editing as rarely as possible. A mode is the
 * seam it already offers for "what is this invocation" — `rlm-delegate` already
 * registers `drive`, `tasks` and `lesson` the same way, so a worker is one more
 * of those and costs the host file nothing.
 *
 * ## Why not `runPrintMode`
 *
 * Print mode writes the answer to raw stdout and installs process-wide signal
 * handlers that call `process.exit`. Both are correct for a process that exists
 * to answer one question and die, and both are wrong here: with more than one
 * task in flight the answers interleave on one stream and cannot be told apart,
 * and a signal meant for one task would take the others with it.
 *
 * So the task loop drives `InProcessAgentConnection` directly — which is what
 * print mode drives — and reads the answer out of the messages with the same
 * `selectHeadlessTerminalResult` print mode uses, so the text a task returns is
 * chosen by the same code that chose it before. The answer goes back over the
 * IPC channel, addressed to the task that asked.
 *
 * ## What is fresh per task, and what is not
 *
 * Fresh: the `SessionManager` (its own file, named by the task's stable session
 * id, so attempt two resumes attempt one), the services, the tool registry, the
 * `AgentSession`, and the connection — `createRuntime` builds all of it, and
 * `dispose()` takes all of it away again. The working directory is restored
 * afterwards, because a `code` cell may have moved it.
 *
 * Not fresh, and this is the honest limit: the composition itself. Rows are
 * mounted once and whatever state a row keeps — a cache, a counter, a warmed
 * index — persists across tasks in one worker, exactly as it persists across
 * turns in an interactive session. A task can also do anything to its worker
 * that any program can do to its own process, because the `code` tool is a vm
 * with `require` in scope. That is bounded by retiring workers rather than
 * pretended away: see `pool.ts`.
 *
 * ## Attention
 *
 * One worker holds many sessions, so "somebody is watching" is not a fact about
 * this process any more. The pool tells every worker which single session in
 * the whole fleet is being watched; a worker that is holding it says so to
 * `rlmHeadless`, and a worker that is not says nothing is. That is what makes
 * exactly one agent live at a time — the delegator, or one of the nine hundred
 * subagents, never both — and lets it move without restarting anything.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PoolReply, PoolRequest, WorkerBound } from "./pool.ts";
import type { AgentSessionRuntime, SessionManager } from "../../rlm-agent/src/index.ts";

/**
 * What this file actually needs from the agent, and nothing else.
 *
 * It used to say `Runner` — `(task, graph) => Promise<string>` from
 * `scheduler.ts` — while `runOne` called `agent.createRuntime(...)`, which no
 * `Runner` has. The two were never the same thing and the type said they were,
 * so `index.ts` handed the mode the `rlmAgent` *factory* from `agent.ts` and
 * every pooled task would have died on `agent.createRuntime is not a function`
 * with the compiler perfectly happy about it.
 *
 * Structural rather than the whole `RlmAgentService` because that is the honest
 * requirement: the worker needs one method. The two types it is written in
 * terms of come from `@rlm/agent` itself, so there is one definition of what a
 * runtime is and this file cannot drift from it.
 */
export interface PoolWorkerAgent {
	createRuntime(options: { sessionManager?: SessionManager }): Promise<AgentSessionRuntime>;
}

/** Names this invocation as a worker rather than a question. */
export const POOL_WORKER_FLAG = "--pool-worker";

/**
 * How many tasks one worker may hold at once, when the parent does not say.
 *
 * The parent always says. This is only here so the mode can be run by hand.
 */
const DEFAULT_SLOTS = 8;

export interface Live {
	/** Ask the agent to stop, in-process, without touching the other tasks. */
	cancel(): Promise<void>;
	/** Let go of everything this task holds. */
	dispose(): Promise<void>;
	/** Which session this task is running as. */
	sessionId: string;
}

/**
 * A `SessionManager` of this task's own, pointed at this task's own file.
 *
 * This is what makes `sessionFor(graph, task)` mean anything. Until now the id
 * was passed on the command line as `--session-id` and read by nobody on this
 * path — `main.ts` parses it into `PRIME_AGENT_SESSION_ID`, and `main.ts` is
 * not the entry point a delegated child uses — so every retry started from
 * nothing while the flag looked implemented from every angle except the one
 * that mattered. That is lesson `reads-nobody`, and it is in the seed list.
 *
 * Here the id names a file. If the file is there the session is resumed with
 * everything attempt one left in it; if it is not, a session is started under
 * that name so attempt two can find it.
 *
 * Exported so the in-process worker can reuse the same session resolution.
 */
export const sessionManagerFor = async (cwd: string, sessionId: string) => {
	const { SessionManager, getDefaultSessionDir } = await import("../../coding-agent/src/core/session-manager.js");
	const dir = getDefaultSessionDir(cwd);
	const file = join(dir, `${sessionId}.jsonl`);
	const manager = SessionManager.create(cwd, dir);
	if (existsSync(file)) manager.setSessionFile(file);
	else {
		try {
			manager.newSession({ id: sessionId });
		} catch {
			// Lost a race with something else naming the same session. Resuming
			// the file that now exists is the same outcome by the other route.
			if (existsSync(file)) manager.setSessionFile(file);
		}
	}
	return manager;
};

/**
 * Run one task to an answer, the way print mode would have.
 *
 * The `ok` it returns is print mode's exit code reduced to a boolean, computed
 * from the same three things: the terminal message's stop reason, a failed
 * compaction, and the autonomous quality gate.
 *
 * Exported so the in-process worker can reuse the same task execution logic
 * without spawning a child process.
 */
export const runOne = async (
	ctx: any,
	request: PoolRequest,
	cwd: string,
	register: (live: Live) => void,
	onChunk: (text: string) => void,
	agent: PoolWorkerAgent,
): Promise<{ ok: boolean; text: string; error?: string }> => {


	const [
		{ InProcessAgentConnection },
		{ selectHeadlessTerminalResult, latestAutonomousGateAttempt },
		{ autonomousLimitReason },
	] = await Promise.all([
		import("../../coding-agent/src/modes/agent-connection/in-process-agent-connection.js"),
		import("../../coding-agent/src/modes/headless-completion.js"),
		import("../../coding-agent/src/core/autonomous.js"),
	]);

	const sessionManager = await sessionManagerFor(cwd, request.sessionId);
	const runtime = await agent.createRuntime({ sessionManager });
	const connection = new InProcessAgentConnection(runtime);

	let disposed = false;
	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		try {
			await connection.dispose();
		} catch {
			/* a task that could not let go is still a task that is over */
		}
	};
	register({
		sessionId: request.sessionId,
		// In-process, and only this task's. `requestAbort()` stops the turn and
		// `abortBash()` stops whatever command it is inside; neither reaches
		// another task's session, which is the whole reason a runaway task does
		// not have to be stopped by ending the process.
		cancel: async () => {
			try {
				await connection.abort();
			} catch {
				/* nothing to abort */
			}
			try {
				await connection.abortBash();
			} catch {
				/* nothing running */
			}
		},
		dispose,
	});

	const errors: string[] = [];
	try {
		const unsubscribe = connection.subscribe((event: any) => {
			if (event?.type === "extension_error") errors.push(`Extension error (${event.extensionPath}): ${event.error}`);
		});
		try {
			await connection.bindHeadlessExtensions();
			await connection.promptAndWait(request.prompt);
			const status = await connection.waitForHeadlessCompletion();

			let ok = true;
			const parts: string[] = [];
			const { primary, compactionOutcomes } = selectHeadlessTerminalResult(await connection.getMessages());
			if (primary?.role === "assistant") {
				if (primary.stopReason === "error" || primary.stopReason === "aborted") {
					ok = false;
					errors.push(primary.errorMessage || `Request ${primary.stopReason}`);
				} else {
					for (const content of primary.content) if (content.type === "text") parts.push(content.text);
				}
			} else if (primary) {
				parts.push(String((primary as any).content));
				if (!(primary as any).details?.success || (primary as any).details?.severity === "error") ok = false;
			}
			for (const outcome of compactionOutcomes) {
				errors.push(String(outcome.content));
				if (outcome.details.outcome === "failed") ok = false;
			}

			const limit = autonomousLimitReason(status);
			if (status.enabled && status.gates.commands.length > 0 && status.lastGateFailure) {
				ok = false;
				errors.push(
					`Autonomous quality gate still failing after attempt ${latestAutonomousGateAttempt(status)}/${status.gates.maxRetries}: ${status.lastGateFailure.exitText}`,
				);
			} else if (status.enabled && status.gates.commands.length === 0 && limit) {
				ok = false;
				errors.push(`Autonomous run stopped before terminal evidence; ${limit}`);
			}

			const text = parts.join("\n");
			if (text) onChunk(text);
			return { ok, text, ...(errors.length ? { error: errors.join("\n") } : {}) };
		} finally {
			unsubscribe();
		}
	} finally {
		await dispose();
	}
};

export interface PoolWorkerOptions {
	agent: PoolWorkerAgent;
	/** How many tasks may be in flight here at once. */
	slots?: number;
	/** Where tasks run. Defaults to where the worker was started. */
	cwd?: string;
	/**
	 * How often to say "still here", in milliseconds. `0` switches it off.
	 *
	 * The parent's only other evidence is the pid, and a pid is not a worker: a
	 * process wedged in a native call or spinning inside a tool that never
	 * returns holds its tasks and answers nothing. This is a message on a channel
	 * the event loop has to reach to send, so it stops arriving exactly when the
	 * loop stops turning.
	 */
	heartbeatMs?: number;
}

/**
 * The loop. Resolves with an exit code when the parent goes away.
 *
 * The IPC channel is what keeps the process alive; there is no timer and no
 * poll. When the parent disconnects — because it retired this worker, or
 * because it died — the loop ends and the host disposes the composition.
 */
export const runPoolWorker = async (ctx: any, options: PoolWorkerOptions): Promise<number> => {
	const send = (message: PoolReply) => {
		try {
			process.send?.(message);
		} catch {
			/* the parent has gone; the disconnect handler is about to fire */
		}
	};
	if (!process.send) {
		console.error("[rlm] pool-worker: there is no IPC channel — this mode is only meaningful under the pool");
		return 2;
	}

	const { agent } = options;
	const cwd = options.cwd ?? process.cwd();
	const slots = Math.max(1, options.slots ?? DEFAULT_SLOTS);
	const beatMs = options.heartbeatMs ?? 5_000;
	const live = new Map<string, Live>();
	/** The directory tasks are supposed to run in, restored if one moves it. */
	const home = process.cwd();
	/** The single session the whole fleet is watching, as last told. */
	let watched: string | null = null;

	let closing = false;
	let done!: (code: number) => void;
	const finished = new Promise<number>((resolve) => {
		done = resolve;
	});

	/**
	 * Tell the headless row whether anything *here* is being watched.
	 *
	 * The pool names one session for the whole fleet. This worker is live only
	 * if that session is one of its own, so nine hundred subagents in a dozen
	 * workers cost nothing while one of them is open.
	 */
	const applyAttention = () => {
		const mine = watched !== null && [...live.values()].some((l) => l.sessionId === watched) ? watched : null;
		const headless = ctx.get?.("rlmHeadless") as { attend?: (id: string | null) => unknown } | undefined;
		try {
			headless?.attend?.(mine);
		} catch (error: any) {
			console.error(`[rlm] pool-worker: could not move attention — ${error?.message ?? error}`);
		}
		send({ type: "attention", watching: watched });
	};

	const settle = async (id: string, reply: Omit<Extract<PoolReply, { type: "done" }>, "type" | "id">) => {
		const held = live.get(id);
		live.delete(id);
		await held?.dispose().catch(() => {});
		if (process.cwd() !== home) {
			try {
				process.chdir(home);
			} catch {
				/* the directory it moved to is gone; the next task will notice */
			}
		}
		send({ type: "done", id, ...reply });
		// The watched session may have been this one. Nothing here is live now.
		if (watched !== null && held?.sessionId === watched) applyAttention();
		if (closing && live.size === 0) done(0);
	};

	const start = (request: PoolRequest) => {
		if (live.size >= slots) {
			send({ type: "done", id: request.id, ok: false, text: "", error: "the worker was already full" });
			return;
		}
		// Reserve the slot before the first await, or two requests arriving in
		// one tick both see room that only one of them has.
		live.set(request.id, { sessionId: request.sessionId, cancel: async () => {}, dispose: async () => {} });
		if (watched === request.sessionId) applyAttention();
		void runOne(
			ctx,
			request,
			cwd,
			(handle) => {
				live.set(request.id, handle);
				if (watched === handle.sessionId) applyAttention();
			},
			(text) => send({ type: "chunk", id: request.id, text }),
			agent)
			.then(
			(result) => settle(request.id, result),
			(error: any) =>
				settle(request.id, { ok: false, text: "", error: String(error?.stack ?? error?.message ?? error) }),
		);
	};

	process.on("message", (raw: any) => {
		const message = raw as WorkerBound;
		if (!message || typeof message !== "object") return;
		if (message.type === "task") return start(message);
		if (message.type === "cancel") {
			void live.get(message.id)?.cancel().catch(() => {});
			return;
		}
		if (message.type === "attend") {
			watched = message.sessionId;
			applyAttention();
			return;
		}
		if (message.type === "retire") {
			closing = true;
			if (live.size === 0) done(0);
			return;
		}
	});

	// The parent went away. Nothing here is worth finishing without it.
	process.on("disconnect", () => done(0));

	/**
	 * A task that takes the worker down must not look like a task that answered.
	 *
	 * Nothing can be trusted about this process afterwards, so every task in
	 * flight is failed by name and the worker exits rather than carrying on with
	 * a heap something has already been wrong in. The pool re-queues them once.
	 */
	for (const fault of ["uncaughtException", "unhandledRejection"] as const) {
		process.on(fault, (error: any) => {
			const why = `the worker hit an ${fault}: ${String(error?.stack ?? error)}`;
			for (const id of [...live.keys()]) send({ type: "done", id, ok: false, text: "", error: why, worker: "lost" });
			send({ type: "fatal", error: why });
			done(1);
		});
	}

	// Unref'd: the IPC channel is what keeps this process alive, and a timer that
	// held the loop open would turn a retired worker into one that will not go.
	const beat =
		beatMs > 0
			? setInterval(() => send({ type: "heartbeat", id: String(process.pid), ts: Date.now() }), beatMs)
			: undefined;
	beat?.unref?.();

	send({ type: "ready", pid: process.pid, slots });
	try {
		return await finished;
	} finally {
		if (beat) clearInterval(beat);
	}
};

export default runPoolWorker;
