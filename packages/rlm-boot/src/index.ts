/**
 * @rlm/boot — the boot layer, as a row.
 *
 * Everything `cordis-shell.mjs` used to do above "read a file and mount it"
 * lives here: watching the composition, layering the user's overlay on top of
 * it, telling every other row where the repo and this instance's state
 * directory are, and shutting down without leaving anything behind.
 *
 * It is a row rather than shell code for one reason, and it is the reason the
 * whole exercise exists: **a bug in any of this has to be fixable while rlm is
 * running.** The shell can only be fixed by restarting, and a thing that needs
 * a restart to change is a thing rlm cannot change about itself.
 *
 * ## The bootstrap paradox, and why it is not one
 *
 * If the row that watches the composition is loaded *from* the composition, a
 * bad edit could leave nobody watching. Three things make that recoverable:
 *
 * 1. A parse error cannot unload this row — `Include.refresh()` is
 *    transactional, so broken YAML leaves the running rlm exactly as it was.
 * 2. A valid edit that deletes this row is caught by the host, which keeps one
 *    slow `watchFile` poll on the composition forever. Put the row back and it
 *    returns.
 * 3. Both paths converge on the same `refresh()`, which short-circuits on
 *    unchanged content, so they never fight.
 *
 * ## Why the overlay is not a `refresh()`
 *
 * The composition is a file Include re-reads on every apply. The overlay is
 * not: it is a *value inside Include's own config* (`patches`). So a change to
 * the composition is `tree.refresh()`, and a change to the overlay has to go
 * back through the entry as a config update. Calling `refresh()` for an
 * overlay edit re-reads a file that did not change and re-applies the patches
 * Include already had — which looks exactly like nothing happening, and is
 * what rlm did until now: the shell read the patch file once at boot and never
 * again.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unwatchFile,
	watch as fsWatch,
	watchFile,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fiber } from "@deepseek-ai/cordis";
import { parse } from "yaml";

export const name = "rlm-boot";

/**
 * The one thing the boot layer exposes to every other row.
 *
 * Four values and no behaviour beyond `refresh`. Anything richer belongs in a
 * capability row that something else can replace; anything a row can work out
 * for itself does not belong here at all.
 */
export interface RlmHost {
	/** The repository root — the directory `packages/` lives in. */
	root: string;
	/** Where this instance keeps its state: overlay, sessions, skills. */
	home: string;
	/** The composition file currently mounted, when there is one. */
	composition: string | null;
	/** The overlay file, whether or not it exists yet. */
	overlay: string;
	/** Re-read the composition. Debounced; safe to call from anywhere. */
	refresh: () => void;
	/** `require` resolved from the repo root, for rows needing CJS interop. */
	require: NodeJS.Require;
}

export interface RlmBootConfig {
	/** The repo root. Defaults to the directory three levels above this file. */
	root?: string;
	/** This instance's state directory. Defaults to `$RLM_HOME` or `~/.rlm`. */
	home?: string;
	/** The overlay, layered over the composition. Defaults to `<home>/cordis.patch.yml`. */
	overlay?: string;
	/** How long to coalesce a burst of filesystem events, in milliseconds. */
	debounce?: number;
	/** Polling interval for the fallback watch on each file, in milliseconds. */
	poll?: number;
	/** Signals that start a graceful shutdown. */
	signals?: string[];
	/** How long to wait for a leaked handle before exiting anyway, in milliseconds. */
	shutdownGrace?: number;
}

/**
 * What this row accepts, as data.
 *
 * rlm has no Schemastery, so `rlm-compose`'s `describe` has nothing to read a
 * row's parameters out of. Exporting them is the cheapest thing that makes
 * "what can I change about myself?" answerable for a row that is not even
 * running — which is exactly when the question gets asked.
 */
export const configFields = [
	{ key: "root", type: "string", description: "Where rlm is installed - the folder its rows live in. Worked out automatically." },
	{ key: "home", type: "string", description: "The folder holding everything this rlm has learned and decided." },
	{ key: "overlay", type: "string", description: "The file holding changes made to the shipped setup. Delete it to return to stock." },
	{ key: "debounce", type: "number", default: 80, description: "How long to wait after a file changes before acting, in milliseconds." },
	{ key: "poll", type: "number", default: 400, description: "How often to check a config file by hand, for editors the fast path cannot see." },
	{ key: "signals", type: "string[]", default: ["SIGINT", "SIGTERM"], description: "Which interruptions shut rlm down politely." },
	{ key: "shutdownGrace", type: "number", default: 3000, description: "How long to wait on the way out for something that has not let go." },
];

/**
 * The repo root, derived from this file's own location rather than passed in,
 * so a copy of this row at `packages/<anything>/src/index.ts` resolves the same
 * root the original does. Overridable all the same.
 */
const derivedRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]+$/, "");

