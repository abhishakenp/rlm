/**
 * The delegator earns trust by being unable to forget.
 *
 * Every section below is one of the failures from the night this package was
 * written, turned into something that fails loudly instead of quietly.
 */
import { Context } from "@deepseek-ai/cordis";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import RlmDelegateService from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/index.ts";
import { CycleError, DeclarationError, render, settle } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/graph.ts";
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";
import { run as runGraph } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/scheduler.ts";
import { capacity } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/capacity.ts";
import { judge } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/lapse.ts";
import { forgeable, forgeryIn, gripOn, segments } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/forgeable.ts";
import { refineOne, reopenForged } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/refine.ts";
import { confineTo, plannerScope, profileFor } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/confine.ts";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
	try { fn(); pass++; console.log("  ok  " + name); }
	catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v: any, m = "") => { if (!v) throw new Error(m || "expected truthy"); };
const settleMs = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-delegate-"));
const passes = { kind: "shell", run: "exit 0" } as const;
const fails = { kind: "shell", run: "exit 1" } as const;

console.log("\na task cannot be declared without a way to tell it is finished");
{
	const store = new Store(path.join(DIR, "criterion"));
	t("a task with no criterion is refused, like a cycle is", () => {
		let threw: any;
		try { store.create("build it", [{ id: "a", title: "A" } as any]); } catch (e) { threw = e; }
		ok(threw instanceof DeclarationError, "expected a DeclarationError");
		ok(String(threw.message).includes("no criterion"), threw?.message);
	});
	t("and nothing was written, so it cannot be half-declared", () => eq(store.ids().length, 0));
	t("an unknown criterion kind is refused too", () => {
		let threw: any;
		try { store.create("x", [{ id: "a", title: "A", proof: { kind: "vibes" } as any }]); } catch (e) { threw = e; }
		ok(threw instanceof DeclarationError, "expected a DeclarationError");
	});
}

console.log("\na declared cycle is refused at declaration, not discovered at run time");
{
	const store = new Store(path.join(DIR, "cycle"));
	t("a -> b -> a is refused, and says which path", () => {
		let threw: any;
		try {
			store.create("circular", [
				{ id: "a", title: "A", needs: ["b"], proof: passes },
				{ id: "b", title: "B", needs: ["a"], proof: passes },
			]);
		} catch (e) { threw = e; }
		ok(threw instanceof CycleError, "expected a CycleError");
		eq(threw.cycle.join(" -> "), "a -> b -> a");
	});
	t("a longer cycle is caught too", () => {
		let threw: any;
		try {
			store.create("circular", [
				{ id: "a", title: "A", needs: ["c"], proof: passes },
				{ id: "b", title: "B", needs: ["a"], proof: passes },
				{ id: "c", title: "C", needs: ["b"], proof: passes },
			]);
		} catch (e) { threw = e; }
		ok(threw instanceof CycleError, "expected a CycleError");
	});
	t("an edge closed against an existing graph is refused as well", () => {
		const g = store.create("later", [{ id: "a", title: "A", proof: passes }]);
		store.add(g.id, [{ id: "b", title: "B", needs: ["a"], proof: passes }]);
		let threw: any;
		try { store.add(g.id, [{ id: "c", title: "C", needs: ["b"], proof: passes }, { id: "d", title: "D", needs: ["c"], proof: passes }]); } catch (e) { threw = e; }
		eq(threw, undefined, "that one is acyclic");
		// now close the loop
		try { store.add(g.id, [{ id: "e", title: "E", needs: ["d"], proof: passes }]); } catch (e) { threw = e; }
		eq(threw, undefined);
	});
	t("a dependency on something never declared is refused", () => {
		let threw: any;
		try { store.create("dangling", [{ id: "a", title: "A", needs: ["ghost"], proof: passes }]); } catch (e) { threw = e; }
		ok(threw instanceof DeclarationError, "expected a DeclarationError");
	});
	t("nothing malformed reached disk", () => eq(store.ids().length, 1));
}

