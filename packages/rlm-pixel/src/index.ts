/**
 * @rlm/pixel — deterministic pixel enforcement as a Cordis Service.
 *
 * Pixel (github.com/LivioGama/pixel) is the successor to gitpixel. The key
 * architectural change: pixel's rewire logic is built into the Rust CLI, not
 * a JS module. There is no `js/substitute/index.cjs` to load — pixel handles
 * agent integration through `pixel install` (hooks, managed blocks in
 * CLAUDE.md/AGENTS.md) and the agent uses `pixel` commands directly.
 *
 * This plugin does four things:
 *
 *   1. AUTO-INSTALL — if the `pixel` binary is not on PATH, build it from
 *      source in the background. The plugin stays inert until the build
 *      finishes, then activates without a restart.
 *   2. WARM — on session_start, run `pixel ready .` to build the text index
 *      and code graph. Skipped in headless mode (a 15-second `--print` child
 *      should not pay 149 MB for an index it will never query twice).
 *   3. REAP — delete graph-rebuild scratch DBs left behind by dead pixel
 *      processes in `.pixel/`.
 *   4. PROMPT — contribute a fragment to the system prompt that teaches the
 *      agent about pixel commands (`pixel search`, `pixel impact`,
 *      `pixel rescue`, etc.) so it uses them instead of raw `rg`/`grep`.
 *
 * What this plugin does NOT do (unlike rlm-gitpixel):
 *
 *   - No SUBSTITUTION — pixel's rewire is in the CLI, not a JS engine. The
 *     agent learns to use `pixel search` from the prompt fragment, not from
 *     having its code cells silently rewritten.
 *   - No INJECTION — pixel has no `gp.*` kernel globals. The CLI is the API.
 *   - No GATE — pixel has its own git safety via `pixel rescue`, `pixel
 *     publish`, `pixel ship` with state checks and recovery keys.
 *
 * Hot-swappable: the extension factory is contributed through a global
 * registry keyed by plugin id, so a fiber.restart() replaces it rather than
 * stacking a second copy, and [Symbol.dispose] withdraws it cleanly.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PLUGIN_ID = "rlm-pixel";

/** Where to clone and build pixel. Default ~/.rlm/agent/tools/pixel. */
const DEFAULT_INSTALL_DIR = join(homedir(), ".rlm", "agent", "tools", "pixel");
const PIXEL_REPO = "https://github.com/LivioGama/pixel.git";

export interface RlmPixelConfig {
	cwd?: string;
	/** Warm the index on session start. Default true. */
	warmOnStart?: boolean;
	/**
	 * Build pixel from source when the binary is not on PATH. Default true.
	 *
	 * Installing takes minutes and happens in the background; the plugin stays
	 * inert until it finishes, then activates without a restart.
	 */
	autoInstall?: boolean;
	/** Where to clone and build. Default ~/.rlm/agent/tools/pixel. */
	installDir?: string;
}

/** Extension factories contributed by plugins, picked up by @rlm/agent. */
type FactoryEntry = { id: string; factory: (pi: any) => void };

function factoryRegistry(): FactoryEntry[] {
	const g = globalThis as any;
	if (!Array.isArray(g.__rlmExtensionFactories)) g.__rlmExtensionFactories = [];
	return g.__rlmExtensionFactories as FactoryEntry[];
}

export class RlmPixelService extends Service {
	static inject = ["rlmConfig"] as const;
	static provide = "rlmPixel" as const;

	declare config: RlmPixelConfig;

	private cwd = process.cwd();
	private installing = false;
	private available = false;
	/** In-flight `pixel ready` per cwd, so sessions starting together share one. */
	private warming = new Map<string, ReturnType<typeof spawn>>();
	/** `pixel --help` is static for a given binary; asked once, not per prompt build. */
	private helpText: string | null = null;

