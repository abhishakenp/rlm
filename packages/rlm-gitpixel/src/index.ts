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
import { existsSync } from "node:fs";

const require_ = createRequire(import.meta.url);

const PLUGIN_ID = "rlm-gitpixel";

export interface RlmGitpixelConfig {
	cwd?: string;
	/** Explicit path to gitpixel's js/substitute module. */
	enginePath?: string;
	/** Warm the index on session start. Default true. */
	warmOnStart?: boolean;
}

/** The subset of gitpixel's substitution engine this plugin uses. */
interface Engine {
	rewriteKernelCode(code: string, opts?: { cwd?: string }): { code: string; notes: string[] } | null;
	gateShell(cmd: string): { allow: boolean; reason?: string };
	kernelBootstrap(cwd?: string, manifest?: unknown): string;
	promptFragment(manifest: unknown): string;
	loadManifest(startPath: string): unknown;
	gp(args: string[], opts?: { cwd?: string; timeout?: number }): string | null;
	gitpixelAvailable(): boolean;
}

function resolveEngine(explicit?: string): Engine | null {
	const candidates = [
		explicit,
		process.env.GITPIXEL_SUBSTITUTE,
		join(homedir(), "proj/tools/gitpixel/js/substitute/index.cjs"),
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
	private rewrites = 0;

	constructor(ctx: any, config: RlmGitpixelConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	/** Boot diagnostics, visible with RLM_VERBOSE=1. */
	private diag(message: string) {
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

		this.engine = resolveEngine(this.config.enginePath);
		if (!this.engine) {
			this.diag("rlm-gitpixel: substitution engine not found — plugin is inert");
			this.ctx.logger?.warn("rlm-gitpixel: substitution engine not found — plugin is inert");
			return;
		}
		if (!this.engine.gitpixelAvailable()) {
			this.diag("rlm-gitpixel: gitpixel binary not on PATH — plugin is inert");
			this.ctx.logger?.warn("rlm-gitpixel: gitpixel binary not on PATH — plugin is inert");
			this.engine = null;
			return;
		}

		this.contributeFactory();
		this.contributePrompt();

		this.diag(`rlm-gitpixel: enforcing (cwd=${this.cwd})`);
		this.ctx.logger?.info(`rlm-gitpixel: enforcing (cwd=${this.cwd})`);
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
				if (svc?.registerFragment && this.engine) {
					handle = svc.registerFragment(PLUGIN_ID, {
						id: "gitpixel-contract",
						priority: 40,
						content: this.engine.promptFragment(this.engine.loadManifest(this.cwd)),
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
