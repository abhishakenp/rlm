#!/usr/bin/env node
/**
 * rlm — self-evolving terminal agent.
 *
 * Prime-agent UI + Cordis plugin architecture + HMR hot-swap.
 * Everything runs in-process. No daemon. Foreground-only.
 *
 * The host:
 * 1. Boots Cordis Context
 * 2. Loads rlm-* plugins from config/profile.yml
 * 3. Starts chokidar HMR watcher on all package source dirs
 * 4. Launches prime-agent's runCli() in-process (interactive TUI or print mode)
 *
 * HMR: editing any plugin source file triggers hot-swap (new generation
 * takes over, old fiber disposed in background — active sessions never
 * interrupted).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const profilePath = join(here, "config", "profile.yml");

// HMR requires --expose-internals for Cordis loader internals.
// Also needed for Node's module cache manipulation.
// Dev mode: re-exec with tsx so HMR can re-import TS source.
// Installed mode: run directly — plugins are compiled JS, CLI is bundled JS.
if (!process.execArgv.includes("--expose-internals")) {
	const { spawn } = await import("node:child_process");
	const { existsSync } = await import("node:fs");
	const { dirname, join } = await import("node:path");

	// Dev mode: if tsx is available locally, use it for HMR on TS source.
	const localTsx = join(here, "node_modules", "tsx", "dist", "loader.mjs");
	if (existsSync(localTsx)) {
		const args = [
			"--expose-internals",
			"--import", localTsx,
			fileURLToPath(import.meta.url),
			...process.argv.slice(2),
		];
		const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
		child.on("exit", (code, signal) => {
			if (signal) process.kill(process.pid, signal);
			else process.exit(code ?? 0);
		});
	} else {
		// Installed mode: no tsx, no HMR — run directly with compiled JS.
		main().catch((error) => {
			console.error(error);
			process.exit(1);
		});
	}
} else {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

async function bootCordis() {
	let Context;
	try {
		({ Context } = await import("@deepseek-ai/cordis"));
	} catch (error) {
		console.error("[rlm] Cordis unavailable:", error?.message ?? error);
		return null;
	}

	const ctx = new Context();
	ctx.baseUrl = pathToFileURL(here + "/").href;

	// HMR — chokidar watcher on all package source dirs.
	// Emits rlm/hmr-change events. Plugin reload handler in loadPlugins()
	// disposes the old fiber and re-imports the changed module.
	try {
		const { watch } = await import("chokidar");
		const watchDirs = [];
		let hmrReady = false;

		// Watch rlm-* plugin source dirs
		for (const d of readdirSync(join(here, "packages"))) {
			if (d.startsWith("rlm-")) {
				const srcPath = join("packages", d, "src");
				if (existsSync(join(here, srcPath))) watchDirs.push(srcPath);
			}
		}

		// Watch prime-agent source dirs (tui, ai, agent, coding-agent)
		for (const d of ["tui", "ai", "agent", "coding-agent"]) {
			const srcPath = join("packages", d, "src");
			if (existsSync(join(here, srcPath))) watchDirs.push(srcPath);
		}

		const watcher = watch(watchDirs, {
			cwd: process.cwd(),
			ignored: ["**/node_modules", "**/.*", "**/dist", "**/*.test.ts", "**/*.test.js"],
			ignoreInitial: true,
			debounce: 100,
		});

		watcher.on("change", (path) => {
			console.error(`[rlm] HMR: ${path} changed`);
			ctx.emit("rlm/hmr-change", { path, url: pathToFileURL(join(process.cwd(), path)).href });
		});

		watcher.on("ready", () => {
			if (!hmrReady) {
				hmrReady = true;
				console.error(`[rlm] HMR active — watching ${watchDirs.length} source dirs`);
			}
		});
	} catch (error) {
		console.error("[rlm] HMR failed:", error?.message ?? error);
	}

	// Load rlm-* plugins from profile YAML.
	if (existsSync(profilePath)) {
		await loadPlugins(ctx);
	}

	// Wait for plugin services to initialize.
	await new Promise((r) => setTimeout(r, 500));

	return ctx;
}

