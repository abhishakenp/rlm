/**
 * rlm — the host shell. Hot-reloadable; the frozen bootstrap (`cordis-shell.mjs`)
 * imports this once and calls `run()`.
 *
 * ## The contract (unchanged from the old cordis-shell.mjs, now reloadable)
 *
 * 1. Create the root Context and mount the Loader.
 * 2. Mount one `cordis-plugin-include` on the composition (degraded boot if rows
 *    will not import — loudly).
 * 3. Poll the composition forever and refresh on change (the dead man's switch:
 *    the `boot` row does the real watching, but it is itself a row).
 * 4. Ask the `modes` row what this invocation is and do that.
 *
 * ## What is new: nothing here needs a restart (zero-restart design, Case 1)
 *
 * - **The anchor.** All live state hangs off `globalThis.__rlmHost` (see
 *   `HostState`): the Context, the Include entry, the lifetime promise, the
 *   dead man's switch, the watchers. The bootstrap created it; nothing ever
 *   replaces it. A new version of this module never builds anything — it adopts.
 * - **Self-reload.** This module watches its own directory. On a change it
 *   parse-checks every file, evicts them from Bun's cache, imports the new copy
 *   and calls `adopt(host)`: the new code re-installs the dead man's switch,
 *   the watchers and the exec triggers around the SAME Context. No row is
 *   rebuilt, no session ends, the terminal is not touched. A file that does not
 *   parse, or an `adopt` that throws, leaves the running shell as it was.
 *   `rlm-hmr` and the official `hmr` row ignore this directory (cordis.yml), so
 *   exactly one reloader owns it.
 * - **The exit path follows the latest code.** When the lifetime settles, the
 *   generation-0 `run()` hands the result to `host.current.finish()` — whatever
 *   shell is current by then decides how the process ends.
 * - **execve in place, last resort.** For what no in-process swap can change
 *   (the bun binary upgraded, the frozen bootstrap edited, runtime flags,
 *   native add-ons): `reexec()` persists what the next image needs, disposes the
 *   composition (sessions and kernel snapshots flush on dispose), and replaces
 *   the process image — same pid, same terminal (measured: bun 1.4.3). The new
 *   image resumes the same session and restores the editor text. Listening
 *   sockets do NOT survive (measured: closed across execve), so they re-bind.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, unwatchFile, watch, watchFile, writeFileSync, copyFileSync, rmSync, type FSWatcher, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RlmSurface } from "./surface.ts";

/** How often the dead man's switch re-reads the composition, in milliseconds. */
const POLL_MS = 1000;
/** EX_CONFIG — kept in step with HOST_EXIT in packages/rlm-delegate/src/host.ts (the reader). */
const HOST_EXIT = 78;
/** Batch rapid saves in this directory into one reload. */
const DEBOUNCE_MS = 150;

const here = dirname(fileURLToPath(import.meta.url));

/** Everything that must outlive a reload. Lives on globalThis.__rlmHost; created by the bootstrap. */
export interface HostState {
	root: string;
	bootstrap: string;
	generation: number;
	/** The shell API that is current now. Replaced on every successful reload. */
	current?: ShellApi;
	ctx?: any;
	entry?: any;
	composition?: string;
	degraded?: boolean;
	broken?: string[];
	/** Resolves with the exit code when this invocation is done. The session-lifetime anchor. */
	lifetime?: Promise<number>;
	surface?: RlmSurface;
	deadMan?: { path: string; listener: (curr: Stats, prev: Stats) => void };
	selfWatch?: { close(): void };
	execTriggers?: Array<{ path: string; listener: (curr: Stats, prev: Stats) => void }>;
	/** mtimes of this directory's files as first imported — the boot catch-up compares against them. */
	importedMtimes?: Record<string, number>;
	reloading?: Promise<void>;
	/** Hash of this directory's files as last adopted — a save that changes nothing is not a reload. */
	shellHash?: string;
	execing?: boolean;
	/** Available to rows and code cells: `globalThis.__rlmHost.reexec("why")`. */
	reexec?: (reason: string) => Promise<void>;
	/** Rows may add work to run before an execve (persist state onto `plan.resume`). */
	execHooks?: Set<(plan: ExecPlan) => void | Promise<void>>;
	/** Called on every successful shell reload, for tests and observers. */
	onSwap?: (generation: number) => void;
}

