/**
 * A failure of the host is not a failure of the task.
 *
 * Every delegated attempt is a child `rlm --print`, and booting the whole
 * composition is the first thing that child does. So an agent mid-edit — a
 * stray brace, a duplicated `const`, a row being written while it is mounted —
 * takes down every child launched during the seconds that file is broken. The
 * child exits 1, the delegate reads a non-zero code, and the task is charged
 * for a failure it had no part in.
 *
 * Measured, on one night: 2,574 of 3,481 recorded attempts — seventy-four
 * percent of everything the drive did — were this. Four tasks reached 350
 * attempts each without a single model ever seeing them. `iris mend.tally`
 * classified 1,243 of 1,327 negative outcomes as `unwritable-criterion`, and
 * the objection recorded against every one of them was the same boot trace.
 *
 * Two things follow, and the second is the one that actually saves the time:
 *
 *   1. **It is not an attempt.** A try that never reached a model is not a try.
 *      Charging it spends a retry budget, drives the task to `rejected`, and
 *      asks him a question about a criterion when the criterion was never the
 *      problem.
 *   2. **It is not worth repeating right now.** If the composition will not
 *      boot, the next child will not boot either. Recognising that and standing
 *      the run down converts three hundred doomed spawns into three, and the
 *      supervisor comes back forty-five seconds later — by which time the edit
 *      that broke it has almost always landed.
 *
 * The list is deliberately narrow, for the same reason `wall()` is: a wrong
 * guess here turns a real failure into an eternal retry. Every string below is
 * one the host actually prints, from `cordis-shell.mjs` or from the loader it
 * mounts — not one that was imagined.
 */

/**
 * What a child exits with when the host, not the work, is what failed.
 *
 * 78 is `EX_CONFIG` from sysexits — "something was wrong in the configuration",
 * which is exactly the case. A number rather than a string match wherever it
 * can be one: the message is best-effort, the code is not.
 */
export const HOST_EXIT = 78;

/**
 * Things only the host says. Each is emitted before any prompt is read, so
 * seeing one means the child never got as far as the work.
 */
const SIGNATURES: readonly string[] = [
	// cordis-shell, degraded boot: the row the mode needed was dropped.
	"row is not mounted",
	"will not load and were left out of this boot",
	"the composition cannot run this",
	// cordis-plugin-loader, refusing the composition outright.
	"failed to apply loader entry",
	"failed to import loader entry",
	// esbuild/tsx, an agent mid-edit.
	"Transform failed with",
	// cordis-shell's own pre-boot refusals.
	"the `modes` row never started",
	"no composition at ",
	"missing node_modules/tsx",
	"rlm needs Node >=",
];

/**
 * Did the host fail before the work could start?
 *
 * Takes an Error, a string, or anything stringifiable, because it is called on
 * both a caught throw and a journalled `detail`.
 */
export const isHostFailure = (detail: unknown): boolean => {
	const text = String((detail as { message?: unknown } | null)?.message ?? detail ?? "");
	if (!text) return false;
	// The exit code first, because it is the only part of this that cannot be
	// imitated. Everything below is a string an agent could in principle print.
	if (text.includes(`the agent exited ${HOST_EXIT}`)) return true;
	// A signature only counts on a line the host itself wrote.
	//
	// `detail` carries the tail of the child's own stdout, so an agent debugging
	// esbuild and printing "Transform failed with 1 error" would otherwise be
	// read as a broken composition — and this classifier's whole effect is to
	// stop charging attempts, so a false positive is a task that can never
	// finish and never be rejected either. Every string in `SIGNATURES` is
	// printed by `cordis-shell.mjs` behind an `[rlm]` prefix; requiring the
	// prefix costs nothing real and closes that off.
	return text
		.split("\n")
		.some((line) => line.trimStart().startsWith("[rlm]") && SIGNATURES.some((signature) => line.includes(signature)));
};

/**
 * The other way an attempt can not happen: somebody stopped it.
 *
 * A stop file, a drive standing down, an abort travelling to a child mid-run —
 * the task did nothing wrong and learned nothing, so charging it a try is the
 * same lie as charging it for a host that would not boot. It showed up while
 * verifying the fix for that one: the circuit breaker aborted, and the two
 * children it killed on the way out were each recorded as a failed attempt by
 * the very run that had just decided not to spend any.
 *
 * Kept apart from `isHostFailure` because they need opposite responses. A host
 * failure means stop; a stop means we already have.
 */
export const isStop = (detail: unknown): boolean => {
	const text = String((detail as { message?: unknown } | null)?.message ?? detail ?? "");
	return text.includes("stopped before this attempt started") || text.includes("stopped mid-attempt");
};

/**
 * Thrown past the thing that would otherwise have written an attempt down.
 *
 * A plain Error would be caught by the same `catch` that records a failed
 * attempt, which is the whole thing being avoided — so it carries a brand the
 * catch can test, and `isHostFailure` still matches its message.
 */
export class HostDown extends Error {
	readonly hostDown = true as const;
	constructor(detail: unknown) {
		super(String((detail as { message?: unknown } | null)?.message ?? detail ?? "the host would not start"));
		this.name = "HostDown";
	}
}

export const isHostDown = (error: unknown): error is HostDown =>
	Boolean((error as { hostDown?: boolean } | null)?.hostDown);
