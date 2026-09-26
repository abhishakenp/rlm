/**
 * UDS event client for the Always daemon — a TypeScript port of old Iris's
 * `AlwaysEventClient` (iris-sama/iris/main/always-stream.js), which the request
 * that created this row named as the version that "was nailed there".
 *
 * One connection does double duty: it keeps the daemon alive (the daemon exits
 * 30s after its last UDS client disconnects — `orphan_daemon_exit`) and streams
 * the daemon's events. We must keep reading: a client that stalls the daemon's
 * writes for >5s (WRITE_TIMEOUT) gets dropped.
 *
 * Wire format (daemon `event.rs`): one JSON object per line,
 * `{"type":"<Variant>","data":{...}}`, in both directions.
 */
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** Always' UDS socket path (macOS), matching daemon.rs `socket_path`. */
export const socketPath = (): string =>
	process.env.ALWAYS_SOCKET_PATH ?? join(homedir(), "Library", "Caches", "Always", "always.sock");

/** Normalized speech-to-text signal forwarded to the owner. */
export type SttEvent =
	| { type: "speechStart" }
	| { type: "partial"; text: string }
	| { type: "final"; text: string }
	| { type: "speechEnd" };

export interface AlwaysState {
	resumedBundles: Set<string>;
	masterPaused: boolean;
}

export interface EventClientOptions {
	path?: string;
	/** STT signals routed to Iris (only while consume mode is on, or wake-word redirected). */
	onEvent?: (event: SttEvent) => void;
	/** The dictation whitelist or master pause changed. */
	onAlwaysState?: (state: AlwaysState) => void;
	/** Every (re)connect — the owner re-derives routing from live focus. */
	onReconnect?: (() => void) | null;
	reconnectMs?: number;
	consumeMode?: boolean;
	wakeWord?: string;
}

export class AlwaysEventClient {
	sock: string;
	onEvent: (event: SttEvent) => void;
	onAlwaysState: (state: AlwaysState) => void;
	onReconnect: (() => void) | null;
	reconnectMs: number;
	/** Mode currently asserted to the daemon; null = unknown (forces the next send). */
	consumeMode: boolean | null;
	/** Mode the owner wants from focus/whitelist; a wake-word redirect overlays it. */
	private restingConsume: boolean;
	/** This utterance was redirected to Iris by the wake word. */
	private wakeRedirect = false;
	private wakeWord: string;
	/** Explicit mute — the daemon's real MASTER_PAUSED, not consume mode. */
	private muted = false;
	/** Always's per-app dictation whitelist, learned live from ResumedAppsChanged. */
	resumedBundles = new Set<string>();
	masterPaused = false;
	private socket: Socket | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private buf = "";

	constructor(opts: EventClientOptions = {}) {
		this.sock = opts.path ?? socketPath();
		this.onEvent = opts.onEvent ?? (() => {});
		this.onAlwaysState = opts.onAlwaysState ?? (() => {});
		this.onReconnect = opts.onReconnect ?? null;
		this.reconnectMs = opts.reconnectMs ?? 1000;
		this.consumeMode = opts.consumeMode ?? false;
		this.restingConsume = !!this.consumeMode;
		this.wakeWord = String(opts.wakeWord ?? "iris").toLowerCase();
	}

	get connected(): boolean {
		return !!this.socket && !this.socket.destroyed;
	}

	/** True when Always may dictate into this app (whitelisted and not master-paused). */
	dictationAllowedFor(bundleId: string): boolean {
		return !this.masterPaused && !!bundleId && this.resumedBundles.has(bundleId);
	}

	/**
	 * True when `text` leads with the wake word — exactly, or followed by a space
	 * or comma. Mirrors the daemon's `starts_with_wake_word` (event_loop.rs) so
	 * both sides route the same utterances to Iris. An empty wake word disables it.
	 */
	leadsWithWakeWord(text: unknown): boolean {
		if (!this.wakeWord) return false;
		const t = String(text ?? "").trim().toLowerCase();
		return t === this.wakeWord || t.startsWith(`${this.wakeWord} `) || t.startsWith(`${this.wakeWord},`);
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.connect();
	}

	/** Send a DaemonCommand as one JSON line. Best-effort. */
	private send(cmd: { type: string; data: Record<string, unknown> }): void {
		if (this.socket && !this.socket.destroyed) {
			try {
				this.socket.write(`${JSON.stringify(cmd)}\n`);
			} catch {
				/* the close handler reconnects */
			}
		}
	}

	/**
	 * Iris ↔ dictation, from focus: enabled=true routes speech to Iris regardless
	 * of focus; false is Always's normal per-app dictation (pastes into the field).
	 * Stored so a reconnect re-asserts it (the daemon clears consume mode on
	 * disconnect/restart). Cheap to call on every focus tick — deduped.
	 */
	setConsumeMode(enabled: boolean): void {
		this.restingConsume = !!enabled;
		// Don't disturb an in-flight wake-word redirect; it reverts when the utterance ends.
		if (this.wakeRedirect) return;
		this.applyConsume(!!enabled);
	}

