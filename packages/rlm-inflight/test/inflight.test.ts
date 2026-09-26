import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHILD_RESULT_CUSTOM_TYPE,
	INTERRUPTED_CUSTOM_TYPE,
	inboxHasMail,
	readInflight,
	recoverLockPath,
} from "../../coding-agent/src/core/inflight-journal.ts";
import { getSessionArtifactPathForFile, SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { createInflightExtension, finalAnswer, resumeEnv, SPAWNED_ENV } from "../src/index.ts";

const DEAD = 2 ** 22 + 11;
let dir: string;
const sessionFile = (path: string, header: Record<string, unknown>) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ type: "session", ...header })}\n`);
	return path;
};
/** A journal left by a process that is gone. */
const leftBusy = (file: string, busy = true) =>
	writeFileSync(
		`${file}.inflight.json`,
		`${JSON.stringify({ v: 1, sessionFile: file, pid: DEAD, imageId: "gone", open: true, busy, depth: 0, updatedAt: "" })}\n`,
	);

/** A minimal `pi` + ctx that records what the extension does. */
const fakeSession = (file: string, header: Record<string, unknown>, entries: number) => {
	const handlers = new Map<string, (e: any, ctx: any) => void>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi = {
		on: (event: string, h: any) => handlers.set(event, h),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	};
	const ctx = {
		sessionManager: {
			getSessionFile: () => file,
			getHeader: () => ({ type: "session", ...header }),
			getEntries: () => Array.from({ length: entries }, (_, i) => ({ id: String(i) })),
		},
	};
	const fire = (event: string, payload: any = {}) => handlers.get(event)?.({ type: event, ...payload }, ctx);
	return { pi, fire, sent };
};

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "rlm-inflight-")), "sessions");
	mkdirSync(dir, { recursive: true });
	delete process.env[SPAWNED_ENV];
});
afterEach(() => {
	rmSync(join(dir, ".."), { recursive: true, force: true });
	delete process.env[SPAWNED_ENV];
});

describe("rlm-inflight", () => {
	it("an interrupted root wakes itself and resumes its interrupted children, once", () => {
		const root = sessionFile(join(dir, "root.jsonl"), { id: "root" });
		const art = getSessionArtifactPathForFile(root);
		const a = sessionFile(join(art, "sub-a", "a.jsonl"), { id: "a", parentSession: root, rlmDepth: 1 });
		const b = sessionFile(join(art, "sub-b", "b.jsonl"), { id: "b", parentSession: root, rlmDepth: 1 });
		leftBusy(root);
		leftBusy(a);
		leftBusy(b, false); // b had finished — nothing to resume
		const spawned: Array<[string, string]> = [];
		const s = fakeSession(root, { id: "root" }, 5);
		createInflightExtension({ spawner: (f, p) => spawned.push([f, p]), pollMs: 60_000 })(s.pi);
		s.fire("session_start", { reason: "startup" });

		expect(spawned.map(([f]) => f)).toEqual([a]);
		expect(spawned[0][1]).toContain("<rlm_interrupted>");
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0].message.customType).toBe(INTERRUPTED_CUSTOM_TYPE);
		expect(s.sent[0].options.triggerTurn).toBe(true);
		expect(s.sent[0].message.content).toContain("Do not spawn them again");
		expect(readInflight(root)!.pid).toBe(process.pid);
		expect(existsSync(recoverLockPath(root))).toBe(true);

		// A second process opening the same session meanwhile does not recover it again.
		leftBusy(root); // pretend the other process read the same stale record
		const second = fakeSession(root, { id: "root" }, 5);
		const spawned2: string[] = [];
		createInflightExtension({ spawner: (f) => spawned2.push(f), pollMs: 60_000 })(second.pi);
		second.fire("session_start", { reason: "startup" });
		expect(second.sent).toHaveLength(0);
		expect(spawned2).toHaveLength(0);

		// The recovering turn ends: the lock is released and the journal is idle.
		s.fire("agent_start");
		expect(readInflight(root)!.busy).toBe(true);
		s.fire("agent_end", { messages: [assistant("done")] });
		expect(readInflight(root)!.busy).toBe(false);
		expect(existsSync(recoverLockPath(root))).toBe(false);
		s.fire("session_shutdown");
	});

	it("a session that ended idle, or a brand-new one, is left alone", () => {
		const root = sessionFile(join(dir, "root.jsonl"), { id: "root" });
		leftBusy(root, false);
		const s = fakeSession(root, { id: "root" }, 5);
		createInflightExtension({ spawner: () => {}, pollMs: 60_000 })(s.pi);
		s.fire("session_start", { reason: "startup" });
		expect(s.sent).toHaveLength(0);
		s.fire("session_shutdown");

		const fresh = sessionFile(join(dir, "fresh.jsonl"), { id: "fresh" });
		leftBusy(fresh); // even a stale busy record: no entries means nothing to continue
		const f = fakeSession(fresh, { id: "fresh" }, 0);
		createInflightExtension({ spawner: () => {}, pollMs: 60_000 })(f.pi);
		f.fire("session_start", { reason: "startup" });
		expect(f.sent).toHaveLength(0);
		f.fire("session_shutdown");
	});

	it("a child run by a live parent (fresh session) never posts to the parent's inbox", () => {
		const root = sessionFile(join(dir, "root.jsonl"), { id: "root" });
		const child = sessionFile(join(getSessionArtifactPathForFile(root), "sub-c", "c.jsonl"), {
			id: "c",
			parentSession: root,
			rlmDepth: 1,
		});
		const spawned: string[] = [];
		const s = fakeSession(child, { parentSession: root, rlmDepth: 1 }, 0);
		createInflightExtension({ spawner: (f) => spawned.push(f), pollMs: 60_000 })(s.pi);
		s.fire("session_start", { reason: "startup" });
		s.fire("agent_start");
		s.fire("agent_end", { messages: [assistant("child answer")] });
		expect(inboxHasMail(root)).toBe(false);
		expect(spawned).toHaveLength(0);
		s.fire("session_shutdown");
	});

	it("a resumed depth-2 child whose parent is not running revives the parent with the result", () => {
		const root = sessionFile(join(dir, "root.jsonl"), { id: "root" });
		const mid = sessionFile(join(getSessionArtifactPathForFile(root), "sub-m", "m.jsonl"), {
			id: "m",
			parentSession: root,
			rlmDepth: 1,
		});
		const leaf = sessionFile(join(getSessionArtifactPathForFile(mid), "sub-l", "l.jsonl"), {
			id: "l",
			parentSession: mid,
			rlmDepth: 2,
		});
		const spawned: Array<[string, string]> = [];
		const s = fakeSession(leaf, { parentSession: mid, rlmDepth: 2 }, 4);
		createInflightExtension({ spawner: (f, p) => spawned.push([f, p]), pollMs: 60_000 })(s.pi);
		s.fire("session_start", { reason: "resume" });
		s.fire("agent_start");
		s.fire("agent_end", { messages: [assistant("resumed-leaf answer")] });
		expect(spawned).toHaveLength(1);
		expect(spawned[0][0]).toBe(mid);
		expect(spawned[0][1]).toContain("resumed-leaf answer");
		expect(inboxHasMail(mid)).toBe(false); // taken into the revive prompt
		s.fire("session_shutdown");
	});

	it("a resumed child whose parent IS open delivers through the parent's inbox as a message and turn", async () => {
		const root = sessionFile(join(dir, "root.jsonl"), { id: "root" });
		const child = sessionFile(join(getSessionArtifactPathForFile(root), "sub-c", "c.jsonl"), {
			id: "c",
			parentSession: root,
			rlmDepth: 1,
		});
		const parent = fakeSession(root, { id: "root" }, 3);
		createInflightExtension({ spawner: () => {}, pollMs: 20 })(parent.pi);
		parent.fire("session_start", { reason: "startup" });

		const spawned: string[] = [];
		const c = fakeSession(child, { parentSession: root, rlmDepth: 1 }, 3);
		createInflightExtension({ spawner: (f) => spawned.push(f), pollMs: 60_000 })(c.pi);
		c.fire("session_start", { reason: "resume" });
		c.fire("agent_start");
		c.fire("agent_end", { messages: [assistant("result for a live parent")] });
		expect(spawned).toHaveLength(0);

		await new Promise((r) => setTimeout(r, 80));
		expect(parent.sent).toHaveLength(1);
		expect(parent.sent[0].message.customType).toBe(CHILD_RESULT_CUSTOM_TYPE);
		expect(parent.sent[0].message.content).toContain("result for a live parent");
		expect(parent.sent[0].options.triggerTurn).toBe(true);
		c.fire("session_shutdown");
		parent.fire("session_shutdown");
	});

	it("a process spawned to resume a session carries the notice as its prompt and does not wake itself again", () => {
		const root = sessionFile(join(dir, "root.jsonl"), { id: "root" });
		leftBusy(root);
		process.env[SPAWNED_ENV] = root;
		const s = fakeSession(root, { id: "root" }, 5);
		createInflightExtension({ spawner: () => {}, pollMs: 60_000 })(s.pi);
		s.fire("session_start", { reason: "startup" });
		expect(s.sent).toHaveLength(0);
		s.fire("session_shutdown");
	});

	it("resume processes never inherit daemon-worker identity", () => {
		const env = resumeEnv("/s/x.jsonl", { PATH: "/bin", DAEMON_WORKER_ID: "w1", RLM_DAEMON: "1", PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1", PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD: "3", KEEP: "k" });
		expect(env.DAEMON_WORKER_ID).toBeUndefined();
		expect(env.RLM_DAEMON).toBeUndefined();
		expect(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER).toBeUndefined();
		expect(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD).toBeUndefined();
		expect(env.KEEP).toBe("k");
		expect(env[SPAWNED_ENV]).toBe("/s/x.jsonl");
		expect(finalAnswer([assistant("a"), { role: "user", content: "q" }, assistant("  last ")])).toBe("last");
	});
	it("puts a brand-new session's prompt on disk when its first turn starts", async () => {
		// session-manager keeps a session off disk until its first reply; a
		// crash during that first turn used to lose the prompt entirely.
		const manager = SessionManager.create(join(dir, ".."), dir);
		const file = manager.getSessionFile()!;
		const handlers = new Map<string, (e: any, ctx: any) => void>();
		createInflightExtension({ spawner: () => {} })({
			on: (event: string, h: any) => handlers.set(event, h),
			sendMessage: () => {},
		});
		const ctx = { sessionManager: manager };
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		// As in AgentSession: extensions see the prompt's message_end first, then
		// it is appended to the session.
		const prompt = { role: "user", content: "first prompt", timestamp: 1 } as const;
		handlers.get("message_end")?.({ type: "message_end", message: prompt }, ctx);
		manager.appendMessage(prompt);
		expect(existsSync(file)).toBe(true);
		await new Promise((r) => setTimeout(r, 5));
		const lines = require("node:fs").readFileSync(file, "utf8").trim().split("\n").map((l: string) => JSON.parse(l));
		expect(lines.some((e: any) => e.type === "message" && e.message.role === "user")).toBe(true);
		expect(readInflight(file)?.busy).toBe(true);
	});
});
