/**
 * `adopt` / `hotData` / `adoptInterval` on real Cordis fibers.
 *
 * Run: bun test packages/rlm-hmr/hot.test.ts
 */
import { expect, test } from "bun:test";
import { adopt, adoptInterval, hotData, isHeld } from "./src/hot.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mount = async (apply: (ctx: any) => void) => {
	const { Context } = await import("@deepseek-ai/cordis");
	const root: any = new Context();
	const fiber = root.plugin({ apply });
	await fiber.await?.();
	return { root, fiber };
};

test("a swap (dispose, then a successor) keeps the same resource and never releases it", async () => {
	const released: string[] = [];
	let created = 0;
	const make = () => ({ id: ++created });
	const seen: any[] = [];
	const a = await mount((ctx) => { seen.push(adopt(ctx, "t:swap", make, () => released.push("a"), 100)); });
	await a.fiber.dispose();
	const b = await mount((ctx) => { seen.push(adopt(ctx, "t:swap", make, () => released.push("b"), 100)); });
	await wait(250);
	expect(created).toBe(1);
	expect(seen[0]).toBe(seen[1]);
	expect(released).toEqual([]);
	// Removed for real: released once, with the newest release function.
	await b.fiber.dispose();
	await wait(250);
	expect(released).toEqual(["b"]);
	expect(isHeld("t:swap")).toBe(false);
});

test("hotData is one object per key across generations", () => {
	const d1 = hotData<{ n?: number }>("t:data");
	d1.n = 7;
	expect(hotData<{ n?: number }>("t:data").n).toBe(7);
});

test("adoptInterval keeps one timer and calls the newest tick", async () => {
	const calls: string[] = [];
	const a = await mount((ctx) => { adoptInterval(ctx, "t:interval", 20, () => calls.push("old")); });
	await wait(70);
	await a.fiber.dispose();
	const b = await mount((ctx) => { adoptInterval(ctx, "t:interval", 20, () => calls.push("new")); });
	calls.length = 0;
	await wait(70);
	expect(calls.length).toBeGreaterThan(0);
	expect(calls.every((c) => c === "new")).toBe(true);
	await b.fiber.dispose();
	await wait(3100);
	calls.length = 0;
	await wait(60);
	expect(calls).toEqual([]);
});
