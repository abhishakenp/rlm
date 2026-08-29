#!/usr/bin/env node
/**
 * rlm Cordis lifecycle shell.
 *
 * Boots a Cordis plugin host (loader + timer + include + HMR) as the outer
 * runtime, then hands control to the verbatim prime-agent coding-agent CLI
 * bundled at packages/coding-agent/dist/bundle/cli.js.
 *
 * This is the integration seam between the Cordis plugin foundation and the
 * prime-agent terminal-native agent brain. The Cordis host owns process
 * lifecycle (foreground-only: it dies with this process) and exposes HMR for
 * in-process plugin evolution; the coding-agent CLI owns the TUI, kernel,
 * refinement, recursive subagents, memory, and self-improvement behavior.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "packages", "coding-agent", "dist", "bundle", "cli.js");

async function bootCordis() {
	let Context, Loader, Timer, Include, Hmr;
	try {
		({ Context } = await import("@deepseek-ai/cordis"));
		Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
		Timer = (await import("@deepseek-ai/cordis-plugin-timer")).default;
		Include = (await import("@deepseek-ai/cordis-plugin-include")).default;
		Hmr = (await import("@deepseek-ai/cordis-plugin-hmr")).default;
	} catch (error) {
		// Cordis is optional at runtime; the agent brain runs without it.
		console.error("[rlm] Cordis unavailable, running agent brain directly:", error?.message ?? error);
		return null;
	}
	try {
		const ctx = new Context();
		ctx.plugin(Loader, { root: process.cwd() });
		ctx.plugin(Timer);
		ctx.plugin(Include);
		ctx.plugin(Hmr, {
			base: process.cwd(),
			root: ["packages"],
			ignored: ["**/node_modules", "**/.*", "**/dist", "cache", "data"],
			debounce: 100,
		});
		return ctx;
	} catch (error) {
		console.error("[rlm] Cordis boot failed, running agent brain directly:", error?.message ?? error);
		return null;
	}
}

async function main() {
	const ctx = await bootCordis();
	const args = process.argv.slice(2);
	const child = spawn(process.execPath, [cliPath, ...args], { stdio: "inherit" });
	child.on("exit", (code, signal) => {
		if (ctx?.fiber?.dispose) void ctx.fiber.dispose();
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
