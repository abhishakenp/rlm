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

export class RlmContextService extends Service {
	static inject = [] as const;
	static provide = "rlmContext" as const;

	declare config: RlmContextConfig;

	private projectVars: Map<string, ContextVariable> = new Map();
	private sessionVars: Map<string, ContextVariable> = new Map();
	private taskVars: Map<string, ContextVariable> = new Map();

	private projectRoot: string = process.cwd();
	private sessionDir: string | null = null;

	constructor(ctx: any, config: RlmContextConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		this.projectRoot = this.config.projectRoot ?? process.cwd();
		this.loadProject();
		this.ctx.logger?.info(
			`rlm-context: ready (${this.projectVars.size} project vars loaded)`,
		);
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

		this.ctx.emit("rlm/context-set", { name, scope, type: variable.type, mutable: variable.mutable });
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
			this.ctx.emit("rlm/context-delete", { name, scope: existing.scope });
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
		this.ctx.emit("rlm/context-move", { patterns, count: Object.keys(snapshot).length });
		return snapshot;
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
		map.clear();
		if (scope === "project") this.saveProject();
		else if (scope === "session") this.saveSession();
		this.ctx.emit("rlm/context-clear", { scope });
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

		/** Clear a scope. Throws if const variables exist (use force=true to override). */
		clear: (scope: ContextScope, force?: boolean) => service.clear(scope, force),
	};
}

// ─── Utilities ───────────────────────────────────────────────────────────────

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

// ─── Exports ─────────────────────────────────────────────────────────────────

export interface RlmContextConfig {
	projectRoot?: string;
}

export default RlmContextService;
export const name = "rlm-context";
export const inject = [] as const;
export { RlmContextService as RlmContext };
