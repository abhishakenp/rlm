#!/usr/bin/env node
/**
 * rlm — the host.
 *
 * ## The contract
 *
 * **This file should need editing as rarely as possible, and ideally never.**
 * Anything that has to be restarted to change is a thing rlm cannot change
 * about itself, and this file is the one thing a restart is required to change.
 * So it holds no policy, no capability, and no knowledge of what rlm does. It
 * does four things, and each is here for the same reason: it is what has to
 * exist before there is anywhere to put a row.
 *
 * 1. **Give the process the two things the composition cannot install for
 *    itself** — a TypeScript hook (every row names `.ts`) and Node's internal
 *    ESM loader (module hot reload needs it). Both come from the command line,
 *    so this file re-execs once. See the note on that below.
 * 2. **Create the root Context and mount the Loader.** There is nowhere to put
 *    a plugin until someone makes a context.
 * 3. **Mount one `cordis-plugin-include` on the composition.** The composition
 *    is a row in nothing; it is the file every row comes from.
 * 4. **Poll that file forever, and refresh on change.** This is the dead man's
 *    switch. The `boot` row does the real watching — but it is itself a row, so
 *    an edit that removes it would otherwise leave nobody reading the file it
 *    was removed from: an rlm that cannot see its own config, unrecoverably.
 *    One slow unconditional poll makes every such edit undoable by editing the
 *    file again. `refresh()` is transactional and short-circuits on unchanged
 *    content, so it costs nothing and never fights the `boot` row.
 *
 * Then it asks the `modes` row what this invocation is and does that.
 *
 * ## What is NOT here any more, and why that matters
 *
 * This file was 707 lines. It held config layering, config watching, mode
 * dispatch, a manual plugin loader, and — twice — a complete module hot-reload
 * engine that nothing could reach, because the official `hmr` plugin is
 * mounted as a row and does the same job. A bug in any of it cost a restart.
 * All of it is now rows:
 *
 * - config layering, the overlay, config watching, shutdown -> `rlm-boot`
 * - reading and rewriting the composition                   -> `rlm-compose`
 * - writing, mounting and reclaiming a new capability       -> `rlm-plugins`
 * - reaching all of that from a code cell                   -> `rlm-self`
 * - print vs interactive                                    -> `rlm-modes`
 * - module hot reload    -> `@deepseek-ai/cordis-plugin-hmr` + `rlm-hmr`
 *
 * If you are about to add a fifth thing here: it belongs in `rlm-boot`, or in
 * a row of its own.
 *
 * ## Why this still re-execs when `iris.mjs` does not
 *
 * Two flags, and only one of them can currently be dropped. The TypeScript
 * hook registers at runtime — `--import tsx` and `await import('tsx')` run the
 * same module, which calls `module.register()` on itself either way. But
 * `--expose-internals` has no runtime equivalent here: `cordis-plugin-loader`
 * reaches the internal loader through the optional peer
 * `node-addon-require-builtin` when the flag is absent, and that package is not
 * installed in this repo. Install it and this whole block can go. Until then,
 * dropping the re-exec would silently cost module hot reload, which is the
 * property the project exists to have.
 */
import { existsSync } from "node:fs";
import { watchFile } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** How often the dead man's switch re-reads the composition, in milliseconds. */
const POLL_MS = 1000;

/**
 * The exit code for "the host, not the work".
 *
 * `EX_CONFIG` from sysexits. Kept in step with `HOST_EXIT` in
 * `packages/rlm-delegate/src/host.ts`, which is the reader — this file cannot
 * import from a package, because it is what mounts the packages.
 */
const HOST_EXIT = 78;

/**
 * True once this process has booted without rows the composition asked for.
 *
 * Everything after a degraded boot is running on less than was declared, so a
 * failure below is at least as likely to be the missing row as the work. It is
 * a module-level flag rather than a return value because the thing that has to
 * read it is the top-level `catch`, which is nowhere near `main`.
 */
let degraded = false;

const die = (message) => {
	// The one place a bare write is right: this runs before any logger exists,
	// and the alternative to saying it here is not saying it.
	console.error("[rlm]", message);
	process.exit(1);
};

/**
 * Cordis's loader classifies Node's internal ESM loader and gives up below
 * Node 22, which is not a soft degradation: `cordis-plugin-hmr` throws, the
 * whole Include tree fails to apply, and rlm boots with no loader entries at
 * all. Every self-modification path reads `loader.entries()`, so on an old Node
 * rlm silently cannot change itself. This used to be caught by a fallback that
 * loaded the rows by hand and looked like success. Failing here instead.
 */
