/**
 * @rlm/tui — TUI extension service.
 *
 * Cordis Service. Provides extension points so any plugin can add
 * slash commands, status bar items, and custom components to the TUI
 * WITHOUT modifying the core TUI code.
 *
 * When a plugin is hot-swapped or removed, its extensions are
 * automatically unregistered — the TUI rolls back to its core state.
 *
 * Extension points:
 *   - registerSlashCommand(name, handler, description, opts) → handle
 *   - registerStatusBarItem(id, renderer) → handle
 *   - registerComponent(id, component) → handle
 *   - registerUiProvider(pluginId, provider) → handle  // full UI override
 *
 * The TUI (in coding-agent) reads from this service via globalThis.__rlmTui.
 * Plugins register extensions via the service's API.
 *
 * Hot-reload safe:
 *   - Each registration returns a handle with a dispose() method.
 *   - When a plugin's Cordis fiber is disposed, its handles are disposed too.
 *   - The TUI re-renders after each registration/unregistration.
 */
import { Service } from "@deepseek-ai/cordis";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SlashCommandExtension {
	name: string;
	description: string;
	argumentHint?: string;
	takesArgument?: boolean;
	/** Handler called when the user runs this command in the TUI. */
	handler: (args: string, context: TuiCommandContext) => Promise<void> | void;
	/** Plugin that registered this command — used for cleanup. */
	pluginId: string;
}

export interface StatusBarItemExtension {
	id: string;
	/** Returns the text to display in the status bar, or null to hide. */
	renderer: (context: TuiRenderContext) => string | null;
	pluginId: string;
}

export interface ComponentExtension {
	id: string;
	/** Returns lines of text to render, or null to hide. */
	renderer: (context: TuiRenderContext) => string[] | null;
	pluginId: string;
}

export interface TuiCommandContext {
	/** Show a message in the chat area. */
	showMessage: (text: string) => void;
	/** Show an error in the chat area. */
	showError: (text: string) => void;
	/** Request a TUI re-render. */
	requestRender: () => void;
	/** Terminal width. */
	width: number;
}

export interface TuiRenderContext {
	width: number;
	/** Current working directory. */
	cwd: string;
}

export interface ExtensionHandle {
	id: string;
	dispose: () => void;
}

// ─── UI Provider Types ──────────────────────────────────────────────────────

export interface UiEvent {
	type: string;
	payload: any;
	timestamp: number;
}

export interface UiActivationApi {
	requestRender: () => void;
	cwd: string;
}

export interface UiProvider {
	id: string;
	priority: number;
	activate?(api: UiActivationApi): void | Promise<void>;
	deactivate?(): void | Promise<void>;
	onEvent?(event: UiEvent): void;
	render?(ctx: TuiRenderContext): string[] | null;
}

// ─── TUI Service ─────────────────────────────────────────────────────────────

/**
 * Default keybindings for micro-plugins — all overridable via RlmTuiConfig.keybindings.
 * Chordis philosophy: all shortcuts are git-reloadable and configurable.
 */
export const DEFAULT_TUI_KEYBINDINGS: Record<string, string> = {
	"context.toggle": "enter",
	"context.expand": "enter",
	"context.collapse": "enter",
	"context.navUp": "k,ArrowUp",
	"context.navDown": "j,ArrowDown",
	"context.navLeft": "h,ArrowLeft",
	"context.navRight": "l,ArrowRight",
	"context.scrollUp": "ctrl+u,pageup",
	"context.scrollDown": "ctrl+d,pagedown",
	"context.focusNext": "tab,j,ArrowDown",
	"context.focusPrev": "shift+tab,k,ArrowUp",
	"panel.toggleAll": "ctrl+o",
};

export const DEFAULT_TUI_CONFIG: Required<Omit<RlmTuiConfig, "keybindings">> & Pick<RlmTuiConfig, "keybindings"> = {
	followupQueueUi: true,
	doubleEnterToSend: true,
	autoFocusTyping: true,
	hjklNavigation: true,
	keybindings: { ...DEFAULT_TUI_KEYBINDINGS },
};

// Alias mirroring naming in other rlm packages
export const DEFAULT_RLM_TUI_CONFIG = DEFAULT_TUI_CONFIG;

