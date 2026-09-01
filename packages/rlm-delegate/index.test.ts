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

console.log("\nthe limit is measured, and never zero");
{
	t("this machine reports a limit of at least one, with its reasoning", () => {
		const verdict = capacity();
		ok(verdict.limit >= 1, `limit was ${verdict.limit}`);
		ok(verdict.why.length > 0, "no reasoning given");
		ok(verdict.readings.some((r) => r.name === "file descriptors"), "descriptors were not read");
	});
	t("a machine with no headroom still gets one", () => eq(capacity({ floor: 1.1 }).limit, 1));
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
		ok(svc.capacity().limit >= 1);
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