console.log("\nthe tenth task is reported unreachable, not lost");
{
	const store = new Store(path.join(DIR, "unreachable"));
	const nine = Array.from({ length: 9 }, (_, i) => ({
		id: `t${i + 1}`,
		title: `job ${i + 1}`,
		proof: i === 8 ? fails : passes, // the ninth cannot pass its criterion
	}));
	const graph = store.create("ten jobs, the last one needs all the others", [
		...nine,
		{ id: "t10", title: "the one that depends on the other nine", needs: nine.map((n) => n.id), proof: passes },
	]);

	const final = await runGraph(store, graph.id, async () => "done, boss", { concurrency: 4, maxAttempts: 1 });
	const by = (id: string) => final.tasks.find((x) => x.id === id)!;

	t("the eight that could finish, finished", () => eq(final.tasks.filter((x) => x.state === "done").length, 8));
	t("the ninth is failed, with a reason", () => {
		eq(by("t9").state, "failed");
		ok(by("t9").reason && by("t9").reason!.length > 0, "no reason recorded");
	});
	t("the ninth's failure says the criterion is what did not hold", () =>
		ok(by("t9").reason!.includes("criterion did not hold"), by("t9").reason));
	t("the tenth is unreachable — not done, not failed, not gone", () => eq(by("t10").state, "unreachable"));
	t("and it names what will never arrive", () => {
		eq(by("t10").blockedBy?.join(","), "t9");
		ok(by("t10").reason!.includes("t9"), by("t10").reason);
	});
	t("the tenth is still in the graph after a fresh read", () => {
		const reread = store.load(graph.id)!;
		eq(reread.tasks.find((x) => x.id === "t10")!.state, "unreachable");
		eq(reread.tasks.length, 10);
	});
	t("the account says what is still owed", () => {
		const text = render(store.load(graph.id)!);
		ok(text.includes("8/10 done, 2 still owed"), text.split("\n").pop());
	});
	t("the tenth becomes runnable again if the ninth is fixed", () => {
		store.ended(graph.id, "t9", "done", { at: "now", ok: true, detail: "fixed", proof: "passed" }, { result: "fixed" });
		eq(store.load(graph.id)!.tasks.find((x) => x.id === "t10")!.state, "ready");
	});
}

console.log("\ncoming back is not finishing");
{
	const store = new Store(path.join(DIR, "claimed"));
	// The iris-dirsize shape: a scaffold mounted, announced as a capability,
	// while the command it was supposed to add is not in the registry.
	const graph = store.create("build dirsize", [
		{ id: "dirsize", title: "give iris a dirsize command", proof: { kind: "command", name: "dirsize.of" } },
	]);
	const final = await runGraph(store, graph.id, async () => "Done. iris-dirsize is built and mounted.", {
		concurrency: 1,
		maxAttempts: 1,
		probe: { commands: () => ["dirsize.hello"] }, // the template's greeting, and nothing else
	});
	const task = final.tasks[0];
	t("a confident report does not make it done", () => eq(task.state, "failed"));
	t("the reason is the registry, not the prose", () => ok(task.reason!.includes("dirsize.of is not registered"), task.reason));
	t("what the agent actually said is still recorded", () =>
		ok(task.attempts[0].detail.includes("criterion did not hold"), task.attempts[0].detail));
	t("a criterion nobody can check is errored, never passed", async () => {});
}
{
	const store = new Store(path.join(DIR, "unverifiable"));
	const graph = store.create("mount a row", [
		{ id: "m", title: "mount the row", proof: { kind: "row", id: "nothing" } },
	]);
	const final = await runGraph(store, graph.id, async () => "mounted!", { concurrency: 1, maxAttempts: 1 });
	t("with no way to look, the task fails rather than passing", () => eq(final.tasks[0].state, "failed"));
	t("and says it could not look", () => ok(final.tasks[0].reason!.includes("unchecked"), final.tasks[0].reason));
}

console.log("\ntwo independent tasks run at once");
{
	const store = new Store(path.join(DIR, "parallel"));
	const graph = store.create("two unrelated jobs", [
		{ id: "left", title: "left", proof: passes },
		{ id: "right", title: "right", proof: passes },
	]);
	const spans: Array<{ id: string; from: number; to: number }> = [];
	const final = await runGraph(
		store,
		graph.id,
		async (task) => {
			const from = Date.now();
			await settleMs(300);
			spans.push({ id: task.id, from, to: Date.now() });
			return "ok";
		},
		{ concurrency: 2 },
	);
	t("both finished", () => eq(final.tasks.filter((x) => x.state === "done").length, 2));
	t("their runs overlapped in wall-clock time", () => {
		const [a, b] = spans;
		ok(a && b, "expected two spans");
		ok(a.from < b.to && b.from < a.to, `no overlap: ${JSON.stringify(spans)}`);
	});
	t("the journal records the overlap too, so it survives the process", () => {
		const reread = store.load(graph.id)!;
		const [a, b] = reread.tasks.map((x) => x.attempts[0]);
		ok(a.at < b.endedAt! && b.at < a.endedAt!, `journalled attempts do not overlap: ${JSON.stringify([a, b])}`);
	});
}

