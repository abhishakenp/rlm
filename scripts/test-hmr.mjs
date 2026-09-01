#!/usr/bin/env node
/**
 * HMR test — boots Cordis with a test plugin, modifies it, verifies reload.
 *
 * Tests the actual HMR logic from cordis-shell.mjs:
 *   1. Boot Cordis + Loader + Include with a test plugin
 *   2. Verify plugin v1 loaded
 *   3. Modify plugin source to v2
 *   4. Wait for fs.watch → debounce → partialReload
 *   5. Verify plugin v2 loaded (new code, not cached)
 *
 * Run: node --expose-internals --import tsx scripts/test-hmr.mjs
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// ── Setup: create a temp test plugin ──
const testPluginDir = join(repoRoot, "packages", "rlm-hmr-test", "src");
const testPluginPath = join(testPluginDir, "index.ts");
mkdirSync(testPluginDir, { recursive: true });

function writeTestPlugin(version) {
	writeFileSync(
		testPluginPath,
		`import { Service } from "@deepseek-ai/cordis";

let versionTag = "${version}";

export class HmrTestService extends Service {
	static inject = [] as const;
	static provide = "hmrTest" as const;

	constructor(ctx: any, config: any = {}) {
		super(ctx, undefined as any);
	}

	async [Service.init]() {
		(globalThis as any).__hmrTestVersion = versionTag;
		console.error("[hmr-test] loaded version: " + versionTag);
		this.ctx.emit("hmr-test/loaded", { version: versionTag });
	}
}

export default HmrTestService;
export const name = "rlm-hmr-test";
export const inject = [] as const;
`,
	);
}

// Create a temp cordis.yml
const testConfigPath = join(repoRoot, "cordis.hmr-test.yml");
writeFileSync(
	testConfigPath,
	`- id: hmrTest
  name: './packages/rlm-hmr-test/src/index.ts'
`,
);

// Cleanup on exit
function cleanup() {
	try { rmSync(join(repoRoot, "packages", "rlm-hmr-test"), { recursive: true }); } catch {}
	try { rmSync(testConfigPath); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

// ── Boot Cordis ──
writeTestPlugin("v1");

const { Context } = await import("@deepseek-ai/cordis");
const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;

const ctx = new Context();
ctx.baseUrl = pathToFileURL(repoRoot + "/").href;

await ctx.plugin(Loader);

const entryId = await ctx.loader.create({
	name: "@deepseek-ai/cordis-plugin-include",
	config: { path: "./cordis.hmr-test.yml", enableLogs: false },
});

// Wait for plugin to load
await new Promise((r) => setTimeout(r, 500));

// ── HMR helpers ──
const { createRequire } = await import("node:module");
const { watch: fsWatch } = await import("node:fs");
const require = createRequire(import.meta.url);

/**
 * Extract a ModuleJob from the loadCache, handling both Node 22/23 (direct)
 * and Node 24+ (wrapper { [type]: ModuleJob }).
 */
function getModuleJob(loadCache, url) {
	// Try custom .get() first — returns ModuleJob directly on all versions.
	try {
		const job = loadCache.get(url);
		if (job && (job.linked !== undefined || job.module !== undefined || job.url !== undefined)) {
			return job;
		}
	} catch {}
	// Fallback: Map.prototype.get returns raw value.
	const raw = Map.prototype.get.call(loadCache, url);
	if (!raw) return undefined;
	// Node 22/23: raw is a ModuleJob directly.
	if (raw.linked !== undefined || raw.module !== undefined || raw.url !== undefined) {
		return raw;
	}
	// Node 24+: raw is { [type]: ModuleJob } — extract first ModuleJob.
	for (const key of Object.keys(raw)) {
		const j = raw[key];
		if (j && (j.linked !== undefined || j.module !== undefined || j.url !== undefined)) {
			return j;
		}
	}
	return undefined;
}

async function resolveModuleURL(loader, specifier, parentURL) {
	const internal = loader.internal;
	if (!internal) return null;
	const attrs = {};
	switch (internal.version) {
		case "v1": return await internal.resolve(specifier, parentURL, attrs);
		case "v2": return internal.resolveSync(parentURL, { specifier, attributes: attrs });
		default: return null;
	}
}

async function getLinked(internal, url) {
	const job = getModuleJob(internal.loadCache, url);
	if (!job) return [];
	const linked = await job.linked;
	if (!linked || !Array.isArray(linked)) return [];
	return Array.prototype.map.call(linked, (j) => j.url);
}

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

