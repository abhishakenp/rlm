import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "bun:jsc";
import { CodeKernelProvisioner } from "../coding-agent/src/core/tools/code.ts";

/**
 * /daemon promotion hands a session's kernel variables to the daemon worker
 * through <artifact dir>/kernel-handover.json (in-process-agents-session.ts);
 * the worker's kernel takes them back once and deletes the file.
 */
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rlm-kernel-handover-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (sessionId: string, vars: Record<string, unknown>) => {
	mkdirSync(dir, { recursive: true });
	const encoded = Object.fromEntries(
		Object.entries(vars).map(([k, v]) => [k, Buffer.from(serialize(v) as ArrayBuffer).toString("base64")]),
	);
	writeFileSync(join(dir, "kernel-handover.json"), JSON.stringify({ v: 1, sessionId, vars: encoded }));
};

describe("kernel handover file", () => {
	it("restores the session's variables once and removes the file", async () => {
		write("s-1", { promoX: 4242, nested: { a: [1, 2] } });
		const kernel = new CodeKernelProvisioner(dir, { sessionId: "s-1", snapshotDir: dir } as never);
		const context = (await kernel.ensure()) as any;
		expect(context.promoX).toBe(4242);
		expect(context.nested).toEqual({ a: [1, 2] });
		expect(existsSync(join(dir, "kernel-handover.json"))).toBe(false);
		await kernel.dispose();
	});

	it("ignores a file written for another session", async () => {
		write("someone-else", { promoX: 1 });
		const kernel = new CodeKernelProvisioner(dir, { sessionId: "s-1", snapshotDir: dir } as never);
		const context = (await kernel.ensure()) as any;
		expect(context.promoX).toBeUndefined();
		await kernel.dispose();
	});
});
