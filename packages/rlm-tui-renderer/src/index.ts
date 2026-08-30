/**
 * @rlm/tui-renderer — InteractiveMode TUI as a Cordis Service.
 *
 * Wraps the coding-agent InteractiveMode behind a service. Creates the full
 * agent runtime (AgentSessionRuntime → InProcessAgentConnection →
 * InteractiveMode) via the rlmAgent service. No fallbacks. No direct
 * coding-agent imports beyond the mode constructors.
 *
 * Depends on:
 * - @rlm/agent (rlmAgent) for createRuntime()
 *
 * Full-replacement support:
 * - Reads active UiProvider via rlmTui.getActiveProvider() (from globalThis.__rlmTui or ctx.get("rlmTui")).
 * - If a provider with `render` exists, it logically owns rendering; currently we log and
 *   still create InteractiveMode but forward all session events to the provider via
 *   rlmTui.emitEvent(). A future provider can fully replace InteractiveMode without
 *   process restart.
 * - Forwards AgentSession events to the active provider and emits ctx "rlm/ui-event".
 * - Listens to "rlm/ui-provider-changed" for hot-swap without restart.
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import {
	InteractiveMode,
	type InteractiveModeOptions,
	type InteractiveModeRunResult,
} from "../../coding-agent/src/modes/interactive/interactive-mode.js";
import {
	createInteractiveModeLocalSessionHost,
} from "../../coding-agent/src/modes/interactive/interactive-mode-services.js";
import {
	InProcessAgentConnection,
	ClientPromptStashStore,
} from "../../coding-agent/src/modes/index.js";
import { initTheme, preloadCodeHighlighter } from "../../coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentSessionRuntime } from "../../coding-agent/src/core/agent-session-runtime.js";

export interface RlmRendererConfig {
	cwd?: string;
}

export interface RlmRendererStartOptions {
	/** Initial message to send on startup (e.g. from --print or -p flag). */
	initialMessage?: string;
	/** Additional text-only messages to send after the initial message. */
	initialMessages?: string[];
	/** Force verbose startup. */
	verbose?: boolean;
}

