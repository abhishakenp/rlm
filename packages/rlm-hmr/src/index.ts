/**
 * @rlm/hmr — the reload bridge.
 *
 * The reload engine used to live in cordis-shell.mjs, which is the one file in
 * the process that cannot reload itself. That is not a stylistic complaint: it
 * had two costs the plugin form does not have.
 *
 *   The watch roots were derived once, at boot, from `readdirSync(packages)`.
 *   A package created afterwards was never watched, so the first edit to a
 *   newly added plugin did nothing and looked like a broken reloader.
 *
 *   The reload policy — debounce, ignore rules, what counts as source — was
 *   frozen for the life of the process. Changing how reloading works meant
 *   restarting the thing whose job is to avoid restarts.
 *
 * As a fiber both go away. One recursive watcher over `packages/` sees
 * directories that appear later, so a package added at runtime is watched from
 * the moment it exists. And this file lives under that same tree, so editing
 * the reloader reloads the reloader: the swap disposes these watchers
 * through ctx.effect() and the new module opens its own.
 *
 * Module reload itself is now the official @deepseek-ai/cordis-plugin-hmr's
 * job — the same plugin DSH declares in its own base composition. This plugin
 * does the two things that one does not:
 *
 *   It watches the agent's resource directories. Skills, extensions, prompts
 *   and workflows live outside the repo (under ~/.rlm/agent), are not modules,
 *   and so are invisible to a module reloader — but a session reads them at
 *   startup and must re-derive when they change.
 *
 *   It translates. The official plugin announces `hmr/reload` and `hmr/change`;
 *   a live AgentSession listens for `rlm/hmr-reload` and `rlm/resources-changed`.
 *
 * When the official plugin is absent — under bun, which exposes no internal
 * module loader, or when the process was not started with --expose-internals —
 * this plugin falls back to reloading modules itself with the algorithm rlm
 * had before: module-graph tracing, cache clearing, registry swap with
 * rollback. Same behaviour, one less dependency, and no silent loss of HMR.
 *
 * Running sessions are never interrupted: reload swaps plugin fibers, and the
 * agent's own state lives in the kernel, not in the plugin closure.
 */