/**
 * Make a config change survive the next source edit.
 *
 * `ctx.plugin()` does not hand back the fiber. It hands back a thenable that
 * *inherits* from the fiber — `Object.create(fiber)` with a `then` on it — so
 * callers can `await` a plugin. The Loader stores that wrapper on
 * `entry.fiber`, so every config update runs `Fiber#update` with `this` bound
 * to the wrapper, and `this._config = config` creates an own property on the
 * wrapper that shadows the real fiber underneath.
 *
 * That is invisible until module hot reload, which does not go through the
 * entry at all: it rebuilds from `runtime.fibers`, and those are the *real*
 * fibers, whose `_config` still says whatever it said at boot. So change a
 * row's config while running, then edit that row's source, and it comes back
 * configured the way it started — silently and permanently, because
 * `entry.options.config` still holds the new value and the next update
 * therefore diffs to nothing.
 *
 * rlm is about to start rewriting its own config and its own source, in that
 * order, as a matter of course. This is the exact shape of edit that has to
 * survive.
 *
 * The second symptom is worse: `Fiber#update` on a fiber that is not ACTIVE —
 * one still waiting on an injected service — only records the config and
 * defers, and activation later reads it back off the fiber. Recorded on the
 * wrapper, read from the real fiber: the row activates with the config it had
 * before the update and stays that way. Any config change landing while a row
 * is PENDING is silently lost without this.
 *
 * **Installed and never removed, deliberately.** Every other registration in
 * this repo returns a disposer; this is the exception. Unloading this row and
 * restoring the original method means the very next config update — the one
 * that puts the row back — goes to the wrapper again. Reloading this row
 * replaces the patch in place, always chaining from the pristine method so
 * copies never stack.
 *
 * A workaround for a cordis bug, not a design. Delete it when `ctx.plugin()`
 * stops returning a prototype wrapper.
 */
const PRISTINE = Symbol.for("@rlm/boot: pristine Fiber#update");

function installFiberConfigShim() {
	const proto = Fiber.prototype as any;
	const original: typeof Fiber.prototype.update = (proto[PRISTINE] ??= proto.update);
	proto.update = function (this: Fiber, config: any, noSave?: boolean) {
		const result = original.call(this, config, noSave);
		// `this` is the wrapper exactly when its prototype is itself a fiber; on
		// a real fiber the prototype is `Fiber.prototype`, which is not one.
		const inner = Object.getPrototypeOf(this);
		if (inner instanceof Fiber) (inner as any)._config = config;
		return result;
	};
}

/**
 * Watch one config file so an edit always lands, whatever the editor.
 *
 * An atomic save (`sed -i`, vim, most GUI editors) replaces the file with a new
 * inode, and `fs.watch` on the path follows the OLD one — it fires once for the
 * replacement and is deaf from then on. Three overlapping watches cover it: the
 * file itself, its directory (survives the inode swap), and `watchFile` polling
 * (survives everything, including a write through a temp file on another
 * device). Duplicate notifications are collapsed by the caller's debounce.
 *
 * @returns a disposer closing every watch this call opened.
 */
function watchConfigFile(file: string, interval: number, onChange: () => void) {
	const dir = dirname(file);
	const leaf = file.slice(dir.length + 1);
	const closers: (() => void)[] = [];
	try {
		if (existsSync(file)) {
			const w = fsWatch(file, () => onChange());
			closers.push(() => w.close());
		}
	} catch {
		/* the directory watch below is the real guarantee */
	}
	try {
		mkdirSync(dir, { recursive: true });
		const w = fsWatch(dir, (_event, entry) => {
			if (!entry || entry === leaf) onChange();
		});
		closers.push(() => w.close());
	} catch {
		/* polling below is the last resort */
	}
	const poll = (curr: { mtimeMs: number; ino: number }, prev: { mtimeMs: number; ino: number }) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino) onChange();
	};
	watchFile(file, { interval }, poll as any);
	closers.push(() => unwatchFile(file, poll as any));
	return () => {
		for (const close of closers.reverse()) {
			try {
				close();
			} catch {
				/* a watch that is already gone is the outcome we wanted */
			}
		}
	};
}

/** The `cordis-plugin-include` this row was mounted from, if it was. */
interface HostTree {
	filename: string;
	refresh(): Promise<void>;
	ctx: {
		fiber: {
			entry?: {
				options: { config: any };
				update(o: any, c: boolean, f: boolean): Promise<void>;
			};
			await?(): Promise<unknown>;
		};
	};
}

function hostTree(ctx: any): HostTree | undefined {
	const tree = ctx.fiber?.entry?.parent?.tree;
	if (typeof tree?.filename === "string" && typeof tree?.refresh === "function") return tree;
	return undefined;
}

