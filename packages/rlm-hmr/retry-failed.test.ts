/**
 * A row that FAILED after boot is retried when its source changes.
 *
 * The failure is produced the way it happens live: a row restarts because a
 * service it injects changed, and its init throws. Cordis leaves that fiber
 * FAILED (state 3) with no transaction to roll back. Before `retryFailedRows`
 * nothing restarted it when the code that would let it start was saved.
 *
 * Built in a scratch root with node_modules linked in, so the running rlms'
 * watchers never see these packages.
 *
 * Run: bun test packages/rlm-hmr/retry-failed.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ImportGraph } from "./src/bun-reload.ts";
import { RlmHmrService } from "./src/index.ts";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "rlm-retry-failed-"));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const flag = join(root, "flag");
const depFile = join(root, "packages", "probe-dep", "src", "index.ts");
const probeFile = join(root, "packages", "probe", "src", "index.ts");
mkdirSync(join(root, "packages", "probe-dep", "src"), { recursive: true });
mkdirSync(join(root, "packages", "probe", "src"), { recursive: true });

writeFileSync(
	depFile,
	`import { Service } from "@deepseek-ai/cordis";
export default class Dep extends Service {
  static provide = "probeDep" as const;
  constructor(ctx: any, config: any = {}) { super(ctx, "probeDep"); (this as any).v = config.v; }
}
export const name = "probe-dep";
`,
);
const probeSource = (version: string) => `import { Service } from "@deepseek-ai/cordis";
import { existsSync } from "node:fs";
export default class Probe extends Service {
  static inject = ["probeDep"] as const;
  static provide = "probe" as const;
  async [Service.init]() {
    if (!existsSync(${JSON.stringify(flag)})) throw new Error("flag missing");
    (globalThis as any).__probeVersion = "${version}";
  }
}
export const name = "probe";
`;
writeFileSync(probeFile, probeSource("v1"));
writeFileSync(join(root, "cordis.yml"), `- id: dep\n  name: ./packages/probe-dep/src/index.ts\n  config: { v: 1 }\n- id: probe\n  name: ./packages/probe/src/index.ts\n`);

const settle = () => new Promise((r) => setTimeout(r, 150));

test("a FAILED row is restarted when its source changes, and only then", async () => {
	writeFileSync(flag, "1");
	const { Context } = await import("@deepseek-ai/cordis");
	const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
	const ctx: any = new Context();
	ctx.baseUrl = pathToFileURL(root + "/").href;
	await ctx.plugin(Loader);
	await ctx.loader.resolve(
		await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-include", config: { path: "./cordis.yml", enableLogs: false } }),
	);
	await settle();
	const entryOf = (id: string) => [...ctx.loader.entries()].find((e: any) => e.options.id === id);
	expect(entryOf("probe").fiber.state).toBe(2);
	expect((globalThis as any).__probeVersion).toBe("v1");

	// Fail it the live way: the service it injects changes, it restarts, init throws.
	rmSync(flag);
	await entryOf("dep")
		.update({ config: { v: 2 } })
		.catch(() => {});
	await settle();
	expect(entryOf("probe").fiber.state).toBe(3);

	const logs: string[] = [];
	const hmr = Object.assign(Object.create(RlmHmrService.prototype), {
		ctx,
		log: (m: string) => logs.push(m),
		announce: () => {},
	});
	const graph = new ImportGraph(root);
	const cache: Record<string, unknown> = require.cache as any;

	// A change elsewhere does not touch it.
	await hmr.retryFailedRows([depFile.replace("probe-dep", "unrelated")], graph, cache);
	expect(entryOf("probe").fiber.state).toBe(3);

	// The fix lands: the flag is back and the probe's source is saved.
	writeFileSync(flag, "1");
	writeFileSync(probeFile, probeSource("v2"));
	await hmr.retryFailedRows([probeFile], graph, cache);
	await settle();
	expect(entryOf("probe").fiber.state).toBe(2);
	expect((globalThis as any).__probeVersion).toBe("v2");
	expect(logs.some((l) => l.includes("retried failed row(s) probe"))).toBe(true);
	await ctx.fiber.dispose?.();
	expect(existsSync(root)).toBe(true);
});
