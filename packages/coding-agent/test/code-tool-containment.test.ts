import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeKernelProvisioner } from "../src/core/tools/code.js";

/**
 * Failure classes taken from ~/.rlm/agent/logs/rlm.jsonl, where the `code`
 * tool is the only tool that fails: EPIPE from a cell's execSync escaping to
 * process scope, a 30s timeout that could run to nearly a minute and left its
 * timer armed, `context.set` on an undefined global, and `Command failed`
 * rejections from a dropped `sh()` landing on the host as unhandledRejection.
 */

const cwd = process.cwd();

function provisioner(options?: Record<string, unknown>) {
	return new CodeKernelProvisioner(cwd, { timeout: 30000, ...(options ?? {}) } as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("code tool — shell output stays inside the cell", () => {
	it("never echoes the child's stderr onto the host's stderr", async () => {
		const kernel = provisioner();
		const hostStderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			hostStderr.push(String(chunk));
			return true;
		}) as never);

		const result = await kernel.execute("execSync('echo boom 1>&2'); 'done';");

		expect(result.status).toBe("ok");
		// Without an explicit stdio, execSync relays the child's stderr through
		// the host's own process.stderr.write. That output never reaches the
		// model, and it is the write that raised EPIPE in production once the
		// host's stderr pipe had no reader left.
		expect(hostStderr.join("")).not.toContain("boom");
	});

	it("survives a host stderr whose reader has gone away", async () => {
		const kernel = provisioner();
		vi.spyOn(process.stderr, "write").mockImplementation((() => {
			// The exact shape Bun throws, recorded at process scope in
			// ~/.rlm/agent/logs/rlm.jsonl as an uncaughtException whose stack ran
			// execSync -> evalmachine.<anonymous>.
			throw new Error("EPIPE: broken pipe, write");
		}) as never);

		const result = await kernel.execute("execSync('echo boom 1>&2'); 'done';");

		expect(result.status).toBe("ok");
		expect(result.result).toContain("done");
	});

	it("still honours an explicit stdio from the cell", async () => {
		const kernel = provisioner();

		const result = await kernel.execute(
			"const out = execSync('echo hi', { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }); console.log('got=' + out.trim());",
		);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("got=hi");
	});
});

describe("code tool — one wall-clock deadline", () => {
	it("does not grant the async phase a second full timeout", async () => {
		const kernel = provisioner({ timeout: 500 });

		// 400ms burned synchronously, then a wait that never finishes. The
		// budget is 500ms in total, so the cell must end at ~500ms — not at
		// 400ms plus a fresh 500ms timer.
		const result = await kernel.execute(
			"const until = Date.now() + 400; while (Date.now() < until) {} await new Promise(r => setTimeout(r, 5000));",
		);

		expect(result.status).toBe("error");
		expect(result.error?.evalue).toContain("Code timeout after 500ms");
		expect(result.durationMs).toBeLessThan(700);
	});

	it("clears the deadline timer when the cell finishes first", async () => {
		const kernel = provisioner({ timeout: 30000 });
		const cleared = vi.spyOn(globalThis, "clearTimeout");

		const result = await kernel.execute("1 + 1");

		expect(result.status).toBe("ok");
		// Promise.race settles on the first outcome but never cancels the
		// loser, so without an explicit clear a one-millisecond cell left a
		// 30-second timer holding the event loop open.
		expect(cleared).toHaveBeenCalled();
	});

	it("says the timed-out cell is still running rather than only that it timed out", async () => {
		const kernel = provisioner({ timeout: 150 });

		const result = await kernel.execute("await new Promise(r => setTimeout(r, 5000));");

		expect(result.status).toBe("error");
		expect(result.error?.evalue).toContain("abandoned, not stopped");
	});

	it("keeps an abandoned cell's late output out of the next cell", async () => {
		const kernel = provisioner({ timeout: 300 });

		// Cell 1 is abandoned at 300ms but prints at 400ms — while cell 2, which
		// runs from ~300ms to ~500ms, is the live cell. Sharing one buffer put
		// that line in cell 2's stdout, which is worse than losing it: cell 2
		// cannot tell it apart from output it produced itself.
		const timedOut = await kernel.execute(
			"await new Promise(r => setTimeout(r, 400)); console.log('LATE-FROM-CELL-1'); await new Promise(r => setTimeout(r, 5000));",
		);
		expect(timedOut.status).toBe("error");

		const next = await kernel.execute(
			"await new Promise(r => setTimeout(r, 200)); console.log('CELL-2');",
		);

		expect(next.status).toBe("ok");
		expect(next.stdout).toContain("CELL-2");
		expect(next.stdout).not.toContain("LATE-FROM-CELL-1");
	});
});

