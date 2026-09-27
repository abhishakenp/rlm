/**
 * @rlm/inflight — work that outlives the process it started in.
 *
 * Every session, root or subagent, in the TUI, in `--print`, or in a daemon
 * worker, gets this extension through the shared factory registry. It keeps the
 * journal beside the session file current (open / busy), and when a session is
 * opened it looks at what the last owner left behind:
 *
 *   - a turn that was running when its process died → the session is woken with
 *     an <rlm_interrupted> notice and continues; its interrupted subagents are
 *     resumed too, each in its own headless process, which recurses to theirs;
 *   - results waiting in its inbox → delivered as messages and a turn is run.
 *
 * And when a subagent that is NOT being run by a live parent (resumed by hand
 * from `rlm -r`, or resumed after a crash) finishes a turn, its answer is posted
 * to the parent's inbox; if the parent is not running anywhere it is revived
 * headless with the result as its prompt, which recurses upward to the root.
 *
 * A child run in-process by a live parent is left alone — the parent already
 * receives its result in memory, and posting it again would deliver it twice.
 *
 * All the state is on disk (see coding-agent core/inflight-journal.ts), so this
 * row holds nothing that a hot swap could lose.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHILD_RESULT_CUSTOM_TYPE,
	childResultText,
	claimRecovery,
	INTERRUPTED_CUSTOM_TYPE,
	inboxHasMail,
	interruptedChildren,
	interruptedNotice,
	isLive,
	postToInbox,
	readInflight,
	releaseRecovery,
	takeInbox,
	wasInterrupted,
	writeInflight,
} from "../../coding-agent/src/core/inflight-journal.ts";

export const name = "rlm-inflight";

/**
 * Turns running in this process right now, across every session it hosts. A
 * daemon worker has no chat on screen, so this is how the host (rlm-host
 * shell.ts) tells whether replacing the process would cut a turn in half.
 */
const turnsInFlight = (): Set<object> =>
	((globalThis as { __rlmTurnsInFlight?: Set<object> }).__rlmTurnsInFlight ??= new Set());
export const turnsRunning = (): number => turnsInFlight().size;
const ID = "rlm-inflight";

/** Set (to the target session file) on a process this row started to resume a session; its CLI prompt is the notice. */
export const SPAWNED_ENV = "RLM_INFLIGHT_SPAWNED";
/** Set to "0" to turn automatic resumption off (the journal is still written). */
export const AUTO_RESUME_ENV = "RLM_INFLIGHT_AUTORESUME";

const INBOX_POLL_MS = 1000;

type FactoryEntry = { id: string; factory: (pi: any) => void };
const registry = (): FactoryEntry[] => {
	const g = globalThis as { __rlmExtensionFactories?: FactoryEntry[] };
	if (!Array.isArray(g.__rlmExtensionFactories)) g.__rlmExtensionFactories = [];
	return g.__rlmExtensionFactories;
};

const shellPath = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../../../cordis-shell.mjs");

/** The environment for a resume process: this one's, minus anything that would make it a daemon worker. */
export const resumeEnv = (sessionFile: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		// Worker/supervisor/catalog identity, startup-gate fds, sockets and tokens:
		// a resume process is an ordinary headless client, never part of the daemon.
		if (key.includes("DAEMON")) continue;
		env[key] = value;
	}
	env[SPAWNED_ENV] = sessionFile;
	env.RLM_HEADLESS = "1";
	return env;
};

export type Spawner = (sessionFile: string, prompt: string) => void;

/** Resume a session headless with `prompt` as its turn, detached, logging beside the session. */
export const spawnResume: Spawner = (sessionFile, prompt) => {
	const log = `${sessionFile}.inflight.log`;
	mkdirSync(dirname(log), { recursive: true });
	const out = openSync(log, "a");
	const child = spawn(
		process.execPath,
		[shellPath(), "--headless", "--print", "--resume", sessionFile, "--", prompt],
		{ cwd: process.cwd(), env: resumeEnv(sessionFile), detached: true, stdio: ["ignore", out, out] },
	);
	child.unref();
};

/** The last assistant text of a finished run. */
export const finalAnswer = (messages: any[] | undefined): string => {
	for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
		const m = messages![i];
		if (m?.role !== "assistant") continue;
		const text = Array.isArray(m.content)
			? m.content
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("")
			: typeof m.content === "string"
				? m.content
				: "";
		if (text.trim()) return text.trim();
	}
	return "";
};

export interface InflightOptions {
	spawner?: Spawner;
	/** Poll interval for the inbox of an open session. */
	pollMs?: number;
}

/**
 * The per-session extension. Exported so tests can drive it with a fake `pi`.
 */
