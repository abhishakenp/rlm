/**
 * @rlm/context — persistent typed variable registry for agent working memory.
 *
 * The prime-agent philosophy: everything the AI has is a variable.
 * The user prompt is a const variable. Skills are variables. The system
 * prompt is a variable. The model config is a variable. Everything is
 * inspectable, transferable, and mutable (or immutable).
 *
 * 3 scopes:
 *   - project: survives all sessions, lives in .rlm/context.json
 *   - session: lives for one session, in session artifact dir
 *   - task:    lives for one subagent invocation, passed via rlm.spawn()
 *
 * const/let semantics:
 *   - const: immutable after creation (e.g. user.prompt, architecture decisions)
 *   - let:   mutable, can be updated (e.g. explored.files, current.task)
 *
 * Copy/move:
 *   - context.copy(["auth.*"]) → returns snapshot, variables STAY in this scope (default)
 *   - context.move(["auth.*"]) → returns snapshot AND deletes from this scope (explicit offload)
 *   - rlm.spawn("task", { context: ["auth.*"] }) → copies matching vars to child's task scope
 *   - Use move only when you're sure you won't need the context anymore
 *
 * The agent interacts via `context` in the code kernel:
 *   context.set("auth.files", [...], { type: "paths", let: true })
 *   context.get("auth.files")
 *   context.list("auth.*")
 *   context.copy(["auth.*"])  // snapshot for passing to subagent (non-destructive)
 *   context.move(["auth.*"])  // transfer to subagent, lose locally (destructive)
 *
 * Hot-reloadable: part of the Cordis plugin system.
 */
import { Service } from "@deepseek-ai/cordis";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { truncateToWidth as piTruncateToWidth, visibleWidth as piVisibleWidth } from "@earendil-works/pi-tui";

// ─── Elegant theme helpers (micro-plugin) ─────────────────────────────────────
// Lazily resolves the coding-agent Theme singleton (globalThis symbol or __rlmTheme).
// Falls back to raw ANSI when theme not initialized (headless tests) but prefers
// theme colors when available via (globalThis as any).__rlmTheme or Symbol-for key.
const THEME_SYMBOL = Symbol.for("@earendil-works/pi-coding-agent:theme");
type ThemeLike = {
	fg: (c: string, t: string) => string;
	bg: (c: string, t: string) => string;
	bold?: (t: string) => string;
	getSelectionBackgroundColor?: () => (t: string) => string;
};
function getRlmTheme(): ThemeLike | null {
	try {
		const g: any = globalThis as any;
		if (g.__rlmTheme && typeof g.__rlmTheme.fg === "function") return g.__rlmTheme as ThemeLike;
		const t = (globalThis as Record<symbol, any>)[THEME_SYMBOL];
		if (t && typeof t.fg === "function") return t as ThemeLike;
		// Also try __rlmTheme on symbol wrapper via globalThis accessor (proxy case)
		if (g.__piTheme && typeof g.__piTheme.fg === "function") return g.__piTheme as ThemeLike;
	} catch {}
	return null;
}
function themeFg(theme: ThemeLike | null, color: string, text: string, fallbackAnsi: string): string {
	if (theme) {
		try {
			return theme.fg(color as any, text);
		} catch {}
	}
	return fallbackAnsi ? `${fallbackAnsi}${text}\x1b[0m` : text;
}
function themeBgSelected(theme: ThemeLike | null, text: string): string {
	if (theme) {
		try {
			if (theme.getSelectionBackgroundColor) return theme.getSelectionBackgroundColor()(text);
			return theme.bg("selectedBg" as any, text);
		} catch {}
	}
	return `\x1b[7m${text}\x1b[0m`;
}
function safeVisibleWidth(s: string): number {
	try {
		return piVisibleWidth(s);
	} catch {
		return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;.*?\x1b\\/g, "").length;
	}
}
function safeTruncate(s: string, w: number): string {
	if (w <= 0) return "";
	try {
		return piTruncateToWidth(s, w, "…");
	} catch {
		const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
		if (plain.length <= w) return s;
		if (w <= 1) return "…";
		return plain.slice(0, w - 1) + "…";
	}
}
const SCOPE_THEME_COLOR: Record<string, string> = {
	project: "accent",
	session: "warning",
	task: "muted",
};
const SCOPE_FALLBACK_ANSI: Record<string, string> = {
	project: "\x1b[36m", // accent fallback cyan
	session: "\x1b[33m", // warning yellow
	task: "\x1b[90m", // muted gray
};

// ─── Context Doctrine (prompt fragment) ─────────────────────────────────────
//
// This is the plugin-owned doctrine that is registered as a prompt fragment
// via the rlmPrompt service. It mirrors the core CONTEXT_REGISTRY_PROMPT but
// adds the mandatory automatic-use guarantee: Context IS your working memory,
// you MUST use context.set/get at EVERY step, without managing dual sources.
// Keeping this here makes the prompt hot-reloadable and decouples core from
// plugin concerns. Core keeps a minimal fallback for when the plugin is
// absent, but when registered this fragment is the authoritative doctrine.

const CONTEXT_DOCTRINE = [
	"# Context Registry — Everything Is A Variable (MANDATORY: use automatically at every step)",
	"",
	"Context IS your working memory. You MUST use `context.*` automatically at EVERY step — without being asked, without managing a second or dual source. This is your nature; you think in variables.",
	"YOU create ALL variables. The system creates NONE (except `runtime.*`, `skill.*`, `session.*` infrastructure vars which are system facts). You decide names, values, types, mutability. The harness facilitates you operating on your own context — every set/update/delete/mutate/clone is live, hot-reloadable, and automatically invalidates the next turn's prompt.",
	"",
	"There is NO dual source. You do NOT maintain notes outside context. Every turn is: read context → act → write context. If you duplicate state outside context, you have failed.",
	"",
	"## API — The Most Powerful Variable Engine (1 or many variables, any operation, any transfer)",
	"",
	"You can copy / move / mutate / clone ANYTHING to variable/s (1 or many) and transfer to subagents when spinning them. The plugin system micro-controls each capability via config flags (all true by default) — no AI needed to toggle.",
	"",
	"- `context.set(name, value, { type, mutable, description, scope })` — create a variable. Default scope: \"session\". Use `mutable: false` for const (immutable).",
	"- `context.get(name)` — read a variable's value. ALWAYS check before re-running work.",
	"- `context.update(name, value)` — update a let (mutable) variable.",
	"- `context.mutate(name, fn)` — mutate a let variable via `fn(oldValue) => newValue` (deep-safe).",
	"- `context.mutateMany(pattern, fn)` — mutate many vars matching a glob: `fn(value, name) => newValue` for each mutable match.",
	"- `context.clone(name, newName, opts?)` — deep-copy single var to new name. `opts.transform?(value)=>newValue`, `opts.scope?` to place copy elsewhere.",
	"- `context.cloneMany(patterns, prefixOrTransform?)` — clone many at once. `cloneMany([\"auth.*\"], \"backup.\")` → `backup.auth.files`, etc. Or `cloneMany([\"auth.*\"], n=>\"backup.\"+n)`. Deep copy + optional transform.",
	"- `context.list(\"auth.*\")` — list variable names matching a glob pattern.",
	"- `context.copy([\"auth.*\"])` / `context.snapshot([\"auth.*\"])` — non-destructive snapshot (COPY) for passing to subagents. Vars STAY.",
	"- `context.move([\"auth.*\"])` — destructive transfer (you lose the variable, child gets it). Const project/session vars are copied not moved.",
	"- `context.delete(name)` — remove a variable.",
	"- `context.clear(scope, force?)` — clear a whole scope.",
	"- `context.batch(ops)` — atomic batch: `[{op:\"set\",name,value,opts},{op:\"mutate\",name,fn},{op:\"clone\",name,newName},...]` — one epoch bump.",
	"- `context.summarize()` — formatted summary of all variables.",
	"- `context.meta(name)` — full metadata for a variable.",
	"- `context.all()` — all variables.",
	"",
	"### Transfer to subagents — many vars as needed (powered by rlm-sdk harness)",
	"",
	"- COPY: `rlm.run(\"task\", { context: [\"auth.*\", \"db.*\"] })` — copies matching vars atomically to child's task scope (parent keeps them). Any number of patterns, any number of vars.",
	"- MOVE: `rlm.run(\"task\", { contextMove: [\"auth.*\"] })` or `contextStrategy:\"move\"` — destructive transfer (parent loses them).",
	"- Ad-hoc: `context.copy([...])` snapshot → pass manually, or `context.move([...])` then spawn.",
	"- Harness guarantees prompt auto-invalidation: after you mutate/clone/move, `rlmContext.getEpoch()` bumps and `rlm/prompt-changed` fires — next turn's system prompt already contains the new vars.",
	"",
	"### Micro-plugin flags (no AI needed — host toggles without you)",
	"",
	"- `enableClone` (default true) — gates clone/cloneMany.",
	"- `enableMutate` (default true) — gates mutate/mutateMany.",
	"- `enableBulkOps` (default true) — gates cloneMany/mutateMany/batch/copy-many.",
	"- `enableSubagentTransfer` (default true) — gates copy/move transfer to subagents.",
	"- Also UI flags: showContextPanel, coloredBars, perVariableExpand, etc. — all true by default.",
	"",
	"## Scopes",
	"",
	"- `project` — persists to .rlm/context.json, survives all sessions. Use for project facts.",
	"- `session` — persists for this session. Use for current task state, findings.",
	"- `task` — in-memory, passed from parent via `rlm.spawn(\"task\", { context: [\"auth.*\"] })`.",
	"",
	"## YOU Create Variables For Everything — The System Creates Nothing (except runtime.*)",
	"",
	"Everything that goes into your context is a variable. YOU create them with meaningful names.",
	"The system does NOT auto-create variables (except infrastructure `runtime.*`/`skill.*`/`session.*`). You think in terms of code and variables.",
	"",
	"1. At the START of your first turn, create variables for your runtime state:",
	"   - `context.set('runtime.model', '<your model>', { mutable: false, description: 'Current model' })`",
	"   - `context.set('runtime.tools', ['code'], { mutable: false, description: 'Available tools' })`",
	"   - `context.set('runtime.skills', [...], { mutable: false, description: 'Installed skills' })`",
	"   - `context.set('runtime.depth', <depth>, { mutable: false, description: 'Recursion depth' })`",
	"",
	"2. When you receive a user prompt, capture it:",
	"   - `context.set('user.prompt', '<the prompt>', { mutable: false, description: 'User request' })`",
	"",
	"3. After EVERY tool execution, IMMEDIATELY and AUTOMATICALLY store the result with a MEANINGFUL name you choose (no reminder needed):",
	"   - `context.set('files.packages', result, { description: 'Directories in packages/' })`",
	"   - `context.set('search.auth', grepResult, { description: 'Auth-related code found' })`",
	"   - `context.set('git.status', status, { description: 'Current git status' })`",
	"",
	"4. When you make a decision, store it:",
	"   - `context.set('decision.use-jwt', true, { type: 'decision', mutable: false, description: 'Decided to use JWT auth' })`",
	"",
	"5. When you discover project facts, store in project scope:",
	"   - `context.set('project.testCmd', 'bun test', { scope: 'project', description: 'Test command for this project' })`",
	"",
	"6. BEFORE re-running a command, ALWAYS check if a variable already has the result (automatic):",
	"   - `const prev = context.get('files.packages'); if (prev) { /* use it, do NOT re-run */ }`",
	"",
	"7. WHEN spawning a subagent, pass relevant context (1 or MANY vars):",
	"   - `rlm.spawn('task', { context: ['auth.*', 'project.*'] })` // copy many",
	"   - `rlm.run('task', { contextMove: ['auth.*'] })` // move (destructive)",
	"   - Need backup before transfer? `context.cloneMany(['auth.*'], 'backup.')` then spawn",
	"   - Need transform? `context.mutate('auth.files', v=>v.filter(x=>x.endsWith('.ts')))` then spawn",
	"",
	"## Naming — YOU Choose Meaningful Names",
	"",
	"Names must be meaningful and self-describing. Use namespace.name patterns:",
	"- `files.packages` — not `result1`",
	"- `search.auth-pattern` — not `grep_output`",
	"- `decision.use-jwt` — not `decision_1`",
	"- `project.testCmd` — not `info`",
	"",
	"## Example — You Create Variables For Everything (automatically, every turn)",
	"",
	"```js",
	"// First turn: capture runtime state",
	"context.set('runtime.model', 'omniroute/auto', { mutable: false });",
	"context.set('runtime.tools', ['code'], { mutable: false });",
	"",
	"// User asks: 'list packages'",
	"context.set('user.prompt', 'list packages', { mutable: false });",
	"const dirs = fs.readdirSync('./packages');",
	"context.set('files.packages', dirs, { description: 'Package directories' });",
	"",
	"// Follow-up: 'which ones start with rlm?'",
	"const prev = context.get('files.packages'); // reuse, don't re-run",
	"const rlmDirs = prev.filter(d => d.startsWith('rlm-'));",
	"context.set('files.rlm-packages', rlmDirs, { description: 'RLM package directories' });",
	"",
	"// Power operations: copy/move/mutate/clone many + transfer",
	"context.clone('files.packages', 'files.packages.bak'); // deep copy single",
	"context.cloneMany(['files.*'], 'backup.files.'); // backup many with prefix",
	"context.mutate('files.rlm-packages', v => [...v, 'rlm-new']); // mutate one",
	"context.mutateMany('files.*', v => Array.isArray(v) ? [...v].sort() : v); // mutate many",
	"// transfer 1 or many to subagent (copy vs move honors enableSubagentTransfer)",
	"await rlm.run('audit rlm packages', { context: ['files.*', 'backup.*'] }); // copy many",
	"await rlm.run('offload auth', { contextMove: ['auth.*'] }); // move (lose locally)",
	"```",
	"",
	"## Automatic Use — No Dual Source",
	"",
	"You do NOT maintain a second memory system. You do NOT keep notes outside context. You do NOT wait to be told to use context — you do it automatically at every step by default. Every turn is: read context → act → write context. This is your nature. Context IS your working memory, you MUST use context.set/get at EVERY step without managing dual sources. Harness auto-invalidates prompt so your mutations are visible next turn without you asking.",
].join("\n");

