/**
 * iris-page-opener: results are grouped by type, URLs are handed to
 * agent-browser as one argument each (never through a shell), and provide()
 * hands out `iris.pageOpener`. Run: `bun test packages/iris-page-opener`.
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "iris-page-opener-"));
const log = join(dir, "calls.log");
const fake = join(dir, "agent-browser");
writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\nprintf -- '--\\n' >> "${log}"\n`);
chmodSync(fake, 0o755);
process.env.IRIS_AGENT_BROWSER = fake;

const mod = await import("../src/index.ts");
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("--\n").filter(Boolean).map((c) => c.trim().split("\n")) : []);

test("categorize and extract", () => {
	const results = [
		{ type: "search", url: "https://a" },
		{ type: "document", url: "https://b" },
		{ type: "message", url: "https://c" },
		{ url: "https://d" },
		{ type: "search", url: "" },
	] as any[];
	const c = mod.categorizeResults(results);
	expect(c.search.length).toBe(2);
	expect(c.documents.length).toBe(1);
	expect(c.messages.length).toBe(1);
	expect(c.generic.length).toBe(1);
	expect(mod.extractUrls(results)).toEqual(["https://a", "https://b", "https://c", "https://d"]);
});

test("a hostile URL stays one argument and runs nothing", async () => {
	const marker = join(dir, "pwned");
	const url = `https://x.test/?q=1;touch ${marker};$(touch ${marker})`;
	await mod.openPage(url);
	expect(existsSync(marker)).toBe(false);
	expect(calls().at(-1)).toEqual(["--session", "iris-page-opener", "open", url]);
	await mod.openPage("https://y.test", { headless: true });
	expect(calls().at(-1)).toEqual(["--engine", "lightpanda", "--session", "iris-page-opener", "open", "https://y.test"]);
});

test("provide() hands out iris.pageOpener, which opens grouped results in order", async () => {
	const opener = mod.default.provide().iris.pageOpener;
	expect(Object.keys(opener).sort()).toEqual(["categorizeResults", "extractUrls", "openJobResults", "openPage", "openResults"]);
	const before = calls().length;
	await opener.openJobResults(
		[
			{ type: "message", url: "https://m" },
			{ type: "search", url: "https://s" },
		] as any,
		{ groupByType: true },
	);
	const opened = calls().slice(before).map((c) => c.at(-1));
	expect(opened).toEqual(["https://s", "https://m"]);
});
