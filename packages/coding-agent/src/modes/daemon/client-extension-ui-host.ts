/**
 * Client-side extension UI host for daemon-mode chats.
 *
 * In daemon mode the agent session — and with it every extension — runs in a
 * worker process. Most of an extension's UI crosses the socket fine
 * (notify, setStatus, array widgets, dialogs), but anything that is a function
 * cannot: setFooter/setHeader factories, setEditorComponent, custom(),
 * function-form setWidget, onTerminalInput, autocomplete providers, and the
 * tool/message renderers the chat draws with. Upstream prime-agent v0.9.6
 * simply drops those in daemon mode (daemon-extension-binding.ts no-ops them).
 *
 * This host loads the same file-based extensions a second time, in the
 * client, for their UI only:
 *
 * - Events come from the daemon's session event stream, mapped exactly as
 *   AgentSession maps agent events for its own runner.
 * - Side effects are no-ops here (sendMessage, appendEntry, setModel, tool and
 *   provider registration…): the worker's instance of the same extension
 *   already performs them. Tools and commands stay in the worker.
 * - UI calls made from event handlers pass through only for the methods the
 *   worker cannot deliver, so nothing is shown twice. Shortcut handlers run
 *   only here, so they get the full UI.
 * - ctx.sessionManager is the session file opened read-only and re-parsed
 *   when it changes on disk, so extensions that replay state from the branch
 *   (rpiv-todo) see what the worker wrote.
 * - Extension files are watched; an edit reloads the client instances live
 *   (session_shutdown "reload" → re-import → session_start "reload").
 *
 * rlm's own Cordis rows are NOT loaded here: they already run in this
 * process (e.g. thinking-steps patches the client's renderer itself).
 */
