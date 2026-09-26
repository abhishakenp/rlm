/**
 * iris keep's ignore rule, as its header describes: dotfiles, `~`, .swp,
 * *.<pid>.tmp, *.test/*.spec (.ts/.js) and test/ __tests__/ tests/ dirs.
 * Run: `bun test packages/iris-keep`.
 */
import { expect, test } from "bun:test";
import { ignored } from "../src/baseline.ts";

test("ignored", () => {
	for (const p of [".env", "a~", "~/x", "x.swp", "file.12345.tmp", "a.test.ts", "b.spec.js", "test/x.ts", "__tests__/y.js", "tests/z.ts", "src\\a.test.ts"]) {
		expect(ignored(p)).toBe(true);
	}
	for (const p of ["src/index.ts", "latest.ts", "contest.js", "src/protest.ts", "notatestXts", "file.tmp", "src/test/x.ts", "tsconfig.json"]) {
		expect(ignored(p)).toBe(false);
	}
});
