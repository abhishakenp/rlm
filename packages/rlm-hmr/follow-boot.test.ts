/**
 * A headless process applies the change batch broadcast while it booted
 * (before `watchFile` could see it), and ignores one from before it started.
 *
 * Run: bun test packages/rlm-hmr/follow-boot.test.ts
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { follow } from "./src/follow.ts";

const dir = mkdtempSync(join(tmpdir(), "rlm-follow-boot-"));
const src = join(dir, "changed.ts");
writeFileSync(src, "export const x = 1;\n");
const url = pathToFileURL(src).href;
const epochAt = (at: number) => {
	const file = join(dir, `epoch-${at}.json`);
	writeFileSync(file, JSON.stringify({ at, pid: -1, urls: [url] }));
	return file;
};

test("an epoch written during boot is applied at start", async () => {
	const got: string[][] = [];
	const stop = follow((u) => got.push(u), () => true, { file: epochAt(Date.now()), intervalMs: 60_000 });
	await new Promise((r) => setTimeout(r, 50));
	stop();
	expect(got).toEqual([[url]]);
});

test("an epoch from before this process started is not", async () => {
	const got: string[][] = [];
	const bootAt = Date.now() - process.uptime() * 1000;
	const stop = follow((u) => got.push(u), () => true, { file: epochAt(bootAt - 60_000), intervalMs: 60_000 });
	await new Promise((r) => setTimeout(r, 50));
	stop();
	expect(got).toEqual([]);
});
