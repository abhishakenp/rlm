/**
 * Inline `<think>` tags in streamed `content`.
 *
 * Some OpenAI-compatible routes (MiniMax M2.x behind OmniRoute, DeepSeek R1
 * distills, QwQ) put their reasoning in `delta.content` wrapped in
 * `<think>...</think>` instead of a separate `reasoning_content` field. Left
 * alone, the tags and the whole chain of thought land in the visible answer.
 *
 * The splitter turns that one text stream into ordered text/thinking segments.
 * It has to survive what those routes actually send:
 *   - tags split across chunks (`<thi` + `nk>`), so a possible tag prefix at the
 *     end of a chunk is held back until the next one decides it;
 *   - a missing close tag: with `tools` in the request, the MiniMax tool parser
 *     upstream swallows `</think>` and emits empty deltas (`{}`) where it was.
 *     The caller reports those through `implicitClose()`. An empty delta is NOT
 *     proof of a close, though: the same route also swallows single tokens in
 *     the middle of reasoning (a quote, a newline) and emits `{}` there too.
 *     Measured over live captures, a real close is always followed by content
 *     that starts with a newline (`\n\npong`), while a mid-reasoning `{}` is
 *     followed by the continuation (`" — so I just…`). So `{}` only marks a
 *     suspected close, decided by the next content chunk;
 *   - a second `<think>` after the answer (the model starting over), and a
 *     stray `</think>` with no opener, which is dropped;
 *   - whitespace between `</think>` and the answer, which is trimmed.
 */

/** `thinkingSignature` of a thinking block parsed from inline tags. Replay re-wraps it in tags. */
export const INLINE_THINK_SIGNATURE = "inline-think-tag";

const OPEN = "<think>";
const CLOSE = "</think>";
const OPENERS = [OPEN] as const;

/**
 * Reasoning delimiters that must never reach a thinking block as text: the
 * block already *is* the reasoning. They leak in from several places — a
 * second `<think>` MiniMax opens while one is still open, `reasoning_content`
 * fields from routes that forward the model's raw tags, Grok/xAI and Qwen
 * traces — so they are removed from every thinking block in one place
 * (AssistantMessageEventStream), whatever provider produced it.
 */
const THINK_TAG = /<\/?(?:think|thinking|reasoning)\s*>/gi;

export const stripThinkTags = (text: string): string => (text.includes("<") ? text.replace(THINK_TAG, "") : text);

/**
 * Remove reasoning delimiters from the thinking blocks of `message`, in place.
 * A delimiter split across two deltas is removed once it is complete. Leading
 * blank lines left where a tag was are trimmed.
 */
export const sanitizeThinkingBlocks = (message: { content?: unknown[] } | undefined): void => {
	const content = message?.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const b = block as { type?: string; thinking?: unknown };
		if (b?.type !== "thinking" || typeof b.thinking !== "string" || !b.thinking.includes("<")) continue;
		const cleaned = stripThinkTags(b.thinking);
		if (cleaned !== b.thinking) b.thinking = cleaned.replace(/^\s*\n/, "");
	}
};

export interface InlineThinkSegment {
	kind: "text" | "thinking";
	text: string;
}

/**
 * Pseudo chat-template markup: a bare tag with a single identifier and nothing
 * else — `<result>`, `</result>`, `<tool_response>`, `<|im_end|>`, `[/USER]`,
 * `[TOOL_CALL]`, `[INST]`. Routes that put reasoning inline (MiniMax behind
 * OmniRoute) emit these when the model loses track of the turn and starts
 * talking to itself after answering. Recognised by shape rather than a list,
 * because the vocabulary keeps changing (live captures so far: `[TOOL_CALL]`,
 * `[/TOOL_CALL]`, `<function_calls>`, `<tool_response>`, `<result>`, `[/USER]`).
 * Brackets need an upper-case name so markdown links (`[see here]`) and
 * `[x]` checkboxes are not mistaken for it; angle tags need a lower-case or
 * `|`-delimited name without attributes or spaces.
 */
const ROLE_LABELS = ["User", "Human", "Assistant", "Model", "AI", "System", "Tool"];

