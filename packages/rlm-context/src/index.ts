/**
 * @rlm/context — persistent typed variable registry for agent working memory.
 *
 * Cordis Service. Provides a 3-scope context registry:
 *   - project: survives all sessions, lives in .rlm/context.json
 *   - session: lives for one session, in session artifact dir
 *   - task:    lives for one subagent invocation, passed via rlm.spawn()
 *
 * Variables are typed so the agent knows how to use them:
 *   - path/paths: file system locations
 *   - string/number/boolean: scalars
 *   - object/array: structured data
 *   - pattern: regex/glob patterns
 *   - decision: architectural choices (immutable by default)
 *
 * The agent interacts via `context` in the code kernel:
 *   context.set("auth.files", [...], { type: "paths", mutable: true })
 *   context.get("auth.files")
 *   context.list("auth.*")
 *   context.delete("auth.files")
 *   context.send(childAgent, ["auth.*"])  // pass to subagent
 *
 * Persistence:
 *   - project scope: .rlm/context.json in project root
 *   - session scope: <session-dir>/context.json
 *   - task scope: in-memory only, passed via rlm.spawn()
 *
 * Hot-reloadable: part of the Cordis plugin system.
 */
import { Service } from "@deepseek-ai/cordis";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

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
	| "decision";

export interface ContextVariable {
	/** Variable name, dot-namespaced (e.g. "auth.files", "db.schema"). */
	name: string;
	/** The value — any JSON-serializable data. */
	value: any;
	/** Whether the agent can update this after creation. */
	mutable: boolean;
	/** Type hint for the agent. */
	type: ContextType;
	/** Human-readable description of what this variable represents. */
	description?: string;
	/** Who set this variable. */
	source: "user" | "agent" | "discovery";
	/** Timestamps. */
	createdAt: number;
	updatedAt: number;
	/** Scope this variable lives in. */
	scope: ContextScope;
}

export interface ContextSetOptions {
	mutable?: boolean;
	type?: ContextType;
	description?: string;
	source?: "user" | "agent" | "discovery";
}

export interface ContextSnapshot {
	[name: string]: {
		value: any;
		mutable: boolean;
		type: ContextType;
		description?: string;
		source: "user" | "agent" | "discovery";
		createdAt: number;
		updatedAt: number;
	};
}

// ─── Context Registry ────────────────────────────────────────────────────────

/**
 * RlmContextService — the context registry as a Cordis service.
 *
 * Other plugins (code tool, sdk, workflow) inject this service and use it
 * to read/write/share agent working memory.
 */
export class RlmContextService extends Service {
	static inject = [] as const;
	static provide = "rlmContext" as const;

	declare config: RlmContextConfig;

	/** Project-scope variables — persisted to .rlm/context.json. */
	private projectVars: Map<string, ContextVariable> = new Map();
	/** Session-scope variables — persisted to session artifact dir. */
	private sessionVars: Map<string, ContextVariable> = new Map();
	/** Task-scope variables — in-memory only, passed to subagents. */
	private taskVars: Map<string, ContextVariable> = new Map();

	/** Project root for project-scope persistence. */
	private projectRoot: string = process.cwd();
	/** Session artifact dir for session-scope persistence. */
	private sessionDir: string | null = null;
	/** Whether project context has been loaded from disk. */
	private projectLoaded: boolean = false;

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

	/** Set the project root and reload project context. */
	setProjectRoot(root: string): void {
		this.projectRoot = root;
		this.loadProject();
	}