console.log("\na dependency serialises, and only a dependency");
{
	const store = new Store(path.join(DIR, "serial"));
	const graph = store.create("b after a", [
		{ id: "a", title: "a", proof: passes },
		{ id: "b", title: "b", needs: ["a"], proof: passes },
	]);
	const order: string[] = [];
	await runGraph(store, graph.id, async (task) => { order.push(`${task.id}:start`); await settleMs(120); order.push(`${task.id}:end`); return "ok"; }, { concurrency: 4 });
	t("b did not start until a had finished", () => eq(order.join(" "), "a:start a:end b:start b:end"));
}

console.log("\noverflow waits, it is never refused");
{
	const store = new Store(path.join(DIR, "queue"));
	const ids = ["one", "two", "three", "four", "five", "six"];
	const graph = store.create("six jobs in one request", ids.map((id) => ({ id, title: `job ${id}`, proof: passes })));
	let peak = 0, live = 0;
	const final = await runGraph(store, graph.id, async () => {
		live++; peak = Math.max(peak, live);
		await settleMs(60);
		live--;
		return "ok";
	}, { concurrency: 1 });
	t("only one ran at a time, as asked", () => eq(peak, 1));
	t("and all six were done — none refused at the door", () => eq(final.tasks.filter((x) => x.state === "done").length, 6));
	t("the limit can be re-asked between tasks", async () => {});
}
{
	const store = new Store(path.join(DIR, "queue2"));
	const graph = store.create("four jobs", ["a", "b", "c", "d"].map((id) => ({ id, title: id, proof: passes })));
	let asked = 0;
	await runGraph(store, graph.id, async () => { await settleMs(40); return "ok"; }, { concurrency: () => { asked++; return 2; } });
	t("the machine was asked more than once", () => ok(asked > 1, `asked ${asked} times`));
}

console.log("\nthe limit is measured, and zero is one of its answers");
{
	t("this machine reports a measured limit, with its reasoning", () => {
		const verdict = capacity();
		ok(verdict.limit >= 0, `limit was ${verdict.limit}`);
		ok(verdict.why.length > 0, "no reasoning given");
		ok(verdict.readings.some((r) => r.name === "file descriptors"), "descriptors were not read");
	});
	// His rule, 2026-09-03: spin while 30% or more is free, otherwise start
	// nothing. One-at-a-time on a machine with nothing spare is still work it
	// cannot afford, and the hardcoded 1 read as a real limit for a whole day
	// while the CPU signal underneath it was broken.
	t("a machine with no headroom starts nothing", () => eq(capacity({ floor: 1.1 }).limit, 0));
	t("an idle machine is allowed the ceiling and no more", () => {
		const verdict = capacity({ ceiling: 3, floor: 0 });
		ok(verdict.limit >= 1 && verdict.limit <= 3, `limit was ${verdict.limit}`);
	});
}

console.log("\nthe same failure twice is not handed back a third time");
{
	t("a repeated shape stops the retries", () => {
		const previous = [
			{ ok: false, shape: "command failed node exited" },
			{ ok: false, shape: "command failed node exited" },
		];
		const verdict = judge(previous, "Command failed: node other.js exited 7", { maxAttempts: 9 });
		eq(verdict.retry, false);
		ok(verdict.why.includes("same way"), verdict.why);
	});
	t("a genuinely different failure is still worth one more go", () => {
		const previous = [{ ok: false, shape: "command failed node exited" }];
		eq(judge(previous, "TypeError: cannot read properties of undefined").retry, true);
	});
	t("and the retry carries the failure into the task text", async () => {});
}
{
	const store = new Store(path.join(DIR, "retry"));
	const graph = store.create("a task that always breaks the same way", [
		{ id: "x", title: "x", proof: passes },
	]);
	const seen: string[] = [];
	const final = await runGraph(store, graph.id, async (task) => {
		seen.push(task.prompt);
		throw new Error("Command failed: /bin/sh -c build.sh exited 2");
	}, { concurrency: 1 });
	t("it was tried twice, not six times", () => eq(seen.length, 2));
	t("the second attempt was not the same prompt", () => ok(seen[1] !== seen[0], "the prompt was unchanged"));
	t("the second prompt carries how the first failed", () => ok(seen[1].includes("Command failed"), seen[1]));
	t("it ends failed with the reason on the task", () => {
		eq(final.tasks[0].state, "failed");
		ok(final.tasks[0].reason!.includes("same way"), final.tasks[0].reason);
	});
}