// ─── Types ───────────────────────────────────────────────────────────────────

export type ContextScope = "project" | "session" | "task";

export type ContextType =
	| "string"
	| "number"
	| "boolean"
	| "array"
	| "object"
	| "path"
	| "paths"
	| "pattern"
	| "decision"
	| "prompt"
	| "skill"
	| "model"
	| "tool"
	| "config";

export interface ContextVariable {
	name: string;
	value: any;
	/** false = const (immutable), true = let (mutable). */
	mutable: boolean;
	type: ContextType;
	description?: string;
	source: "user" | "agent" | "discovery" | "system";
	createdAt: number;
	updatedAt: number;
	scope: ContextScope;
	/** If true, this variable was moved from a parent scope. */
	transferred?: boolean;
}

export interface ContextSetOptions {
	/** false = const (immutable), true = let (mutable). Default: true unless type is "decision" or "prompt". */
	mutable?: boolean;
	type?: ContextType;
	description?: string;
	source?: "user" | "agent" | "discovery" | "system";
}

export interface ContextSnapshot {
	[name: string]: {
		value: any;
		mutable: boolean;
		type: ContextType;
		description?: string;
		source: "user" | "agent" | "discovery" | "system";
		createdAt: number;
		updatedAt: number;
		transferred?: boolean;
	};
}

// ─── Context Registry ────────────────────────────────────────────────────────

export type ResolvedRlmContextConfig = Required<Omit<RlmContextConfig, "projectRoot">> & { projectRoot?: string };

export class RlmContextService extends Service {
	static inject = [] as const;
	static provide = "rlmContext" as const;

	declare config: ResolvedRlmContextConfig;

	private projectVars: Map<string, ContextVariable> = new Map();
	private sessionVars: Map<string, ContextVariable> = new Map();
	private taskVars: Map<string, ContextVariable> = new Map();

	private projectRoot: string = process.cwd();
	private sessionDir: string | null = null;

	/** Epoch counter — increments on every mutation. Used for cache invalidation. */
	private _epoch: number = 0;
	getEpoch(): number { return this._epoch; }

	constructor(ctx: any, config: RlmContextConfig = {}) {
		super(ctx, undefined as any);
		const raw = typeof config === "object" && !Array.isArray(config) ? config : {} as RlmContextConfig;
		this.config = resolveRlmContextConfig(raw as RlmContextConfig);
		// Stash raw for backwards-compat propagation to tui single source
		;(this as any)._rawConfig = raw;
	}

	async [Service.init]() {
		this.projectRoot = this.config.projectRoot ?? process.cwd();
		this.loadProject();
		this.ctx.logger?.info(
			`rlm-context: ready (${this.projectVars.size} project vars loaded)`,
		);

		// Register TUI component — context variables rendered inline.
		// No slash command. The TUI renderer itself shows context as part
		// of its normal display. When this plugin is hot-swapped, the TUI
		// service disposes this component automatically.
		this.registerTuiExtensions();
		this.registerPromptFragment();
	}

	/** TUI extension handles — disposed on hot-swap. */
	private tuiHandles: any[] = [];

	/** Prompt fragment handle — disposed on hot-swap. */
	private promptHandle: any | null = null;
	private promptRetryTimer: ReturnType<typeof setTimeout> | null = null;

	private registerPromptFragment(): void {
		const getPromptSvc = (): any | undefined => {
			const fromGlobal = (globalThis as any).__rlmPrompt;
			if (fromGlobal) return fromGlobal;
			try {
				const fromCtx = (this.ctx as any).get?.("rlmPrompt");
				if (fromCtx) return fromCtx;
			} catch {}
			return undefined;
		};
		const promptSvc = getPromptSvc();
		if (!promptSvc) {
			// Prompt service not yet ready (context loads before prompt in cordis.yml).
			// Retry shortly; this also covers hot-reload ordering.
			if (this.promptRetryTimer) clearTimeout(this.promptRetryTimer);
			this.promptRetryTimer = setTimeout(() => {
				this.promptRetryTimer = null;
				if (this.promptHandle) return;
				this.registerPromptFragment();
			}, 400);
			// Also try to catch service registration via Cordis event if available.
			try {
				(this.ctx as any).once?.("internal/service", () => {
					if (!this.promptHandle) this.registerPromptFragment();
				});
			} catch {}
			return;
		}
		if (this.promptHandle) return;
		const content = () => CONTEXT_DOCTRINE;
		try {
			this.promptHandle = promptSvc.registerFragment("rlm-context", {
				id: "context-doctrine",
				priority: 100,
				content,
			});
			this.ctx.logger?.info("rlm-context: registered prompt fragment (context-doctrine, priority 100)");
		} catch (error) {
			this.ctx.logger?.warn(`rlm-context: failed to register prompt fragment: ${error instanceof Error ? error.message : error}`);
		}
	}

	private disposePromptFragment(): void {
		if (this.promptRetryTimer) {
			clearTimeout(this.promptRetryTimer);
			this.promptRetryTimer = null;
		}
		if (this.promptHandle) {
			try {
				this.promptHandle.dispose();
			} catch {}
			this.promptHandle = null;
		} else {
			// Ensure orphaned fragments from previous fiber are cleaned if service outlives us.
			try {
				const svc = (globalThis as any).__rlmPrompt ?? (this.ctx as any).get?.("rlmPrompt");
				svc?.disposePlugin?.("rlm-context");
			} catch {}
		}
	}

	private emitPromptChanged(reason: string): void {
		try {
			(this.ctx as any).emit("rlm/prompt-changed", {
				pluginId: "rlm-context",
				reason,
				epoch: this._epoch,
			});
		} catch {}
	}

	// ─── Elegant micro-plugin panel state (hot-reloadable) ────────────────────────
	private _panelState: {
		focusedIndex: number
		expandedSet: Set<string>
		scrollOffset: number
		followupQueue: string[]
		lastEnterAt: number
		globalExpanded: boolean
	} | null = null

	/**
	 * Max visible variables in scroll window (tunable).
	 * Virtualization: O(1) window — only this many vars are sliced and rendered
	 * per frame (slice(scrollOffset, scrollOffset+PANEL_MAX_VISIBLE)), so 50k vars
	 * still produces ~12-15 lines, not 50k. Hidden indicators show overflow.
	 * Must match ContextVariableGroupComponent EXPANDED_MAX for consistent UX.
	 */
	private readonly PANEL_MAX_VISIBLE = 10
	/** Double-enter window ms for followup send. */
	private readonly DOUBLE_ENTER_MS = 400

	/** Retrieve generic TUI service if available (extracted micro-plugins). */
	private getTui(): any {
		try { return (globalThis as any).__rlmTui } catch { return undefined }
	}

	/** Effective config — generic flags delegate to rlm-tui when available (single source after extraction). */
	private getEffectiveConfig(): ResolvedRlmContextConfig {
		const tui = this.getTui()
		if (!tui?.config) return this.config
		return {
			...this.config,
			followupQueueUi: tui.config.followupQueueUi ?? this.config.followupQueueUi,
			doubleEnterToSend: tui.config.doubleEnterToSend ?? this.config.doubleEnterToSend,
			autoFocusTyping: tui.config.autoFocusTyping ?? this.config.autoFocusTyping,
			hjklNavigation: tui.config.hjklNavigation ?? this.config.hjklNavigation,
		}
	}

	/** Effective followup queue — delegates to rlm-tui generic service when available. */
	private getEffectiveFollowupQueue(): string[] {
		const tui = this.getTui()
		if (tui?.getFollowupQueue) {
			try { return tui.getFollowupQueue() as string[] } catch {}
		}
		if (tui?.getQueue) {
			try { return tui.getQueue() as string[] } catch {}
		}
		return this._panelState ? [...this._panelState.followupQueue] : []
	}

