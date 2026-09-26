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
/**
 * Types only, on purpose — the values arrive in `start()`.
 *
 * This row injects `rlmLive`, so in an unwatched run its fiber never leaves
 * PENDING. That parks its *effects*, not its *imports*: cordis's loader has to
 * `import()` the module to get a plugin object out of it before it can decide
 * the fiber must wait, so every static import in this file was paid in full by
 * every `--print` child — 366 KB of `interactive-mode.ts` plus eighty-odd
 * components and the whole of pi-tui, parsed and compiled for a renderer that
 * was never going to render. Measured in the loaded-module set of a real
 * headless child, not inferred.
 *
 * A `import type` is erased before the loader ever sees it, so the cost now
 * follows the activation instead of the file.
 */
import type {
	InteractiveMode,
	InteractiveModeOptions,
	InteractiveModeRunResult,
} from "../../coding-agent/src/modes/interactive/interactive-mode.js";
import { initTheme, preloadCodeHighlighter } from "../../coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentSessionRuntime } from "../../coding-agent/src/core/agent-session-runtime.js";
import type { SessionManager } from "../../coding-agent/src/core/session-manager.js";
// What must outlive a swap of this row — the chat on screen, its runtime, the
// session subscription — lives on the host-owned Surface, not on the instance.
// See packages/rlm-host/src/surface.ts.
import {
	attachRow,
	captureAgentsViewState,
	detachRow,
	rowOwner,
	surface,
	takeAgentsViewSeed,
} from "../../rlm-host/src/surface.ts";
import type { AgentSessionServices } from "../../coding-agent/src/core/agent-session-services.js";

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
	/**
	 * The session `--resume <id>`, `--continue` or `--fork` named. Absent, the
	 * session row's fresh session is used.
	 */
	sessionManager?: SessionManager;
	/** Bare `--resume`/`-r`: open on the agents view (saved sessions) instead of a chat. */
	openAgentsView?: boolean;
	/** The rest of the command line (--model, --thinking, --tools, …) as a runtime config. */
	sessionConfig?: Record<string, unknown>;
	/**
	 * Attach to prime-agent's daemon instead of hosting the sessions in this
	 * process. Opt-in while it settles: `RLM_DAEMON=1` in the environment.
	 */
	daemon?: boolean;
	cwd?: string;
}