console.log("\na reviewer can dispute a criterion that passed");
{
	const store = new Store(path.join(DIR, "review"));
	const graph = store.create("review me", [
		{ id: "a", title: "a", proof: passes },
		{ id: "b", title: "b", needs: ["a"], proof: passes },
		{ id: "c", title: "c", needs: ["a"], proof: passes },
	]);
	await runGraph(store, graph.id, async (task) => (task.id === "a" ? "ok" : "ok"), { concurrency: 1 });
	t("everything passed its criterion first", () => eq(store.load(graph.id)!.tasks.every((x) => x.state === "done"), true));

	store.reviewed(graph.id, "a", { by: "me-2", at: new Date().toISOString(), verdict: "rejected", reason: "the criterion was `exit 0`, which proves nothing" });
	const after = store.load(graph.id)!;
	t("the rejected task is rejected, with the reviewer's reason", () => {
		eq(after.tasks.find((x) => x.id === "a")!.state, "rejected");
		ok(after.tasks.find((x) => x.id === "a")!.reason!.includes("me-2"), after.tasks.find((x) => x.id === "a")!.reason);
	});
	t("finished work standing on it is tainted rather than left claiming to be sound", () => {
		ok(after.tasks.find((x) => x.id === "b")!.tainted, "b was not tainted");
		ok(after.tasks.find((x) => x.id === "c")!.tainted, "c was not tainted");
	});
	t("overturning the rejection puts it back", () => {
		store.reviewed(graph.id, "a", { by: "me-2", at: new Date().toISOString(), verdict: "accepted", reason: "looked again" });
		const back = store.load(graph.id)!;
		eq(back.tasks.find((x) => x.id === "a")!.state, "done");
		eq(back.tasks.find((x) => x.id === "b")!.tainted, undefined);
	});
	t("a dependent that had not started becomes unreachable on a rejection", () => {
		const g2 = store.create("not started yet", [
			{ id: "p", title: "p", proof: passes },
			{ id: "q", title: "q", needs: ["p"], proof: passes },
		]);
		store.ended(g2.id, "p", "done", { at: "now", ok: true, detail: "ok", proof: "passed" }, { result: "ok" });
		store.reviewed(g2.id, "p", { by: "me-2", at: new Date().toISOString(), verdict: "rejected", reason: "no" });
		eq(store.load(g2.id)!.tasks.find((x) => x.id === "q")!.state, "unreachable");
	});
}

console.log("\nwork survives the process that was doing it");
{
	const graphDir = path.join(DIR, "crash");
	const script = path.join(DIR, "crash-child.mjs");
	fs.writeFileSync(script, `
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";
import { run } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/scheduler.ts";
const store = new Store(${JSON.stringify(graphDir)});
const graph = store.create("five jobs handed over at once", [
  { id: "j1", title: "job one", proof: { kind: "shell", run: "exit 0" } },
  { id: "j2", title: "job two", proof: { kind: "shell", run: "exit 0" } },
  { id: "j3", title: "job three", proof: { kind: "shell", run: "exit 0" } },
  { id: "j4", title: "job four", proof: { kind: "shell", run: "exit 0" } },
  { id: "j5", title: "job five", needs: ["j4"], proof: { kind: "shell", run: "exit 0" } },
]);
console.log(graph.id);
let done = 0;
await run(store, graph.id, async () => {
  if (++done === 2) { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); }
  return "ok";
}, { concurrency: 1 });
`);
	const child = spawnSync(process.execPath, ["--experimental-strip-types", script], { encoding: "utf8" });
	const graphId = (child.stdout || "").trim().split("\n")[0];

	t("the child really was killed, not returned", () => eq(child.signal, "SIGKILL"));
	t("it had written the graph down before it died", () => ok(graphId?.startsWith("g-"), `stdout was ${JSON.stringify(child.stdout)}`));

	const store = new Store(graphDir);
	const recovered = store.load(graphId)!;
	t("all five jobs are still there after the crash", () => eq(recovered.tasks.length, 5));
	t("what it managed to finish is recorded as finished", () => eq(recovered.tasks.filter((x) => x.state === "done").length, 1));
	t("the rest is still owed", () => eq(recovered.tasks.filter((x) => x.state !== "done").length, 4));
	t("the task it died holding is runnable again, not stuck running", () => {
		ok(recovered.tasks.every((x) => x.state !== "running"), "something is still marked running");
		ok(recovered.tasks.some((x) => x.reason?.includes("died before it came back")), "no note of the interrupted attempt");
	});
	t("a torn last line does not take the graph with it", () => {
		fs.appendFileSync(path.join(graphDir, `${graphId}.jsonl`), '{"k":"ended","at":"2026');
		eq(store.load(graphId)!.tasks.length, 5);
	});

	const finished = await runGraph(store, graphId, async () => "ok", { concurrency: 2 });
	t("a second process picks the remaining work up and finishes it", () => eq(finished.tasks.filter((x) => x.state === "done").length, 5));
	t("and then nothing is outstanding", () => eq(store.open().length, 0));
}

