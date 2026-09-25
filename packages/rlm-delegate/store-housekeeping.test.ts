/**
 * The journal has to be able to let go, and it has to stay one line per entry.
 *
 * Both are the same bug wearing different hats. A store that only ever grows is
 * a store nobody reads: 731 journals accumulated in quarantine, 607 of them
 * graphs that had already reached a terminal outcome that was not `done`, and
 * `prune` reclaimed none of them because it only ever deleted a graph whose
 * every task was proven done — the 2% case. And a journal written as
 * pretty-printed JSON is a graph that no longer exists as far as the fold is
 * concerned: `load` skips every line that will not parse, so a sixteen-line
 * record parses to nothing and the whole request silently disappears.
 *
 * These tests hold the properties that stop both: a graph that ended badly is
 * eventually reclaimable while live work never is, a graph nobody has touched
 * is resolved to something explicit rather than left invisible, and an entry
 * with a newline in it is refused at the point of writing.
 */
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { oneLine, Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";

const DAY = 24 * 60 * 60 * 1000;
const HALF_DAY = 12 * 60 * 60 * 1000;

const freshStore = (): Store => new Store(mkdtempSync(join(tmpdir(), "rlm-housekeeping-")));

/** Rewrite a journal's `at` stamps so the graph reads as old, without waiting. */
const backdate = (store: Store, id: string, ms: number): void => {
	const file = join(store.dir, `${id}.jsonl`);
	const at = new Date(Date.now() - ms).toISOString();
	const lines = readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.stringify({ ...JSON.parse(l), at }));
	writeFileSync(file, `${lines.join("\n")}\n`);
};

/** A graph with one task that failed — the shape 607 quarantined journals have. */
const spentGraph = (store: Store, ageMs: number): string => {
	const graph = store.create("a thing that did not work", [
		{ id: "t", title: "the thing", proof: { kind: "shell", run: "exit 1" } },
	]);
	store.ended(graph.id, "t", "failed", { at: "then", ok: false, detail: "it did not work" }, { reason: "it did not work" });
	backdate(store, graph.id, ageMs);
	return graph.id;
};

test("a graph that ended badly is reclaimed once it is past the spent ttl", () => {
	const store = freshStore();
	const id = spentGraph(store, 100 * DAY);
	strictEqual(store.load(id)!.tasks[0].state, "failed");

	// The fortnight that governs receipts does not touch it: the point of the
	// second ttl is that evidence is kept far longer than a receipt is.
	deepStrictEqual(store.prune(14 * DAY, 365 * DAY), []);
	ok(existsSync(join(store.dir, `${id}.jsonl`)), "it was reclaimed on the receipt ttl");

	deepStrictEqual(store.prune(14 * DAY, 90 * DAY), [id]);
	ok(!existsSync(join(store.dir, `${id}.jsonl`)), "it was still there after its own ttl passed");
});

test("a graph that ended badly is still kept while it is inside the spent ttl", () => {
	const store = freshStore();
	const id = spentGraph(store, 3 * DAY);
	deepStrictEqual(store.prune(14 * DAY, 90 * DAY), []);
	ok(existsSync(join(store.dir, `${id}.jsonl`)), "a three-day-old wound was thrown away");
});

test("a graph that still owes work is never reclaimed, however old", () => {
	const store = freshStore();
	const graph = store.create("live work", [{ id: "t", title: "the thing", proof: { kind: "shell", run: "exit 0" } }]);
	backdate(store, graph.id, 1000 * DAY);
	deepStrictEqual(store.prune(0, 0), []);
	ok(existsSync(join(store.dir, `${graph.id}.jsonl`)), "work nobody has finished was deleted");
});

test("a journal nothing can be folded out of is kept, not reclaimed", () => {
	// 104 of the 731 quarantined journals are like this: entries, but no
	// `declared` to fold them onto. Nothing can say what their terminal state
	// was, and the rule is that only a recorded terminal state justifies a
	// deletion.
	const store = freshStore();
	const id = "g-20260101000000-zzzz";
	writeFileSync(
		join(store.dir, `${id}.jsonl`),
		`${JSON.stringify({ k: "ended", at: "2020-01-01T00:00:00.000Z", id: "t", state: "blocked", attempt: { at: "then", ok: false, detail: "no such graph" } })}\n`,
	);
	strictEqual(store.load(id), null);
	deepStrictEqual(store.prune(0, 0), []);
	ok(existsSync(join(store.dir, `${id}.jsonl`)), "an unreadable journal was thrown away");
});

test("the spent ttl is read from the environment, not hard-coded", () => {
	const store = freshStore();
	const id = spentGraph(store, 30 * DAY);
	const before = process.env.RLM_DELEGATE_SPENT_TTL_MS;
	try {
		process.env.RLM_DELEGATE_SPENT_TTL_MS = String(7 * DAY);
		deepStrictEqual(store.prune(), [id]);
	} finally {
		if (before === undefined) delete process.env.RLM_DELEGATE_SPENT_TTL_MS;
		else process.env.RLM_DELEGATE_SPENT_TTL_MS = before;
	}
});

