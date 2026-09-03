/**
 * Client library for external applications (Iris) to use rlm-integration.
 *
 * Iris should import this module and use `rlmIntegrationClient.post()` instead of
 * calling Perplexity, OpenRouter, or Gemini directly. The API matches OpenAI's
 * chat completions, so minimal changes are needed to replace existing calls.
 *
 * Example replacement in Iris:
 *   - From: const response = await fetch('https://api.perplexity.ai/chat/completions', ...)
 *   - To:   const response = await rlmIntegrationClient.post('/v1/chat/completions', body)
 */
import type { ChatCompletionRequest } from './index.js';

export interface RlmIntegrationClient {
  /** POST /v1/chat/completions - OpenAI-compatible endpoint. */
  post(endpoint: "/v1/chat/completions", body: ChatCompletionRequest): Promise<Response>;
  /** GET /health - Service health check. */
  health(): Promise<Response>;
}

export class RlmIntegrationClientImpl implements RlmIntegrationClient {
  private baseUrl: string;

  constructor(baseUrl: string = "http://localhost:20129") {
    this.baseUrl = baseUrl;
  }

  async post(endpoint: "/v1/chat/completions", body: ChatCompletionRequest): Promise<Response> {
    if (!body.messages?.length) {
      throw new TypeError("messages is required");
    }
    const response = await fetch(this.baseUrl + endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response;
  }

  async health(): Promise<Response> {
    const response = await fetch(this.baseUrl + "/health");
    return response;
  }
}

export default function createClient(baseUrl?: string): RlmIntegrationClient {
  return new RlmIntegrationClientImpl(baseUrl);
}