console.log("\nit is a plugin, and it says what is owed");
{
	const stateDir = path.join(DIR, "service");
	const skeleton = path.join(DIR, "delegator-skeleton.ts");
	fs.writeFileSync(skeleton, "export default (api) => ({ name: 'delegator', async run(input) { return input } })\n");

	const root: any = new Context();
	const fork = root.plugin(RlmDelegateService, { dir: stateDir, skeletonPath: skeleton, concurrency: 2 });
	await settleMs(300);
	const svc = root.rlmDelegate;

	t("the service is provided", () => ok(svc, "rlmDelegate is not on the context"));
	t("a graph can be declared through it", () => {
		const g = svc.declare("do the thing", [{ id: "a", title: "the thing", proof: passes }]);
		ok(g.id.startsWith("g-"), g.id);
	});
	t("open work is what it reports", () => eq(svc.open().length, 1));
	t("the prompt fragment names the task, in the words it was asked in", () => {
		const text = svc.owedFragment();
		ok(text.includes("the thing"), text);
		ok(text.includes("Still owed"), text);
	});
	t("the skeleton fragment is the file's current contents, read just now", () => {
		ok(svc.skeletonFragment().includes("name: 'delegator'"), "the loop's source is not in the fragment");
		fs.writeFileSync(skeleton, "export default () => ({ name: 'delegator', async run() { return 'rewritten' } })\n");
		ok(svc.skeletonFragment().includes("rewritten"), "the fragment did not follow the file");
	});
	t("it can say how much this machine will carry, and why", () => {
		// Not `>= 1`. Zero is a real, correct answer — it is what his 30% floor
		// says when the machine has no room, and the queue waits rather than a
		// child being forced out onto a laptop somebody is using. What must
		// always hold is that the number is a measured count and that the
		// verdict says which reading bound it.
		const v = svc.capacity();
		ok(Number.isInteger(v.limit) && v.limit >= 0, `limit was ${v.limit}`);
		ok(v.why.length > 0, "a limit nobody can explain is a guess");
		ok(v.readings.some((r: any) => r.name === "file descriptors"), svc.explainCapacity());
		ok(svc.explainCapacity().includes("file descriptors"), svc.explainCapacity());
	});
	t("a criterion can be run on its own", async () => {});

	const graphId = svc.open()[0].id;
	const done = await svc.run(graphId, async () => "ok");
	t("it runs a graph end to end", () => eq(done.tasks[0].state, "done"));
	t("and afterwards owes nothing", () => eq(svc.owedFragment(), ""));
	t("a reviewer's rejection goes through the service", () => {
		const after = svc.review(graphId, "a", "rejected", "me-2", "that criterion proves nothing");
		eq(after.tasks[0].state, "rejected");
	});
	t("and the service hands a reviewer the criterion and its evidence", () => {
		const g2 = svc.declare("second", [{ id: "z", title: "z", proof: { kind: "file", path: skeleton } }]);
		return g2;
	});

	console.log("\nhot-swap");
	const beforeDispose = svc.open().length;
	fork.dispose();
	await settleMs(150);
	t("disposing leaves the journal alone — the work is not the process", () => {
		eq(new Store(stateDir).open().length, beforeDispose);
	});
	t("and the service is gone from the context", () => eq(root.rlmDelegate, undefined));
}

