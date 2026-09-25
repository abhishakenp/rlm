/**
 * The bun reload path, against real files evaluated by bun.
 *
 * Run: bun test packages/rlm-hmr/bun-reload.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ImportGraph, ancestors, closureOf, patchClass, patchNamespace } from "./src/bun-reload.ts";
import { RlmHmrService } from "./src/index.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "rlm-hmr-bun-")));
const SRC = join(ROOT, "packages", "demo", "src");
mkdirSync(SRC, { recursive: true });
const file = (name: string, body: string) => {
	const p = join(SRC, name);
	writeFileSync(p, body);
	return p;
};
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A service-shaped object with just what bunReload touches. No loader rows. */
const fakeService = () => {
	const logs: string[] = [];
	const events: any[] = [];
	const self: any = Object.create(RlmHmrService.prototype);
	Object.assign(self, {
		root: ROOT,
		config: {},
		reloadCount: 0,
		lastReloaded: [],
		ctx: {
			loader: { entries: () => [], unwrapExports: (x: any) => x?.default ?? x },
			registry: { values: () => [] },
			emit: (name: string, payload: unknown) => events.push({ name, payload }),
		},
		log: (msg: string) => logs.push(String(msg)),
	});
	return { self, logs, events };
};

describe("ImportGraph", () => {
	test("resolves ./x.js to x.ts, drops type-only imports and packages", () => {
		const a = file("g-a.ts", "export const a = 1;");
		file("g-t.ts", "export type T = 1;");
		const b = file(
			"g-b.ts",
			'import { a } from "./g-a.js";\nimport type { T } from "./g-t.ts";\nimport { join } from "node:path";\nexport const b = a + 1;',
		);
		expect(new ImportGraph(ROOT).depsOf(b)).toEqual([a]);
	});

	test("importers and ancestors walk upward, closure walks downward", () => {
		const leaf = file("w-leaf.ts", "export const x = 1;");
		const mid = file("w-mid.ts", 'import { x } from "./w-leaf.ts"; export const y = x;');
		const top = file("w-top.ts", 'import { y } from "./w-mid.ts"; export const z = y;');
		const other = file("w-other.ts", "export const q = 1;");
		const graph = new ImportGraph(ROOT);
		const loaded = new Set([leaf, mid, top, other]);
		const reverse = graph.importersOver(loaded);
		expect([...ancestors([leaf], reverse)].sort()).toEqual([leaf, mid, top].sort());
		expect([...closureOf(top, graph, loaded)].sort()).toEqual([leaf, mid, top].sort());
		expect(ancestors([other], reverse).size).toBe(1);
	});

	test("check reports a parse error without evaluating", () => {
		const bad = file("c-bad.ts", "export class X { hi( { }");
		const good = file("c-good.ts", "export const ok = 1;");
		const graph = new ImportGraph(ROOT);
		expect(graph.check(bad)).toContain("Expected");
		expect(graph.check(good)).toBeNull();
	});
});

describe("patchClass", () => {
	test("live instances run new methods and getters; static state survives", () => {
		class Live {
			static count = 5;
			static make() {
				return "old";
			}
			n = 1;
			hi() {
				return `old:${this.n}`;
			}
			get label() {
				return "old";
			}
		}
		class Next {
			static count = 0;
			static make() {
				return "new";
			}
			n = 99;
			hi() {
				return `new:${this.n}`;
			}
			get label() {
				return "new";
			}
			added() {
				return "added";
			}
		}
		const inst = new Live();
		expect(patchClass(Live, Next)).toBeGreaterThan(0);
		expect(inst.hi()).toBe("new:1"); // new code, old instance state
		expect(inst.label).toBe("new");
		expect((inst as any).added()).toBe("added");
		expect(Live.make()).toBe("new");
		expect(Live.count).toBe(5); // static data is state, never overwritten
	});

	test("patchNamespace only touches classes present in both", () => {
		class A {
			f() {
				return 1;
			}
		}
		class A2 {
			f() {
				return 2;
			}
		}
		const fn = () => 1;
		expect(patchNamespace({ A, fn }, { A: A2, fn: () => 2, B: class {} })).toEqual(["A"]);
		expect(new A().f()).toBe(2);
	});
});