export const createInflightExtension =
	(options: InflightOptions = {}) =>
	(pi: any): void => {
		const spawner = options.spawner ?? spawnResume;
		let file: string | undefined;
		let manager: any;
		let depth = 0;
		let parent: string | undefined;
		/** This session's results go to its parent's inbox, not through a live parent's memory. */
		let orphan = false;
		let recovering = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		let idle = true;

		const deliverInbox = () => {
			if (!file || !idle || !inboxHasMail(file)) return;
			const mail = takeInbox(file);
			if (mail.length === 0) return;
			idle = false; // the turn below makes us busy; don't deliver twice before agent_start
			pi.sendMessage(
				{
					customType: CHILD_RESULT_CUSTOM_TYPE,
					content: childResultText(mail),
					display: true,
					details: { from: mail.map((m) => m.fromSession) },
				},
				{ triggerTurn: true },
			);
		};

		pi.on("session_start", (_event: any, ctx: any) => {
			const sm = ctx?.sessionManager;
			manager = sm;
			file = sm?.getSessionFile?.();
			if (!file) return;
			const header = sm.getHeader?.() ?? {};
			depth = header.rlmDepth ?? 0;
			parent = header.parentSession;
			// Resumed means it already holds conversation. A brand-new session
			// starts with bookkeeping entries (service_tier_change, session_state,
			// model_change) before any message; counting those made every fresh
			// subagent an "orphan" that posted its result to its live parent's
			// inbox — a second delivery and an extra parent turn per child.
			const resumed = (sm.getEntries?.() ?? []).some((e: any) => e?.type === "message");
			// Only the session this process was started for; its fresh in-process
			// children are ordinary live children and must not count.
			const spawnedByUs = process.env[SPAWNED_ENV] === file;
			orphan = depth > 0 && !!parent && (resumed || spawnedByUs);

			const prior = readInflight(file);
			const interrupted = resumed && wasInterrupted(prior);
			writeInflight(file, { open: true, busy: false, depth, parentSession: parent });

			if (interrupted && process.env[AUTO_RESUME_ENV] !== "0" && claimRecovery(file)) {
				recovering = true;
				const children = interruptedChildren(file);
				for (const child of children) spawner(child, interruptedNotice(interruptedChildren(child)));
				// A process this row spawned already carries the notice as its CLI
				// prompt; everyone else is woken here.
				if (!spawnedByUs) {
					idle = false;
					pi.sendMessage(
						{
							customType: INTERRUPTED_CUSTOM_TYPE,
							content: interruptedNotice(children),
							display: true,
							details: { children },
						},
						{ triggerTurn: true },
					);
				}
			}

			// Results that arrived while this session was not running.
			queueMicrotask(deliverInbox);
			timer ??= setInterval(deliverInbox, options.pollMs ?? INBOX_POLL_MS);
			(timer as any).unref?.();
		});

		// One token per session this extension instance watches.
		const turn = {};
		pi.on("agent_start", () => {
			idle = false;
			turnsInFlight().add(turn);
			// A brand-new session is written to disk only after its first reply
			// (session-manager keeps abandoned drafts off disk). A turn that is
			// actually running is not a draft: put its prompt on disk now, so a
			// crash before the first reply still leaves something to resume.
			try {
				manager?.flushNow?.();
			} catch {
				// Journal below still records the turn; the flush retries next turn.
			}
			if (file) writeInflight(file, { open: true, busy: true, depth, parentSession: parent });
		});

		// The prompt itself is appended at its own message_end, after
		// agent_start — and after extensions have seen that event (AgentSession
		// emits to extensions, then appends). So flush on the next macrotask,
		// once the append has happened, or the file holds everything but it.
		pi.on("message_end", (event: any) => {
			if (event?.message?.role !== "user") return;
			setTimeout(() => {
				try {
					manager?.flushNow?.();
				} catch {
					// Retried on the next event; the journal still marks the turn busy.
				}
			}, 0);
		});

		pi.on("agent_end", (event: any) => {
			idle = true;
			turnsInFlight().delete(turn);
			if (!file) return;
			writeInflight(file, { open: true, busy: false, depth, parentSession: parent });
			if (recovering) {
				recovering = false;
				releaseRecovery(file);
			}
			if (orphan && parent) {
				const text = finalAnswer(event?.messages);
				if (text) {
					postToInbox(parent, { fromSession: file, fromName: `depth-${depth}`, text });
					// Nobody has the parent open: revive it with the result as its turn.
					if (!isLive(parent)) {
						const mail = takeInbox(parent);
						if (mail.length > 0) spawner(parent, childResultText(mail));
					}
				}
			}
			deliverInbox();
		});

		pi.on("session_shutdown", () => {
			turnsInFlight().delete(turn);
			if (timer) clearInterval(timer);
			timer = undefined;
			if (file) writeInflight(file, { open: false, busy: false, depth, parentSession: parent });
			if (recovering && file) releaseRecovery(file);
		});
	};

export function apply(ctx: any) {
	ctx.effect(() => {
		const reg = registry();
		const stale = reg.findIndex((e) => e.id === ID);
		if (stale >= 0) reg.splice(stale, 1);
		const entry: FactoryEntry = { id: ID, factory: createInflightExtension() };
		reg.push(entry);
		(ctx as any).emit?.("rlm/resources-changed", { reason: "inflight row mounted" });
		return () => {
			const i = registry().indexOf(entry);
			if (i >= 0) registry().splice(i, 1);
		};
	});
}

export default { name, apply };

/** Where a session's resume log goes (for tests and for `rlm doctor`-style inspection). */
export const resumeLogPath = (sessionFile: string): string => join(`${sessionFile}.inflight.log`);