	constructor(ctx: any, config: RlmPixelConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	/** Boot diagnostics, visible with RLM_VERBOSE=1. */
	private diag(message: string) {
		try {
			(globalThis as any).__rlmLog?.("info", "pixel", message);
		} catch {}
		if (process.env.RLM_VERBOSE || process.env.RLM_HMR_VERBOSE) console.error(`[rlm] ${message}`);
	}

	async [Service.init]() {
		// Cordis never calls `[Symbol.dispose]`; the effect disposer is what runs when
		// this fiber goes (swap or removal). See packages/rlm-hmr/src/hot.ts.
		(this.ctx as any).effect(() => () => void this.retire(), "rlm-pixel retire");
		this.diag("rlm-pixel: init");
		const rlmConfig = this.ctx.get("rlmConfig") as {
			getSettingsManager?: () => { getCwd?: () => string } | undefined;
		};
		// cordis.yml carries `cwd: .`, so this must be resolved: a literal "."
		// would be compared against absolute paths when deciding whether a file
		// belongs to this repo, and every such comparison would fail.
		this.cwd = resolve(this.config.cwd ?? rlmConfig?.getSettingsManager?.()?.getCwd?.() ?? process.cwd());

		// Contribute first, resolve second. The contribution reads pixel's
		// CLI lazily, so an install that finishes minutes from now activates
		// this plugin without a restart and without re-registering anything.
		this.contributeFactory();
		this.contributePrompt();

		this.available = this.has("pixel");
		if (this.available) {
			this.diag(`rlm-pixel: enforcing (cwd=${this.cwd})`);
			this.ctx.logger?.info(`rlm-pixel: enforcing (cwd=${this.cwd})`);
			return;
		}

		if (this.config.autoInstall === false) {
			this.ctx.logger?.warn("rlm-pixel: pixel not available and autoInstall is off — inert");
			return;
		}
		void this.install();
	}

	private has(bin: string): boolean {
		try {
			execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}

	private run(cmd: string, args: string[], cwd: string): Promise<boolean> {
		return new Promise((resolve) => {
			const child = spawn(cmd, args, { cwd, stdio: "ignore" });
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
		});
	}

	/**
	 * Build pixel from source, in the background, and activate when it lands.
	 *
	 * The agent should not have to be told to install its own tooling, and a
	 * missing binary should not quietly mean a worse agent for the rest of the
	 * session. Nothing here blocks startup: the plugin is already registered and
	 * simply does nothing until the build finishes.
	 */
	private async install(): Promise<void> {
		if (this.installing) return;
		this.installing = true;
		const dir = this.config.installDir ?? DEFAULT_INSTALL_DIR;

		if (!this.has("git") || !this.has("cargo")) {
			this.ctx.logger?.warn(
				`rlm-pixel: pixel is missing and cannot be built (need git and cargo) — ` +
					`install it manually: git clone ${PIXEL_REPO} && cd pixel && cargo build --release -p pixel-cli`,
			);
			this.installing = false;
			return;
		}

		this.ctx.logger?.info(`rlm-pixel: building pixel from source in ${dir} (this takes a few minutes)`);
		this.diag(`rlm-pixel: installing into ${dir}`);

		try {
			if (!existsSync(join(dir, "Cargo.toml"))) {
				mkdirSync(dir, { recursive: true });
				const cloned = await this.run("git", ["clone", "--depth", "1", PIXEL_REPO, dir], homedir());
				if (!cloned) throw new Error("clone failed");
			}
			const built = await this.run("cargo", ["build", "--release", "-p", "pixel-cli"], dir);
			if (!built) throw new Error("cargo build failed");

			const bin = join(dir, "target", "release", "pixel");
			if (!existsSync(bin)) throw new Error("build produced no binary");

			// Put the binary on PATH so `pixel` resolves in subsequent calls.
			// Also set PIXEL_BIN for explicit reference.
			process.env.PIXEL_BIN = bin;
			const localBin = join(homedir(), ".local", "bin");
			try {
				mkdirSync(localBin, { recursive: true });
				const link = join(localBin, "pixel");
				if (!existsSync(link)) {
					// Symlink if possible, copy as fallback.
					try {
						execFileSync("ln", ["-s", bin, link], { stdio: "ignore" });
					} catch {
						execFileSync("cp", [bin, link], { stdio: "ignore" });
					}
				}
			} catch {}

			this.available = this.has("pixel") || existsSync(bin);
			if (!this.available) throw new Error("built pixel is still not usable");

			this.ctx.logger?.info(`rlm-pixel: pixel installed at ${bin} — enforcing from the next tool call`);
			this.diag(`rlm-pixel: installed at ${bin}`);
		} catch (error: any) {
			this.ctx.logger?.warn(`rlm-pixel: automatic install failed (${error?.message ?? error}) — inert`);
			this.diag(`rlm-pixel: install failed: ${error?.message ?? error}`);
		} finally {
			this.installing = false;
		}
	}

	/**
	 * Delete graph-rebuild scratch DBs left behind by dead pixel processes.
	 *
	 * `pixel ready` rebuilds the graph into a sibling scratch file named
	 * `.graph-rebuild-<pid>.db` and renames it over `graph.db` once it lands.
	 * A rebuild that dies before that rename leaves the scratch file behind,
	 * and nothing ever collects it.
	 *
	 * Liveness is the only thing that authorises a delete, checked with
	 * `kill(pid, 0)`: ESRCH means gone, EPERM means alive under another user.
	 * A recycled pid therefore reads as alive and its file is kept — the
	 * conservative direction, because leaking a scratch file costs disk while
	 * deleting a live rebuild's file costs a corrupted index.
	 */
	private reapStaleRebuildDbs(): void {
		const dir = join(this.cwd, ".pixel");
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}

		let freed = 0;
		let count = 0;
		for (const name of names) {
			const match = /^\.graph-rebuild-(\d+)\.db$/.exec(name);
			if (!match) continue;

			const pid = Number(match[1]);
			if (!Number.isSafeInteger(pid) || pid <= 0) continue;

			try {
				process.kill(pid, 0);
				continue; // alive, or alive but not ours — leave it alone
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue;
			}

			const file = join(dir, name);
			try {
				const size = statSync(file).size;
				unlinkSync(file);
				freed += size;
				count += 1;
			} catch {
				// Raced with another session's reaper, or not ours to remove.
			}
		}

		if (count > 0) {
			const mb = (freed / 1024 / 1024).toFixed(1);
			const line = `rlm-pixel: reaped ${count} stale graph-rebuild db(s), ${mb} MB`;
			this.diag(line);
			this.ctx.logger?.info(line);
		}
	}

	/** Run `pixel <args>` synchronously, returning stdout or null on failure. */
	private pixel(args: string[], opts?: { cwd?: string; timeout?: number }): string | null {
		const bin = process.env.PIXEL_BIN ?? "pixel";
		try {
			return execFileSync(bin, args, {
				cwd: opts?.cwd ?? this.cwd,
				timeout: opts?.timeout ?? 60_000,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "ignore"],
			}).trim();
		} catch {
			return null;
		}
	}

