/**
 * Always voice integration — row id `always`, service `always`.
 *
 * The request that created this row (delegate g-20260906142200-9ams): "Always
 * plugin: when text field is focused, dictate transcriptions unless prefixed
 * with 'iris'. When not focused, Iris listens. Port this from old iris — it was
 * nailed there but broken now." This is that port of iris-sama/iris
 * (main/always-stream.js, main/focus-watcher.js, main.js `recomputeConsume`).
 *
 * The Always daemon owns the microphone and pastes dictation itself. This row
 * only decides WHERE speech goes, by flipping the daemon's consume mode:
 *   - an editable field is focused in an app Always may dictate into → consume
 *     OFF, Always pastes into the field;
 *   - otherwise (nothing editable, app not whitelisted) → consume ON, speech
 *     comes here and is handed to Iris.
 * An utterance that starts with the wake word ("iris …") goes to Iris even
 * while dictating (event-client.ts).
 *
 * Consumers: `ctx.always.onTranscript(fn)` / `onFocusChange(fn)`, or the
 * `always/transcript` and `always/focus` events.
 *
 * Hot reload: the UDS connection and the focus helper are adopted across swaps
 * (rlm-hmr/src/hot.ts). Dropping the socket would make the daemon clear consume
 * mode — a window where speech meant for Iris gets pasted into a field.
 */
import { Service } from "@deepseek-ai/cordis";
import { adopt, hotData } from "../../rlm-hmr/src/hot.ts";
import { alwaysStatus, ensureAlwaysReady } from "./cli.ts";
import { AlwaysEventClient, type SttEvent, socketPath } from "./event-client.ts";
import { type FocusState, FocusWatcher } from "./focus-watcher.ts";
import { eligibleToOwn, OwnerLease } from "./owner.ts";

export { AlwaysEventClient, socketPath } from "./event-client.ts";
export type { AlwaysState, SttEvent } from "./event-client.ts";
export { FocusWatcher, defaultFocusBin } from "./focus-watcher.ts";
export type { FocusState } from "./focus-watcher.ts";
export { alwaysCli, alwaysStatus, daemonRunning, ensureAlwaysReady } from "./cli.ts";

export const name = "always";

export interface AlwaysTranscript {
	text: string;
	ts: string;
	source: "always";
	partial: boolean;
}

export type TranscriptHandler = (t: AlwaysTranscript) => void;
export type FocusHandler = (s: FocusState) => void;

export interface AlwaysConfig {
	/** Focus helper sampling interval, ms. Default 300. */
	focusIntervalMs?: number;
	/** Override the daemon socket (default ~/Library/Caches/Always/always.sock). */
	socketPath?: string;
	/** Override the focused-editable helper. */
	focusBin?: string;
	/** Wake word that routes an utterance to Iris while dictating. Default "iris". */
	wakeWord?: string;
	/** Start the Always daemon (detached) if it isn't running. Default true. */
	startDaemon?: boolean;
}

export const configFields = [
	{ key: "focusIntervalMs", type: "number", description: "How often the focus helper samples editable focus, in ms." },
	{ key: "wakeWord", type: "string", description: "Leading word that sends an utterance to Iris while dictating." },
	{ key: "startDaemon", type: "boolean", description: "Start the Always daemon if it is not running." },
];

/** What every generation of this row shares; handlers point at the newest one. */
interface Shared extends Record<string, unknown> {
	lastFocus?: FocusState;
	warnedUntrusted?: boolean;
	onStt?: (e: SttEvent) => void;
	onState?: () => void;
	onReconnect?: () => void;
	onFocus?: (s: FocusState) => void;
	onFocusError?: (e: Error) => void;
}

declare module "@deepseek-ai/cordis" {
	interface Context {
		always: Always;
	}
	interface Events {
		"always/transcript"(t: AlwaysTranscript): void;
		"always/focus"(s: FocusState & { dictate: boolean }): void;
	}
}

/**
 * Holds the machine-wide lease (owner.ts) and, only while it holds it, the
 * daemon connection and the focus helper. Adopted across hot swaps, so a
 * reload never drops the socket; a non-owner retries every few seconds and
 * takes over within one tick of the owner exiting.
 */
