import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiFor, buildProviderConfig, isChatModel, rootOf } from "./src/catalog.ts";
import { Context } from "@deepseek-ai/cordis";
import { PLUGIN_ID, PROVIDER, RlmCliproxyService } from "./src/index.ts";

describe("catalog", () => {
	test("each family gets the wire format that keeps its features", () => {
		expect(apiFor("claude-sonnet-5")).toBe("anthropic-messages");
		expect(apiFor("gpt-5.5")).toBe("openai-responses");
		expect(apiFor("codex-auto-review")).toBe("openai-responses");
		expect(apiFor("o4-mini")).toBe("openai-responses");
		expect(apiFor("gemini-3-pro")).toBe("openai-completions");
	});

	test("image, audio and embedding models stay out of the picker", () => {
		for (const id of ["gpt-image-2", "gpt-image-2.5-flare", "text-embedding-3", "whisper-1", "gpt-4o-mini-tts"]) {
			expect(isChatModel(id)).toBe(false);
		}
		expect(isChatModel("gpt-6-sol")).toBe(true);
	});

	test("Claude talks to the root, everything else to /v1, however the URL was written", () => {
		expect(rootOf("http://127.0.0.1:8317/v1/")).toBe("http://127.0.0.1:8317");
		const cfg = buildProviderConfig(["claude-sonnet-5", "gpt-5.5", "gpt-image-2"], {
			baseUrl: "http://127.0.0.1:8317/v1",
			apiKey: "k",
		});
		expect(cfg.models.map((m) => [m.id, m.baseUrl])).toEqual([
			["claude-sonnet-5", "http://127.0.0.1:8317"],
			["gpt-5.5", "http://127.0.0.1:8317/v1"],
		]);
		expect(cfg.models.every((m) => m.cost.input === 0)).toBe(true);
	});

	test("known ids take the built-in catalog's window; unknown ones get a family default", () => {
		const cfg = buildProviderConfig(["gpt-5.5", "claude-new"], {
			baseUrl: "http://x",
			apiKey: "k",
			lookup: (id) => (id === "gpt-5.5" ? { name: "GPT-5.5", contextWindow: 272_000, maxTokens: 128_000 } : undefined),
		});
		const [claude, gpt] = cfg.models;
		expect(gpt).toMatchObject({ name: "GPT-5.5", contextWindow: 272_000, maxTokens: 128_000 });
		expect(claude).toMatchObject({ name: "claude-new", contextWindow: 200_000, reasoning: true });
	});
});

describe("row", () => {
	let ids = ["gpt-5.5"];
	let up = true;
	let server: ReturnType<typeof Bun.serve>;
	const dir = mkdtempSync(join(tmpdir(), "rlm-cliproxy-"));
	const keyFile = join(dir, "key");
	const cacheFile = join(dir, "cache.json");

	beforeAll(() => {
		writeFileSync(keyFile, "secret-key\n");
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (!up) return new Response("down", { status: 503 });
				if (req.headers.get("authorization") !== "Bearer secret-key") return new Response("no", { status: 401 });
				return Response.json({ data: ids.map((id) => ({ id, object: "model" })) });
			},
		});
	});
	afterAll(() => server.stop(true));

	// Mounted the way the host mounts it: as a Cordis plugin on a Context.
	const boot = () => {
		const root = new Context();
		const fork = root.plugin(RlmCliproxyService, {
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
			apiKeyFile: keyFile,
			cacheFile,
			refreshMs: 3_600_000,
		});
		const fakePi = () => {
			const calls: string[][] = [];
			return {
				calls,
				on() {},
				registerProvider: (name: string, cfg: any) => calls.push([name, ...cfg.models.map((m: any) => m.id)]),
				unregisterProvider: (name: string) => calls.push([`-${name}`]),
			};
		};
		let svc!: RlmCliproxyService;
		const init = async () => {
			for (let i = 0; i < 100 && !(svc = root.get("rlmCliproxy") as RlmCliproxyService); i++) await Bun.sleep(10);
			await svc.refresh();
		};
		return {
			get svc() {
				return svc;
			},
			fakePi,
			init,
			dispose: () => fork.dispose(),
		};
	};

	const factory = () => ((globalThis as any).__rlmExtensionFactories as any[]).find((e) => e.id === PLUGIN_ID).factory;

	test("a session gets the listing, and a changed listing reaches it live", async () => {
		const b = boot();
		const { fakePi, dispose } = b;
		await b.init();
		const svc = b.svc;
		const pi = fakePi();
		factory()(pi);
		expect(pi.calls).toEqual([[PROVIDER, "gpt-5.5"]]);

		ids = ["gpt-5.5", "claude-sonnet-5", "gpt-image-2"];
		await svc.refresh();
		expect(pi.calls.at(-1)).toEqual([PROVIDER, "claude-sonnet-5", "gpt-5.5"]);

		// Same listing again: no re-registration churn.
		await svc.refresh();
		expect(pi.calls.length).toBe(2);
		dispose();
	});

	test("an outage keeps the last listing instead of emptying the picker", async () => {
		const b = boot();
		const { fakePi, dispose } = b;
		await b.init();
		const svc = b.svc;
		await svc.refresh();
		up = false;
		expect(await svc.refresh()).toEqual([`${PROVIDER}/claude-sonnet-5`, `${PROVIDER}/gpt-5.5`]);
		expect(svc.status().error).toContain("503");
		const pi = fakePi();
		factory()(pi);
		expect(pi.calls).toEqual([[PROVIDER, "claude-sonnet-5", "gpt-5.5"]]);
		up = true;
		dispose();
	});

	test("the cache on disk never carries the key", async () => {
		const b = boot();
		const { dispose } = b;
		await b.init();
		const svc = b.svc;
		ids = ["gpt-6-sol"];
		await svc.refresh();
		const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
		expect(cached.apiKey).toBe("");
		expect(cached.models.map((m: any) => m.id)).toEqual(["gpt-6-sol"]);
		expect(readFileSync(cacheFile, "utf8")).not.toContain("secret-key");
		dispose();
	});

	test("an empty listing unregisters the provider", async () => {
		const b = boot();
		const { fakePi, dispose } = b;
		await b.init();
		const svc = b.svc;
		await svc.refresh();
		const pi = fakePi();
		factory()(pi);
		ids = [];
		await svc.refresh();
		expect(pi.calls.at(-1)).toEqual([`-${PROVIDER}`]);
		dispose();
	});
});
