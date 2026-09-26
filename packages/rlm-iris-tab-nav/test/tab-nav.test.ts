/**
 * rlm-iris-tab-nav loads (its AppleScript strings were mangled from template
 * literals into broken "…" + n + "…" strings, so the file did not parse), passes
 * the search text to AppleScript as argv instead of splicing it in, and refuses
 * an empty search without running osascript.
 * Run: `bun test packages/rlm-iris-tab-nav`.
 */
import { expect, test } from "bun:test";
import IrisTabNavService from "../src/index.ts";

test("loads, provides irisTabNav", () => {
	expect(IrisTabNavService.provide).toBe("irisTabNav");
});

test("empty search is refused before any AppleScript runs", async () => {
	const svc = Object.create(IrisTabNavService.prototype);
	expect(await svc.findAndSwitchTab("   ")).toEqual({ ok: false, error: "empty search name" });
});

test("search text never reaches the script source", async () => {
	const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
	expect(src).not.toMatch(/"" \+ n \+ ""/);
	expect(src.match(/contains \(item 1 of argv\)/g)?.length).toBe(9);
	expect(src).toContain("osa([app.script], [n], 5000)");
});
