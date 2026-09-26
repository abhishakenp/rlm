/**
 * A supervisor that crashed must not hold its successor back for proper-lockfile's
 * 5 s mtime staleness: the socket lock records its holder's pid, and a quick
 * acquire breaks the lock of a holder that is gone. Run under bun (the child is
 * a real process): `bunx --bun vitest run test/daemon-socket-dead-holder.test.ts`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDaemonSocketPathLease, daemonSocketLockHolderIsDead } from "../src/modes/daemon/daemon-socket.js";

const moduleUrl = new URL("../src/modes/daemon/daemon-socket.ts", import.meta.url).pathname;
const dirs: string[] = [];

/** A real process that takes the lease, says so, and then waits to be killed. */
async function holdLockInChild(socketPath: string) {
	const child = spawn(
		process.execPath,
		[
			"-e",
			`const m = await import(${JSON.stringify(moduleUrl)}); await m.acquireDaemonSocketPathLease(${JSON.stringify(socketPath)}); console.log("held"); setInterval(() => {}, 1000);`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise<void>((resolve, reject) => {
		child.stdout!.on("data", (chunk) => String(chunk).includes("held") && resolve());
		child.on("exit", (code) => reject(new Error(`holder exited early (${code})`)));
	});
	return child;
}

const killed = (child: ReturnType<typeof spawn>) =>
	new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.kill("SIGKILL");
	});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daemon socket lock after its holder dies", () => {
	it("a quick acquire takes a crashed holder's lock at once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rlm-lock-"));
		dirs.push(dir);
		const socketPath = join(dir, "d.sock");
		const child = await holdLockInChild(socketPath);
		expect(existsSync(`${socketPath}.lock.owner`)).toBe(true);
		expect(daemonSocketLockHolderIsDead(socketPath)).toBe(false);
		await killed(child);
		expect(daemonSocketLockHolderIsDead(socketPath)).toBe(true);
		const started = Date.now();
		const lease = await acquireDaemonSocketPathLease(socketPath, { retries: 0 });
		expect(lease).toBeDefined();
		expect(Date.now() - started).toBeLessThan(1000);
		await lease!.release();
		expect(existsSync(`${socketPath}.lock.owner`)).toBe(false);
	}, 20_000);

	it("without the holder record the lock still waits for staleness (control)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rlm-lock-"));
		dirs.push(dir);
		const socketPath = join(dir, "d.sock");
		const child = await holdLockInChild(socketPath);
		rmSync(`${socketPath}.lock.owner`, { force: true });
		await killed(child);
		await expect(acquireDaemonSocketPathLease(socketPath, { retries: 0 })).rejects.toThrow(/already being held/i);
	}, 20_000);
});
