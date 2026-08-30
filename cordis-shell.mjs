#!/usr/bin/env node
/**
 * rlm — self-evolving terminal agent.
 *
 * Prime-agent UI + Cordis plugin architecture + HMR hot-swap.
 * Everything runs in-process. No daemon. Foreground-only.
 *
 * The host:
 * 1. Boots Cordis Context with baseUrl = repo root
 * 2. Loads Cordis Loader + Include plugins (DSH-style)
 * 3. Include reads cordis.yml, Loader imports each plugin module
 * 4. HMR via Cordis-native mechanisms (no chokidar):
 *    - Config files: fs.watch → Include.refresh()
 *    - Plugin source: fs.watch → entry.fiber.restart()
 *    - All watchers registered as ctx.effect() — cleaned up on dispose
 * 5. Launches rlm runCli() in-process (interactive TUI or print mode)
 *
 * Config resolution (DSH-style layering):
 * - Root: cordis.yml at repo root (or config/profile.yml fallback)
 * - Project: .rlm/cordis.yml (if present)
 * - Global: ~/.rlm/cordis.yml (if present)
 * - Patches: ~/.rlm/cordis.patch.yml (applied last)
 *
 * HMR follows the Cordis philosophy: plugins are disposable, reloadable
 * fibers. Editing any source file triggers fiber.restart() — old fiber
 * disposes in background, new fiber loads with fresh module import.
 * Active sessions are NEVER interrupted — only the next turn uses new code.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { watch as fsWatch } from "node:fs";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

// HMR requires --expose-internals for Cordis loader internals.
// Dev mode: re-exec with tsx so HMR can re-import TS source.
// Installed mode: run directly — plugins are compiled JS, CLI is bundled JS.
if (!process.execArgv.includes("--expose-internals")) {
	const { spawn } = await import("node:child_process");

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

/**
 * Resolve the cordis.yml config path using DSH-style layering.
 * Priority: CLI --config > project .rlm/cordis.yml > root cordis.yml > config/profile.yml
 * Patches: ~/.rlm/cordis.patch.yml (applied after base config)
 */
function resolveConfigPath() {
	// CLI --config override
	const configIdx = process.argv.indexOf("--config");
	if (configIdx !== -1 && process.argv[configIdx + 1]) {
		return { path: process.argv[configIdx + 1], patches: null };
	}

	// Project-local .rlm/cordis.yml
	const projectConfig = join(process.cwd(), ".rlm", "cordis.yml");
	if (existsSync(projectConfig)) {
		return { path: projectConfig, patches: resolvePatchPath() };
	}

	// Root cordis.yml (DSH convention)
	const rootConfig = join(here, "cordis.yml");
	if (existsSync(rootConfig)) {
		return { path: rootConfig, patches: resolvePatchPath() };
	}

	// Fallback: config/profile.yml (legacy)
	const legacyConfig = join(here, "config", "profile.yml");
	if (existsSync(legacyConfig)) {
		return { path: legacyConfig, patches: resolvePatchPath() };
	}

	return { path: null, patches: null };
}

function resolvePatchPath() {
	// Global patch: ~/.rlm/cordis.patch.yml
	const globalPatch = join(homedir(), ".rlm", "cordis.patch.yml");
	if (existsSync(globalPatch)) return globalPatch;

	// Project patch: .rlm/cordis.patch.yml
	const projectPatch = join(process.cwd(), ".rlm", "cordis.patch.yml");
	if (existsSync(projectPatch)) return projectPatch;

	return null;
}

