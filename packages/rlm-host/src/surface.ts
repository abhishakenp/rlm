/**
 * The Surface — the host-owned object that outlives the rows that draw it
 * (zero-restart design, Case 3; owned by worker SURFACE).
 *
 * rlm-hmr used to pin `renderer`, `print`, `sdk` and `modes`: patched in place,
 * never swapped, because a swap disposes the old fiber and plugs a new one, and
 * everything those rows held — the chat on screen, its runtime, the subagent
 * handles the SDK hands out — lived on the old instance. A swapped renderer came
 * back with `instance` undefined: panels stopped repainting, the session event
 * forwarding died with the old fiber, and nothing could reach the chat again.
 *
 * So what must outlive a swap lives here instead, on the host anchor
 * (`globalThis.__rlmHost`, which outlives every reload — see
 * `cordis-shell.mjs`), and the rows become controllers that attach to it:
 *
 *   - `interactive` — the chat currently on screen, the root runtime, whether
 *     the interactive loop is running, and the one session-event subscription.
 *     A new renderer generation reads the same objects its predecessor wrote.
 *   - `rowState(row, init)` — per-row state that must survive a swap (the SDK's
 *     child handles, print's runtime). Hand over data and resources, never the
 *     old generation's functions.
 *   - `attachRow(row, owner)` / `rowOwner(row)` — which generation of a row is
 *     current, so long-lived callbacks registered once (a session subscription)
 *     always call into the newest code instead of a disposed fiber.
 *
 * The terminal is never stopped by any of this: the ProcessTerminal and TUI
 * belong to the live InteractiveMode, which the Surface keeps, so a row swap
 * never toggles raw mode or leaves the alternate screen.
 *
 * This module holds no state of its own — only functions over the anchor — so a
 * reload of this file changes behaviour without losing anything.
 */

/** Live interactive state: the chat on screen and what it runs on. */
export interface SurfaceInteractive {
	/** The InteractiveMode currently on screen (the root chat or one opened from the agents view). */
	instance?: unknown;
	/** The root runtime the interactive loop was started with. */
	runtime?: unknown;
	/** True from `start()` until the interactive loop returns. */
	running: boolean;
	/** Unsubscribe for the root session's event forwarding; one per session, not per generation. */
	sessionEventUnsub?: () => void;
	/** True once the session subscription forwards through the current renderer owner. */
	surfaceForwarding?: boolean;
	/**
	 * What is on screen: a chat, or the agents view. The host's execve path
	 * reads this to relaunch into the same view (`shell.ts` reexec).
	 */
	view?: "chat" | "agents";
	/** The agents view on screen, if any — its `persistentState` is what an execve saves. */
	agentsView?: { persistentState: Record<string, any> };
}

/**
 * The parts of an agents view's state that make it look identical after an
 * execve in place: selection, expansion, scope, filter, hidden rows. JSON-safe
 * (Sets become arrays); catalogs and clients are rebuilt by the new image.
 */
export const AGENTS_VIEW_KEYS = [
	"selectedRowIdentity",
	"selectedSessionKey",
	"scopeFrames",
	"scopeRootSummary",
	"backSession",
	"pendingExpandedAncestorSessionIds",
	"expandedSubagentParents",
	"programShownParents",
	"query",
	"showHidden",
] as const;

/** Serialize the agents view on screen for `plan.resume`. */
export const captureAgentsViewState = (): Record<string, unknown> | undefined => {
	const state = surface().interactive.agentsView?.persistentState;
	if (!state) return undefined;
	const out: Record<string, unknown> = {};
	for (const key of AGENTS_VIEW_KEYS) {
		const value = state[key];
		if (value === undefined) continue;
		out[key] = value instanceof Set ? [...value] : value;
	}
	return out;
};

/**
 * The agents-view seed an execve left behind, if the relaunch is into the
 * agents view. Consumed once: a later view in this process starts normally.
 */
