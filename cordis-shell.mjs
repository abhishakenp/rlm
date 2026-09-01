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
 *    - Plugin source: fs.watch → cache-clear + re-import + registry swap
 *    - All watchers registered as ctx.effect() — cleaned up on dispose
 * 5. Launches the agent via Cordis services (rlmAgent + rlmRenderer)
 *    No bundle import. No static import. Everything is a plugin.
 *
 * Config resolution (DSH-style layering):
 * - Root: cordis.yml at repo root
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
import { createRequire } from "node:module";

// HMR verbose logging — disabled by default to keep the TUI clean.
// Set RLM_HMR_VERBOSE=1 to see reload messages.
const hmrLog = (...args) => {
	if (process.env.RLM_HMR_VERBOSE) console.error(...args);
};

// Info logging — disabled by default to keep the TUI clean.
// Set RLM_VERBOSE=1 to see boot/info messages. Errors always show.
const rlmInfo = (...args) => {
	if (process.env.RLM_VERBOSE) console.error(...args);
};

const here = dirname(fileURLToPath(import.meta.url));

// HMR requires --expose-internals for Cordis loader internals.
// Dev mode: re-exec with tsx so HMR can re-import TS source.
// Installed mode: run with compiled JS plugins (no tsx, no HMR).
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
		// Installed mode: no tsx — use compiled JS plugins.
		// cordis.yml points to src/index.ts but tsx isn't available, so
		// rewrite paths to dist/index.js at runtime.
		// HMR is not available in installed mode (no source to watch).
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
 * Priority: CLI --config > project .rlm/cordis.yml > root cordis.yml
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
		console.error("[rlm] No cordis.yml found (looked: .rlm/cordis.yml, cordis.yml)");
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
			rlmInfo(`[rlm] config patches: ${patchPath}`);
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
		rlmInfo(`[rlm] config: ${configPath}`);
	} catch (error) {
		console.error(`[rlm] config load failed: ${error?.message ?? error}`);
		// Fallback to manual loading if Include fails.
		await loadPluginsManual(ctx, configPath);
	}

	// Wait for plugin services to initialize.
	await new Promise((r) => setTimeout(r, 500));

	// HMR via Cordis-native mechanisms — no chokidar.
	//
	// Source watching now belongs to the `hmr` plugin row (packages/rlm-hmr),
	// which watches recursively and therefore sees packages that appear after
	// boot — something a list derived here, once, never could. When that row is
	// present the shell installs config watching only; the source-watching half
	// below is superseded and can be deleted once the plugin has proven itself.
	const hmrPluginActive = !!ctx.get?.("rlmHmr");
	const hmrWatchers = installCordisHMR(ctx, {
		configPath,
		patchPath,
		includeEntry,
		here,
		skipSourceWatching: hmrPluginActive,
	});
	if (hmrPluginActive) hmrLog("[rlm] HMR: source watching delegated to the hmr plugin");

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
function installCordisHMR(ctx, { configPath, patchPath, includeEntry, here, skipSourceWatching }) {
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
	if (includeEntry) {
		const include = includeEntry.fiber?.ctx?.get("loader");
		const includeService = includeEntry.fiber?.ctx;
		watchPath(configPath, (changed) => {
			hmrLog(`[rlm] HMR: config changed → Include.refresh()`);
			const includeTree = includeEntry.subtree ?? includeEntry;
			if (includeTree?.refresh) {
				includeTree.refresh().catch((e) =>
					hmrLog(`[rlm] HMR: Include.refresh() failed: ${e?.message ?? e}`),
				);
			}
		});
		if (patchPath) {
			watchPath(patchPath, () => {
				hmrLog(`[rlm] HMR: patch changed → Include.refresh()`);
				const includeTree = includeEntry.subtree ?? includeEntry;
				if (includeTree?.refresh) {
					includeTree.refresh().catch((e) =>
						hmrLog(`[rlm] HMR: Include.refresh() failed: ${e?.message ?? e}`),
					);
				}
			});
		}
	}

	// 2. Plugin source watching → cache-clear + re-import + registry swap
	// When a plugin's source file changes, we clear the module from Node's
	// internal ESM loadCache (and CJS require.cache), re-import it fresh,
	// then swap the old plugin out of the registry and register the new one
	// with the old fibers' configs. This mirrors the official
	// @deepseek-ai/cordis-plugin-hmr approach.
	//
	// fiber.restart() alone does NOT work — it re-runs the plugin callback
	// but reuses the cached module, so source changes never take effect.
	const sourceDirs = [];
	for (const d of skipSourceWatching ? [] : readdirSync(join(here, "packages"))) {
		const srcPath = join("packages", d, "src");
		if (existsSync(join(here, srcPath))) sourceDirs.push(srcPath);
	}

	// Debounce: batch rapid saves into one reload pass.
	let hmrDebounceTimer = null;
	const hmrStashed = new Set(); // changed file URLs pending reload

	for (const dir of sourceDirs) {
		watchPath(join(here, dir), (changed) => {
			// Ignore test files, dist, node_modules, tsx cache, .map files
			if (changed.endsWith(".test.ts") || changed.endsWith(".test.js")) return;
			if (changed.includes("node_modules") || changed.includes("/dist/")) return;
			if (changed.endsWith(".map") || changed.endsWith(".d.ts")) return;
			if (changed.includes(".cache") || changed.includes("/.tsbuildinfo")) return;
			// Only react to .ts/.js source changes
			if (!changed.endsWith(".ts") && !changed.endsWith(".js")) return;

			hmrLog(`[rlm] HMR: ${changed} changed`);
			hmrStashed.add(pathToFileURL(changed).href);

			// Debounce 100ms — batch multiple file saves into one reload.
			if (hmrDebounceTimer) clearTimeout(hmrDebounceTimer);
			hmrDebounceTimer = setTimeout(() => {
				hmrDebounceTimer = null;
				const stashed = [...hmrStashed];
				hmrStashed.clear();
				partialReload(ctx, stashed).catch((e) =>
					hmrLog(`[rlm] HMR: partialReload failed: ${e?.message ?? e}`),
				);
			}, 100);

			// System prompt / skills / refinement files changed → emit prompt-changed.
			if (changed.includes("/prompts/") || changed.includes("/skills/") || changed.includes("/refinement/")) {
				hmrLog(`[rlm] HMR: prompt/skill/refinement changed → rebuilding system prompt`);
				ctx.emit("rlm/prompt-changed", { path: changed });
			}
		});
	}

	hmrLog(`[rlm] HMR active — watching ${sourceDirs.length} source dirs + config (Cordis-native, cache-clearing)`);

	// Return watchers so main() can close them on dispose.
	return watchers;
}

