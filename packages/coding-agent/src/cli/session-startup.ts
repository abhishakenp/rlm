/**
 * Which session a launch opens: `--resume`, `--continue`, `--fork`, `--session-dir`,
 * `--no-session`.
 *
 * Moved out of `main.ts` so the Cordis launch path (`rlm-modes` → renderer / print
 * rows) reads a command line the same way `main()` does. Before, only `main()`
 * looked at these flags and the rows never called it, so `rlm -r` opened a fresh
 * chat and `rlm --resume <id>` quietly started a new session file.
 */

import { createInterface } from "node:readline";
import chalk from "chalk";
import { APP_NAME, expandTildePath, getAgentDir, getSessionDirEnvOverride } from "../config.js";
import { SessionManager } from "../core/session-manager.js";
import { SettingsManager } from "../core/settings-manager.js";
import type { Args } from "./args.js";
import {
	looksLikeSessionPath,
	resolveSessionPath,
	SessionSelectorError,
	SessionSelectorNotFoundError,
} from "./session-resolver.js";

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

export function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function getResumeSelector(parsed: Pick<Args, "resume">): string | undefined {
	return typeof parsed.resume === "string" ? expandSelector(parsed.resume) : undefined;
}

/**
 * A selector that is a path gets `~` expanded — the shell does not do it inside
 * `--resume=~/…`, and rlm-iris passes exactly that. An id or prefix is left alone.
 */
function expandSelector(selector: string): string {
	return looksLikeSessionPath(selector) ? expandTildePath(selector) : selector;
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
): Promise<SessionManager> {
	const explicitCwdOverride = parsed.cwd ? cwd : undefined;

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}

	if (parsed.fork) {
		const resolved = await resolveSessionPath(expandSelector(parsed.fork), cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
		}
	}

	const resumeSelector = getResumeSelector(parsed);
	if (resumeSelector) {
		const resolved = await resolveSessionPath(resumeSelector, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, sessionDir, explicitCwdOverride);

			case "global": {
				if (!process.stdin.isTTY) {
					// The fork confirm reads stdin; without a TTY it would hang boot forever.
					console.error(
						chalk.red(
							`Error: session ${resumeSelector} belongs to a different project (${resolved.cwd}). Pass --fork ${resumeSelector} to use it here, or run from that project's directory.`,
						),
					);
					process.exit(1);
				}
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	return SessionManager.create(cwd, sessionDir);
}

/** `--session-dir`, then the env override, then settings — the order `main()` uses. */
export function resolveStartupSessionDir(
	parsed: Pick<Args, "sessionDir">,
	settingsManager: Pick<SettingsManager, "getSessionDir">,
): string | undefined {
	return (
		(parsed.sessionDir ? expandTildePath(parsed.sessionDir) : undefined) ??
		getSessionDirEnvOverride() ??
		settingsManager.getSessionDir()
	);
}

/** True when the command line names a session to open rather than a fresh one. */
export function selectsSession(parsed: Pick<Args, "resume" | "continue" | "fork" | "noSession" | "sessionDir">): boolean {
	return (
		parsed.resume !== undefined ||
		!!parsed.continue ||
		!!parsed.fork ||
		!!parsed.noSession ||
		!!parsed.sessionDir
	);
}

/**
 * Bare `--resume`/`-r` in an interactive terminal opens the agents view over the
 * saved-session catalog instead of a chat — prime-agent's
 * `shouldOpenAgentsViewForDaemonInteractive`. A selector, `--continue` or
 * `--fork` opens its target directly.
 */
export function opensAgentsViewForResume(parsed: Pick<Args, "resume" | "continue" | "fork" | "noSession">): boolean {
	return parsed.resume === true && !parsed.continue && !parsed.fork && !parsed.noSession;
}

/**
 * The session manager a Cordis launch should hand `createRuntime`, or `undefined`
 * when the command line names no session (the `session` row's fresh one is right).
 * Exits with the same messages `main()` prints when a selector does not resolve.
 */
export async function sessionManagerFromArgs(parsed: Args, cwd: string): Promise<SessionManager | undefined> {
	if (!selectsSession(parsed) || parsed.resume === true) return undefined;
	validateForkFlags(parsed);
	const sessionDir = resolveStartupSessionDir(parsed, SettingsManager.create(cwd, getAgentDir()));
	try {
		return await createSessionManager(parsed, cwd, sessionDir);
	} catch (error) {
		if (!(error instanceof SessionSelectorError)) throw error;
		const suggestion =
			error instanceof SessionSelectorNotFoundError && error.suggestion ? ` Did you mean '${error.suggestion}'?` : "";
		console.error(chalk.red(`Error: ${error.message}.${suggestion}`));
		console.error(chalk.dim(`Open ${APP_NAME} and press left-arrow to browse sessions.`));
		process.exit(1);
	}
}
