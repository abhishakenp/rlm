// Tests for rlm's SDK client (src/client.ts) — how any program reaches rlm on
// :20130 instead of calling model providers itself. A local server stands
// in for the integration row, so these run without a live rlm.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import createClient, { RlmIntegrationClientImpl } from "../src/client.ts";

let server;
const seen = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "POST" ? await req.json() : undefined;
			seen.push({ method: req.method, path: url.pathname, contentType: req.headers.get("content-type"), body });
			if (url.pathname === "/health") return Response.json({ ok: true });
			if (url.pathname === "/v1/chat/completions") {
				return Response.json({
					model: body.model,
					choices: [{ message: { role: "assistant", content: `echo:${body.messages.at(-1).content}` } }],
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}`;

describe("rlm-integration client", () => {
	it("defaults to the integration port", () => {
		expect(new RlmIntegrationClientImpl().baseUrl).toBe("http://localhost:20130");
	});

	it("health() reaches /health", async () => {
		const res = await createClient(base()).health();
		expect(res.ok).toBe(true);
		expect(await res.json()).toEqual({ ok: true });
		expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/health" });
	});

	it("post() sends an OpenAI-shaped chat request as JSON", async () => {
		const res = await createClient(base()).post("/v1/chat/completions", {
			model: "auto/best-free",
			messages: [{ role: "user", content: "ping" }],
		});
		expect(res.ok).toBe(true);
		const json = await res.json();
		expect(json.choices[0].message.content).toBe("echo:ping");
		const req = seen.at(-1);
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/v1/chat/completions");
		expect(req.contentType).toContain("application/json");
		expect(req.body.model).toBe("auto/best-free");
	});

	it("post() refuses a request with no messages before touching the network", async () => {
		const before = seen.length;
		await expect(createClient(base()).post("/v1/chat/completions", { model: "x", messages: [] })).rejects.toThrow(
			"messages is required",
		);
		expect(seen.length).toBe(before);
	});
});

describe("rlm SDK client: delegate and sessions", () => {
	let api;
	const hits = [];
	beforeAll(() => {
		api = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const url = new URL(req.url);
				const text = await req.text();
				hits.push({ method: req.method, path: url.pathname, body: text ? JSON.parse(text) : undefined });
				return Response.json({ ok: true });
			},
		});
	});
	afterAll(() => api.stop(true));
	const client = () => createClient(`http://127.0.0.1:${api.port}/`);

	it("maps every method to its endpoint and verb", async () => {
		const c = client();
		await c.delegate({ prompt: "do it", timeout: 5000 });
		await c.createSession({ prompt: "first", goal: "goal" });
		await c.listSessions();
		await c.spawn("g/1", { prompt: "next" });
		await c.cancelSession("g/1");
		await c.deleteSession("g/1");
		expect(hits.map((h) => `${h.method} ${h.path}`)).toEqual([
			"POST /v1/delegate",
			"POST /v1/sessions",
			"GET /v1/sessions",
			"POST /v1/sessions/g%2F1/spawn",
			"POST /v1/sessions/g%2F1/cancel",
			"DELETE /v1/sessions/g%2F1",
		]);
		expect(hits[0].body).toEqual({ prompt: "do it", timeout: 5000 });
	});

	it("refuses an empty prompt before touching the network", () => {
		const before = hits.length;
		expect(() => client().delegate({ prompt: "  " })).toThrow("prompt is required");
		expect(() => client().spawn("x", { prompt: "" })).toThrow("prompt is required");
		expect(hits.length).toBe(before);
	});

	it("strips a trailing slash from the base URL", () => {
		expect(client().baseUrl.endsWith("/")).toBe(false);
	});
});