class AlwaysOwnership {
	client?: AlwaysEventClient;
	watcher?: FocusWatcher;
	private readonly lease = new OwnerLease();
	private timer?: ReturnType<typeof setInterval>;
	private busy = false;
	private stopped = false;
	private readonly onExit = () => this.lease.release();

	constructor(
		private readonly make: {
			prepare: () => Promise<void>;
			client: () => AlwaysEventClient;
			watcher: () => FocusWatcher;
		},
		private readonly log: (level: "info" | "warn", msg: string) => void,
		private readonly retryMs = 3000,
	) {}

	get owned(): boolean {
		return !!this.client;
	}

	start(): this {
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.retryMs);
		(this.timer as any).unref?.();
		process.once("exit", this.onExit);
		return this;
	}

	private async tick(): Promise<void> {
		if (this.stopped || this.busy) return;
		this.busy = true;
		try {
			if (this.owned) {
				if (!this.lease.holds()) this.drop("lease taken by another process");
				return;
			}
			if (!(await this.lease.tryAcquire())) return;
			await this.make.prepare();
			if (this.stopped) return;
			this.client = this.make.client();
			this.watcher = this.make.watcher();
			this.log("info", `[always] owner (pid ${process.pid}): driving the Always daemon`);
		} catch (e: any) {
			this.log("warn", `[always] ownership tick failed: ${e?.message ?? e}`);
		} finally {
			this.busy = false;
		}
	}

	private drop(why: string): void {
		this.client?.stop();
		this.watcher?.stop();
		this.client = undefined;
		this.watcher = undefined;
		this.log("info", `[always] stood down: ${why}`);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		process.removeListener("exit", this.onExit);
		if (this.owned) this.drop("row stopped");
		this.lease.release();
	}
}

export class Always extends Service {
	static inject = [] as const;
	static provide = "always" as const;

	declare config: AlwaysConfig;
	private shared = hotData<Shared>("always:shared");
	private transcriptHandlers = new Set<TranscriptHandler>();
	private focusHandlers = new Set<FocusHandler>();
	private ownership?: AlwaysOwnership;

	private get client(): AlwaysEventClient | undefined {
		return this.ownership?.client;
	}

	constructor(ctx: any, config: AlwaysConfig = {}) {
		super(ctx, "always");
		this.config = config ?? {};
	}

	async [Service.init]() {
		const ctx = this.ctx as any;
		const shared = this.shared;
		// The newest generation receives everything the adopted resources report.
		shared.onStt = (e) => this.onStt(e);
		shared.onState = () => this.recompute("whitelist");
		shared.onReconnect = () => this.recompute("reconnect");
		shared.onFocus = (s) => {
			shared.lastFocus = s;
			this.recompute("focus");
		};
		shared.onFocusError = (e) => ctx.logger?.warn?.(`[always] focus watcher: ${e?.message ?? e}`);
		ctx.effect(() => () => {
			this.transcriptHandlers.clear();
			this.focusHandlers.clear();
		});

		// Only one process on the machine drives the daemon (owner.ts). Headless
		// runs, delegate children and daemon workers never compete; an eligible
		// process that isn't the owner stays idle and takes over if the owner goes.
		if (!eligibleToOwn()) {
			ctx.logger?.info?.("[always] not eligible to drive Always in this process (headless/worker)");
			return;
		}
		const config = this.config;
		const log = (level: "info" | "warn", msg: string) => ctx.logger?.[level]?.(msg);
		this.ownership = adopt(
			ctx,
			"always:ownership",
			() =>
				new AlwaysOwnership(
					{
						prepare: async () => {
							if (config.startDaemon === false) return;
							const ready = await ensureAlwaysReady();
							if (!ready.ok) log("warn", `[always] daemon not ready: ${ready.error ?? "not running"}`);
						},
						client: () => {
							const c = new AlwaysEventClient({
								path: config.socketPath ?? socketPath(),
								wakeWord: config.wakeWord ?? "iris",
								// Route to Iris until the focus helper reports; it fires at once.
								consumeMode: true,
								onEvent: (e) => shared.onStt?.(e),
								onAlwaysState: () => shared.onState?.(),
								onReconnect: () => shared.onReconnect?.(),
							});
							c.start();
							return c;
						},
						watcher: () => {
							const w = new FocusWatcher({
								binPath: config.focusBin,
								intervalMs: config.focusIntervalMs ?? 300,
								onChange: (s) => shared.onFocus?.(s),
								onError: (e) => shared.onFocusError?.(e),
							});
							w.start();
							return w;
						},
					},
					log,
				).start(),
			(o) => o.stop(),
		);
		// A swapped-in generation re-derives routing from what the old one saw.
		if (shared.lastFocus) this.recompute("reload");
		ctx.logger?.info?.("[always] ready");
	}

