/**
 * @rlm/prompt — prompt contribution registry as a Cordis Service.
 *
 * Foundation plugin — no dependencies. Provides a registry where any plugin
 * can contribute system-prompt fragments. The agent session composes them into
 * the final system prompt via `buildCompositePrompt()`.
 *
 * Hot-reload safe:
 *   - Each `registerFragment()` returns a handle with `dispose()`.
 *   - `disposePlugin(pluginId)` removes all fragments for a plugin.
 *   - Mutations emit `rlm/prompt-changed` on the Cordis ctx so
 *     AgentSession._installPromptHmrListener invalidates its cache.
 *
 * Exposed globally as `globalThis.__rlmPrompt` for read without import
 * (like `__rlmTui`), so coding-agent can access it without a static cycle.
 */

import { Service } from "@deepseek-ai/cordis";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PromptFragment {
	id: string;
	content: string | (() => string);
	priority: number;
	when?: "always" | "depth0" | "depth>0";
	pluginId?: string;
}

export interface ExtensionHandle {
	id: string;
	dispose: () => void;
}

export interface Disposable {
	dispose: () => void;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class RlmPromptService extends Service {
	static inject = [] as const;
	static provide = "rlmPrompt" as const;

	declare config: RlmPromptConfig;

	/** Fragments keyed by `${pluginId}:${id}` */
	private fragments: Map<string, PromptFragment> = new Map();
	/** Handles grouped by pluginId for bulk disposal on hot-swap */
	private handlesByPlugin: Map<string, ExtensionHandle[]> = new Map();
	/** Change listeners */
	private listeners: Set<() => void> = new Set();
	/** Counter for auto-generated fragment ids (string shortcut) */
	private autoIdCounter = 0;

	constructor(ctx: any, config: RlmPromptConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		(globalThis as any).__rlmPrompt = this;
		this.ctx.logger?.info("rlm-prompt: ready (prompt contribution registry)");
	}

	// ─── Registration ────────────────────────────────────────────────────────

	/**
	 * Register a prompt fragment.
	 *
	 * @param pluginId - owning plugin id (used for HMR cleanup)
	 * @param fragment - fragment descriptor or plain string (shortcut: auto id, priority 50)
	 * @returns handle whose `dispose()` unregisters the fragment
	 */
	registerFragment(
		pluginId: string,
		fragment: string | Omit<PromptFragment, "pluginId">,
	): ExtensionHandle {
		let frag: PromptFragment;

		if (typeof fragment === "string") {
			const id = `frag-${++this.autoIdCounter}`;
			frag = { id, content: fragment, priority: 50, pluginId };
		} else {
			const { id, content, priority, when } = fragment as PromptFragment;
			if (!id || typeof id !== "string") {
				throw new Error("rlm-prompt: fragment.id is required");
			}
			if (priority === undefined || priority === null || typeof priority !== "number") {
				throw new Error("rlm-prompt: fragment.priority is required");
			}
			frag = { id, content, priority, when, pluginId };
		}

		const key = `${pluginId}:${frag.id}`;
		this.fragments.set(key, frag);

		const handle: ExtensionHandle = {
			id: key,
			dispose: () => {
				if (this.fragments.delete(key)) {
					this.removeHandle(pluginId, handle);
					this.notifyChange(pluginId, frag.id);
				}
			},
		};
		this.addHandle(pluginId, handle);
		this.notifyChange(pluginId, frag.id);
		return handle;
	}

	// ─── Queries ─────────────────────────────────────────────────────────────

	/**
	 * Get all fragments, optionally filtered by depth, sorted by priority descending.
	 */
	getFragments(depth?: number): PromptFragment[] {
		const result = [...this.fragments.values()].filter((f) => this.matchesDepth(f, depth));
		result.sort((a, b) => b.priority - a.priority);
		return result;
	}

	/**
	 * Build the composite prompt by concatenating fragment contents (evaluating functions)
	 * sorted by priority descending. Optionally filtered by depth.
	 */
	buildCompositePrompt(depth?: number): string {
		const frags = this.getFragments(depth);
		const parts: string[] = [];
		for (const f of frags) {
			let content: string;
			if (typeof f.content === "function") {
				try {
					content = (f.content as () => string)();
				} catch {
					continue;
				}
			} else {
				content = f.content as string;
			}
			if (content && content.trim().length > 0) parts.push(content);
		}
		return parts.join("\n\n");
	}

	/**
	 * Subscribe to fragment changes. Returns a disposable.
	 */
	onDidChange(cb: () => void): Disposable {
		this.listeners.add(cb);
		return { dispose: () => this.listeners.delete(cb) };
	}

	// ─── Plugin cleanup ──────────────────────────────────────────────────────

	/**
	 * Remove all fragments registered by a plugin.
	 * Called on hot-swap / fiber dispose; also available for manual cleanup.
	 */
	disposePlugin(pluginId: string): void {
		const handles = this.handlesByPlugin.get(pluginId);
		if (!handles) return;
		const toDispose = [...handles];
		this.handlesByPlugin.delete(pluginId);
		let changed = false;
		for (const handle of toDispose) {
			if (this.fragments.delete(handle.id)) changed = true;
		}
		if (changed) {
			this.notifyChange(pluginId, "*");
		}
		try {
			(this.ctx as any).emit("rlm/prompt-dispose-plugin", { pluginId });
		} catch {}
	}

	/** Check if a plugin has active fragments. */
	hasFragments(pluginId: string): boolean {
		return (this.handlesByPlugin.get(pluginId)?.length ?? 0) > 0;
	}

	// ─── Internals ───────────────────────────────────────────────────────────

	private matchesDepth(f: PromptFragment, depth: number | undefined): boolean {
		if (!f.when || f.when === "always") return true;
		if (depth === undefined) return true;
		if (f.when === "depth0") return depth === 0;
		if (f.when === "depth>0") return depth > 0;
		return true;
	}

	private notifyChange(pluginId: string, id: string): void {
		try {
			(this.ctx as any).emit("rlm/prompt-changed", { pluginId, id });
		} catch {}
		this.emitListeners();
	}

	private emitListeners(): void {
		for (const cb of [...this.listeners]) {
			try {
				cb();
			} catch {}
		}
	}

	private addHandle(pluginId: string, handle: ExtensionHandle): void {
		if (!this.handlesByPlugin.has(pluginId)) {
			this.handlesByPlugin.set(pluginId, []);
		}
		this.handlesByPlugin.get(pluginId)!.push(handle);
	}

	private removeHandle(pluginId: string, handle: ExtensionHandle): void {
		const handles = this.handlesByPlugin.get(pluginId);
		if (!handles) return;
		const idx = handles.indexOf(handle);
		if (idx >= 0) handles.splice(idx, 1);
		if (handles.length === 0) this.handlesByPlugin.delete(pluginId);
	}

	async [Symbol.dispose]() {
		// Clear all fragments on shutdown — dispose handles without re-emitting per-fragment.
		const pluginIds = [...this.handlesByPlugin.keys()];
		for (const pid of pluginIds) {
			this.disposePlugin(pid);
		}
		this.fragments.clear();
		this.listeners.clear();
		if ((globalThis as any).__rlmPrompt === this) {
			try {
				delete (globalThis as any).__rlmPrompt;
			} catch {
				(globalThis as any).__rlmPrompt = undefined;
			}
		}
	}
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export interface RlmPromptConfig {}

export default RlmPromptService;
export const name = "rlm-prompt";
export const inject = [] as const;
export { RlmPromptService as RlmPrompt };