export function apply(ctx: any, config: RlmBootConfig = {}) {
	const debounceMs = config.debounce ?? 80;
	const pollMs = config.poll ?? 400;
	const root = config.root ?? derivedRoot;
	const home = config.home ?? process.env.RLM_HOME ?? join(homedir(), ".rlm");
	const overlayPath = config.overlay ?? join(home, "cordis.patch.yml");
	const info = (message: string) => ctx.logger?.info?.(`boot: ${message}`);
	const warn = (message: string) => ctx.logger?.warn?.(`boot: ${message}`);

	/**
	 * Say something once the log has somewhere to go. The console exporter is a
	 * row like any other and is not necessarily ACTIVE while this one applies,
	 * so anything said during `apply` can land in a void.
	 */
	const banner: string[] = [];
	ctx.effect(() => {
		const timer = setTimeout(() => banner.splice(0).forEach(info), 0);
		timer.unref?.();
		return () => clearTimeout(timer);
	}, "rlm-boot banner");

	// Not an effect: the patch outlives this fiber on purpose. See the comment
	// on `installFiberConfigShim`.
	installFiberConfigShim();

	const tree = hostTree(ctx);
	/** Set on unload, so deferred work started at init does not act after it. */
	let disposed = false;
	ctx.effect(
		() => () => {
			disposed = true;
		},
		"rlm-boot disposal flag",
	);

	/**
	 * Debounce that forgets its pending call when the fiber unloads. Without the
	 * disposer a reload leaves a timer holding the old tree, which then
	 * refreshes a tree the new instance is also refreshing.
	 */
	const debounce = (fn: () => void) => {
		let timer: NodeJS.Timeout | null = null;
		const call = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				fn();
			}, debounceMs);
		};
		ctx.effect(
			() => () => {
				if (timer) clearTimeout(timer);
				timer = null;
			},
			"rlm-boot debounce",
		);
		return call;
	};

	const refresh = debounce(() => {
		if (!tree) return;
		tree.refresh().catch((error: any) => warn(`refresh failed: ${error?.message ?? error}`));
	});

	// ── The overlay ──────────────────────────────────────────────────────────

	/** Re-read the overlay. Absent is a valid answer, not an error. */
	const readOverlay = () => {
		if (!existsSync(overlayPath)) return undefined;
		try {
			return parse(readFileSync(overlayPath, "utf8")) ?? [];
		} catch (error: any) {
			warn(`overlay failed to parse (${overlayPath}): ${error?.message ?? error}`);
			return undefined;
		}
	};

	const applyOverlay = () => {
		const entry = tree?.ctx.fiber.entry;
		if (!entry) return;
		const patches = readOverlay();
		entry
			.update({ config: { ...entry.options.config, patches } }, false, true)
			.then(() => info(patches ? `overlay applied: ${overlayPath}` : "overlay removed"))
			.catch((error: any) => warn(`overlay failed: ${error?.message ?? error}`));
	};
	const reapplyOverlay = debounce(applyOverlay);

	if (tree) {
		ctx.effect(() => watchConfigFile(tree.filename, pollMs, refresh), "rlm-boot watch composition");
		ctx.effect(() => watchConfigFile(overlayPath, pollMs, reapplyOverlay), "rlm-boot watch overlay");
		banner.push(`composition: ${tree.filename}`);
		// At boot the overlay has to wait for the tree that carries it.
		//
		// This row is created BY the include's first apply, so at the moment it
		// runs the include's own fiber is still LOADING. `Fiber#update` on a
		// fiber that is not ACTIVE does not run the `internal/update` waterfall
		// at all — it records the config and defers — so the include never sees
		// the patches and they are lost, silently, with a success log. Waiting
		// for the fiber to settle costs the overlay one beat at boot and is the
		// same code path every later edit takes.
		if (existsSync(overlayPath)) {
			void (async () => {
				try {
					await (tree.ctx.fiber as any).await?.();
				} catch {
					/* a tree that failed to load has nothing to patch */
				}
				if (!disposed) applyOverlay();
			})();
		}
	} else {
		warn("not mounted from a config file — nothing to watch");
	}

	ctx.provide?.(
		"rlmHost",
		{
			root,
			home,
			composition: tree?.filename ?? null,
			overlay: overlayPath,
			refresh,
			require: createRequire(join(root, "package.json")),
		} satisfies RlmHost,
		true,
	);

	// ── Shutdown ─────────────────────────────────────────────────────────────
	/**
	 * Unload everything, then let the process end on its own.
	 *
	 * `process.exit()` here tears the runtime down mid-flight. Disposing the
	 * root fiber releases every effect, so once that resolves nothing should be
	 * keeping the loop alive and Node exits by itself. The timer is the backstop
	 * for a row that leaks a handle: it exits anyway rather than hanging on
	 * Ctrl-C, so a leak shows up as a pause with a message instead of a hang.
	 */
	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		info(`${signal} — unloading`);
		await ctx.root.fiber.dispose().catch((error: any) => warn(`dispose failed: ${error?.message ?? error}`));
		const backstop = setTimeout(() => {
			process.exit(0);
		}, config.shutdownGrace ?? 3000);
		backstop.unref();
	};

	ctx.effect(() => {
		const installed: [string, () => void][] = [];
		for (const signal of config.signals ?? ["SIGINT", "SIGTERM"]) {
			const handler = () => void shutdown(signal);
			process.on(signal as NodeJS.Signals, handler);
			installed.push([signal, handler]);
		}
		return () => {
			for (const [signal, handler] of installed) process.off(signal as NodeJS.Signals, handler);
		};
	}, "rlm-boot signals");

	banner.push(`home: ${home}`);
	banner.push("up");
}

export default apply;