	/**
	 * Publish the extension factory for @rlm/agent to load into every
	 * AgentSession.
	 *
	 * Registered as a ctx.effect() so the fiber owns it: a fiber.restart()
	 * withdraws the old contribution before the reloaded module adds its own,
	 * which is what keeps a hot-swap from stacking two copies.
	 */
	private contributeFactory() {
		this.ctx.effect(() => {
			const reg = factoryRegistry();
			const stale = reg.findIndex((e) => e.id === PLUGIN_ID);
			if (stale >= 0) reg.splice(stale, 1);
			const entry: FactoryEntry = { id: PLUGIN_ID, factory: (pi: any) => this.register(pi) };
			reg.push(entry);
			this.diag(`rlm-pixel: factory contributed (registry size ${reg.length})`);
			return () => {
				const i = reg.indexOf(entry);
				if (i >= 0) reg.splice(i, 1);
			};
		});
	}

	/** Wire the session_start handler onto one AgentSession's extension API. */
	private register(pi: any) {
		this.diag("rlm-pixel: attaching handlers to a session");
		pi.on("session_start", () => {
			// Deliberately above both the warmOnStart check and the headless gate.
			// What those two guard against is the cost of re-indexing a repository;
			// this is a readdir plus one liveness check per match, and the directory
			// it cleans only grows because nothing else ever looks at it.
			this.reapStaleRebuildDbs();

			if (this.config.warmOnStart === false) return;

			// Not in a run nobody is watching.
			//
			// `pixel ready` re-indexes the whole repository. That is the right
			// thing to pay for once, at the start of a session somebody will keep
			// asking questions of. It is the single most expensive thing a
			// fifteen-second `--print` child does.
			//
			// Skipped rather than parked, because the rest of this row is the
			// prompt fragment — the thing that teaches the agent to use pixel —
			// and a delegated child is exactly where that has to keep working.
			//
			// Probed with `ctx.get` rather than injected: an rlm composed without
			// the headless row is not headless, it simply has no opinion, and this
			// row must stay useful in that composition.
			if ((this.ctx.get("rlmHeadless") as { on?: boolean } | undefined)?.on) {
				this.diag("rlm-pixel: headless — skipping the warm index");
				return;
			}

			this.warmIndex();
		});
	}