	// ─── Chordis hot-reload config (micro-plugin flags + keybindings) ─────────
	/** Get resolved keybindings (defaults + overrides). Hot-reloadable via config patch. */
	getKeybindings(): Record<string, string> {
		return { ...(this.config.keybindings ?? DEFAULT_CONTEXT_KEYBINDINGS) }
	}
	/** Get a single keybinding. */
	getKeybinding(action: string): string | undefined {
		return this.getKeybindings()[action]
	}
	/** Update keybindings at runtime (chordis hot-reload). */
	updateKeybindings(patch: Record<string, string>): void {
		this.config.keybindings = { ...this.getKeybindings(), ...patch }
		try { (this.ctx as any).emit("rlm/context-keybindings-changed", { keybindings: this.config.keybindings }) } catch {}
	}
	/** Update context config flags at runtime (chordis hot-reload). Also syncs generic flags to tui if present. */
	updateConfig(patch: Partial<RlmContextConfig>): void {
		this.config = resolveRlmContextConfig({ ...this.config, ...patch } as any)
		// Sync generic flags to tui single source when tui available
		const tui = this.getTui()
		if (tui?.updateConfig) {
			const genericPatch: any = {}
			if (patch.followupQueueUi !== undefined) genericPatch.followupQueueUi = patch.followupQueueUi
			if (patch.doubleEnterToSend !== undefined) genericPatch.doubleEnterToSend = patch.doubleEnterToSend
			if (patch.autoFocusTyping !== undefined) genericPatch.autoFocusTyping = patch.autoFocusTyping
			if (patch.hjklNavigation !== undefined) genericPatch.hjklNavigation = patch.hjklNavigation
			if (Object.keys(genericPatch).length) {
				try { tui.updateConfig(genericPatch) } catch {}
			}
		}
		try { (this.ctx as any).emit("rlm/context-config-changed", { config: this.config }) } catch {}
	}

	/** Public accessor for tests / TUI integration — returns live panel state. */
	getPanelState(): { focusedIndex: number; expandedSet: Set<string>; scrollOffset: number; followupQueue: string[]; globalExpanded: boolean } | null {
		if (!this._panelState) return null
		// Surface effective queue when tui is the source of truth (delegated)
		const tui = this.getTui()
		const effectiveQueue = tui?.getFollowupQueue ? (() => { try { return tui.getFollowupQueue() as string[] } catch { return [...this._panelState!.followupQueue] } })() : [...this._panelState.followupQueue]
		return {
			focusedIndex: this._panelState.focusedIndex,
			expandedSet: new Set(this._panelState.expandedSet),
			scrollOffset: this._panelState.scrollOffset,
			followupQueue: effectiveQueue,
			globalExpanded: this._panelState.globalExpanded,
		}
	}

	/** Focus helpers — micro-plugin navigable. */
	panelFocusNext(): void { this._panelMoveFocus(1) }
	panelFocusPrev(): void { this._panelMoveFocus(-1) }
	private _panelMoveFocus(delta: number): void {
		const st = this._panelState
		if (!st) return
		const all = this.getAll().sort((a, b) => a.name.localeCompare(b.name))
		if (all.length === 0) { st.focusedIndex = -1; return }
		if (st.focusedIndex === -1) st.focusedIndex = delta > 0 ? 0 : all.length - 1
		else st.focusedIndex = Math.max(0, Math.min(all.length - 1, st.focusedIndex + delta))
		this._panelEnsureVisible()
	}
	panelSetFocused(index: number): void {
		const st = this._panelState
		if (!st) return
		const all = this.getAll()
		if (all.length === 0) { st.focusedIndex = -1; return }
		st.focusedIndex = Math.max(-1, Math.min(all.length - 1, index))
		this._panelEnsureVisible()
	}
	private _panelEnsureVisible(): void {
		const st = this._panelState
		if (!st || !this.config.scrollablePanel) return
		const total = this.getAll().length
		const max = this.PANEL_MAX_VISIBLE
		if (total <= max) { st.scrollOffset = 0; return }
		const maxOffset = Math.max(0, total - max)
		st.scrollOffset = Math.min(st.scrollOffset, maxOffset)
		st.scrollOffset = Math.max(0, st.scrollOffset)
		if (st.focusedIndex < 0) return
		if (st.focusedIndex < st.scrollOffset) st.scrollOffset = st.focusedIndex
		else if (st.focusedIndex >= st.scrollOffset + max) st.scrollOffset = st.focusedIndex - max + 1
	}

	/** Toggle focused variable (per-variable expand). */
	panelToggleFocused(): boolean {
		const st = this._panelState
		if (!st) return false
		if (!this.config.perVariableExpand) {
			st.globalExpanded = !st.globalExpanded
			return st.globalExpanded
		}
		const all = this.getAll().sort((a, b) => a.name.localeCompare(b.name))
		if (st.focusedIndex < 0 || st.focusedIndex >= all.length) return false
		const name = all[st.focusedIndex].name
		if (st.expandedSet.has(name)) st.expandedSet.delete(name)
		else st.expandedSet.add(name)
		return st.expandedSet.has(name)
	}

	/** Toggle a specific variable by name (per-variable expand). */
	panelToggleVariable(name: string): boolean {
		const st = this._panelState
		if (!st || !this.config.perVariableExpand) return false
		if (st.expandedSet.has(name)) st.expandedSet.delete(name)
		else st.expandedSet.add(name)
		return st.expandedSet.has(name)
	}

	/** Followup queue micro-plugin — delegates to generic rlm-tui service when available. */
	panelEnqueueFollowup(text: string): void {
		const tui = this.getTui()
		if (tui?.enqueueFollowup) { try { tui.enqueueFollowup(text); return } catch {} }
		if (tui?.enqueue) { try { tui.enqueue(text); return } catch {} }
		const st = this._panelState
		if (!st) return
		const trimmed = text.trim()
		if (!trimmed) return
		st.followupQueue.push(trimmed)
		try { (this.ctx as any).emit("rlm/context-followup-enqueued", { text: trimmed, queueLength: st.followupQueue.length }) } catch {}
		try { (this.ctx as any).emit("rlm/followup-enqueued", { text: trimmed, queueLength: st.followupQueue.length }) } catch {}
	}
	panelClearFollowupQueue(): string[] {
		const tui = this.getTui()
		if (tui?.clearFollowupQueue) { try { return tui.clearFollowupQueue() as string[] } catch {} }
		if (tui?.clear) { try { return tui.clear() as string[] } catch {} }
		const st = this._panelState
		if (!st) return []
		const q = [...st.followupQueue]
		st.followupQueue.length = 0
		try { (this.ctx as any).emit("rlm/context-followup-sent", { count: q.length }) } catch {}
		try { (this.ctx as any).emit("rlm/followup-sent", { count: q.length }) } catch {}
		return q
	}
	panelGetFollowupQueue(): string[] {
		const tui = this.getTui()
		if (tui?.getFollowupQueue) { try { return [...tui.getFollowupQueue()] } catch {} }
		if (tui?.getQueue) { try { return [...tui.getQueue()] } catch {} }
		return this._panelState ? [...this._panelState.followupQueue] : []
	}

	/** Subscribe to double-enter followup-send. Returns disposer. Chordis hot-reloadable. Delegates to tui if present. */
	panelOnFollowupSend(cb: (payload: { texts: string[] }) => void): () => void {
		const tui = this.getTui()
		if (tui?.onFollowupSend) { try { return tui.onFollowupSend(cb) } catch {} }
		const handler = (payload: any) => cb(payload as { texts: string[] })
		try { (this.ctx as any).on("rlm/followup-send", handler) } catch {}
		return () => { try { (this.ctx as any).off?.("rlm/followup-send", handler) } catch {} }
	}

	/** Alias for panelOnFollowupSend — for registerTuiExtensions helper. */
	onFollowupSend(cb: (payload: { texts: string[] }) => void): () => void {
		return this.panelOnFollowupSend(cb)
	}

	/** Whether the panel has focus (focusedIndex !== -1). */
	get isFocused(): boolean {
		return this._panelState !== null && this._panelState.focusedIndex !== -1
	}

	/** Alias for isFocused getter — for callers that prefer a method. */
	panelIsFocused(): boolean {
		return this.isFocused
	}

	/**
	 * Map a rendered line index (from panelRenderer) to a variable and toggle it.
	 * Handles hiddenAbove/hiddenBelow indicators, expanded content lines, separators,
	 * and description lines. Clicking on the main line or any expanded-content line
	 * within a variable's block toggles that variable. Returns true if handled.
	 */
	panelHandleClick(y: number, width?: number): boolean {
		const st = this._panelState
		if (!st) return false
		if (!this.config.showContextPanel) return false
		// Normalize y
		if (typeof y !== "number" || !Number.isFinite(y) || y < 0) return false
		const all = this.getAll().sort((a, b) => a.name.localeCompare(b.name))
		if (all.length === 0) return false
		// Keep scrollOffset in bounds (mirrors panelRenderer)
		if (this.config.scrollablePanel) {
			const maxOffset = Math.max(0, all.length - this.PANEL_MAX_VISIBLE)
			st.scrollOffset = Math.min(st.scrollOffset, maxOffset)
			st.scrollOffset = Math.max(0, st.scrollOffset)
			if (st.focusedIndex >= 0) this._panelEnsureVisible()
		}
		let visibleVars: typeof all
		let hiddenAbove = 0
		let hiddenBelow = 0
		if (this.config.scrollablePanel && all.length > this.PANEL_MAX_VISIBLE) {
			visibleVars = all.slice(st.scrollOffset, st.scrollOffset + this.PANEL_MAX_VISIBLE)
			hiddenAbove = st.scrollOffset
			hiddenBelow = all.length - (st.scrollOffset + visibleVars.length)
		} else {
			visibleVars = all
		}
		void width
		let curY = 0
		if (hiddenAbove > 0) {
			if (y === curY) return false
			curY += 1
		}
		for (let i = 0; i < visibleVars.length; i++) {
			const v = visibleVars[i]
			const mainLineY = curY
			if (y === mainLineY) {
				const globalIdx = all.indexOf(v)
				st.focusedIndex = globalIdx
				this._panelEnsureVisible()
				if (this.config.perVariableExpand) {
					this.panelToggleVariable(v.name)
				} else {
					st.globalExpanded = !st.globalExpanded
				}
				return true
			}
			curY += 1
			const isExpanded = this.config.perVariableExpand ? st.expandedSet.has(v.name) : st.globalExpanded
			if (isExpanded) {
				const fullValueStr = formatValueDetailed(v.value)
				const valueLines = String(fullValueStr).split("\n")
				const maxLines = 6
				const valLinesCount = Math.min(valueLines.length, maxLines)
				const hasOverflow = valueLines.length > maxLines
				const hasDesc = !!v.description
				const hasSep = i < visibleVars.length - 1
				const blockLines = valLinesCount + (hasOverflow ? 1 : 0) + (hasDesc ? 1 : 0) + (hasSep ? 1 : 0)
				if (y > mainLineY && y < mainLineY + 1 + blockLines) {
					const globalIdx = all.indexOf(v)
					st.focusedIndex = globalIdx
					this._panelEnsureVisible()
					if (this.config.perVariableExpand) {
						this.panelToggleVariable(v.name)
					} else {
						st.globalExpanded = !st.globalExpanded
					}
					return true
				}
				curY += blockLines
			}
		}
		if (hiddenBelow > 0) {
			if (y === curY) return false
			curY += 1
		}
		// followup queue / hints are non-variable lines — not handled
		return false
	}

