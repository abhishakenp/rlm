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

export class Always extends Service {
	static inject = [] as const;
	static provide = "always" as const;

	declare config: AlwaysConfig;
	private shared = hotData<Shared>("always:shared");
	private transcriptHandlers = new Set<TranscriptHandler>();
	private focusHandlers = new Set<FocusHandler>();
	private client!: AlwaysEventClient;
	private watcher!: FocusWatcher;

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

		if (this.config.startDaemon !== false) {
			const ready = await ensureAlwaysReady();
			if (!ready.ok) ctx.logger?.warn?.(`[always] daemon not ready: ${ready.error ?? "not running"}`);
		}

		this.client = adopt(
			ctx,
			"always:client",
			() => {
				const c = new AlwaysEventClient({
					path: this.config.socketPath ?? socketPath(),
					wakeWord: this.config.wakeWord ?? "iris",
					// Route to Iris until the focus helper reports; it fires at once.
					consumeMode: true,
					onEvent: (e) => shared.onStt?.(e),
					onAlwaysState: () => shared.onState?.(),
					onReconnect: () => shared.onReconnect?.(),
				});
				c.start();
				return c;
			},
			(c) => c.stop(),
		);
		this.watcher = adopt(
			ctx,
			"always:focus",
			() => {
				const w = new FocusWatcher({
					binPath: this.config.focusBin,
					intervalMs: this.config.focusIntervalMs ?? 300,
					onChange: (s) => shared.onFocus?.(s),
					onError: (e) => shared.onFocusError?.(e),
				});
				w.start();
				return w;
			},
			(w) => w.stop(),
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
