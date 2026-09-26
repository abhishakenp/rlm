/**
 * The `olympus` mode: claimed by `rlm olympus …`, dispatched to tools/, removed
 * when the row goes away (ctx.effect is the only disposer Cordis calls).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { runOlympus } from "../src/cli.ts";
import RlmOlympusService from "../src/index.ts";

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
	const log = console.log;
	const err = console.error;
	console.log = () => {};
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.log = log;
		console.error = err;
	}
};

describe("runOlympus", () => {
	test("status and help exit 0", async () => {
		expect(await quiet(() => runOlympus([]))).toBe(0);
		expect(await quiet(() => runOlympus(["status"]))).toBe(0);
	});

	test("an unknown command exits 2", async () => {
		expect(await quiet(() => runOlympus(["nope"]))).toBe(2);
	});

	test("submit without a dir is usage; with an empty candidate it refuses", async () => {
		expect(await quiet(() => runOlympus(["submit"]))).toBe(2);
		const empty = mkdtempSync(join(tmpdir(), "oly-"));
		expect(await quiet(() => runOlympus(["submit", empty]))).toBe(1);
	});
});

describe("row", () => {
	test("registers `olympus` with rlmModes and removes it on dispose", async () => {
		const registered: any[] = [];
		const root = new Context();
		root.provide("rlmModes");
		(root as any).rlmModes = {
			register(mode: any) {
				registered.push(mode);
				return { dispose: () => registered.splice(registered.indexOf(mode), 1) };
			},
		};
		const fiber = root.plugin(RlmOlympusService as any);
		await (fiber as any).await?.();
		expect(registered.map((m) => m.id)).toEqual(["olympus"]);
		expect(registered[0].claims(["olympus", "status"])).toBe(true);
		expect(registered[0].claims(["tasks"])).toBe(false);
		await (fiber as any).dispose();
		expect(registered).toEqual([]);
	});
});