export class RlmRendererService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmRenderer" as const;

	declare config: RlmRendererConfig;

	/**
	 * The chat on screen, whether the interactive loop runs, and its runtime.
	 * Accessors over the Surface rather than fields: a swap of this row plugs a
	 * new instance while the chat keeps running, and the new instance must see
	 * the same chat its predecessor started — which is what lets hot reload swap
	 * this row instead of pinning it.
	 */
	private get instance(): InteractiveMode | undefined {
		return surface().interactive.instance as InteractiveMode | undefined;
	}
	private set instance(mode: InteractiveMode | undefined) {
		surface().interactive.instance = mode;
	}
	private get running(): boolean {
		return surface().interactive.running;
	}
	private set running(value: boolean) {
		surface().interactive.running = value;
	}
	private get runtime(): AgentSessionRuntime | undefined {
		return surface().interactive.runtime as AgentSessionRuntime | undefined;
	}
	private set runtime(runtime: AgentSessionRuntime | undefined) {
		surface().interactive.runtime = runtime;
	}

	/** Unsubscribe for session event forwarding — one per session, held on the Surface. */
	private get sessionEventUnsub(): (() => void) | undefined {
		return surface().interactive.sessionEventUnsub;
	}
	private set sessionEventUnsub(unsub: (() => void) | undefined) {
		surface().interactive.sessionEventUnsub = unsub;
	}
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
		// Take over the Surface. When this is a hot swap, the chat is already
		// running; this generation is now the one its callbacks reach, and the
		// listeners below re-attach the panels to it. Nothing is redrawn from
		// scratch and the terminal is never touched.
		attachRow("renderer", this);
		try {
			this.ctx.effect?.(() => () => detachRow("renderer", this));
		} catch {}
		if (this.running && this.instance) {
			this.ctx.logger?.info(`rlm-tui-renderer: attached to the running chat (hot swap)`);
			try {
				(this.instance as any).ui?.requestRender?.();
			} catch {}
		}

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
		if (this.running) {
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

		// prime-agent's interactive flow: this process is a client, and the session
		// lives in a resident worker under the daemon supervisor, so closing the chat
		// detaches instead of ending it. The in-process path below remains for when
		// the daemon cannot be brought up.
		if (opts.daemon ?? process.env.RLM_DAEMON === "1") {
			const attached = await this.startDaemonClient(opts);
			if (attached) return attached;
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
		this.runtime = await rlmAgent.createRuntime({
			...(opts.sessionManager ? { sessionManager: opts.sessionManager } : {}),
			...(opts.sessionConfig ? { sessionConfig: opts.sessionConfig } : {}),
		} as never);

		// Wire up event forwarding: pipe AgentSession events to the active UI provider
		// via rlmTui.emitEvent. This lets a hot-reloadable provider receive all events
		// without modifying InteractiveMode.
		try {
			// The runtime's session is the AgentSession; its subscribe method forwards all AgentSessionEvents.
			// One subscription for the session's life, held on the Surface, and it
			// forwards through whichever renderer generation is current — so a hot
			// swap of this row neither drops events nor sends them to a disposed fiber.
			const maybeSession: any = (this.runtime as any).session;
			if (maybeSession?.subscribe) {
				try { this.sessionEventUnsub?.(); } catch {}
				this.sessionEventUnsub = maybeSession.subscribe((event: any) => {
					const current = rowOwner<RlmRendererService>("renderer") ?? this;
					try {
						current.forwardEvent(event.type, event);
					} catch {}
				});
				surface().interactive.surfaceForwarding = true;
				this.ctx.logger?.info(`rlm-tui-renderer: forwarding AgentSession events to UI provider via rlmTui.emitEvent`);
			}
		} catch (e) {
			this.ctx.logger?.warn(`rlm-tui-renderer: session event forwarding setup failed: ${(e as any)?.message ?? e}`);
		}

		// Initialize theme before creating InteractiveMode — the TUI
		// proxy-guards `theme` and throws if initTheme() wasn't called.
		const settingsManager = this.runtime.services.settingsManager;
		initTheme(settingsManager.getTheme(), true);
		await preloadCodeHighlighter();

		// prime-agent's interactive flow: the chat, and behind it the agents view
		// (left arrow, or Enter on the subagent tray) over every session this
		// process hosts — this runtime, agents started from the view, and all of
		// their subagents, recursively.
		const [{ runInProcessAgentsSession }, { SessionManager }] = await Promise.all([
			import("../../coding-agent/src/modes/agents-view/in-process-agents-session.js"),
			import("../../coding-agent/src/core/session-manager.js"),
		]);
		const rootRuntime = this.runtime;
		const sessionDir = rootRuntime.session.sessionManager.getSessionDir() || undefined;
		const cwd = rootRuntime.session.sessionManager.getCwd();
		this.running = true;
		// The host's last-resort execve (rlm-host shell.ts) asks the Surface what
		// the next image needs to look identical. It already saves the view kind
		// and the chat's editor text; this adds the agents view's own state.
		surface().interactive.view ??= opts.openAgentsView ? "agents" : "chat";
		surface().beforeExec = (plan) => {
			const live = surface().interactive;
			plan.resume.view = live.view;
			if (live.view === "agents") {
				const state = captureAgentsViewState();
				if (state) plan.resume.agentsView = state;
			}
		};
		let result: InteractiveModeRunResult | undefined;
		try {
			result = await runInProcessAgentsSession({
				runtime: rootRuntime,
				// A new agent from the view, or an inactive one resumed, is a runtime
				// built exactly as this one was, on its own session file.
				createTopLevelRuntime: async ({ sessionPath }) =>
					rlmAgent.createRuntime({
						sessionManager: sessionPath
							? SessionManager.open(sessionPath, sessionDir)
							: SessionManager.create(cwd, sessionDir),
						...(opts.sessionConfig ? { sessionConfig: opts.sessionConfig } : {}),
					} as never),
				initialMessage: opts.initialMessage,
				initialMessages: opts.initialMessages,
				verbose: opts.verbose,
				openAgentsView: opts.openAgentsView,
				// After an execve in place, the agents view comes back with its
				// selection, expansion, scope and filter (see the host's reexec).
				initialAgentsViewState: takeAgentsViewSeed() as never,
				onAgentsView: (view) => {
					const live = surface().interactive;
					live.view = "agents";
					live.agentsView = view as never;
				},
				// A default model that couldn't be used is announced, never swapped silently.
				modelFallbackMessage: rootRuntime.modelFallbackMessage,
				// Whichever chat is open is the one panel updates repaint. Written to
				// the Surface, so whichever renderer generation is current sees it.
				onInteractiveMode: (mode) => {
					surface().interactive.instance = mode;
					surface().interactive.view = "chat";
				},
			});
		} finally {
			this.running = false;
			this.instance = undefined;
			// The session loop disposed every runtime it hosted, this one included.
			this.runtime = undefined;
		}

		// Cleanup forwarding after InteractiveMode exits
		try { this.sessionEventUnsub?.(); } catch {}
		this.sessionEventUnsub = undefined;
		surface().interactive.surfaceForwarding = false;

		return result as InteractiveModeRunResult;
	}

	/**
	 * Run the chat as a daemon client. Undefined when the daemon could not be made
	 * ready, so the caller can host the session in-process instead; once attached,
	 * failures propagate like any other.
	 */
	private async startDaemonClient(opts: RlmRendererStartOptions): Promise<InteractiveModeRunResult | undefined> {
		const agent = this.ctx.get("rlmAgent") as {
			createServices: (options: { cwd: string }) => Promise<AgentSessionServices>;
		};
		const [{ ensureInteractiveDaemonRunning }, { defaultDaemonSocketPath }, client, services, { SessionManager }] =
			await Promise.all([
				import("../../coding-agent/src/cli/daemon-launch.js"),
				import("../../coding-agent/src/modes/daemon/daemon-socket.js"),
				import("../../coding-agent/src/modes/daemon/rlm-daemon-client.js"),
				import("../../coding-agent/src/modes/interactive/interactive-mode-services.js"),
				import("../../coding-agent/src/core/session-manager.js"),
			]);
		const socketPath = defaultDaemonSocketPath();
		try {
			await ensureInteractiveDaemonRunning(socketPath);
		} catch (error) {
			this.ctx.logger?.warn(
				`rlm-tui-renderer: daemon unavailable, hosting sessions in-process: ${(error as Error)?.message ?? error}`,
			);
			return undefined;
		}
		const cwd = opts.cwd ?? opts.sessionManager?.getCwd() ?? process.cwd();
		const clientServices = await agent.createServices({ cwd });
		const sessionManager = opts.sessionManager ?? SessionManager.inMemory(cwd);
		initTheme(clientServices.settingsManager.getTheme(), true);
		await preloadCodeHighlighter();
		const uiServices = services.createInteractiveModeUiServicesFromServices({ services: clientServices, sessionManager });
		let daemonActiveSessionId: string | undefined;
		surface().interactive.view ??= opts.openAgentsView ? "agents" : "chat";
		surface().beforeExec = (plan) => {
			const live = surface().interactive;
			plan.resume.view = live.view;
			if (live.view === "agents") {
				const state = captureAgentsViewState();
				if (state) plan.resume.agentsView = state;
			}
			// The session lives in a daemon worker and outlives this process: the next
			// image reattaches to it instead of opening a new one.
			if (daemonActiveSessionId) plan.resume.daemonActiveSessionId = daemonActiveSessionId;
		};
		this.running = true;
		try {
			await client.runRlmDaemonInteractive({
				socketPath,
				sessionManager: opts.sessionManager,
				openAgentsView: opts.openAgentsView,
				config: { cwd, ...(opts.sessionConfig ?? {}), executionMode: "interactive" } as never,
				cwd,
				uiServices,
				createUiServicesForSession: async (summary) => {
					const attached = client.createSessionManagerForActiveDaemonSummary(summary, cwd);
					const attachedServices = await agent.createServices({ cwd: attached.getCwd() });
					return services.createInteractiveModeUiServicesFromServices({
						services: attachedServices,
						sessionManager: attached,
					});
				},
				initialMessage: opts.initialMessage,
				initialMessages: opts.initialMessages,
				verbose: opts.verbose,
				// The same Surface bookkeeping as the in-process path: whichever chat or
				// agents view is on screen, and — for an execve in place — which daemon
				// session to reattach to, so the next image resumes the same live session.
				onInteractiveMode: (mode) => {
					surface().interactive.instance = mode;
					surface().interactive.view = "chat";
				},
				onAgentsView: (view) => {
					const live = surface().interactive;
					live.view = "agents";
					live.agentsView = view as never;
				},
				initialAgentsViewState: takeAgentsViewSeed() as never,
				activeSessionId: (surface().resumed?.daemonActiveSessionId as string | undefined) ?? undefined,
				onAttached: (activeSessionId) => {
					daemonActiveSessionId = activeSessionId;
				},
			});
		} finally {
			this.running = false;
			this.instance = undefined;
		}
		return { type: "agents_view", source: {} } as InteractiveModeRunResult;
	}

	/**
	 * Stop the InteractiveMode and dispose the runtime.
	 */
	async stop(): Promise<void> {
		try { this.sessionEventUnsub?.(); } catch {}
		this.sessionEventUnsub = undefined;
		surface().interactive.surfaceForwarding = false;
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

	/**
	 * rlm-hmr calls this on the outgoing instance just before a swap, with this
	 * class's methods already patched to the new code. A renderer started before
	 * the Surface existed kept the chat in own fields (`instance`, `running`,
	 * `runtime`, `sessionEventUnsub`), which shadow the accessors above; move
	 * them onto the Surface so the next generation reaches the same chat.
	 */
	[Symbol.for("rlm.hmr.handover")]() {
		const live = surface().interactive as any;
		for (const key of ["instance", "running", "runtime", "sessionEventUnsub"] as const) {
			if (!Object.hasOwn(this, key)) continue;
			const value = (this as any)[key];
			delete (this as any)[key];
			if (live[key] === undefined || (key === "running" && !live.running)) live[key] = value;
		}
		// A pre-Surface subscription called the old `tui` directly; re-subscribe
		// through the current owner so events follow every later swap.
		const session = (live.runtime as any)?.session;
		if (live.running && session?.subscribe && !live.surfaceForwarding) {
			try { live.sessionEventUnsub?.(); } catch {}
			live.sessionEventUnsub = session.subscribe((event: any) => {
				const current = rowOwner<RlmRendererService>("renderer");
				try { current?.forwardEvent(event.type, event); } catch {}
			});
			live.surfaceForwarding = true;
		}
	}

	/**
	 * Detach this generation. Cordis never calls this (it defines no dispose
	 * symbol; fiber teardown runs `ctx.effect` disposers), but anything that does
	 * must not end the chat: the chat, its runtime and the session subscription
	 * belong to the Surface and outlive this instance. Ending them is `stop()`.
	 */
	async [Symbol.dispose]() {
		try { this.providerChangedUnsub?.(); } catch {}
		this.providerChangedUnsub = undefined;
		try { this.tuiConfigUnsub?.(); } catch {}
		this.tuiConfigUnsub = undefined;
		try { this.followupSendUnsub?.(); } catch {}
		this.followupSendUnsub = undefined;
		detachRow("renderer", this);
	}
}

export default RlmRendererService;
export const name = "rlm-tui-renderer";
export const inject = ["rlmAgent"] as const;
export { RlmRendererService as RlmRenderer };
export type { InteractiveModeOptions, InteractiveModeRunResult };
