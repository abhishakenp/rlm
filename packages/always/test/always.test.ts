/**
 * The Always row against a fake daemon (a real Unix socket speaking the daemon's
 * `{type,data}` JSON lines) and a fake focused-editable helper (a shell script).
 * Nothing here touches the real Always app, its socket, or the microphone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { AlwaysEventClient } from "../src/event-client.ts";
import { FocusWatcher } from "../src/focus-watcher.ts";
import Always from "../src/index.ts";
import { eligibleToOwn, OwnerLease } from "../src/owner.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await sleep(20);
	return cond();
};

/** A fake Always daemon: records commands, lets the test push events. */
class FakeDaemon {
	server: Server;
	clients: Socket[] = [];
	commands: Array<{ type: string; data: any }> = [];
	constructor(readonly path: string) {
		this.server = createServer((sock) => {
			this.clients.push(sock);
			sock.setEncoding("utf8");
			let buf = "";
			sock.on("data", (chunk: string) => {
				buf += chunk;
				let nl: number;
				while ((nl = buf.indexOf("\n")) !== -1) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line.trim()) this.commands.push(JSON.parse(line));
				}
			});
			sock.on("close", () => (this.clients = this.clients.filter((c) => c !== sock)));
		});
	}
	listen = () => new Promise<void>((r) => this.server.listen(this.path, r));
	send(evt: { type: string; data?: any }) {
		for (const c of this.clients) c.write(`${JSON.stringify(evt)}\n`);
	}
	consume = () => this.commands.filter((c) => c.type === "SetConsumeMode").map((c) => c.data.enabled);
	close = () => new Promise<void>((r) => this.server.close(() => r()));
}

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "always-test-"));
	// The owner lease lives under RLM_HOME; never the real ~/.rlm.
	process.env.RLM_HOME = join(dir, "rlm-home");
	delete process.env.RLM_HEADLESS;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AlwaysEventClient", () => {
	test("routes finals only in consume mode; tracks whitelist; wake word redirects; stop hands dictation back", async () => {
		const daemon = new FakeDaemon(join(dir, "c1.sock"));
		await daemon.listen();
		const events: any[] = [];
		const c = new AlwaysEventClient({ path: daemon.path, consumeMode: true, reconnectMs: 50, onEvent: (e) => events.push(e) });
		c.start();
		expect(await until(() => daemon.clients.length === 1)).toBe(true);
		// On connect the asserted state is unknown, so the resting mode is re-sent, plus the pause state.
		expect(await until(() => daemon.consume().length === 1)).toBe(true);
		expect(daemon.consume()).toEqual([true]);
		expect(daemon.commands.some((x) => x.type === "SetPaused" && x.data.paused === false)).toBe(true);

		daemon.send({ type: "TranscriptChunk", data: { text: "open safari" } });
		daemon.send({ type: "TranscriptFinal", data: { text: "open safari" } });
		expect(await until(() => events.length === 2)).toBe(true);
		expect(events).toEqual([
			{ type: "partial", text: "open safari" },
			{ type: "final", text: "open safari" },
		]);

		daemon.send({ type: "ResumedAppsChanged", data: { bundles: ["com.apple.Notes"] } });
		expect(await until(() => c.dictationAllowedFor("com.apple.Notes"))).toBe(true);
		expect(c.dictationAllowedFor("com.other")).toBe(false);

		// Dictating: plain speech is Always's to paste, not forwarded.
		c.setConsumeMode(false);
		events.length = 0;
		daemon.send({ type: "TranscriptFinal", data: { text: "dear diary" } });
		await sleep(100);
		expect(events).toEqual([]);

		// A wake-word-led partial flips consume ON for that utterance, then back.
		daemon.send({ type: "TranscriptChunk", data: { text: "Iris, what time" } });
		daemon.send({ type: "TranscriptFinal", data: { text: "Iris, what time is it" } });
		expect(await until(() => events.some((e) => e.type === "final"))).toBe(true);
		expect(await until(() => daemon.consume().slice(-3).join() === "false,true,false")).toBe(true);

		// Batch engines: the wake word first appears in the final — still forwarded.
		events.length = 0;
		daemon.send({ type: "TranscriptFinal", data: { text: "iris lock the screen" } });
		expect(await until(() => events.length === 1)).toBe(true);
		expect(events[0]).toEqual({ type: "final", text: "iris lock the screen" });

		c.setConsumeMode(true);
		c.stop();
		expect(await until(() => daemon.consume().at(-1) === false)).toBe(true);
		await daemon.close();
	});

	test("reconnects after the daemon restarts and asks the owner to recompute", async () => {
		const path = join(dir, "c2.sock");
		let daemon = new FakeDaemon(path);
		await daemon.listen();
		let reconnects = 0;
		const c = new AlwaysEventClient({ path, reconnectMs: 50, onReconnect: () => reconnects++ });
		c.start();
		expect(await until(() => reconnects === 1)).toBe(true);
		for (const s of daemon.clients) s.destroy();
		await daemon.close();
		daemon = new FakeDaemon(path);
		await daemon.listen();
		expect(await until(() => reconnects === 2)).toBe(true);
		c.stop();
		await daemon.close();
	});
});

