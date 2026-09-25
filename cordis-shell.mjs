#!/usr/bin/env node
/**
 * rlm — the frozen bootstrap. Everything else lives in packages/rlm-host/src/shell.ts,
 * which hot-reloads itself and adopts the live Context (zero-restart design, Case 1).
 * This file only picks the runtime and hands over; editing it applies through the
 * host's execve-in-place path (same pid, same terminal). Do not add logic here.
 * Edit it atomically (write a temp file, then rename): every new rlm loads it.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const host = join(here, "packages", "rlm-host");
// Bun caps concurrent HTTP requests at 256 unless this is set before it starts; subagents
// past #256 queue for a socket (worker W). execve in place: same pid, ~20-40ms.
if (process.versions.bun && !process.env.BUN_CONFIG_MAX_HTTP_REQUESTS && typeof process.execve === "function") {
	process.execve(process.execPath, [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
		...process.env,
		BUN_CONFIG_MAX_HTTP_REQUESTS: "4096",
	});
}
// A re-evaluation of this file (a reloader importing it again) must not boot a second rlm.
if (!globalThis.__rlmHost) {
	globalThis.__rlmHost = { root: here, bootstrap: fileURLToPath(import.meta.url), generation: 0 };
	if (!process.versions.bun && !process.execArgv.includes("--expose-internals")) {
		await import(pathToFileURL(join(host, "src", "node-reexec.mjs")).href);
	} else {
		// If an edit left shell.ts unimportable, boot the last copy that ran.
		const shell = await import(pathToFileURL(join(host, "src", "shell.ts")).href).catch((error) =>
			import(pathToFileURL(join(host, "last-good", "shell.ts")).href).catch(() => Promise.reject(error)),
		);
		await shell.run(globalThis.__rlmHost);
	}
}
