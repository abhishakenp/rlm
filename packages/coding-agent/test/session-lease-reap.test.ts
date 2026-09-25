import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireSessionLease,
	canonicalSessionPath,
	getProcessStartId,
	reapStaleSessionLeases,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../src/core/session-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-session-lease-reap-test-"));
	tempDirs.push(directory);
	return directory;
}

function enabledEnvironment(owner: string): NodeJS.ProcessEnv {
	return {
		[SESSION_LEASES_ENABLED_ENV]: "1",
		[SESSION_LEASE_OWNER_ID_ENV]: owner,
	};
}

/** Plant a lease exactly as `acquireSessionLease` would have left it behind. */
function plantLease(agentDir: string, name: string, owner: Record<string, unknown> | string): string {
	const sessionPath = canonicalSessionPath(resolve(agentDir, name));
	const key = createHash("sha256").update(sessionPath).digest("hex");
	const directory = join(agentDir, "session-leases", `${key}.lock`);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "owner.json"),
		typeof owner === "string" ? owner : JSON.stringify({ version: 1, sessionPath, ...owner }),
	);
	return directory;
}

describe("session lease reaping", () => {
	it("names every dead lease under a dry run and removes none of them", () => {
		const agentDir = createTempDir();
		const dead = plantLease(agentDir, "dead.jsonl", {
			token: "dead",
			pid: 2_147_483_647,
			activeSessionId: "dead-owner",
			createdAt: new Date(0).toISOString(),
		});
		const recycled = plantLease(agentDir, "recycled.jsonl", {
			token: "recycled",
			pid: process.pid,
			processStartId: "a-process-that-is-not-this-one",
			activeSessionId: "recycled-owner",
			createdAt: new Date(0).toISOString(),
		});
		const living = plantLease(agentDir, "living.jsonl", {
			token: "living",
			pid: process.pid,
			processStartId: getProcessStartId(process.pid),
			activeSessionId: "living-owner",
			createdAt: new Date().toISOString(),
		});

		const planned = reapStaleSessionLeases(agentDir, { dryRun: true });

		expect(planned.map((entry) => entry.directory).sort()).toEqual([dead, recycled].sort());
		expect(planned.find((entry) => entry.directory === dead)).toMatchObject({
			reason: "process-gone",
			pid: 2_147_483_647,
			activeSessionId: "dead-owner",
		});
		expect(planned.find((entry) => entry.directory === recycled)).toMatchObject({
			reason: "process-replaced",
			activeSessionId: "recycled-owner",
		});
		expect(existsSync(dead)).toBe(true);
		expect(existsSync(recycled)).toBe(true);
		expect(existsSync(living)).toBe(true);
	});

	it("removes the dead and the recycled owners and leaves the living one alone", () => {
		const agentDir = createTempDir();
		const dead = plantLease(agentDir, "dead.jsonl", {
			token: "dead",
			pid: 2_147_483_647,
			createdAt: new Date(0).toISOString(),
		});
		const unreadable = plantLease(agentDir, "unreadable.jsonl", "{ this is not json");
		const living = plantLease(agentDir, "living.jsonl", {
			token: "living",
			pid: process.pid,
			processStartId: getProcessStartId(process.pid),
			createdAt: new Date().toISOString(),
		});

		const reaped = reapStaleSessionLeases(agentDir);

		expect(reaped.map((entry) => entry.reason).sort()).toEqual(["owner-unreadable", "process-gone"]);
		expect(existsSync(dead)).toBe(false);
		expect(existsSync(unreadable)).toBe(false);
		expect(existsSync(living)).toBe(true);
		expect(reapStaleSessionLeases(agentDir)).toEqual([]);
	});

	it("sweeps the stale siblings a process did not come for", () => {
		const agentDir = createTempDir();
		const orphan = plantLease(agentDir, "orphan.jsonl", {
			token: "orphan",
			pid: 2_147_483_647,
			createdAt: new Date(0).toISOString(),
		});

		const lease = acquireSessionLease(
			join(agentDir, "wanted.jsonl"),
			agentDir,
			enabledEnvironment("newcomer"),
		);

		expect(lease?.sessionPath).toBe(canonicalSessionPath(join(agentDir, "wanted.jsonl")));
		expect(existsSync(orphan)).toBe(false);
		lease?.release();
	});
});