const PSEUDO_MARKUP =
	/<\/?[a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?>|<\|[a-z0-9_]+\|>|\[\/?[A-Z][A-Z0-9_]+\]|\n(?:User|Human|Assistant|Model|AI|System|Tool)\s*:/;

const findPseudoMarkup = (s: string, fenceOpen: boolean): { index: number; length: number } | undefined => {
	// Skip anything inside inline code or a ``` fence: markup there is the answer's content.
	let inFence = fenceOpen;
	let offset = 0;
	for (const part of s.split("```")) {
		if (!inFence) {
			const segments = part.split("`");
			let segOffset = offset;
			for (let i = 0; i < segments.length; i++) {
				if (i % 2 === 0) {
					const m = PSEUDO_MARKUP.exec(segments[i]!);
					if (m) return { index: segOffset + m.index, length: m[0].length };
				}
				segOffset += segments[i]!.length + 1;
			}
		}
		offset += part.length + 3;
		inFence = !inFence;
	}
	return undefined;
};

/** Hold back a trailing `<…` or `[…` that could still become pseudo-markup in the next chunk. */
const possibleMarkupTail = (s: string): number => {
	// A new line that may still become a chat-transcript role label (`\nUser:`).
	const line = /\n([A-Za-z]{0,9})(\s*)$/.exec(s);
	if (line && (line[2] === "" || ROLE_LABELS.includes(line[1]!)) && ROLE_LABELS.some((role) => role.startsWith(line[1]!))) {
		return s.length - line.index;
	}
	const at = Math.max(s.lastIndexOf("<"), s.lastIndexOf("["));
	if (at === -1 || s.length - at > 32) return 0;
	const tail = s.slice(at);
	return /^(<\/?[a-z0-9_:]*|<\|[a-z0-9_|]*|\[\/?[A-Z0-9_]*)$/.test(tail) ? tail.length : 0;
};

/** Length of the longest suffix of `s` that is a proper prefix of one of `tags`. */
const heldPrefixLength = (s: string, tags: readonly string[]): number => {
	let best = 0;
	for (const tag of tags) {
		for (let n = Math.min(tag.length - 1, s.length); n > best; n--) {
			if (s.endsWith(tag.slice(0, n))) {
				best = n;
				break;
			}
		}
	}
	return best;
};

export class InlineThinkSplitter {
	private pending = "";
	private inside = false;
	private sawTag = false;
	/** Whitespace-only text at the start of a text run, held until we know what follows it. */
	private leadingWhitespace = "";
	/** True while the current text run has emitted nothing but (held) whitespace. */
	private atRunStart = true;
	/** An empty delta arrived inside <think>; the next chunk decides whether it was the close. */
	private closeSuspected = false;
	/** A think block has ended and non-whitespace answer text followed it. */
	private answeredAfterThink = false;
	private closedAThink = false;
	/**
	 * The model answered, then opened another <think>: it is starting over
	 * (`pong <think>… pong <think>… Done.`, live captures). What it writes after
	 * that is more of its own deliberation, not a second answer, so it is kept
	 * as thinking.
	 */
	private restarted = false;
	/** Non-whitespace answer text has been emitted. */
	private hasAnswer = false;
	/** Inside a ``` code fence in the answer: markup there is content, not a restart. */
	private fenceOpen = false;

	/** Whether any inline tag has been seen in this stream. */
	get active(): boolean {
		return this.sawTag;
	}

	/** Whether the stream is currently inside an opened `<think>`. */
	get insideThink(): boolean {
		return this.inside;
	}

	/** Whether the model answered and then opened another `<think>` (see `restarted` field). */
	get startedOver(): boolean {
		return this.restarted;
	}

	push(chunk: string): InlineThinkSegment[] {
		const out: InlineThinkSegment[] = [];
		if (this.closeSuspected) {
			this.closeSuspected = false;
			// Content after a swallowed `</think>` starts on a new line; anything
			// else continues the reasoning the `{}` interrupted.
			if (this.inside && chunk.startsWith("\n")) {
				this.emit(out, "thinking", this.pending);
				this.pending = "";
				this.closeThink();
			}
		}
		let s = this.pending + chunk;
		this.pending = "";
		while (s.length > 0) {
			if (this.inside) {
				const closeAt = s.indexOf(CLOSE);
				if (closeAt !== -1) {
					this.emit(out, "thinking", s.slice(0, closeAt));
					this.closeThink();
					s = s.slice(closeAt + CLOSE.length);
					continue;
				}
				const hold = heldPrefixLength(s, [CLOSE]);
				this.emit(out, "thinking", s.slice(0, s.length - hold));
				this.pending = s.slice(s.length - hold);
				break;
			}
			let openAt = -1;
			let opener: string = OPEN;
			for (const candidate of OPENERS) {
				const at = s.indexOf(candidate);
				if (at !== -1 && (openAt === -1 || at < openAt)) {
					openAt = at;
					opener = candidate;
				}
			}
			const strayCloseAt = s.indexOf(CLOSE);
			if (strayCloseAt !== -1 && (openAt === -1 || strayCloseAt < openAt)) {
				this.emit(out, "text", s.slice(0, strayCloseAt));
				this.sawTag = true;
				s = s.slice(strayCloseAt + CLOSE.length);
				continue;
			}
			if (openAt !== -1) {
				this.emit(out, "text", s.slice(0, openAt));
				// Whitespace that only separated nothing from a <think> is not part of the answer.
				this.leadingWhitespace = "";
				if (this.answeredAfterThink) this.restarted = true;
				this.inside = true;
				this.sawTag = true;
				s = s.slice(openAt + opener.length);
				continue;
			}
			// Pseudo chat-template markup after an answer: the model started over.
			if (this.sawTag && !this.restarted) {
				const markup = findPseudoMarkup(s, this.fenceOpen);
				if (markup) {
					const before = s.slice(0, markup.index);
					if (this.hasAnswer || before.trim() !== "") {
						this.emit(out, "text", before.replace(/\s+$/, ""));
						this.restarted = true;
						s = s.slice(markup.index);
						continue;
					}
					// No answer yet: the markup wraps what is coming (`<result>pong`) — drop the token.
					this.emit(out, "text", before);
					s = s.slice(markup.index + markup.length);
					continue;
				}
			}
			let hold = Math.max(
				heldPrefixLength(s, [...OPENERS, CLOSE]),
				this.sawTag && !this.restarted ? possibleMarkupTail(s) : 0,
			);
			// On inline-think routes also hold whitespace at the end of the answer:
			// if markup follows, it belongs to nothing and is dropped.
			if (this.sawTag && !this.restarted) {
				const body = s.slice(0, s.length - hold);
				hold += body.length - body.replace(/\s+$/, "").length;
			}
			this.emit(out, "text", s.slice(0, s.length - hold));
			this.pending = s.slice(s.length - hold);
			break;
		}
		return out;
	}

	/**
	 * The route emitted an empty delta while thinking. It may have swallowed
	 * `</think>` — or a single token mid-reasoning; the next `push` decides.
	 */
	implicitClose(): InlineThinkSegment[] {
		if (this.inside) this.closeSuspected = true;
		return [];
	}

	/** End of stream: release whatever was held back. */
	flush(): InlineThinkSegment[] {
		const out: InlineThinkSegment[] = [];
		this.emit(out, this.inside ? "thinking" : "text", this.pending);
		this.pending = "";
		// With no tag ever seen this was an ordinary reply; keep its whitespace.
		if (!this.sawTag && this.leadingWhitespace) {
			out.push({ kind: "text", text: this.leadingWhitespace });
		}
		this.leadingWhitespace = "";
		return out;
	}

	private closeThink() {
		this.inside = false;
		this.closeSuspected = false;
		this.closedAThink = true;
		this.atRunStart = true;
		this.leadingWhitespace = "";
	}

	private emit(out: InlineThinkSegment[], kind: InlineThinkSegment["kind"], text: string) {
		if (!text) return;
		if (kind === "text" && this.restarted) kind = "thinking";
		if (kind === "text" && this.closedAThink && text.trim() !== "") this.answeredAfterThink = true;
		if (kind === "text") {
			if (text.trim() !== "") this.hasAnswer = true;
			const fences = text.split("```").length - 1;
			if (fences % 2 === 1) this.fenceOpen = !this.fenceOpen;
		}
		if (kind === "text" && this.atRunStart) {
			if (text.trim() === "") {
				this.leadingWhitespace += text;
				return;
			}
			// Before any tag the reply is ordinary text and keeps its whitespace;
			// after a </think> the separating newlines are dropped.
			text = this.sawTag ? text.trimStart() : this.leadingWhitespace + text;
			this.leadingWhitespace = "";
			this.atRunStart = false;
		}
		const last = out[out.length - 1];
		if (last && last.kind === kind) last.text += text;
		else out.push({ kind, text });
	}
}

/**
 * The answer part of a reply from an inline-think route: everything before the
 * first pseudo chat-template token outside code (see PSEUDO_MARKUP). Used where
 * a finished message is printed, as a backstop to the streaming splitter.
 */
export const cutAtPseudoMarkup = (text: string): string => {
	const markup = findPseudoMarkup(text, false);
	if (!markup) return text;
	const before = text.slice(0, markup.index).trimEnd();
	return before.trim() === "" ? text : before;
};