	/**
	 * The routing decision (old Iris main.js `recomputeConsume`): dictate ONLY
	 * when the focused app is in Always's dictation whitelist AND an editable
	 * field is focused; otherwise route to Iris. Without Accessibility trust
	 * there is no focus signal, so fall back to plain dictation.
	 */
	private recompute(trigger: string): void {
		const s = this.shared.lastFocus;
		if (!this.client || !s) return;
		const ctx = this.ctx as any;
		if (!s.trusted) {
			if (!this.shared.warnedUntrusted) {
				this.shared.warnedUntrusted = true;
				ctx.logger?.warn?.(
					"[always] Accessibility permission is not granted to the focused-editable helper — focus routing is off; dictation only. Grant it in System Settings › Privacy & Security › Accessibility.",
				);
			}
			this.client.setConsumeMode(false);
			this.announceFocus(s, true);
			return;
		}
		const dictate = this.client.dictationAllowedFor(s.bundleId) && s.editable;
		this.client.setConsumeMode(!dictate);
		ctx.logger?.debug?.(`[always] app=${s.bundleId || "-"} → ${dictate ? "dictation" : "Iris"} [${trigger}]`);
		this.announceFocus(s, dictate);
	}

	private announceFocus(s: FocusState, dictate: boolean): void {
		for (const h of this.focusHandlers) {
			try {
				h(s);
			} catch {
				/* one bad subscriber must not stop routing */
			}
		}
		(this.ctx as any).emit?.("always/focus", { ...s, dictate });
	}

	private onStt(e: SttEvent): void {
		if (e.type !== "partial" && e.type !== "final") return;
		const t: AlwaysTranscript = { text: e.text, ts: new Date().toISOString(), source: "always", partial: e.type === "partial" };
		for (const h of this.transcriptHandlers) {
			try {
				h(t);
			} catch {
				/* drop */
			}
		}
		(this.ctx as any).emit?.("always/transcript", t);
	}

	// ── public API ──────────────────────────────────────────────────────────

	/** Speech routed to Iris (consume mode, or a wake-word redirect). Returns an unsubscribe. */
	onTranscript(handler: TranscriptHandler): () => void {
		this.transcriptHandlers.add(handler);
		return () => this.transcriptHandlers.delete(handler);
	}

	/** Focus changes (after routing was applied). Returns an unsubscribe. */
	onFocusChange(handler: FocusHandler): () => void {
		this.focusHandlers.add(handler);
		return () => this.focusHandlers.delete(handler);
	}

	/** Whether an editable text field is focused right now. */
	get textFocused(): boolean {
		return !!this.shared.lastFocus?.editable;
	}

	/** "dictate" while Always pastes into the field, "listen" while speech goes to Iris. */
	get mode(): "dictate" | "listen" {
		return this.client?.consumeMode ? "listen" : "dictate";
	}

	get daemonConnected(): boolean {
		return !!this.client?.connected;
	}

	/** Force consume mode (Iris listens) on or off until the next focus change. */
	setConsumeMode(enabled: boolean): void {
		this.client?.setConsumeMode(enabled);
	}

	/** Mute capture (the daemon's master pause) — not just rerouting. */
	setMuted(muted: boolean): void {
		this.client?.setMuted(muted);
	}

	status() {
		return alwaysStatus();
	}
}

export default Always;