	/** Load project-scope variables from .rlm/context.json. */
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
			this.projectLoaded = true;
		} catch (error) {
			this.ctx.logger?.warn(
				`rlm-context: failed to load project context: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	/** Save project-scope variables to .rlm/context.json. */
	saveProject(): void {
		const file = this.getProjectContextFile();
		const dir = dirname(file);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const snapshot: ContextSnapshot = {};
		for (const [name, v] of this.projectVars) {
			snapshot[name] = {
				value: v.value,
				mutable: v.mutable,
				type: v.type,
				description: v.description,
				source: v.source,
				createdAt: v.createdAt,
				updatedAt: v.updatedAt,
			};
		}
		writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
	}

	private getProjectContextFile(): string {
		return join(this.projectRoot, ".rlm", "context.json");
	}

	// ─── Session scope ────────────────────────────────────────────────────────

	/** Set the session artifact dir and load session context. */
	setSessionDir(dir: string): void {
		this.sessionDir = dir;
		this.loadSession();
	}

	/** Load session-scope variables from <session-dir>/context.json. */
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

	/** Save session-scope variables to <session-dir>/context.json. */
	saveSession(): void {
		if (!this.sessionDir) return;
		const file = join(this.sessionDir, "context.json");
		if (!existsSync(this.sessionDir)) mkdirSync(this.sessionDir, { recursive: true });
		const snapshot: ContextSnapshot = {};
		for (const [name, v] of this.sessionVars) {
			snapshot[name] = {
				value: v.value,
				mutable: v.mutable,
				type: v.type,
				description: v.description,
				source: v.source,
				createdAt: v.createdAt,
				updatedAt: v.updatedAt,
			};
		}
		writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
	}

	// ─── Task scope ───────────────────────────────────────────────────────────

	/** Load task-scope variables from a snapshot (received from parent). */
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
			});
		}
	}

	/** Export a snapshot of variables matching patterns for passing to subagent. */
	toSnapshot(patterns?: string[]): ContextSnapshot {
		const snapshot: ContextSnapshot = {};
		const all = this.getAll();
		for (const v of all) {
			if (!patterns || patterns.length === 0 || matchesAny(v.name, patterns)) {
				snapshot[v.name] = {
					value: v.value,
					mutable: v.mutable,
					type: v.type,
					description: v.description,
					source: v.source,
					createdAt: v.createdAt,
					updatedAt: v.updatedAt,
				};
			}
		}
		return snapshot;
	}

	// ─── Core API ─────────────────────────────────────────────────────────────

	/**
	 * Get a variable by name. Searches task → session → project scope.
	 * Returns undefined if not found.
	 */
	get(name: string): ContextVariable | undefined {
		return this.taskVars.get(name) ?? this.sessionVars.get(name) ?? this.projectVars.get(name);
	}

	/**
	 * Get a variable's value. Shorthand for `context.get(name)?.value`.
	 */
	value(name: string): any {
		return this.get(name)?.value;
	}

	/**
	 * Set a variable. Default scope is "session".
	 * Throws if the variable exists and is immutable.
	 */
	set(
		name: string,
		value: any,
		opts: ContextSetOptions & { scope?: ContextScope } = {},
	): ContextVariable {
		const scope = opts.scope ?? "session";
		const existing = this.get(name);
		if (existing && !existing.mutable) {
			throw new Error(`context: "${name}" is immutable (set as ${existing.type})`);
		}

		const now = Date.now();
		const variable: ContextVariable = {
			name,
			value,
			mutable: opts.mutable ?? (opts.type === "decision" ? false : true),
			type: opts.type ?? inferType(value),
			description: opts.description,
			source: opts.source ?? "agent",
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			scope,
		};

		const map = this.getScopeMap(scope);
		map.set(name, variable);

		// Auto-persist project and session scopes.
		if (scope === "project") this.saveProject();
		else if (scope === "session") this.saveSession();

		this.ctx.emit("rlm/context-set", { name, scope, type: variable.type });
		return variable;
	}

	/**
	 * Delete a variable. Returns true if it existed.
	 */
	delete(name: string): boolean {
		const existing = this.get(name);
		if (!existing) return false;
		if (!existing.mutable) {
			throw new Error(`context: "${name}" is immutable and cannot be deleted`);
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

	/**
	 * List all variable names matching a glob pattern (e.g. "auth.*").
	 * If no pattern, lists all variables.
	 */
	list(pattern?: string): string[] {
		const all = this.getAll();
		if (!pattern) return all.map((v) => v.name);
		return all.filter((v) => matchesPattern(v.name, pattern)).map((v) => v.name);
	}

	/**
	 * Get all variables (task + session + project, merged).
	 * Task scope overrides session, session overrides project.
	 */
	getAll(): ContextVariable[] {
		const merged = new Map<string, ContextVariable>();
		for (const v of this.projectVars.values()) merged.set(v.name, v);
		for (const v of this.sessionVars.values()) merged.set(v.name, v);
		for (const v of this.taskVars.values()) merged.set(v.name, v);
		return [...merged.values()];
	}

	/**
	 * Get a summary of all context for the system prompt.
	 * Returns a formatted string the agent can read.
	 */
	summarize(): string {
		const all = this.getAll();
		if (all.length === 0) return "(no context variables set)";
		const lines: string[] = [];
		for (const v of all.sort((a, b) => a.name.localeCompare(b.name))) {
			const valueStr = formatValue(v.value);
			const mutStr = v.mutable ? "" : " [immutable]";
			const descStr = v.description ? ` — ${v.description}` : "";
			lines.push(`  ${v.name} (${v.type}, ${v.scope}${mutStr})${descStr}: ${valueStr}`);
		}
		return lines.join("\n");
	}

	/**
	 * Clear all variables in a scope.
	 */
	clear(scope: ContextScope): void {
		const map = this.getScopeMap(scope);
		map.clear();
		if (scope === "project") this.saveProject();
		else if (scope === "session") this.saveSession();
		this.ctx.emit("rlm/context-clear", { scope });
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
		// Persist on dispose.
		this.saveProject();
		this.saveSession();
	}
}

// ─── Context Proxy (for VM context) ──────────────────────────────────────────

/**
 * Create a proxy object for the code kernel's VM context.
 * The agent interacts with this via `context.set()`, `context.get()`, etc.
 */
export function createContextProxy(service: RlmContextService): any {
	return {
		/** Get a variable's value (undefined if not found). */
		get: (name: string) => service.value(name),
		/** Get the full variable metadata. */
		meta: (name: string) => service.get(name),
		/** Set a variable. */
		set: (
			name: string,
			value: any,
			opts?: ContextSetOptions & { scope?: ContextScope },
		) => service.set(name, value, opts),
		/** Delete a variable. */
		delete: (name: string) => service.delete(name),
		/** List variable names matching a pattern. */
		list: (pattern?: string) => service.list(pattern),
		/** Get all variables. */
		all: () => service.getAll(),
		/** Get a formatted summary for the prompt. */
		summarize: () => service.summarize(),
		/** Export a snapshot for passing to a subagent. */
		snapshot: (patterns?: string[]) => service.toSnapshot(patterns),
		/** Clear a scope. */
		clear: (scope: ContextScope) => service.clear(scope),
	};
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Infer a ContextType from a JS value. */
function inferType(value: any): ContextType {
	if (typeof value === "string") {
		// Check if it looks like a file path.
		if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return "path";
		// Check if it looks like a glob/regex pattern.
		if (/[*?\[\]{}()|+\\]/.test(value) && value.length < 200) return "pattern";
		return "string";
	}
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (Array.isArray(value)) {
		// Check if it's an array of paths.
		if (value.every((v) => typeof v === "string" && (v.startsWith("/") || v.startsWith("./")))) return "paths";
		return "array";
	}
	if (typeof value === "object" && value !== null) return "object";
	return "string";
}

/** Match a variable name against a glob pattern (supports * wildcard). */
function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	// Convert glob to regex: * → .*, . → \.
	const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${regex}$`).test(name);
}

/** Match a variable name against any of multiple patterns. */
function matchesAny(name: string, patterns: string[]): boolean {
	return patterns.some((p) => matchesPattern(name, p));
}

/** Format a value for display in the summary. */
function formatValue(value: any): string {
	if (typeof value === "string") return JSON.stringify(value);
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
