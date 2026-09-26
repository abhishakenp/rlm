/**
 * rlm's SDK client — how any program talks to a running rlm over HTTP.
 *
 * rlm serves its HTTP API from the `integration` row (default
 * http://localhost:20130). This module is the typed client for that API and is
 * the only thing a consumer needs to import. It knows nothing about who is
 * calling: a voice assistant, a script, another agent — they all use the same
 * surface. Consumer-specific behaviour (which session to use, how to phrase a
 * request, what to do with the answer) belongs in the consumer, not here.
 *
 * Endpoints (see ./index.ts for the server side):
 *   GET    /health                     service health
 *   POST   /v1/chat/completions        OpenAI-compatible, routed through rlm's model registry
 *   POST   /v1/delegate                hand rlm a job and wait for the answer
 *   POST   /v1/sessions                record a session and its first job
 *   GET    /v1/sessions                what is still owed, by session
 *   POST   /v1/sessions/:id/spawn      add a job to a session and wait for it
 *   POST   /v1/sessions/:id/cancel     stop caring about what a session still owes
 *   DELETE /v1/sessions/:id            the same; the journal is kept
 *
 * The protocol version below changes only when a request or response shape
 * changes incompatibly.
 */
import type { ChatCompletionRequest } from "./index.js";

export const RLM_SDK_PROTOCOL = 1;
export const RLM_SDK_DEFAULT_URL = "http://localhost:20130";

export interface DelegateRequest {
	/** What to do, in plain language. Required, non-empty. */
	prompt: string;
	/** Milliseconds to wait for the answer (1 ms – 24 h). Absent uses rlm's default. */
	timeout?: number;
	/** Optional named session to record the job under. */
	session?: string;
}

export interface SessionCreateRequest {
	/** The first job. Required, non-empty. */
	prompt: string;
	/** What the session is for; defaults to the first prompt. */
	goal?: string;
}

export interface RlmIntegrationClient {
	/** POST /v1/chat/completions — OpenAI-compatible endpoint. */
	post(endpoint: "/v1/chat/completions", body: ChatCompletionRequest): Promise<Response>;
	/** GET /health — service health check. */
	health(): Promise<Response>;
}

export interface RlmClient extends RlmIntegrationClient {
	readonly baseUrl: string;
	chatCompletions(body: ChatCompletionRequest): Promise<Response>;
	delegate(body: DelegateRequest): Promise<Response>;
	createSession(body: SessionCreateRequest): Promise<Response>;
	listSessions(): Promise<Response>;
	spawn(sessionId: string, body: DelegateRequest): Promise<Response>;
	cancelSession(sessionId: string): Promise<Response>;
	deleteSession(sessionId: string): Promise<Response>;
}

const json = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

const requirePrompt = (body: { prompt?: unknown } | undefined): void => {
	if (typeof body?.prompt !== "string" || !body.prompt.trim()) throw new TypeError("prompt is required");
};

export class RlmIntegrationClientImpl implements RlmClient {
	readonly baseUrl: string;

	// 20130, not 20129: the account provisioner owns 20129 on this machine.
	constructor(baseUrl: string = RLM_SDK_DEFAULT_URL) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	private url(path: string): string {
		return this.baseUrl + path;
	}

	async post(endpoint: "/v1/chat/completions", body: ChatCompletionRequest): Promise<Response> {
		if (!body.messages?.length) throw new TypeError("messages is required");
		return fetch(this.url(endpoint), json(body));
	}

	chatCompletions(body: ChatCompletionRequest): Promise<Response> {
		return this.post("/v1/chat/completions", body);
	}

	health(): Promise<Response> {
		return fetch(this.url("/health"));
	}

	delegate(body: DelegateRequest): Promise<Response> {
		requirePrompt(body);
		return fetch(this.url("/v1/delegate"), json(body));
	}

	createSession(body: SessionCreateRequest): Promise<Response> {
		requirePrompt(body);
		return fetch(this.url("/v1/sessions"), json(body));
	}

	listSessions(): Promise<Response> {
		return fetch(this.url("/v1/sessions"));
	}

	spawn(sessionId: string, body: DelegateRequest): Promise<Response> {
		requirePrompt(body);
		return fetch(this.url(`/v1/sessions/${encodeURIComponent(sessionId)}/spawn`), json(body));
	}

	cancelSession(sessionId: string): Promise<Response> {
		return fetch(this.url(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`), { method: "POST" });
	}

	deleteSession(sessionId: string): Promise<Response> {
		return fetch(this.url(`/v1/sessions/${encodeURIComponent(sessionId)}`), { method: "DELETE" });
	}
}

export default function createClient(baseUrl?: string): RlmClient {
	return new RlmIntegrationClientImpl(baseUrl);
}