export interface ExecPlan {
	reason: string;
	argv: string[];
	env: Record<string, string | undefined>;
	resume: Record<string, unknown>;
}

export interface ShellApi {
	run(host: HostState): Promise<void>;
	adopt(host: HostState, previous?: ShellApi): Promise<void>;
	finish(host: HostState, code: number): Promise<never>;
	fail(host: HostState, error: unknown): never;
	reexec(host: HostState, reason: string): Promise<void>;
}

/* ───────────────────────────── logging ───────────────────────────── */

/**
 * One line to the log file, and — when there is a TUI — one transient notice in
 * the footer. Never stderr while a TUI is up: a reload is not an event the
 * screen should scroll for.
 */
const say = (level: "info" | "warn", text: string, notice = false) => {
	const g = globalThis as any;
	try {
		g.__rlmLog?.(level, "host", text);
	} catch {}
	if (notice) {
		try {
			g.__rlmTui?.announce?.(text, { level });
		} catch {}
	}
	if (!g.__rlmLog && !g.__rlmTui && process.env.RLM_HOST_VERBOSE) console.error(`[rlm] ${text}`);
};

const die = (message: string): never => {
	// The one place a bare write is right: this can run before any logger exists.
	console.error("[rlm]", message);
	process.exit(1);
};

/**
 * An error with its whole cause chain. Cordis loader errors keep the real reason
 * only in `error.cause` — the shell used to print `[rlm] fatal: Error` (worker M).
 * Bounded: five causes, forty stack lines each.
 */
export const describeError = (error: any, depth = 0): string => {
	if (error === undefined || error === null) return String(error);
	const stack = typeof error?.stack === "string" ? error.stack : String(error?.message ?? error);
	const head = stack.split("\n").slice(0, 40).join("\n");
	if (depth >= 5 || error?.cause === undefined) return head;
	return `${head}\n  caused by: ${describeError(error.cause, depth + 1)}`;
};

/* ───────────────────────────── boot ───────────────────────────── */

/** Which composition to mount: --config, else a project's .rlm/cordis.yml, else the repo's. */
const compositionPath = (host: HostState): string => {
	const flag = process.argv.indexOf("--config");
	if (flag !== -1 && process.argv[flag + 1]) {
		const given = process.argv[flag + 1]!;
		return isAbsolute(given) ? given : resolve(process.cwd(), given);
	}
	const project = join(process.cwd(), ".rlm", "cordis.yml");
	if (existsSync(project)) return project;
	return join(host.root, "cordis.yml");
};

/**
 * Wait for a service to exist. `ctx.get()` needs the providing fiber ACTIVE,
 * and there is no "composition settled" event, so poll with a deadline.
 */
const waitFor = async (ctx: any, service: string, timeoutMs = 15000): Promise<any> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = ctx.get(service);
		if (found) return found;
		if (Date.now() > deadline) return undefined;
		await new Promise((r) => setTimeout(r, 25));
	}
};

/**
 * The rows whose entry cannot be imported, named — each with the first line of
 * its own error, because a degradation that does not say why is silent by
 * construction. Only local rows are tried.
 */
