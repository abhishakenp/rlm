/**
 * iris-recall search: finds a query across nested session folders with a
 * snippet, and the limit stops the whole walk (it used to stop one folder).
 * Run: `bun test packages/iris-recall/test/search.test.ts`.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IrisRecallService } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "iris-recall-"));
for (const d of ["a", "a/sub", "b", "c"]) mkdirSync(join(root, d), { recursive: true });
writeFileSync(join(root, "a/one.jsonl"), '{"text":"the Needle is here"}\n');
writeFileSync(join(root, "a/sub/two.jsonl"), '{"text":"another needle"}\n');
writeFileSync(join(root, "b/three.jsonl"), '{"text":"needle three"}\n');
writeFileSync(join(root, "c/four.jsonl"), '{"text":"nothing"}\n');
writeFileSync(join(root, "c/notes.txt"), "needle but not jsonl\n");

test("finds matches case-insensitively in nested folders, jsonl only", async () => {
	const { results } = await new IrisRecallService(root).search({ query: "needle", limit: 10 });
	expect(results.length).toBe(3);
	expect(results.every((r) => r.path.endsWith(".jsonl"))).toBe(true);
	expect(results.some((r) => r.snippet.includes("the Needle is here"))).toBe(true);
});

test("the limit stops the whole walk", async () => {
	const svc: any = new IrisRecallService(root);
	let visited = 0;
	const finished = svc.walk(root, () => (visited++, false));
	expect(visited).toBe(1);
	expect(finished).toBe(false);
	const { results } = await svc.search({ query: "needle", limit: 1 });
	expect(results.length).toBe(1);
});
