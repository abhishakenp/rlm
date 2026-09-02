/**
 * The one way this package reaches a model directly.
 *
 * There is already a route to a model here — `rlmAgent`, which spawns rlm in
 * print mode and is what the runner and the planner both use. That is the
 * right shape for work: an agent with tools, a session, a working directory.
 * It is the wrong shape for a reviewer, which must ask one question, get one
 * paragraph back, and above all not be able to go and *do* anything about what
 * it finds. A reviewer with hands is a second author.
 *
 * So this is a single chat completion and nothing else, and it deliberately
 * does not invent a second endpoint to make one. The provider, the base URL and
 * the key all come out of `~/.rlm/agent/models.json` — the same registry rlm's
 * own agent reads, so there is one place where "which model" is answered and
 * changing it there changes it here too. The literals below are only what to do
 * when that file cannot be read at all; they match what is in it today
 * (`omniroute` at `http://localhost:20128/v1`, key `omniroute-local`), so a
 * missing registry degrades to the same call rather than to no call.
 *
 * **On the banned key:** nothing on this path reads `ANTHROPIC_API_KEY`, and
 * nothing on it may. The key comes from the registry entry for the configured
 * provider and from nowhere else; no environment variable is consulted for
 * credentials.
 *
 * Two details that are not incidental:
 *
 *   - **`max_tokens` is large on purpose.** The models behind `auto/best-free`
 *     are reasoning models: they spend their budget inside `<think>` before
 *     they say anything. The first real run of me-2 asked for 800 and got back
 *     a truncated thought with no verdict in it, every single time, which reads
 *     as a reviewer that refuses to answer rather than as a budget.
 *   - **It throws rather than returning something empty.** `me2` turns a throw
 *     into `rejected`, which is the honest outcome: a review that did not
 *     happen is not an acceptance. Returning `""` here would hand it a silence
 *     to misread.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What it takes to make one call, once resolved. */
export interface Route {
	url: string;
	model: string;
	headers: Record<string, string>;
}

export interface AskOptions {
	/** Which provider in the registry. */
	provider?: string;
	/** Which model id. Defaults to the registry's first, else `auto/best-free`. */
	model?: string;
	/** Room to think in. Anything under ~3000 and a reasoning model never reaches a verdict. */
	maxTokens?: number;
	/** Give up on one question after this long. A reviewer that hangs hangs the drive. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** rlm's home. Only tests pass this. */
	home?: string;
	/** Stand in for the network. Only tests pass this. */
	fetch?: typeof fetch;
}

const FALLBACK = {
	baseUrl: "http://localhost:20128/v1",
	apiKey: "omniroute-local",
	authHeader: true,
	model: "auto/best-free",
};

const home = (options: AskOptions = {}): string => options.home ?? process.env.RLM_HOME ?? join(homedir(), ".rlm");

/**
 * Where the model lives, read from rlm's own registry.
 *
 * Never throws. An unreadable, malformed or half-written registry falls back to
 * the shipped defaults rather than taking the reviewer down with it — a broken
 * config file must not be the reason nothing got reviewed tonight.
 */
export const route = (options: AskOptions = {}): Route => {
	const provider = options.provider ?? process.env.RLM_REVIEW_PROVIDER ?? "omniroute";
	let entry: any = {};
	try {
		const registry = JSON.parse(readFileSync(join(home(options), "agent", "models.json"), "utf8"));
		entry = registry?.providers?.[provider] ?? {};
	} catch {
		/* the defaults below are the same call */
	}
	const baseUrl = String(entry.baseUrl || FALLBACK.baseUrl).replace(/\/+$/, "");
	const apiKey = String(entry.apiKey || FALLBACK.apiKey);
	const model =
		options.model ?? process.env.RLM_REVIEW_MODEL ?? String(entry.models?.[0]?.id || FALLBACK.model);
	const headers: Record<string, string> = { "content-type": "application/json" };
	// `authHeader` absent means the registry did not say; the router wants one.
	if (entry.authHeader !== false) headers.authorization = `Bearer ${apiKey}`;
	return { url: `${baseUrl}/chat/completions`, model, headers };
};

/**
 * One question, one answer, no tools.
 *
 * The one-shot-ness is a property of the call shape — there is no `tools` field
 * to loop over — rather than of anything the prompt asks for.
 */
export const askModel = (options: AskOptions = {}) => {
	const call = options.fetch ?? fetch;
	return async (prompt: string): Promise<string> => {
		const { url, model, headers } = route(options);
		// Four minutes is a delegation's budget, not a review's. me-2 runs inside
	// the sweep, so every second it spends is a second no work is handed out —
	// and with the late-settle path re-reviewing each stopped task every sweep,
	// a four-minute ceiling meant the drive could spend an entire sweep
	// reviewing and never reach a runnable task. Measured: 725 attempts flat
	// across eighty minutes while it looked busy.
	//
	// A review is one question about work that has already happened. If it
	// cannot answer in ninety seconds it is not going to, and me-2 fails closed
	// on no answer, which is the safe direction.
	const timeoutMs = options.timeoutMs ?? 90_000;
		const timer = AbortSignal.timeout(timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;

		let response: Response;
		try {
			response = await call(url, {
				method: "POST",
				headers,
				signal,
				body: JSON.stringify({
					model,
					max_tokens: options.maxTokens ?? 4000,
					messages: [{ role: "user", content: prompt }],
				}),
			});
		} catch (error: any) {
			// Named, because "fetch failed" against localhost means the router is
			// not running, and that is a thing to go and fix rather than a thing
			// about the work being reviewed.
			throw new Error(`${model} at ${url} could not be reached: ${error?.message ?? error}`);
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`${model} at ${url} answered ${response.status}: ${body.slice(0, 400)}`);
		}
		const payload: any = await response.json().catch((error: any) => {
			throw new Error(`${model} answered with something that is not JSON: ${error?.message ?? error}`);
		});
		const choice = payload?.choices?.[0];
		const said = String(choice?.message?.content ?? "");
		if (!said.trim()) {
			// A finish_reason of `length` here is the budget, not the model
			// declining, and saying which saves the next person the experiment.
			const stopped = choice?.finish_reason ?? "(no finish_reason)";
			throw new Error(
				`${model} said nothing (finish_reason ${stopped}` +
					`${stopped === "length" ? `, so max_tokens ${options.maxTokens ?? 4000} was too small to reach an answer` : ""})`,
			);
		}
		return said;
	};
};