describe("bunReload", () => {
	test("a changed class module patches the live instance, keeping shared singletons", async () => {
		const state = file("r-state.ts", "export let hits = 0; export const bump = () => ++hits;");
		const box = file("r-box.ts", 'import { bump } from "./r-state.ts";\nexport class Box { hi() { return "v1:" + bump(); } }');
		const { Box } = await import(box);
		const live = new Box();
		expect(live.hi()).toBe("v1:1");

		file("r-box.ts", 'import { bump } from "./r-state.ts";\nexport class Box { hi() { return "v2:" + bump(); } }');
		const { self, logs, events } = fakeService();
		await self.bunReload([pathToFileURL(box).href]);

		expect(live.hi()).toBe("v2:2"); // same instance, new method, same counter
		expect(logs.at(-1)).toContain("r-box.ts changed, 1 evaluated again | patched");
		expect(events.map((e) => e.name)).toEqual(["rlm/hmr-patched"]); // no swap → no session resource reload
		expect((await import(state)).hits).toBe(2); // singleton was not evaluated again
	});

	test("a changed function module reaches the classes that call it", async () => {
		const help = file("f-help.ts", 'export const word = () => "old";');
		const user = file("f-user.ts", 'import { word } from "./f-help.ts";\nexport class User { say() { return word(); } }');
		const { User } = await import(user);
		const live = new User();
		expect(live.say()).toBe("old");

		file("f-help.ts", 'export const word = () => "new";');
		const { self } = fakeService();
		await self.bunReload([pathToFileURL(help).href]);
		expect(live.say()).toBe("new");
	});

	test("a file that does not parse changes nothing, and the next good save lands", async () => {
		const mod = file("s-mod.ts", 'export class M { v() { return "good"; } }');
		const { M } = await import(mod);
		const live = new M();

		file("s-mod.ts", "export class M { v( { }");
		const first = fakeService();
		await first.self.bunReload([pathToFileURL(mod).href]);
		expect(first.logs.at(-1)).toContain("does not parse — nothing reloaded");
		expect(live.v()).toBe("good");
		expect(first.events).toEqual([]);

		file("s-mod.ts", 'export class M { v() { return "fixed"; } }');
		const second = fakeService();
		await second.self.bunReload([pathToFileURL(mod).href]);
		expect(live.v()).toBe("fixed");
	});

	test("a file this process never loaded is left for the next import", async () => {
		const cold = file("n-cold.ts", "export const c = 1;");
		const { self, logs } = fakeService();
		await self.bunReload([pathToFileURL(cold).href]);
		expect(logs.at(-1)).toContain("not loaded in this process");
	});
});

test("a root with a trailing separator still tracks its files (composition baseUrl form)", () => {
	const p = file("t-root.ts", "export const r = 1;");
	expect(new ImportGraph(ROOT + "/").tracks(p)).toBe(true);
});

test("the second and third edits still reach an instance created before the first", async () => {
	const mod = file("m-gen.ts", 'export class G { v() { return "v1"; } }');
	const { G } = await import(mod);
	const original = new G();
	const { self } = fakeService();
	file("m-gen.ts", 'export class G { v() { return "v2"; } }');
	await self.bunReload([pathToFileURL(mod).href]);
	expect(original.v()).toBe("v2");
	const midGen = new (await import(mod)).G(); // created from the reloaded module
	file("m-gen.ts", 'export class G { v() { return "v3"; } }');
	await self.bunReload([pathToFileURL(mod).href]);
	expect(original.v()).toBe("v3");
	expect(midGen.v()).toBe("v3");
	file("m-gen.ts", 'export class G { v() { return "v4"; } }');
	await self.bunReload([pathToFileURL(mod).href]);
	expect(original.v()).toBe("v4");
	expect(midGen.v()).toBe("v4");
});

