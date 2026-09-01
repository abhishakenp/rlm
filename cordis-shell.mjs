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
		process.exit(1);
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

	const entry = ctx.loader.resolve(
		await ctx.loader.create({
			name: "@deepseek-ai/cordis-plugin-include",
			// Bare specifiers inside the composition resolve against the
			// composition's own directory, so a config passed by absolute path
			// still finds packages the way `cordis.yml` does.
			config: { path: pathToFileURL(composition).href, enableLogs: false },
		}),
	);

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

	const code = await modes.dispatch();
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
