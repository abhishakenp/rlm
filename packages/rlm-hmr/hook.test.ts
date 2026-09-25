/**
 * HMR_PATCHED: live objects re-derive init-time state after a patch pass, and
 * unwatched processes follow broadcast batches. See ./src/bun-reload.ts and
 * ./src/follow.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HMR_PATCHED, notifyPatched, patchNamespace, registerLive } from "./src/bun-reload.ts";
import { follow } from "./src/follow.ts";

const dir = mkdtempSync(join(tmpdir(), "rlm-hmr-hook-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HMR_PATCHED dispatch", () => {
	test("a provided service built by the old class re-derives with the new code", async () => {
		class V1 {
			list = ["a", "cordis.yml"];
		}
		class V2 {
			list = ["a"];
			fresh?: boolean;
			[HMR_PATCHED]() {
				this.list = ["a"];
				this.fresh = true; // a field V1 never had: the hook must still run
			}
		}
		const path = join(dir, "svc.ts");
		patchNamespace({}, { Svc: V1 }, path);
		const live = new V1() as any;
		patchNamespace({ Svc: V1 }, { Svc: V2 }, path);
		const ctx = { reflect: { store: { [Symbol("svc")]: { value: live } } } };
		const done = await notifyPatched(ctx, [path]);
		expect(done).toEqual(["V1"]);
		expect(live.list).toEqual(["a"]);
		expect(live.fresh).toBe(true);
	});

	test("a second edit that adds a field still runs the NEW hook on an old instance", async () => {
		class G1 {}
		class G2 {
			v = 2;
			[HMR_PATCHED]() {
				(this as any).seen = "v2";
			}
		}
		class G3 {
			v = 3;
			extra?: number;
			[HMR_PATCHED]() {
				(this as any).seen = "v3";
				this.extra = 1; // G3's new field: the hook is what sets it up
			}
		}
		const path = join(dir, "gen.ts");
		patchNamespace({}, { G: G1 }, path);
		const live = new G1() as any;
		patchNamespace({ G: G1 }, { G: G2 }, path);
		patchNamespace({ G: G2 }, { G: G3 }, path);
		await notifyPatched({ reflect: { store: { [Symbol("g")]: { value: live } } } }, [path]);
		expect(live.seen).toBe("v3");
		expect(live.extra).toBe(1);
	});

	test("objects of unrelated classes are not called; opted-in objects are", async () => {
		class Other {
			calls = 0;
			[HMR_PATCHED]() {
				this.calls++;
			}
		}
		class K1 {}
		class K2 {
			calls = 0;
			[HMR_PATCHED]() {
				(this as any).calls = ((this as any).calls ?? 0) + 1;
			}
		}
		const path = join(dir, "kernel.ts");
		patchNamespace({}, { K: K1 }, path);
		const kernel = new K1() as any;
		registerLive(kernel);
		const other = new Other();
		patchNamespace({ K: K1 }, { K: K2 }, path);
		const done = await notifyPatched({ reflect: { store: { [Symbol("o")]: { value: other } } } }, [path]);
		expect(done).toEqual(["K1"]);
		expect(kernel.calls).toBe(1);
		expect(other.calls).toBe(0);
	});

	test("a throwing hook is reported, not fatal", async () => {
		class T1 {}
		class T2 {
			[HMR_PATCHED]() {
				throw new Error("boom");
			}
		}
		const path = join(dir, "throw.ts");
		patchNamespace({}, { T: T1 }, path);
		const live = new T1();
		patchNamespace({ T: T1 }, { T: T2 }, path);
		const done = await notifyPatched({ reflect: { store: { [Symbol("t")]: { value: live } } } }, [path]);
		expect(done).toEqual(["T1: boom"]);
	});
});

describe("follow: unwatched processes reload what a watched one broadcast", () => {
	test("new content is delivered once; the same save is not delivered twice; inactive ignores", async () => {
		const epoch = join(dir, "epoch.json");
		const src = join(dir, "a.ts");
		writeFileSync(src, "export const a = 1;\n");
		const url = pathToFileURL(src).href;
		const got: string[][] = [];
		let active = true;
		const stop = follow((u) => got.push(u), () => active, { file: epoch, intervalMs: 20 });
		const write = (pid: number) => writeFileSync(epoch, JSON.stringify({ at: Date.now(), pid, urls: [url] }));
		try {
			write(process.pid + 1);
			await sleep(120);
			expect(got).toEqual([[url]]);
			write(process.pid + 2); // a second watched process broadcasting the same save
			await sleep(120);
			expect(got.length).toBe(1);
			const later = new Date(Date.now() + 5000);
			utimesSync(src, later, later); // a new save
			write(process.pid + 1);
			await sleep(120);
			expect(got.length).toBe(2);
			write(process.pid); // our own broadcast
			utimesSync(src, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
			await sleep(120);
			expect(got.length).toBe(2);
			active = false; // watched processes ignore the file
			write(process.pid + 1);
			await sleep(120);
			expect(got.length).toBe(2);
		} finally {
			stop();
		}
	});
});