async function loadPlugins(ctx) {
	const yaml = await import("yaml");
	const { readFileSync } = await import("node:fs");
	const content = readFileSync(profilePath, "utf-8");
	const profile = yaml.parse(content);
	const entries = Array.isArray(profile) ? profile : (profile?.plugins ?? []);

	const loaded = [];
	for (const entry of entries) {
		const pkgName = entry.name ?? entry;
		if (pkgName?.startsWith("cordis:")) continue;
		const config = expandPaths(entry.config ?? {});
		try {
			const mod = await import(pkgName);
			const Plugin = mod.default ?? mod;
			const fiber = ctx.plugin(Plugin, config);
			loaded.push({ pkgName, config, fiber, Plugin });
			console.error(`[rlm] loaded plugin: ${pkgName}`);
		} catch (error) {
			console.error(`[rlm] plugin failed: ${pkgName}: ${error?.message ?? error}`);
		}
	}

	// HMR reload handler — reload the changed rlm-* plugin.
	// CRITICAL: never interrupt active sessions. The old fiber stays alive
	// until the new one is fully loaded and ready. Only then do we swap.
	// In-flight operations using the old service complete normally.
	ctx.on("rlm/hmr-change", async ({ path }) => {
		// Only reload rlm-* plugins (not prime-agent source — that's too complex for HMR).
		const match = path.match(/packages\/(rlm-[^/]+)\//);
		if (!match) return;
		const pkgDir = match[1];
		// Find the loaded entry by matching the package dir in the import path.
		const entry = loaded.find((e) => e.pkgName.includes(pkgDir));
		if (!entry) return;

		// Debounce: skip if already reloading this plugin.
		if (entry._reloading) return;
		entry._reloading = true;

		console.error(`[rlm] HMR: hot-swapping ${pkgDir}...`);
		try {
			// Load the new module FIRST — don't touch the old fiber yet.
			const modUrl = pathToFileURL(join(process.cwd(), "packages", pkgDir, "src", "index.ts")).href;
			const cacheBust = `${modUrl}?hmr=${Date.now()}`;
			const mod = await import(cacheBust);
			const NewPlugin = mod.default ?? mod;

			// Register the new plugin — it takes over the service name.
			const newFiber = ctx.plugin(NewPlugin, entry.config);

			// Swap: new fiber is active. Old fiber is disposed AFTER the swap.
			// Any in-flight calls on the old service have already captured their
			// reference and will complete normally — dispose just stops new
			// activations and cleans up timers/watchers.
			const oldFiber = entry.fiber;
			entry.Plugin = NewPlugin;
			entry.fiber = newFiber;

			// Dispose old fiber asynchronously — don't await, don't block.
			// If in-flight operations are still running, they complete on the
			// old service instance which remains in memory until GC.
			if (oldFiber?.dispose) {
				oldFiber.dispose().catch(() => {});
			}

			console.error(`[rlm] HMR: ${pkgDir} hot-swapped (old fiber disposed in background)`);
		} catch (error) {
			console.error(`[rlm] HMR: reload failed for ${pkgDir}: ${error?.message ?? error}`);
		} finally {
			entry._reloading = false;
		}
	});
}

function expandPaths(config) {
	const home = process.env.HOME ?? "~";
	const result = {};
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === "string" && value.startsWith("~")) {
			result[key] = join(home, value.slice(1));
		} else {
			result[key] = value;
		}
	}
	return result;
}

async function main() {
	const ctx = await bootCordis();
	if (!ctx) process.exit(1);

	// The code tool is now the native built-in — no override injection needed.
	// The CLI's createAllToolDefinitions() returns { code: createCodeToolDefinition(...) }
	// and the rlmCode Cordis service provides the execution backend.
	console.error(`[rlm] code tool is native built-in`);

	// Launch prime-agent in-process.
	// runCli() reads process.argv and dispatches to interactive mode or print mode.
	// The interactive mode uses InProcessAgentConnection (no daemon).
	// Import from the esbuild bundle (self-contained JS, no tsx needed).
	try {
		const bundlePath = join(here, "packages", "coding-agent", "dist", "bundle", "cli-main.js");
		const { runCli } = await import(bundlePath);
		await runCli();
	} catch (error) {
		console.error(`[rlm] agent failed: ${error?.message ?? error}`);
		process.exit(1);
	} finally {
		if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
	}

	// Print mode (-p) exits after the response. Interactive mode exits on Ctrl+C.
	// In both cases, chokidar watchers keep the process alive — force exit.
	// Only force-exit if stdout is not a TTY (print mode), or if the CLI
	// has finished. The prime-agent CLI calls process.exit() itself in
	// interactive mode, so this is a safety net for print mode.
	if (!process.stdout.isTTY) {
		process.exit(0);
	}
}
