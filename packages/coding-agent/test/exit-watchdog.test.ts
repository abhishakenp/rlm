import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WATCHDOG = fileURLToPath(new URL("../src/utils/exit-watchdog.ts", import.meta.url));

/** Run a script in a real bun process so process.exit is observed, not mocked. */
const runBun = (script: string, timeoutMs = 15_000) => {
	const started = Date.now();
	const result = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: timeoutMs, env: { ...process.env } });
	return { ...result, elapsedMs: Date.now() - started };
};

describe("exit watchdog", () => {
	it("exits with the intended code when teardown never settles, naming the stuck step", () => {
		const result = runBun(`
			const { armExitWatchdog, exitStep } = await import(${JSON.stringify(WATCHDOG)});
			armExitWatchdog("quit", 7, 300);
			exitStep("session teardown (onShutdown exit)");
			await new Promise(() => {}); // a dispose nobody resolves
			setInterval(() => {}, 1000); // and something keeping the loop alive
		`);
		expect(result.status).toBe(7);
		expect(result.stderr).toContain('stuck');
		expect(result.stderr).toContain('"session teardown (onShutdown exit)"');
		expect(result.elapsedMs).toBeLessThan(10_000);
	});

	it("only the first arm counts, so a later exit path cannot extend the deadline", () => {
		const result = runBun(`
			const { armExitWatchdog } = await import(${JSON.stringify(WATCHDOG)});
			armExitWatchdog("quit", 3, 300);
			armExitWatchdog("quit from agents view", 0, 60_000);
			setInterval(() => {}, 1000);
		`);
		expect(result.status).toBe(3);
		expect(result.stderr).toContain("exit (quit)");
	});

	it("stands down during an execve in place", () => {
		const result = runBun(`
			globalThis.__rlmHostExecing = true;
			const { armExitWatchdog, exitWatchdogArmed } = await import(${JSON.stringify(WATCHDOG)});
			armExitWatchdog("quit", 9, 100);
			await new Promise((r) => setTimeout(r, 400));
			console.log(exitWatchdogArmed() ? "armed" : "not-armed");
		`);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("not-armed");
	});

	it("does nothing when teardown finishes first", () => {
		const result = runBun(`
			const { armExitWatchdog } = await import(${JSON.stringify(WATCHDOG)});
			armExitWatchdog("quit", 5, 2_000);
			await new Promise((r) => setTimeout(r, 50));
			process.exit(0);
		`);
		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain("stuck");
	});
});
