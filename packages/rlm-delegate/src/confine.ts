/**
 * Where a child may write, enforced by the kernel rather than by asking.
 *
 * ## Why the planner needed this and the runner does not
 *
 * A delegated child gets exactly one tool, `code`, and that tool is a vm with
 * `execSync`, `fs`, `require` and `fetch` in scope, running as the same user
 * with the same permissions as rlm itself. For the **runner** that is the
 * point: the fleet exists to change the repo.
 *
 * For the **planner** it is a category error. The planner is asked to write a
 * *specification* — what the jobs are, and how anybody could tell each one is
 * finished. It is not asked to do any of them. Given hands it does them anyway:
 * `install-and-wire-the-iris-17` was a planning call in which the child went and
 * did the work, and a precursor cell in the same run recognised the correct Iris
 * client by its exact path and deleted it as "wrong place". That call also ran
 * past its ten-minute ceiling and was killed — a plan is a paragraph, and
 * nothing that only writes a paragraph takes ten minutes.
 *
 * `ask.ts` already makes this argument for the reviewer, in one line: *a
 * reviewer with hands is a second author*. The planner is the same shape.
 *
 * ## But not "no hands" — the wrong hands
 *
 * A planner that can write nothing cannot persist a plan, and on this machine
 * plans are a real artefact with a real home: `~/.plans/YYYY-MM-DD_HH-MM-slug.md`,
 * 145 of them at the time of writing. So the bound is a *scope*, not a
 * subtraction: the planner keeps a write tool whose reachable set is the plans
 * directory and the few paths its own boot needs, and does not include the repo,
 * does not include PATH, does not include the task graphs.
 *
 * ## Why sandbox-exec and not a check
 *
 * `rlm-guard` is the natural place to say "this path is forbidden" and it says
 * it well, but its model is a denylist over cell *text* — it reads the code an
 * agent is about to run and refuses when it names something protected. Its own
 * header is explicit that this is a heuristic and not a sandbox:
 * `require("fs")["write" + "FileSync"]` defeats it in one line. A denylist also
 * cannot express "only here": that is the complement of what it computes, and
 * every write whose target it cannot evaluate — a variable, an interpolation —
 * would have to be refused, which is most real cells.
 *
 * So this is not a second guard. It is the seam `agent.ts` already cut for
 * exactly this and never filled: `AgentOptions.confine`, "wrap the command
 * before it runs — the seam a fence plugs into". macOS ships `sandbox-exec`,
 * which enforces a write scope in the kernel, on absolute and relative paths
 * alike, against `fs.writeFileSync` and `execSync("… > …")` and a compiled
 * helper equally, because none of them is consulted about it.
 *
 * The profile shape is taken from `@iris/bounds`, which already solves this on
 * this machine — the shape, not the dependency, the same way `agent.ts` takes
 * `confine`'s signature rather than importing the package.
 *
 * ## The honest limits, stated here rather than discovered later
 *
 *   - **Deprecated, and still the only one.** `sandbox-exec` has carried a
 *     deprecation warning for years. It is what is on the machine.
 *   - **Writes only.** Reads are wide open, deliberately: a planner has to be
 *     able to read the repo to write a criterion about it, and reading changes
 *     nothing.
 *   - **Not available everywhere.** `available()` says whether it is here.
 *     Where it is not the caller gets null and has to decide, because silently
 *     running unconfined while believing otherwise is the failure this whole
 *     package is about.
 *   - **A bound on writing is not a bound on doing.** A confined planner can
 *     still run commands, reach the network and spawn things. What it cannot do
 *     is leave a change behind outside its scope, which is the harm observed.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

/** The one on macOS. */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export const available = (): boolean => process.platform === "darwin" && existsSync(SANDBOX_EXEC);

export interface Scope {
	/** Absolute directories the child may write to. Everything else is refused. */
	writable: string[];
}

/**
 * Paths any rlm child writes on the way up, before it reads a single token.
 *
 * These are not a courtesy. A profile without them does not produce a confined
 * child, it produces a child that dies during boot with an error about a log
 * file — which reads as rlm being broken rather than as the bound being too
 * tight. Found by running one and watching what it touched, not by reasoning
 * about it.
 */
export const bootPaths = (home = homedir()): string[] => [
	// The session transcript, the model registry, the journals and the logs.
	resolve(home, ".rlm"),
	resolve(home, ".cache"),
	resolve(tmpdir()),
	"/private/var/folders",
	// Node and the shells write here. Not a place a criterion can be forged:
	// nothing on PATH resolves into /dev.
	"/dev",
];

/** The sandbox-exec profile: read anything, write only inside the scope. */
export const profileFor = (count: number): string =>
	[
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		...Array.from({ length: count }, (_, i) => `(allow file-write* (subpath (param "W${i}")))`),
	].join("\n");

/**
 * A `confine` for `AgentOptions` — the same `(command, args) => argv` shape.
 *
 * Returns null when the machine cannot enforce it, so a caller has to decide
 * rather than being handed something that looks like a bound and is not.
 */
export const confineTo = (scope: Scope): ((command: string, args: string[]) => string[]) | null => {
	if (!available()) return null;
	const dirs = [...new Set(scope.writable.map((dir) => resolve(dir)))].filter(Boolean);
	if (!dirs.length) return null;
	const profile = profileFor(dirs.length);
	return (command: string, args: string[]): string[] => {
		const flags: string[] = [];
		dirs.forEach((dir, i) => flags.push("-D", `W${i}=${dir}`));
		flags.push("-p", profile);
		return [SANDBOX_EXEC, ...flags, command, ...args];
	};
};

/**
 * The planner's scope: where plans go, plus what the boot needs.
 *
 * `~/.plans` is created if it is not there. A bound that failed because the one
 * directory it exists to permit did not exist yet would be discovered at the
 * worst possible moment.
 */
export const plannerScope = (home = homedir()): Scope => {
	const plans = resolve(home, ".plans");
	try {
		mkdirSync(plans, { recursive: true });
	} catch {
		/* if it cannot be made, the profile still names it and writes there fail */
	}
	return { writable: [plans, ...bootPaths(home)] };
};