export const takeAgentsViewSeed = (): Record<string, unknown> | undefined => {
	const s = surface();
	const resumed = s.resumed ?? (anchor() as any).resumed;
	const saved = resumed?.agentsView as Record<string, unknown> | undefined;
	if (resumed?.view !== "agents" || !saved) return undefined;
	delete resumed.agentsView;
	const seed: Record<string, unknown> = { ...saved };
	for (const key of ["expandedSubagentParents", "programShownParents"] as const) {
		if (Array.isArray(seed[key])) seed[key] = new Set(seed[key] as string[]);
	}
	return seed;
};

/** What the host needs from a Surface, plus what the rows share through it. */
export interface RlmSurface {
	/**
	 * Resolves with the process exit code when the user quits. Once a Surface is
	 * registered, the shell awaits this instead of the promise `modes.dispatch()`
	 * returned, so a row swap can never end the process.
	 */
	lifetime?: Promise<number>;
	/**
	 * Called before an execve-in-place (shell.ts `reexec`). Put whatever the new
	 * process needs to look identical (open session ids, view, scroll, editor
	 * text, subagent tree) on `plan.resume`; it is written to disk and handed to
	 * the next image as `RLM_HOST_RESUME`.
	 */
	beforeExec?(plan: { argv: string[]; resume: Record<string, unknown> }): void | Promise<void>;
	/** Called once after an execve-in-place with the `resume` object written before it. */
	afterExec?(resume: Record<string, unknown>): void | Promise<void>;

	/** Live interactive state (the chat on screen). */
	interactive: SurfaceInteractive;
	/** Per-row state that survives a row swap, keyed by row name. */
	rows: Record<string, object>;
	/** The current owner (latest attached generation) of each row, keyed by row name. */
	owners: Record<string, { owner: object; generation: number }>;
	/** Bumped by every attach; a monotonic generation counter across all rows. */
	generation: number;
	/** What was handed over by an execve-in-place, until something consumes it. */
	resumed?: Record<string, unknown>;
}

const anchor = (): any => {
	const g = globalThis as any;
	// The host anchor exists in every real process (cordis-shell.mjs creates it
	// first). Tests and embedders without one get a private anchor, so the same
	// code runs everywhere.
	return g.__rlmHost ?? (g.__rlmSurfaceAnchor ??= {});
};

/** The Surface registered on the host anchor, if any. */
export const hostSurface = (): RlmSurface | undefined => anchor().surface;

/** Register (or replace) the Surface on the host anchor. The anchor outlives every reload. */
export const setHostSurface = (surface: RlmSurface | undefined): void => {
	anchor().surface = surface;
};

/** The Surface, created on first use. Every row goes through this. */
export const surface = (): RlmSurface => {
	const a = anchor();
	const s: RlmSurface = (a.surface ??= { interactive: { running: false }, rows: {}, owners: {}, generation: 0 });
	// A stub registered by an older generation of this module (or by the host
	// before SURFACE existed) gains the fields it lacks, never loses the ones it has.
	s.interactive ??= { running: false };
	s.rows ??= {};
	s.owners ??= {};
	s.generation ??= 0;
	return s;
};

/**
 * Per-row state that survives a swap: the first generation creates it, every
 * later one gets the same object back.
 */
export const rowState = <T extends object>(row: string, init: () => T): T => {
	const rows = surface().rows;
	return (rows[row] ??= init()) as T;
};

/**
 * Record `owner` as the current generation of `row`. Returns its generation
 * number. Called from a row's `[Service.init]`, so a swap hands ownership over
 * the moment the new fiber starts.
 */
export const attachRow = (row: string, owner: object): number => {
	const s = surface();
	const generation = ++s.generation;
	s.owners[row] = { owner, generation };
	return generation;
};

/** The current owner of `row`, if one has attached. */
export const rowOwner = <T = unknown>(row: string): T | undefined => surface().owners[row]?.owner as T | undefined;

/**
 * Drop `owner` as the current generation of `row`, if it still is. A fiber
 * disposed by a swap calls this after its successor attached, so it is a no-op
 * then; a row that is really going away clears itself.
 */
export const detachRow = (row: string, owner: object): void => {
	const s = surface();
	if (s.owners[row]?.owner === owner) delete s.owners[row];
};
