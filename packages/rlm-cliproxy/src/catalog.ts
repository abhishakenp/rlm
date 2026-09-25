/**
 * Turns CLIProxyAPI's `/v1/models` listing into one rlm provider config.
 *
 * Pure on purpose: no fetch, no fs, no globals. The row does the I/O; this
 * decides what a model id means, so it can be tested with a list of strings.
 *
 * ## One provider, three wire formats
 *
 * CLIProxyAPI answers every family on one port, so rlm sees one provider
 * (`cliproxy`) and each model carries its own `api` and `baseUrl`:
 *
 * - `claude-*`   → `anthropic-messages` at the root. Thinking, prompt caching
 *                  and tool use only survive the trip on Claude's own format;
 *                  squeezed through chat completions they are lost.
 * - `gpt-*`, `o<n>*`, `codex-*` → `openai-responses` at `/v1`. The Codex
 *                  backend is a Responses API; reasoning items round-trip there.
 * - anything else (gemini, grok, kimi, qwen, …) → `openai-completions` at `/v1`,
 *                  the format every upstream CLIProxyAPI wraps can speak.
 *
 * Image, audio and embedding models are not chat models and are left out of
 * the picker.
 */

export type CliproxyApi = "anthropic-messages" | "openai-responses" | "openai-completions";

/** What the built-in catalog knows about an id, when it knows it. */
export interface KnownModel {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
}

export interface CliproxyModel {
	id: string;
	name: string;
	api: CliproxyApi;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export interface CliproxyProviderConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
	api: CliproxyApi;
	models: CliproxyModel[];
}

/** Subscriptions are flat-rate: a per-token cost would only mislead the footer. */
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const NOT_CHAT = /(^|[-_/])(image|dall-e|tts|whisper|audio|embedding|embed|transcribe|moderation)([-_.]|$)/i;

export const isChatModel = (id: string): boolean => !NOT_CHAT.test(id);

export const apiFor = (id: string): CliproxyApi => {
	const bare = id.toLowerCase().split("/").pop() ?? id;
	if (bare.startsWith("claude")) return "anthropic-messages";
	if (/^(gpt-|o\d|codex)/.test(bare)) return "openai-responses";
	return "openai-completions";
};

/** Strip any trailing slash and a trailing `/v1`, so both spellings configure the same thing. */
export const rootOf = (baseUrl: string): string => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

export const buildProviderConfig = (
	ids: readonly string[],
	options: { baseUrl: string; apiKey: string; lookup?: (id: string) => KnownModel | undefined },
): CliproxyProviderConfig => {
	const root = rootOf(options.baseUrl);
	const v1 = `${root}/v1`;
	const models = [...new Set(ids)]
		.filter(isChatModel)
		.sort()
		.map((id): CliproxyModel => {
			const api = apiFor(id);
			const known = options.lookup?.(id);
			const claude = api === "anthropic-messages";
			return {
				id,
				name: known?.name ?? id,
				api,
				// The Anthropic client appends `/v1/messages` itself.
				baseUrl: claude ? root : v1,
				reasoning: known?.reasoning ?? (claude || api === "openai-responses"),
				input: known?.input ?? ["text", "image"],
				cost: FREE,
				contextWindow: known?.contextWindow ?? (claude ? 200_000 : 128_000),
				maxTokens: known?.maxTokens ?? 32_000,
			};
		});
	return { name: "CLIProxyAPI", baseUrl: v1, apiKey: options.apiKey, api: "openai-completions", models };
};

/** Same ids, same order → same picker. Used to skip no-op re-registrations. */
export const sameModels = (a: readonly { id: string }[], b: readonly { id: string }[]): boolean =>
	a.length === b.length && a.every((m, i) => m.id === b[i]?.id);
