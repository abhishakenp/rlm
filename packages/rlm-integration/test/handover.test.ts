/**
 * A swapped fiber takes the sockets over without closing them, a hot patch
 * rebinds the handler in place, and a row that is really removed closes after
 * the grace period. Mounted as the host mounts it: a Cordis plugin on a Context.
 * Run: `bun test packages/rlm-integration/test/handover.test.ts`.
 */
import { expect, test } from "bun:test";
import { Context, Service } from "@deepseek-ai/cordis";
import RlmIntegration from "../src/index.ts";

class FakeConfig extends Service {
	static provide = "rlmConfig" as const;
	constructor(ctx: any) {
		super(ctx, undefined as any);
	}
	get() {
		return {};
	}
}

const PORT = 20000 + Math.floor(Math.random() * 5000);
const url = `http://127.0.0.1:${PORT}/health`;
const cfg = { port: PORT, host: "127.0.0.1" };
const shared = () => (globalThis as any).__rlmIntegrationSockets.get(`127.0.0.1:${PORT}`);

const mounted = async (root: Context) => {
	for (let i = 0; i < 200; i++) {
		const svc = root.get("rlmIntegration") as any;
		if (svc?.status?.running) return svc;
		await Bun.sleep(10);
	}
	throw new Error("rlm-integration never came up");
};

test("swap keeps the socket open; patch rebinds; removal closes", async () => {
	const root = new Context();
	root.plugin(FakeConfig);
	const first = root.plugin(RlmIntegration as any, cfg);
	const svc1 = await mounted(root);
	const sockets = svc1.status.listening;

	let failures = 0;
	let ok = 0;
	let running = true;
	const hammer = (async () => {
		while (running) {
			try {
				const r = await fetch(url);
				if (r.status === 200) ok++;
				else failures++;
			} catch {
				failures++;
			}
			await Bun.sleep(5);
		}
	})();

	await Bun.sleep(100);
	// Swap: the old fiber goes, a successor mounts and takes the sockets over.
	first.dispose();
	const second = root.plugin(RlmIntegration as any, cfg);
	const svc2 = await mounted(root);
	expect(svc2).not.toBe(svc1);
	expect(svc2.status.listening).toEqual(sockets);
	expect(shared().servers.length).toBe(1); // one socket, taken over, never rebound
	expect(shared().owner).toBe(svc2.token);

	await Bun.sleep(100);
	// Patch: the handler is rebuilt in place; the socket stays.
	const before = shared().handler;
	svc2[Symbol.for("rlm.hmr.patched")]();
	expect(shared().handler).not.toBe(before);

	await Bun.sleep(3500); // past the first fiber's grace period: it must not close anything
	running = false;
	await hammer;
	expect(failures).toBe(0);
	expect(ok).toBeGreaterThan(50);

	// Removal: no successor, so the sockets close after the grace period.
	second.dispose();
	expect((await fetch(url)).status).toBe(200); // still open inside the grace period
	await Bun.sleep(3300);
	await expect(fetch(url)).rejects.toThrow();
}, 30000);

test("a port another process serves leaves the row mounted and idle, not failed", async () => {
	const port = 20000 + Math.floor(Math.random() * 5000);
	const other = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("other") });
	try {
		const root = new Context();
		root.plugin(FakeConfig);
		const fork = root.plugin(RlmIntegration as any, { port, host: "127.0.0.1" });
		let svc: any;
		for (let i = 0; i < 200 && !(svc = root.get("rlmIntegration")); i++) await Bun.sleep(10);
		await Bun.sleep(100);
		expect(svc).toBeDefined();
		expect(svc.status.running).toBe(false);
		expect(String((fork as any).state ?? (fork as any).fiber?.state ?? "")).not.toMatch(/FAIL/i);
		expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("other");
		fork.dispose();
	} finally {
		other.stop(true);
	}
});