	/**
	 * Handle a key for the panel — returns true if handled.
	 * Supports: hjkl + arrows navigation, h/l as collapse/expand, enter to expand/collapse,
	 * double-enter to send queue, auto-focus typing, tab cycling, scroll, ctrl+o toggle all.
	 */
	panelHandleKey(key: string): boolean {
		const st = this._panelState
		if (!st) return false
		const tui: any = this.getTui()
		const cfg = this.getEffectiveConfig()
		const all = this.getAll().sort((a, b) => a.name.localeCompare(b.name))
		const keyLower = key.toLowerCase()

		// Vertical navigation: ArrowUp/Down always, k/j delegated to tui.isNavKey when available
		if (keyLower === "arrowup") {
			this._panelMoveFocus(-1)
			return true
		}
		if (keyLower === "arrowdown") {
			this._panelMoveFocus(1)
			return true
		}
		// hjkl k/j — generic nav micro-plugin, delegated to tui
		const isK = (() => {
			if (tui?.isNavKey) { try { return !!tui.isNavKey(key, "up") && keyLower === "k" } catch {} }
			return !!cfg.hjklNavigation && keyLower === "k"
		})()
		if (isK) {
			this._panelMoveFocus(-1)
			return true
		}
		const isJ = (() => {
			if (tui?.isNavKey) { try { return !!tui.isNavKey(key, "down") && keyLower === "j" } catch {} }
			return !!cfg.hjklNavigation && keyLower === "j"
		})()
		if (isJ) {
			this._panelMoveFocus(1)
			return true
		}

		// Horizontal collapse/expand: ArrowLeft/Right always, h/l delegated to tui
		const hasFocus = st.focusedIndex >= 0 && st.focusedIndex < all.length
		const focusedName = hasFocus ? all[st.focusedIndex].name : null
		const handleCollapse = (): boolean => {
			if (!hasFocus || !focusedName) return false
			if (cfg.perVariableExpand) {
				if (st.expandedSet.has(focusedName)) st.expandedSet.delete(focusedName)
				return true
			}
			st.globalExpanded = false
			return true
		}
		const handleExpand = (): boolean => {
			if (!hasFocus || !focusedName) return false
			if (cfg.perVariableExpand) {
				if (!st.expandedSet.has(focusedName)) st.expandedSet.add(focusedName)
				return true
			}
			st.globalExpanded = true
			return true
		}
		if (keyLower === "arrowleft") {
			if (hasFocus) return handleCollapse()
			this._panelMoveFocus(-1)
			return true
		}
		if (keyLower === "arrowright") {
			if (hasFocus) return handleExpand()
			this._panelMoveFocus(1)
			return true
		}
		const isH = (() => {
			if (tui?.isNavKey) { try { return !!tui.isNavKey(key, "left") && keyLower === "h" } catch {} }
			return !!cfg.hjklNavigation && keyLower === "h"
		})()
		if (isH) {
			if (hasFocus) return handleCollapse()
			return false
		}
		const isL = (() => {
			if (tui?.isNavKey) { try { return !!tui.isNavKey(key, "right") && keyLower === "l" } catch {} }
			return !!cfg.hjklNavigation && keyLower === "l"
		})()
		if (isL) {
			if (hasFocus) return handleExpand()
			return false
		}
		const isPrintable = key.length === 1 && key >= " " && key <= "~"
		// autoFocus typing: delegate to tui.autoFocusShouldFocus when available
		const shouldAutoFocus = (() => {
			if (tui?.autoFocusShouldFocus) { try { return !!tui.autoFocusShouldFocus(key) } catch {} }
			return !!cfg.autoFocusTyping && isPrintable
		})()
		if (shouldAutoFocus && st.focusedIndex === -1 && all.length > 0) {
			st.focusedIndex = 0
			this._panelEnsureVisible()
			return false // let editor handle typing
		}
		// Tab / shift+tab focus cycling
		if (keyLower === "tab" || keyLower === "shift+tab") {
			this._panelMoveFocus(keyLower === "shift+tab" ? -1 : 1)
			return true
		}
		// Enter / expansion
		if (keyLower === "enter") {
			// Delegate double-enter followup to tui when available
			if (tui?.handleFollowupKey) {
				try {
					const handled = !!tui.handleFollowupKey(key)
					if (handled) return true
					// first Enter was recorded in tui; fall through to expand
				} catch {}
			} else {
				const now = Date.now()
				const effectiveQueueLen = this.getEffectiveFollowupQueue().length
				if (cfg.doubleEnterToSend && cfg.followupQueueUi && effectiveQueueLen > 0) {
					if (now - st.lastEnterAt < this.DOUBLE_ENTER_MS) {
						const cleared = this.panelClearFollowupQueue()
						st.lastEnterAt = 0
						try { (this.ctx as any).emit("rlm/followup-send", { texts: cleared }) } catch {}
						return true
					}
					st.lastEnterAt = now
				} else {
					st.lastEnterAt = now
				}
			}
			if (cfg.perVariableExpand) {
				if (st.focusedIndex >= 0) {
					this.panelToggleFocused()
					return true
				}
				// no focus -> no-op but handled
				return true
			} else {
				st.globalExpanded = !st.globalExpanded
				return true
			}
		}
		// Ctrl+O toggle all (legacy global)
		if (keyLower === "ctrl+o") {
			if (cfg.perVariableExpand) {
				// toggle all: if any collapsed, expand all; else collapse all
				const allNames = all.map(v => v.name)
				const allExpanded = allNames.every(n => st.expandedSet.has(n))
				if (allExpanded) st.expandedSet.clear()
				else for (const n of allNames) st.expandedSet.add(n)
			} else {
				st.globalExpanded = !st.globalExpanded
			}
			return true
		}
		// Scroll keys
		if (cfg.scrollablePanel) {
			if (keyLower === "pageup" || keyLower === "ctrl+u") {
				st.scrollOffset = Math.max(0, st.scrollOffset - this.PANEL_MAX_VISIBLE)
				return true
			}
			if (keyLower === "pagedown" || keyLower === "ctrl+d") {
				const maxOffset = Math.max(0, all.length - this.PANEL_MAX_VISIBLE)
				st.scrollOffset = Math.min(maxOffset, st.scrollOffset + this.PANEL_MAX_VISIBLE)
				return true
			}
		}
		return false
	}

