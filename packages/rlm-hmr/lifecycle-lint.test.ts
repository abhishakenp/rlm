/**
 * Every row must be swappable with zero downtime. Two things break that and
 * are cheap to see in source:
 *
 * 1. Cleanup in `[Service.stop]`, `[Service.dispose]`, `[Symbol.dispose]` or
 *    `[Symbol.asyncDispose]`. Cordis 4.0.2 calls none of them — only
 *    `ctx.effect` disposers run (probe: `{symbolDispose: 0, effectDisposer: 1}`)
 *    — so the cleanup silently never happens and a swap leaks the old
 *    generation's sockets, timers and registrations.
 * 2. A long-lived resource (interval, server, file watch) created by a row that
 *    registers no effect and adopts nothing (packages/rlm-hmr/src/hot.ts): it is
 *    never released, or it blinks when the row is swapped.
 *
 * Scans the rows the composition and the user's overlay actually load.
 * `KNOWN` lists rows another owner is converting, with the reason; delete the
 * entry when it is fixed — the test fails on a stale entry too.
 *
 * Run: bun test packages/rlm-hmr/lifecycle-lint.test.ts
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Rows owned elsewhere, still on the old pattern. Reason required. */
const KNOWN: Record<string, string> = {
	"packages/rlm-sdk/src/index.ts": "SURFACE owns this row (zero-restart Case 3)",
	"packages/rlm-tui-renderer/src/index.ts": "SURFACE owns this row (zero-restart Case 3)",
};

const rowFiles = (): string[] => {
	const sources = [join(repo, "cordis.yml"), join(process.env.RLM_HOME ?? join(homedir(), ".rlm"), "cordis.patch.yml")];
	const out = new Set<string>();
	for (const s of sources) {
		if (!existsSync(s)) continue;
		for (const m of readFileSync(s, "utf8").matchAll(/name:\s*'?(\.\/packages\/[^'\s]+)/g)) out.add(m[1]!.slice(2));
	}
	return [...out].filter((f) => existsSync(join(repo, f))).sort();
};

/** Strip comments so prose that names a symbol is not mistaken for code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const DEAD = /^\s*(?:async\s+)?\[(?:Service\.(?:stop|dispose)|Symbol\.(?:dispose|asyncDispose))\]\s*\(/m;
const RESOURCE = /\bsetInterval\(|\bcreateServer\(|\.listen\(|\bfsWatch\(|\bwatchFile\(|\bwatch\(/;
const MANAGED = /\.effect\??\.?\(|\badopt\(|\badoptInterval\(/;

const findings = () => {
	const out: Record<string, string[]> = {};
	for (const rel of rowFiles()) {
		const src = code(readFileSync(join(repo, rel), "utf8"));
		const problems: string[] = [];
		if (DEAD.test(src)) problems.push("cleanup in a method Cordis never calls");
		if (RESOURCE.test(src) && !MANAGED.test(src)) problems.push("long-lived resource with no effect/adopt");
		if (problems.length) out[rel] = problems;
	}
	return out;
};

test("no row keeps cleanup where Cordis never calls it, or holds unmanaged resources", () => {
	const found = findings();
	const unexpected = Object.fromEntries(Object.entries(found).filter(([f]) => !(f in KNOWN)));
	expect(unexpected).toEqual({});
});

test("every KNOWN entry is still a real finding (delete it once fixed)", () => {
	const found = findings();
	const loaded = new Set(rowFiles());
	const stale = Object.keys(KNOWN).filter((f) => loaded.has(f) && !(f in found));
	expect(stale).toEqual([]);
});

test("the patterns catch what they claim to", () => {
	expect(DEAD.test(code("class A {\n\tasync [Symbol.dispose]() {}\n}"))).toBe(true);
	expect(DEAD.test(code("class A {\n\t// Cordis never calls `[Symbol.dispose]`\n}"))).toBe(false);
	expect(DEAD.test(code("class A {\n\t[Service.stop]() {}\n}"))).toBe(true);
	expect(RESOURCE.test("setInterval(() => {}, 5)") && !MANAGED.test("setInterval(() => {}, 5)")).toBe(true);
	expect(MANAGED.test("this.ctx.effect?.(() => () => {})")).toBe(true);
});
