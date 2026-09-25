/**
 * rlm-host shell: argv rewriting for execve, headless detection, error cause
 * chains, the kernel variable snapshot, and the reload chain itself (a copy of
 * src/ in a temp dir, so the live host directory is never touched).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, headlessInvocation, snapshotKernels, withAgentsView, withResume } from "./src/shell.ts";

describe("argv for the next image", () => {
	test("--resume <current file> replaces every session flag", () => {
		expect(withResume(["-r", "--model", "x/y"], "/s/a.jsonl")).toEqual(["--model", "x/y", "--resume", "/s/a.jsonl"]);
		expect(withResume(["--resume", "old", "-c"], "/s/a.jsonl")).toEqual(["--resume", "/s/a.jsonl"]);
		expect(withResume(["--resume=old"], "/s/a.jsonl")).toEqual(["--resume", "/s/a.jsonl"]);
		expect(withResume(["--session-dir", "/d", "-c"], "/s/a.jsonl")).toEqual(["--session-dir", "/d", "--resume", "/s/a.jsonl"]);
	});
	test("no session file known → argv unchanged", () => {
		expect(withResume(["-r"], undefined)).toEqual(["-r"]);
	});
	test("agents view: session flags stripped, bare -r appended", () => {
		expect(withAgentsView(["--resume", "/s/a.jsonl", "--model", "m"])).toEqual(["--model", "m", "-r"]);
		expect(withAgentsView(["-r"])).toEqual(["-r"]);
		expect(withAgentsView([])).toEqual(["-r"]);
	});
});

describe("headless invocations", () => {
	test("pool worker and delegate verbs are headless", () => {
		expect(headlessInvocation(["--headless", "--pool-worker", "--slots", "1"])).toBe(true);
		expect(headlessInvocation(["drive", "status"])).toBe(true);
		expect(headlessInvocation(["--headless", "drive"])).toBe(true);
		expect(headlessInvocation(["tasks"])).toBe(true);
	});
	test("--print is headless", () => {
		expect(headlessInvocation(["--print", "hi"])).toBe(true);
	});
});

describe("describeError", () => {
	test("walks the cause chain", () => {
		const e = new Error("outer", { cause: new Error("middle", { cause: new Error("the real reason") }) });
		const text = describeError(e);
		expect(text).toContain("outer");
		expect(text).toContain("caused by: Error: middle");
		expect(text).toContain("the real reason");
	});
	test("bounded depth", () => {
		let e: any = new Error("leaf");
		for (let i = 0; i < 20; i++) e = new Error(`level ${i}`, { cause: e });
		expect(describeError(e).match(/caused by:/g)!.length).toBe(5);
	});
});

describe("kernel variable snapshot", () => {
	test("clonable user variables per session; functions and uncloneables skipped", async () => {
		const context: Record<string, unknown> = { n: 42, obj: { a: [1, 2] }, fn: () => 1, sym: Symbol("x") };
		const kernel = {
			context,
			options: { sessionId: "sess-1" },
			listNamespaceNames: async () => Object.keys(context),
		};
		const g = globalThis as any;
		const saved = g.__rlmHmrLive;
		g.__rlmHmrLive = new Set([new WeakRef(kernel)]);
		try {
			const snap = await snapshotKernels();
			expect(Object.keys(snap)).toEqual(["sess-1"]);
			expect(Object.keys(snap["sess-1"]!).sort()).toEqual(["n", "obj"]);
			const { deserialize } = await import("bun:jsc" as string);
			expect(deserialize(Buffer.from(snap["sess-1"]!.obj!, "base64"))).toEqual({ a: [1, 2] });
		} finally {
			g.__rlmHmrLive = saved;
		}
	});
});

describe("reload chain (copy of src/ in a temp dir)", () => {
	const dir = mkdtempSync(join(tmpdir(), "rlm-host-test-"));
	cpSync(join(import.meta.dir, "src"), join(dir, "src"), { recursive: true });
	const shell = join(dir, "src", "shell.ts");
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("every edit swaps; a syntax error is refused; a no-op save is not a reload", async () => {
		const swaps: number[] = [];
		const warnings: string[] = [];
		const host: any = { root: dir, bootstrap: join(dir, "boot.mjs"), generation: 0, onSwap: (g: number) => swaps.push(g) };
		const g = globalThis as any;
		const savedHost = g.__rlmHost;
		const savedLog = g.__rlmLog;
		g.__rlmHost = host;
		g.__rlmLog = (level: string, _scope: string, text: string) => {
			if (level === "warn") warnings.push(text);
		};
		const settle = () => new Promise((r) => setTimeout(r, 700));
		try {
			const m = await import(shell);
			await m.adopt(host); // gen 1, installs the watcher
			const original = readFileSync(shell, "utf8");

			appendFileSync(shell, "\n// edit A\n");
			await settle();
			appendFileSync(shell, "\n// edit B\n");
			await settle();
			expect(swaps).toEqual([1, 2, 3]);

			appendFileSync(shell, "\nconst broken = ;\n");
			await settle();
			expect(swaps).toEqual([1, 2, 3]);
			expect(warnings.some((w) => w.includes("does not parse"))).toBe(true);

			writeFileSync(shell, `${original}\n// edit C\n`);
			await settle();
			expect(swaps).toEqual([1, 2, 3, 4]);

			// Same bytes again: no reload.
			writeFileSync(shell, `${original}\n// edit C\n`);
			await settle();
			expect(swaps).toEqual([1, 2, 3, 4]);
		} finally {
			host.selfWatch?.close();
			g.__rlmHost = savedHost;
			g.__rlmLog = savedLog;
		}
	}, 20_000);
});
