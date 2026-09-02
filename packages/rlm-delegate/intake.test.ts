/**
 * The floor: nothing can be handed over without being written down.
 *
 * The graph in this package could not forget, but until now nothing ever
 * created one — the delegator reached the model as two prompt fragments saying
 * a graph was available, which is a protocol a model has to remember to follow,
 * which is the thing that failed in the first place. So the recording moved
 * into the boundary itself, where it costs four lines and no model call.
 *
 * These are the cases where the intelligent part is absent, wrong, or lying,
 * and the record has to exist anyway.
 */
import { Context } from "@deepseek-ai/cordis";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import RlmDelegateService from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/index.ts";
import RlmModesService from "/Users/abhi/proj/rlm/packages/rlm-modes/src/index.ts";
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";
import { run as runGraph } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/scheduler.ts";
import { CycleError, owed, render, unverified } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/graph.ts";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
	try { fn(); pass++; console.log("  ok  " + name); }
	catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v: any, m = "") => { if (!v) throw new Error(m || "expected truthy"); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-intake-"));
const REQUEST = "six jobs, please:\n1 fix the notch\n2 the dirsize command\n3 the wake word\n4 the log\n5 the tests\n6 the readme";

const boot = async (stateDir: string, print: { run: (o: any) => Promise<number> }) => {
	const root: any = new Context();
	root.provide("rlmPrint");
	root.set("rlmPrint", print);
	const delegate = root.plugin(RlmDelegateService, { dir: stateDir });
	const modes = root.plugin(RlmModesService, {});
	await wait(350);
	return { root, delegate, modes };
};

console.log("\na request is on disk before anything intelligent has looked at it");
{
	const stateDir = path.join(DIR, "clean");
	let sawGraphDuringRun: string[] = [];
	const { root } = await boot(stateDir, {
		// The model's turn happens here. By this point the request must already
		// be recorded — that is the whole property.
		run: async () => {
			sawGraphDuringRun = new Store(stateDir).ids();
			return 0;
		},
	});

	const code = await root.rlmModes.dispatch(["--print", REQUEST]);
	const store = new Store(stateDir);
	const graph = store.load(store.ids()[0])!;

	t("the run still returns its exit code", () => eq(code, 0));
	t("the request was written down BEFORE the model ran", () => eq(sawGraphDuringRun.length, 1));
	t("exactly one task, recorded in code with no plan and no decomposition", () => eq(graph.tasks.length, 1));
	t("the request is kept verbatim, all six jobs of it", () => {
		eq(graph.goal, REQUEST);
		ok(graph.tasks[0].prompt.includes("6 the readme"), "the sixth job is not in the record");
	});
	t("its title is the asker's own first line", () => eq(graph.tasks[0].title, "six jobs, please:"));
	t("having come back, it is unproven — not done, and not a claim", () => eq(graph.tasks[0].state, "unproven"));
	t("and it says why nobody can tell", () =>
		ok(graph.tasks[0].reason!.includes("nobody had said how to tell"), graph.tasks[0].reason));
	t("the account marks it UNPROVEN rather than counting it as finished", () =>
		ok(render(graph).includes("UNPROVEN"), render(graph)));
}

console.log("\nthe record survives the model being unavailable, confused, or lying");
{
	const stateDir = path.join(DIR, "broken");
	const { root } = await boot(stateDir, {
		run: async () => { throw new Error("brain unavailable / exited 1"); },
	});

	let threw: any;
	try { await root.rlmModes.dispatch(["--print", REQUEST]); } catch (e) { threw = e; }
	const store = new Store(stateDir);
	const graph = store.load(store.ids()[0])!;

	t("the failure still reaches the caller", () => ok(threw, "the error was swallowed"));
	t("the request is on disk anyway", () => {
		eq(store.ids().length, 1);
		ok(graph.tasks[0].prompt.includes("6 the readme"));
	});
	t("recorded as failed, with what actually went wrong", () => {
		eq(graph.tasks[0].state, "failed");
		ok(graph.tasks[0].reason!.includes("brain unavailable"), graph.tasks[0].reason);
	});
	t("a wound the next process can find without anyone having noticed it", () =>
		eq(store.open().length, 1));
}
{
	const stateDir = path.join(DIR, "nonzero");
	const { root } = await boot(stateDir, { run: async () => 1 });
	await root.rlmModes.dispatch(["--print", "do the thing"]);
	const graph = new Store(stateDir).load(new Store(stateDir).ids()[0])!;
	t("a non-zero exit is a failure, not a finished job", () => eq(graph.tasks[0].state, "failed"));
}

console.log("\nthe intelligent part is an improvement on the floor, never the floor");
{
	const stateDir = path.join(DIR, "refine");
	const { root } = await boot(stateDir, { run: async () => 0 });
	const graphs = root.rlmDelegate;

	// The model reads the recorded request and turns it into real work. This is
	// allowed to fail; the record above is not.
	const recorded = graphs.intake(REQUEST, { source: "test" })!;
	const refined = graphs.refine(recorded.graph.id, "the-request", [
		{ id: "notch", title: "fix the notch", proof: { kind: "shell", run: "exit 0" } },
		{ id: "dirsize", title: "the dirsize command", proof: { kind: "shell", run: "exit 0" } },
		{ id: "readme", title: "the readme", needs: ["dirsize"], proof: { kind: "shell", run: "exit 0" } },
	]);

	t("the recorded request became four tasks", () => eq(refined.tasks.length, 4));
	t("the parent is now the sum of its children", () => {
		const parent = refined.tasks.find((x: any) => x.id === "the-request")!;
		eq(parent.proof.kind, "rollup");
		eq(parent.needs.join(","), "notch,dirsize,readme");
	});
	t("and it is no longer unproven, because there is now something to prove", () =>
		eq(refined.tasks.find((x: any) => x.id === "the-request")!.state, "blocked"));

	const spawned: string[] = [];
	const done = await runGraph(new Store(stateDir), recorded.graph.id, async (task) => { spawned.push(task.id); return "ok"; }, { concurrency: 2 });

	t("everything finished", () => eq(done.tasks.filter((x: any) => x.state === "done").length, 4));
	t("the rollup cost nobody a model call", () => ok(!spawned.includes("the-request"), spawned.join(",")));
	t("and the graph owes nothing now", () => eq(owed(done.tasks).length, 0));

	t("a refinement that would close a loop is refused, before writing", () => {
		const second = graphs.intake("another one", { source: "test" })!;
		let threw: any;
		try {
			graphs.refine(second.graph.id, "the-request", [
				{ id: "a", title: "a", needs: ["the-request"], proof: { kind: "shell", run: "exit 0" } },
			]);
		} catch (e) { threw = e; }
		ok(threw instanceof CycleError, `expected a CycleError, got ${threw}`);
		eq(new Store(stateDir).load(second.graph.id)!.tasks.length, 1);
	});
}

console.log("\nwounds are visible; receipts do not drown them");
{
	const stateDir = path.join(DIR, "wounds");
	const { root } = await boot(stateDir, { run: async () => 0 });
	const graphs = root.rlmDelegate;

	await root.rlmModes.dispatch(["--print", "a turn nobody could check"]);
	const store = new Store(stateDir);

	t("an unproven turn is not listed as live work", () => eq(store.open().length, 0));
	t("but it is listed as unverified", () => {
		const wounds = store.unverified();
		eq(wounds.length, 1);
		eq(wounds[0].task.title, "a turn nobody could check");
	});
	t("and the prompt says so, in its own quieter section", () => {
		const fragment = graphs.owedFragment();
		ok(fragment.includes("no way to check"), fragment);
		ok(fragment.includes("a turn nobody could check"), fragment);
	});
	t("the prompt also says how to stop it happening", () =>
		ok(graphs.owedFragment().includes("refine(graphId, taskId, tasks)"), "refine is not taught"));

	graphs.declare("a real wound", [{ id: "hurt", title: "the thing that failed", proof: { kind: "shell", run: "exit 1" } }]);
	await runGraph(store, store.ids().find((id) => store.load(id)!.goal === "a real wound")!, async () => "ok", { maxAttempts: 1, concurrency: 1 });

	t("a failure IS live work — somebody has to look at it", () => eq(store.open().length, 1));
	t("pruning forgets the receipt", () => {
		const gone = store.prune(0);
		eq(gone.length, 1);
	});
	t("and keeps the wound, whatever its age", () => {
		eq(store.ids().length, 1);
		eq(store.load(store.ids()[0])!.goal, "a real wound");
	});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
