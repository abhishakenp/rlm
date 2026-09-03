/**
 * @rlm/integration — RLM AI capabilities exposed to external applications.
 *
 * This plugin makes RLM's AI routing available to external apps (notably Iris)
 * that should not contain AI logic directly. Rather than calling Perplexity,
 * OpenRouter, or Gemini APIs directly from Iris, Iris makes HTTP calls to this
 * integration layer, which routes through RLM's model registry.
 *
 * ## What it provides
 *
 * - An HTTP server (configurable port, default 20129) that serves two endpoints:
 *     POST /v1/chat/completions  — compatible with OpenAI's chat completions API
 *     GET  /health                — health check for service discovery
 *
 * - A client library (exported from "./client") that Iris can use to call
 *   the integration server with the same interface as a direct API call.
 *
 * - Cordis service registration so the server starts/stops with RLM.
 *
 * ## Why this matters
 *
 * The request that created this plugin: "Iris herself should contain no AI at
 * all — instead build an rlm-integration plugin pointing at ~/proj/rlm."
 *
 * Before this, Iris called Perplexity, OpenRouter, and Gemini directly from:
 *     core/skills/deep_research/impl.js    — perplexity + openrouter /chat/completions
 *     core/skills/web_search/impl.js        — perplexity /chat/completions
 *     core/skills/capture_screen/impl.js    — gemini /v1beta/models/...:generateContent
 *
 * After this, Iris calls POST http://localhost:20129/v1/chat/completions with the
 * same request shape, and this layer routes it through RLM's model registry.
 *
 * ## RLM as the boundary
 *
 * RLM already has a model registry at ~/.rlm/agent/models.json. This integration
 * reads the same registry and routes calls accordingly, so "which model" is
 * answered in one place and changes propagate to both RLM and any integration
 * client automatically.
 *
 * Hot-swappable: edit this file and the fiber restarts.
 */
import { Service } from "@deepseek-ai/cordis";
import express, { type Application, type Request, type Response } from "express";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { route as modelRoute, type Route } from "../../rlm-delegate/src/ask.ts";

declare module "@deepseek-ai/cordis" {
	interface Events {
		/** Integration server started. @mode emit */
		"rlm/integration-started"(data: { port: number }): void;
		/** Integration server stopped. @mode emit */
		"rlm/integration-stopped"(data: { reason: string }): void;
		/** A request was proxied through the integration. @mode emit */
		"rlm/integration-request"(data: { method: string; path: string; status: number; durationMs: number }): void;
	}
}

export interface RlmIntegrationConfig {
	/** TCP port for the HTTP server. Default: 20129. */
	port?: number;
	/** Host to bind. Default: localhost (security: do not expose publicly). */
	host?: string;
	/** Path to RLM home. Default: ~/.rlm. */
	home?: string;
	/** Whether to start the server on boot. Default: true. */
	enabled?: boolean;
}

export const name = "rlm-integration";

/** OpenAI-compatible chat completions request shape (subset). */
interface ChatCompletionRequest {
	model?: string;
	messages: Array<{ role: string; content: string }>;
	max_tokens?: number;
	temperature?: number;
	stream?: boolean;
}

export class RlmIntegration extends Service {
	/** Cordis injections. */
	static inject = ["rlmConfig"] as const;
	static provide = "rlmIntegration" as const;

	private config: Required<RlmIntegrationConfig>;
	private app: Application;
	private server: Server | null = null;

	constructor(goog: any) {
		super(goog, undefined as any);
		const raw = (goog.rlmConfig as any)?.get?.("rlm-integration") ?? {};
		this.config = {
			port: raw.port ?? 20129,
			host: raw.host ?? "localhost",
			home: raw.home ?? join(homedir(), ".rlm"),
			enabled: raw.enabled ?? true,
		};
		this.app = express();
		this.app.use(express.json({ limit: "10mb" }));
	}

	async [Service.init]() {
		if (!this.config.enabled) {
			console.error("[rlm] rlm-integration: disabled by config");
			return;
		}
		await this.start();
	}

	async [Service.stop]() {
		await this.stop("service_stop");
	}

	/** Start the HTTP server. Idempotent. */
	async start(): Promise<void> {
		if (this.server) return;
		const { port, host } = this.config;

		this.app.get("/health", (_req: Request, res: Response) => {
			res.json({ ok: true, service: "rlm-integration", version: "0.1.0" });
		});

		/** OpenAI-compatible /v1/chat/completions endpoint. */
		this.app.post("/v1/chat/completions", async (req: Request, res: Response) => {
			const t0 = Date.now();
			try {
				const body = req.body as ChatCompletionRequest;
				if (!body.messages?.length) {
					res.status(400).json({ error: { message: "messages is required", type: "invalid_request_error" } });
					return;
				}

				// Route through RLM's model registry.
				const route = modelRoute({ home: this.config.home, model: body.model });

				// Forward to the actual provider.
				const response = await fetch(route.url, {
					method: "POST",
					headers: {
						...route.headers,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: route.model,
						messages: body.messages,
						max_tokens: body.max_tokens,
						temperature: body.temperature,
						stream: body.stream,
					}),
				});

				const durationMs = Date.now() - t0;
				this.ctx.emit("rlm/integration-request", {
					method: "POST",
					path: "/v1/chat/completions",
					status: response.status,
					durationMs,
				});

				// Stream or JSON depending on request.
				if (body.stream) {
					res.status(response.status).setHeader("content-type", "text/event-stream");
					if (!response.body) { res.end(); return; }
					for await (const chunk of response.body) {
						res.write(chunk);
					}
					res.end();
				} else {
					const data = await response.json();
					res.status(response.status).json(data);
				}
			} catch (err: any) {
				const durationMs = Date.now() - t0;
				this.ctx.emit("rlm/integration-request", {
					method: "POST",
					path: "/v1/chat/completions",
					status: 500,
					durationMs,
				});
				res.status(500).json({ error: { message: String(err?.message ?? err) } });
			}
		});

		return new Promise((resolve) => {
			this.server = createServer(this.app);
			this.server.listen(port, host, () => {
				console.error(`[rlm] rlm-integration: listening on http://${host}:${port}`);
				this.ctx.emit("rlm/integration-started", { port });
				resolve();
			});
		});
	}

	/** Stop the HTTP server. Idempotent. */
	async stop(reason = "manual"): Promise<void> {
		if (!this.server) return;
		return new Promise((resolve) => {
			this.server!.close(() => {
				console.error(`[rlm] rlm-integration: stopped (${reason})`);
				this.server = null;
				this.ctx.emit("rlm/integration-stopped", { reason });
				resolve();
			});
		});
	}

	/** Current server status. */
	get status() {
		return { running: this.server !== null, config: this.config };
	}
}
