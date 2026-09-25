import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import {
	hideNoiseAgentsViewSessions,
	isDelegatedSessionRecord,
	reconcileUnifiedSessions,
} from "../src/modes/agents-view/agents-view-state.js";
import { claimStartupNotices } from "../src/modes/shared/startup-notices.js";

const saved = (path: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
	path,
	id: path.split("/").pop()!.replace(".jsonl", ""),
	cwd: "/work",
	rlmDepth: 0,
	created: new Date("2026-09-25T10:00:00Z"),
	modified: new Date("2026-09-25T10:00:00Z"),
	messageCount: 2,
	firstMessage: "hello",
	allMessagesText: "hello",
	...over,
});

const catalog = [
	saved("/s/real.jsonl"),
	saved("/s/rlm-delegate-g1-t1.jsonl"),
	saved("/s/rlm-delegate-g1-t2.jsonl"),
	saved("/s/empty.jsonl", { messageCount: 0, firstMessage: "(no messages)", allMessagesText: "" }),
	saved("/a/real/sub-1/child.jsonl", { rlmDepth: 1, parentSessionPath: "/s/real.jsonl" }),
];

describe("saved list noise", () => {
	it("recognises delegated task sessions by file name only", () => {
		const records = reconcileUnifiedSessions([], catalog);
		expect(records.filter(isDelegatedSessionRecord).map((r) => r.saved?.id)).toEqual([
			"rlm-delegate-g1-t1",
			"rlm-delegate-g1-t2",
		]);
	});

	it("hides delegated and empty sessions by default and says how many", () => {
		const hidden = hideNoiseAgentsViewSessions(reconcileUnifiedSessions([], catalog), false);
		expect(hidden.records.map((r) => r.saved?.id).sort()).toEqual(["child", "real"]);
		expect(hidden.delegated).toBe(2);
		expect(hidden.empty).toBe(1);
	});

	it("shows everything once toggled, with nothing counted as hidden", () => {
		const shown = hideNoiseAgentsViewSessions(reconcileUnifiedSessions([], catalog), true);
		expect(shown.records).toHaveLength(catalog.length);
		expect([shown.delegated, shown.empty]).toEqual([0, 0]);
	});
});

describe("startup notices", () => {
	afterEach(() => {
		delete (globalThis as { __rlmStartupNoticesClaimed?: boolean }).__rlmStartupNoticesClaimed;
		delete process.env.RLM_STARTUP_NOTICES_SHOWN;
	});

	it("survive an execve-in-place: same pid, fresh globalThis, inherited env", () => {
		delete (globalThis as { __rlmStartupNoticesClaimed?: boolean }).__rlmStartupNoticesClaimed;
		delete process.env.RLM_STARTUP_NOTICES_SHOWN;
		expect(claimStartupNotices()).toBe(true);
		// The next image: globalThis is new, the environment came with it.
		delete (globalThis as { __rlmStartupNoticesClaimed?: boolean }).__rlmStartupNoticesClaimed;
		expect(claimStartupNotices()).toBe(false);
		// A child process (another pid) with the inherited variable still shows them.
		process.env.RLM_STARTUP_NOTICES_SHOWN = String(process.pid + 1);
		delete (globalThis as { __rlmStartupNoticesClaimed?: boolean }).__rlmStartupNoticesClaimed;
		expect(claimStartupNotices()).toBe(true);
	});

	it("are claimed once per process, and the claim lives on globalThis so a reloaded module sees it", () => {
		delete (globalThis as { __rlmStartupNoticesClaimed?: boolean }).__rlmStartupNoticesClaimed;
		delete process.env.RLM_STARTUP_NOTICES_SHOWN;
		expect(claimStartupNotices()).toBe(true);
		expect(claimStartupNotices()).toBe(false);
		// A hot-reloaded copy of the module keeps no state of its own; it reads this.
		expect((globalThis as { __rlmStartupNoticesClaimed?: boolean }).__rlmStartupNoticesClaimed).toBe(true);
	});
});