export function resolveRlmTuiConfig(cfg: RlmTuiConfig = {}): Required<RlmTuiConfig> {
	return {
		followupQueueUi: cfg.followupQueueUi ?? true,
		doubleEnterToSend: cfg.doubleEnterToSend ?? true,
		autoFocusTyping: cfg.autoFocusTyping ?? true,
		hjklNavigation: cfg.hjklNavigation ?? true,
		keybindings: { ...DEFAULT_TUI_KEYBINDINGS, ...(cfg.keybindings ?? {}) },
	};
}

export class RlmTuiService extends Service {
	static inject = [] as const;
	static provide = "rlmTui" as const;

	declare config: Required<RlmTuiConfig>;

	/** Slash commands registered by plugins. */
	private slashCommands: Map<string, SlashCommandExtension> = new Map();
	/** Status bar items registered by plugins. */
	private statusItems: Map<string, StatusBarItemExtension> = new Map();
	/** Custom components registered by plugins. */
	private components: Map<string, ComponentExtension> = new Map();
	/** All extension handles by plugin — for cleanup on hot-swap. */
	private handlesByPlugin: Map<string, ExtensionHandle[]> = new Map();
	/** Callback to request a TUI re-render. */
	private renderCallback: (() => void) | null = null;

	/** UI providers registered by plugins — key is `${pluginId}:${provider.id}` */
	private uiProviders: Map<string, UiProvider & { pluginId: string }> = new Map();
	/** Active provider key — computed as max priority */
	private activeProviderKey: string | undefined = undefined;

	/** Generic followup queue micro-plugin (independent of context) */
	private _followupQueue: string[] = [];
	private _lastEnterAt: number = 0;
	private readonly DOUBLE_ENTER_MS = 400;

	constructor(ctx: any, config: RlmTuiConfig = {}) {
		super(ctx, undefined as any);
		const raw = typeof config === "object" && !Array.isArray(config) ? config : {};
		this.config = resolveRlmTuiConfig(raw as RlmTuiConfig);
	}

	async [Service.init]() {
		// Expose the service globally so the TUI (in the coding-agent bundle)
		// can read extensions without importing this package directly.
		(globalThis as any).__rlmTui = this;
		this.ctx.logger?.info("rlm-tui: ready (extension points available)");
	}

	// ─── Render callback ──────────────────────────────────────────────────────

	/** Called by the TUI to register a re-render callback. */
	setRenderCallback(cb: () => void): void {
		this.renderCallback = cb;
	}

	private requestRender(): void {
		this.renderCallback?.();
	}

	private createActivationApi(): UiActivationApi {
		return {
			requestRender: () => this.requestRender(),
			cwd: (this.config as any)?.cwd ?? process.cwd(),
		};
	}

	private computeActiveProviderKey(): string | undefined {
		let bestKey: string | undefined;
		let bestPriority = -Infinity;
		for (const [key, provider] of this.uiProviders) {
			const p = provider.priority ?? 0;
			if (p > bestPriority) {
				bestPriority = p;
				bestKey = key;
			}
		}
		return bestKey;
	}

	// ─── Slash commands ───────────────────────────────────────────────────────

	/**
	 * Register a slash command. Other plugins can add commands to the TUI
	 * without modifying the core TUI code.
	 */
	registerSlashCommand(
		pluginId: string,
		ext: Omit<SlashCommandExtension, "pluginId">,
	): ExtensionHandle {
		this.slashCommands.set(ext.name, { ...ext, pluginId });
		const handle: ExtensionHandle = {
			id: `slash:${ext.name}`,
			dispose: () => {
				this.slashCommands.delete(ext.name);
				this.removeHandle(pluginId, handle);
				this.requestRender();
			},
		};
		this.addHandle(pluginId, handle);
		(this.ctx as any).emit("rlm/tui-register-command", { name: ext.name, pluginId });
		this.requestRender();
		return handle;
	}

	/** Get all registered slash commands. */
	getSlashCommands(): SlashCommandExtension[] {
		return [...this.slashCommands.values()];
	}

	/** Get a specific slash command by name. */
	getSlashCommand(name: string): SlashCommandExtension | undefined {
		return this.slashCommands.get(name);
	}

