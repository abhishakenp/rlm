import { describe, expect, it } from "vitest";
import { CodeKernelProvisioner } from "../src/core/tools/code.js";

/**
 * The refine skill, the rlm-refine prompt fragment and the rlm prompt all tell
 * the model to call `await refine.run(...)` from a cell. The session built the
 * `refine.run` / `refine.status` handlers, but the JS kernel never exposed them,
 * so the call was a ReferenceError and no explicit lesson — local or global —
 * could be recorded from a cell.
 */

const kernelWith = (calls: Array<Record<string, unknown>>) =>
	new CodeKernelProvisioner(process.cwd(), {
		timeout: 30000,
		hostHandlers: {
			"refine.run": async (payload: Record<string, unknown>) => {
				calls.push(payload);
				return { scheduled: true };
			},
			"refine.status": async () => ({ pending: calls.length > 0, in_flight: false }),
		},
	} as never);

describe("code tool — refine is reachable from a cell", () => {
	it("schedules a local refinement with instructions", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const result = await kernelWith(calls).execute(`JSON.stringify(await refine.run("remember X"))`);
		expect(result.status).toBe("ok");
		expect(calls).toEqual([{ instructions: "remember X" }]);
	});

	it.each([
		["{ global: true }", "{ global: true }"],
		["{ global_: true } (the old Python spelling)", "{ global_: true }"],
		["a bare true", "true"],
	])("passes global for %s", async (_label, opts) => {
		const calls: Array<Record<string, unknown>> = [];
		const result = await kernelWith(calls).execute(`await refine.run("durable lesson", ${opts}); 'ok'`);
		expect(result.status).toBe("ok");
		expect(calls).toEqual([{ instructions: "durable lesson", global: true }]);
	});

	it("runs with no arguments and reports status", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const result = await kernelWith(calls).execute(
			`await refine.run(); JSON.stringify(await refine.status())`,
		);
		expect(result.status).toBe("ok");
		expect(calls).toEqual([{}]);
		expect(JSON.stringify(result)).toContain("pending");
	});

	it("is undefined when the session does not allow refinement", async () => {
		const kernel = new CodeKernelProvisioner(process.cwd(), { timeout: 30000, hostHandlers: {} } as never);
		const result = await kernel.execute(`typeof refine`);
		expect(result.status).toBe("ok");
		expect(JSON.stringify(result)).toContain("undefined");
	});
});