function requireModernNode() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major > 22 || (major === 22 && minor >= 8)) return;
	die(
		`rlm needs Node >= 22.8 and this is ${process.versions.node}.\n` +
			"        Below 22, Cordis cannot reach Node's internal ESM loader, so hot\n" +
			"        reload and self-modification are both unavailable. Try:\n" +
			"          fnm use 22 && rlm …   (or run rlm with a v22+ node on PATH)",
	);
}

requireModernNode();

if (!process.execArgv.includes("--expose-internals")) {
	const localTsx = join(here, "node_modules", "tsx", "dist", "loader.mjs");
	if (!existsSync(localTsx)) die("missing node_modules/tsx — run `npm install` first");
	const { spawn } = await import("node:child_process");
	const child = spawn(
		process.execPath,
		["--expose-internals", "--import", localTsx, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
		{ stdio: "inherit", env: process.env },
	);
	// Forward the signal rather than exiting on it, so the child's `rlm-boot`
	// row gets to unload the composition before this half goes away.
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
} else {
	await main().catch((error) => {
		console.error(`[rlm] fatal: ${error?.stack ?? error}`);
		// 1 means "this run failed". It does not distinguish "the work went
		// wrong" from "there was nowhere to do the work", and everything that
		// spawns rlm has to tell those apart: the delegate charges a task an
		// attempt for the first and must not for the second. So a boot that
		// came up short of the row this invocation needed exits EX_CONFIG
		// instead, and `packages/rlm-delegate/src/host.ts` reads it.
		process.exit(degraded ? HOST_EXIT : 1);
	});
}

/**
 * Which composition to mount. A path, and nothing about its contents — the
 * overlay that used to be read here is the `boot` row's business now, because
 * it has to be re-read every time it changes and this file runs once.
 */
function compositionPath() {
	const flag = process.argv.indexOf("--config");
	if (flag !== -1 && process.argv[flag + 1]) {
		const given = process.argv[flag + 1];
		return isAbsolute(given) ? given : resolve(process.cwd(), given);
	}
	const project = join(process.cwd(), ".rlm", "cordis.yml");
	if (existsSync(project)) return project;
	return join(here, "cordis.yml");
}

async function main() {
	const composition = compositionPath();
	if (!existsSync(composition)) die(`no composition at ${composition}`);

	const { Context } = await import("@deepseek-ai/cordis");
	const ctx = new Context();
	ctx.baseUrl = pathToFileURL(here + "/").href;
	await ctx.plugin((await import("@deepseek-ai/cordis-plugin-loader")).default);

	// Boot without the rows that will not load, rather than not at all.
	//
	// Cordis already protects a *running* process: a failed update rolls back
	// to the previous entry and only throws if the rollback itself fails. A
	// cold boot has nothing to roll back to, so one broken file refuses the
	// entire composition — and twice tonight that meant every `rlm` command
	// returned a stack trace while the running daemon carried on with its old
	// modules, so nothing looked wrong from outside.
	//
	// Both were an agent mid-edit: a stray `}` in rlm-sdk, and rlm-outloop
	// being written while mounted. Neither is a reason for the other
	// twenty-five rows to be unavailable.
	//
	// So: try the whole composition, and if it refuses, find the rows that
	// cannot be imported, write a composition without them, and boot that.
	// Loudly — a degraded boot that looks like a healthy one is worse than a
	// failed one.
	const boot = async (path) =>
		ctx.loader.resolve(
			await ctx.loader.create({
				name: "@deepseek-ai/cordis-plugin-include",
				// Bare specifiers inside the composition resolve against the
				// composition's own directory, so a config passed by absolute path
				// still finds packages the way `cordis.yml` does.
				config: { path: pathToFileURL(path).href, enableLogs: false },
			}),
		);

	let entry;
	/** The rows this boot went without. Named later, when a mode cannot run. */
	let broken = [];
	try {
		entry = await boot(composition);
	} catch (error) {
		broken = await unloadableRows(composition);
		if (!broken.length) throw error;
		const reduced = await withoutRows(composition, broken);
		degraded = true;
		process.stderr.write(
			`[rlm] ${broken.length} row(s) will not load and were left out of this boot: ${broken.join(", ")}\n` +
				`[rlm] ${String(error?.message ?? error).split("\n")[0]}\n`,
		);
		entry = await boot(reduced);
	}

	watchFile(composition, { interval: POLL_MS }, (curr, prev) => {
		if (curr.mtimeMs === prev.mtimeMs && curr.ino === prev.ino) return;
		// Errors are the `boot` row's to report; this path exists so the file
		// the host mounted is always being read by someone, and must not be able
		// to fail loudly enough to matter.
		Promise.resolve((entry.subtree ?? entry).refresh?.()).catch(() => {});
	});

	// The upstream agent tree reaches Cordis through this. It is a wire, not a
	// design, and it is here rather than in a row because the row that would
	// own it could be unloaded, which would take the agent's context with it.
	globalThis.__rlmCordisContext = ctx;

	const modes = await waitFor(ctx, "rlmModes");
	if (!modes) {
		die(
			"the `modes` row never started, so there is no surface to run.\n" +
				"        Check `cordis.yml` for a row with id `modes`, and the log for why it failed.",
		);
	}

	// A degraded boot removes rows by id and nothing recomputes who needed them.
	// `print` injects `rlmAgent`, so dropping the one row `agent` leaves `print`
	// sitting in the reduced composition, never reaching ACTIVE, and the mode
	// reports "the print row is not mounted" — a true sentence about a row that
	// is right there in the file, blaming the wrong thing. Say what actually
	// happened, and keep the original underneath it.
	const code = await modes.dispatch().catch((error) => {
		if (!degraded) throw error;
		throw new Error(
			`the composition cannot run this: it booted without ${broken.join(", ")}, and what was asked for ` +
				`needs a row that depends on that. This is the host, not the request — fix the row and run it ` +
				`again.\n  underneath: ${String(error?.message ?? error)}`,
			{ cause: error },
		);
	});
	await ctx.fiber.dispose().catch(() => {});
	// Interactive mode leaves the TTY as it found it and Node exits on its own;
	// anything else may be holding a handle upstream opened, so say the word.
	if (code !== 0 || !process.stdout.isTTY) process.exit(code);
}

/**
 * Wait for a service to exist.
 *
 * `ctx.get()` is strict about state — the providing fiber has to be ACTIVE, not
 * merely LOADING — so a probe taken the instant Include returns reports every
 * row as absent. There is no "the composition has settled" event to wait on,
 * and a row that never starts has to time out rather than hang the process.
 */
async function waitFor(ctx, service, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = ctx.get(service);
		if (found) return found;
		if (Date.now() > deadline) return undefined;
		await new Promise((r) => setTimeout(r, 25));
	}
}