import { type FSWatcher, statSync, watch } from "node:fs";
import { dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { KeybindingsConfig } from "../../core/keybindings.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import { DefaultResourceLoader } from "../../core/resource-loader.js";
import { SessionManager } from "../../core/session-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type { ExtensionError, ExtensionUIContext } from "../../core/extensions/index.js";
import { ExtensionRunner, emitSessionShutdownEvent } from "../../core/extensions/runner.js";
import type { ContextUsage, MessageRenderer, SessionStartEvent } from "../../core/extensions/types.js";

type ThinkingLevel = string;

export interface ClientExtensionUiHostDeps {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	/** The chat's full UI context (InteractiveMode.createExtensionUIContext). */
	ui: ExtensionUIContext;
	getSessionFile(): string | undefined;
	getModel(): Model<any> | undefined;
	getThinkingLevel(): ThinkingLevel;
	isIdle(): boolean;
	abort(): void;
	getContextUsage(): ContextUsage | undefined;
	onError(error: ExtensionError): void;
	/** Called after a (re)load so the chat can refresh renderers/shortcuts and repaint. */
	onLoaded?(): void;
	/** Watch extension files and reload on change (default true). */
	watch?: boolean;
}

/** Methods whose effect cannot cross the socket, so the worker never delivers them. */
const CLIENT_ONLY_UI = new Set<string>([
	"onTerminalInput",
	"setFooter",
	"setHeader",
	"custom",
	"addAutocompleteProvider",
	"setEditorComponent",
	"getEditorComponent",
	"getEditorText",
	"getAllThemes",
	"getTheme",
	"setTheme",
	"getToolsExpanded",
	"setToolsExpanded",
]);

/** Fallbacks for methods the worker delivers; returned so client handlers never block. */
const WORKER_DELIVERED_FALLBACK: Record<string, unknown> = {
	select: undefined,
	confirm: false,
	input: undefined,
	editor: undefined,
};

type SessionEventLike = { type: string; [key: string]: any };

const HMR_PATCHED = Symbol.for("rlm.hmr.patched");

export class ClientExtensionUiHost {
	private runner?: ExtensionRunner;
	private sessionManager?: SessionManager;
	private sessionFileStamp = "";
	private queue: Promise<void> = Promise.resolve();
	private turnIndex = 0;
	private watchers: FSWatcher[] = [];
	private reloadTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private reloading?: Promise<void>;
	/** What the client instances put on screen, so a reload/dispose can take it down. */
	private footerSet = false;
	private headerSet = false;
	private editorSet = false;
	private widgetKeys = new Set<string>();
	private terminalInputUnsubs = new Set<() => void>();
	/** Visible for tests: session_start/shutdown reasons emitted, in order. */
	readonly lifecycle: string[] = [];

	private constructor(private deps: ClientExtensionUiHostDeps) {
		((globalThis as any).__rlmHmrLive ??= new Set()).add(new WeakRef(this));
	}

	static async start(
		deps: ClientExtensionUiHostDeps,
		reason: SessionStartEvent["reason"] = "startup",
	): Promise<ClientExtensionUiHost> {
		const host = new ClientExtensionUiHost(deps);
		await host.load(reason);
		if (deps.watch !== false) host.watchExtensionFiles();
		return host;
	}

	/** Extension paths currently loaded (for diagnostics/tests). */
	getExtensionPaths(): string[] {
		return this.runner?.getExtensionPaths() ?? [];
	}

	getToolRendererDefinition(
		toolName: string,
	): { renderCall?: any; renderResult?: any; renderShell?: any } | undefined {
		const definition = this.runner?.getToolDefinition(toolName);
		if (!definition) return undefined;
		const out: { renderCall?: any; renderResult?: any; renderShell?: any } = {};
		if ((definition as any).renderCall) out.renderCall = (definition as any).renderCall;
		if ((definition as any).renderResult) out.renderResult = (definition as any).renderResult;
		if ((definition as any).renderShell) out.renderShell = (definition as any).renderShell;
		return Object.keys(out).length > 0 ? out : undefined;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		return this.runner?.getMessageRenderer(customType);
	}

	/** Runs a matching extension shortcut with the full UI. Returns true when handled. */
	handleShortcut(data: string, keybindings: KeybindingsConfig): boolean {
		const runner = this.runner;
		if (!runner) return false;
		for (const [key, shortcut] of runner.getShortcuts(keybindings)) {
			if (!matchesKey(data, key as KeyId)) continue;
			const ctx = { ...runner.createContext(), ui: this.deps.ui, hasUI: true };
			Promise.resolve(shortcut.handler(ctx as any)).catch((error) =>
				this.deps.onError({
					extensionPath: shortcut.extensionPath ?? "<shortcut>",
					event: "shortcut",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				}),
			);
			return true;
		}
		return false;
	}

	/** Feed one daemon `session_event` payload. Serialized; never throws. */
	handleSessionEvent(event: SessionEventLike): void {
		this.queue = this.queue.then(() => this.dispatch(event)).catch(() => {});
	}

	/** Resolves once every queued event has been delivered (tests). */
	idle(): Promise<void> {
		return this.queue;
	}

	async reload(): Promise<void> {
		if (this.disposed) return;
		if (this.reloading) return this.reloading;
		this.reloading = (async () => {
			await this.queue;
			await this.shutdownRunner("reload");
			await this.load("reload");
		})().finally(() => {
			this.reloading = undefined;
		});
		return this.reloading;
	}

	async dispose(reason: "quit" | "new" | "resume" | "fork" = "quit"): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		for (const w of this.watchers) {
			try {
				w.close();
			} catch {}
		}
		this.watchers = [];
		await this.queue.catch(() => {});
		await this.shutdownRunner(reason);
	}

	/** rlm-hmr after-patch hook: new code for this module — reload the instances under it. */
	async [HMR_PATCHED](_info?: unknown): Promise<void> {
		await this.reload();
	}

	private async load(reason: SessionStartEvent["reason"]): Promise<void> {
		const { cwd, agentDir, settingsManager, modelRegistry } = this.deps;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getExtensions();
		for (const error of result.errors) {
			this.deps.onError({ extensionPath: error.path, event: "load", error: error.error });
		}
		const runner = new ExtensionRunner(result.extensions, result.runtime, cwd, this.readSessionManager(), modelRegistry);
		const noop = () => {};
		runner.bindCore(
			{
				sendMessage: noop,
				sendUserMessage: noop,
				appendEntry: noop,
				setSessionName: noop,
				getSessionName: () => this.sessionManager?.getSessionName?.(),
				setLabel: noop,
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: noop,
				refreshTools: noop,
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => this.deps.getThinkingLevel() as any,
				setThinkingLevel: noop,
			} as any,
			{
				getModel: () => this.deps.getModel(),
				isIdle: () => this.deps.isIdle(),
				getSignal: () => undefined,
				abort: () => this.deps.abort(),
				hasPendingMessages: () => false,
				shutdown: noop,
				getContextUsage: () => this.deps.getContextUsage(),
				compact: noop,
				getSystemPrompt: () => "",
			},
			{ registerProvider: noop, unregisterProvider: noop },
		);
		runner.setUIContext(this.createEventUiContext());
		runner.onError((error) => this.deps.onError(error));
		this.runner = runner;
		this.turnIndex = 0;
		this.lastLeafId = (this.sessionManager as any)?.getLeafId?.() ?? null;
		this.lifecycle.push(`start:${reason}`);
		await runner.emit({ type: "session_start", reason } as SessionStartEvent);
		this.deps.onLoaded?.();
	}

	private async shutdownRunner(reason: "quit" | "reload" | "new" | "resume" | "fork"): Promise<void> {
		const runner = this.runner;
		if (!runner) return;
		this.lifecycle.push(`shutdown:${reason}`);
		try {
			await emitSessionShutdownEvent(runner, { type: "session_shutdown", reason });
		} catch {}
		try {
			runner.shutdown();
		} catch {}
		this.runner = undefined;
		this.clearClientSurfaces();
	}

	/** Take down whatever the client instances put on screen. */
	private clearClientSurfaces(): void {
		const ui = this.deps.ui;
		for (const unsub of this.terminalInputUnsubs) {
			try {
				unsub();
			} catch {}
		}
		this.terminalInputUnsubs.clear();
		if (this.footerSet) ui.setFooter(undefined as any);
		if (this.headerSet) ui.setHeader(undefined as any);
		if (this.editorSet) ui.setEditorComponent(undefined as any);
		for (const key of this.widgetKeys) ui.setWidget(key, undefined);
		this.footerSet = this.headerSet = this.editorSet = false;
		this.widgetKeys.clear();
	}

	/**
	 * UI for event handlers: client-only methods pass through (and are tracked
	 * for cleanup); everything the worker already delivers is dropped here.
	 * Delegates at call time so a hot patch of this module applies at once.
	 */
	private createEventUiContext(): ExtensionUIContext {
		return new Proxy({} as ExtensionUIContext, {
			get: (_target, prop) => {
				if (prop === "theme") return this.deps.ui.theme;
				if (typeof prop !== "string") return undefined;
				return (...args: unknown[]) => this.forwardEventUi(prop, args);
			},
		});
	}

	private forwardEventUi(method: string, args: unknown[]): unknown {
		const ui = this.deps.ui as any;
		if (method === "setWidget") {
			const [key, content] = args as [string, unknown];
			// Array/string-line widgets are delivered by the worker; only factories are ours.
			if (typeof content === "function") {
				this.widgetKeys.add(key);
				return ui.setWidget(...args);
			}
			if (content === undefined && this.widgetKeys.has(key)) {
				this.widgetKeys.delete(key);
				return ui.setWidget(...args);
			}
			return undefined;
		}
		if (!CLIENT_ONLY_UI.has(method)) {
			return method in WORKER_DELIVERED_FALLBACK ? Promise.resolve(WORKER_DELIVERED_FALLBACK[method]) : undefined;
		}
		if (method === "setFooter") this.footerSet = args[0] !== undefined;
		if (method === "setHeader") this.headerSet = args[0] !== undefined;
		if (method === "setEditorComponent") this.editorSet = args[0] !== undefined;
		const result = ui[method]?.(...args);
		if (method === "onTerminalInput" && typeof result === "function") {
			const unsub = result as () => void;
			this.terminalInputUnsubs.add(unsub);
			return () => {
				this.terminalInputUnsubs.delete(unsub);
				unsub();
			};
		}
		return result;
	}

	/** The session file, read-only, re-parsed only when it changed on disk. */
	private readSessionManager(): SessionManager {
		const file = this.deps.getSessionFile();
		if (!file) {
			this.sessionManager = SessionManager.inMemory(this.deps.cwd);
			this.sessionFileStamp = "";
			return this.sessionManager;
		}
		this.sessionManager = SessionManager.open(file);
		this.sessionFileStamp = this.stamp(file);
		const host = this;
		// Re-parse lazily on read; writes are blocked (the worker owns the file).
		return new Proxy(this.sessionManager, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				const name = String(prop);
				if (/^(append|set|add|remove|delete|record|create|branch|fork|write|save|flush)/.test(name)) {
					return () => undefined;
				}
				return (...args: unknown[]) => {
					host.refreshSessionManager(target);
					return value.apply(target, args);
				};
			},
		});
	}

	private refreshSessionManager(target: SessionManager): void {
		const file = this.deps.getSessionFile();
		if (!file) return;
		const stamp = this.stamp(file);
		if (stamp === this.sessionFileStamp) return;
		this.sessionFileStamp = stamp;
		try {
			(target as any).setSessionFile(file);
		} catch {}
	}

	private stamp(file: string): string {
		try {
			const s = statSync(file);
			return `${s.size}:${s.mtimeMs}`;
		} catch {
			return "";
		}
	}

	private async dispatch(event: SessionEventLike): Promise<void> {
		const runner = this.runner;
		if (!runner || this.disposed) return;
		try {
			switch (event.type) {
				case "agent_start":
					this.turnIndex = 0;
					await runner.emit({ type: "agent_start" } as any);
					break;
				case "agent_end":
					await runner.emit({ type: "agent_end", messages: event.messages } as any);
					await this.syncFromDisk();
					break;
				case "turn_start":
					await runner.emit({ type: "turn_start", turnIndex: this.turnIndex, timestamp: Date.now() } as any);
					break;
				case "turn_end":
					await runner.emit({
						type: "turn_end",
						turnIndex: this.turnIndex,
						message: event.message,
						toolResults: event.toolResults,
					} as any);
					this.turnIndex++;
					break;
				case "message_start":
					await runner.emit({ type: "message_start", message: event.message } as any);
					break;
				case "message_update":
					await runner.emit({
						type: "message_update",
						message: event.message,
						assistantMessageEvent: event.assistantMessageEvent,
					} as any);
					break;
				case "message_end":
					// Replacement results are the worker's call; the client only observes.
					await runner.emitMessageEnd({ type: "message_end", message: event.message } as any);
					// A tool ran in the worker, not here, so state a tool mutates in
					// memory (rpiv-todo's list) never changed in these instances. By
					// message_end the result is on disk: tell them the leaf moved so
					// extensions that rebuild from the branch catch up.
					if (event.message?.role === "toolResult") await this.syncFromDisk();
					break;
				case "tool_execution_start":
					await runner.emit({
						type: "tool_execution_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					} as any);
					break;
				case "tool_execution_update":
					await runner.emit({
						type: "tool_execution_update",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						partialResult: event.partialResult,
					} as any);
					break;
				case "tool_execution_end":
					await runner.emit({
						type: "tool_execution_end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
					} as any);
					break;
				case "compaction_end":
				case "session_compact":
					if (runner.hasHandlers("session_compact")) await runner.emit({ type: "session_compact" } as any);
					break;
				default:
					break;
			}
		} catch (error) {
			this.deps.onError({
				extensionPath: "<client-ui-host>",
				event: event.type,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * The worker appended to the session file: emit `session_tree` for the moved
	 * leaf so client instances replay from the branch (the event extensions
	 * already use to rebuild state after the branch changes under them).
	 */
	private async syncFromDisk(): Promise<void> {
		const runner = this.runner;
		const sm = this.sessionManager;
		if (!runner || !sm || !runner.hasHandlers("session_tree")) return;
		const oldLeafId = this.lastLeafId ?? null;
		this.refreshSessionManager(sm);
		const newLeafId = (sm as any).getLeafId?.() ?? null;
		if (newLeafId === oldLeafId) return;
		this.lastLeafId = newLeafId;
		await runner.emit({ type: "session_tree", newLeafId, oldLeafId, fromExtension: false } as any);
	}

	private lastLeafId: string | null | undefined;

	private watchExtensionFiles(): void {
		const dirs = new Set<string>();
		for (const p of this.getExtensionPaths()) {
			// An extension is a file or an index inside a package dir; watch its directory tree.
			dirs.add(dirname(p));
		}
		dirs.add(`${this.deps.agentDir}/extensions`);
		dirs.add(`${this.deps.cwd}/.rlm/agent/extensions`);
		for (const dir of dirs) {
			try {
				const w = watch(dir, { recursive: true }, (_evt, filename) => {
					if (filename && /(^|\/)node_modules(\/|$)|\.git(\/|$)/.test(String(filename))) return;
					this.scheduleReload();
				});
				this.watchers.push(w);
			} catch {
				/* missing dir: nothing to watch */
			}
		}
	}

	private scheduleReload(): void {
		if (this.disposed) return;
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = undefined;
			void this.reload();
		}, 200);
		this.reloadTimer.unref?.();
	}
}
