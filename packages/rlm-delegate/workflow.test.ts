/**
 * The loop end to end, with a stand-in for the model.
 *
 * The unit tests prove the graph cannot forget. This one proves the delegator
 * actually uses it: that a request becomes rows on disk before any of it is
 * attempted, that independent work overlaps, that a confident "Done" does not
 * finish a task whose criterion says otherwise, and that what is left is still
 * there for the next process.
 */
import { Context } from "@deepseek-ai/cordis";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import RlmDelegateService from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/index.ts";
import makeDelegator from "/Users/abhi/proj/rlm/packages/rlm-delegate/workflows/delegator.ts";
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
	try { fn(); pass++; console.log("  ok  " + name); }
	catch (e: any) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const eq = (a: any, b: any, m = "") => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v: any, m = "") => { if (!v) throw new Error(m || "expected truthy"); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rlm-delegator-"));
const marker = path.join(DIR, "left-was-here.txt");

const root: any = new Context();
// The limit is pinned here so this proves the loop, not the state of the
// machine it happens to run on; capacity itself is measured and proved in
// index.test.ts.
const fork = root.plugin(RlmDelegateService, { dir: path.join(DIR, "graphs"), teachSkeleton: false, concurrency: 3 });
await wait(300);
const graphs = root.rlmDelegate;

const spans: Array<{ id: string; from: number; to: number }> = [];
const said: string[] = [];
const events: string[] = [];

const sdk = {
	async spawn(prompt: string, opts: { name?: string } = {}) {
		said.push(opts.name ?? "?");
		if (opts.name === "planner") {
			// Two independent jobs and one that must wait for both. The third
			// declares a criterion it cannot satisfy, so the loop has to notice.
			return `Here is the plan:\n${JSON.stringify([
				{ id: "left", title: "the left-hand job", proof: { kind: "file", path: marker } },
				{ id: "right", title: "the right-hand job", proof: { kind: "shell", run: "exit 0" } },
				{ id: "both", title: "the one that needs both", needs: ["left", "right"], proof: { kind: "shell", run: "exit 0" } },
				{ id: "lying", title: "the one that will claim to be finished", proof: { kind: "file", path: path.join(DIR, "never-written") } },
			])}`;
		}
		const from = Date.now();
		await wait(200);
		if (opts.name === "left") fs.writeFileSync(marker, "done");
		spans.push({ id: opts.name ?? "?", from, to: Date.now() });
		return "Done. Everything is built and working.";
	},
};

const api = {
	ctx: { get: (key: string) => (key === "rlmDelegate" ? graphs : null) },
	emit: (event: string) => { events.push(event); },
	sdk,
};

console.log("\nthe loop writes the work down, then does it");
const account = await makeDelegator(api).run("four things, please");

const store = new Store(path.join(DIR, "graphs"));
const graph = store.load(store.ids()[0])!;

t("the request became a graph on disk", () => {
	ok(store.ids().length === 1, `${store.ids().length} graphs`);
	eq(graph.tasks.length, 4);
});
t("the goal is kept in the words it was asked in", () => eq(graph.goal, "four things, please"));
t("every task carries a criterion", () => ok(graph.tasks.every((x) => x.proof && (x.proof as any).kind), "a task has no criterion"));
t("the planner ran once, then the work", () => eq(said[0], "planner"));

console.log("\nindependent work overlapped");
t("left and right ran at the same time", () => {
	const left = spans.find((s) => s.id === "left");
	const right = spans.find((s) => s.id === "right");
	ok(left && right, `spans: ${JSON.stringify(spans)}`);
	ok(left!.from < right!.to && right!.from < left!.to, `no overlap: ${JSON.stringify(spans)}`);
});
t("and the dependent one waited for both", () => {
	const both = spans.find((s) => s.id === "both");
	const left = spans.find((s) => s.id === "left");
	const right = spans.find((s) => s.id === "right");
	ok(both, "the dependent task never ran");
	ok(both!.from >= left!.to && both!.from >= right!.to, `it started too early: ${JSON.stringify(spans)}`);
});

console.log("\na confident report is not a finished task");
t("the two real jobs are done", () => {
	eq(graph.tasks.find((x) => x.id === "left")!.state, "done");
	eq(graph.tasks.find((x) => x.id === "right")!.state, "done");
});
t("the one that only claimed to be finished is failed", () => eq(graph.tasks.find((x) => x.id === "lying")!.state, "failed"));
t("and its reason names the criterion, not the prose", () =>
	ok(graph.tasks.find((x) => x.id === "lying")!.reason!.includes("does not exist"), graph.tasks.find((x) => x.id === "lying")!.reason));
t("the account handed back says what is still owed", () => {
	ok(account.includes("3/4 done, 1 still owed"), account.split("\n").pop());
	ok(account.includes("the one that will claim to be finished"), "the failed job is not in the account");
});

console.log("\nwhat is left is still there for whoever comes next");
t("the graph is still open", () => eq(graphs.open().length, 1));
t("and the prompt says so, in the asker's words", () => {
	const fragment = graphs.owedFragment();
	ok(fragment.includes("the one that will claim to be finished"), fragment);
});
{
	// A task that is merely unfinished — the shape a crash leaves behind.
	const leftover = graphs.declare("an earlier request nobody finished", [
		{ id: "leftover", title: "the job from before", proof: { kind: "shell", run: "exit 0" } },
	]);
	const before = said.length;
	await makeDelegator(api).run("something else entirely");
	const after = said.slice(before);

	t("unfinished work from an earlier request is done before the new one is planned", () =>
		ok(after.indexOf("leftover") !== -1 && after.indexOf("leftover") < after.indexOf("planner"), after.join(",")));
	t("the loop said it was resuming", () => ok(events.includes("rlm/delegator-resuming"), events.join(",")));
	t("the leftover is finished now", () => eq(store.load(leftover.id)!.tasks[0].state, "done"));

	// The failed one is a different case on purpose: it stays owed and visible,
	// but it is not silently handed back to an agent on every later request.
	t("the task that failed is neither retried behind the user's back nor dropped", () => {
		const still = store.load(graph.id)!.tasks.find((x) => x.id === "lying")!;
		eq(still.state, "failed");
		eq(still.attempts.length, 2);
		ok(graphs.owedFragment().includes("the one that will claim to be finished"), "it fell out of what is owed");
	});
}

fork.dispose();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
