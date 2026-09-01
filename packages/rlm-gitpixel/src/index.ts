/**
 * @rlm/gitpixel — deterministic gitpixel enforcement as a Cordis Service.
 *
 * The agent has exactly one tool: `code`. Every read, search, and edit it will
 * ever perform passes through that single door. This plugin stands in the door
 * and rewrites what walks through it.
 *
 * Three layers, strongest first:
 *
 *   1. SUBSTITUTION — a `tool_call` handler mutates `event.input.code` in
 *      place before the kernel runs it. A bare `rg`/`grep`/`ag` in a `%%bash`
 *      cell or a `!` line becomes `gitpixel search`. The model is not asked,
 *      not told, and never sees an error: the cell it wrote is simply the
 *      better cell by the time it executes.
 *   2. INJECTION — the persistent kernel is seeded once with `gp.*`, so the
 *      code graph is a value in scope rather than a CLI the model must
 *      remember. Because the vm context survives across calls, seeding it once
 *      is enough for the whole session.
 *   3. GATE — a destructive git reset in a shell cell is refused, with
 *      `gitpixel rescue` named as the non-destructive answer.
 *
 * Policy is not defined here. It lives in gitpixel's own js/substitute module,
 * which the Claude Code hook loads too — one contract, two harnesses.
 *
 * Hot-swappable: the extension factory is contributed through a global
 * registry keyed by plugin id, so a fiber.restart() replaces it rather than
 * stacking a second copy, and [Symbol.dispose] withdraws it cleanly.
 */
import { Service } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

const require_ = createRequire(import.meta.url);

const PLUGIN_ID = "rlm-gitpixel";

export interface RlmGitpixelConfig {
	cwd?: string;
	/** Explicit path to gitpixel's js/substitute module. */
	enginePath?: string;
	/** Warm the index on session start. Default true. */
	warmOnStart?: boolean;
	/**
	 * Build gitpixel from source when the binary is not on PATH. Default true.
	 *
	 * Installing takes minutes and happens in the background; the plugin stays
	 * inert until it finishes, then activates without a restart.
	 */
	autoInstall?: boolean;
	/** Where to clone and build. Default ~/.rlm/agent/tools/gitpixel. */
	installDir?: string;
}

/** The subset of gitpixel's substitution engine this plugin uses. */
const GITPIXEL_REPO = "https://github.com/LivioGama/gitpixel.git";

interface Engine {
	rewriteKernelCode(code: string, opts?: { cwd?: string }): { code: string; notes: string[] } | null;
	gateShell(cmd: string): { allow: boolean; reason?: string };
	kernelBootstrap(cwd?: string, manifest?: unknown): string;
	promptFragment(manifest: unknown, options?: { help?: string | null }): string;
	cliHelp(subcommands?: string[]): string | null;
	loadManifest(startPath: string): unknown;
	gp(args: string[], opts?: { cwd?: string; timeout?: number }): string | null;
	gitpixelAvailable(): boolean;
}

/** The substitution engine ships inside the gitpixel checkout, beside the binary. */
function engineNextToBinary(): string | null {
	try {
		const which = execFileSync("sh", ["-c", "command -v gitpixel"], { encoding: "utf8" }).trim();
		if (!which) return null;
		const real = execFileSync("readlink", ["-f", which], { encoding: "utf8" }).trim() || which;
		// <checkout>/target/release/gitpixel → <checkout>/js/substitute/index.cjs
		return join(real, "..", "..", "..", "js", "substitute", "index.cjs");
	} catch {
		return null;
	}
}

function resolveEngine(explicit?: string): Engine | null {
	const candidates = [
		explicit,
		process.env.GITPIXEL_SUBSTITUTE,
		engineNextToBinary(),
		join(homedir(), "proj/tools/gitpixel/js/substitute/index.cjs"),
		join(homedir(), ".rlm/agent/tools/gitpixel/js/substitute/index.cjs"),
		"/usr/local/lib/gitpixel/js/substitute/index.cjs",
		"/opt/homebrew/lib/gitpixel/js/substitute/index.cjs",
	].filter(Boolean) as string[];
	for (const c of candidates) {
		try {
			if (existsSync(c)) {
				// Bust the CJS cache so a fiber.restart() picks up an edited policy.
				delete require_.cache[require_.resolve(c)];
				return require_(c) as Engine;
			}
		} catch {}
	}
	return null;
}

/** Extension factories contributed by plugins, picked up by @rlm/agent. */
type FactoryEntry = { id: string; factory: (pi: any) => void };

function factoryRegistry(): FactoryEntry[] {
	const g = globalThis as any;
	if (!Array.isArray(g.__rlmExtensionFactories)) g.__rlmExtensionFactories = [];
	return g.__rlmExtensionFactories as FactoryEntry[];
}