const unloadableRows = async (composition: string) => {
	const root = dirname(composition);
	const rows: Array<{ id: string; name: string | null }> = [];
	let current: { id: string; name: string | null } | null = null;
	for (const raw of readFileSync(composition, "utf8").split("\n")) {
		const line = raw.replace(/#.*$/, "");
		const id = line.match(/^-\s*id:\s*(\S+)/);
		if (id) {
			if (current) rows.push(current);
			current = { id: id[1]!, name: null };
			continue;
		}
		const name = line.match(/^\s+name:\s*['"]?([^'"\s]+)['"]?/);
		if (name && current && !current.name) current.name = name[1]!;
	}
	if (current) rows.push(current);

	const broken: Array<{ id: string; name: string; why: string }> = [];
	for (const row of rows) {
		if (!row.name?.startsWith(".")) continue;
		try {
			const mod = await import(pathToFileURL(resolve(root, row.name)).href);
			const plugin = mod.default ?? mod;
			if (typeof plugin !== "function" && typeof plugin?.apply !== "function") {
				broken.push({ id: row.id, name: row.name, why: `its default export is a ${typeof plugin}, not a plugin` });
			}
		} catch (error: any) {
			const why = describeError(error).split("\n").filter((l) => !/^\s+at /.test(l)).slice(0, 3).join(" | ");
			broken.push({ id: row.id, name: row.name, why });
		}
	}
	return broken;
};

/** The same composition with the named rows removed, written beside it. */
const withoutRows = (composition: string, ids: string[]): string => {
	const out: string[] = [];
	let skipping = false;
	for (const line of readFileSync(composition, "utf8").split("\n")) {
		const id = line.match(/^-\s*id:\s*(\S+)/);
		if (id) skipping = ids.includes(id[1]!);
		if (!skipping) out.push(line);
	}
	const reduced = composition.replace(/\.ya?ml$/, "") + ".degraded.yml";
	writeFileSync(reduced, out.join("\n"), "utf8");
	return reduced;
};

/** Create the Context, mount the loader and the composition (degraded if it must). */
const bootComposition = async (host: HostState) => {
	const composition = compositionPath(host);
	if (!existsSync(composition)) die(`no composition at ${composition}`);
	host.composition = composition;

	const { Context } = await import("@deepseek-ai/cordis");
	const ctx = new Context();
	ctx.baseUrl = pathToFileURL(host.root + "/").href;
	await ctx.plugin((await import("@deepseek-ai/cordis-plugin-loader")).default);
	host.ctx = ctx;

	// Boot without the rows that will not load, rather than not at all. A cold
	// boot has nothing to roll back to, so one broken file would refuse the whole
	// composition; one agent mid-edit is no reason for the other rows to be gone.
	const boot = async (path: string) =>
		ctx.loader.resolve(
			await ctx.loader.create({
				name: "@deepseek-ai/cordis-plugin-include",
				config: { path: pathToFileURL(path).href, enableLogs: false },
			}),
		);

	host.broken = [];
	try {
		host.entry = await boot(composition);
	} catch (error: any) {
		const unloadable = await unloadableRows(composition);
		if (!unloadable.length) throw error;
		host.broken = unloadable.map((r) => r.id);
		host.degraded = true;
		process.stderr.write(
			`[rlm] ${host.broken.length} row(s) will not load and were left out of this boot: ${host.broken.join(", ")}\n` +
				unloadable.map((r) => `[rlm]   ${r.id} (${r.name}): ${r.why}\n`).join("") +
				`[rlm] ${describeError(error).split("\n").filter((l) => !/^\s+at /.test(l)).join(" | ")}\n`,
		);
		say("warn", `degraded boot: ${describeError(error)}`);
		host.entry = await boot(withoutRows(composition, host.broken));
	}

	// The upstream agent tree reaches Cordis through this. A wire, not a design;
	// on the host because the row that would own it could be unloaded.
	(globalThis as any).__rlmCordisContext = ctx;
};

/* ───────────────────────── reinstallable pieces ───────────────────────── */

/**
 * The dead man's switch: an unconditional slow poll of the composition, so an
 * edit that removes the `boot` row stays undoable. `refresh()` is transactional
 * and short-circuits on unchanged content. Re-installed by every generation, so
 * the listener always runs the current code.
 */
const installDeadMan = (host: HostState) => {
	if (!host.composition || !host.entry) return;
	if (host.deadMan) unwatchFile(host.deadMan.path, host.deadMan.listener);
	const listener = (curr: Stats, prev: Stats) => {
		if (curr.mtimeMs === prev.mtimeMs && curr.ino === prev.ino) return;
		Promise.resolve((host.entry.subtree ?? host.entry).refresh?.()).catch(() => {});
	};
	watchFile(host.composition, { interval: POLL_MS }, listener);
	host.deadMan = { path: host.composition, listener };
};

/** This directory's module files — what a shell reload re-imports. */
const hostFiles = (): string[] =>
	readdirSync(here)
		.filter((f) => /\.(ts|mts)$/.test(f) && !f.endsWith(".test.ts"))
		.map((f) => join(here, f));

const mtimeOf = (path: string): number => {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
};

/** Content hash of the given files (an editor's temp-file event and its rename are one change). */
const hashOf = (files: string[]): string => {
	const h = createHash("sha1");
	for (const f of files) {
		try {
			h.update(f).update(readFileSync(f));
		} catch {}
	}
	return h.digest("hex");
};

/** Parse-check a file without evaluating it. Bun only; under node the import itself is the check. */
const parses = (path: string): string | null => {
	const B = (globalThis as any).Bun;
	if (!B?.Transpiler) return null;
	try {
		new B.Transpiler({ loader: path.endsWith(".mjs") || path.endsWith(".js") ? "js" : "ts" }).transformSync(
			readFileSync(path, "utf8"),
		);
		return null;
	} catch (error: any) {
		return String(error?.message ?? error).split("\n")[0]!;
	}
};

/**
 * Reload this module and hand the live host to the new code. Parse-check first:
 * a file that does not parse changes nothing. Evict every host file from Bun's
 * cache so the new shell sees its new imports too (surface.ts included).
 */
const reloadShell = async (host: HostState, why: string) => {
	if (host.reloading) return host.reloading;
	const attempt = (async () => {
		try {
			const files = hostFiles();
			const hash = hashOf(files);
			if (hash === host.shellHash) return;
			for (const file of files) {
				const bad = parses(file);
				if (bad) {
					say("warn", `⚠ host shell: ${file.slice(host.root.length + 1)} does not parse — kept running code (${bad})`, true);
					return;
				}
			}
			// Bun: the module-scoped `require` (globalThis.require is undefined in ESM,
			// and a `?query` import returns the SAME cached module — measured).
			const cache = (process.versions.bun && typeof require !== "undefined" ? require.cache : undefined) as
				| Record<string, unknown>
				| undefined;
			if (cache) for (const file of files) delete cache[file];
			const url = pathToFileURL(join(here, "shell.ts")).href;
			// Under node the ESM cache cannot be evicted; a fresh URL is the only way in.
			const next: ShellApi = await import(cache ? url : `${url}?gen=${host.generation + 1}`);
			const previous = host.current;
			await next.adopt(host, previous);
			host.shellHash = hash;
			snapshotLastGood(host);
		} catch (error: any) {
			say("warn", `⚠ host shell reload failed — kept running code: ${String(error?.message ?? error).split("\n")[0]}`, true);
		}
	})();
	// Cleared after the assignment, never inside the attempt: an attempt that
	// returns without awaiting (unchanged content, a parse failure) would clear
	// the flag before it was set, leaving a settled promise that blocks every
	// later reload — the shell went deaf after one no-op reload (measured).
	const settled: Promise<void> = attempt.finally(() => {
		if (host.reloading === settled) host.reloading = undefined;
	});
	host.reloading = settled;
	return settled;
};

/**
 * Watch this directory. One watcher per process, owned by the current
 * generation; `adopt` replaces it so its callback always runs current code.
 * Also the boot catch-up for host files: anything saved between import and
 * watcher start is reloaded immediately.
 */
const installSelfWatch = (host: HostState) => {
	host.selfWatch?.close();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watcher: FSWatcher | undefined;
	const schedule = (why: string) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void reloadShell(host, why);
		}, DEBOUNCE_MS);
		(timer as any).unref?.();
	};
	try {
		watcher = watch(here, (_event, name) => {
			if (!name || !/\.(ts|mts)$/.test(String(name)) || String(name).endsWith(".test.ts")) return;
			schedule(`${name} changed`);
		});
		(watcher as any).unref?.();
	} catch (error: any) {
		say("warn", `host shell: cannot watch ${here} (${error?.message ?? error}) — shell reload is off`);
	}
	host.selfWatch = {
		close: () => {
			if (timer) clearTimeout(timer);
			try {
				watcher?.close();
			} catch {}
		},
	};
	// Catch-up: a save during boot, before this watcher existed.
	const seen = host.importedMtimes ?? {};
	const changed = hostFiles().filter((f) => seen[f] !== undefined && mtimeOf(f) > seen[f]!);
	host.importedMtimes = Object.fromEntries(hostFiles().map((f) => [f, mtimeOf(f)]));
	if (changed.length) schedule(`changed during boot: ${changed.map((f) => f.slice(here.length + 1)).join(", ")}`);
};

