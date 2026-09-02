/**
 * Every ask he made, in the graph, with the state it is actually in.
 *
 * Sourced by reading his own 117 typed messages and 83 voice utterances, not
 * anybody's recollection. Triaged against the running system, with evidence
 * required for anything called done.
 *
 * `done` is recorded as done — a graph that pretends finished work is owed is
 * as useless as one that pretends owed work is finished. `partial` is the
 * important state and it is recorded as owed with the half that exists named
 * in the prompt, because "some of it is there" is exactly how a thing gets
 * forgotten. `unclear` becomes a question rather than a guess.
 */
import { Store } from "/Users/abhi/proj/rlm/packages/rlm-delegate/src/store.ts";
import { readFileSync } from "node:fs";

const store = new Store();
const rows: any[] = [];
for (const n of [1, 2, 3, 4]) {
	try {
		rows.push(...JSON.parse(readFileSync(`/tmp/triaged-${n}.json`, "utf8")));
	} catch (error: any) {
		console.log(`  batch ${n} unreadable: ${error?.message ?? error}`);
	}
}
console.log(`  ${rows.length} triaged asks`);

const slug = (s: string, i: number) =>
	`${s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 5).join("-") || "ask"}-${i}`;

// Chunked: one graph of three hundred tasks is not a graph anybody reads, and
// the drive works every graph anyway.
const CHUNK = 40;
const made: string[] = [];
for (let at = 0; at < rows.length; at += CHUNK) {
	const part = rows.slice(at, at + CHUNK);
	const tasks = part.map((r, i) => ({
		id: slug(r.ask, r.idx ?? at + i),
		title: String(r.ask).slice(0, 90),
		prompt:
			`${r.ask}\n\nHis words [${r.ts}]: "${String(r.his_words).slice(0, 700)}"\n\n` +
			`Where it stood on 2026-09-02: ${r.state.toUpperCase()} — ${r.evidence}` +
			(r.state === "partial" ? `\n\nPartial is the dangerous state: the half that exists is why nobody notices the half that does not.` : ""),
		proof: { kind: "unstated" as const, note: `triaged ${r.state}: ${String(r.evidence).slice(0, 160)}` },
	}));
	const graph = store.create(
		`What he asked for, ${at + 1}–${at + part.length} of ${rows.length}. Read from his own messages; triaged against the running system.`,
		tasks as any,
	);
	made.push(graph.id);

	// Settle the ones already proven, so the backlog is honest in both directions.
	for (let i = 0; i < part.length; i += 1) {
		const r = part[i];
		if (r.state !== "done") continue;
		store.ended(graph.id, tasks[i].id, "done", { ok: true, detail: r.evidence, proofDetail: r.evidence } as any, {
			result: `already done when the backlog was reconstructed: ${r.evidence}`,
		});
	}
}
console.log(`  wrote ${made.length} graph(s)`);
const counts: Record<string, number> = {};
for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
console.log("  " + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));
