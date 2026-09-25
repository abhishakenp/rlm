import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What loading the agent core pulls in, measured in a real bun process (rlm runs
// under bun; vitest does not). Every session and every daemon worker pays for
// this graph, headless or not, so UI and one-use packages stay out of it.
const runtimeEntry = fileURLToPath(new URL("../src/core/agent-session-runtime.ts", import.meta.url));

const loadedModules = (): string[] => {
	const script = `await import(${JSON.stringify(runtimeEntry)}); console.log(JSON.stringify(Object.keys(require.cache)));`;
	const result = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: 120_000 });
	if (result.status !== 0) throw new Error(`bun probe failed: ${result.stderr}`);
	return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "[]") as string[];
};

const nodeModule = (paths: string[], name: string) =>
	paths.filter((p) => new RegExp(`/node_modules/(\\.bun/[^/]+/node_modules/)?${name}/`).test(p));

describe("agent core import graph", () => {
	const paths = loadedModules();

	it("does not load the TUI package index, its interactive components, or interactive mode", () => {
		// The edit tool's renderer uses Box/Text/Spacer/Container (tui.ts); those are
		// imported by path. Everything else in the TUI stays out.
		expect(paths.filter((p) => p.endsWith("/packages/tui/src/index.ts"))).toEqual([]);
		const allowed = new Set(["box.ts", "spacer.ts", "text.ts", "image.ts"]);
		const components = paths.filter((p) => /\/packages\/tui\/src\/components\//.test(p));
		expect(components.filter((p) => !allowed.has(p.split("/components/")[1]))).toEqual([]);
		expect(paths.filter((p) => p.includes("/modes/interactive/interactive-mode.ts"))).toEqual([]);
	});

	it("does not load packages that are only needed on first use", () => {
		// yaml: Bun.YAML parses frontmatter; diff: first edit; glob: glob manifests; uuid: local v7.
		for (const name of ["yaml", "diff", "glob", "uuid"]) expect(nodeModule(paths, name)).toEqual([]);
	});

	it("stays small", () => {
		// 316 modules before the lazy-loading pass (2026-09-26), 184 after.
		expect(paths.length).toBeLessThan(230);
	});
});