/**
 * The things an in-process swap cannot change → execve in place:
 * - the frozen bootstrap edited (it is only ever evaluated at process start);
 * - the bun binary replaced (`bun upgrade`).
 * Both are polled slowly; neither fires in `--print` runs, which are short and
 * would rather finish on the old image than answer twice.
 */
const installExecTriggers = (host: HostState) => {
	for (const t of host.execTriggers ?? []) unwatchFile(t.path, t.listener);
	host.execTriggers = [];
	if (isPrintRun()) return;
	const add = (path: string, why: (curr: Stats) => string | null) => {
		const listener = (curr: Stats, prev: Stats) => {
			if (curr.mtimeMs === prev.mtimeMs && curr.ino === prev.ino) return;
			const reason = why(curr);
			if (reason) void host.current?.reexec(host, reason);
		};
		watchFile(path, { interval: 2000 }, listener);
		host.execTriggers!.push({ path, listener });
	};
	add(host.bootstrap, () => {
		const bad = parses(host.bootstrap);
		if (bad) {
			say("warn", `⚠ cordis-shell.mjs does not parse — kept running image (${bad})`, true);
			return null;
		}
		return "the bootstrap (cordis-shell.mjs) changed";
	});
	if (process.versions.bun) add(process.execPath, (curr) => (curr.size > 0 ? "the bun binary was replaced" : null));
	// A request file, because a code cell's globalThis is the kernel sandbox, not
	// the host: `{"pid": <pid>|"all", "reason": "..."}` in
	// <agent dir>/host/reexec-request.json asks for an execve in place.
	const request = join(RESUME_DIR(), "reexec-request.json");
	mkdirSync(RESUME_DIR(), { recursive: true });
	add(request, () => {
		try {
			const r = JSON.parse(readFileSync(request, "utf8"));
			if (r?.pid === process.pid || r?.pid === "all") return String(r.reason ?? "requested");
		} catch {}
		return null;
	});
};

