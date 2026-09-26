import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore, nextRunAtForSchedule } from "../src/core/cron-jobs.js";

const start = new Date("2026-01-01T12:34:00.000Z");

const makeStorePath = (tempDirs: string[]): string => {
	const dir = mkdtempSync(join(tmpdir(), "cron-give-up-"));
	tempDirs.push(dir);
	return join(dir, "scheduled-jobs.json");
};

/**
 * A recurring heartbeat that reruns `dispatch.mjs` every five minutes and fails the same way
 * every time is the shape that burned 14 unattended hours in session
 * 01a028af-f660-73a9-a338-4a08ea15aeca. These tests pin the give-up bounds that stop it.
 */
describe("AgentCronJobStore give-up bounds", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const makeRecurringJob = (store: AgentCronJobStore) =>
		store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "ORCHESTRATION STABILITY CHECK (5-min heartbeat)",
			now: start,
		});

	it("stops a recurring job whose failure never changes, instead of rescheduling for ever", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = makeRecurringJob(store);
		const error = new Error("[export_artifacts:build] failed");

		const first = store.recordRunResult(job.id, { now: new Date(start.getTime() + 60_000), error });
		expect(first).toMatchObject({ status: "active", consecutiveFailures: 1, repeatedFailures: 1 });

		const second = store.recordRunResult(job.id, { now: new Date(start.getTime() + 120_000), error });
		expect(second).toMatchObject({ status: "active", repeatedFailures: 2 });

		// Third identical failure: the error set has not moved once in three runs, so another
		// identical run cannot help. The job must stop rather than reschedule.
		const third = store.recordRunResult(job.id, { now: new Date(start.getTime() + 180_000), error });

		expect(third?.status).toBe("paused");
		expect(third?.nextRunAt).toBeUndefined();
		expect(third?.repeatedFailures).toBe(3);
		expect(third?.lastError).toContain("gave up");
		expect(third?.lastError).toContain("3 times");
		expect(third?.lastError).toContain("[export_artifacts:build] failed");
		expect(store.due(new Date(start.getTime() + 3_600_000))).toEqual([]);
	});

	it("keeps a job that is failing differently alive until the hard consecutive bound", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = makeRecurringJob(store);

		// Every failure is distinct, so the no-progress detector never fires. Only the hard
		// ceiling stops it.
		let latest = store.list()[0];
		for (let run = 1; run <= 9; run++) {
			latest = store.recordRunResult(job.id, {
				now: new Date(start.getTime() + run * 60_000),
				error: new Error(`distinct failure kind ${String.fromCharCode(96 + run)}`),
			})!;
			expect(latest.status).toBe("active");
		}
		expect(latest.consecutiveFailures).toBe(9);

		const tenth = store.recordRunResult(job.id, {
			now: new Date(start.getTime() + 600_000),
			error: new Error("distinct failure kind j"),
		});

		expect(tenth?.status).toBe("paused");
		expect(tenth?.consecutiveFailures).toBe(10);
		expect(tenth?.lastError).toContain("gave up");
		expect(tenth?.lastError).toContain("10 consecutive");
		expect(store.due(new Date(start.getTime() + 3_600_000))).toEqual([]);
	});

	it("never lets an identically failing job outlive its bound, however long it is driven", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = makeRecurringJob(store);
		const error = new Error("✗ Svelte still has 1 compile error(s) after all fixes and LLM retries");

		// Drive far past any plausible bound. Without a give-up this loop reschedules 200 times;
		// with one, every run after the give-up is a no-op on an already-stopped job.
		let ran = 0;
		for (let run = 1; run <= 200; run++) {
			const due = store.due(new Date(start.getTime() + run * 300_000));
			if (due.length === 0) {
				break;
			}
			ran++;
			store.recordRunResult(job.id, { now: new Date(start.getTime() + run * 300_000), error });
		}

		expect(ran).toBe(3);
		expect(store.list()[0]?.status).toBe("paused");
	});

	it("treats a changed failure message as progress and resets the repeat counter", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = makeRecurringJob(store);

		store.recordRunResult(job.id, { now: new Date(start.getTime() + 60_000), error: new Error("build failed") });
		store.recordRunResult(job.id, { now: new Date(start.getTime() + 120_000), error: new Error("build failed") });
		const moved = store.recordRunResult(job.id, {
			now: new Date(start.getTime() + 180_000),
			error: new Error("tests failed"),
		});

		expect(moved).toMatchObject({ status: "active", consecutiveFailures: 3, repeatedFailures: 1 });
		expect(moved?.nextRunAt).toBeDefined();
	});

	it("ignores volatile run-to-run detail when deciding the failure is unchanged", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = makeRecurringJob(store);

		// The same failure carrying a fresh timestamp/pid/duration on every run is still the
		// same failure; a signature that keyed on the raw text would never match twice.
		for (let run = 1; run <= 2; run++) {
			const alive = store.recordRunResult(job.id, {
				now: new Date(start.getTime() + run * 60_000),
				error: new Error(`CalledProcessError at 12:0${run}:33 (pid 4471${run}) after 3.${run}s`),
			});
			expect(alive?.status).toBe("active");
		}

		const stopped = store.recordRunResult(job.id, {
			now: new Date(start.getTime() + 180_000),
			error: new Error("CalledProcessError at 12:09:41 (pid 44999) after 3.9s"),
		});

		expect(stopped?.status).toBe("paused");
		expect(stopped?.repeatedFailures).toBe(3);
	});

	it("clears the failure streak after a successful run", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = makeRecurringJob(store);
		const error = new Error("[export_artifacts:build] failed");

		store.recordRunResult(job.id, { now: new Date(start.getTime() + 60_000), error });
		store.recordRunResult(job.id, { now: new Date(start.getTime() + 120_000), error });
		const recovered = store.recordRunResult(job.id, { now: new Date(start.getTime() + 180_000) });

		expect(recovered).toMatchObject({ status: "active", consecutiveFailures: 0, repeatedFailures: 0 });
		expect(recovered?.lastError).toBeUndefined();

		// The streak restarts from zero, so the job survives two more identical failures.
		const afterRecovery = store.recordRunResult(job.id, { now: new Date(start.getTime() + 240_000), error });
		expect(afterRecovery).toMatchObject({ status: "active", repeatedFailures: 1 });
	});

	it("honours the configured bounds from the environment", () => {
		vi.stubEnv("PI_CRON_MAX_REPEATED_FAILURES", "2");
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = makeRecurringJob(store);
		const error = new Error("[export_artifacts:build] failed");

		expect(store.recordRunResult(job.id, { now: new Date(start.getTime() + 60_000), error })?.status).toBe("active");
		const stopped = store.recordRunResult(job.id, { now: new Date(start.getTime() + 120_000), error });

		expect(stopped?.status).toBe("paused");
		expect(stopped?.lastError).toContain("2 times");
	});

	it("applies the same give-up to the dispatch-completion path", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = makeRecurringJob(store);
		const error = new Error("[export_artifacts:build] failed");

		let latest = job;
		for (let run = 1; run <= 3; run++) {
			const [dispatch] = store.claimDue(new Date(start.getTime() + run * 300_000));
			expect(dispatch).toBeDefined();
			latest = store.recordDispatchResult(dispatch!.id, {
				now: new Date(start.getTime() + run * 300_000),
				outcome: "ran",
				error,
			})!;
		}

		expect(latest.status).toBe("paused");
		expect(latest.lastError).toContain("gave up");
		expect(store.due(new Date(start.getTime() + 3_600_000))).toEqual([]);
	});
});

describe("cron schedules use local time", () => {
	it("fires a 09:00 schedule at 09:00 local, whatever the zone", () => {
		// Built from local fields, so this holds in UTC and in +05:45 alike.
		const localMorning = new Date(2026, 0, 5, 8, 30, 0, 0);
		const next = nextRunAtForSchedule({ kind: "cron", expression: "0 9 * * *" } as never, localMorning);
		expect(next).toBeDefined();
		expect(next!.getHours()).toBe(9);
		expect(next!.getMinutes()).toBe(0);
		expect(next!.getDate()).toBe(5);
	});
});