async function partialReload(ctx, stashedURLs) {
	const loader = ctx.loader;
	if (!loader?.internal) {
		console.error("[hmr-test] loader.internal unavailable");
		return;
	}
	const internal = loader.internal;

	// ── 1. Classify changes (analyzeChanges) ──
	const accepted = new Set(stashedURLs);
	const declined = new Set();
	const isExcluded = (url) => url.startsWith("node:") || url.includes("/node_modules/");

	const pending = [];
	for (const url of stashedURLs) {
		const linked = await getLinked(internal, url);
		for (const child of linked) {
			if (accepted.has(child) || declined.has(child) || isExcluded(child)) continue;
			pending.push(child);
		}
	}

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
				else { isDeclined = false; if (!pending.includes(child)) { hasUpdate = true; pending.push(child); } }
			}
			if (isAccepted || isDeclined) {
				hasUpdate = true; pending.splice(index, 1);
				if (isAccepted) accepted.add(url); else declined.add(url);
			} else { index++; }
		}
		if (!hasUpdate) break;
	}
	for (const url of pending) declined.add(url);

	// ── 2. Find plugins whose dependency tree includes accepted files ──
	const nameMap = {};
	for (const entry of loader.entries()) {
		const baseUrl = entry.parent?.tree?.ctx?.baseUrl;
		if (!baseUrl) continue;
		(nameMap[baseUrl] ??= new Set()).add(entry.options.name);
	}

	// First pass: resolve all plugin entry URLs.
	const allPending = new Map(); // job → { plugin, url }
	for (const baseUrl in nameMap) {
		for (const name of nameMap[baseUrl]) {
			try {
				const result = await resolveModuleURL(loader, name, baseUrl);
				if (!result?.url) continue;
				if (declined.has(result.url)) continue;
				const job = getModuleJob(internal.loadCache, result.url);
				if (!job) continue;
				const plugin = loader.unwrapExports(job.module?.getNamespace?.());
				if (!plugin) continue;
				allPending.set(job, { plugin, url: result.url });
				declined.add(result.url);
			} catch (e) {
				console.error("[hmr-test] resolve error for " + name + ": " + e);
			}
		}
	}

	// Second pass: check deps. DELETE url from declined before traversing
	// so the entry file itself is included in dependencies.
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
		console.error("[hmr-test] no plugins affected by " + stashedURLs.length + " changed file(s)");
		return;
	}

	console.error("[hmr-test] " + reloads.size + " plugin(s) to reload");

	// ── 3. Clear caches for all accepted files ──
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
		} catch {}
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
	const getOuterStack = () => [];
	const attempts = {};
	try {
		for (const [url] of reloads) {
			console.error("[hmr-test] re-importing: " + url);
			attempts[url] = loader.unwrapExports(await loader.import(url, getOuterStack));
		}
	} catch (e) {
		console.error("[hmr-test] re-import failed: " + e);
		rollback();
		return;
	}

	// ── 5-7. Swap plugins ──
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

		try { ctx.registry.delete(oldPlugin); }
		catch (e) { console.error("[hmr-test] dispose failed for " + path + ": " + e); }

		try {
			reload(newPlugin, runtime);
			console.error("[hmr-test] reloaded plugin at " + path);
		} catch (e) {
			console.error("[hmr-test] reload failed for " + path + ": " + e);
			rollback();
			for (const [url2, { plugin: oldPlugin2, runtime: runtime2 }] of reloads) {
				if (oldPlugin2 === oldPlugin) continue;
				try { ctx.registry.delete(attempts[url2]); } catch {}
				reload(oldPlugin2, runtime2);
			}
			return;
		}
	}
}

// ── Watch the test plugin dir ──
let hmrDebounceTimer = null;
const hmrStashed = new Set();

const watcher = fsWatch(testPluginDir, { recursive: true }, (event, filename) => {
	const changed = join(testPluginDir, filename);
	if (!changed.endsWith(".ts") && !changed.endsWith(".js")) return;
	console.error("[hmr-test] file changed: " + changed);
	hmrStashed.add(pathToFileURL(changed).href);
	if (hmrDebounceTimer) clearTimeout(hmrDebounceTimer);
	hmrDebounceTimer = setTimeout(() => {
		hmrDebounceTimer = null;
		const stashed = [...hmrStashed];
		hmrStashed.clear();
		partialReload(ctx, stashed).catch((e) => console.error("[hmr-test] partialReload error: " + e));
	}, 200);
});

// ── Test sequence ──
console.error("[hmr-test] === HMR TEST START ===");

// Step 1: verify v1 loaded
await new Promise((r) => setTimeout(r, 300));
const v1 = globalThis.__hmrTestVersion;
console.error("[hmr-test] step 1: initial version = " + v1);

if (v1 !== "v1") {
	console.error("[hmr-test] FAIL: expected v1, got " + v1);
	cleanup();
	watcher.close();
	process.exit(1);
}

// Step 2: modify plugin to v2
console.error("[hmr-test] step 2: modifying plugin to v2...");
writeTestPlugin("v2");

// Step 3: wait for HMR (debounce 200ms + reload + init)
console.error("[hmr-test] step 3: waiting for HMR...");
await new Promise((r) => setTimeout(r, 3000));

const v2 = globalThis.__hmrTestVersion;
console.error("[hmr-test] step 4: after HMR version = " + v2);

// Step 4: verify
if (v2 === "v2") {
	console.error("[hmr-test] === PASS: HMR reloaded plugin with new code ===");
	console.error("VERIFIED: HMR cache-clear + re-import + registry swap → v1→v2");
} else {
	console.error("[hmr-test] === FAIL: HMR did not reload (expected v2, got " + v2 + ") ===");
	console.error("UNVERIFIED: HMR reload failed");
}

watcher.close();
cleanup();
process.exit(v2 === "v2" ? 0 : 1);
