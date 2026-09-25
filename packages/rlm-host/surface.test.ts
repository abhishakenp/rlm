/**
 * The Surface and the rows that attach to it (zero-restart design, Case 3).
 *
 * What is proven here, against a real cordis Context and the real rows:
 *   - per-row state survives a swap (same object handed to the next generation);
 *   - a renderer swap keeps the chat: the new generation sees the running chat,
 *     its runtime and the session subscription the old one created;
 *   - session events after the swap reach the NEW generation, not the disposed one;
 *   - disposing a renderer generation never stops the chat;
 *   - the SDK's live subagent handles survive a swap of the sdk row;
 *   - rlm-hmr no longer pins renderer/print/sdk/modes by default.
 *
 * Run: bun packages/rlm-host/surface.test.ts
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { attachRow, detachRow, rowOwner, rowState, surface } from "./src/surface.ts";

let pass = 0,
	fail = 0;
const t = (name: string, ok: boolean, extra = "") => {
	if (ok) {
		pass++;
		console.log("  ok  " + name);
	} else {
		fail++;
		console.log("  FAIL " + name + (extra ? "\n       " + extra : ""));
	}
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as any;
// A private anchor for this test, never the host's.
delete g.__rlmHost;
delete g.__rlmSurfaceAnchor;

console.log("surface primitives");
const a = rowState("x", () => ({ n: 1 }));
a.n = 7;
t("rowState hands the same object to a later caller", rowState("x", () => ({ n: 0 })).n === 7);
const o1 = {},
	o2 = {};
const g1 = attachRow("r", o1);
const g2 = attachRow("r", o2);
t("attach bumps the generation", g2 === g1 + 1);
t("latest attach owns the row", rowOwner("r") === o2);
detachRow("r", o1);
t("detaching a superseded owner is a no-op", rowOwner("r") === o2);
detachRow("r", o2);
t("detaching the current owner clears it", rowOwner("r") === undefined);
g.__rlmSurfaceAnchor.surface = { lifetime: undefined };
t("a stub surface gains the fields it lacks", Array.isArray(Object.keys(surface().rows)) && surface().interactive.running === false);

console.log("renderer swap keeps the chat");
class FakeAgent extends Service {
	static provide = "rlmAgent" as const;
	constructor(ctx: any) {
		super(ctx, undefined as any);
	}
	createRuntime = async () => ({}) as any;
}
const { default: Renderer } = await import("../rlm-tui-renderer/src/index.ts");
const root: any = new Context();
root.plugin(FakeAgent);
await sleep(50);
const fiber1 = root.plugin(Renderer, {});
await sleep(100);
const gen1 = root.get("rlmRenderer");
const owner1 = rowOwner("renderer");
// ctx.get returns cordis's per-context wrapper; the row registers its raw instance.
t("renderer generation 1 attached", owner1 !== undefined);

// Pretend generation 1 started a chat: a live InteractiveMode stand-in, a
// runtime whose session records its subscriber, running = true.
let renders = 0;
let stopped = 0;
const chat = { ui: { requestRender: () => renders++ }, stop: () => stopped++ };
let subscriber: ((e: any) => void) | undefined;
const runtime = {
	session: {
		subscribe: (fn: (e: any) => void) => {
			subscriber = fn;
			return () => (subscriber = undefined);
		},
	},
};
surface().interactive.instance = chat;
surface().interactive.runtime = runtime;
surface().interactive.running = true;
// The subscription start() creates: forwarding through the current owner.
const seen: string[] = [];
gen1.forwardEvent = (type: string) => seen.push(`gen1:${type}`);
surface().interactive.sessionEventUnsub = runtime.session.subscribe((event: any) => {
	(rowOwner<any>("renderer") ?? gen1).forwardEvent(event.type, event);
});

// The swap rlm-hmr performs: dispose the old fiber, plug the new plugin.
await fiber1.dispose();
await sleep(50);
t("disposing generation 1 did not stop the chat", stopped === 0);
t("the chat is still on the Surface", surface().interactive.instance === chat && surface().interactive.running === true);
const rendersBefore = renders;
root.plugin(Renderer, {});
await sleep(100);
const gen2 = root.get("rlmRenderer");
t("a new renderer generation is provided", gen2 && gen2 !== gen1);
t("generation 2 owns the row", rowOwner("renderer") !== undefined && rowOwner("renderer") !== owner1);
t("generation 2 sees the running chat", (gen2 as any).instance === chat && (gen2 as any).running === true);
t("generation 2 sees the runtime", (gen2 as any).runtime === runtime);
t("attaching repainted the chat once", renders === rendersBefore + 1, `renders ${rendersBefore} → ${renders}`);
gen2.forwardEvent = (type: string) => seen.push(`gen2:${type}`);
subscriber?.({ type: "message_update" });
t("session events reach the new generation", seen.at(-1) === "gen2:message_update", seen.join(","));
t("the session subscription survived the swap", typeof subscriber === "function");

console.log("a pre-Surface renderer is migrated by the handover");
// A process whose chat started before the Surface: the chat sits in own fields
// on the old instance, shadowing the accessors. The handover rlm-hmr runs
// before a swap moves it onto the Surface.
surface().interactive = { running: false };
const legacy: any = root.get("rlmRenderer");
const legacyChat = { ui: { requestRender: () => {} }, stop: () => stopped++ };
let legacySub: ((e: any) => void) | undefined;
const legacyRuntime = { session: { subscribe: (fn: any) => ((legacySub = fn), () => (legacySub = undefined)) } };
for (const [k, v] of Object.entries({ instance: legacyChat, running: true, runtime: legacyRuntime }))
	Object.defineProperty(legacy, k, { value: v, writable: true, configurable: true, enumerable: true });
t("legacy own fields shadow the accessors", Object.hasOwn(legacy, "instance") && surface().interactive.instance === undefined);
legacy[Symbol.for("rlm.hmr.handover")]();
t("handover moved the chat onto the Surface", surface().interactive.instance === legacyChat && surface().interactive.running === true);
t("handover removed the shadowing own fields", !Object.hasOwn(legacy, "instance") && !Object.hasOwn(legacy, "runtime"));
t("handover re-subscribed through the current owner", typeof legacySub === "function" && surface().interactive.surfaceForwarding === true);
legacySub?.({ type: "agent_start" });
t("events after the handover reach the current generation", seen.at(-1) === "gen2:agent_start", seen.join(","));

console.log("sdk swap keeps its subagents");
const { default: Sdk } = await import("../rlm-sdk/src/index.ts");
const sdkFiber = root.plugin(Sdk, {});
await sleep(150);
const sdk1: any = root.get("rlmSdk");
sdk1.children.set("child-1", { id: "child-1" });
sdk1.goalState = { objective: "keep going", status: "active", tokensUsed: 3 };
await sdkFiber.dispose();
root.plugin(Sdk, {});
await sleep(150);
const sdk2: any = root.get("rlmSdk");
t("a new sdk generation is provided", sdk2 && sdk2 !== sdk1);
t("its subagent handles survived", sdk2.children.get("child-1")?.id === "child-1");
t("its goal state survived", sdk2.goalState.objective === "keep going");

console.log("execve round trip of the agents view");
{
	const { captureAgentsViewState, takeAgentsViewSeed } = await import("./src/surface.ts");
	surface().interactive.view = "agents";
	surface().interactive.agentsView = {
		persistentState: {
			selectedRowIdentity: "agent:abc",
			expandedSubagentParents: new Set(["p1", "p2"]),
			query: "octo",
			showHidden: true,
			rosterClient: { not: "serialized" },
			paintSnapshot: { rows: [] },
		},
	};
	const saved = captureAgentsViewState()!;
	t("capture keeps selection, filter, hidden rows", saved.selectedRowIdentity === "agent:abc" && saved.query === "octo" && saved.showHidden === true);
	t("capture turns Sets into arrays", Array.isArray(saved.expandedSubagentParents));
	t("capture leaves clients and catalogs out", !("rosterClient" in saved) && !("paintSnapshot" in saved));
	// What the new image sees: the resume file, JSON round-tripped.
	surface().resumed = JSON.parse(JSON.stringify({ view: "agents", agentsView: saved }));
	const seed = takeAgentsViewSeed()!;
	t("the seed restores Sets", seed.expandedSubagentParents instanceof Set && (seed.expandedSubagentParents as Set<string>).has("p2"));
	t("the seed carries the selection", seed.selectedRowIdentity === "agent:abc");
	t("the seed is consumed once", takeAgentsViewSeed() === undefined);
	surface().resumed = { view: "chat", agentsView: saved };
	t("a chat relaunch gets no agents-view seed", takeAgentsViewSeed() === undefined);
}

console.log("rlm-hmr pinning");
const hmrSrc = await Bun.file(new URL("../rlm-hmr/src/index.ts", import.meta.url)).text();
t("no row is pinned by default", /const DEFAULT_PINNED: string\[\] = \[\];/.test(hmrSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