export class RlmRendererService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmRenderer" as const;

	declare config: RlmRendererConfig;

	private instance: InteractiveMode | undefined;
	private runtime: AgentSessionRuntime | undefined;

	/** Unsubscribe for session event forwarding */
	private sessionEventUnsub: (() => void) | undefined;
	/** Unsubscribe for provider-changed listener */
	private providerChangedUnsub: (() => void) | undefined;
	/** Unsubscribe for tui config hot-reload */
	private tuiConfigUnsub: (() => void) | undefined;
	/** Unsubscribe for followup-send forwarding */
	private followupSendUnsub: (() => void) | undefined;

	constructor(ctx: any, config: RlmRendererConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	/** Try to get the rlmTui service via Cordis ctx or globalThis fallback. */
	public getTui(): any {
		try {
			const tui = this.ctx.get("rlmTui");
			if (tui) return tui;
		} catch {}
		return (globalThis as any).__rlmTui;
	}

	/**
	 * Forward an event to the active UI provider via rlmTui.emitEvent.
	 * Also safe when no provider exists — still emits "rlm/ui-event" for any listener.
	 */
	forwardEvent(type: string, payload: any): void {
		const tui = this.getTui();
		if (tui?.emitEvent) {
			try {
				tui.emitEvent(type, payload);
			} catch {}
		} else {
			// No tui service — still broadcast via ctx for listeners
			try {
				(this.ctx as any).emit("rlm/ui-event", { type, payload, timestamp: Date.now() });
			} catch {}
		}
	}

	async [Service.init]() {
		const cwd = this.config.cwd ?? process.cwd();
		const tui = this.getTui();
		const active = tui?.getActiveProvider?.();
		if (active) {
			this.ctx.logger?.info(
				`rlm-tui-renderer: ready (cwd=${cwd}, active UI provider=${active.id} prio=${active.priority})`,
			);
			if (active.render) {
				this.ctx.logger?.info(`rlm-tui-renderer: provider ${active.id} has render — will own UI`);
			}
		} else {
			this.ctx.logger?.info(`rlm-tui-renderer: ready (cwd=${cwd})`);
		}

		// Listen for provider hot-swap while running — log and optionally handle.
		try {
			const off = (this.ctx as any).on("rlm/ui-provider-changed", (payload: any) => {
				const newId = payload?.newId ?? payload?.newKey ?? "none";
				const oldId = payload?.oldId ?? payload?.oldKey ?? "none";
				this.ctx.logger?.info(`rlm-tui-renderer: UI provider changed ${oldId} → ${newId}`);
				// If a provider with render becomes active while InteractiveMode is running,
				// we could hot-swap by tearing down InteractiveMode and activating the provider.
				// For minimal implementation, just log. The provider's activate() already ran
				// in rlmTui, and events will forward via forwardEvent. A full replacement
				// would stop InteractiveMode here and let the provider take over.
				if (this.instance) {
					this.ctx.logger?.info(`rlm-tui-renderer: provider changed during InteractiveMode — forwarding continues`);
				}
			});
			// Cordis ctx.on may return an off function or a dispose object; normalize
			if (typeof off === "function") {
				this.providerChangedUnsub = off as () => void;
			} else if (off && typeof (off as any).dispose === "function") {
				this.providerChangedUnsub = () => (off as any).dispose();
			} else if (off && typeof (off as any).off === "function") {
				this.providerChangedUnsub = () => (off as any).off();
			} else {
				// Fallback: try ctx.off
				this.providerChangedUnsub = () => {
					try { (this.ctx as any).off?.("rlm/ui-provider-changed"); } catch {}
				};
			}
			// Register effect cleanup if available — Cordis ctx.effect will dispose on fiber dispose
			try {
				if (this.ctx.effect) {
					this.ctx.effect(() => () => {
						try { this.providerChangedUnsub?.(); } catch {}
					});
				}
			} catch {}
		} catch {}
		// ── Followup queue + config hot-reload (chordis) ──
		try {
			const offFollowup = (this.ctx as any).on("rlm/followup-send", (payload: any) => {
				try { this.forwardEvent("rlm/followup-send", payload); } catch {}
				if (this.instance) {
					try { (this.instance as any).renderRlmTuiPanel?.(); } catch {}
					try { (this.instance as any).ui?.requestRender?.(); } catch {}
				}
			});
			if (typeof offFollowup === "function") this.followupSendUnsub = offFollowup as () => void;
			else if (offFollowup && typeof (offFollowup as any).dispose === "function") this.followupSendUnsub = () => (offFollowup as any).dispose();
			else this.followupSendUnsub = () => { try { (this.ctx as any).off?.("rlm/followup-send"); } catch {} };
			try {
				if (this.ctx.effect) {
					this.ctx.effect(() => () => { try { this.followupSendUnsub?.(); } catch {} });
				}
			} catch {}
		} catch {}
		try {
			const offCfg = (this.ctx as any).on("rlm/tui-config-changed", (payload: any) => {
				this.ctx.logger?.info(`rlm-tui-renderer: tui config changed`);
				try { this.forwardEvent("rlm/tui-config-changed", payload); } catch {}
				if (this.instance) {
					try { (this.instance as any).renderRlmTuiPanel?.(); } catch {}
					try { (this.instance as any).ui?.requestRender?.(); } catch {}
				}
			});
			if (typeof offCfg === "function") this.tuiConfigUnsub = offCfg as () => void;
			else if (offCfg && typeof (offCfg as any).dispose === "function") this.tuiConfigUnsub = () => (offCfg as any).dispose();
			else this.tuiConfigUnsub = () => { try { (this.ctx as any).off?.("rlm/tui-config-changed"); } catch {} };
			try {
				if (this.ctx.effect) {
					this.ctx.effect(() => () => { try { this.tuiConfigUnsub?.(); } catch {} });
				}
			} catch {}
		} catch {}
		try {
			const offComp = (this.ctx as any).on("rlm/tui-register-component", () => {
				if (this.instance) {
					try { (this.instance as any).renderRlmTuiPanel?.(); } catch {}
					try { (this.instance as any).ui?.requestRender?.(); } catch {}
				}
			});
			if (typeof offComp === "function") {
				const prev = this.tuiConfigUnsub;
				this.tuiConfigUnsub = () => { try { prev?.(); } catch {} try { (offComp as any)(); } catch {} };
			} else if (offComp && typeof (offComp as any).dispose === "function") {
				const prev = this.tuiConfigUnsub;
				this.tuiConfigUnsub = () => { try { prev?.(); } catch {} try { (offComp as any).dispose(); } catch {} };
			}
		} catch {}
		try {
			const offKey = (this.ctx as any).on("rlm/tui-keybindings-changed", (payload: any) => {
				try { this.forwardEvent("rlm/tui-keybindings-changed", payload); } catch {}
				if (this.instance) {
					try { (this.instance as any).ui?.requestRender?.(); } catch {}
				}
			});
			if (typeof offKey === "function") {
				const prev = this.tuiConfigUnsub;
				this.tuiConfigUnsub = () => { try { prev?.(); } catch {} try { (offKey as any)(); } catch {} };
			} else if (offKey && typeof (offKey as any).dispose === "function") {
				const prev = this.tuiConfigUnsub;
				this.tuiConfigUnsub = () => { try { prev?.(); } catch {} try { (offKey as any).dispose(); } catch {} };
			}
		} catch {}
	}

	/**
	 * Create the full agent runtime and launch InteractiveMode.
	 * No fallbacks — if the runtime or UI fails, the error propagates.
	 */
	async start(opts: RlmRendererStartOptions = {}): Promise<InteractiveModeRunResult> {
		if (this.instance) {
			throw new Error("rlm-tui-renderer: InteractiveMode already running");
		}

		const rlmAgent = this.ctx.get("rlmAgent") as {
			createRuntime: (options: {
				sessionConfig?: Record<string, unknown>;
				sessionOptions?: Record<string, unknown>;
			}) => Promise<AgentSessionRuntime>;
		};

		if (!rlmAgent?.createRuntime) {
			throw new Error("rlm-tui-renderer: rlmAgent.createRuntime not available");
		}

		// Check for active provider that wants to own rendering.
		const tui = this.getTui();
		const active = tui?.getActiveProvider?.();
		if (active?.render) {
			this.ctx.logger?.info(
				`rlm-tui-renderer: active provider ${active.id} (prio ${active.priority}) has render — provider would own UI; currently falling back to InteractiveMode with event forwarding`,
			);
			// Emit that provider is active for observability
			try {
				tui.emitEvent?.("rlm/renderer-provider-active", { providerId: active.id, priority: active.priority });
			} catch {}
			// Full replacement path (future): if provider wishes to fully own rendering,
			// we would NOT create InteractiveMode but instead run provider lifecycle:
			//   await active.activate({ requestRender: () => {}, cwd: process.cwd() })
			//   // then subscribe session events and let provider.render() drive terminal
			// For minimal implementation, we still create InteractiveMode below and forward events.
		}

		// Create the full agent runtime via the rlmAgent service.
		this.runtime = await rlmAgent.createRuntime({});

		// Wire up event forwarding: pipe AgentSession events to the active UI provider
		// via rlmTui.emitEvent. This lets a hot-reloadable provider receive all events
		// without modifying InteractiveMode.
		try {
			// The runtime's session is the AgentSession; its subscribe method forwards all AgentSessionEvents.
			const maybeSession: any = (this.runtime as any).session;
			if (maybeSession?.subscribe && tui?.emitEvent) {
				this.sessionEventUnsub = maybeSession.subscribe((event: any) => {
					try {
						tui.emitEvent(event.type, event);
					} catch {}
					// Also forward as generic ui-event for renderer listeners
				});
				this.ctx.logger?.info(`rlm-tui-renderer: forwarding AgentSession events to UI provider via rlmTui.emitEvent`);
			} else if (maybeSession?.subscribe) {
				// No tui — still subscribe to avoid dropping, but just emit via ctx
				this.sessionEventUnsub = maybeSession.subscribe((event: any) => {
					try { (this.ctx as any).emit("rlm/ui-event", { type: event.type, payload: event, timestamp: Date.now() }); } catch {}
				});
			}
		} catch (e) {
			this.ctx.logger?.warn(`rlm-tui-renderer: session event forwarding setup failed: ${(e as any)?.message ?? e}`);
		}

		// Initialize theme before creating InteractiveMode — the TUI
		// proxy-guards `theme` and throws if initTheme() wasn't called.
		const settingsManager = this.runtime.services.settingsManager;
		initTheme(settingsManager.getTheme(), true);
		await preloadCodeHighlighter();

		// Wire up the in-process agent connection + local session host.
		const connection = new InProcessAgentConnection(this.runtime);
		const localSessionHost = createInteractiveModeLocalSessionHost(this.runtime);
		const promptStashStore = new ClientPromptStashStore();

		const interactiveOptions: InteractiveModeOptions = {
			agentConnection: connection,
			localSessionHost,
			promptStashStore,
			promptStashSessionId: this.runtime.session.sessionId,
			bindLocalSessionExtensions: true,
			initialMessage: opts.initialMessage,
			initialMessages: opts.initialMessages,
			verbose: opts.verbose,
		};

		this.instance = new InteractiveMode(interactiveOptions);
		const result = await this.instance.run();

		// Cleanup forwarding after InteractiveMode exits
		try { this.sessionEventUnsub?.(); } catch {}
		this.sessionEventUnsub = undefined;

		return result;
	}

	/**
	 * Stop the InteractiveMode and dispose the runtime.
	 */
	async stop(): Promise<void> {
		try { this.sessionEventUnsub?.(); } catch {}
		this.sessionEventUnsub = undefined;
		try { this.providerChangedUnsub?.(); } catch {}
		this.providerChangedUnsub = undefined;
		try { this.tuiConfigUnsub?.(); } catch {}
		this.tuiConfigUnsub = undefined;
		try { this.followupSendUnsub?.(); } catch {}
		this.followupSendUnsub = undefined;
		if (this.instance) {
			this.instance.stop();
			this.instance = undefined;
		}
		if (this.runtime) {
			await this.runtime.dispose?.();
			this.runtime = undefined;
		}
	}

	async [Symbol.dispose]() {
		try { this.sessionEventUnsub?.(); } catch {}
		this.sessionEventUnsub = undefined;
		try { this.providerChangedUnsub?.(); } catch {}
		this.providerChangedUnsub = undefined;
		try { this.tuiConfigUnsub?.(); } catch {}
		this.tuiConfigUnsub = undefined;
		try { this.followupSendUnsub?.(); } catch {}
		this.followupSendUnsub = undefined;
		if (this.instance) {
			try { this.instance.stop(); } catch {}
			this.instance = undefined;
		}
		if (this.runtime) {
			try { await this.runtime.dispose?.(); } catch {}
			this.runtime = undefined;
		}
	}
}

export default RlmRendererService;
export const name = "rlm-tui-renderer";
export const inject = ["rlmAgent"] as const;
export { RlmRendererService as RlmRenderer };
export type { InteractiveModeOptions, InteractiveModeRunResult };