/**
 * Resolve a module specifier to a URL, compatible with Node 22-24.
 * v1: internal.resolve(specifier, parentURL, attrs) → Promise<ResolveResult>
 * v2: internal.resolveSync(parentURL, { specifier, attributes }) → ResolveResult
 */
async function resolveModuleURL(loader, specifier, parentURL) {
	const internal = loader.internal;
	if (!internal) return null;
	const attrs = {};
	switch (internal.version) {
		case "v1":
			return await internal.resolve(specifier, parentURL, attrs);
		case "v2":
			return internal.resolveSync(parentURL, { specifier, attributes: attrs });
		default:
			return null;
	}
}

/**
 * Get the URLs of modules that depend on (import) the given URL.
 * Uses loadCache.get() (custom method) which returns ModuleJob directly
 * on all Node versions (22/23 direct, 24+ wrapper extraction handled internally).
 */
async function getLinked(internal, url) {
	const job = internal.loadCache.get(url);
	if (!job) return [];
	const linked = await job.linked;
	if (!linked || !Array.isArray(linked)) return [];
	return Array.prototype.map.call(linked, (j) => j.url);
}

/**
 * Recursively collect all module dependencies from a URL.
 * Skips node: builtins and node_modules to focus on user code.
 * Mirrors official cordis-plugin-hmr loadDependencies().
 */