describe("FocusWatcher", () => {
	test("dedupes on routing fields and ignores garbage", () => {
		const seen: any[] = [];
		const w = new FocusWatcher({ binPath: "/nonexistent", onChange: (s) => seen.push(s) });
		w.handleLine('{"editable":true,"trusted":true,"bundleId":"a","role":"AXTextField"}');
		w.handleLine('{"editable":true,"trusted":true,"bundleId":"a","role":"AXTextArea"}');
		w.handleLine("not json");
		w.handleLine('{"editable":true,"trusted":true,"bundleId":"b"}');
		expect(seen.map((s) => s.bundleId)).toEqual(["a", "b"]);
	});

	test("spawns the helper with --watch and reports its lines", async () => {
		const bin = join(dir, "focused-editable");
		writeFileSync(bin, `#!/bin/sh\necho "{\\"editable\\":true,\\"trusted\\":true,\\"bundleId\\":\\"$1-$2\\"}"\nsleep 5\n`);
		chmodSync(bin, 0o755);
		const seen: any[] = [];
		const w = new FocusWatcher({ binPath: bin, intervalMs: 120, onChange: (s) => seen.push(s) });
		w.start();
		expect(await until(() => seen.length === 1)).toBe(true);
		expect(seen[0].bundleId).toBe("--watch-120");
		w.stop();
	});

	test("reports a missing helper instead of throwing", () => {
		const errs: Error[] = [];
		new FocusWatcher({ binPath: join(dir, "nope"), onError: (e) => errs.push(e) }).start();
		expect(errs[0]?.message).toContain("focused-editable not found");
	});
});

