/**
 * Reasoning out of the answer, for the SDK's /v1/chat/completions.
 *
 * The route used to hand the provider's reply straight back. On inline-think
 * routes (auto/best-free → MiniMax, via OmniRoute) that reply carries the
 * model's reasoning as `<think>…</think>` inside `content` — and sometimes a
 * swallowed `</think>`, a second `<think>` after the answer, or chat-template
 * pseudo-markup. rlm's own sessions never show that, because packages/ai splits
 * it (InlineThinkSplitter); an SDK client got it raw.
 *
 * Same splitter here, so a client sees what an rlm session sees: the answer in
 * `content`, the reasoning in `reasoning_content` (the field OpenAI-compatible
 * reasoning providers already use). A reply with no tags passes through as is.
 */
import { InlineThinkSplitter, cutAtPseudoMarkup } from "../../ai/src/providers/inline-think.ts";

type Segments = ReturnType<InlineThinkSplitter["push"]>;

const join = (segments: Segments, kind: "text" | "thinking"): string =>
	segments
		.filter((s) => s.kind === kind)
		.map((s) => s.text)
		.join("");

/** Split one complete reply into answer and reasoning. */
export const splitReply = (raw: string): { content: string; reasoning: string } => {
	const splitter = new InlineThinkSplitter();
	const segments = [...splitter.push(raw), ...splitter.flush()];
	if (!splitter.active) return { content: raw, reasoning: "" };
	return { content: cutAtPseudoMarkup(join(segments, "text")).trimEnd(), reasoning: join(segments, "thinking") };
};

/** Rewrite a non-streaming chat completion in place. */
export const cleanCompletion = (data: any): any => {
	for (const choice of data?.choices ?? []) {
		const message = choice?.message;
		if (!message || typeof message.content !== "string") continue;
		const { content, reasoning } = splitReply(message.content);
		message.content = content;
		if (reasoning) {
			message.reasoning_content = [message.reasoning_content, reasoning].filter(Boolean).join("\n");
		}
	}
	return data;
};

/**
 * Rewrite an SSE chat-completion stream: `content` deltas go through one
 * splitter per choice; reasoning is sent as `reasoning_content` deltas.
 * Everything else (tool calls, finish_reason, usage, [DONE]) passes unchanged.
 */
export const cleanStream = async function* (
	body: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const splitters = new Map<number, InlineThinkSplitter>();
	const splitterFor = (index: number) => {
		let s = splitters.get(index);
		if (!s) splitters.set(index, (s = new InlineThinkSplitter()));
		return s;
	};
	/** Emit a chunk carrying one choice's segments, modelled on `base`. */
	const segmentEvent = (base: any, index: number, segments: Segments): string | undefined => {
		const content = join(segments, "text");
		const reasoning = join(segments, "thinking");
		if (!content && !reasoning) return undefined;
		const delta: Record<string, string> = {};
		if (content) delta.content = content;
		if (reasoning) delta.reasoning_content = reasoning;
		const chunk = { ...base, choices: [{ index, delta, finish_reason: null }] };
		return `data: ${JSON.stringify(chunk)}\n\n`;
	};
	let lastBase: any = { object: "chat.completion.chunk" };
	const flushAll = function* () {
		for (const [index, splitter] of splitters) {
			const event = segmentEvent(lastBase, index, splitter.flush());
			if (event) yield event;
		}
		splitters.clear();
	};

	let buffer = "";
	for await (const part of body) {
		buffer += typeof part === "string" ? part : decoder.decode(part, { stream: true });
		let end: number;
		while ((end = buffer.indexOf("\n\n")) !== -1) {
			const event = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const line = event.split("\n").find((l) => l.startsWith("data:"));
			const payload = line?.slice(5).trim();
			if (!payload) {
				yield `${event}\n\n`;
				continue;
			}
			if (payload === "[DONE]") {
				yield* flushAll();
				yield `${event}\n\n`;
				continue;
			}
			let chunk: any;
			try {
				chunk = JSON.parse(payload);
			} catch {
				yield `${event}\n\n`;
				continue;
			}
			const { choices, ...rest } = chunk;
			lastBase = rest;
			const out: string[] = [];
			const passthrough: any[] = [];
			for (const choice of choices ?? []) {
				const index = choice?.index ?? 0;
				const delta = choice?.delta ?? {};
				const splitter = splitterFor(index);
				let segments: Segments = [];
				if (typeof delta.content === "string" && delta.content) {
					segments = splitter.push(delta.content);
				} else if (Object.keys(delta).length === 0 && !choice?.finish_reason) {
					// The route's empty delta: possibly a swallowed `</think>`.
					segments = splitter.implicitClose();
				}
				if (choice?.finish_reason) segments = [...segments, ...splitter.flush()];
				const event = segmentEvent(rest, index, segments);
				if (event) out.push(event);
				const { content: _content, ...otherDelta } = delta;
				if (Object.keys(otherDelta).length > 0 || choice?.finish_reason) {
					passthrough.push({ ...choice, delta: otherDelta });
				}
			}
			yield* out;
			if (passthrough.length > 0 || !choices?.length) {
				yield `data: ${JSON.stringify({ ...rest, choices: passthrough })}\n\n`;
			}
		}
	}
	yield* flushAll();
	if (buffer.trim()) yield buffer;
};
