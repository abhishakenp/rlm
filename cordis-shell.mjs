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
 * HMR: editing any plugin source file triggers dispose + reload.
 * The prime-agent TUI handles subagent visualization, streaming, tools, etc.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";

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
	ctx.on("rlm/hmr-change", async ({ path }) => {
		// Only reload rlm-* plugins (not prime-agent source — that's too complex for HMR).
		const match = path.match(/packages\/(rlm-[^/]+)\//);
		if (!match) return;
		const pkgDir = match[1];
		const pkgName = `@rlm/${pkgDir.replace(/^rlm-/, "")}`;
		const entry = loaded.find((e) => e.pkgName === pkgName);
		if (!entry) return;

		console.error(`[rlm] HMR: reloading ${pkgName}...`);
		try {
			if (entry.fiber?.dispose) {
				await entry.fiber.dispose();
			}
			const modUrl = pathToFileURL(join(process.cwd(), "packages", pkgDir, "src", "index.ts")).href;
			const cacheBust = `${modUrl}?hmr=${Date.now()}`;
			const mod = await import(cacheBust);
			const NewPlugin = mod.default ?? mod;
			entry.Plugin = NewPlugin;
			entry.fiber = ctx.plugin(NewPlugin, entry.config);
			console.error(`[rlm] HMR: ${pkgName} reloaded`);
		} catch (error) {
			console.error(`[rlm] HMR: reload failed for ${pkgName}: ${error?.message ?? error}`);
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
}
