import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	childResultText,
	claimRecovery,
	interruptedChildren,
	interruptedNotice,
	isLive,
	listChildSessions,
	type OwnerProbe,
	postToInbox,
	readInflight,
	releaseRecovery,
	takeInbox,
	wasInterrupted,
	writeInflight,
} from "../src/core/inflight-journal.js";
import { getSessionArtifactPathForFile } from "../src/core/session-manager.js";

const DEAD_PID = 2 ** 22 + 7;
const dead: OwnerProbe = { isAlive: () => false, startIdOf: () => undefined };

let dir: string;
const session = (file: string, header: Record<string, unknown>) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ type: "session", ...header })}\n`);
	return file;
};
/** A record as a process other than this one would have left it. */
const foreign = (file: string, busy: boolean, open = true) =>
	writeFileSync(
		`${file}.inflight.json`,
		`${JSON.stringify({ v: 1, sessionFile: file, pid: DEAD_PID, startId: "x", imageId: "other", open, busy, depth: 0, updatedAt: "" })}\n`,
	);

beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "inflight-")), "sessions");
	mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("inflight journal", () => {
	it("reads back what it wrote, and this process is its own live owner", () => {
		const file = session(join(dir, "root.jsonl"), { id: "root" });
		writeInflight(file, { open: true, busy: true, depth: 0 });
		const record = readInflight(file)!;
		expect(record.pid).toBe(process.pid);
		expect(record.busy).toBe(true);
		expect(wasInterrupted(record)).toBe(false);
		expect(isLive(file)).toBe(true);
	});

	it("a busy record whose process is gone is an interrupted turn; an idle one is not", () => {
		const file = session(join(dir, "root.jsonl"), { id: "root" });
		foreign(file, true);
		expect(wasInterrupted(readInflight(file), dead)).toBe(true);
		foreign(file, false);
		expect(wasInterrupted(readInflight(file), dead)).toBe(false);
	});

	it("a recycled pid (same pid, different start id) is not the owner", () => {
		const file = session(join(dir, "root.jsonl"), { id: "root" });
		foreign(file, true);
		const recycled: OwnerProbe = { isAlive: () => true, startIdOf: () => "someone-else" };
		expect(wasInterrupted(readInflight(file), recycled)).toBe(true);
		const same: OwnerProbe = { isAlive: () => true, startIdOf: () => "x" };
		expect(wasInterrupted(readInflight(file), same)).toBe(false);
	});

	it("a record from an earlier image of this same pid (execve) reads as a dead owner", () => {
		const file = session(join(dir, "root.jsonl"), { id: "root" });
		writeFileSync(
			`${file}.inflight.json`,
			`${JSON.stringify({ v: 1, sessionFile: file, pid: process.pid, imageId: "before-exec", open: true, busy: true, depth: 0, updatedAt: "" })}\n`,
		);
		expect(wasInterrupted(readInflight(file))).toBe(true);
	});

	it("exactly one claimant recovers; a lock left by a dead process is taken over", () => {
		const file = session(join(dir, "root.jsonl"), { id: "root" });
		expect(claimRecovery(file)).toBe(true);
		expect(claimRecovery(file)).toBe(false);
		releaseRecovery(file);
		writeFileSync(`${file}.recover.lock`, `${JSON.stringify({ pid: DEAD_PID, at: Date.now() })}\n`);
		expect(claimRecovery(file, 60_000, dead)).toBe(true);
	});

	it("finds direct children in both nesting layouts, and only the interrupted ones", () => {
		const root = session(join(dir, "root.jsonl"), { id: "root" });
		const art = getSessionArtifactPathForFile(root);
		const a = session(join(art, "sub-a", "a.jsonl"), { id: "a", parentSession: root, rlmDepth: 1 });
		const b = session(join(art, "sub-b", "b.jsonl"), { id: "b", parentSession: root, rlmDepth: 1 });
		// A subagent's own children sit in sub-* beside its file (the layout rlm
		// writes: <root>/sub-a/sub-g/<id>.jsonl) — not a direct child of root.
		const g = session(join(art, "sub-a", "sub-g", "g.jsonl"), { id: "g", parentSession: a, rlmDepth: 2 });
		// …and the older layout under the child's own artifact directory.
		const h = session(join(getSessionArtifactPathForFile(a), "sub-h", "h.jsonl"), {
			id: "h",
			parentSession: a,
			rlmDepth: 2,
		});
		// A sibling root in the same folder is never read as a child.
		session(join(dir, "other.jsonl"), { id: "other", parentSession: root });
		expect(listChildSessions(root)).toEqual([a, b].sort());
		expect(listChildSessions(a)).toEqual([g, h].sort());
		foreign(a, true);
		foreign(b, false);
		expect(interruptedChildren(root, dead)).toEqual([a]);
	});

	it("an inbox delivers each message once, oldest first", async () => {
		const parent = session(join(dir, "p.jsonl"), { id: "p" });
		postToInbox(parent, { fromSession: "/x/c1.jsonl", fromName: "c1", text: "one" });
		await new Promise((r) => setTimeout(r, 5));
		postToInbox(parent, { fromSession: "/x/c2.jsonl", fromName: "c2", text: "two" });
		const got = takeInbox(parent);
		expect(got.map((m) => m.text)).toEqual(["one", "two"]);
		expect(takeInbox(parent)).toEqual([]);
		expect(childResultText(got)).toContain('<rlm_child_result from="c1"');
	});

	it("the interrupted notice names children being resumed and says not to respawn them", () => {
		const text = interruptedNotice(["/s/art/root/sub-alpha/x.jsonl"]);
		expect(text).toContain("alpha");
		expect(text).toContain("Do not spawn them again");
		expect(interruptedNotice([])).not.toContain("Do not spawn");
	});
});
