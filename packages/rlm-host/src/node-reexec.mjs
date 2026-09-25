/**
 * Node only: the half of the process that exists to add two flags.
 *
 * Plain `.mjs` on purpose — it runs before the TypeScript hook exists. Moved
 * verbatim in behaviour out of the old 368-line `cordis-shell.mjs`: Cordis needs
 * Node's internal ESM loader (`--expose-internals`, no runtime equivalent) and
 * every row names `.ts` (`--import tsx`). Bun needs neither, so the bootstrap
 * never loads this file under Bun.
 *
 * This parent is a relay and nothing else: it forwards signals so the child's
 * `rlm-boot` row can unload the composition, and exits with the child's code.
 */
import { spawn } from "node:child_process";
import { existsSync, fstatSync } from "node:fs";
import { join } from "node:path";

const host = globalThis.__rlmHost;

const die = (message) => {
	console.error("[rlm]", message);
	process.exit(1);
};

// Below Node 22.8 Cordis cannot reach Node's internal ESM loader, the Include
// tree fails to apply, and rlm boots with no loader entries — silently unable
// to change itself. Fail here instead.
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > 22 || (major === 22 && minor >= 8))) {
	die(
		`rlm needs Node >= 22.8 and this is ${process.versions.node}.\n` +
			"        Below 22, Cordis cannot reach Node's internal ESM loader, so hot\n" +
			"        reload and self-modification are both unavailable. Try:\n" +
			"          fnm use 22 && rlm …   (or run rlm with a v22+ node on PATH)",
	);
}

const localTsx = join(host.root, "node_modules", "tsx", "dist", "loader.mjs");
if (!existsSync(localTsx)) die("missing node_modules/tsx — run `bun install` first");

// Descriptors above stdio that the environment names, passed at the same number:
// a daemon worker's startup gate arrives as fd 3+ and is named by
// PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD; passing only 0-2 dropped it
// and every worker waited on a closed fd (worker M). Any `*_FD` variable counts,
// plus an explicit RLM_INHERIT_FDS list. Not a /dev/fd scan: that also lists
// node's own internal descriptors, and passing those fails the spawn (EBADF).
const fstatOk = (fd) => {
	try {
		fstatSync(fd);
		return true;
	} catch {
		return false;
	}
};
const named = [
	...Object.entries(process.env)
		.filter(([k]) => k.endsWith("_FD"))
		.map(([, v]) => Number(v)),
	...(process.env.RLM_INHERIT_FDS ?? "").split(",").map((v) => Number(v.trim())),
];
const extra = [...new Set(named)].filter((fd) => Number.isInteger(fd) && fd > 2 && fstatOk(fd));
const stdio = ["inherit", "inherit", "inherit"];
for (const fd of extra) stdio[fd] = fd;
for (let i = 3; i < stdio.length; i++) stdio[i] ??= "ignore";

const child = spawn(
	process.execPath,
	["--expose-internals", "--import", localTsx, host.bootstrap, ...process.argv.slice(2)],
	{ stdio, env: process.env },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		try {
			child.kill(signal);
		} catch {
			/* already gone */
		}
	});
}
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