describe("code tool — context global", () => {
	it("explains that the registry is unmounted instead of failing on undefined", async () => {
		const kernel = provisioner();

		const result = await kernel.execute("context.set('iris.fullList', 'x');");

		expect(result.status).toBe("error");
		expect(result.error?.evalue).not.toContain("undefined is not an object");
		expect(result.error?.evalue).toContain("rlm-context");
		expect(result.error?.evalue).toContain("globalThis.<name>");
	});

	it("uses the real registry when one is mounted", async () => {
		const store = new Map<string, unknown>();
		const kernel = provisioner({
			contextProxy: {
				set: (key: string, value: unknown) => {
					store.set(key, value);
					return value;
				},
				get: (key: string) => store.get(key),
			},
		});

		const result = await kernel.execute("context.set('k', 'v'); context.get('k');");

		expect(result.status).toBe("ok");
		expect(store.get("k")).toBe("v");
		expect(result.result).toContain("v");
	});
});

describe("code tool — a dropped sh() cannot fault the host", () => {
	it("does not raise unhandledRejection when a cell never awaits a failing command", async () => {
		const kernel = provisioner();
		const reasons: unknown[] = [];
		const onUnhandled = (reason: unknown) => reasons.push(reason);
		process.on("unhandledRejection", onUnhandled);

		try {
			const result = await kernel.execute("sh('exit 7'); 'started';");
			expect(result.status).toBe("ok");
			await new Promise((resolve) => setTimeout(resolve, 400));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(reasons).toEqual([]);
	});

	it("still throws into a cell that does await the failing command", async () => {
		const kernel = provisioner();

		const result = await kernel.execute("await sh('exit 7');");

		expect(result.status).toBe("error");
		expect(result.error?.evalue).toContain("Command failed");
	});
});

describe("code tool — JSON.parse of a value that is not a string", () => {
	it("names the missing await rather than only the token it choked on", async () => {
		const kernel = provisioner();

		const result = await kernel.execute("JSON.parse(sh('echo hi'));");

		expect(result.status).toBe("error");
		expect(result.error?.evalue).toContain("await");
		expect(result.error?.evalue).toContain("asynchronous");
	});
});

describe("code tool — a subagent spawn the cell never awaits stays in the cell", () => {
	// Six `Agent name "…" is unavailable` rejections in rlm.jsonl on Sep 25 were
	// reported at process scope: a cell fired `rlm.spawn(...)` without awaiting
	// it, the name was taken, and the rejection had no owner.
	const taken = () =>
		provisioner({
			hostHandlers: {
				"rlm.run": async () => {
					throw new Error('Agent name "d2" is unavailable: an agent of that name already exists at depth 1 under this parent');
				},
			},
		});

	for (const method of ["spawn", "run"] as const) {
		it(`does not raise unhandledRejection when rlm.${method} is dropped`, async () => {
			const kernel = taken();
			const reasons: unknown[] = [];
			const onUnhandled = (reason: unknown) => reasons.push(reason);
			process.on("unhandledRejection", onUnhandled);
			try {
				const result = await kernel.execute(`rlm.${method}("task", { name: "d2" }); 'started';`);
				expect(result.status).toBe("ok");
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
			expect(reasons).toEqual([]);
		});

		it(`still throws into a cell that awaits rlm.${method}`, async () => {
			const result = await taken().execute(`await rlm.${method}("task", { name: "d2" });`);
			expect(result.status).toBe("error");
			expect(result.error?.evalue).toContain("already exists");
		});
	}
});