describe("dependentFibers (real cordis)", () => {
	test("finds injectors of a provider, through the thenable wrapper and down the chain", async () => {
		const { Context, Service } = await import("@deepseek-ai/cordis");
		const { dependentFibers, rawFiber } = await import("./src/bun-reload.ts");
		class Agent extends Service {
			static inject = [] as const;
			constructor(ctx: any) {
				super(ctx, "probeAgent");
			}
		}
		class Renderer extends Service {
			static inject = ["probeAgent"] as const;
			constructor(ctx: any) {
				super(ctx, "probeRenderer");
			}
		}
		const seenByLeaf: string[] = [];
		const Leaf = { name: "leaf", inject: ["probeRenderer"], apply: () => void seenByLeaf.push("up") };
		const Loner = { name: "loner", inject: [], apply: () => {} };
		const ctx: any = new Context();
		const agent = ctx.plugin(Agent);
		const renderer = ctx.plugin(Renderer);
		const leaf = ctx.plugin(Leaf);
		const loner = ctx.plugin(Loner);
		await agent;
		await renderer;
		await leaf;
		await loner;
		expect(Object.hasOwn(agent, "then")).toBe(true); // what entry.fiber holds

		const reach = dependentFibers(ctx.registry, agent);
		expect(reach.has(rawFiber(renderer))).toBe(true);
		expect(reach.has(rawFiber(leaf))).toBe(true); // renderer restarts → leaf restarts
		expect(reach.has(rawFiber(loner))).toBe(false);
		expect(dependentFibers(ctx.registry, loner).size).toBe(0);
	});
});

test("a reload pass that throws still patches, so a broken reloader can load its own fix", async () => {
	const mod = file("x-heal.ts", 'export class H { v() { return "broken"; } }');
	const { H } = await import(mod);
	const live = new H();
	file("x-heal.ts", 'export class H { v() { return "healed"; } }');
	const { self, logs } = fakeService();
	self.bunReload = async () => {
		throw new ReferenceError("dependentFibers is not defined");
	};
	await self.partialReload([pathToFileURL(mod).href]);
	expect(live.v()).toBe("healed");
	expect(logs.join("\n")).toContain("falling back to patch-only");
});

test("an instance built before a field existed keeps its old method; new instances get the new one", async () => {
	const mod = file("q-field.ts", 'export class Conn { constructor() {} dispose() { return "old-dispose"; } }');
	const { Conn } = await import(mod);
	const before = new Conn();
	file(
		"q-field.ts",
		'export class Conn { opts = { runtime: "r" }; dispose() { return "new-dispose:" + this.opts.runtime; } }',
	);
	const { self } = fakeService();
	await self.bunReload([pathToFileURL(mod).href]);
	expect(before.dispose()).toBe("old-dispose"); // would throw reading this.opts.runtime
	const after = new (await import(mod)).Conn();
	expect(after.dispose()).toBe("new-dispose:r");
	(before as any).opts = { runtime: "late" }; // once the instance has the field, the new code runs
	expect(before.dispose()).toBe("new-dispose:late");
});

test("a row whose swap would restart a pinned row is held back, whatever tree prefixes its id", async () => {
	const mod = file("p-agent.ts", 'export default class AgentRow { v() { return "a1"; } }');
	const Row = (await import(mod)).default;
	const live = new Row();
	file("p-agent.ts", 'export default class AgentRow { v() { return "a2"; } }');
	const { self, logs, events } = fakeService();
	// Nothing is pinned by default since the Surface (zero-restart Case 3);
	// `config.pinned` is the escape hatch this test exercises.
	self.config = { pinned: ["renderer", "print"] };
	self.rowEntries = () => [{ id: "95168bf2:agent", path: mod, fiber: {} }];
	self.restartReach = () => new Set(["95168bf2:renderer", "95168bf2:print"]);
	await self.bunReload([pathToFileURL(mod).href]);
	expect(logs.at(-1)).toContain("held back 95168bf2:agent (would restart renderer, print)");
	expect(logs.at(-1)).not.toContain("swapped");
	expect(live.v()).toBe("a2"); // held back rows are still patched
	expect(events.map((e) => e.name)).toEqual(["rlm/hmr-patched"]);
});

test("by default nothing is pinned: a row that would restart renderer/print is not held back", async () => {
	const mod = file("p-agent2.ts", 'export default class AgentRow2 { v() { return "b1"; } }');
	await import(mod);
	file("p-agent2.ts", 'export default class AgentRow2 { v() { return "b2"; } }');
	const { self, logs } = fakeService();
	self.rowEntries = () => [{ id: "95168bf2:agent", path: mod, fiber: {} }];
	self.restartReach = () => new Set(["95168bf2:renderer", "95168bf2:print", "95168bf2:modes", "95168bf2:sdk"]);
	await self.bunReload([pathToFileURL(mod).href]);
	expect(logs.at(-1)).not.toContain("held back");
});