	private applyConsume(enabled: boolean): void {
		if (enabled === this.consumeMode) return;
		this.consumeMode = enabled;
		this.send({ type: "SetConsumeMode", data: { enabled } });
	}

	/**
	 * Mute/unmute via `SetPaused` — the daemon's master pause. Consume mode only
	 * decides WHERE a transcript goes; mute must actually stop capture.
	 */
	setMuted(muted: boolean): void {
		if (!!muted === this.muted) return;
		this.muted = !!muted;
		this.send({ type: "SetPaused", data: { paused: this.muted, reason: "iris_mute" } });
	}

	private connect(): void {
		if (!this.running) return;
		this.buf = "";
		const s = createConnection(this.sock);
		this.socket = s;
		s.setEncoding("utf8");
		s.on("connect", () => {
			// Self-heal on every (re)connect: a restarted daemon starts with consume
			// mode OFF and re-sends the whitelist + pause in its initial burst.
			// Re-asserting a stale `consumeMode = true` is what once left dictation
			// stuck routing to Iris after Always restarted, so mark the asserted
			// state unknown and let the owner recompute from live focus.
			this.consumeMode = null;
			if (this.onReconnect) this.onReconnect();
			else this.applyConsume(this.restingConsume);
			// Assert the desired master pause both ways: a relaunched daemon can boot
			// MASTER_PAUSED=true, and master pause gates all capture.
			this.send({ type: "SetPaused", data: { paused: this.muted, reason: "iris_mute" } });
		});
		s.on("data", (chunk: string) => this.onData(chunk));
		s.on("error", () => {
			/* daemon not up yet / socket gone — the close handler reconnects */
		});
		s.on("close", () => {
			if (this.socket === s) this.socket = null;
			if (this.running) this.timer = setTimeout(() => this.connect(), this.reconnectMs);
		});
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) !== -1) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (line) this.handleFrame(line);
		}
	}

	/** Visible for tests: one decoded frame of the daemon's event stream. */
	handleFrame(line: string): void {
		let evt: { type?: string; data?: Record<string, any> };
		try {
			evt = JSON.parse(line);
		} catch {
			return; // partial/garbled frame
		}
		const type = evt?.type;
		const data = evt?.data ?? {};

		// Always state (not STT): tracked regardless of consume mode.
		if (type === "ResumedAppsChanged") {
			this.resumedBundles = new Set(Array.isArray(data.bundles) ? data.bundles : []);
			this.onAlwaysState({ resumedBundles: this.resumedBundles, masterPaused: this.masterPaused });
			return;
		}
		if (type === "MasterPauseChanged") {
			this.masterPaused = !!data.master_paused;
			this.onAlwaysState({ resumedBundles: this.resumedBundles, masterPaused: this.masterPaused });
			return;
		}

		// Wake-word redirect (streaming path): while dictating, an utterance that
		// starts with the wake word flips consume ON before the final, so the
		// daemon routes it to Iris instead of pasting it. Reverts when it ends.
		if (type === "TranscriptChunk" && !this.consumeMode && this.leadsWithWakeWord(data.text)) {
			this.wakeRedirect = true;
			this.applyConsume(true);
		}

		// Wake-word redirect (batch path): batch engines emit no partials, so the
		// first sight of the wake word is the final. The daemon already routes it
		// to Iris (`wake_routed`); forward it here too, or it reaches neither side.
		if (type === "TranscriptFinal" && !this.consumeMode && this.leadsWithWakeWord(data.text)) {
			const text = String(data.text ?? "").trim();
			if (text) this.onEvent({ type: "final", text });
			this.endWakeRedirect();
			return;
		}

		// While dictating, Always owns the utterance and pastes it; forwarding it
		// too would make Iris act on it as well. Forward only in consume mode.
		if (!this.consumeMode) return;

		switch (type) {
			case "VoiceActivityDetected":
			case "TranscribingStarted":
				this.onEvent({ type: "speechStart" });
				break;
			case "TranscriptChunk": {
				const text = String(data.text ?? "").trim();
				if (text) this.onEvent({ type: "partial", text });
				break;
			}
			case "TranscriptFinal": {
				const text = String(data.text ?? "").trim();
				if (text) this.onEvent({ type: "final", text });
				this.endWakeRedirect();
				break;
			}
			case "TranscriptionFiltered":
				// Rejected utterance (hallucination/filter): end the turn cleanly.
				this.onEvent({ type: "speechEnd" });
				this.endWakeRedirect();
				break;
			default:
				break; // Hello, state burst, pause/model events — not STT
		}
	}

	private endWakeRedirect(): void {
		if (!this.wakeRedirect) return;
		this.wakeRedirect = false;
		this.applyConsume(this.restingConsume);
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.socket) {
			// Hand Always back to normal dictation, and never leave it paused.
			if (this.consumeMode) this.send({ type: "SetConsumeMode", data: { enabled: false } });
			if (this.muted) this.send({ type: "SetPaused", data: { paused: false, reason: "iris_mute" } });
			try {
				this.socket.destroy();
			} catch {
				/* noop */
			}
			this.socket = null;
		}
	}
}
