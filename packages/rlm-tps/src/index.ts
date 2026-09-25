/**
 * @rlm/tps — output tokens per second, on the prompt tray right of the
 * context usage ("37k (4%) · 42 tok/s").
 *
 * A row, not a patch to the chat: it listens to the events of whichever
 * session the chat is showing (rlm-tui `onDisplayedSessionEvent`) and shows
 * one status bar item (`registerStatusBarItem`, order 10 so it sits next to
 * the context label and is the first item kept). Each session keeps its own
 * meter, so opening a subagent from the agents view shows that subagent's
 * rate and coming back shows the parent's last one.
 *
 * The arithmetic lives in ./meter.ts: live rate from the first token (time to
 * first token excluded), eased over ~1s, frozen at the provider-reported count
 * when the response ends.
 *
 * Hot-swappable: every handle is disposed with the fiber.
 */
import { Service } from "@deepseek-ai/cordis";
import { formatTps, streamedChars, TpsMeter, usageOutputOf } from "./meter.ts";

interface TuiHandle {
	dispose(): void;
}

export class RlmTpsService extends Service {
	static inject = ["rlmTui"] as const;
	static provide = "rlmTps" as const;

	/**
	 * Per-session meters and the session on screen, kept on `globalThis` so they
	 * outlive this instance: a swap of the tui row restarts this row too (it
	 * injects `rlmTui`), and a fresh instance must not come back empty.
	 */
	private readonly carried: { meters: Map<string, TpsMeter>; current: string } = ((globalThis as any).__rlmTpsState ??=
		{ meters: new Map<string, TpsMeter>(), current: "default" });
	private get meters(): Map<string, TpsMeter> {
		return this.carried.meters;
	}
	private get current(): string {
		return this.carried.current;
	}
	private set current(value: string) {
		this.carried.current = value;
	}
	private handles: TuiHandle[] = [];
	/** The rlmTui instance the handles belong to. */
	private registeredWith: unknown;

	constructor(ctx: any, config: Record<string, unknown> = {}) {
		super(ctx, undefined as any);
		void config;
	}

	async [Service.init]() {
		this.ensureRegistered();
		// No poll: a hot swap of the tui row now carries its registry over to the
		// successor (rlm-tui `adopt`), so these handles stay valid across it. The
		// fiber's disposer releases them when this row goes.
		(this.ctx as { effect: (fn: () => () => void) => void }).effect(() => () => this.releaseHandles());
	}

	/**
	 * rlm-hmr patched this class in place. The registered closures already call
	 * methods by name, so they use the new code; re-register only if the tui
	 * instance is not the one the handles belong to.
	 */
	[Symbol.for("rlm.hmr.patched")](): void {
		this.ensureRegistered();
	}

	private ensureRegistered(): void {
		const tui = this.getTui();
		if (!tui?.registerStatusBarItem || tui === this.registeredWith) return;
		this.releaseHandles();
		this.registeredWith = tui;
		const status = tui.registerStatusBarItem("rlm-tps", {
			id: "tokens-per-second",
			order: 10,
			renderer: () => formatTps(this.meterFor(this.current).state) ?? null,
		});
		if (status) this.handles.push(status);
		const events = tui.onDisplayedSessionEvent?.("rlm-tps", (event: any, sessionId: string | undefined) =>
			this.onEvent(event, sessionId),
		);
		if (events) this.handles.push(events);
		this.ctx.logger?.info?.("rlm-tps: registered on the prompt tray");
	}

	private releaseHandles(): void {
		for (const handle of this.handles.splice(0)) {
			try {
				handle.dispose();
			} catch {}
		}
	}

	/** The rate of the session on screen, for other rows and code cells. */
	get state() {
		return this.meterFor(this.current).state;
	}

	private onEvent(event: { type: string; message?: any }, sessionId: string | undefined): void {
		const sid = sessionId ?? this.current;
		if (event.type === "session_attached") {
			if (sessionId) this.current = sessionId;
			return;
		}
		this.current = sid;
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		const now = Date.now();
		const meter = this.meterFor(sid);
		const sample = { chars: streamedChars(message), usageOutput: usageOutputOf(message) };
		// The message's own timestamp is when its request started; event arrival
		// can lag it (a busy UI, a buffered stream).
		const startedAt = typeof message.timestamp === "number" && message.timestamp <= now ? message.timestamp : now;
		if (event.type === "message_start") meter.start(startedAt);
		else if (event.type === "message_update") {
			// An update with no start seen (listener attached mid-stream).
			if (!meter.active) meter.start(startedAt);
			meter.update(sample, now);
		}
		else if (event.type === "message_end") meter.end(sample, now);
	}

	private meterFor(sessionId: string): TpsMeter {
		let meter = this.meters.get(sessionId);
		if (!meter) {
			meter = new TpsMeter();
			this.meters.set(sessionId, meter);
			// Sessions come and go (subagents); keep the most recent few dozen.
			if (this.meters.size > 64) {
				const oldest = this.meters.keys().next().value;
				if (oldest !== undefined && oldest !== this.current) this.meters.delete(oldest);
			}
		}
		return meter;
	}

	/** The live service: after a swap `__rlmTui` is the new one before injection catches up. */
	private getTui(): any {
		const live = (globalThis as any).__rlmTui;
		if (live) return live;
		try {
			return this.ctx.get("rlmTui");
		} catch {
			return undefined;
		}
	}

	// No `[Symbol.dispose]`: Cordis never calls it; the effect in init releases the handles.
}

export default RlmTpsService;
export const name = "rlm-tps";