	/**
	 * Warm index + graph without holding up the first turn.
	 *
	 * Async on purpose. This used to be `execFileSync` inside a `setTimeout(0)`,
	 * which defers the call but still blocks the event loop for the whole
	 * index: 8.1s in this repo, measured, with the TUI frozen — no render, no
	 * keystrokes. And it ran on every `session_start`, so each in-process
	 * subagent froze the parent's screen again. One warm per cwd at a time;
	 * a session that starts while one is running rides on it.
	 */
	private warmIndex() {
		if (this.warming.has(this.cwd)) return;
		// Only a git work tree has an index worth warming: `pixel ready /tmp` was
		// measured at 62% CPU and 1.5 GB for an index nothing would read.
		if (!insideGitWorkTree(this.cwd)) return;
		// One warm-up per directory across every rlm process, not one each.
		const lock = join(tmpdir(), `rlm-pixel-warm-${createHash("sha1").update(this.cwd).digest("hex").slice(0, 16)}.pid`);
		if (lockHeldByLiveProcess(lock)) return;
		const bin = process.env.PIXEL_BIN ?? "pixel";
		try {
			// Low priority: warming must never take CPU from the terminal UI.
			const child = spawn("nice", ["-n", "10", bin, "ready", this.cwd, "--no-daemon"], {
				cwd: this.cwd,
				stdio: "ignore",
				timeout: 180_000,
			});
			try {
				if (child.pid) writeFileSync(lock, String(child.pid));
			} catch {}
			this.warming.set(this.cwd, child);
			const done = () => {
				if (this.warming.get(this.cwd) === child) this.warming.delete(this.cwd);
				try {
					if (readFileSync(lock, "utf8") === String(child.pid)) unlinkSync(lock);
				} catch {}
			};
			child.once("exit", done);
			child.once("error", done);
			child.unref();
		} catch {}
	}

	private contributePrompt() {
		this.ctx.effect(() => {
			let handle: { dispose(): void } | undefined;
			try {
				const svc = (globalThis as any).__rlmPrompt ?? (this.ctx as any).get?.("rlmPrompt");
				if (svc?.registerFragment) {
					handle = svc.registerFragment(PLUGIN_ID, {
						id: "pixel-contract",
						priority: 40,
						content: () => this.buildPromptFragment(),
					});
				}
			} catch {}
			return () => {
				try {
					handle?.dispose();
				} catch {}
			};
		});
	}

	/**
	 * Build the prompt fragment that teaches the agent about pixel commands.
	 *
	 * Uses `pixel --help` output when pixel is available, falling back to a
	 * static summary when it is not (or not yet installed).
	 */
	private buildPromptFragment(): string {
		if (!this.available) return "";

		if (!this.helpText) this.helpText = this.pixel(["--help"]);
		const help = this.helpText;
		if (!help) return "";

		// Extract the command list from `pixel --help` output.
		// The help output format is:
		//   Commands:
		//     search    Find text with the local index
		//     ...
		const lines = help.split("\n");
		const cmdStart = lines.findIndex((l) => /^\s*Commands:/i.test(l));
		if (cmdStart < 0) return "";

		const cmdLines: string[] = [];
		for (let i = cmdStart + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === "") break;
			if (/^\s*Options:/i.test(line)) break;
			cmdLines.push(line);
		}

		return [
			"## Pixel — local repository control layer",
			"",
			"Pixel is installed and warmed. Use pixel commands instead of raw shell tools for repository work:",
			"",
			"```",
			...cmdLines,
			"```",
			"",
			"Prefer `pixel search` over `rg`/`grep` for text search.",
			"Prefer `pixel impact` over manual caller analysis.",
			"Prefer `pixel rescue` over `git reset --hard` for recovery.",
			"Prefer `pixel publish` or `pixel ship` over raw `git commit && git push`.",
			"Use `pixel targets` to build a prioritized task map before editing.",
			"Use `pixel status .` to check index/graph freshness.",
			"",
			"Run `pixel <command> --help` for command-specific options. Add `--json` for machine-readable output.",
		].join("\n");
	}

	/** How many operations this session has silently improved. */
	stats() {
		return { active: this.available, installing: this.installing };
	}

	/** This generation ends: release what it registered. */
	async retire() {
		const reg = factoryRegistry();
		const i = reg.findIndex((e) => e.id === PLUGIN_ID);
		if (i >= 0) reg.splice(i, 1);
		for (const child of this.warming.values()) child.kill();
		this.warming.clear();
		try {
			(globalThis as any).__rlmPrompt?.disposePlugin?.(PLUGIN_ID);
		} catch {}
	}
}

export default RlmPixelService;
export const name = "rlm-pixel";
export const inject = ["rlmConfig"] as const;
export { RlmPixelService as RlmPixel };

function insideGitWorkTree(dir: string): boolean {
	let current = resolve(dir);
	for (;;) {
		if (existsSync(join(current, ".git"))) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/** True when `lock` names a process that is still running (signal 0 only probes). */
function lockHeldByLiveProcess(lock: string): boolean {
	try {
		const pid = Number(readFileSync(lock, "utf8"));
		if (!Number.isInteger(pid) || pid <= 0) return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