	// ─── Status bar items ─────────────────────────────────────────────────────

	/**
	 * Register a status bar item. The renderer is called on every TUI render.
	 * Return null from the renderer to hide the item.
	 */
	registerStatusBarItem(
		pluginId: string,
		ext: Omit<StatusBarItemExtension, "pluginId">,
	): ExtensionHandle {
		this.statusItems.set(ext.id, { ...ext, pluginId });
		const handle: ExtensionHandle = {
			id: `status:${ext.id}`,
			dispose: () => {
				this.statusItems.delete(ext.id);
				this.removeHandle(pluginId, handle);
				this.requestRender();
			},
		};
		this.addHandle(pluginId, handle);
		this.requestRender();
		return handle;
	}

	/** Get all registered status bar items. */
	getStatusBarItems(): StatusBarItemExtension[] {
		return [...this.statusItems.values()];
	}

	// ─── Custom components ────────────────────────────────────────────────────

	/**
	 * Register a custom component that renders in the TUI.
	 * The renderer returns lines of text to display.
	 */
	registerComponent(
		pluginId: string,
		ext: Omit<ComponentExtension, "pluginId">,
	): ExtensionHandle {
		this.components.set(ext.id, { ...ext, pluginId });
		const handle: ExtensionHandle = {
			id: `component:${ext.id}`,
			dispose: () => {
				this.components.delete(ext.id);
				this.removeHandle(pluginId, handle);
				this.requestRender();
			},
		};
		this.addHandle(pluginId, handle);
		this.requestRender();
		return handle;
	}

	/** Get all registered custom components. */
	getComponents(): ComponentExtension[] {
		return [...this.components.values()];
	}

	// ─── UI Provider (full replacement) ───────────────────────────────────────

	/**
	 * Register a full UI provider. Highest priority provider becomes active.
	 * When active changes, old provider's deactivate is called, new provider's
	 * activate is called, and rlm/ui-provider-changed is emitted.
	 *
	 * @param pluginId - owning plugin id (used for HMR cleanup and key namespacing)
	 * @param provider - provider descriptor (id required, priority defaults to 0)
	 * @returns handle whose dispose() unregisters the provider and reverts active to next highest
	 */
	registerUiProvider(
		pluginId: string,
		provider: Omit<UiProvider, "pluginId"> & { id: string; priority?: number },
	): ExtensionHandle {
		if (!provider || typeof provider.id !== "string" || provider.id.length === 0) {
			throw new Error("rlm-tui: UiProvider id is required");
		}
		const key = `${pluginId}:${provider.id}`;
		const priority = provider.priority ?? 0;
		const full: UiProvider & { pluginId: string } = {
			id: provider.id,
			priority,
			activate: provider.activate,
			deactivate: provider.deactivate,
			onEvent: provider.onEvent,
			render: provider.render,
			pluginId,
		};

		const oldActiveKey = this.activeProviderKey;
		const oldActive = oldActiveKey ? this.uiProviders.get(oldActiveKey) : undefined;

		this.uiProviders.set(key, full);

		const newActiveKey = this.computeActiveProviderKey();
		const needsSwitch = newActiveKey !== oldActiveKey;

		if (needsSwitch) {
			if (oldActive?.deactivate) {
				try {
					const r = oldActive.deactivate();
					if (r instanceof Promise) r.catch(() => {});
				} catch {}
			}
			const newActive = newActiveKey ? this.uiProviders.get(newActiveKey) : undefined;
			if (newActive?.activate) {
				try {
					const r = newActive.activate(this.createActivationApi());
					if (r instanceof Promise) r.catch(() => {});
				} catch {}
			}
			this.activeProviderKey = newActiveKey ?? undefined;
			try {
				(this.ctx as any).emit("rlm/ui-provider-changed", {
					oldId: oldActive?.id ?? null,
					newId: newActive?.id ?? null,
					oldKey: oldActiveKey ?? null,
					newKey: newActiveKey ?? null,
				});
			} catch {}
			this.requestRender();
		} else if (this.activeProviderKey === key) {
			// Re-registration of active provider without priority change — still request render
			this.requestRender();
		}

		const handle: ExtensionHandle = {
			id: `ui-provider:${key}`,
			dispose: () => {
				const existed = this.uiProviders.get(key);
				// If this key was overwritten by a later registration, the map entry may be different;
				// but we still delete the current entry if it matches this provider id.
				// For simplicity, delete by key and handle active transition if needed.
				const wasActive = this.activeProviderKey === key;
				const deleted = this.uiProviders.delete(key);
				if (!deleted) {
					// Already removed — still clean up handle tracking
					this.removeHandle(pluginId, handle);
					return;
				}
				this.removeHandle(pluginId, handle);
				if (wasActive) {
					if (existed?.deactivate) {
						try {
							const r = existed.deactivate();
							if (r instanceof Promise) r.catch(() => {});
						} catch {}
					}
					const nextKey = this.computeActiveProviderKey();
					const next = nextKey ? this.uiProviders.get(nextKey) : undefined;
					if (next?.activate) {
						try {
							const r = next.activate(this.createActivationApi());
							if (r instanceof Promise) r.catch(() => {});
						} catch {}
					}
					this.activeProviderKey = nextKey ?? undefined;
					try {
						(this.ctx as any).emit("rlm/ui-provider-changed", {
							oldId: existed?.id ?? null,
							newId: next?.id ?? null,
							oldKey: key,
							newKey: nextKey ?? null,
						});
					} catch {}
					this.requestRender();
				}
			},
		};
		this.addHandle(pluginId, handle);
		try {
			(this.ctx as any).emit("rlm/tui-register-ui-provider", { id: provider.id, pluginId, priority, key });
		} catch {}
		return handle;
	}