const isPrintRun = () => process.argv.some((a) => a === "--print" || a === "-p") || !process.stdin.isTTY;

/** Verbs whose mode never draws a screen (rlm-delegate's modes). */
const HEADLESS_VERBS = new Set(["drive", "tasks", "lesson", "test-task"]);

/**
 * Nobody is watching this invocation: print (flag or piped stdin), a pooled
 * worker, or a delegate verb. rlm-headless only switches on for `--headless` /
 * RLM_HEADLESS, so a plain `rlm --print` used to run every file watcher and the
 * pixel indexer (worker W: 1.4 GB / 196% CPU in /tmp). Hot reload still reaches
 * headless processes through rlm-hmr's follower (hmr-epoch.json).
 */
const headlessInvocation = (argv: string[]): boolean => {
	if (argv.includes("--pool-worker")) return true;
	const verb = argv.find((a) => !a.startsWith("-"));
	if (verb && HEADLESS_VERBS.has(verb)) return true;
	return isPrintRun();
};

/* ───────────────────────────── execve ───────────────────────────── */

const RESUME_DIR = () => join(process.env.RLM_CODING_AGENT_DIR ?? join(homedir(), ".rlm", "agent"), "host");

/**
 * The chat on screen and its runtime. SURFACE keeps them on the Surface
 * (`surface.interactive`); older renderers kept them on the row instance.
 */