	/**
	 * Renderer helper — builds elegant lines with colored bars per variable. Exposed for testing.
	 *
	 * Virtualization: O(1) window — uses slice(scrollOffset, scrollOffset+PANEL_MAX_VISIBLE)
	 * so render cost is constant regardless of total var count (50k → ~10 rendered + 2 indicators).
	 * Does NOT iterate all 50k lines each frame. Performance is O(N log N) for the sort
	 * but O(1) for rendering; sort is cheap for 50k strings (~tens of ms) and could be
	 * further cached if needed. VisibleWidth/truncateToWidth enforced via safeVisibleWidth/
	 * safeTruncate + ensureWidth on every line so output never exceeds `width`. Theme colors
	 * via getRlmTheme()/themeFg()/themeBgSelected remain correct in both headless (ANSI fallback)
	 * and themed (elegant bars ▎, dim/muted/accent) modes.
	 *
	 * Context mutation collapses transcript: `mutate` updates the same var in place
	 * (no new entry), so 50k `mutate` turns on one name still shows 1 line, with
	 * expanded view showing the latest mutated value.
	 */
	panelRenderer(opts?: { width?: number; cwd?: string; expanded?: boolean }): string[] | null {
		const cfg = this.getEffectiveConfig()
		if (!cfg.showContextPanel) return null
		const st = this._panelState
		if (!st) return null
		const width = opts?.width ?? 80
		if (opts?.expanded !== undefined && !cfg.perVariableExpand) {
			st.globalExpanded = opts.expanded
		}
		const all = this.getAll().sort((a, b) => a.name.localeCompare(b.name))
		const effectiveQueue = this.getEffectiveFollowupQueue()
		if (all.length === 0) {
			if (cfg.followupQueueUi && effectiveQueue.length > 0) {
			} else {
				return null
			}
		}
		if (cfg.scrollablePanel) {
			const maxOffset = Math.max(0, all.length - this.PANEL_MAX_VISIBLE)
			st.scrollOffset = Math.min(st.scrollOffset, maxOffset)
			st.scrollOffset = Math.max(0, st.scrollOffset)
			if (st.focusedIndex >= 0) this._panelEnsureVisible()
		}
		// ── O(1) virtualization window: only PANEL_MAX_VISIBLE vars are materialized ──
		// slice(scrollOffset, scrollOffset+10) is O(1) regardless of total N (50k → 10).
		// Hidden counts drive the ↑/↓ indicators. No O(N) line loop over all vars.
		let visibleVars: ContextVariable[]
		let hiddenAbove = 0
		let hiddenBelow = 0
		if (cfg.scrollablePanel && all.length > this.PANEL_MAX_VISIBLE) {
			visibleVars = all.slice(st.scrollOffset, st.scrollOffset + this.PANEL_MAX_VISIBLE)
			hiddenAbove = st.scrollOffset
			hiddenBelow = all.length - (st.scrollOffset + visibleVars.length)
		} else {
			visibleVars = all
		}
		// ── Elegant theme-aware helpers (box drawing + proper truncate) ──
		// Every line is bounded to `width` via visibleWidth checks + truncateToWidth
		// (safeVisibleWidth/safeTruncate wrappers) and ensureWidth. Theme colors
		// remain correct: coloredBars + getRlmTheme() → fg/accent/warning/muted,
		// with ANSI fallbacks when theme absent (headless tests).
		const theme = getRlmTheme()
		const useTheme = cfg.coloredBars && !!theme
		const BLOCK = "▓"
		const BLOCK_GAP = "░"
		const VERT = "│"
		const barFor = (scope: string): string => {
			if (!cfg.coloredBars) return BLOCK_GAP
			const tColor = SCOPE_THEME_COLOR[scope] ?? "border"
			const fallback = SCOPE_FALLBACK_ANSI[scope] ?? "\x1b[32m"
			if (useTheme) {
				try { return (theme as any).fg(tColor, BLOCK) } catch {}
			}
			return `${fallback}${BLOCK}\x1b[0m`
		}
		const scopeBadge = (scope: string): string => {
			if (!cfg.coloredBars) return scope
			const tColor = SCOPE_THEME_COLOR[scope] ?? "border"
			const fallback = SCOPE_FALLBACK_ANSI[scope] ?? "\x1b[32m"
			if (useTheme) {
				try { return (theme as any).fg(tColor, scope) } catch {}
			}
			return `${fallback}${scope}\x1b[0m`
		}
		const dim = (t: string): string => {
			if (!cfg.coloredBars) return t
			return themeFg(theme, "dim", t, "\x1b[2m")
		}
		const muted = (t: string): string => {
			if (!cfg.coloredBars) return t
			return themeFg(theme, "muted", t, "\x1b[90m")
		}
		const accent = (t: string): string => {
			if (!cfg.coloredBars) return t
			return themeFg(theme, "accent", t, "\x1b[36m")
		}
		const success = (t: string): string => {
			if (!cfg.coloredBars) return t
			return themeFg(theme, "success", t, "\x1b[32m")
		}
		const warning = (t: string): string => {
			if (!cfg.coloredBars) return t
			return themeFg(theme, "warning", t, "\x1b[33m")
		}
		const truncate = (s: string, w: number): string => safeTruncate(s, w)
		const ensureWidth = (line: string, maxW: number): string => {
			if (safeVisibleWidth(line) <= maxW) return line
			return safeTruncate(line, maxW)
		}
		const lines: string[] = []
		if (hiddenAbove > 0) {
			lines.push(ensureWidth(cfg.coloredBars ? dim(`  ↑ ${hiddenAbove} more above`) : `  ↑ ${hiddenAbove} more above`, width))
		}
		for (let i = 0; i < visibleVars.length; i++) {
			const v = visibleVars[i]
			const globalIdx = cfg.scrollablePanel && all.length > this.PANEL_MAX_VISIBLE ? st.scrollOffset + i : all.indexOf(v)
			const isFocused = globalIdx === st.focusedIndex
			const isExpanded = cfg.perVariableExpand ? st.expandedSet.has(v.name) : st.globalExpanded
			const bar = barFor(v.scope)
			const kind = v.mutable ? "let" : "const"
			const kindStyled = v.mutable ? success(kind) : dim(kind)
			const nameStyled = (() => {
				if (!cfg.coloredBars) return v.name
				if (useTheme) {
					try {
						const t: any = theme
						if (t.bold) {
							const fgText = t.fg("text" as any, v.name)
							const plainCheck = `\x1b[39m${v.name}\x1b[39m`
							if (fgText !== plainCheck) return t.bold(fgText)
							return t.bold(v.name)
						}
						return t.fg("text" as any, v.name)
					} catch {}
				}
				return `\x1b[1m${v.name}\x1b[0m`
			})()
			let mainLine: string
			if (!isExpanded) {
				const maxValWidth = Math.max(10, width - v.name.length - kind.length - 8)
				const valPreview = truncate(formatValueCompact(v.value), maxValWidth)
				const valStyled = muted(valPreview)
				const eq = dim("=")
				mainLine = `${bar} ${kindStyled} ${nameStyled} ${eq} ${valStyled}`
			} else {
				const typeBadge = dim(`[${v.type}]`)
				const badge = scopeBadge(v.scope)
				mainLine = `${bar} ${kindStyled} ${nameStyled} ${typeBadge} ${badge}`
			}
			if (isFocused) {
				const arrow = cfg.coloredBars ? accent("▶ ") : "▶ "
				mainLine = themeBgSelected(theme, `${arrow}${mainLine}`)
			}
			mainLine = ensureWidth(mainLine, width)
			// Gap line between blocks for visual separation
			lines.push(dim("  " + "─".repeat(Math.min(width - 4, 12))))
			lines.push(mainLine)
			if (isExpanded) {
				const fullValueStr = formatValueDetailed(v.value)
				const valueLines = String(fullValueStr).split("\n")
				const maxLines = 6
				for (let vi = 0; vi < Math.min(valueLines.length, maxLines); vi++) {
					const vl = truncate(valueLines[vi], Math.max(10, width - 4))
					const cont = cfg.coloredBars ? `${dim(` ${VERT}`)} ${muted(vl)}` : `  ${VERT} ${vl}`
					lines.push(ensureWidth(cont, width))
				}
				if (valueLines.length > maxLines) {
					lines.push(ensureWidth(dim(`   … +${valueLines.length - maxLines} more lines`), width))
				}
				if (v.description) {
					const desc = truncate(v.description, Math.max(10, width - 4))
					lines.push(ensureWidth(dim(`   ${desc}`), width))
				}
				if (i < visibleVars.length - 1) {
					const sep = dim("─".repeat(Math.min(width - 2, 16)))
					lines.push(ensureWidth(`  ${sep}`, width))
				}
			}
		}
		if (hiddenBelow > 0) {
			lines.push(ensureWidth(cfg.coloredBars ? dim(`  ↓ ${hiddenBelow} more below`) : `  ↓ ${hiddenBelow} more below`, width))
		}
		if (cfg.followupQueueUi && effectiveQueue.length > 0) {
			lines.push("")
			lines.push(ensureWidth(cfg.coloredBars ? warning(`  followup queue (${effectiveQueue.length}):`) : `  followup queue (${effectiveQueue.length}):`, width))
			const recent = effectiveQueue.slice(-3)
			for (const q of recent) {
				const tq = truncate(q, Math.max(10, width - 6))
				lines.push(ensureWidth(cfg.coloredBars ? `    ${dim(tq)}` : `    ${tq}`, width))
			}
			if (cfg.doubleEnterToSend) {
				lines.push(ensureWidth(cfg.coloredBars ? dim("  press Enter twice to send immediately") : "  press Enter twice to send immediately", width))
			}
		}
		if (cfg.autoFocusTyping && all.length > 0 && st.focusedIndex === -1) {
			const hint = cfg.hjklNavigation
				? "hjkl/arrows: navigate • enter: expand • type to auto-focus"
				: "arrows: navigate • enter: expand"
			lines.push(ensureWidth(cfg.coloredBars ? dim(`  ${hint}`) : `  ${hint}`, width))
		}
		return lines.length > 0 ? lines : null
	}

	private registerTuiExtensions(): void {
		const tui = (globalThis as any).__rlmTui;
		if (!tui) return;
		// Backwards-compat: if context was configured with generic flags (pre-extraction), propagate to tui single source
		try {
			const raw = (this as any)._rawConfig as RlmContextConfig | undefined
			if (raw && tui.updateConfig) {
				const patch: any = {}
				if (raw.followupQueueUi !== undefined) patch.followupQueueUi = raw.followupQueueUi
				if (raw.doubleEnterToSend !== undefined) patch.doubleEnterToSend = raw.doubleEnterToSend
				if (raw.autoFocusTyping !== undefined) patch.autoFocusTyping = raw.autoFocusTyping
				if (raw.hjklNavigation !== undefined) patch.hjklNavigation = raw.hjklNavigation
				if (Object.keys(patch).length) {
					try { tui.updateConfig(patch) } catch {}
				}
			}
		} catch {}
		const cfg = this.config

		// Initialize panel state (hot-reloadable — preserved across re-register if already exists)
		if (!this._panelState) {
			this._panelState = {
				focusedIndex: -1,
				expandedSet: new Set<string>(),
				scrollOffset: 0,
				followupQueue: [],
				lastEnterAt: 0,
				globalExpanded: false,
			}
		}
		const st = this._panelState!

		// Cached names for status bar (ultra-lightweight)
		let cachedNames: string[] | null = null
		let cacheEpoch = -1
		const getVarNames = (): string[] => {
			const epoch = this.getEpoch?.() ?? 0
			if (cachedNames === null || epoch !== cacheEpoch) {
				cachedNames = this.getAll().map((v) => v.name).sort()
				cacheEpoch = epoch
			}
			return cachedNames
		}

		// Elegant component renderer — delegates to panelRenderer for testability
		const renderer = (opts?: { width?: number; cwd?: string; expanded?: boolean; width2?: number }): string[] | null => {
			// For backward compat, map TuiRenderContext (width,cwd) to panelRenderer opts
			const width = (opts as any)?.width ?? 80
			const expanded = (opts as any)?.expanded
			return this.panelRenderer({ width, expanded } as any)
		}

		// Extended component handle — includes micro-plugin handlers (chordis hot-reloadable)
		const componentExt: any = {
			id: "context-panel",
			renderer,
			// Legacy global toggle (used when perVariableExpand==false)
			toggle: () => {
				if (!cfg.perVariableExpand) {
					st.globalExpanded = !st.globalExpanded
					return st.globalExpanded
				}
				// per-variable: toggle focused var, or if none focused toggle all
				if (st.focusedIndex >= 0) return this.panelToggleFocused()
				const all = this.getAll().sort((a, b) => a.name.localeCompare(b.name))
				if (all.length === 0) return false
				// no focus -> focus first and toggle it
				st.focusedIndex = 0
				return this.panelToggleFocused()
			},
			isExpanded: () => cfg.perVariableExpand ? st.expandedSet.size > 0 : st.globalExpanded,
			// Micro-plugin navigation handlers (hjkl/arrows, scroll)
			focusNext: () => this.panelFocusNext(),
			focusPrev: () => this.panelFocusPrev(),
			setFocused: (idx: number) => this.panelSetFocused(idx),
			toggleFocused: () => this.panelToggleFocused(),
			toggleVariable: (name: string) => this.panelToggleVariable(name),
			handleKey: (key: string) => this.panelHandleKey(key),
			handleClick: (y: number, width?: number) => this.panelHandleClick(y, width),
			isFocused: () => this.isFocused,
			panelIsFocused: () => this.panelIsFocused(),
			getState: () => this.getPanelState(),
			expandSet: st.expandedSet,
			// followup queue micro-plugin
			enqueueFollowup: (text: string) => this.panelEnqueueFollowup(text),
			clearFollowup: () => this.panelClearFollowupQueue(),
			getFollowupQueue: () => this.panelGetFollowupQueue(),
			onFollowupSend: (cb: (payload: { texts: string[] }) => void) => this.panelOnFollowupSend(cb),
			panelOnFollowupSend: (cb: (payload: { texts: string[] }) => void) => this.panelOnFollowupSend(cb),
			// scroll
			getScrollOffset: () => st.scrollOffset,
			setScrollOffset: (off: number) => { st.scrollOffset = Math.max(0, off); return st.scrollOffset },
		}

		const componentHandle = tui.registerComponent("rlm-context", componentExt);
		if (componentHandle) this.tuiHandles.push(componentHandle);

		// Register a status bar item — context var count (ultra-compact).
		// Shows compact `ctx:${count}` not a list, so 50k vars still renders one short token.
		// Count is epoch-cached via getVarNames() — O(1) when epoch unchanged.
		const statusHandle = tui.registerStatusBarItem("rlm-context", {
			id: "context-vars-count",
			renderer: () => {
				const count = getVarNames().length;
				return count > 0 ? `ctx:${count}` : null;
			},
		});
		if (statusHandle) this.tuiHandles.push(statusHandle);

		this.ctx.logger?.info("rlm-context: registered TUI context panel (elegant micro-plugins: coloredBars, perVariableExpand, hjkl, scroll, followupQueue)");
	}

