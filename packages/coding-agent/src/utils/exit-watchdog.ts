/**
 * A deadline for leaving the process.
 *
 * Quitting restores the terminal first and then awaits teardown — the
 * connection, every hosted session and subagent, the composition. Each of those
 * awaits is a promise somebody else resolves, and when one never does the
 * process sits idle in kevent64 with the terminal already handed back cooked:
 * the shell prompt is there, and so is rlm, holding a socket to CLIProxyAPI.
 * That is what the stuck test TUIs of 2026-09-25 were (pids 65921, 38211).
 *
 * So every exit path arms this once. If the process is still alive when the
 * deadline passes, it says which teardown step it was stuck in, puts the
 * terminal back the way the TUI found it, and exits with the code it meant to.
 * Session entries are written with appendFileSync, so nothing is lost by not
 * waiting.
 *
 * The state lives on globalThis so a hot-reloaded copy of this module arms and
 * steps the same watchdog instead of a second one.
 */

export const EXIT_DEADLINE_MS = 5000;

interface ArmedWatchdog {
	code: number;
	reason: string;
	step: string;
	since: number;
	timer: ReturnType<typeof setTimeout>;
}

interface WatchdogState {
	armed?: ArmedWatchdog;
}

const state = (): WatchdogState => ((globalThis as any).__rlmExitWatchdog ??= {}) as WatchdogState;

const deadlineFromEnv = (): number => {
	const value = Number(process.env.RLM_EXIT_DEADLINE_MS);
	return Number.isFinite(value) && value > 0 ? value : EXIT_DEADLINE_MS;
};

/** Start the clock. Only the first call counts; later exit paths just step it. */
export const armExitWatchdog = (reason: string, code = 0, deadlineMs = deadlineFromEnv()): void => {
	const s = state();
	if (s.armed) return;
	// An execve in place (rlm-host shell.ts reexec) also disposes everything;
	// it has its own deadline and must not be cut short by an exit.
	if ((globalThis as any).__rlmHostExecing) return;
	const armed: ArmedWatchdog = { code, reason, step: "starting", since: Date.now(), timer: undefined as any };
	armed.timer = setTimeout(() => forceExit(), deadlineMs);
	s.armed = armed;
};

/** Name the teardown step now in progress, so a forced exit can say where it was stuck. */
export const exitStep = (step: string): void => {
	const armed = state().armed;
	if (armed) armed.step = step;
};

export const exitWatchdogArmed = (): boolean => state().armed !== undefined;

/** Undo every mode the TUI's ProcessTerminal turns on; each sequence is harmless if already off. */
const restoreTerminal = (): void => {
	try {
		if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
	} catch {}
	try {
		if (process.stdout.isTTY) {
			// mouse, bracketed paste, kitty keyboard, modifyOtherKeys, alt screen, cursor
			process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?1049l\x1b[?25h");
		}
	} catch {}
};

const forceExit = (): void => {
	const armed = state().armed;
	if (!armed) return;
	const waited = Date.now() - armed.since;
	const message = `exit (${armed.reason}) stuck ${waited}ms in "${armed.step}" — exiting anyway`;
	try {
		(globalThis as any).__rlmLog?.("warn", "exit", message, { step: armed.step, reason: armed.reason, waitedMs: waited });
	} catch {}
	restoreTerminal();
	try {
		process.stderr.write(`[rlm] ${message}\n`);
	} catch {}
	process.exit(armed.code);
};

/** For tests: forget an armed watchdog without exiting. */
export const disarmExitWatchdogForTests = (): void => {
	const armed = state().armed;
	if (armed) clearTimeout(armed.timer);
	state().armed = undefined;
};