export class RlmGitpixelService extends Service {
	static inject = ["rlmConfig"] as const;
	static provide = "rlmGitpixel" as const;

	declare config: RlmGitpixelConfig;

	private engine: Engine | null = null;
	private cwd = process.cwd();
	/** The kernel is seeded once per session; the vm context persists. */
	private seeded = false;
	private installing = false;
	private rewrites = 0;

	constructor(ctx: any, config: RlmGitpixelConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	/** Boot diagnostics, visible with RLM_VERBOSE=1. */
	private diag(message: string) {
		// Console output is opt-in and ephemeral; the log is neither, and it is
		// what someone reads after the fact when this went wrong.
		try {
			(globalThis as any).__rlmLog?.("info", "gitpixel", message);
		} catch {}
		if (process.env.RLM_VERBOSE || process.env.RLM_HMR_VERBOSE) console.error(`[rlm] ${message}`);
	}

	async [Service.init]() {
		this.diag("rlm-gitpixel: init");
		const rlmConfig = this.ctx.get("rlmConfig") as {
			getSettingsManager?: () => { getCwd?: () => string } | undefined;
		};
		// cordis.yml carries `cwd: .`, so this must be resolved: a literal "."
		// would be compared against absolute paths when deciding whether a file
		// belongs to this repo, and every such comparison would fail.
		this.cwd = resolve(this.config.cwd ?? rlmConfig?.getSettingsManager?.()?.getCwd?.() ?? process.cwd());

		// Contribute first, resolve second. Both contributions read the engine
		// lazily, so an install that finishes minutes from now activates this
		// plugin without a restart and without re-registering anything.
		this.contributeFactory();
		this.contributePrompt();

		this.engine = this.resolveUsableEngine();
		if (this.engine) {
			this.diag(`rlm-gitpixel: enforcing (cwd=${this.cwd})`);
			this.ctx.logger?.info(`rlm-gitpixel: enforcing (cwd=${this.cwd})`);
			return;
		}

		if (this.config.autoInstall === false) {
			this.ctx.logger?.warn("rlm-gitpixel: gitpixel not available and autoInstall is off — inert");
			return;
		}
		void this.install();
	}

	/** An engine is only usable if the binary it drives is actually there. */
	private resolveUsableEngine(): Engine | null {
		const engine = resolveEngine(this.config.enginePath);
		if (!engine) return null;
		if (!engine.gitpixelAvailable()) return null;
		return engine;
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
	 * Build gitpixel from source, in the background, and activate when it lands.
	 *
	 * The agent should not have to be told to install its own tooling, and a
	 * missing binary should not quietly mean a worse agent for the rest of the
	 * session. Nothing here blocks startup: the plugin is already registered and
	 * simply does nothing until the build finishes.
	 */
	private async install(): Promise<void> {
		if (this.installing) return;
		this.installing = true;
		const dir = this.config.installDir ?? join(homedir(), ".rlm", "agent", "tools", "gitpixel");

		if (!this.has("git") || !this.has("cargo")) {
			this.ctx.logger?.warn(
				`rlm-gitpixel: gitpixel is missing and cannot be built (need git and cargo) — ` +
					`install it manually: git clone ${GITPIXEL_REPO} && cd gitpixel && cargo build --release`,
			);
			this.installing = false;
			return;
		}

		this.ctx.logger?.info(`rlm-gitpixel: building gitpixel from source in ${dir} (this takes a few minutes)`);
		this.diag(`rlm-gitpixel: installing into ${dir}`);

		try {
			if (!existsSync(join(dir, "Cargo.toml"))) {
				mkdirSync(dir, { recursive: true });
				const cloned = await this.run("git", ["clone", "--depth", "1", GITPIXEL_REPO, dir], homedir());
				if (!cloned) throw new Error("clone failed");
			}
			const built = await this.run("cargo", ["build", "--release"], dir);
			if (!built) throw new Error("cargo build failed");

			const bin = join(dir, "target", "release", "gitpixel");
			if (!existsSync(bin)) throw new Error("build produced no binary");
			process.env.GITPIXEL_BIN = bin;
			process.env.GITPIXEL_SUBSTITUTE = join(dir, "js", "substitute", "index.cjs");

			this.engine = this.resolveUsableEngine();
			if (!this.engine) throw new Error("built gitpixel is still not usable");

			this.seeded = false; // the next cell seeds a kernel that now has gp
			this.ctx.logger?.info(`rlm-gitpixel: gitpixel installed at ${bin} — enforcing from the next tool call`);
			this.diag(`rlm-gitpixel: installed at ${bin}`);
		} catch (error: any) {
			this.ctx.logger?.warn(`rlm-gitpixel: automatic install failed (${error?.message ?? error}) — inert`);
			this.diag(`rlm-gitpixel: install failed: ${error?.message ?? error}`);
		} finally {
			this.installing = false;
		}
	}

	/**
	 * Publish the extension factory for @rlm/agent to load into every
	 * AgentSession.
	 *
	 * Registered as a ctx.effect() so the fiber owns it: a fiber.restart()
	 * withdraws the old contribution before the reloaded module adds its own,
	 * which is what keeps a hot-swap from stacking two copies of the rewriter.
	 */
	private contributeFactory() {
		this.ctx.effect(() => {
			const reg = factoryRegistry();
			const stale = reg.findIndex((e) => e.id === PLUGIN_ID);
			if (stale >= 0) reg.splice(stale, 1);
			const entry: FactoryEntry = { id: PLUGIN_ID, factory: (pi: any) => this.register(pi) };
			reg.push(entry);
			this.diag(`rlm-gitpixel: factory contributed (registry size ${reg.length})`);
			return () => {
				const i = reg.indexOf(entry);
				if (i >= 0) reg.splice(i, 1);
			};
		});
	}

	/** Wire the handlers onto one AgentSession's extension API. */
	private register(pi: any) {
		this.diag("rlm-gitpixel: attaching handlers to a session");
		pi.on("session_start", () => {
			this.seeded = false;
			if (this.config.warmOnStart === false) return;
			// Warm index + graph without holding up the first turn.
			setTimeout(() => {
				try {
					this.engine?.gp(["ready", this.cwd, "--no-daemon"], { cwd: this.cwd, timeout: 180000 });
				} catch {}
			}, 0);
		});

		pi.on("tool_call", (event: any) => {
			if (!this.engine || event.toolName !== "code") return;
			const input = event.input as { code?: string };
			const original = typeof input?.code === "string" ? input.code : null;
			if (original === null) return;

			// Gate: a destructive reset never runs, whatever cell it hides in.
			const gate = this.engine.gateShell(original);
			if (!gate.allow) return { block: true, reason: gate.reason };

			let code = original;

			// Substitute: the cell becomes the cell it should have been.
			const rewritten = this.engine.rewriteKernelCode(code, { cwd: this.cwd });
			if (rewritten) {
				code = rewritten.code;
				this.rewrites += rewritten.notes.length;
			}

			// Inject: seed `gp.*` and the fs interception into the persistent
			// kernel, once. The manifest is read at seed time so the scope the
			// agent is answered with is the scope in force for this session.
			//
			// Never into a cell magic: the kernel recognises `%%bash` only at
			// offset zero, so prepending anything to such a cell would stop it
			// being a shell cell at all. Seeding waits for the next JS cell —
			// shell cells are already covered by substitution.
			if (!this.seeded && !/^[ \t]*%%/.test(code)) {
				const manifest: any = this.engine.loadManifest(this.cwd);
				this.diag(
					`rlm-gitpixel: seeding (cwd=${this.cwd}, manifest=${
						manifest ? `${manifest.files?.length ?? 0} file(s)${manifest.stale ? " STALE" : ""}` : "none"
					})`,
				);
				code = `${this.engine.kernelBootstrap(this.cwd, manifest)}\n${code}`;
				this.seeded = true;
				this.diag("rlm-gitpixel: kernel seeded with gp.* and fs interception");
			}

			// Mutation in place is the contract — no re-validation follows.
			if (code !== original) input.code = code;
			return undefined;
		});
	}

	private contributePrompt() {
		this.ctx.effect(() => {
			let handle: { dispose(): void } | undefined;
			try {
				const svc = (globalThis as any).__rlmPrompt ?? (this.ctx as any).get?.("rlmPrompt");
				if (svc?.registerFragment) {
					// Evaluated per prompt build: the manifest changes between
					// turns, and the engine may not exist yet when this registers.
					handle = svc.registerFragment(PLUGIN_ID, {
						id: "gitpixel-contract",
						priority: 40,
						content: () => {
							if (!this.engine) return "";
							return this.engine.promptFragment(this.engine.loadManifest(this.cwd), {
								help: this.engine.cliHelp(),
							});
						},
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

	/** How many operations this session has silently improved. */
	stats() {
		return { rewrites: this.rewrites, seeded: this.seeded, active: this.engine !== null };
	}

	async [Symbol.dispose]() {
		const reg = factoryRegistry();
		const i = reg.findIndex((e) => e.id === PLUGIN_ID);
		if (i >= 0) reg.splice(i, 1);
		try {
			this.promptHandle?.dispose();
		} catch {}
		try {
			(globalThis as any).__rlmPrompt?.disposePlugin?.(PLUGIN_ID);
		} catch {}
	}
}

export default RlmGitpixelService;
export const name = "rlm-gitpixel";
export const inject = ["rlmConfig"] as const;
export { RlmGitpixelService as RlmGitpixel };