async function loadDependencies(internal, url, ignored = new Set()) {
	const dependencies = new Set();
	async function traverse(url) {
		if (ignored.has(url) || dependencies.has(url)) return;
		if (url.startsWith("node:") || url.includes("/node_modules/")) return;
		dependencies.add(url);
		const linked = await getLinked(internal, url);
		await Promise.all(linked.map(traverse));
	}
	await traverse(url);
	return dependencies;
}

/**
 * Partial reload — the core HMR logic.
 *
 * Mirrors the official @deepseek-ai/cordis-plugin-hmr partialReload():
 * 1. Classify changed files into accepted (should reload) and declined (should not)
 * 2. For each plugin entry: resolve its module URL, check if it or any dep is accepted
 * 3. Clear the accepted URLs from ESM loadCache + CJS require.cache
 * 4. Re-import the plugin entry files fresh
 * 5. registry.delete(oldPlugin) — disposes all old fibers
 * 6. For each old fiber: registry.plugin(newPlugin, oldFiber._config) → new fiber
 * 7. Set fiber.entry = oldFiber.entry; fiber.entry.fiber = fiber
 * 8. On error: rollback caches and re-register old plugins
 */
async function partialReload(ctx, stashedURLs) {
	const loader = ctx.loader;
	if (!loader?.internal) {
		hmrLog(`[rlm] HMR: loader.internal unavailable — cannot reload (need --expose-internals)`);
		return;
	}
	const internal = loader.internal;
	const require = createRequire(import.meta.url);

	// ── 1. Classify changes (analyzeChanges) ──
	const accepted = new Set(stashedURLs);
	const declined = new Set();
	const isExcluded = (url) => url.startsWith("node:") || url.includes("/node_modules/");

	// Expand accepted set via dependent analysis.
	const pending = [];
	for (const url of stashedURLs) {
		const linked = await getLinked(internal, url);
		for (const child of linked) {
			if (accepted.has(child) || declined.has(child) || isExcluded(child)) continue;
			pending.push(child);
		}
	}

	// Propagate acceptance: a file is accepted if any dependent is accepted.
	while (pending.length) {
		let index = 0, hasUpdate = false;
		while (index < pending.length) {
			const url = pending[index];
			const linked = await getLinked(internal, url);
			if (linked.length === 0) {
				pending.splice(index, 1); hasUpdate = true; declined.add(url); continue;
			}
			let isDeclined = true, isAccepted = false;
			for (const child of linked) {
				if (declined.has(child) || isExcluded(child)) continue;
				if (accepted.has(child)) { isAccepted = true; break; }
				else {
					isDeclined = false;
					if (!pending.includes(child)) { hasUpdate = true; pending.push(child); }
				}
			}
			if (isAccepted || isDeclined) {
				hasUpdate = true;
				pending.splice(index, 1);
				if (isAccepted) accepted.add(url);
				else declined.add(url);
			} else { index++; }
		}
		if (!hasUpdate) break;
	}
	for (const url of pending) declined.add(url);

	// ── 2. Find plugins whose dependency tree includes accepted files ──
	// Build a map of plugin names per config tree URL (matches official approach).
	const nameMap = {}; // baseUrl → Set<name>
	for (const entry of loader.entries()) {
		const baseUrl = entry.parent?.tree?.ctx?.baseUrl;
		if (!baseUrl) continue;
		(nameMap[baseUrl] ??= new Set()).add(entry.options.name);
	}

	// First pass: resolve all plugin entry URLs and add to pending.
	// Use loadCache.get() (custom method) for reading job data — handles Node 24 wrapper.
	const allPending = new Map(); // job → { plugin, url, entry }
	for (const baseUrl in nameMap) {
		for (const name of nameMap[baseUrl]) {
			try {
				const result = await resolveModuleURL(loader, name, baseUrl);
				if (!result?.url) continue;
				if (declined.has(result.url)) continue;
				const job = internal.loadCache.get(result.url);
				if (!job) continue;
				const plugin = loader.unwrapExports(job.module?.getNamespace?.());
				if (!plugin) continue;
				allPending.set(job, { plugin, url: result.url });
				declined.add(result.url); // temp add to avoid re-resolving
			} catch (e) {
				// resolve failed — skip
			}
		}
	}

	// Second pass: check each plugin's dependency tree for accepted files.
	// KEY: DELETE the plugin's own URL from declined before traversing, so
	// the entry file itself is included in dependencies. This matches the
	// official cordis-plugin-hmr approach exactly.
	const reloads = new Map(); // url → { plugin, runtime }
	for (const [job, { plugin, url }] of allPending) {
		declined.delete(url);
		const deps = [...await loadDependencies(internal, url, declined)];
		declined.add(url);

		if (!deps.some((dep) => accepted.has(dep))) continue;
		deps.forEach((dep) => accepted.add(dep));

		const runtime = ctx.registry.get(plugin);
		if (!runtime) continue;

		reloads.set(url, { plugin, runtime });
	}

	if (reloads.size === 0) {
		hmrLog(`[rlm] HMR: no plugins affected by ${stashedURLs.length} changed file(s)`);
		return;
	}

	hmrLog(`[rlm] HMR: ${reloads.size} plugin(s) to reload`);

	// ── 3. Clear caches for all accepted files ──
	// Use Map.prototype methods for backup/clear — Node 24 LoadCache.delete()
	// only sets the type slot to undefined, doesn't remove the entry.
	const esmBackup = {};
	const cjsBackup = {};
	for (const filename of accepted) {
		const raw = Map.prototype.get.call(internal.loadCache, filename);
		esmBackup[filename] = raw;
		Map.prototype.delete.call(internal.loadCache, filename);
		try {
			const filepath = fileURLToPath(filename);
			if (require.cache[filepath]) {
				cjsBackup[filepath] = require.cache[filepath];
				delete require.cache[filepath];
			}
		} catch { /* not a file: URL */ }
	}

	const rollback = () => {
		for (const filename in esmBackup) {
			Map.prototype.set.call(internal.loadCache, filename, esmBackup[filename]);
		}
		for (const filepath in cjsBackup) {
			require.cache[filepath] = cjsBackup[filepath];
		}
	};

	// ── 4. Re-import plugin entry files fresh ──
	// Use loader.import(filename, getOuterStack) — the filename URL, not plugin name.
	const getOuterStack = () => [];
	const attempts = {}; // url → new plugin exports
	try {
		for (const [url] of reloads) {
			attempts[url] = loader.unwrapExports(
				await loader.import(url, getOuterStack),
			);
		}
	} catch (e) {
		hmrLog(`[rlm] HMR: re-import failed: ${e?.message ?? e}`);
		rollback();
		return;
	}

	// ── 5-7. Swap plugins: registry.delete(old) + registry.plugin(new) ──
	// Matches official cordis-plugin-hmr reload() helper exactly.
	const reload = (plugin, runtime) => {
		if (!runtime) return;
		for (const oldFiber of runtime.fibers) {
			const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, getOuterStack);
			fiber.entry = oldFiber.entry;
			if (fiber.entry) fiber.entry.fiber = fiber;
		}
	};

	for (const [url, { plugin: oldPlugin, runtime }] of reloads) {
		const newPlugin = attempts[url];
		if (!newPlugin) continue;
		const path = url.replace(ctx.baseUrl, "");

		try {
			ctx.registry.delete(oldPlugin);
		} catch (e) {
			hmrLog(`[rlm] HMR: failed to dispose old plugin at ${path}: ${e?.message ?? e}`);
		}

		try {
			reload(newPlugin, runtime);
			hmrLog(`[rlm] HMR: reloaded plugin at ${path}`);
		} catch (e) {
			hmrLog(`[rlm] HMR: failed to reload plugin at ${path}: ${e?.message ?? e}`);
			rollback();
			for (const [url2, { plugin: oldPlugin2, runtime: runtime2 }] of reloads) {
				if (oldPlugin2 === oldPlugin) continue;
				try { ctx.registry.delete(attempts[url2]); } catch {}
				reload(oldPlugin2, runtime2);
			}
			return;
		}
	}

	ctx.emit("rlm/hmr-reload", { reloaded: [...reloads.keys()] });
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
			rlmInfo(`[rlm] loaded plugin: ${pkgName}`);
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

	rlmInfo(`[rlm] code tool is native built-in`);

	// Inject the context registry proxy into the agent session.
	globalThis.__rlmCordisContext = ctx;
	try {
		const contextService = ctx.get("rlmContext");
		if (contextService) {
			const { createContextProxy } = await import("./packages/rlm-context/src/index.ts");
			globalThis.__rlmContextProxy = createContextProxy(contextService);
			rlmInfo(`[rlm] context registry active`);
		}
	} catch (error) {
		console.error(`[rlm] context registry unavailable: ${error?.message ?? error}`);
	}

	// Determine mode: --print → print mode, otherwise interactive.
	const printIdx = process.argv.indexOf("--print");
	const isPrint = printIdx !== -1 && process.argv[printIdx + 1];
	const isPiped = !process.stdin.isTTY;

	try {
		if (isPrint || isPiped) {
			// Print mode: use the rlmPrint service.
			const printService = ctx.get("rlmPrint");
			if (!printService) {
				throw new Error("rlmPrint service not available — plugin failed to load");
			}

			// Resolve prompt: --print "..." flag, or piped stdin.
			let prompt = isPrint ? process.argv[printIdx + 1] : "";
			if (!prompt && isPiped) {
				prompt = await new Promise((resolve) => {
					let data = "";
					process.stdin.setEncoding("utf8");
					process.stdin.on("data", (chunk) => { data += chunk; });
					process.stdin.on("end", () => { resolve(data.trim() || ""); });
					process.stdin.resume();
				});
			}

			if (!prompt) {
				rlmInfo("[rlm] print mode: no prompt provided (use --print \"...\" or pipe stdin)");
				if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
				for (const w of hmrWatchers ?? []) { try { w.close(); } catch {} }
				process.exit(1);
			}

			rlmInfo(`[rlm] print mode via rlmPrint (Cordis service)`);
			const exitCode = await printService.run({
				mode: "text",
				initialMessage: prompt,
			});
			if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
			for (const w of hmrWatchers ?? []) { try { w.close(); } catch {} }
			process.exit(exitCode ?? 0);
		}

		// Interactive mode: use the rlmRenderer service.
		const rendererService = ctx.get("rlmRenderer");
		if (!rendererService) {
			throw new Error("rlmRenderer service not available — plugin failed to load");
		}
		rlmInfo(`[rlm] interactive mode via rlmRenderer (Cordis service)`);
		await rendererService.start({ cwd: process.cwd() });
	} catch (error) {
		console.error(`[rlm] fatal: ${error?.message ?? error}`);
		if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
		for (const w of hmrWatchers ?? []) { try { w.close(); } catch {} }
		process.exit(1);
	}

	// Cleanup on normal exit.
	if (ctx?.fiber?.dispose) await ctx.fiber.dispose();
	for (const w of hmrWatchers ?? []) { try { w.close(); } catch {} }

	if (!process.stdout.isTTY) {
		process.exit(0);
	}
}