async function bootCordis() {
	let Context, Loader, Include;
	try {
		({ Context } = await import("@deepseek-ai/cordis"));
		Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
		Include = (await import("@deepseek-ai/cordis-plugin-include")).default;
	} catch (error) {
		console.error("[rlm] Cordis unavailable:", error?.message ?? error);
		return null;
	}

	const ctx = new Context();
	ctx.baseUrl = pathToFileURL(here + "/").href;

	// Load the Cordis Loader plugin — provides ctx.loader
	await ctx.plugin(Loader);

	// Resolve config path using DSH-style layering.
	const { path: configPath, patches: patchPath } = resolveConfigPath();
	if (!configPath) {
		console.error("[rlm] No cordis.yml found (looked: .rlm/cordis.yml, cordis.yml, config/profile.yml)");
		process.exit(1);
	}

	// Load the Include plugin — reads the YAML, imports each plugin module.
	// The Include plugin handles module resolution (bare packages, relative
	// paths, cordis: builtins) via the Loader's ModuleLoader.
	// Include resolves `path` relative to ctx.baseUrl, so use a relative path
	// when the config is inside the repo, or an absolute file:// URL otherwise.
	let resolvedPath;
	if (configPath.startsWith(here)) {
		resolvedPath = "./" + configPath.slice(here.length + 1);
	} else {
		resolvedPath = pathToFileURL(configPath).href;
	}

	// Load patches if present.
	let patches = undefined;
	if (patchPath) {
		const yaml = await import("yaml");
		const { readFileSync } = await import("node:fs");
		try {
			const patchContent = readFileSync(patchPath, "utf-8");
			patches = yaml.parse(patchContent) ?? [];
			console.error(`[rlm] config patches: ${patchPath}`);
		} catch (error) {
			console.error(`[rlm] patch load failed (${patchPath}): ${error?.message ?? error}`);
		}
	}

	let includeEntry = null;
	try {
		const entryId = await ctx.loader.create({
			name: "@deepseek-ai/cordis-plugin-include",
			config: { path: resolvedPath, patches, enableLogs: false },
		});
		includeEntry = ctx.loader.resolve(entryId);
		console.error(`[rlm] config: ${configPath}`);
	} catch (error) {
		console.error(`[rlm] config load failed: ${error?.message ?? error}`);
		// Fallback to manual loading if Include fails.
		await loadPluginsManual(ctx, configPath);
	}

	// Wait for plugin services to initialize.
	await new Promise((r) => setTimeout(r, 500));

	// HMR via Cordis-native mechanisms — no chokidar.
	const hmrWatchers = installCordisHMR(ctx, { configPath, patchPath, includeEntry, here });

	return { ctx, hmrWatchers };
}

/**
 * Install Cordis-native HMR using Node's fs.watch registered as ctx.effect().
 *
 * Two kinds of watching:
 * 1. Config files (cordis.yml, patches) → Include.refresh()
 *    Re-reads YAML, transactionally updates entries, old fibers dispose.
 * 2. Plugin source dirs (packages/.../src) → entry.fiber.restart()
 *    Re-imports the module, old fiber disposes, new fiber loads.
 *
 * Watchers are closed in main()'s finally block after Cordis root fiber dispose.
 * No external dependencies. No chokidar.
 */
function installCordisHMR(ctx, { configPath, patchPath, includeEntry, here }) {
	const watchers = [];

	function watchPath(path, onChange) {
		if (!existsSync(path)) return;
		try {
			const w = fsWatch(path, { recursive: true }, (event, filename) => {
				if (!filename) return;
				onChange(join(path, filename));
			});
			watchers.push(w);
		} catch {
			try {
				const w = fsWatch(path, (event, filename) => {
					onChange(filename ? join(path, filename) : path);
				});
				watchers.push(w);
			} catch { /* best effort */ }
		}
	}

	// 1. Config file watching → Include.refresh()
	// When cordis.yml or patch files change, re-read and transactionally
	// update all entries. Old fibers dispose, new fibers load.
	if (includeEntry) {
		const include = includeEntry.fiber?.ctx?.get("loader");
		// The Include service is accessible via the entry's context.
		// includeEntry.fiber.ctx is the child context where Include runs.
		const includeService = includeEntry.fiber?.ctx;
		watchPath(configPath, (changed) => {
			console.error(`[rlm] HMR: config changed → Include.refresh()`);
			// Call refresh() on the Include entry tree — re-reads YAML,
			// transactionally updates child entries.
			const includeTree = includeEntry.subtree ?? includeEntry;
			if (includeTree?.refresh) {
				includeTree.refresh().catch((e) =>
					console.error(`[rlm] HMR: Include.refresh() failed: ${e?.message ?? e}`),
				);
			}
		});
		if (patchPath) {
			watchPath(patchPath, () => {
				console.error(`[rlm] HMR: patch changed → Include.refresh()`);
				const includeTree = includeEntry.subtree ?? includeEntry;
				if (includeTree?.refresh) {
					includeTree.refresh().catch((e) =>
						console.error(`[rlm] HMR: Include.refresh() failed: ${e?.message ?? e}`),
					);
				}
			});
		}
	}

	// 2. Plugin source watching → fiber.restart()
	// When a plugin's source file changes, find the affected loader entry
	// and restart its fiber. Old fiber disposes in background, new fiber
	// loads with fresh module import. Active work is NEVER interrupted.
	const sourceDirs = [];
	for (const d of readdirSync(join(here, "packages"))) {
		const srcPath = join("packages", d, "src");
		if (existsSync(join(here, srcPath))) sourceDirs.push(srcPath);
	}

	for (const dir of sourceDirs) {
		watchPath(join(here, dir), (changed) => {
			if (changed.endsWith(".test.ts") || changed.endsWith(".test.js")) return;
			if (changed.includes("node_modules") || changed.includes("/dist/")) return;

			console.error(`[rlm] HMR: ${changed} changed`);

			// Find the affected loader entry and restart its fiber.
			// The Loader maps plugin module specifiers to entries.
			restartAffectedFiber(ctx, changed);

			// System prompt / skills / refinement files changed → emit prompt-changed.
			// The agent session listens and rebuilds the system prompt on next turn.
			if (changed.includes("/prompts/") || changed.includes("/skills/") || changed.includes("/refinement/")) {
				console.error(`[rlm] HMR: prompt/skill/refinement changed → rebuilding system prompt`);
				ctx.emit("rlm/prompt-changed", { path: changed });
			}
		});
	}

	console.error(`[rlm] HMR active — watching ${sourceDirs.length} source dirs + config (Cordis-native)`);

	// Return watchers so main() can close them on dispose.
	return watchers;
}