	/** Dispose TUI extensions — called on hot-swap. */
	private disposeTuiExtensions(): void {
		for (const handle of this.tuiHandles) {
			try { handle.dispose(); } catch {}
		}
		this.tuiHandles = [];
	}

	// ─── Project scope ────────────────────────────────────────────────────────

	setProjectRoot(root: string): void {
		this.projectRoot = root;
		this.loadProject();
	}

	private loadProject(): void {
		const file = this.getProjectContextFile();
		if (!existsSync(file)) return;
		try {
			const data = JSON.parse(readFileSync(file, "utf8"));
			for (const [name, v] of Object.entries(data)) {
				const snap = v as any;
				this.projectVars.set(name, {
					name,
					value: snap.value,
					mutable: snap.mutable ?? true,
					type: snap.type ?? "object",
					description: snap.description,
					source: snap.source ?? "agent",
					createdAt: snap.createdAt ?? Date.now(),
					updatedAt: snap.updatedAt ?? Date.now(),
					scope: "project",
				});
			}
		} catch (error) {
			this.ctx.logger?.warn(
				`rlm-context: failed to load project context: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	saveProject(): void {
		const file = this.getProjectContextFile();
		const dir = dirname(file);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const snapshot: ContextSnapshot = {};
		for (const [name, v] of this.projectVars) {
			snapshot[name] = toSnapshotEntry(v);
		}
		writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
	}

	private getProjectContextFile(): string {
		return join(this.projectRoot, ".rlm", "context.json");
	}

	// ─── Session scope ────────────────────────────────────────────────────────

	setSessionDir(dir: string): void {
		this.sessionDir = dir;
		this.loadSession();
	}

	private loadSession(): void {
		if (!this.sessionDir) return;
		const file = join(this.sessionDir, "context.json");
		if (!existsSync(file)) return;
		try {
			const data = JSON.parse(readFileSync(file, "utf8"));
			for (const [name, v] of Object.entries(data)) {
				const snap = v as any;
				this.sessionVars.set(name, {
					name,
					value: snap.value,
					mutable: snap.mutable ?? true,
					type: snap.type ?? "object",
					description: snap.description,
					source: snap.source ?? "agent",
					createdAt: snap.createdAt ?? Date.now(),
					updatedAt: snap.updatedAt ?? Date.now(),
					scope: "session",
				});
			}
		} catch (error) {
			this.ctx.logger?.warn(
				`rlm-context: failed to load session context: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	saveSession(): void {
		if (!this.sessionDir) return;
		const file = join(this.sessionDir, "context.json");
		if (!existsSync(this.sessionDir)) mkdirSync(this.sessionDir, { recursive: true });
		const snapshot: ContextSnapshot = {};
		for (const [name, v] of this.sessionVars) {
			snapshot[name] = toSnapshotEntry(v);
		}
		writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
	}

	// ─── Task scope ───────────────────────────────────────────────────────────

	loadTaskSnapshot(snapshot: ContextSnapshot): void {
		this.taskVars.clear();
		for (const [name, v] of Object.entries(snapshot)) {
			this.taskVars.set(name, {
				name,
				value: v.value,
				mutable: v.mutable ?? true,
				type: v.type ?? "object",
				description: v.description,
				source: v.source ?? "agent",
				createdAt: v.createdAt ?? Date.now(),
				updatedAt: v.updatedAt ?? Date.now(),
				scope: "task",
				transferred: true,
			});
		}
		this._epoch++;
		(this.ctx as any).emit("rlm/context-load-task", { count: Object.keys(snapshot).length });
		this.emitPromptChanged("context-load-task");
	}

	// ─── Core API ─────────────────────────────────────────────────────────────

	get(name: string): ContextVariable | undefined {
		return this.taskVars.get(name) ?? this.sessionVars.get(name) ?? this.projectVars.get(name);
	}

	value(name: string): any {
		return this.get(name)?.value;
	}

	/**
	 * Set a variable. Default scope is "session".
	 * const semantics: if mutable is false (or type is "decision"/"prompt"), the variable
	 * cannot be updated or deleted after creation.
	 * let semantics: if mutable is true (default), the variable can be updated.
	 */
	set(
		name: string,
		value: any,
		opts: ContextSetOptions & { scope?: ContextScope } = {},
	): ContextVariable {
		const scope = opts.scope ?? "session";
		const existing = this.get(name);

		// Enforce const — cannot reassign an immutable variable.
		if (existing && !existing.mutable) {
			throw new Error(`context: "${name}" is const (immutable, set as ${existing.type})`);
		}

		// Determine mutability:
		// - Explicit opts.mutable takes priority
		// - "decision" and "prompt" types default to const (immutable)
		// - Everything else defaults to let (mutable)
		const isConst = opts.mutable === false || (!opts.mutable && (opts.type === "decision" || opts.type === "prompt"));

		const now = Date.now();
		const variable: ContextVariable = {
			name,
			value,
			mutable: !isConst,
			type: opts.type ?? inferType(value),
			description: opts.description,
			source: opts.source ?? "agent",
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			scope,
		};

		const map = this.getScopeMap(scope);
		map.set(name, variable);

		if (scope === "project") this.saveProject();
		else if (scope === "session") this.saveSession();

		(this.ctx as any).emit("rlm/context-set", { name, scope, type: variable.type, mutable: variable.mutable });
		this._epoch++;
		this.emitPromptChanged("context-set");
		return variable;
	}

	/**
	 * Update a let (mutable) variable. Throws if the variable is const.
	 * This is an alias for set() but semantically clearer for updates.
	 */
	update(name: string, value: any): ContextVariable {
		const existing = this.get(name);
		if (!existing) throw new Error(`context: "${name}" does not exist`);
		if (!existing.mutable) throw new Error(`context: "${name}" is const and cannot be updated`);
		return this.set(name, value, {
			mutable: true,
			type: existing.type,
			description: existing.description,
			source: existing.source,
			scope: existing.scope,
		});
	}

	/**
	 * Delete a variable. Throws if the variable is const.
	 */
	delete(name: string): boolean {
		const existing = this.get(name);
		if (!existing) return false;
		if (!existing.mutable) {
			throw new Error(`context: "${name}" is const and cannot be deleted`);
		}
		const map = this.getScopeMap(existing.scope);
		const deleted = map.delete(name);
		if (deleted) {
			if (existing.scope === "project") this.saveProject();
			else if (existing.scope === "session") this.saveSession();
			(this.ctx as any).emit("rlm/context-delete", { name, scope: existing.scope });
			this._epoch++;
			this.emitPromptChanged("context-delete");
		}
		return deleted;
	}

	list(pattern?: string): string[] {
		const all = this.getAll();
		if (!pattern) return all.map((v) => v.name);
		return all.filter((v) => matchesPattern(v.name, pattern)).map((v) => v.name);
	}

	getAll(): ContextVariable[] {
		const merged = new Map<string, ContextVariable>();
		for (const v of this.projectVars.values()) merged.set(v.name, v);
		for (const v of this.sessionVars.values()) merged.set(v.name, v);
		for (const v of this.taskVars.values()) merged.set(v.name, v);
		return [...merged.values()];
	}

	/**
	 * Export a snapshot of variables matching patterns.
	 * This is a COPY — the variables stay in this scope.
	 */
	toSnapshot(patterns?: string[]): ContextSnapshot {
		const snapshot: ContextSnapshot = {};
		const all = this.getAll();
		for (const v of all) {
			if (!patterns || patterns.length === 0 || matchesAny(v.name, patterns)) {
				snapshot[v.name] = toSnapshotEntry(v);
			}
		}
		return snapshot;
	}

	/**
	 * MOVE variables matching patterns — returns a snapshot AND deletes them from this scope.
	 * This is a TRANSFER: the parent loses the variables, the child receives them.
	 *
	 * Use this when a parent delegates work to a child and doesn't need the context anymore.
	 * The child gets full ownership.
	 *
	 * Cannot move const variables (they're locked to their scope).
	 * Exception: const variables in task scope CAN be moved (they were transferred in).
	 */
	move(patterns: string[]): ContextSnapshot {
		if (!this.config.enableSubagentTransfer) throw new Error("context.move disabled by config (enableSubagentTransfer=false)");
		const snapshot: ContextSnapshot = {};
		const all = this.getAll();
		for (const v of all) {
			if (matchesAny(v.name, patterns)) {
				// Can't move const variables from project/session scope.
				if (!v.mutable && v.scope !== "task") {
					// Copy const variables instead of moving them.
					snapshot[v.name] = toSnapshotEntry(v);
					continue;
				}
				snapshot[v.name] = toSnapshotEntry(v);
				// Delete from the source scope.
				const map = this.getScopeMap(v.scope);
				map.delete(v.name);
				if (v.scope === "project") this.saveProject();
				else if (v.scope === "session") this.saveSession();
			}
		}
		(this.ctx as any).emit("rlm/context-move", { patterns, count: Object.keys(snapshot).length });
		if (Object.keys(snapshot).length > 0) {
			this._epoch++;
			this.emitPromptChanged("context-move");
		}
		return snapshot;
	}

	// ─── Micro-behaviour power API — clone / mutate / bulk ─────────────────────

	/**
	 * Clone a single variable to a new name (deep copy, atomic).
	 * Respects enableClone flag; supports transform and optional scope override.
	 */
	clone(
		name: string,
		newName: string,
		opts?: { transform?: (v: any) => any; scope?: ContextScope },
	): ContextVariable {
		if (!this.config.enableClone) throw new Error("context.clone disabled by config (enableClone=false)");
		if (!name || !newName) throw new Error("context.clone: name and newName required");
		if (name === newName) throw new Error("context.clone: newName must differ from source name");
		const src = this.get(name);
		if (!src) throw new Error(`context.clone: "${name}" does not exist`);
		let newValue: any = deepClone(src.value);
		if (opts?.transform) {
			newValue = opts.transform(newValue);
		}
		const targetScope = opts?.scope ?? src.scope;
		// Prevent overwriting const with clone — set will throw if exists and const.
		const created = this.set(newName, newValue, {
			type: src.type,
			mutable: src.mutable,
			description: src.description ? `${src.description} (clone of ${name})` : `Clone of ${name}`,
			source: src.source,
			scope: targetScope,
		});
		(this.ctx as any).emit("rlm/context-clone", { name, newName, scope: targetScope });
		// set already bumped epoch + promptChanged; emit extra clone event for granularity.
		return created;
	}

	/**
	 * Clone many variables matching patterns to new names with a prefix or transform.
	 * - prefix string: newName = prefix + oldName (e.g. cloneMany(["auth.*"], "backup.") → backup.auth.files)
	 * - function: newName = fn(oldName, variable)
	 * Deep copies values; optional value transform via opts.transform.
	 * Respects enableClone + enableBulkOps flags. Returns list of created names.
	 */
	cloneMany(
		patterns: string[],
		prefixOrTransform?: string | ((oldName: string, v: ContextVariable) => string),
		opts?: { transform?: (v: any, name: string) => any; scope?: ContextScope },
	): string[] {
		if (!this.config.enableClone) throw new Error("context.cloneMany disabled by config (enableClone=false)");
		if (!this.config.enableBulkOps) throw new Error("context.cloneMany disabled by config (enableBulkOps=false)");
		if (!patterns || patterns.length === 0) throw new Error("context.cloneMany: patterns required");
		const matched = this.getAll().filter((v) => matchesAny(v.name, patterns));
		if (matched.length === 0) return [];
		const created: string[] = [];
		// Batch semantics: collect then single bump? We do per-set bumps (simpler) but collapse epoch via batch style:
		// Use internal batch to avoid N prompt invalidations — one at end.
		const startEpoch = this._epoch;
		let didCreate = false;
		for (const src of matched) {
			let newName: string;
			if (typeof prefixOrTransform === "function") {
				newName = (prefixOrTransform as (oldName: string, v: ContextVariable) => string)(src.name, src);
				if (!newName || typeof newName !== "string") throw new Error("context.cloneMany: transform must return a string newName");
			} else if (typeof prefixOrTransform === "string") {
				newName = `${prefixOrTransform}${src.name}`;
			} else {
				// Default: suffix .clone
				newName = `${src.name}.clone`;
			}
			if (this.get(newName) && !this.get(newName)!.mutable) {
				throw new Error(`context.cloneMany: target "${newName}" is const and cannot be overwritten`);
			}
			let newValue: any = deepClone(src.value);
			if (opts?.transform) {
				newValue = opts.transform(newValue, src.name);
			}
			const targetScope = opts?.scope ?? src.scope;
			// Low-level set without extra epoch? We still want persistence per var.
			// Directly use map + save + single emit at end for atomicity.
			const variable: ContextVariable = {
				name: newName,
				value: newValue,
				mutable: src.mutable,
				type: src.type,
				description: src.description ? `${src.description} (clone of ${src.name})` : `Clone of ${src.name}`,
				source: src.source,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				scope: targetScope,
			};
			const map = this.getScopeMap(targetScope);
			map.set(newName, variable);
			if (targetScope === "project") this.saveProject();
			else if (targetScope === "session") this.saveSession();
			created.push(newName);
			didCreate = true;
		}
		if (didCreate) {
			// One epoch bump + one prompt invalidation for the bulk, instead of N.
			// Adjust because inner sets would have bumped? We bypassed sets so bump once.
			// If _epoch was unchanged, bump once; else it already bumped via prior ops — ensure exactly one extra if we used low-level path.
			if (this._epoch === startEpoch) {
				this._epoch++;
				this.emitPromptChanged("context-cloneMany");
			} else {
				// If some path used set(), we already have bumps — still ensure bulk event
				this._epoch++;
				this.emitPromptChanged("context-cloneMany");
			}
			(this.ctx as any).emit("rlm/context-cloneMany", { patterns, count: created.length, created });
		}
		return created;
	}

	/**
	 * Mutate a single let variable via fn(oldValue) => newValue. Throws if const.
	 * Deep-safe: fn receives a deep clone of the value; return is stored.
	 */
	mutate(name: string, fn: (v: any) => any): ContextVariable {
		if (!this.config.enableMutate) throw new Error("context.mutate disabled by config (enableMutate=false)");
		if (typeof fn !== "function") throw new Error("context.mutate: fn must be a function");
		const existing = this.get(name);
		if (!existing) throw new Error(`context.mutate: "${name}" does not exist`);
		if (!existing.mutable) throw new Error(`context.mutate: "${name}" is const and cannot be mutated`);
		const next = fn(deepClone(existing.value));
		const updated = this.set(name, next, {
			mutable: true,
			type: existing.type,
			description: existing.description,
			source: existing.source,
			scope: existing.scope,
		});
		(this.ctx as any).emit("rlm/context-mutate", { name });
		return updated;
	}

	/**
	 * Mutate many variables matching a glob pattern. Only mutable vars are mutated; const are skipped.
	 * Returns count of mutated variables.
	 */
	mutateMany(pattern: string, fn: (v: any, name: string) => any): number {
		if (!this.config.enableMutate) throw new Error("context.mutateMany disabled by config (enableMutate=false)");
		if (!this.config.enableBulkOps) throw new Error("context.mutateMany disabled by config (enableBulkOps=false)");
		if (typeof fn !== "function") throw new Error("context.mutateMany: fn must be a function");
		if (!pattern) throw new Error("context.mutateMany: pattern required");
		const matched = this.getAll().filter((v) => matchesPattern(v.name, pattern));
		const mutableMatched = matched.filter((v) => v.mutable);
		if (matched.length === 0) return 0;
		let count = 0;
		for (const v of mutableMatched) {
			const next = fn(deepClone(v.value), v.name);
			// Direct low-level update to allow single epoch bump
			const map = this.getScopeMap(v.scope);
			const updatedVar: ContextVariable = {
				...v,
				value: next,
				updatedAt: Date.now(),
			};
			map.set(v.name, updatedVar);
			if (v.scope === "project") this.saveProject();
			else if (v.scope === "session") this.saveSession();
			count++;
		}
		if (count > 0) {
			this._epoch++;
			this.emitPromptChanged("context-mutateMany");
			(this.ctx as any).emit("rlm/context-mutateMany", { pattern, count });
		}
		// If some const were skipped, emit warning emit
		if (count !== matched.length) {
			(this.ctx as any).emit("rlm/context-mutateMany-skip-const", { pattern, skipped: matched.length - count });
		}
		return count;
	}

	/**
	 * Atomic batch — execute multiple ops with a single epoch bump and single prompt invalidation.
	 * Each op is one of: set | update | delete | clone | mutate | cloneMany | mutateMany | copy | move | clear.
	 * All operations run sequentially; if any throws, prior writes remain but epoch still bumps (best-effort atomic).
	 * Respects individual enable flags per sub-op.
	 */
	batch(ops: Array<
		| { op: "set"; name: string; value: any; opts?: ContextSetOptions & { scope?: ContextScope } }
		| { op: "update"; name: string; value: any }
		| { op: "delete"; name: string }
		| { op: "clone"; name: string; newName: string; opts?: { transform?: (v: any) => any; scope?: ContextScope } }
		| { op: "cloneMany"; patterns: string[]; prefixOrTransform?: string | ((oldName: string, v: ContextVariable) => string); opts?: { transform?: (v: any, name: string) => any; scope?: ContextScope } }
		| { op: "mutate"; name: string; fn: (v: any) => any }
		| { op: "mutateMany"; pattern: string; fn: (v: any, name: string) => any }
		| { op: "copy"; patterns?: string[] }
		| { op: "move"; patterns: string[] }
		| { op: "clear"; scope: ContextScope; force?: boolean }
	>): { snapshot?: ContextSnapshot; cleared?: string[] } {
		if (!this.config.enableBulkOps) throw new Error("context.batch disabled by config (enableBulkOps=false)");
		if (!Array.isArray(ops) || ops.length === 0) return {};
		const startEpoch = this._epoch;
		let suppressExtraBumps = true;
		// Temporarily patch _epoch increment? Instead capture and revert intermediate bumps.
		// We'll run ops by directly using low-level where possible, but delegate to service methods
		// that bump. So we snapshot epoch after each op and collapse to single bump at end.
		let lastSnapshot: ContextSnapshot | undefined;
		const cleared: string[] = [];
		for (const op of ops) {
			switch (op.op) {
				case "set":
					this.set(op.name, op.value, op.opts ?? {});
					break;
				case "update":
					this.update(op.name, op.value);
					break;
				case "delete":
					this.delete(op.name);
					break;
				case "clone":
					this.clone(op.name, op.newName, op.opts);
					break;
				case "cloneMany":
					this.cloneMany(op.patterns, op.prefixOrTransform, op.opts);
					break;
				case "mutate":
					this.mutate(op.name, op.fn);
					break;
				case "mutateMany":
					this.mutateMany(op.pattern, op.fn);
					break;
				case "copy":
					lastSnapshot = this.toSnapshot(op.patterns);
					break;
				case "move":
					lastSnapshot = this.move(op.patterns);
					break;
				case "clear":
					this.clear(op.scope, op.force);
					cleared.push(op.scope);
					break;
				default:
					throw new Error(`context.batch: unknown op "${(op as any).op}"`);
			}
		}
		// Collapse N bumps into 1: if we did any mutation, _epoch is now start + N. Reset to start+1.
		if (this._epoch !== startEpoch) {
			const bumps = this._epoch - startEpoch;
			if (bumps > 1) {
				this._epoch = startEpoch + 1;
			}
			// Single prompt-changed for batch (already emitted per-op, but ensure at least one)
			if (suppressExtraBumps) {
				this.emitPromptChanged("context-batch");
			}
			(this.ctx as any).emit("rlm/context-batch", { count: ops.length });
		}
		void suppressExtraBumps;
		return { ...(lastSnapshot ? { snapshot: lastSnapshot } : {}), ...(cleared.length ? { cleared } : {}) };
	}

	/**
	 * Get a summary of all context for the system prompt.
	 */
	summarize(): string {
		const all = this.getAll();
		if (all.length === 0) return "(no context variables)";
		const lines: string[] = [];
		for (const v of all.sort((a, b) => a.name.localeCompare(b.name))) {
			const valueStr = formatValue(v.value);
			const kind = v.mutable ? "let" : "const";
			const descStr = v.description ? ` — ${v.description}` : "";
			const transferStr = v.transferred ? " [transferred]" : "";
			lines.push(`  ${v.name} (${kind} ${v.type}, ${v.scope}${transferStr})${descStr}: ${valueStr}`);
		}
		return lines.join("\n");
	}

	/**
	 * Clear all variables in a scope. Cannot clear project/session if they contain const vars.
	 * Use force=true to clear everything including const vars.
	 */
	clear(scope: ContextScope, force?: boolean): void {
		const map = this.getScopeMap(scope);
		if (!force) {
			for (const v of map.values()) {
				if (!v.mutable) throw new Error(`context: cannot clear ${scope} scope — "${v.name}" is const`);
			}
		}
		const hadEntries = map.size > 0;
		map.clear();
		if (scope === "project") this.saveProject();
		else if (scope === "session") this.saveSession();
		(this.ctx as any).emit("rlm/context-clear", { scope });
		if (hadEntries) {
			this._epoch++;
			this.emitPromptChanged("context-clear");
		}
	}

	/**
	 * Auto-capture the user prompt as a const variable.
	 * Called by the agent session when a new prompt arrives.
	 */
	captureUserPrompt(prompt: string): void {
		this.set("user.prompt", prompt, {
			type: "prompt",
			mutable: false,
			description: "The original user prompt for this session",
			source: "user",
			scope: "session",
		});
	}

	/**
	 * Auto-capture session metadata as variables.
	 */
	captureSessionMeta(meta: {
		model?: string;
		cwd?: string;
		tools?: string[];
		depth?: number;
	}): void {
		if (meta.model) {
			this.set("session.model", meta.model, {
				type: "model",
				mutable: false,
				description: "Model used for this session",
				source: "system",
				scope: "session",
			});
		}
		if (meta.cwd) {
			this.set("session.cwd", meta.cwd, {
				type: "path",
				mutable: false,
				description: "Working directory for this session",
				source: "system",
				scope: "session",
			});
		}
		if (meta.tools) {
			this.set("session.tools", meta.tools, {
				type: "tool",
				mutable: false,
				description: "Tools available in this session",
				source: "system",
				scope: "session",
			});
		}
		if (meta.depth !== undefined) {
			this.set("session.depth", meta.depth, {
				type: "number",
				mutable: false,
				description: "Recursion depth (0 = root, 1+ = child)",
				source: "system",
				scope: "session",
			});
		}
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────

	private getScopeMap(scope: ContextScope): Map<string, ContextVariable> {
		switch (scope) {
			case "project": return this.projectVars;
			case "session": return this.sessionVars;
			case "task": return this.taskVars;
		}
	}

	async [Symbol.dispose]() {
		// Dispose prompt fragment (triggers rlm/prompt-changed via service).
		this.disposePromptFragment();
		// Dispose TUI extensions — roll back the TUI to its core state.
		this.disposeTuiExtensions();
		this._panelState = null;
		// Persist on dispose.
		this.saveProject();
		this.saveSession();
	}
}

// ─── Context Proxy (for VM context) ──────────────────────────────────────────

/**
 * Create a proxy object for the code kernel's VM context.
 * The agent interacts with this via `context.set()`, `context.get()`, etc.
 *
 * This is the agent's primary interface to its working memory.
 */
export function createContextProxy(service: RlmContextService): any {
	return {
		/** Get a variable's value (undefined if not found). */
		get: (name: string) => service.value(name),

		/** Get the full variable metadata. */
		meta: (name: string) => service.get(name),

		/** Set a new variable. Default is let (mutable). Use { mutable: false } for const. */
		set: (
			name: string,
			value: any,
			opts?: ContextSetOptions & { scope?: ContextScope },
		) => service.set(name, value, opts),

		/** Update an existing let variable. Throws if const. */
		update: (name: string, value: any) => service.update(name, value),

		/** Delete a variable. Throws if const. */
		delete: (name: string) => service.delete(name),

		/** List variable names matching a glob pattern. */
		list: (pattern?: string) => service.list(pattern),

		/** Get all variables. */
		all: () => service.getAll(),

		/** Get a formatted summary for the prompt. */
		summarize: () => service.summarize(),

		/** Export a COPY of variables matching patterns. Variables stay in this scope. Default for subagent passing. */
		copy: (patterns?: string[]) => service.toSnapshot(patterns),

		/** Alias for copy — same non-destructive snapshot. */
		snapshot: (patterns?: string[]) => service.toSnapshot(patterns),

		/**
		 * MOVE variables matching patterns — returns a snapshot AND removes them from this scope.
		 * Destructive: you lose the variables. Use only when you're sure you won't need them.
		 * Const variables in project/session scope are copied (not moved).
		 */
		move: (patterns: string[]) => service.move(patterns),

		/** Deep-copy single var to new name. opts.transform?(value)=>newValue, opts.scope? target scope. */
		clone: (name: string, newName: string, opts?: { transform?: (v: any) => any; scope?: ContextScope }) => service.clone(name, newName, opts),

		/** Clone many vars matching patterns. prefix string → prefix+oldName, or fn(oldName,v)=>newName. */
		cloneMany: (patterns: string[], prefixOrTransform?: string | ((oldName: string, v: any) => string), opts?: { transform?: (v: any, name: string) => any; scope?: ContextScope }) => service.cloneMany(patterns, prefixOrTransform as any, opts),

		/** Mutate a mutable var via fn(oldValue)=>newValue. */
		mutate: (name: string, fn: (v: any) => any) => service.mutate(name, fn),

		/** Mutate many vars matching pattern via fn(value,name)=>newValue. Returns count. */
		mutateMany: (pattern: string, fn: (v: any, name: string) => any) => service.mutateMany(pattern, fn),

		/** Atomic batch — one epoch bump for many ops. See service.batch for op shapes. */
		batch: (ops: any[]) => service.batch(ops),

	/** Clear a scope. Throws if const variables exist (use force=true to override). */
		clear: (scope: ContextScope, force?: boolean) => service.clear(scope, force),

		/** Get panel state including focusedIndex for focus highlighting. */
		getPanelState: () => service.getPanelState(),
	};
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function deepClone<T>(value: T): T {
	try {
		if (typeof (globalThis as any).structuredClone === "function") {
			return (globalThis as any).structuredClone(value);
		}
	} catch {}
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		// Fallback shallow for non-serializable
		if (Array.isArray(value)) return [...(value as any)] as any;
		if (value && typeof value === "object") return { ...(value as any) } as any;
		return value;
	}
}

function toSnapshotEntry(v: ContextVariable): ContextSnapshot[string] {
	return {
		value: v.value,
		mutable: v.mutable,
		type: v.type,
		description: v.description,
		source: v.source,
		createdAt: v.createdAt,
		updatedAt: v.updatedAt,
		transferred: v.transferred,
	};
}

function inferType(value: any): ContextType {
	if (typeof value === "string") {
		if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return "path";
		if (/[*?\[\]{}()|+\\]/.test(value) && value.length < 200) return "pattern";
		return "string";
	}
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (Array.isArray(value)) {
		if (value.every((v) => typeof v === "string" && (v.startsWith("/") || v.startsWith("./")))) return "paths";
		return "array";
	}
	if (typeof value === "object" && value !== null) return "object";
	return "string";
}

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${regex}$`).test(name);
}

function matchesAny(name: string, patterns: string[]): boolean {
	return patterns.some((p) => matchesPattern(name, p));
}

function formatValue(value: any): string {
	if (typeof value === "string") {
		// Truncate long strings.
		if (value.length > 100) return JSON.stringify(value.slice(0, 100) + "...");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (value.length <= 3) return `[${value.map(formatValue).join(", ")}]`;
		return `[${value.slice(0, 3).map(formatValue).join(", ")}, ...${value.length} items]`;
	}
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value);
		if (keys.length <= 3) return JSON.stringify(value);
		return `{${keys.slice(0, 3).join(", ")}, ...${keys.length} keys}`;
	}
	return String(value);
}

/** Ultra-compact value formatter for TUI rendering — minimal width. */
function formatValueCompact(value: any): string {
	if (typeof value === "string") {
		if (value.length > 40) return `"${value.slice(0, 37)}..."`;
		return `"${value}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		if (value.length <= 2) return `[${value.map(formatValueCompact).join(", ")}]`;
		return `[${value.length} items]`;
	}
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		if (keys.length <= 2) return `{${keys.join(", ")}}`;
		return `{${keys.length} keys}`;
	}
	return String(value);
}

/** Detailed formatter for expanded view — preserves full content. */
function formatValueDetailed(value: any): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		try { return JSON.stringify(value, null, 2); } catch { return String(value); }
	}
	if (typeof value === "object") {
		try { return JSON.stringify(value, null, 2); } catch { return String(value); }
	}
	return String(value);
}