	/**
	 * Alias for registerUiProvider — allows renderer plugin replacement via
	 * a more explicit name. Same priority/deactivation semantics.
	 */
	registerRendererOverride(
		pluginId: string,
		provider: Omit<UiProvider, "pluginId"> & { id: string; priority?: number },
	): ExtensionHandle {
		return this.registerUiProvider(pluginId, provider);
	}

	/** Get the currently active UI provider (highest priority), if any. */
	getActiveProvider(): (UiProvider & { pluginId: string }) | undefined {
		if (!this.activeProviderKey) return undefined;
		return this.uiProviders.get(this.activeProviderKey);
	}

	/** Get all registered UI providers. */
	getUiProviders(): (UiProvider & { pluginId: string })[] {
		return [...this.uiProviders.values()];
	}

	// ─── Config / keybindings (micro-plugin hot-reloadable) ─────────────────────

	/** Get resolved keybindings (defaults + overrides). Hot-reloadable via config patch. */
	getKeybindings(): Record<string, string> {
		return { ...(this.config.keybindings ?? DEFAULT_TUI_KEYBINDINGS) };
	}

	/** Get a single keybinding value. */
	getKeybinding(action: string): string | undefined {
		return this.getKeybindings()[action];
	}

	/** Update keybindings at runtime (micro-plugin hot-reload). */
	updateKeybindings(patch: Record<string, string>): void {
		this.config.keybindings = { ...this.getKeybindings(), ...patch };
		try { (this.ctx as any).emit("rlm/tui-keybindings-changed", { keybindings: this.config.keybindings }); } catch {}
		this.requestRender();
	}

	/** Update TUI micro-plugin flags at runtime (chordis hot-reload). */
	updateConfig(patch: Partial<RlmTuiConfig>): void {
		this.config = resolveRlmTuiConfig({ ...this.config, ...patch });
		try { (this.ctx as any).emit("rlm/tui-config-changed", { config: this.config }); } catch {}
		this.requestRender();
	}

	/** Get a single flag value (hot-reloadable). */
	getConfig<K extends keyof RlmTuiConfig>(key: K): Required<RlmTuiConfig>[K] {
		return (this.config as any)[key];
	}

	/** Getters for generic micro-plugin flags — chordis hot-reloadable. */
	getFollowupQueueUi(): boolean { return !!this.config.followupQueueUi; }
	getDoubleEnterToSend(): boolean { return !!this.config.doubleEnterToSend; }
	getAutoFocusTyping(): boolean { return !!this.config.autoFocusTyping; }
	getHjklNavigation(): boolean { return !!this.config.hjklNavigation; }
	/** Legacy alias getters */
	isFollowupQueueEnabled(): boolean { return this.getFollowupQueueUi(); }
	isDoubleEnterEnabled(): boolean { return this.getDoubleEnterToSend(); }
	isAutoFocusTypingEnabled(): boolean { return this.getAutoFocusTyping(); }
	isHjklEnabled(): boolean { return this.getHjklNavigation(); }