test("age is read from the journal, not from the state a load derives", () => {
	const store = freshStore();
	// `settle` stamps `updatedAt` with the time of the load whenever it moves a
	// derived state, so a graph re-derived on every read looks freshly touched
	// for ever. Only what is written down can say how old a graph is.
	const graph = store.create("derived every time", [
		{ id: "a", title: "a", proof: { kind: "shell", run: "exit 1" } },
		{ id: "b", title: "b", needs: ["a"], proof: { kind: "shell", run: "exit 0" } },
	]);
	store.ended(graph.id, "a", "failed", { at: "then", ok: false, detail: "no" }, { reason: "no" });
	backdate(store, graph.id, 100 * DAY);
	const loaded = store.load(graph.id)!;
	ok(loaded.tasks.every((t) => ["failed", "unreachable"].includes(t.state)), "not the shape under test");
	ok(Date.parse(loaded.tasks.find((t) => t.id === "b")!.updatedAt) > Date.now() - 60_000, "b was not re-derived");
	deepStrictEqual(store.prune(14 * DAY, 90 * DAY), [graph.id]);
});

test("a stale graph nobody has touched is resolved to something explicit", () => {
	const store = freshStore();
	const graph = store.create("abandoned mid-flight", [
		{ id: "parent", title: "the request", proof: { kind: "unstated" } },
	]);
	store.refine(graph.id, "parent", [{ id: "child", title: "do it", proof: { kind: "shell", run: "exit 0" } }]);
	backdate(store, graph.id, 2 * DAY);

	const before = store.load(graph.id)!;
	ok(before.tasks.some((t) => t.state === "ready" || t.state === "blocked"), "nothing was owed to begin with");
	deepStrictEqual(store.prune(0, 0), [], "a graph that still owes work must not be prunable yet");

	const dry = store.reconcile(HALF_DAY, { dryRun: true });
	deepStrictEqual(dry.map((r) => r.graph), [graph.id]);
	deepStrictEqual([...dry[0].tasks].sort(), ["child", "parent"]);
	strictEqual(readFileSync(join(store.dir, `${graph.id}.jsonl`), "utf8").includes('"ended"'), false, "the dry run wrote");

	const done = store.reconcile(HALF_DAY);
	deepStrictEqual(done.map((r) => r.graph), [graph.id]);

	const after = store.load(graph.id)!;
	ok(after.tasks.every((t) => t.state === "failed"), `still live: ${after.tasks.map((t) => t.state).join()}`);
	ok(after.tasks.every((t) => (t.reason ?? "").includes("nothing has touched")), "no reason was recorded");
	// And now it is evidence like any other wound, so it can age out. Its own
	// clock restarts here — the reconciler wrote to the journal, and that is a
	// touch like any other — so this asks for the ttl it is now actually past.
	deepStrictEqual(store.reclaimable(14 * DAY, 0).map((r) => r.kind), ["spent"]);
	deepStrictEqual(store.prune(14 * DAY, 0), [graph.id]);
});

test("a graph that was touched recently is left alone by the reconciler", () => {
	const store = freshStore();
	const graph = store.create("live work", [{ id: "t", title: "t", proof: { kind: "shell", run: "exit 0" } }]);
	deepStrictEqual(store.reconcile(HALF_DAY), []);
	strictEqual(store.load(graph.id)!.tasks[0].state, "ready");
});

test("the stale threshold is read from the environment, not hard-coded", () => {
	const store = freshStore();
	const graph = store.create("abandoned", [{ id: "t", title: "t", proof: { kind: "shell", run: "exit 0" } }]);
	backdate(store, graph.id, 2 * DAY);
	const before = process.env.RLM_DELEGATE_LOST_AFTER_MS;
	try {
		process.env.RLM_DELEGATE_LOST_AFTER_MS = String(7 * DAY);
		deepStrictEqual(store.reconcile(), [], "a two-day-old graph was abandoned under a seven-day threshold");
		process.env.RLM_DELEGATE_LOST_AFTER_MS = String(DAY);
		deepStrictEqual(store.reconcile().map((r) => r.graph), [graph.id]);
	} finally {
		if (before === undefined) delete process.env.RLM_DELEGATE_LOST_AFTER_MS;
		else process.env.RLM_DELEGATE_LOST_AFTER_MS = before;
	}
});

test("an entry with a newline in it is refused, not written", () => {
	throws(() => oneLine('{\n  "k": "declared"\n}'), /one line/i);
	throws(() => oneLine('{"k":"declared"}\r\n{"k":"began"}'), /one line/i);
	strictEqual(oneLine('{"k":"declared","goal":"a\\nb"}'), '{"k":"declared","goal":"a\\nb"}');
});

test("a journal written as pretty-printed json is repaired without losing a record", () => {
	const store = freshStore();
	const id = "g-1788318770489";
	const records = [
		{
			k: "declared",
			at: "2026-09-02T03:12:50.489Z",
			goal: "track it",
			tasks: [{ id: "example-task", title: "track it", proof: { kind: "shell", run: "true" } }],
		},
		{ k: "began", at: "2026-09-02T03:12:51.000Z", id: "example-task" },
	];
	writeFileSync(join(store.dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r, null, 2)).join("\n"));

	strictEqual(store.load(id), null, "a multi-line journal is not the thing under test");

	strictEqual(store.repair(id), 2);
	const lines = readFileSync(join(store.dir, `${id}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim());
	strictEqual(lines.length, 2);
	for (const line of lines) oneLine(line);
	deepStrictEqual(lines.map((l) => JSON.parse(l)), records);

	const graph = store.load(id)!;
	strictEqual(graph.goal, "track it");
	strictEqual(graph.tasks.length, 1);
});

test("repairing a journal that is already one line per entry changes nothing", () => {
	const store = freshStore();
	const graph = store.create("fine already", [{ id: "t", title: "t", proof: { kind: "shell", run: "exit 0" } }]);
	const file = join(store.dir, `${graph.id}.jsonl`);
	const before = readFileSync(file, "utf8");
	strictEqual(store.repair(graph.id), 0);
	strictEqual(readFileSync(file, "utf8"), before);
});