import { Service } from "@deepseek-ai/cordis";
import { watch as fsWatch, existsSync, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

export interface RlmHmrConfig {
	/** Directories to watch, relative to the repo root. Default: ["packages"]. */
	roots?: string[];
	/** Substrings and suffixes that disqualify a path from triggering a reload. */
	ignored?: string[];
	/**
	 * Directories holding runtime resources — skills, extensions, prompts,
	 * themes. Anything that changes here is announced to live sessions, which
	 * re-derive from it without restarting.
	 *
	 * Defaults to the resource subdirectories of the project's and the user's
	 * agent directories, never the agent directory itself: a running session
	 * writes its transcript, artifacts and lock files there, and watching the
	 * parent turns the session's own output into a reload trigger, which
	 * produces more output.
	 */
	resourceRoots?: string[];
	/** Milliseconds to batch rapid saves into one reload pass. Default 100. */
	debounce?: number;
	/** Log every decision. Also enabled by RLM_HMR_VERBOSE=1. */
	verbose?: boolean;
	/**
	 * "bridge" defers module reload to @deepseek-ai/cordis-plugin-hmr;
	 * "standalone" reloads modules here; "auto" (default) bridges when the
	 * official plugin is present and falls back when it is not.
	 */
	mode?: "auto" | "bridge" | "standalone";
}

/** Paths whose contents end up inside the built system prompt. */
const PROMPT_SHAPED = ["/skills/", "/prompts/", "/refinement/", "/themes/"];

/**
 * The subdirectories of an agent directory that actually hold resources.
 *
 * Deliberately not the agent directory itself: sessions, session-artifacts,
 * logs and lock files live beside these and are written by the running
 * session, so watching the parent makes a session reload in response to its
 * own transcript — and each reload writes more of one.
 */
const RESOURCE_DIRS = ["skills", "extensions", "prompts", "themes", "workflows"];

/** file:// URL → path, tolerant of anything that is not one. */
function urlToPathSafe(url: string): string {
	try {
		return url.startsWith("file:") ? fileURLToPath(url) : url;
	} catch {
		return url;
	}
}

const DEFAULT_IGNORED = [
	// Session state written by the running agent. Never a resource change.
	"/sessions/",
	"/session-artifacts/",
	"/logs/",
	".lock",
	".jsonl",
	".tmp",
	"/node_modules/",
	"/dist/",
	"/.cache",
	"/.tsbuildinfo",
	".test.ts",
	".test.js",
	".map",
	".d.ts",
];

export class RlmHmrService extends Service {
	static inject = [] as const;
	static provide = "rlmHmr" as const;

	declare config: RlmHmrConfig;

	private root = process.cwd();
	private resourceRoots: string[] = [];
	private mode: "auto" | "bridge" | "standalone" = "auto";
	private reloadCount = 0;
	private resourceEvents = 0;
	private lastReloaded: string[] = [];

	constructor(ctx: any, config: RlmHmrConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	private log(...args: unknown[]) {
		try {
			(globalThis as any).__rlmLog?.("info", "hmr", String(args[0] ?? "").replace(/^\[rlm\] /, ""));
		} catch {}
		if (this.config.verbose || process.env.RLM_HMR_VERBOSE) console.error(...args);
	}

	async [Service.init]() {
		this.root = this.ctx.baseUrl ? fileURLToPath(this.ctx.baseUrl) : process.cwd();
		this.resourceRoots = (
			this.config.resourceRoots ??
			[join(this.root, ".rlm", "agent"), join(homedir(), ".rlm", "agent")].flatMap((base) =>
				RESOURCE_DIRS.map((sub) => join(base, sub)),
			)
		).filter((d) => existsSync(d));

		this.mode = this.config.mode ?? "auto";
		if (this.mode !== "standalone") this.installBridge();
		if (this.mode === "standalone" && !this.ctx.loader?.internal) {
			this.ctx.logger?.warn?.(
				"rlm-hmr: no official hmr plugin and no loader.internal — module reload is inert " +
					"(start node with --expose-internals, or add an hmr row to cordis.yml)",
			);
		}

		this.ctx.effect(() => {
			const watchers = this.install();
			return () => {
				for (const w of watchers) {
					try {
						w.close();
					} catch {}
				}
			};
		});

		const what =
			this.mode === "bridge"
				? "bridging @deepseek-ai/cordis-plugin-hmr"
				: `mode=${this.mode}, watching ${(this.config.roots ?? ["packages"]).join(", ")}`;
		this.log(`[rlm] rlm-hmr: ${what}; resources: ${this.resourceRoots.join(", ") || "none"}`);
		this.ctx.logger?.info?.(`rlm-hmr: ${what} (root=${this.root})`);
	}

	/**
	 * Translate the official plugin's announcements into the ones a live
	 * session listens for. Registered through ctx.effect so a reload of this
	 * plugin does not leave a second translator behind.
	 */
	private installBridge() {
		this.ctx.effect(() => {
			const ctx: any = this.ctx;
			const onReload = (reloads: any) => {
				const count = reloads?.size ?? reloads?.length ?? 0;
				this.reloadCount++;
				this.log(`[rlm] rlm-hmr: official hmr reloaded ${count} plugin(s)`);
				try {
					ctx.emit("rlm/hmr-reload", { reloaded: [...(reloads?.keys?.() ?? [])] });
				} catch {}
			};
			// A file the official plugin watched but could not treat as a module:
			// for us that is a resource, and a session may need to re-read it.
			const onChange = (url: string) => this.announceResourceChange([urlToPathSafe(url)]);
			ctx.on("hmr/reload", onReload);
			ctx.on("hmr/change", onChange);
			return () => {
				try {
					ctx.off?.("hmr/reload", onReload);
					ctx.off?.("hmr/change", onChange);
				} catch {}
			};
		});
	}

	/**
	 * One recursive watcher per configured root.
	 *
	 * Recursive is the whole point: a package directory created after boot is
	 * inside an already-watched tree, so it needs no new watcher and no restart.
	 */
	private install(): FSWatcher[] {
		const watchers: FSWatcher[] = [];
		const debounceMs = this.config.debounce ?? 100;
		const ignored = [...DEFAULT_IGNORED, ...(this.config.ignored ?? [])];

		let timer: NodeJS.Timeout | null = null;
		const stashed = new Set<string>();

		const onChange = (absolute: string) => {
			if (!absolute.endsWith(".ts") && !absolute.endsWith(".js")) return;
			if (ignored.some((frag) => absolute.includes(frag) || absolute.endsWith(frag))) return;
			// Only source under a package's src/ is plugin code.
			if (!absolute.includes(`${sep}src${sep}`)) return;

			this.log(`[rlm] HMR: ${relative(this.root, absolute)} changed`);
			stashed.add(pathToFileURL(absolute).href);
			// Source that feeds the prompt (prompt templates, skill definitions,
			// refinement text) must invalidate the built prompt as well as
			// reloading the module that holds it.
			if (PROMPT_SHAPED.some((frag) => absolute.includes(frag))) {
				try {
					(this.ctx as any).emit("rlm/prompt-changed", { path: absolute });
				} catch {}
			}

			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				const batch = [...stashed];
				stashed.clear();
				if (this.isBridging) {
					// The official plugin owns module reload; it saw this too.
					this.log(`[rlm] rlm-hmr: ${batch.length} change(s) deferred to the official hmr plugin`);
					return;
				}
				this.partialReload(batch).catch((e) =>
					this.log(`[rlm] HMR: partialReload failed: ${e?.message ?? e}`),
				);
			}, debounceMs);
		};

		for (const rel of this.mode === "bridge" ? [] : this.config.roots ?? ["packages"]) {
			const dir = join(this.root, rel);
			if (!existsSync(dir)) continue;
			try {
				watchers.push(
					fsWatch(dir, { recursive: true }, (_event, filename) => {
						if (filename) onChange(join(dir, filename.toString()));
					}),
				);
			} catch (e: any) {
				this.log(`[rlm] HMR: cannot watch ${dir}: ${e?.message ?? e}`);
			}
		}

		// Resource directories. Nothing here is a module, so nothing is
		// re-imported; the change is announced and live sessions re-derive from
		// it. This is what makes a skill added at runtime reach a running agent.
		let resourceTimer: NodeJS.Timeout | null = null;
		const resourceChanges = new Set<string>();
		const onResourceChange = (absolute: string) => {
			if (ignored.some((frag) => absolute.includes(frag) || absolute.endsWith(frag))) return;
			resourceChanges.add(absolute);
			if (resourceTimer) clearTimeout(resourceTimer);
			resourceTimer = setTimeout(() => {
				resourceTimer = null;
				const batch = [...resourceChanges];
				resourceChanges.clear();
				this.announceResourceChange(batch);
			}, debounceMs);
		};

		for (const dir of this.resourceRoots) {
			try {
				watchers.push(
					fsWatch(dir, { recursive: true }, (_event, filename) => {
						if (filename) onResourceChange(join(dir, filename.toString()));
					}),
				);
				this.log(`[rlm] HMR: watching resources in ${dir}`);
			} catch (e: any) {
				this.log(`[rlm] HMR: cannot watch ${dir}: ${e?.message ?? e}`);
			}
		}
		return watchers;
	}

	/**
	 * Tell live sessions that something they read at startup has changed.
	 *
	 * `rlm/resources-changed` makes a session re-derive skills, extensions and
	 * tools; `rlm/prompt-changed` additionally invalidates the built system
	 * prompt. Both are advisory — a session applies them between turns, never
	 * during one.
	 */
	private announceResourceChange(paths: string[]) {
		if (paths.length === 0) return;
		const ctx: any = this.ctx;
		const names = paths.map((p) => relative(this.root, p)).slice(0, 3).join(", ");
		this.log(`[rlm] HMR: resources changed (${names})`);
		this.resourceEvents++;
		try {
			ctx.emit("rlm/resources-changed", { paths, reason: `resources changed: ${names}` });
		} catch {}
		if (paths.some((p) => PROMPT_SHAPED.some((frag) => p.includes(frag)))) {
			try {
				ctx.emit("rlm/prompt-changed", { path: paths[0] });
			} catch {}
		}
	}

	/**
	 * Whether module reload belongs to the official plugin right now.
	 *
	 * Asked at the moment a change arrives rather than at startup: the official
	 * plugin's service only becomes visible once its watcher is ready, which is
	 * after this plugin's own init, so an init-time answer is a race. Both
	 * watchers may see the same file; only one acts on it.
	 */
	get isBridging(): boolean {
		if (this.mode === "bridge") return true;
		if (this.mode === "standalone") return false;
		try {
			return !!this.ctx.get?.("hmr");
		} catch {
			return false;
		}
	}

	/** How many reload passes this fiber has performed, and what it last swapped. */
	stats() {
		return {
			mode: this.mode,
			bridging: this.isBridging,
			reloads: this.reloadCount,
			resourceEvents: this.resourceEvents,
			lastReloaded: this.lastReloaded,
			root: this.root,
			resourceRoots: this.resourceRoots,
		};
	}

	// ─── Module graph ─────────────────────────────────────────────────────────

	private async resolveModuleURL(specifier: string, parentURL: string) {
		const internal = this.ctx.loader?.internal;
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

	private async getLinked(internal: any, url: string): Promise<string[]> {
		const job = internal.loadCache.get(url);
		if (!job) return [];
		const linked = await job.linked;
		if (!linked || !Array.isArray(linked)) return [];
		return Array.prototype.map.call(linked, (j: any) => j.url) as string[];
	}

	private async loadDependencies(internal: any, url: string, ignored = new Set<string>()) {
		const dependencies = new Set<string>();
		const traverse = async (u: string): Promise<void> => {
			if (ignored.has(u) || dependencies.has(u)) return;
			if (u.startsWith("node:") || u.includes("/node_modules/")) return;
			dependencies.add(u);
			const linked = await this.getLinked(internal, u);
			await Promise.all(linked.map(traverse));
		};
		await traverse(url);
		return dependencies;
	}

	// ─── Reload ───────────────────────────────────────────────────────────────

	/**
	 * Clear the changed modules from Node's caches, re-import them, and swap the
	 * affected plugins in the registry, keeping each old fiber's config. Any
	 * failure rolls the caches back and re-registers what was removed, so a
	 * syntax error in a plugin costs a failed reload rather than a dead process.
	 */
	async partialReload(stashedURLs: string[]) {
		const ctx: any = this.ctx;
		const loader = ctx.loader;
		if (!loader?.internal) {
			this.log("[rlm] HMR: loader.internal unavailable — cannot reload (need --expose-internals)");
			return;
		}
		const internal = loader.internal;

		const accepted = new Set(stashedURLs);
		const declined = new Set<string>();
		const isExcluded = (url: string) => url.startsWith("node:") || url.includes("/node_modules/");

		const pending: string[] = [];
		for (const url of stashedURLs) {
			for (const child of await this.getLinked(internal, url)) {
				if (accepted.has(child) || declined.has(child) || isExcluded(child)) continue;
				pending.push(child);
			}
		}

		while (pending.length) {
			let index = 0;
			let hasUpdate = false;
			while (index < pending.length) {
				const url = pending[index]!;
				const linked = await this.getLinked(internal, url);
				if (linked.length === 0) {
					pending.splice(index, 1);
					hasUpdate = true;
					declined.add(url);
					continue;
				}
				let isDeclined = true;
				let isAccepted = false;
				for (const child of linked) {
					if (declined.has(child) || isExcluded(child)) continue;
					if (accepted.has(child)) {
						isAccepted = true;
						break;
					}
					isDeclined = false;
					if (!pending.includes(child)) {
						hasUpdate = true;
						pending.push(child);
					}
				}
				if (isAccepted || isDeclined) {
					hasUpdate = true;
					pending.splice(index, 1);
					if (isAccepted) accepted.add(url);
					else declined.add(url);
				} else index++;
			}
			if (!hasUpdate) break;
		}
		for (const url of pending) declined.add(url);

		const nameMap: Record<string, Set<string>> = {};
		for (const entry of loader.entries()) {
			const baseUrl = entry.parent?.tree?.ctx?.baseUrl;
			if (!baseUrl) continue;
			(nameMap[baseUrl] ??= new Set()).add(entry.options.name);
		}

		const allPending = new Map<any, { plugin: any; url: string }>();
		for (const baseUrl in nameMap) {
			for (const name of nameMap[baseUrl]!) {
				try {
					const result: any = await this.resolveModuleURL(name, baseUrl);
					if (!result?.url || declined.has(result.url)) continue;
					const job = internal.loadCache.get(result.url);
					if (!job) continue;
					const plugin = loader.unwrapExports(job.module?.getNamespace?.());
					if (!plugin) continue;
					allPending.set(job, { plugin, url: result.url });
					declined.add(result.url);
				} catch {}
			}
		}

		const reloads = new Map<string, { plugin: any; runtime: any }>();
		for (const [, { plugin, url }] of allPending) {
			declined.delete(url);
			const deps = [...(await this.loadDependencies(internal, url, declined))];
			declined.add(url);
			if (!deps.some((dep) => accepted.has(dep))) continue;
			deps.forEach((dep) => accepted.add(dep));
			const runtime = ctx.registry.get(plugin);
			if (!runtime) continue;
			reloads.set(url, { plugin, runtime });
		}

		if (reloads.size === 0) {
			this.log(`[rlm] HMR: no plugins affected by ${stashedURLs.length} changed file(s)`);
			return;
		}
		this.log(`[rlm] HMR: ${reloads.size} plugin(s) to reload`);

		const esmBackup: Record<string, any> = {};
		const cjsBackup: Record<string, any> = {};
		for (const filename of accepted) {
			esmBackup[filename] = Map.prototype.get.call(internal.loadCache, filename);
			Map.prototype.delete.call(internal.loadCache, filename);
			try {
				const filepath = fileURLToPath(filename);
				if (require_.cache[filepath]) {
					cjsBackup[filepath] = require_.cache[filepath];
					delete require_.cache[filepath];
				}
			} catch {}
		}
		const rollback = () => {
			for (const filename in esmBackup) {
				Map.prototype.set.call(internal.loadCache, filename, esmBackup[filename]);
			}
			for (const filepath in cjsBackup) require_.cache[filepath] = cjsBackup[filepath];
		};

		const getOuterStack = () => [];
		const attempts: Record<string, any> = {};
		try {
			for (const [url] of reloads) {
				attempts[url] = loader.unwrapExports(await loader.import(url, getOuterStack));
			}
		} catch (e: any) {
			this.log(`[rlm] HMR: re-import failed: ${e?.message ?? e}`);
			rollback();
			return;
		}

		const reload = (plugin: any, runtime: any) => {
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
			} catch (e: any) {
				this.log(`[rlm] HMR: failed to dispose old plugin at ${path}: ${e?.message ?? e}`);
			}
			try {
				reload(newPlugin, runtime);
				this.log(`[rlm] HMR: reloaded plugin at ${path}`);
			} catch (e: any) {
				this.log(`[rlm] HMR: failed to reload plugin at ${path}: ${e?.message ?? e}`);
				rollback();
				for (const [url2, { plugin: oldPlugin2, runtime: runtime2 }] of reloads) {
					if (oldPlugin2 === oldPlugin) continue;
					try {
						ctx.registry.delete(attempts[url2]);
					} catch {}
					reload(oldPlugin2, runtime2);
				}
				return;
			}
		}

		this.reloadCount++;
		this.lastReloaded = [...reloads.keys()];
		ctx.emit("rlm/hmr-reload", { reloaded: this.lastReloaded });
	}
}

export default RlmHmrService;
export const name = "rlm-hmr";
export const inject = [] as const;
export { RlmHmrService as RlmHmr };