// ─── Config & defaults (chordis micro-plugin flags) ───────────────────────────────

export interface RlmContextConfig {
	projectRoot?: string
	// UI toggles — each micro feature toggleable, all true by default
	showContextPanel?: boolean
	coloredBars?: boolean
	perVariableExpand?: boolean
	/** @deprecated moved to RlmTuiConfig.hjklNavigation — kept for backwards compat, delegates to tui when available */
	hjklNavigation?: boolean
	/** @deprecated moved to RlmTuiConfig.autoFocusTyping — kept for backwards compat, delegates to tui when available */
	autoFocusTyping?: boolean
	/** @deprecated moved to RlmTuiConfig.doubleEnterToSend — kept for backwards compat, delegates to tui when available */
	doubleEnterToSend?: boolean
	/** @deprecated moved to RlmTuiConfig.followupQueueUi — kept for backwards compat, delegates to tui when available */
	followupQueueUi?: boolean
	scrollablePanel?: boolean
	/** Overridable keybindings for this panel (merged with DEFAULT_CONTEXT_KEYBINDINGS). */
	keybindings?: Record<string, string>
	// Micro-behaviour power toggles (all true by default — harness most powerful without AI)
	enableClone?: boolean
	enableMutate?: boolean
	enableBulkOps?: boolean
	enableSubagentTransfer?: boolean
}