const liveInteractive = (host: HostState): { chat?: any; runtime?: any } => {
	try {
		const s = (host.surface as any)?.interactive;
		if (s?.instance || s?.runtime) return { chat: s.instance, runtime: s.runtime };
		const renderer = host.ctx?.get?.("rlmRenderer") as any;
		return { chat: renderer?.instance, runtime: renderer?.runtime };
	} catch {
		return {};
	}
};

const liveChat = (host: HostState): any => liveInteractive(host).chat;

const liveSession = (host: HostState): any => {
	const { chat, runtime } = liveInteractive(host);
	return chat?.session ?? runtime?.session;
};

const liveSessionFile = (host: HostState): string | undefined => {
	try {
		return liveSession(host)?.sessionManager?.getSessionFile?.() ?? undefined;
	} catch {
		return undefined;
	}
};

const isBusy = (host: HostState): boolean => {
	try {
		return Boolean(liveSession(host)?.isStreaming);
	} catch {
		return false;
	}
};

/** Session flags removed before re-adding `--resume <current file>`. */
const SESSION_FLAGS_WITH_VALUE = new Set(["--resume", "-r", "--session", "--fork", "--session-dir"]);
const SESSION_FLAGS_BARE = new Set(["-r", "--resume", "-c", "--continue", "--no-session"]);

const withResume = (argv: string[], file: string | undefined): string[] => {
	if (!file) return argv;
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a.startsWith("--resume=") || a.startsWith("--session=")) continue;
		if (SESSION_FLAGS_WITH_VALUE.has(a) && argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
			if (a !== "--session-dir") {
				i++;
				continue;
			}
		}
		if (SESSION_FLAGS_BARE.has(a)) continue;
		out.push(a);
	}
	return [...out, "--resume", file];
};

/**
 * Kernel variables, per session, as structured clones (bun:jsc). Functions,
 * host bindings (sh, rlm, context…) and anything uncloneable are skipped — the
 * new image re-creates bindings itself. What a cell was doing mid-promise at the
 * moment of exec cannot be kept (the V8 heap is replaced).
 */
const snapshotKernels = async (): Promise<Record<string, Record<string, string>>> => {
	const out: Record<string, Record<string, string>> = {};
	let serialize: ((v: unknown) => Uint8Array | ArrayBuffer) | undefined;
	try {
		serialize = (await import("bun:jsc" as string)).serialize;
	} catch {
		return out;
	}
	for (const ref of ((globalThis as any).__rlmHmrLive ?? []) as Set<WeakRef<any>>) {
		const kernel = ref.deref?.();
		const sessionId = kernel?.options?.sessionId;
		if (!kernel?.context || !sessionId || typeof kernel.listNamespaceNames !== "function") continue;
		const names: string[] = (await kernel.listNamespaceNames().catch(() => null)) ?? [];
		for (const name of names) {
			const value = kernel.context[name];
			if (typeof value === "function") continue;
			try {
				const bytes = serialize!(value);
				(out[sessionId] ??= {})[name] = Buffer.from(bytes as ArrayBuffer).toString("base64");
			} catch {}
		}
	}
	return out;
};

/** Session flags removed, then a bare `-r`: the next image opens the agents view. */
const withAgentsView = (argv: string[]): string[] => {
	const stripped = withResume(argv, "\u0000").slice(0, -2);
	return [...stripped, "-r"];
};

/**
 * Replace this process image with a fresh one: same pid, same terminal.
 * Waits (bounded) for the agent to go idle so no turn is cut in half.
 */
