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

// ─── TUI Service ─────────────────────────────────────────────────────────────

export class RlmTuiService extends Service {
	static inject = [] as const;
	static provide = "rlmTui" as const;

	declare config: RlmTuiConfig;

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

	constructor(ctx: any, config: RlmTuiConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
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
		this.ctx.emit("rlm/tui-register-command", { name: ext.name, pluginId });
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
		this.ctx.emit("rlm/tui-dispose-plugin", { pluginId });
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
		// Dispose all extensions on shutdown.
		for (const handles of this.handlesByPlugin.values()) {
			for (const handle of handles) handle.dispose();
		}
		this.handlesByPlugin.clear();
	}
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export interface RlmTuiConfig {}

export default RlmTuiService;
export const name = "rlm-tui";
export const inject = [] as const;
export { RlmTuiService as RlmTui };