describe("Always row", () => {
	test("routes by focus + whitelist, delivers Iris speech, and keeps the socket across a swap", async () => {
		const daemon = new FakeDaemon(join(dir, "row.sock"));
		await daemon.listen();
		const fifoBin = join(dir, "focus-row");
		const focusFile = join(dir, "focus.jsonl");
		writeFileSync(focusFile, "");
		// The fake helper tails a file the test appends focus states to.
		writeFileSync(fifoBin, `#!/bin/sh\nexec tail -n +1 -f "${focusFile}"\n`);
		chmodSync(fifoBin, 0o755);
		const pushFocus = (s: object) => writeFileSync(focusFile, `${JSON.stringify(s)}\n`, { flag: "a" });

		const root: any = new Context();
		const config = { socketPath: daemon.path, focusBin: fifoBin, startDaemon: false, focusIntervalMs: 100 };
		const fiber = root.plugin(Always, config);
		expect(await until(() => !!root.always && daemon.clients.length === 1)).toBe(true);
		const got: any[] = [];
		root.always.onTranscript((t: any) => got.push(t));

		daemon.send({ type: "ResumedAppsChanged", data: { bundles: ["com.apple.Notes"] } });
		await sleep(50);
		pushFocus({ editable: true, trusted: true, bundleId: "com.apple.Notes" });
		expect(await until(() => daemon.consume().at(-1) === false)).toBe(true);
		expect(root.always.mode).toBe("dictate");

		// Editable, but in an app Always may not dictate into → Iris.
		pushFocus({ editable: true, trusted: true, bundleId: "com.slack" });
		expect(await until(() => daemon.consume().at(-1) === true)).toBe(true);
		expect(root.always.mode).toBe("listen");

		daemon.send({ type: "TranscriptFinal", data: { text: "summarise my day" } });
		expect(await until(() => got.length === 1)).toBe(true);
		expect(got[0]).toMatchObject({ text: "summarise my day", partial: false, source: "always" });

		// Hot swap: dispose + remount with the same config keeps the SAME connection.
		const before = daemon.clients[0];
		fiber.dispose();
		root.plugin(Always, config);
		await sleep(300);
		expect(daemon.clients.length).toBe(1);
		expect(daemon.clients[0]).toBe(before);

		// Untrusted (no Accessibility) → plain dictation.
		pushFocus({ editable: false, trusted: false, bundleId: "com.slack" });
		expect(await until(() => daemon.consume().at(-1) === false)).toBe(true);

		for (const c of daemon.clients) c.destroy();
		await daemon.close();
	}, 15_000);
});

describe("one owner per machine", () => {
	test("a second lease cannot take a live holder; it takes over once released", async () => {
		const leaseDir = join(dir, "lease-a");
		const a = new OwnerLease(leaseDir);
		const b = new OwnerLease(leaseDir);
		expect(await a.tryAcquire(10)).toBe(true);
		expect(await b.tryAcquire(10)).toBe(false);
		a.release();
		expect(await b.tryAcquire(10)).toBe(true);
		expect(a.holds()).toBe(false);
		b.release();
	});

	test("a holder whose process is gone is stale and replaced", async () => {
		const leaseDir = join(dir, "lease-b");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(leaseDir, { recursive: true });
		// pid 1 is launchd: alive, but a different start time → not the recorded holder.
		writeFileSync(join(leaseDir, "owner.json"), JSON.stringify({ pid: 1, start: "Thu Jan  1 00:00:00 1970", token: "ghost" }));
		const b = new OwnerLease(leaseDir);
		expect(await b.tryAcquire(10)).toBe(true);
		b.release();
	});

	test("headless runs, delegate children and daemon workers never drive Always", () => {
		expect(eligibleToOwn({}, ["bun", "cordis-shell.mjs"])).toBe(true);
		expect(eligibleToOwn({ RLM_HEADLESS: "1" }, [])).toBe(false);
		expect(eligibleToOwn({ RLM_DELEGATE_CHILD: "1" }, [])).toBe(false);
		expect(eligibleToOwn({ PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1" }, [])).toBe(false);
		expect(eligibleToOwn({}, ["bun", "cordis-shell.mjs", "--pool-worker"])).toBe(false);
	});

	test("an ineligible process mounts the row without touching the daemon", async () => {
		const daemon = new FakeDaemon(join(dir, "idle.sock"));
		await daemon.listen();
		process.env.RLM_HEADLESS = "1";
		try {
			const root: any = new Context();
			root.plugin(Always, { socketPath: daemon.path, startDaemon: false, focusBin: join(dir, "nope") });
			expect(await until(() => !!root.always)).toBe(true);
			await sleep(300);
			expect(daemon.clients.length).toBe(0);
			expect(root.always.daemonConnected).toBe(false);
		} finally {
			delete process.env.RLM_HEADLESS;
			await daemon.close();
		}
	});
});
