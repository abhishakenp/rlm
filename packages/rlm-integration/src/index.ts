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
 * - An HTTP server (configurable port, default 20130) that serves:
 *     GET  /health                     — health check for service discovery
 *     POST /v1/chat/completions        — compatible with OpenAI's chat completions API
 *     POST /v1/delegate                — hand rlm a job and wait for the answer
 *     POST /v1/sessions                — record a session and its first job
 *     GET  /v1/sessions                — what is still owed, by session
 *     POST /v1/sessions/:id/spawn      — add a job to a session and wait for it
 *     POST /v1/sessions/:id/cancel     — stop caring about what a session still owes
 *     DELETE /v1/sessions/:id          — the same, and say the journal is kept
 *
 *   **The port moved from 20129 to 20130.** 20129 is held on this machine by the
 *   account provisioner, which was live at the time this row was written, and two
 *   services that both believe they own a port is a bind error at boot for
 *   whichever loses the race. It is config either way.
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
 * After this, Iris calls POST http://localhost:20130/v1/chat/completions with the
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
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server } from "node:net";
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
	/** TCP port for the HTTP server. Default: 20130. */
	port?: number;
	/**
	 * What to bind. Default: `loopback`, which is both `127.0.0.1` and `::1`.
	 *
	 * Not `localhost`: that is a name, the resolver picks one of the two
	 * addresses behind it, and node binds only that one — measured here as
	 * `[::1]` alone, with `127.0.0.1` refused and `localhost` working purely by
	 * the accident of this machine's resolver order. `loopback` opens one socket
	 * per address so both spellings answer, and neither is reachable off the
	 * machine. Any other value is taken literally and binds exactly that.
	 */
	host?: string;
	/** Path to RLM home. Default: ~/.rlm. */
	home?: string;
	/** Whether to start the server on boot. Default: true. */
	enabled?: boolean;
	/**
	 * Which process serves the port. Default `daemon`: with `RLM_DAEMON=1` only
	 * prime-agent's daemon supervisor listens — it is the one process that is up
	 * whenever rlm is — and clients, workers and `--print` runs leave the port
	 * alone. Without the daemon every process tries and the first to bind wins,
	 * as before. `any`: always the latter.
	 */
	owner?: "daemon" | "any";
}

/** prime-agent's supervisor: `--mode daemon` without the worker role in the environment. */
function isDaemonSupervisorProcess(): boolean {
	const argv = process.argv;
	const index = argv.indexOf("--mode");
	const daemon = (index >= 0 && argv[index + 1] === "daemon") || argv.includes("--mode=daemon");
	return daemon && !process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER;
}


export const name = "rlm-integration";

/** How long a disposed fiber keeps the sockets open for a successor to take over. */
const RELEASE_GRACE_MS = 3000;

interface SharedSockets {
	servers: Server[];
	handler: Application | ((req: any, res: any) => void);
	owner?: object;
	closing?: ReturnType<typeof setTimeout>;
}

/**
 * The listening sockets, per port and host, kept on `globalThis` so they outlive
 * the module and the fiber: a hot reload evaluates this file again (a fresh
 * module scope) and swaps the fiber, and both must find the sockets the
 * previous generation opened rather than bind the port a second time.
 */
