/**
 * Running the criterion — the difference between finished and claimed.
 *
 * Every kind is mechanical. It answers when the model is down, when the
 * delegator has crashed, and when the agent is confidently wrong, because none
 * of those three change whether a command exits zero. `iris-dirsize` was
 * announced as a capability while its only command was the template's greeting;
 * `iris dirsize.of` returning a size would have said so in a millisecond, and
 * no amount of confident prose would have moved it.
 *
 * Two of the kinds need to ask the running rlm about itself — whether a row is
 * ACTIVE, whether a command is really in the registry. Those come in through
 * `probe`, and when there is no probe the verdict is `errored`, never `passed`.
 * Unverifiable is not the same as verified; that confusion is the whole bug.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Proof } from "./graph.ts";

/**
 * `~` is a shell courtesy, not a path.
 *
 * `existsSync("~/proj/rlm/docs/outloop.md")` is false while the file is
 * plainly there, so the criterion read "does not exist", the task was charged
 * two failed attempts, and four tasks went unreachable behind it. The agent
 * had very likely done the work. Nobody writing a criterion by hand thinks
 * about this, and they should not have to.
 */
export const expand = (path: string): string => {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	if (path.startsWith("$HOME/")) return join(homedir(), path.slice(6));
	return path;
};

export interface ProofResult {
	verdict: "passed" | "failed" | "errored" | "unstated";
	detail: string;
}

/** What the graph needs to ask of a live rlm. Both may be absent. */
export interface Probe {
	/** Fiber state of a composition row, or null when there is no such row. */
	rowState?(id: string): string | null | undefined;
	/** Every command/tool name currently registered. */
	commands?(): string[];
}

const shell = (
	command: string,
	cwd: string | undefined,
	timeoutMs: number,
): Promise<{ code: number | null; out: string }> =>
	new Promise((resolve) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
			(error: any, stdout, stderr) => {
				const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
				if (error) {
					resolve({
						code: typeof error.code === "number" ? error.code : null,
						out: out || String(error.message ?? error),
					});
				} else resolve({ code: 0, out });
			},
		);
	});

export const check = async (
	proof: Proof,
	options: { cwd?: string; probe?: Probe; needsAllDone?: boolean } = {},
): Promise<ProofResult> => {
	switch (proof.kind) {
		case "unstated": {
			// The one kind that never passes. A request written down at the door
			// before any model has looked at it has no criterion yet, and saying
			// so is worth more than pretending either way.
			return {
				verdict: "unstated",
				detail: proof.note ?? "nobody said how to tell whether this was finished, so nobody can",
			};
		}

		case "rollup": {
			return options.needsAllDone
				? { verdict: "passed", detail: "everything it was broken into is done" }
				: { verdict: "failed", detail: "something it was broken into is not done" };
		}

		case "file": {
			const path = expand(proof.path);
			if (!existsSync(path)) return { verdict: "failed", detail: `${proof.path} does not exist` };
			if (proof.changedSince) {
				let touched = 0;
				try {
					touched = statSync(path).mtimeMs;
				} catch (error: any) {
					return { verdict: "errored", detail: `could not stat ${proof.path}: ${error?.message ?? error}` };
				}
				if (touched <= Date.parse(proof.changedSince)) {
					return { verdict: "failed", detail: `${proof.path} has not been touched since the work started` };
				}
			}
			if (proof.contains) {
				let text = "";
				try {
					text = readFileSync(path, "utf8");
				} catch (error: any) {
					return { verdict: "errored", detail: `could not read ${proof.path}: ${error?.message ?? error}` };
				}
				if (!text.includes(proof.contains)) {
					return {
						verdict: "failed",
						detail: `${proof.path} exists but does not contain ${JSON.stringify(proof.contains)}`,
					};
				}
			}
			return {
				verdict: "passed",
				detail: proof.changedSince ? `${proof.path} has changed` : `${proof.path} is there`,
			};
		}

		case "row": {
			const want = proof.state ?? "ACTIVE";
			const read = options.probe?.rowState;
			if (!read) {
				return { verdict: "errored", detail: `cannot see composition rows from here, so "${proof.id} is ${want}" is unchecked` };
			}
			let state: string | null | undefined;
			try {
				state = read(proof.id);
			} catch (error: any) {
				return { verdict: "errored", detail: `could not read row ${proof.id}: ${error?.message ?? error}` };
			}
			if (!state) return { verdict: "failed", detail: `there is no row "${proof.id}" — nothing was mounted` };
			return state === want
				? { verdict: "passed", detail: `row ${proof.id} is ${state}` }
				: { verdict: "failed", detail: `row ${proof.id} is ${state}, not ${want}` };
		}

		case "command": {
			const list = options.probe?.commands;
			if (!list) {
				return { verdict: "errored", detail: `cannot see the command registry from here, so "${proof.name}" is unchecked` };
			}
			let names: string[] = [];
			try {
				names = list() ?? [];
			} catch (error: any) {
				return { verdict: "errored", detail: `could not read the registry: ${error?.message ?? error}` };
			}
			return names.includes(proof.name)
				? { verdict: "passed", detail: `${proof.name} is registered` }
				: { verdict: "failed", detail: `${proof.name} is not registered (${names.length} commands are)` };
		}

		case "shell": {
			try {
				const where = proof.cwd ?? options.cwd;
				const { code, out } = await shell(proof.run, where ? expand(where) : undefined, proof.timeoutMs ?? 60_000);
				const tail = out.split("\n").slice(-12).join("\n");
				return code === 0
					? { verdict: "passed", detail: tail || `${proof.run} exited 0` }
					: { verdict: "failed", detail: `${proof.run} exited ${code ?? "on a signal"}\n${tail}`.trim() };
			} catch (error: any) {
				return { verdict: "errored", detail: `could not run the criterion: ${error?.message ?? error}` };
			}
		}
	}
};