/**
 * Find the loader entry whose plugin source includes `changed` and restart its fiber.
 *
 * The Loader stores entries by id. Each entry has a `name` (module specifier)
 * and a `fiber`. We match by checking if the changed file path is within the
 * plugin's source directory, then call fiber.restart() to reload it.
 */
function restartAffectedFiber(ctx, changed) {
	if (!ctx.loader) return;

	// Map changed file path to plugin package name.
	// e.g. packages/rlm-context/src/index.ts → rlm-context
	const match = changed.match(/packages\/([^/]+)\//);
	if (!match) return;
	const pkgDir = match[1];

	// Iterate all loader entries (including nested Include subtrees) and
	// find one whose module specifier includes pkgDir.
	for (const entry of ctx.loader.entries()) {
		if (!entry?.fiber?.uid) continue;
		const entryName = entry.options?.name ?? "";
		// Match by package dir name in the module specifier.
		if (entryName.includes(pkgDir)) {
			console.error(`[rlm] HMR: restarting fiber "${entry.id}" (${entryName})`);
			entry.fiber.restart().catch((e) =>
				console.error(`[rlm] HMR: fiber.restart() failed for "${entry.id}": ${e?.message ?? e}`),
			);
			return;
		}
	}
	// If no matching entry found, the changed file might be in a core package
	// (coding-agent, ai, tui) that's bundled rather than loaded as a plugin.
	// Those require a full process restart — emit an event for the agent to handle.
	ctx.emit("rlm/hmr-change", { path: changed, url: pathToFileURL(changed).href });
}

/**
 * Fallback manual plugin loader — used if Cordis Include fails.
 * This is the old approach: parse YAML, import() each module, ctx.plugin().
 */
async function loadPluginsManual(ctx, configPath) {
	const yaml = await import("yaml");
	const { readFileSync } = await import("node:fs");
	const content = readFileSync(configPath, "utf-8");
	const profile = yaml.parse(content);
	const entries = Array.isArray(profile) ? profile : (profile?.plugins ?? []);

	for (const entry of entries) {
		const pkgName = entry.name ?? entry;
		if (pkgName?.startsWith("cordis:")) continue;
		const config = expandPaths(entry.config ?? {});
		try {
			const mod = await import(pkgName);
			const Plugin = mod.default ?? mod;
			ctx.plugin(Plugin, config);
			console.error(`[rlm] loaded plugin: ${pkgName}`);
		} catch (error) {
			console.error(`[rlm] plugin failed: ${pkgName}: ${error?.message ?? error}`);
		}
	}
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
	const { ctx, hmrWatchers } = await bootCordis();
	if (!ctx) process.exit(1);

	// The code tool is now the native built-in — no override injection needed.
	console.error(`[rlm] code tool is native built-in`);

	// Inject the context registry proxy into the agent session.
	// The context service is a Cordis plugin — we expose it via globalThis
	// so agent-session.ts can pass it into the code tool's VM context.
	// Also expose the Cordis context itself for HMR event listening.
	globalThis.__rlmCordisContext = ctx;
	try {
		const contextService = ctx.get("rlmContext");
		if (contextService) {
			const { createContextProxy } = await import("./packages/rlm-context/src/index.ts");
			globalThis.__rlmContextProxy = createContextProxy(contextService);
			console.error(`[rlm] context registry active`);
		}
	} catch (error) {
		console.error(`[rlm] context registry unavailable: ${error?.message ?? error}`);
	}

	// Launch rlm in-process.
	try {
		const bundlePath = join(here, "packages", "coding-agent", "dist", "bundle", "cli-main.js");
		const { runCli } = await import(bundlePath);
		await runCli();
	} catch (error) {
		console.error(`[rlm] agent failed: ${error?.message ?? error}`);
		process.exit(1);
	} finally {
		// Dispose Cordis root fiber — all plugin fibers unload.
		if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
		// Close HMR watchers.
		for (const w of hmrWatchers ?? []) {
			try { w.close(); } catch { /* best effort */ }
		}
	}

	if (!process.stdout.isTTY) {
		process.exit(0);
	}
}