const reexecImpl = async (host: HostState, reason: string): Promise<void> => {
	if (host.execing) return;
	const B = (globalThis as any).process;
	if (typeof B?.execve !== "function") {
		say("warn", `⚠ ${reason}; this runtime has no process.execve — applies on next launch`, true);
		return;
	}
	host.execing = true;
	try {
		const deadline = Date.now() + 10 * 60_000;
		if (isBusy(host)) say("info", `↻ ${reason} — applying when this turn ends`, true);
		while (isBusy(host) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));

		const args = process.argv.slice(2);
		// In the agents view the next image must open the agents view again, not a
		// chat: keep a bare `-r` (and drop a stale `--resume <file>`). SURFACE sets
		// `interactive.view` and restores selection/scroll from `plan.resume` in
		// afterExec.
		const view = (host.surface as any)?.interactive?.view;
		const argv = view === "agents" ? withAgentsView(args) : withResume(args, liveSessionFile(host));
		const plan: ExecPlan = { reason, argv, env: { ...process.env }, resume: { view } };
		try {
			const text = liveChat(host)?.editor?.getText?.();
			if (typeof text === "string" && text.length) plan.resume.editorText = text;
		} catch {}
		for (const hook of host.execHooks ?? []) {
			try {
				await hook(plan);
			} catch (error: any) {
				say("warn", `exec hook failed: ${error?.message ?? error}`);
			}
		}
		try {
			await host.surface?.beforeExec?.(plan);
		} catch {}
		plan.resume.kernels = await snapshotKernels();

		mkdirSync(RESUME_DIR(), { recursive: true });
		const file = join(RESUME_DIR(), `resume-${process.pid}.json`);
		writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), reason, generation: host.generation, ...plan.resume }, null, 2));
		plan.env.RLM_HOST_RESUME = file;
		say("info", `host: execve in place — ${reason}`);

		// Sessions and kernel snapshots flush on dispose; the TUI leaves the alt
		// screen and hands input back cooked, so the next image starts clean.
		(globalThis as any).__rlmHostExecing = true;
		await Promise.race([
			Promise.resolve(host.ctx?.fiber?.dispose?.()).catch(() => {}),
			new Promise((r) => setTimeout(r, 5000)),
		]);
		const env = Object.fromEntries(Object.entries(plan.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
		B.execve(process.execPath, [process.execPath, ...process.execArgv, host.bootstrap, ...plan.argv], env);
	} catch (error: any) {
		host.execing = false;
		say("warn", `⚠ execve failed — kept running: ${error?.message ?? error}`, true);
	}
};

/**
 * After an execve: restore what the old image persisted. The session itself is
 * reopened by `--resume`; the editor text is put back once the chat exists.
 */
