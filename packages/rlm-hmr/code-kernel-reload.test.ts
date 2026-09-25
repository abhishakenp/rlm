/**
 * A hot reload of the code tool must reach the RUNNING kernel with no gap:
 * same VM context, same variables, a cell already running finishes, and the
 * next cell runs on the module evaluated just now. Driven through the same
 * eviction and class patching the bun reload path uses.
 */
import { describe, expect, test } from "bun:test";
import { patchNamespace } from "./src/bun-reload.ts";

const CODE = new URL("../coding-agent/src/core/tools/code.ts", import.meta.url).pathname;

const reevaluate = async () => {
	const before = (await import(CODE)) as Record<string, unknown>;
	delete (require.cache as Record<string, unknown>)[CODE];
	const after = (await import(CODE)) as Record<string, unknown>;
	patchNamespace(before, after, CODE);
	return after;
};

describe("code kernel across a hot reload of code.ts", () => {
	test("in-flight cell finishes, variables stay, helpers are rebound, no cell fails", async () => {
		const mod = (await import(CODE)) as any;
		const kernel = new mod.CodeKernelProvisioner("/tmp");
		expect((await kernel.execute("var x = 42\nglobalThis.shBefore = sh\n1")).status).toBe("ok");

		const inFlight = kernel.execute("await new Promise((r) => setTimeout(r, 150)); x + 1");
		const t0 = performance.now();
		const next = (await reevaluate()) as any;
		const patchMs = performance.now() - t0;

		const done = await inFlight;
		expect(done.status).toBe("ok");
		expect(done.result).toBe("43");

		const after = await kernel.execute("[x, sh === globalThis.shBefore, typeof sh].join(',')");
		expect(after.status).toBe("ok");
		// Same variable, a NEW `sh` from the module evaluated just now.
		expect(after.result).toBe("42,false,function");

		// A kernel made before the reload is still an instance of the class the
		// process holds, and gets the new methods (update exists and works).
		expect(typeof kernel.update).toBe("function");
		kernel.update({ commandPrefix: "" });
		expect((await kernel.execute("x")).result).toBe("42");

		expect(next.rebindCodeKernels()).toBeGreaterThanOrEqual(1);
		expect(patchMs).toBeLessThan(2000);
		await kernel.dispose();
	});

	test("the rlm.hmr.patched hook rebinds a running kernel before its next cell", async () => {
		const mod = (await import(CODE)) as any;
		const kernel = new mod.CodeKernelProvisioner("/tmp");
		await kernel.execute("var keepMe = 'yes'\nglobalThis.shBefore = sh\n1");
		await reevaluate();
		const hook = kernel[Symbol.for("rlm.hmr.patched")];
		expect(typeof hook).toBe("function");
		hook.call(kernel, { path: CODE });
		const context = (kernel as any).context;
		expect(context.sh).not.toBe(context.shBefore);
		expect(context.keepMe).toBe("yes");
		await kernel.dispose();
		// An ended kernel is left alone.
		expect(() => hook.call(kernel, {})).not.toThrow();
	});

	test("console output of a cell running across the reload stays with that cell", async () => {
		const mod = (await import(CODE)) as any;
		const kernel = new mod.CodeKernelProvisioner("/tmp");
		const inFlight = kernel.execute("await new Promise((r) => setTimeout(r, 150)); console.log('late line'); 1");
		await reevaluate();
		const done = await inFlight;
		expect(done.status).toBe("ok");
		expect(done.stdout).toContain("late line");
		const nextCell = await kernel.execute("2");
		expect(nextCell.stdout).not.toContain("late line");
		await kernel.dispose();
	});
});
