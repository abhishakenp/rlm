#!/usr/bin/env node
/**
 * rlm — self-evolving terminal agent.
 *
 * Modified Cordis host, DSH philosophy, no prime-agent code.
 * Everything is a plugin. The host boots Cordis, loads plugins from
 * config/profile.yml, then runs the TUI or print mode.
 *
 * HMR watches plugin source dirs — any plugin can be hot-swapped at runtime.
 * Foreground-only: process dies when terminal exits.
 * Session/memory data persists on disk under ~/.rlm/.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const profilePath = join(here, "config", "profile.yml");

// HMR requires --expose-internals. Re-spawn if not present.
if (!process.execArgv.includes("--expose-internals")) {
	const { spawn } = await import("node:child_process");
	const args = ["--expose-internals", fileURLToPath(import.meta.url), ...process.argv.slice(2)];
	const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
} else {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

async function bootCordis() {
	let Context, Loader, Timer, Include, Group;
	try {
		({ Context } = await import("@deepseek-ai/cordis"));
		Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
		Timer = (await import("@deepseek-ai/cordis-plugin-timer")).default;
		Include = (await import("@deepseek-ai/cordis-plugin-include")).default;
		({ Group } = await import("@deepseek-ai/cordis-plugin-loader"));
	} catch (error) {
		console.error("[rlm] Cordis unavailable:", error?.message ?? error);
		return null;
	}

	const ctx = new Context();
	ctx.baseUrl = pathToFileURL(here + "/").href;

	// Bedrock: loader + timer
	await ctx.plugin(Loader, { root: process.cwd() });
	ctx.plugin(Timer);

	const loader = ctx.get("loader");
	if (loader) {
		loader.builtins.include = Include;
		loader.builtins.group = Group;
	}

	// HMR — direct chokidar watcher. Emits rlm/hmr-change events that
	// plugins can listen for to reload themselves.
	// (Cordis's HMR plugin requires loader-internal module tracking
	// which doesn't work with direct import() plugin loading.)
	try {
		const { watch } = await import("chokidar");
		const { readdirSync, statSync } = await import("node:fs");
		// Chokidar doesn't expand globs — resolve actual plugin src dirs.
		const pluginDirs = readdirSync(join(here, "packages"))
			.filter((d) => d.startsWith("rlm-"))
			.map((d) => join("packages", d, "src"))
			.filter((p) => existsSync(join(here, p)));
		const watcher = watch(pluginDirs, {
			cwd: process.cwd(),
			ignored: ["**/node_modules", "**/.*", "**/dist", "cache", "data"],
			ignoreInitial: true,
			debounce: 100,
		});
		watcher.on("change", (path) => {
			console.error(`[rlm] HMR: ${path} changed`);
			ctx.emit("rlm/hmr-change", { path, url: pathToFileURL(join(process.cwd(), path)).href });
		});
		watcher.on("ready", () => {
			console.error(`[rlm] HMR active — watching ${pluginDirs.length} plugin dirs`);
		});
	} catch (error) {
		console.error("[rlm] HMR failed:", error?.message ?? error);
	}

	// Load plugins from profile YAML.
	if (existsSync(profilePath)) {
		await loadPlugins(ctx);
	}

	// Wait for all plugin services to initialize.
	await new Promise((r) => setTimeout(r, 500));

	return ctx;
}

async function loadPlugins(ctx) {
	const yaml = await import("yaml");
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
			console.error(`[rlm] loaded: ${pkgName}`);
		} catch (error) {
			console.error(`[rlm] failed: ${pkgName}: ${error?.message ?? error}`);
		}
	}

	// HMR reload handler — reload the changed plugin.
	ctx.on("rlm/hmr-change", async ({ path }) => {
		// Match path to plugin package name.
		const match = path.match(/packages\/(rlm-[^/]+)\//);
		if (!match) return;
		const pkgDir = match[1];
		const pkgName = `@rlm/${pkgDir.replace(/^rlm-/, "")}`;
		const entry = loaded.find((e) => e.pkgName === pkgName);
		if (!entry) {
			console.error(`[rlm] HMR: no tracked plugin for ${pkgName}`);
			return;
		}

		console.error(`[rlm] HMR: reloading ${pkgName}...`);
		try {
			// Dispose old fiber.
			if (entry.fiber?.dispose) {
				await entry.fiber.dispose();
			}

			// Clear module cache for this plugin.
			const modUrl = pathToFileURL(join(process.cwd(), "packages", pkgDir, "src", "index.ts")).href;
			// Node caches by resolved URL — cache-bust with query param.
			const cacheBust = `${modUrl}?hmr=${Date.now()}`;
			const mod = await import(cacheBust);
			const NewPlugin = mod.default ?? mod;

			// Register new plugin instance.
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

function parseArgs(argv) {
	const args = { print: false, prompt: null, verbose: false, rest: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--print") {
			args.print = true;
		} else if (arg === "--verbose") {
			args.verbose = true;
		} else if (arg === "--help" || arg === "-h") {
			args.help = true;
		} else {
			args.rest.push(arg);
		}
	}
	args.prompt = args.rest.join(" ");
	return args;
}

async function main() {
	const ctx = await bootCordis();
	if (!ctx) process.exit(1);

	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(`rlm — self-evolving terminal agent

Usage:
  rlm [options] [message]

Options:
  -p, --print     Print a response and exit
  --verbose       Show tool calls and results
  -h, --help      Show this help

Interactive mode:
  rlm             Start the interactive TUI
  rlm "message"   Run a one-shot prompt in interactive mode

Print mode:
  rlm -p "msg"    Print response and exit (no TUI)`);
		if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
		return;
	}

	const tui = ctx.get("rlmTui");
	if (!tui) {
		console.error("[rlm] TUI service not available");
		process.exit(1);
	}

	try {
		if (args.print && args.prompt) {
			// Print mode — one-shot, no TUI.
			await tui.runPrint(args.prompt);
		} else if (args.prompt) {
			// One-shot prompt in interactive mode.
			await tui.runPrint(args.prompt);
		} else {
			// Interactive TUI.
			await tui.startInteractive();
		}
	} catch (error) {
		console.error(`[rlm] ${error?.message ?? error}`);
		process.exit(1);
	} finally {
		if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
	}
}