const restoreAfterExec = (host: HostState) => {
	const file = process.env.RLM_HOST_RESUME;
	if (!file) return;
	delete process.env.RLM_HOST_RESUME; // children must not inherit it
	let resume: Record<string, unknown> = {};
	try {
		resume = JSON.parse(readFileSync(file, "utf8"));
		unlinkSync(file);
	} catch {
		return;
	}
	// SURFACE consumes `surface.resumed`; kept on the anchor too for anything that reads it first.
	(host as any).resumed = resume;
	void (async () => {
		const kernels = resume.kernels as Record<string, Record<string, string>> | undefined;
		if (!kernels || !Object.keys(kernels).length) return;
		try {
			const { deserialize } = await import("bun:jsc" as string);
			const handover: Record<string, Record<string, unknown>> = ((globalThis as any).__rlmKernelHandover ??= {});
			for (const [sessionId, vars] of Object.entries(kernels)) {
				for (const [name, b64] of Object.entries(vars)) {
					try {
						(handover[sessionId] ??= {})[name] = deserialize(Buffer.from(b64, "base64"));
					} catch {}
				}
			}
		} catch {}
	})();
	if (host.surface) (host.surface as any).resumed = resume;
	void (async () => {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const chat = liveChat(host);
			if (chat?.editor?.setText) {
				try {
					if (typeof resume.editorText === "string") chat.editor.setText(resume.editorText);
					await host.surface?.afterExec?.(resume);
				} catch {}
				say("info", `↻ resumed after ${String(resume.reason ?? "execve")}`, true);
				return;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	})();
};

/* ───────────────────────────── last good ───────────────────────────── */

/**
 * After a shell that booted or adopted successfully, keep a copy. The bootstrap
 * could fall back to it if a later edit leaves shell.ts unimportable at launch.
 * Inside the repo so bare specifiers still resolve to the repo's node_modules.
 */
const snapshotLastGood = (host: HostState) => {
	try {
		const dir = join(here, "..", "last-good");
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		for (const file of hostFiles()) copyFileSync(file, join(dir, file.slice(here.length + 1)));
		copyFileSync(join(here, "node-reexec.mjs"), join(dir, "node-reexec.mjs"));
	} catch {}
};

/* ───────────────────────────── API ───────────────────────────── */

const api: ShellApi = {
	async run(host) {
		host.current = api;
		host.execHooks ??= new Set();
		host.reexec = (reason: string) => host.current!.reexec(host, reason);
		host.importedMtimes = Object.fromEntries(hostFiles().map((f) => [f, mtimeOf(f)]));
		host.shellHash = hashOf(hostFiles());
		if (headlessInvocation(process.argv.slice(2))) process.env.RLM_HEADLESS ??= "1";
		try {
			await bootComposition(host);
			installDeadMan(host);
			installSelfWatch(host);
			installExecTriggers(host);
			restoreAfterExec(host);
			snapshotLastGood(host);

			const modes = await waitFor(host.ctx, "rlmModes");
			if (!modes) {
				die(
					"the `modes` row never started, so there is no surface to run.\n" +
						"        Check `cordis.yml` for a row with id `modes`, and the log for why it failed.",
				);
			}
			// A degraded boot removes rows by id and nothing recomputes who needed
			// them; say what actually happened, keeping the original underneath.
			host.lifetime = modes.dispatch().catch((error: any) => {
				if (!host.degraded) throw error;
				throw new Error(
					`the composition cannot run this: it booted without ${host.broken!.join(", ")}, and what was asked for ` +
						`needs a row that depends on that. This is the host, not the request — fix the row and run it ` +
						`again.\n  underneath: ${String(error?.message ?? error)}`,
					{ cause: error },
				);
			});
			const code = await (host.surface?.lifetime ?? host.lifetime);
			await host.current!.finish(host, code ?? 0);
		} catch (error) {
			host.current!.fail(host, error);
		}
	},

	async adopt(host, previous) {
		host.generation += 1;
		host.current = api;
		host.execHooks ??= new Set();
		host.reexec = (reason: string) => host.current!.reexec(host, reason);
		installDeadMan(host);
		installSelfWatch(host);
		installExecTriggers(host);
		host.onSwap?.(host.generation);
		say("info", `↻ host shell reloaded (gen ${host.generation})`, true);
		void previous;
	},

	async finish(host, code) {
		for (const t of host.execTriggers ?? []) unwatchFile(t.path, t.listener);
		if (host.deadMan) unwatchFile(host.deadMan.path, host.deadMan.listener);
		host.selfWatch?.close();
		await Promise.resolve(host.ctx?.fiber?.dispose?.()).catch(() => {});
		// Exit explicitly in every mode: provider keep-alive and proxy sockets
		// outlive the composition and would otherwise hold the terminal (worker M).
		process.exit(code);
	},

	fail(host, error: any) {
		const text = describeError(error);
		console.error(`[rlm] fatal: ${text}`);
		try {
			(globalThis as any).__rlmLog?.("error", "host", "fatal", { error: text });
		} catch {}
		// 1 = "this run failed"; EX_CONFIG = "there was nowhere to do the work".
		// The delegate charges a task an attempt only for the first.
		process.exit(host.degraded ? HOST_EXIT : 1);
	},

	reexec: reexecImpl,
};

export const run = api.run;
export const adopt = api.adopt;
export const finish = api.finish;
export const fail = api.fail;
export const reexec = api.reexec;

/** Pure helpers, exported for tests. */
export { withResume, withAgentsView, headlessInvocation, hashOf, snapshotKernels };
