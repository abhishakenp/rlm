/**
 * Output tokens per second for one assistant response at a time.
 *
 * The clock starts at the first streamed token, not at the request: time to
 * first token is the provider thinking about the prompt, and folding it in
 * would make a fast model behind a slow queue read as a slow model. The
 * exception is a reply that arrives in one burst (see BURST_WINDOW_MS).
 *
 * Live, the count is estimated from the characters streamed so far (text,
 * thinking and tool-call arguments, ~4 characters a token) unless the provider
 * is already reporting `usage.output`. At the end the provider's count wins
 * when it has one, and the value freezes until the next response starts.
 *
 * The live number is eased toward the running average with a ~1s time
 * constant, so a burst of deltas in one frame does not make it jump.
 */

export const CHARS_PER_TOKEN = 4;
/** Below this, a rate is mostly noise from the first chunk's timing. */
export const MIN_LIVE_MS = 250;
export const MIN_LIVE_TOKENS = 5;
export const SMOOTHING_MS = 1000;
/** A response shorter than this after its first token gets no final rate. */
export const MIN_FINAL_MS = 50;
/**
 * A stream shorter than this was delivered in a burst — the provider (or a
 * gateway in front of it) generated the reply before sending the first byte —
 * so dividing by the stream window would report delivery speed, not
 * generation speed. Those responses are rated over the whole response time.
 */
export const BURST_WINDOW_MS = 1000;

export interface StreamSample {
	/** Characters streamed so far for this response (text + thinking + tool args). */
	chars: number;
	/** Provider-reported output tokens so far, if any (0 when not reported). */
	usageOutput?: number;
}

export type TpsState =
	| { phase: "idle" }
	| { phase: "waiting" }
	| { phase: "live"; tps: number | undefined }
	| { phase: "done"; tps: number | undefined };

export class TpsMeter {
	private startedAt: number | undefined;
	private firstTokenAt: number | undefined;
	private lastAt: number | undefined;
	private tokens = 0;
	private shown: number | undefined;
	private final: number | undefined;
	private phase: TpsState["phase"] = "idle";

	/** A new assistant response began (request sent). */
	start(now: number): void {
		this.startedAt = now;
		this.firstTokenAt = undefined;
		this.lastAt = undefined;
		this.tokens = 0;
		this.shown = undefined;
		this.phase = "waiting";
	}

	/** Streaming progress. Safe to call before `start` (starts implicitly). */
	update(sample: StreamSample, now: number): void {
		if (this.phase === "idle" || this.phase === "done") this.start(now);
		const tokens = tokensOf(sample);
		if (tokens <= 0) return;
		if (this.firstTokenAt === undefined) {
			this.firstTokenAt = now;
			this.tokens = tokens;
			this.lastAt = now;
			this.phase = "live";
			return;
		}
		this.tokens = Math.max(this.tokens, tokens);
		const elapsed = now - this.firstTokenAt;
		if (elapsed < MIN_LIVE_MS || this.tokens < MIN_LIVE_TOKENS) {
			this.lastAt = now;
			return;
		}
		// Tokens after the first chunk over the time since it: the first chunk's
		// tokens arrived "at" firstTokenAt and took no measurable time.
		const target = rate(this.tokens, elapsed);
		if (this.shown === undefined) {
			this.shown = target;
		} else {
			const dt = Math.max(0, now - (this.lastAt ?? now));
			const alpha = 1 - Math.exp(-dt / SMOOTHING_MS);
			this.shown += (target - this.shown) * alpha;
		}
		this.lastAt = now;
	}

	/** The response finished. `sample` is the final message; provider usage wins. */
	end(sample: StreamSample, now: number): void {
		if (this.phase === "idle") {
			this.phase = "done";
			this.final = undefined;
			return;
		}
		const tokens = sample.usageOutput && sample.usageOutput > 0 ? sample.usageOutput : Math.max(this.tokens, tokensOf(sample));
		const elapsed = this.firstTokenAt === undefined ? 0 : now - this.firstTokenAt;
		// One chunk and done (or nothing streamed) has no meaningful rate; keep
		// showing the previous response's value rather than a made-up one.
		if (this.firstTokenAt !== undefined && elapsed >= MIN_FINAL_MS && tokens > 0) {
			const burst = elapsed < BURST_WINDOW_MS && this.startedAt !== undefined;
			this.final = rate(tokens, burst ? now - (this.startedAt as number) : elapsed);
		}
		this.phase = "done";
	}

	/** Forget everything (new session / session switch). */
	reset(): void {
		this.startedAt = undefined;
		this.firstTokenAt = undefined;
		this.lastAt = undefined;
		this.tokens = 0;
		this.shown = undefined;
		this.final = undefined;
		this.phase = "idle";
	}

	get state(): TpsState {
		switch (this.phase) {
			case "idle":
				return { phase: "idle" };
			case "waiting":
				// Between request and first token: keep the last response's value.
				return this.final === undefined ? { phase: "waiting" } : { phase: "done", tps: this.final };
			case "live":
				return { phase: "live", tps: this.shown };
			case "done":
				return { phase: "done", tps: this.final };
		}
	}

	/** A response is in flight (started, not ended). */
	get active(): boolean {
		return this.phase === "waiting" || this.phase === "live";
	}

	/** Time to first token of the current/last response, ms. */
	get ttftMs(): number | undefined {
		return this.startedAt !== undefined && this.firstTokenAt !== undefined ? this.firstTokenAt - this.startedAt : undefined;
	}
}

const tokensOf = (sample: StreamSample): number =>
	sample.usageOutput && sample.usageOutput > 0 ? sample.usageOutput : Math.round(sample.chars / CHARS_PER_TOKEN);

const rate = (tokens: number, elapsedMs: number): number => (tokens * 1000) / Math.max(1, elapsedMs);

/** Characters of everything the model produced in a message: text, thinking, tool-call args. */
export const streamedChars = (message: unknown): number => {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") chars += p.text.length;
		else if (p.type === "thinking" && typeof p.thinking === "string") chars += p.thinking.length;
		else if (p.type === "toolCall") {
			const args = p.arguments;
			if (typeof args === "string") chars += args.length;
			else if (args && typeof args === "object") chars += JSON.stringify(args).length;
		}
	}
	return chars;
};

export const usageOutputOf = (message: unknown): number => {
	const out = (message as { usage?: { output?: unknown } })?.usage?.output;
	return typeof out === "number" && Number.isFinite(out) ? out : 0;
};

/** "42 tok/s", "3.4 tok/s", "…" while measuring, undefined when there is nothing to show. */
export const formatTps = (state: TpsState): string | undefined => {
	if (state.phase === "idle") return undefined;
	if (state.phase === "waiting") return undefined;
	if (state.tps === undefined || !Number.isFinite(state.tps)) return state.phase === "live" ? "… tok/s" : undefined;
	const v = state.tps;
	// One decimal below 10; whole numbers from there (9.97 reads "10", not "10.0").
	const text = v >= 9.95 ? Math.round(v).toString() : v.toFixed(1);
	return `${text} tok/s`;
};