/**
 * The rows whose entry cannot be imported, named.
 *
 * Only local rows are tried: a package from node_modules is the package
 * manager's problem, and importing every one of them would make a boot slow
 * enough that somebody turns this off.
 */
async function unloadableRows(composition) {
	const { readFileSync } = await import("node:fs");
	const { dirname, resolve } = await import("node:path");
	const root = dirname(composition);
	const rows = [];
	let current = null;
	for (const raw of readFileSync(composition, "utf8").split("\n")) {
		const line = raw.replace(/#.*$/, "");
		const id = line.match(/^-\s*id:\s*(\S+)/);
		if (id) {
			if (current) rows.push(current);
			current = { id: id[1], name: null };
			continue;
		}
		const name = line.match(/^\s+name:\s*['"]?([^'"\s]+)['"]?/);
		if (name && current && !current.name) current.name = name[1];
	}
	if (current) rows.push(current);

	const broken = [];
	for (const row of rows) {
		if (!row.name?.startsWith(".")) continue;
		try {
			const mod = await import(pathToFileURL(resolve(root, row.name)).href);
			const plugin = mod.default ?? mod;
			if (typeof plugin !== "function" && typeof plugin?.apply !== "function") broken.push(row.id);
		} catch {
			broken.push(row.id);
		}
	}
	return broken;
}

/** The same composition with the named rows removed, written beside it. */
async function withoutRows(composition, ids) {
	const { readFileSync, writeFileSync } = await import("node:fs");
	const lines = readFileSync(composition, "utf8").split("\n");
	const out = [];
	let skipping = false;
	for (const line of lines) {
		const id = line.match(/^-\s*id:\s*(\S+)/);
		if (id) skipping = ids.includes(id[1]);
		if (!skipping) out.push(line);
	}
	const reduced = composition.replace(/\.ya?ml$/, "") + ".degraded.yml";
	writeFileSync(reduced, out.join("\n"), "utf8");
	return reduced;
}