console.log("\nan unstated task is not run through the service — it is left for the planner");
{
	// The production pattern: a graph with one `unstated` task is handed to
	// `svc.run()`. Before the fix, `run()` did not set `replanCriterion`, so
	// `runnable()` used `canRefine=false` and the unstated task was selected,
	// run, came back `unproven`, and the drive set it back to `unstated` —
	// forever. 80% of all negative outcomes in six hours were this loop.
	const stateDir = path.join(DIR, "unstated-not-run");
	const skeleton = path.join(DIR, "delegator-skeleton-unstated.ts");
	fs.writeFileSync(skeleton, "export default (api) => ({ name: 'delegator', async run(input) { return input } })\n");

	const root: any = new Context();
	const fork = root.plugin(RlmDelegateService, { dir: stateDir, skeletonPath: skeleton, concurrency: 1 });
	await settleMs(300);
	const svc = root.rlmDelegate;

	const g = svc.declare("a request nobody decomposed", [
		{ id: "the-request", title: "the request", prompt: "do it", proof: { kind: "unstated", note: "nobody said how to tell" } },
	]);

	let attempts = 0;
	const result = await svc.run(g.id, async () => { attempts++; return "I did it"; });
	const task = result.tasks.find((x: any) => x.id === "the-request")!;

	t("the unstated task was not handed to an agent", () => eq(attempts, 0, `runner was called ${attempts} times`));
	t("it was not marked unproven — that is the symptom of the loop", () => eq(task.state, "ready", task.state));
	t("it has no attempts recorded", () => eq(task.attempts.length, 0, `${task.attempts.length} attempts`));
	t("it is still owed, so the planner can refine it", () => ok(svc.open().some((open: any) => open.id === g.id), "graph was closed"));

	fork.dispose();
	await settleMs(150);
}


console.log("\na planner is asked for a paragraph, so it does not get the repo to write in");
{
	const scope = plannerScope(os.homedir());
	t("the plans directory is in its scope, and it exists", () => {
		ok(scope.writable.includes(path.join(os.homedir(), ".plans")), JSON.stringify(scope.writable));
		ok(fs.existsSync(path.join(os.homedir(), ".plans")), "~/.plans was not made");
	});
	t("the repo is not", () =>
		ok(!scope.writable.some((dir: string) => "/Users/abhi/proj/rlm".startsWith(dir) && dir !== "/"), JSON.stringify(scope.writable)));
	t("the profile reads everything and writes only inside the scope", () => {
		const profile = profileFor(2);
		ok(profile.includes("(allow default)"), profile);
		ok(profile.includes("(deny file-write*)"), profile);
		eq(profile.split("allow file-write*").length - 1, 2, profile);
	});
	t("confine returns the argv shape agent.ts expects, with the real command last", () => {
		const confine = confineTo({ writable: [os.tmpdir()] });
		ok(confine, "no confinement on this machine");
		const argv = confine!("/bin/echo", ["hi"]);
		eq(argv[0], "/usr/bin/sandbox-exec");
		eq(argv[argv.length - 2], "/bin/echo");
		eq(argv[argv.length - 1], "hi");
	});
	// The bound is only worth anything if the kernel really refuses. Run it.
	t("a confined process cannot write outside its scope, by any route", () => {
		const inside = path.join(DIR, "confine-inside.txt");
		const outside = path.join(DIR, "..", `confine-outside-${process.pid}.txt`);
		const confine = confineTo({ writable: [fs.realpathSync(DIR)] })!;
		const script =
			`const fs=require("node:fs");const out={};` +
			`try{fs.writeFileSync(${JSON.stringify(inside)},"x");out.inside="wrote"}catch(e){out.inside=e.code}` +
			`try{fs.writeFileSync(${JSON.stringify(outside)},"x");out.outside="wrote"}catch(e){out.outside=e.code}` +
			`out.read=fs.readFileSync("/Users/abhi/proj/rlm/package.json","utf8").length>0;` +
			`console.log(JSON.stringify(out));`;
		const [bin, ...rest] = confine(process.execPath, ["-e", script]);
		const ran = spawnSync(bin, rest, { encoding: "utf8" });
		eq(ran.status, 0, ran.stderr);
		const said = JSON.parse(ran.stdout.trim());
		eq(said.inside, "wrote");
		eq(said.outside, "EPERM", `expected EPERM outside the scope, got ${said.outside}`);
		eq(said.read, true, "reads must stay open — a planner has to read the repo");
		ok(!fs.existsSync(outside), "the file outside the scope was created");
	});
}

