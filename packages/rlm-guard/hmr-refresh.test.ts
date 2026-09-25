/**
 * A guard built by old code re-derives its protected list and backstop when
 * rlm-hmr calls `Symbol.for("rlm.hmr.patched")` — with no moment unwatched.
 */
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RlmGuardService } from "./src/index.ts";
import { resolveProtected } from "./src/protect.ts";

const root = mkdtempSync(join(tmpdir(), "rlm-guard-hmr-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const [rel, body] of [
	["cordis.yml", "- id: guard\n"],
	["packages/rlm-delegate/src/capacity.ts", "export const cap = 1;\n"],
	["packages/rlm-guard/src/index.ts", "export {};\n"],
] as const) {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), body);
}
execFileSync("git", ["init", "-q"], { cwd: root });
execFileSync("git", ["add", "-A"], { cwd: root });

test("patched hook drops a spec the new code no longer has, new backstop first", async () => {
	const guard = Object.create(RlmGuardService.prototype) as any;
	guard.ctx = {};
	guard.config = { cwd: root, protect: ["packages/rlm-delegate/src/capacity.ts"], unlockFile: join(root, "unlock.json") };
	guard.root = root;
	guard.incidents = [];
	// What the OLD code resolved at init: cordis.yml included.
	guard.files = resolveProtected(root, [
		{ pattern: "packages/rlm-delegate/src/capacity.ts", why: "x" },
		{ pattern: "packages/rlm-guard/src/**", why: "x", inherent: true },
		{ pattern: "cordis.yml", why: "x", inherent: true },
	]);
	expect(guard.files.map((f: any) => f.rel)).toContain("cordis.yml");
	const order: string[] = [];
	const oldStop = () => order.push(guard.stopWatching === oldStop ? "old stopped BEFORE new started" : "old stopped after new started");
	guard.stopWatching = oldStop;

	await guard[Symbol.for("rlm.hmr.patched")]({ paths: [] });

	const rels = guard.files.map((f: any) => f.rel);
	expect(rels).not.toContain("cordis.yml");
	expect(rels).toContain("packages/rlm-delegate/src/capacity.ts");
	expect(rels).toContain("packages/rlm-guard/src/index.ts");
	expect(order).toEqual(["old stopped after new started"]);
	expect(typeof guard.stopWatching).toBe("function");
	expect(guard.stopWatching).not.toBe(oldStop);
	expect(guard.baselines.map((b: any) => b.file?.rel ?? b.rel)).not.toContain("cordis.yml");
	guard.stopWatching();

	// Unchanged list: nothing restarted.
	const current = guard.stopWatching;
	await guard[Symbol.for("rlm.hmr.patched")]({ paths: [] });
	expect(guard.stopWatching).toBe(current);
});

test("patched hook re-derives the PATH directories too, new backstop first", async () => {
	const guard = Object.create(RlmGuardService.prototype) as any;
	guard.ctx = {};
	const extra = mkdtempSync(join(tmpdir(), "rlm-guard-pathdir-"));
	guard.config = { cwd: root, protect: [], protectPath: false, protectPathDirs: [extra], unlockFile: join(root, "unlock.json") };
	guard.root = root;
	guard.incidents = [];
	guard.files = guard.protectedList();
	// What the OLD code derived at init: a directory the new config no longer names.
	guard.pathDirs = [{ abs: "/nonexistent/old-bin", dir: "/nonexistent/old-bin", watched: true, why: "x" }];
	const order: string[] = [];
	const oldStop = () =>
		order.push(guard.stopWatchingPath === oldStop ? "old stopped BEFORE new started" : "old stopped after new started");
	guard.stopWatchingPath = oldStop;

	await guard[Symbol.for("rlm.hmr.patched")]({ paths: [] });

	const dirs = guard.pathDirs.map((d: any) => d.abs);
	expect(dirs).not.toContain("/nonexistent/old-bin");
	expect(dirs.some((d: string) => d.endsWith(extra.split("/").pop()!))).toBe(true);
	expect(order).toEqual(["old stopped after new started"]);
	expect(guard.stopWatchingPath).not.toBe(oldStop);
	guard.stopWatchingPath();
	rmSync(extra, { recursive: true, force: true });
});
