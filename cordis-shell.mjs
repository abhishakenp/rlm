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
 * 4. Starts chokidar HMR watcher on all package source dirs
 * 5. Launches rlm runCli() in-process (interactive TUI or print mode)
 *
 * Config resolution (DSH-style layering):
 * - Root: cordis.yml at repo root (or config/profile.yml fallback)
 * - Project: .rlm/cordis.yml (if present)
 * - Global: ~/.rlm/cordis.yml (if present)
 * - Patches: ~/.rlm/cordis.patch.yml (applied last)
 *
 * HMR: editing any plugin source file triggers hot-swap (new generation
 * takes over, old fiber disposed in background — active sessions never
 * interrupted).
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";
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

	try {
		await ctx.loader.create({
			name: "@deepseek-ai/cordis-plugin-include",
			config: { path: resolvedPath, patches, enableLogs: false },
		});
		console.error(`[rlm] config: ${configPath}`);
	} catch (error) {
		console.error(`[rlm] config load failed: ${error?.message ?? error}`);
		// Fallback to manual loading if Include fails.
		await loadPluginsManual(ctx, configPath);
	}

	// Wait for plugin services to initialize.
	await new Promise((r) => setTimeout(r, 500));

	// HMR — chokidar watcher on all package source dirs.
	// Emits rlm/hmr-change events. Plugin reload handler
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

		// Watch rlm source dirs (tui, ai, agent, coding-agent)
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

			// System prompt / skills / refinement files changed → emit prompt-changed.
			// The agent session listens for this and rebuilds the system prompt
			// on the next turn. Active work is NEVER interrupted — only the
			// next LLM turn uses the new prompt. Context variables update live.
			if (path.includes("/prompts/") || path.includes("/skills/") || path.includes("/refinement/")) {
				console.error(`[rlm] HMR: prompt/skill/refinement changed → rebuilding system prompt`);
				ctx.emit("rlm/prompt-changed", { path });
			}
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

	return ctx;
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
	const ctx = await bootCordis();
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
	if (!process.stdout.isTTY) {
		process.exit(0);
	}
}