	// ─── Generic TUI micro-plugins (extracted from rlm-context) ─────────────────

	/** Enqueue a followup text while streaming — generic input queue, not context-specific. */
	enqueueFollowup(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this._followupQueue.push(trimmed);
		try { (this.ctx as any).emit("rlm/followup-enqueued", { text: trimmed, queueLength: this._followupQueue.length }); } catch {}
		try { (this.ctx as any).emit("rlm/context-followup-enqueued", { text: trimmed, queueLength: this._followupQueue.length }); } catch {}
	}

	/** Alias for enqueueFollowup — generic followup service. */
	enqueue(text: string): void { this.enqueueFollowup(text); }

	/** Alias for panelEnqueueFollowup compat. */
	panelEnqueueFollowup(text: string): void { this.enqueueFollowup(text); }

	/** Clear the followup queue and return its contents. */
	clearFollowupQueue(): string[] {
		const q = [...this._followupQueue];
		this._followupQueue.length = 0;
		try { (this.ctx as any).emit("rlm/followup-sent", { count: q.length }); } catch {}
		try { (this.ctx as any).emit("rlm/context-followup-sent", { count: q.length }); } catch {}
		return q;
	}

	/** Alias for clearFollowupQueue. */
	clear(text?: string): string[] { void text; return this.clearFollowupQueue(); }

	/** Alias for clearFollowupQueue — panel compat. */
	panelClearFollowupQueue(): string[] { return this.clearFollowupQueue(); }

	/** Get a copy of the followup queue. */
	getFollowupQueue(): string[] { return [...this._followupQueue]; }

	/** Alias for getFollowupQueue. */
	getQueue(): string[] { return this.getFollowupQueue(); }

	/** Alias. */
	panelGetFollowupQueue(): string[] { return this.getFollowupQueue(); }

	/** Subscribe to double-enter followup-send. Returns disposer. Chordis hot-reloadable. */
	onFollowupSend(cb: (payload: { texts: string[] }) => void): () => void {
		const handler = (payload: any) => cb(payload as { texts: string[] });
		try { (this.ctx as any).on("rlm/followup-send", handler); } catch {}
		return () => { try { (this.ctx as any).off?.("rlm/followup-send", handler); } catch {} };
	}

	/** Alias for onFollowupSend. */
	panelOnFollowupSend(cb: (payload: { texts: string[] }) => void): () => void { return this.onFollowupSend(cb); }

	/**
	 * Handle double-Enter for followup send — generic followup collection.
	 * Returns true if a double-enter send was performed (queue cleared + rlm/followup-send emitted).
	 * Returns false otherwise (first Enter timestamp recorded, or queue empty, or flag disabled).
	 * The caller should fall through to other Enter handling when false (e.g. expand toggle).
	 */
	handleFollowupKey(key: string): boolean {
		if (!this.config.followupQueueUi || !this.config.doubleEnterToSend) return false;
		if (key.toLowerCase() !== "enter") return false;
		if (this._followupQueue.length === 0) return false;
		const now = Date.now();
		if (now - this._lastEnterAt < this.DOUBLE_ENTER_MS) {
			const cleared = this.clearFollowupQueue();
			this._lastEnterAt = 0;
			try { (this.ctx as any).emit("rlm/followup-send", { texts: cleared }); } catch {}
			return true;
		}
		this._lastEnterAt = now;
		return false;
	}

	/** Whether a key should auto-focus the input (generic TUI input behavior). */
	autoFocusShouldFocus(key: string): boolean {
		if (!this.config.autoFocusTyping) return false;
		if (key.length !== 1) return false;
		if (key < " " || key > "~") return false;
		if (key.toLowerCase() === "enter") return false;
		return true;
	}

