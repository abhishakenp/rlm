/**
 * Authorisation: the one way a protected file is allowed to change.
 *
 * The mechanism is a sentinel file with a time to live — `~/.rlm/guard-unlock.json`,
 * holding `{ "until": <epoch ms> }`. While it is in the future the backstop in
 * `restore.ts` stands down and accepts whatever the file becomes. When it
 * lapses, whatever the file is at that moment is the new baseline.
 *
 * A file rather than an environment variable, and this is the part worth being
 * precise about, because the obvious choice is wrong here:
 *
 *   - `packages/rlm-delegate/src/agent.ts` spawns every delegated child with
 *     `env: { ...process.env, …, RLM_DELEGATE_CHILD: "1" }`. **A child inherits
 *     the entire parent environment.** So an `RLM_GUARD_UNLOCK` exported in
 *     Abhi's shell is present in every child too, and would unlock all of them.
 *   - Worse, the `code` tool runs JavaScript in a vm in the agent's own
 *     process, where `process.env.RLM_GUARD_UNLOCK = "1"` is one statement. An
 *     env var read at the moment of the check is not a credential; it is a
 *     variable the thing being checked can assign to.
 *
 * What a child cannot do is stop being a child. `RLM_DELEGATE_CHILD` is set by
 * the spawner, before the child process exists, and it is read **once here at
 * module load** — during boot, before any tool call can run — rather than at
 * the moment of the check. A cell that later deletes it from `process.env`
 * changes nothing. So:
 *
 *   1. In a delegated child the unlock is never honoured, whatever the file
 *      says and whatever the environment says.
 *   2. `unlock()` refuses to run in a delegated child, so a child cannot write
 *      the sentinel through the service either.
 *   3. The sentinel path is on the protected list, so layer 1 refuses a cell
 *      that would write it.
 *
 * ### What this does not stop, said plainly
 *
 * (1) and (2) are structural. (3) is a heuristic, and it is the one that
 * matters for the remaining hole: a child that gets past layer 1 and writes the
 * sentinel to disk would stop the *parent's* backstop from restoring, because
 * the parent is not a child and will honour any sentinel it finds. The TTL
 * bounds how long that lasts and `maxMinutes` bounds how long a sentinel may
 * claim, but nothing here makes the file unforgeable by a process running as
 * the same user with a shell. A child is not sandboxed and this file does not
 * pretend it is.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Read once, at module load, before the agent exists.
 *
 * Deliberately not a function over `process.env`: the point is that this
 * answers "was this process spawned as a delegated child", which is settled
 * before any cell runs, and not "does this variable say so right now".
 */
const SPAWNED_AS_CHILD = process.env.RLM_DELEGATE_CHILD === "1";

/** Was this process spawned as a delegated child? Settled at boot; not re-read. */
export const isDelegateChild = (): boolean => SPAWNED_AS_CHILD;

export const defaultUnlockFile = (): string => join(homedir(), ".rlm", "guard-unlock.json");

export interface UnlockState {
	/** Are protected files writable right now? */
	open: boolean;
	/** When the current unlock lapses, if there is one. */
	until?: number;
	/** In a sentence, for the log and for `explain()`. */
	why: string;
}

const locked = (why: string): UnlockState => ({ open: false, why });

/**
 * Is there a live, honest unlock?
 *
 * `maxMinutes` caps what a sentinel may claim. Without it "unlocked until the
 * heat death of the universe" is one JSON edit away, and an unlock nobody ever
 * has to renew is not an unlock, it is the guard being off.
 */
export const unlockState = (file: string, maxMinutes: number, now = Date.now()): UnlockState => {
	if (SPAWNED_AS_CHILD) return locked("this is a delegated child — the unlock is never honoured here");
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return locked("no unlock file");
	}
	let until: number;
	try {
		until = Number(JSON.parse(raw)?.until);
	} catch {
		return locked(`unlock file at ${file} is not readable JSON`);
	}
	if (!Number.isFinite(until)) return locked(`unlock file at ${file} has no usable "until"`);
	if (until <= now) return locked(`unlock lapsed ${Math.round((now - until) / 1000)}s ago`);
	if (until - now > maxMinutes * 60_000)
		return locked(`unlock claims ${Math.round((until - now) / 60_000)} minutes, over the ${maxMinutes} allowed`);
	return { open: true, until, why: `unlocked for another ${Math.round((until - now) / 1000)}s` };
};

/** Write the sentinel. Refuses in a delegated child — see the header. */
export const writeUnlock = (file: string, minutes: number, maxMinutes: number): UnlockState => {
	if (SPAWNED_AS_CHILD) throw new Error("rlm-guard: a delegated child cannot unlock the guard");
	const span = Math.min(Math.max(1, minutes), maxMinutes);
	const until = Date.now() + span * 60_000;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ until, minutes: span, written: new Date().toISOString() }, null, 2)}\n`);
	return { open: true, until, why: `unlocked for ${span} minute(s)` };
};

/** Remove the sentinel. Safe to call when there is none. */
export const clearUnlock = (file: string): void => {
	try {
		rmSync(file, { force: true });
	} catch {
		/* nothing there, or not ours to remove — either way it is not unlocked by us */
	}
};
