/**
 * Housekeeping that exists but never runs is housekeeping that does not exist.
 *
 * `Store.reconcile()` resolves graphs that began and then lost whoever was
 * driving them — no terminal event, no progress, invisible to `prune()` because
 * prune only reclaims settled journals. Eight such graphs had been sitting in
 * the real store since 2026-09-05, and nothing would ever have touched them,
 * because `reconcile` was a method the sweep never called: the service's startup
 * housekeeping ran `prune()` and `quarantine()` and stopped there.
 *
 * This test holds the wiring itself, not the reconciler's logic (that lives in
 * store-housekeeping.test.ts). It asserts the property that actually failed in
 * production: bringing the service up over a store containing an abandoned
 * graph must leave that graph ended, with a reason on the record.
 */
import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { RlmDelegateService } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/index.ts";
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";

const DAY = 24 * 60 * 60 * 1000;

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

/**
 * Bring the service up the way the host does — through the plugin registry, on a
 * real Cordis context — rather than calling the constructor directly. The base
 * `Service` constructor reaches into container internals, so a hand-rolled ctx
 * cannot stand in for one; and it is the real startup path that has to reconcile.
 */
const bringUp = async (dir: string): Promise<void> => {
	const root: any = new Context();
	root.plugin(RlmDelegateService, { dir });
	await new Promise((r) => setTimeout(r, 300));
};

test("bringing the service up ends a graph nobody has touched", async () => {
	const store = new Store(mkdtempSync(join(tmpdir(), "rlm-sweep-")));
	const graph = store.create("abandoned mid-flight", [
		{ id: "stranded", title: "the task nobody finished", proof: { kind: "shell", run: "exit 0" } },
	]);
	store.began(graph.id, "stranded");
	backdate(store, graph.id, 2 * DAY);

	// Before the sweep runs, the task is exactly what production looked like:
	// begun, not ended, and not going anywhere on its own.
	const before = store.load(graph.id);
	ok(before, "the fixture graph should load");
	strictEqual(before?.tasks[0]?.state === "done", false);

	await bringUp(store.dir);

	// The full housekeeping chain runs in one pass: reconcile ends the stranded
	// task, and quarantine then moves the now-finished journal out of the active
	// queue — so the graph is found under quarantine/, not where it started.
	const quarantined = new Store(join(store.dir, "quarantine"));
	const after = quarantined.load(graph.id);
	const task = after?.tasks.find((t) => t.id === "stranded");
	strictEqual(task?.state, "failed", "the abandoned task should have been ended by the sweep");

	const journal = readFileSync(join(store.dir, "quarantine", `${graph.id}.jsonl`), "utf8");
	ok(
		journal.includes("abandoned: nothing has touched this graph since"),
		"the give-up should be on the record with its reason, not silent",
	);
});

test("a graph that is still live is left alone by the sweep", async () => {
	const store = new Store(mkdtempSync(join(tmpdir(), "rlm-sweep-live-")));
	const graph = store.create("live work", [
		{ id: "t", title: "the thing", proof: { kind: "shell", run: "exit 0" } },
	]);
	store.began(graph.id, "t");

	await bringUp(store.dir);

	const after = store.load(graph.id);
	ok(after, "live work must stay in the active queue, not be quarantined");
	strictEqual(
		after?.tasks.find((t) => t.id === "t")?.state === "failed",
		false,
		"work begun moments ago is not abandoned and must survive the sweep",
	);
});