console.log("\na criterion the doer can answer itself is not a criterion");
{
	// A machine made up on the spot, so the screen is tested against a known
	// world rather than against whatever happens to be installed today.
	// Through realpath, both ends. macOS hands out /var/folders/… and resolves it
	// to /private/var/folders/…, and a sealed directory recorded under one
	// spelling never matches a program resolved under the other.
	const world = fs.realpathSync(DIR) + "/reach";
	const sealedbin = path.join(world, "opt", "bin");
	const work = path.join(world, "work");
	fs.mkdirSync(sealedbin, { recursive: true });
	fs.mkdirSync(work, { recursive: true });
	fs.writeFileSync(path.join(sealedbin, "realtool"), "#!/bin/sh\necho hello\n", { mode: 0o755 });
	fs.writeFileSync(path.join(sealedbin, "shim"), `#!/bin/bash\nexec ${path.join(work, "impl")} "$@"\n`, { mode: 0o755 });
	fs.writeFileSync(path.join(work, "impl"), "#!/bin/sh\necho real\n", { mode: 0o755 });
	fs.writeFileSync(path.join(work, "loose"), "#!/bin/sh\necho loose\n", { mode: 0o755 });
	// The system directories are in it because they are in every real one, and
	// leaving them out would make `grep` look like a name nobody had installed.
	const reach = {
		sealed: [sealedbin, "/bin", "/usr/bin"],
		lookup: [sealedbin, work, "/bin", "/usr/bin"],
		home: world,
		root: path.join(world, "repo"),
	};

	t("a program the fleet cannot write is sound", () => eq(gripOn("realtool", reach), null));
	t("a program in a directory nothing seals can be rewritten", () =>
		eq(gripOn("loose", reach)?.grip, "rebindable"));
	t("a name that resolves to nothing is the worst case, not the safest", () =>
		eq(gripOn("nosuchtool", reach)?.grip, "absent"));
	t("a sealed one-line launcher into a writable tree seals nothing", () => {
		const grip = gripOn("shim", reach);
		eq(grip?.grip, "delegating");
		eq(grip?.lands, path.join(work, "impl"));
	});

	t("the head of a clause is observed; what reads it downstream is not", () => {
		const parsed = segments("shim status | grep -q ok && echo done");
		eq(parsed.length, 3);
		eq(parsed[0]!.head, true);
		eq(parsed[0]!.pipedInto, true);
		eq(parsed[1]!.head, false);
		// `&& echo done` starts a clause and nothing reads it, so it decides
		// nothing — the distinction that stopped an honest criterion being flagged.
		eq(parsed[2]!.head, true);
		eq(parsed[2]!.pipedInto, false);
	});

	const grep = (run: string) => forgeryIn({ kind: "shell", run } as any, reach);
	t("running a name the agent can rebind, and matching a string, is forgeable", () =>
		eq(grep("shim ears self | grep -q '\"daemon\":\"connected\"'")?.grip, "delegating"));
	t("so is running a name that does not exist yet", () =>
		eq(grep("nosuchtool commands | grep -E 'config|recall' && echo FOUND")?.grip, "absent"));
	t("so is a program reached only through a command substitution", () =>
		eq(grep("TEXT=$(shim transcribe /tmp/a.wav) && test -n \"$TEXT\"")?.grip, "delegating"));
	t("a criterion that compares itself with itself is forgeable", () =>
		eq(grep("echo 'skill' | grep -q 'skill'")?.grip, "self-produced"));
	t("but a trailing echo nobody reads is not — it decides nothing", () =>
		eq(grep("realtool run | grep -q PASS && echo 'Tests passed'"), null));
	t("reading a file through sound tools is a file criterion, not a forgery", () =>
		eq(grep(`grep -q needle ${path.join(work, "impl")}`), null));
	t("and an ordinary file criterion is left alone", () =>
		eq(forgeryIn({ kind: "file", path: path.join(work, "notes.md"), contains: "x" } as any, reach), null));
	t("a criterion about the contents of a command on PATH is the hijack itself", () =>
		eq(forgeryIn({ kind: "file", path: path.join(sealedbin, "shim"), contains: "connected" } as any, reach)?.grip,
			"rebindable"));
	t("a row criterion has no oracle to rebind", () =>
		eq(forgeryIn({ kind: "row", id: "delegate", state: "ACTIVE" } as any, reach), null));

	t("forgeable() reports one finding per task, naming the task", () => {
		const found = forgeable(
			[
				{ id: "bad", title: "b", proof: { kind: "shell", run: "shim x | grep -q y" } },
				{ id: "good", title: "g", proof: { kind: "shell", run: "realtool x | grep -q y" } },
			] as any,
			reach,
		);
		eq(found.length, 1);
		eq(found[0]!.id, "bad");
		ok(found[0]!.why.includes(path.join(work, "impl")), found[0]!.why);
	});

	// ── the plan is refused, and the criterion is never run ──────────────────
	{
		const store = new Store(path.join(DIR, "forgeable-refine"));
		const g = store.create("make the shim say connected", [
			{ id: "job", title: "make it say connected", proof: { kind: "unstated" } },
		] as any);
		const sentinel = path.join(DIR, "the-forged-criterion-ran");
		const asked: string[] = [];
		const events: Array<[string, any]> = [];
		let turn = 0;
		const planner = async (prompt: string) => {
			asked.push(prompt);
			turn += 1;
			return turn === 1
				? JSON.stringify([
						{ id: "a", title: "A", proof: { kind: "shell", run: `shim self && touch ${sentinel}` } },
					])
				: JSON.stringify([{ id: "a", title: "A", proof: { kind: "shell", run: "exit 1" } }]);
		};
		const into = await refineOne(store, g, g.tasks[0] as any, planner as any, (e, d) => events.push([e, d]), { reach });

		t("the forgeable plan was refused and the second one accepted", () => eq(into, 1));
		t("a refusal was journalled naming the task whose oracle was owned", () => {
			const refusal = events.find(([e]) => e === "rlm/delegate-refine-refused");
			ok(refusal, "no refusal event");
			ok(Array.isArray(refusal![1].forgeable), "refusal did not name the forgeable criteria");
			eq(refusal![1].forgeable[0], "a");
		});
		t("the planner was told exactly why, in the words it has to fix", () => {
			ok(asked.length >= 2, `planner asked ${asked.length} times`);
			ok(asked[1]!.includes("can be made true without the work being done"), asked[1]!.slice(-400));
		});
		t("the forgeable criterion was never executed — the screen runs before it", () =>
			ok(!fs.existsSync(sentinel), "the criterion ran; the screen is in the wrong order"));
		t("the task became real work with a criterion that can fail", () => {
			const after = store.load(g.id)!;
			const job = after.tasks.find((task: any) => task.id === "a")!;
			eq(job.proof.kind, "shell");
		});
	}

	// ── what was already in the graphs ───────────────────────────────────────
	{
		const store = new Store(path.join(DIR, "forgeable-sweep"));
		const g = store.create("already queued", [
			{ id: "forged", title: "F", proof: { kind: "shell", run: "shim notify.status | grep -q running" } },
			{ id: "sound", title: "S", proof: { kind: "shell", run: "realtool notify.status | grep -q running" } },
		] as any);
		const events: Array<[string, any]> = [];
		const swept = reopenForged(store, [g], (e, d) => events.push([e, d]), { reach });
		const after = store.load(g.id)!;
		const forged = after.tasks.find((task: any) => task.id === "forged")!;
		const sound = after.tasks.find((task: any) => task.id === "sound")!;

		t("the already-queued forgeable criterion was withdrawn", () => eq(swept, 1));
		t("the sound one beside it was left exactly as it was", () => eq(sound.proof.kind, "shell"));
		t("the task itself was not thrown away — only its proof", () => {
			eq(forged.proof.kind, "unstated");
			ok(after.tasks.some((task: any) => task.id === "forged"), "the task disappeared");
			ok(forged.state !== "rejected", `state is ${forged.state}`);
		});
		t("it says why, so the journal records what was withdrawn and what it was", () => {
			const said = events.find(([e]) => e === "rlm/delegate-forgeable-withdrawn");
			ok(said, "nothing was journalled");
			eq(said![1].grip, "delegating");
			ok(String(said![1].was).includes("shim notify.status"), said![1].was);
		});
		t("a second sweep does nothing, so it converges instead of looping", () =>
			eq(reopenForged(store, [store.load(g.id)!], () => {}, { reach }), 0));

		// A task in an agent's hands keeps its criterion. `store.open()` rewrites
		// `running` to `ready` as crash recovery, so the drive re-reads with
		// `recoverRunning: false` before sweeping — without that, this passes for
		// the wrong reason and the real drive pulls criteria out from under live
		// work.
		t("a task an agent is holding right now is left alone", () => {
			const held = new Store(path.join(DIR, "forgeable-inflight"));
			const hg = held.create("in flight", [
				{ id: "busy", title: "B", proof: { kind: "shell", run: "shim status | grep -q ok" } },
			] as any);
			held.began(hg.id, "busy");
			eq(reopenForged(held, [held.load(hg.id, { recoverRunning: false })!], () => {}, { reach }), 0);
			// and the same graph read the way `open()` reads it would have been swept,
			// which is exactly why the drive does not read it that way.
			eq(reopenForged(held, [held.load(hg.id)!], () => {}, { reach }), 1);
		});
	}
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