/** Does something already answer HTTP on this port? (a live rlm-integration, or anything else) */
const portAnswers = (port: number, address: string): Promise<boolean> =>
	new Promise((resolveProbe) => {
		const socket = require("node:net").connect({ port, host: address });
		const done = (answer: boolean) => {
			socket.destroy();
			resolveProbe(answer);
		};
		socket.setTimeout(300, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});

const sharedSockets = (port: number, host: string): SharedSockets => {
	const all = ((globalThis as any).__rlmIntegrationSockets ??= new Map<string, SharedSockets>()) as Map<
		string,
		SharedSockets
	>;
	const key = `${host}:${port}`;
	let entry = all.get(key);
	if (!entry) {
		entry = { servers: [], handler: (_req: any, res: any) => res.writeHead(503).end() };
		all.set(key, entry);
	}
	return entry;
};

/** OpenAI-compatible chat completions request shape (subset). */
export interface ChatCompletionRequest {
	model?: string;
	messages: Array<{ role: string; content: string }>;
	max_tokens?: number;
	temperature?: number;
	stream?: boolean;
}

export class RlmIntegration extends Service {
	/**
	 * Cordis injections.
	 *
	 * `rlmDelegate` is *not* injected: a composition without it must still serve
	 * `/health` and the completions proxy, and cordis 4 has no optional inject.
	 * It is probed with `ctx.get` per request instead, and the delegation routes
	 * answer 503 with a sentence when it is not there — never an empty success,
	 * which is the failure mode that makes an integration look wired when it is
	 * not.
	 */
	static inject = ["rlmConfig"] as const;
	static provide = "rlmIntegration" as const;

	private config: Required<RlmIntegrationConfig>;
	private app: Application;
	/**
	 * One server per loopback address, not one server.
	 *
	 * `listen(port, "localhost")` binds whatever the resolver puts first, and on
	 * this machine that is `::1` alone — measured: `lsof` showed
	 * `TCP [::1]:20130 (LISTEN)`, `curl http://localhost:20130/health` returned
	 * 200 and `curl http://127.0.0.1:20130/health` was refused. So the seam
	 * worked only by the accident of a resolver order, and any caller that spells
	 * the address `127.0.0.1`, or runs where `localhost` resolves to IPv4 first —
	 * a container, a Linux box, node started with `--dns-result-order=ipv4first`
	 * — got `ECONNREFUSED` and would have read it as "rlm is down".
	 *
	 * Binding `::` or `0.0.0.0` would fix reachability by putting the row on
	 * every interface, which is the one thing the original comment on `host` said
	 * not to do. One socket cannot hold two addresses, so loopback-on-both-stacks
	 * is two sockets sharing one express app. A machine with no IPv6 keeps the
	 * IPv4 one and says so; the row does not fail to mount over it.
	 */
	private servers: Server[] = [];
	/**
	 * Who owns the shared sockets, by token rather than by `this`: cordis hands
	 * callers a proxy of the service, so `this` inside a method reached through
	 * it is not the object `start` stored.
	 */
	private readonly token = {};

	/**
	 * Cordis hands a row `(ctx, config)`, and this took only the first.
	 *
	 * So the `config:` block under the row in `cordis.yml` — the port, the host,
	 * the on/off switch — was read by nobody, and the only way to change any of
	 * it was through the overlay. The row was never in `cordis.yml` until now, so
	 * nothing had ever tried. The block wins where it says something; the overlay
	 * stands in behind it, which is the order every other row uses.
	 *
	 * A default parameter does not catch `null`, and YAML reads an empty
	 * `config:` as `null` rather than as an absent key — the same trap
	 * `rlm-agent` documents.
	 */
	constructor(ctx: any, config?: RlmIntegrationConfig | null) {
		super(ctx, undefined as any);
		const overlay = (ctx.rlmConfig as any)?.get?.("rlm-integration") ?? {};
		const raw = { ...overlay, ...(config ?? {}) };
		this.config = {
			port: raw.port ?? 20130,
			host: raw.host ?? "loopback",
			home: raw.home ?? join(homedir(), ".rlm"),
			enabled: raw.enabled ?? true,
			owner: raw.owner ?? "daemon",
		};
		this.app = express();
	}

	async [Service.init]() {
		if (!this.config.enabled) {
			console.error("[rlm] rlm-integration: disabled by config");
			return;
		}
		// Cleanup used to live in `[Service.stop]`. Cordis 4 defines no such
		// symbol, so that was a method named "undefined" that nothing ever called,
		// and a swapped fiber kept :20130 bound with no way to hand it on. The
		// effect's disposer is what cordis actually runs when the fiber goes.
		(this.ctx as { effect: (fn: () => () => void) => void }).effect(() => () => {
			if (this.takeoverTimer) clearTimeout(this.takeoverTimer);
			void this.release("fiber disposed");
		});
		if ((this.config.owner ?? "daemon") === "daemon" && !isDaemonSupervisorProcess() && process.env.RLM_DAEMON === "1") {
			this.ctx.logger?.info?.("rlm-integration: the daemon supervisor serves the port; not listening in this process");
			return;
		}
		if (isDaemonSupervisorProcess()) {
			// The supervisor is the long-lived owner. It binds with SO_REUSEPORT beside
			// an rlm that may hold the port already (see start), so it takes over at
			// once; the retry below is only for a port held without SO_REUSEPORT.
			this.startWhenFree();
			return;
		}
		await this.start();
	}

	private takeoverTimer?: ReturnType<typeof setTimeout>;

	private startWhenFree(): void {
		this.start().catch((error) => {
			if (!String(error?.message ?? error).includes("EADDRINUSE")) {
				console.error(`[rlm] rlm-integration: ${String(error?.message ?? error)}`);
				return;
			}
			this.ctx.logger?.info?.("rlm-integration: port held by another rlm; the supervisor will take it over when it frees");
			this.takeoverTimer = setTimeout(() => this.startWhenFree(), 5_000);
			this.takeoverTimer.unref?.();
		});
	}

	/**
	 * A hot patch (rlm-hmr) replaced this class's methods in place. The routes
	 * were registered at start with the old closures, so rebuild the app from the
	 * new code and point the live sockets at it. The sockets never close: a
	 * request in flight finishes on the app it started on, the next one lands on
	 * the new one.
	 */
	[Symbol.for("rlm.hmr.patched")](): void {
		const shared = sharedSockets(this.config.port, this.config.host);
		if (shared.owner !== this.token) return;
		shared.handler = this.buildApp();
	}

	/**
	 * Every route, on a fresh express app. Separate from `start` so a hot patch or
	 * a swapped fiber can rebuild the handler without touching the sockets.
	 */
	private buildApp(): Application {
		this.app = express();
		this.app.use(express.json({ limit: "10mb" }));

		this.app.get("/health", (_req: Request, res: Response) => {
			// Whether the delegation routes can actually do anything is part of
			// "are you healthy". A 200 that does not say so is how a caller ends up
			// pointing at a server that will 503 every real request.
			const delegate = this.ctx.get("rlmDelegate") as { delegate?: unknown } | undefined;
			res.json({
				ok: true,
				service: "rlm-integration",
				version: "0.1.0",
				port: this.config.port,
				delegate: typeof delegate?.delegate === "function",
			});
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

		this.mountDelegation();
		return this.app;
	}

	/** Start the HTTP server. Idempotent. */
	async start(): Promise<void> {
		if (this.servers.length) return;
		const { port, host } = this.config;
		const shared = sharedSockets(port, host);
		const app = this.buildApp();

		// A swapped fiber (or a second mount in this process) takes over the
		// sockets the previous one opened instead of racing it for the port: the
		// old fiber's release is deferred (see `release`), so for a swap the
		// sockets are still open here, and nothing ever refuses a connection.
		if (shared.servers.length) {
			if (shared.closing) clearTimeout(shared.closing);
			shared.closing = undefined;
			shared.handler = app;
			shared.owner = this.token;
			this.servers = shared.servers;
			this.ctx.logger?.info?.(`rlm-integration: took over the sockets on port ${port} — no rebind`);
			this.ctx.emit("rlm/integration-started", { port });
			return;
		}

		// `loopback` is a pair of addresses, not one. Anything else is taken
		// literally, so a caller that really does want one interface still gets it.
		const wanted = host === "loopback" ? ["127.0.0.1", "::1"] : [host];

		// Sockets bind with SO_REUSEPORT so a successor process (the daemon
		// supervisor taking over from an in-process rlm, e.g. after /daemon) can
		// bind while the old owner still listens: the newest bind takes new
		// connections and the port is never unbound — zero refused. That would
		// also let every extra rlm steal the port, so an ordinary process first
		// asks whether someone already serves it and, if so, stays out (as a
		// failed bind used to make it). The supervisor is the owner by design and
		// takes over at once.
		if (!isDaemonSupervisorProcess() && (await portAnswers(port, wanted[0]!))) {
			this.ctx.logger?.info?.(`rlm-integration: port ${port} is served by another process — this one stays idle`);
			return;
		}
		// The sockets dispatch through `shared.handler`, looked up per request, so
		// the app behind them can be replaced while they stay open.
		const dispatch = (req: any, res: any) => (shared.handler as any)(req, res);
		shared.handler = app;
		const bind = (address: string) =>
			new Promise<{ address: string; server: Server | null; error?: string }>((resolve) => {
				// Bun's node:http ignores SO_REUSEPORT, node:net honours it: listen with
				// net and hand each connection to an HTTP server that never binds.
				const http = createHttpServer(dispatch);
				const connections = new Set<import("node:net").Socket>();
				const server = createNetServer((socket) => {
					connections.add(socket);
					socket.once("close", () => connections.delete(socket));
					http.emit("connection", socket);
				});
				// Closing the listener must also end its kept-alive connections, as
				// closing an http server that owned them did.
				const closeListener = server.close.bind(server);
				server.close = ((callback?: (error?: Error) => void) => {
					for (const socket of connections) socket.destroy();
					connections.clear();
					return closeListener(callback);
				}) as typeof server.close;
				const failed = (error: any) => {
					server.removeAllListeners();
					try {
						server.close();
					} catch {
						/* it never opened */
					}
					resolve({ address, server: null, error: String(error?.code ?? error?.message ?? error) });
				};
				server.once("error", failed);
				server.listen({ port, host: address, reusePort: true } as any, () => {
					server.removeListener("error", failed);
					resolve({ address, server });
				});
			});

		const outcomes = await Promise.all(wanted.map(bind));
		this.servers = outcomes.map((o) => o.server).filter((s): s is Server => s !== null);
		// Every address busy is the normal case for a second rlm: the first one
		// owns the port. Two stderr lines on every extra launch told the user
		// nothing, and "the other address still answers" was false — neither bound.
		const portHeldElsewhere = !this.servers.length && outcomes.every((o) => o.error === "EADDRINUSE");
		for (const outcome of outcomes) {
			if (outcome.server) console.error(`[rlm] rlm-integration: listening on http://${outcome.address}:${port}`);
			else if (!portHeldElsewhere)
				console.error(
					`[rlm] rlm-integration: could not bind ${outcome.address}:${port} (${outcome.error})` +
						(this.servers.length ? " — the other loopback address still answers" : ""),
				);
		}
		if (!this.servers.length) {
			// Every address refused. Said as an error rather than swallowed: a row
			// that reports itself started while nothing is listening is the failure
			// mode this whole seam has to not have.
			const why = outcomes.map((o) => `${o.address}: ${o.error}`).join("; ");
			// Another process owning the port is the normal case for every rlm
			// after the first, and not a failure of this one. It used to throw
			// here, and a FAILED row kept the composition from settling — rlm-boot
			// waits for it before layering the overlay — so every overlay row
			// (tps, omni-access, eleksha, …) silently never mounted, and inside a
			// daemon worker the throw aborted the whole boot. Stay mounted, idle,
			// and say so where it can be read (`status.running` is false).
			if (portHeldElsewhere) {
				this.ctx.logger?.info?.(`rlm-integration: port ${port} is served by another process — this one stays idle (${why})`);
				return;
			}
			throw new Error(`rlm-integration: nothing could be bound on port ${port} — ${why}`);
		}
		shared.servers = this.servers;
		shared.owner = this.token;
		this.ctx.emit("rlm/integration-started", { port });
	}

	/**
	 * The rlm agent itself, over HTTP.
	 *
	 * Everything above this line proxies to a provider. Everything below hands
	 * work to `rlmDelegate`, which records it in a durable journal before anybody
	 * runs it — so a caller that disconnects, a process that dies, or a timeout
	 * that fires leaves the job still owed rather than gone.
	 *
	 * A "session" is a graph. It is already the thing that holds a run's tasks,
	 * survives the process, and can be added to; inventing a second noun for the
	 * API would mean two things that both half-mean "a run".
	 */
	private mountDelegation() {
		/**
		 * The delegate row, or null.
		 *
		 * Probed per request rather than injected, so this row still serves
		 * `/health` and the completions proxy in a composition that has no
		 * delegate — and so a hot reload of the delegate row is picked up without
		 * restarting the server.
		 */
		const delegate = () =>
			this.ctx.get("rlmDelegate") as
				| {
						delegate(opts: { prompt: string; session?: string; timeout?: number; source?: string }): Promise<{
							ok: boolean;
							output: string;
							ms: number;
							events: string[];
							graph?: string;
							task?: string;
						}>;
						sessions(): Array<{ id: string; goal: string; status: string; tasks: Array<{ id: string; state: string; title: string }> }>;
						declare(goal: string, tasks: unknown[], graphId?: string): { id: string };
						cancel(graphId: string, why?: string): { ok: boolean; cancelled: string[] };
						get(graphId: string): unknown;
				  }
				| undefined;

		/** 503 with a sentence, never a 200 with nothing in it. */
		const absent = (res: Response) => {
			res.status(503).json({
				error: {
					message:
						"rlm-delegate is not mounted in this composition, so there is nothing here to hand work to",
					type: "service_unavailable",
				},
			});
		};

		const bad = (res: Response, message: string) => {
			res.status(400).json({ error: { message, type: "invalid_request_error" } });
		};

		/** A prompt, validated. Never echoed back on the failure path. */
		const promptOf = (body: any): string | null => {
			const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
			return prompt.length ? prompt : null;
		};

		/** A timeout in milliseconds, validated. */
		const timeoutOf = (body: any): number | undefined | "bad" => {
			if (body?.timeout === undefined || body?.timeout === null) return undefined;
			const ms = Number(body.timeout);
			if (!Number.isFinite(ms) || ms <= 0 || ms > 24 * 60 * 60 * 1000) return "bad";
			return ms;
		};

		const record = (path: string, status: number, t0: number) =>
			this.ctx.emit("rlm/integration-request", { method: "POST", path, status, durationMs: Date.now() - t0 });

		const handOver = async (req: Request, res: Response, path: string, session?: string) => {
			const t0 = Date.now();
			const svc = delegate();
			if (!svc?.delegate) {
				record(path, 503, t0);
				return absent(res);
			}
			const prompt = promptOf(req.body);
			if (!prompt) {
				record(path, 400, t0);
				return bad(res, "prompt is required and must be a non-empty string");
			}
			const timeout = timeoutOf(req.body);
			if (timeout === "bad") {
				record(path, 400, t0);
				return bad(res, "timeout must be a positive number of milliseconds, at most 86400000");
			}
			const named = session ?? (typeof req.body?.session === "string" ? req.body.session : undefined);
			if (named !== undefined && !/^[A-Za-z0-9._-]{1,120}$/.test(named)) {
				record(path, 400, t0);
				return bad(res, "session must be a graph id: letters, digits, dot, underscore or dash");
			}
			try {
				const answer = await svc.delegate({
					prompt,
					...(named ? { session: named } : {}),
					...(timeout ? { timeout } : {}),
					source: "rlm-integration",
				});
				record(path, 200, t0);
				res.status(200).json(answer);
			} catch (err: any) {
				record(path, 500, t0);
				res.status(500).json({ error: { message: String(err?.message ?? err) } });
			}
		};

		this.app.post("/v1/delegate", (req: Request, res: Response) => void handOver(req, res, "/v1/delegate"));

		this.app.post("/v1/sessions", (req: Request, res: Response) => {
			const t0 = Date.now();
			const svc = delegate();
			if (!svc?.declare) {
				record("/v1/sessions", 503, t0);
				return absent(res);
			}
			// A session must arrive with its first job. The store refuses a graph
			// with no tasks — *"a graph needs at least one task"* — and it is right
			// to: an empty graph is a row in a journal that can never settle and can
			// never be worked, which is exactly the "scaffold announced as a
			// capability" this whole row exists to not be. So the API does not
			// invent an empty-session noun to paper over it.
			const first = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
			if (!first) {
				record("/v1/sessions", 400, t0);
				return bad(res, "prompt is required: a session is a graph, and a graph needs at least one task");
			}
			const goal = typeof req.body?.goal === "string" && req.body.goal.trim() ? req.body.goal.trim() : first;
			try {
				// Recorded, not run. The work is owed the moment it is written down;
				// `/spawn` is what asks for it to be done now.
				const taskId = "the-request";
				const graph = svc.declare(goal.slice(0, 1000), [
					{
						id: taskId,
						title: (first.split("\n").find((l: string) => l.trim()) ?? first).trim().slice(0, 140),
						prompt: first,
						proof: { kind: "unstated", note: "it arrived through rlm-integration and nobody has said how to tell" },
					},
				]);
				record("/v1/sessions", 200, t0);
				res.status(200).json({ id: graph.id, task: taskId });
			} catch (err: any) {
				record("/v1/sessions", 500, t0);
				res.status(500).json({ error: { message: String(err?.message ?? err) } });
			}
		});

		this.app.get("/v1/sessions", (_req: Request, res: Response) => {
			const svc = delegate();
			if (!svc?.sessions) return absent(res);
			try {
				res.status(200).json({ sessions: svc.sessions() });
			} catch (err: any) {
				res.status(500).json({ error: { message: String(err?.message ?? err) } });
			}
		});

		this.app.post("/v1/sessions/:id/spawn", (req: Request, res: Response) => {
			void handOver(req, res, "/v1/sessions/:id/spawn", String(req.params.id ?? ""));
		});

		const stopCaring = (req: Request, res: Response, path: string) => {
			const t0 = Date.now();
			const svc = delegate();
			if (!svc?.cancel) {
				record(path, 503, t0);
				return absent(res);
			}
			const id = String(req.params.id ?? "");
			if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) {
				record(path, 400, t0);
				return bad(res, "session id must be letters, digits, dot, underscore or dash");
			}
			try {
				const outcome = svc.cancel(id, "cancelled through rlm-integration");
				if (!outcome.ok) {
					record(path, 404, t0);
					res.status(404).json({ error: { message: `no such session: ${id}`, type: "not_found" } });
					return;
				}
				record(path, 200, t0);
				res.status(200).json({
					ok: true,
					cancelled: outcome.cancelled,
					// Said out loud rather than implied. This row's entire premise is
					// that a task cannot be forgotten, so a cancelled task is one with
					// a recorded ending — not one with no record.
					note: "the journal is kept; every outstanding task was ended as failed with the reason on it",
				});
			} catch (err: any) {
				record(path, 500, t0);
				res.status(500).json({ error: { message: String(err?.message ?? err) } });
			}
		};

		this.app.post("/v1/sessions/:id/cancel", (req: Request, res: Response) =>
			stopCaring(req, res, "/v1/sessions/:id/cancel"),
		);
		this.app.delete("/v1/sessions/:id", (req: Request, res: Response) =>
			stopCaring(req, res, "DELETE /v1/sessions/:id"),
		);
	}

	/**
	 * The fiber is going. For a hot swap a successor mounts within milliseconds
	 * and takes the sockets over in `start`; closing here would refuse every
	 * connection in between. So the close is deferred by `RELEASE_GRACE_MS` and
	 * cancelled by a successor. A row that is really removed closes after it.
	 */
	private release(reason: string): void {
		const shared = sharedSockets(this.config.port, this.config.host);
		if (shared.owner !== this.token) {
			this.servers = [];
			return;
		}
		if (shared.closing) clearTimeout(shared.closing);
		shared.closing = setTimeout(() => {
			shared.closing = undefined;
			if (shared.owner === this.token) void this.stop(reason);
		}, RELEASE_GRACE_MS);
		shared.closing.unref?.();
	}

	/** Stop every socket the row opened. Idempotent. */
	async stop(reason = "manual"): Promise<void> {
		if (!this.servers.length) return;
		const closing = this.servers;
		this.servers = [];
		const shared = sharedSockets(this.config.port, this.config.host);
		if (shared.owner === this.token) {
			shared.servers = [];
			shared.owner = undefined;
			if (shared.closing) clearTimeout(shared.closing);
			shared.closing = undefined;
		}
		await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		console.error(`[rlm] rlm-integration: stopped (${reason})`);
		this.ctx.emit("rlm/integration-stopped", { reason });
	}

	/** Current server status, including which addresses actually answer. */
	get status() {
		return {
			running: this.servers.length > 0,
			listening: this.servers.map((s) => {
				const at = s.address();
				return typeof at === "string" ? at : `${at?.address}:${at?.port}`;
			}),
			config: this.config,
		};
	}
}

/**
 * The row, as cordis expects to receive it.
 *
 * There was no default export, so the loader read the module's namespace object
 * and refused it: *"invalid plugin, expect function or object with an `apply`
 * method"*. Nothing had ever caught it because the row was not in `cordis.yml`
 * — it existed, it type-checked, and it could not be mounted. Every other row
 * in this repo default-exports its service class; this one now does too.
 */
export default RlmIntegration;
export const inject = ["rlmConfig"] as const;
