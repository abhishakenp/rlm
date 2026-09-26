/**
 * :20130 moves between processes without refusing a connection. The row binds
 * with SO_REUSEPORT (through node:net — Bun's node:http ignores the flag), so
 * the daemon supervisor can bind beside an rlm that already serves the port and
 * take over at once; an ordinary second rlm sees the port answering and stays
 * idle instead of stealing it.
 * Run: `bun test packages/rlm-integration/test/takeover.test.ts`.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = join(import.meta.dir, "fixtures", "mount.ts");
const spawnRow = (port: number, lifeMs: number, supervisor = false) =>
	Bun.spawn(["bun", fixture, ...(supervisor ? ["--mode", "daemon"] : [])], {
		env: { ...process.env, PORT: String(port), LIFE_MS: String(lifeMs) },
		stdout: "pipe",
		stderr: "ignore",
	});
const firstLine = async (proc: ReturnType<typeof spawnRow>) => {
	const reader = proc.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	return JSON.parse(text.split("\n")[0]!) as { running: boolean };
};

test("the supervisor takes the port over with zero failed requests", async () => {
	const port = 24000 + Math.floor(Math.random() * 4000);
	const owner = spawnRow(port, 2500);
	expect((await firstLine(owner)).running).toBe(true);
	let ok = 0;
	let failed = 0;
	let running = true;
	const hammer = (async () => {
		while (running) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/health`);
				response.status === 200 ? ok++ : failed++;
			} catch {
				failed++;
			}
			await Bun.sleep(50);
		}
	})();
	await Bun.sleep(300);
	const supervisor = spawnRow(port, 6000, true);
	expect((await firstLine(supervisor)).running).toBe(true);
	await owner.exited; // the old owner is gone; the supervisor alone serves now
	await Bun.sleep(1500);
	running = false;
	await hammer;
	supervisor.kill();
	expect(failed).toBe(0);
	expect(ok).toBeGreaterThan(40);
}, 30_000);

test("a second ordinary rlm stays idle while the port is served", async () => {
	const port = 24000 + Math.floor(Math.random() * 4000);
	const first = spawnRow(port, 3000);
	expect((await firstLine(first)).running).toBe(true);
	const second = spawnRow(port, 3000);
	expect((await firstLine(second)).running).toBe(false);
	first.kill();
	second.kill();
}, 30_000);