	/**
	 * Generic hjkl navigation helper — context panel delegates here.
	 * Returns true if key matches the given direction respecting hjklNavigation flag.
	 */
	isNavKey(key: string, dir: "up" | "down" | "left" | "right"): boolean {
		const lower = key.toLowerCase();
		const hjkl = !!this.config.hjklNavigation;
		switch (dir) {
			case "up": return lower === "arrowup" || (hjkl && lower === "k");
			case "down": return lower === "arrowdown" || (hjkl && lower === "j");
			case "left": return lower === "arrowleft" || (hjkl && lower === "h");
			case "right": return lower === "arrowright" || (hjkl && lower === "l");
			default: return false;
		}
	}

	/** Generic registerFollowupQueue shim — for task spec naming. No-op registration, returns disposer. */
	registerFollowupQueue(_opts?: any): { dispose: () => void } {
		return { dispose: () => {} };
	}

	/**
	 * Emit an event to the active UI provider (if it has onEvent) and also
	 * broadcast via ctx.emit("rlm/ui-event", ...) for any Cordis listener.
	 * The renderer will use this to forward session/agent events.
	 */
	emitEvent(type: string, payload: any): void {
		const timestamp = Date.now();
		const event: UiEvent = { type, payload, timestamp };
		const active = this.getActiveProvider();
		if (active?.onEvent) {
			try {
				active.onEvent(event);
			} catch {}
		}
		try {
			(this.ctx as any).emit("rlm/ui-event", event);
		} catch {}
	}

	// ─── Plugin cleanup ───────────────────────────────────────────────────────

	/**
	 * Remove all extensions registered by a plugin.
	 * Called automatically when a plugin is hot-swapped or removed.
	 */
	disposePlugin(pluginId: string): void {
		const handles = this.handlesByPlugin.get(pluginId);
		if (!handles) return;
		// Copy the array before disposing — dispose() modifies the original array.
		const toDispose = [...handles];
		this.handlesByPlugin.delete(pluginId);
		for (const handle of toDispose) {
			try { handle.dispose(); } catch {}
		}
		(this.ctx as any).emit("rlm/tui-dispose-plugin", { pluginId });
	}

	/** Check if a plugin has any active extensions. */
	hasExtensions(pluginId: string): boolean {
		return (this.handlesByPlugin.get(pluginId)?.length ?? 0) > 0;
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────

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
	}

	async [Symbol.dispose]() {
		// Deactivate active provider if any
		const active = this.getActiveProvider();
		if (active?.deactivate) {
			try {
				const r = active.deactivate();
				if (r instanceof Promise) await r.catch(() => {});
			} catch {}
		}
		// Clear generic followup queue micro-plugin state
		this._followupQueue.length = 0;
		this._lastEnterAt = 0;
		// Dispose all extensions on shutdown.
		for (const handles of this.handlesByPlugin.values()) {
			for (const handle of handles) {
				try { handle.dispose(); } catch {}
			}
		}
		this.handlesByPlugin.clear();
		this.uiProviders.clear();
		this.activeProviderKey = undefined;
		if ((globalThis as any).__rlmTui === this) {
			try {
				delete (globalThis as any).__rlmTui;
			} catch {
				(globalThis as any).__rlmTui = undefined;
			}
		}
	}
}

// ─── Config (chordis hot-reloadable micro-plugin flags) ─────────────────────────

export const DEFAULT_TUI_FLAGS = {
	followupQueueUi: true,
	doubleEnterToSend: true,
	autoFocusTyping: true,
	hjklNavigation: true,
} as const;

// ─── Exports ─────────────────────────────────────────────────────────────────

export interface RlmTuiConfig {
	/** Show followup queue UI when input is queued while streaming. Generic TUI, not context-specific. */
	followupQueueUi?: boolean;
	/** Double-Enter within DOUBLE_ENTER_MS sends the followup queue. */
	doubleEnterToSend?: boolean;
	/** Any printable key (except Enter) auto-focuses the TUI input. */
	autoFocusTyping?: boolean;
	/** hjkl keys navigate lists; when false only arrows navigate. */
	hjklNavigation?: boolean;
	/** Overridable keybindings for micro-plugins — defaults to DEFAULT_TUI_KEYBINDINGS. */
	keybindings?: Record<string, string>;
}

export default RlmTuiService;
export const name = "rlm-tui";
export const inject = [] as const;
export { RlmTuiService as RlmTui };