export const DEFAULT_CONTEXT_KEYBINDINGS: Record<string, string> = {
	"panel.toggle": "enter",
	"panel.expand": "enter",
	"panel.collapse": "enter",
	"panel.navUp": "k,ArrowUp,h",
	"panel.navDown": "j,ArrowDown,l",
	"panel.navLeft": "h,ArrowLeft",
	"panel.navRight": "l,ArrowRight",
	"panel.scrollUp": "ctrl+u,pageup",
	"panel.scrollDown": "ctrl+d,pagedown",
	"panel.focusNext": "tab,j,ArrowDown",
	"panel.focusPrev": "shift+tab,k,ArrowUp",
};

export const DEFAULT_RLM_CONTEXT_CONFIG: Required<Omit<RlmContextConfig, "projectRoot" | "keybindings">> & Pick<RlmContextConfig, "projectRoot" | "keybindings"> = {
	projectRoot: undefined as unknown as string | undefined,
	showContextPanel: true,
	coloredBars: true,
	perVariableExpand: true,
	hjklNavigation: true,
	autoFocusTyping: true,
	doubleEnterToSend: true,
	followupQueueUi: true,
	scrollablePanel: true,
	keybindings: { ...DEFAULT_CONTEXT_KEYBINDINGS },
	enableClone: true,
	enableMutate: true,
	enableBulkOps: true,
	enableSubagentTransfer: true,
};

export function resolveRlmContextConfig(cfg: RlmContextConfig = {}): ResolvedRlmContextConfig {
	return {
		projectRoot: cfg.projectRoot,
		showContextPanel: cfg.showContextPanel ?? true,
		coloredBars: cfg.coloredBars ?? true,
		perVariableExpand: cfg.perVariableExpand ?? true,
		hjklNavigation: cfg.hjklNavigation ?? true,
		autoFocusTyping: cfg.autoFocusTyping ?? true,
		doubleEnterToSend: cfg.doubleEnterToSend ?? true,
		followupQueueUi: cfg.followupQueueUi ?? true,
		scrollablePanel: cfg.scrollablePanel ?? true,
		keybindings: { ...DEFAULT_CONTEXT_KEYBINDINGS, ...(cfg.keybindings ?? {}) },
		enableClone: cfg.enableClone ?? true,
		enableMutate: cfg.enableMutate ?? true,
		enableBulkOps: cfg.enableBulkOps ?? true,
		enableSubagentTransfer: cfg.enableSubagentTransfer ?? true,
	};
}

export function getRlmContextDefaults(): ResolvedRlmContextConfig {
	return resolveRlmContextConfig({});
}

export default RlmContextService;
export const name = "rlm-context";
export const inject = [] as const;
export { RlmContextService as RlmContext };
