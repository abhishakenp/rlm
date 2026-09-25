/**
 * Fix B verification: concurrent tasks must not overwrite each other's
 * task context snapshot.
 *
 * Before Fix B: rlm-sdk set `globalThis.__rlmTaskContextSnapshot = snapshot`
 * before calling createAgentSessionFn. Concurrent tasks overwrote each
 * other's snapshot — task A's snapshot was lost when task B started.
 *
 * After Fix B: the snapshot is passed as `rlmTaskContextSnapshot` parameter
 * to createAgentSessionFn. Each task carries its own snapshot.
 *
 * This test verifies the contract: createAgentSessionFn receives the
 * correct snapshot for each concurrent task, not a shared global.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const contextPath = join(process.cwd(), ".rlm", "context.json");
const backupPath = contextPath + ".test-backup";

function backupContext() {
	if (existsSync(contextPath)) {
		writeFileSync(backupPath, readFileSync(contextPath, "utf-8"), "utf-8");
	}
}

function restoreContext() {
	if (existsSync(backupPath)) {
		writeFileSync(contextPath, readFileSync(backupPath, "utf-8"), "utf-8");
		try { rmSync(backupPath); } catch {}
	} else {
		try { rmSync(contextPath); } catch {}
	}
}

const createMockCtx = () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
	emit: () => {},
	on: () => () => {},
	get: (name: string) => null,
	reflect: { provide: () => {} },
});

describe("Fix B: concurrent task context snapshots are isolated", () => {
	beforeEach(() => backupContext());
	afterEach(() => restoreContext());

	it("createAgentSessionFn receives rlmTaskContextSnapshot as parameter, not via global", async () => {
		const { RlmSdkService } = await import("../src/index.ts");
		const svc = new RlmSdkService(createMockCtx() as any, { maxDepth: 5 });

		// Track what createAgentSessionFn receives
		let receivedSnapshot: any = undefined;
		let globalWasSet = false;

		// Mock createAgentSessionFn — captures the snapshot parameter
		(svc as any).createAgentSessionFn = async (opts: any) => {
			receivedSnapshot = opts.rlmTaskContextSnapshot;
			globalWasSet = !!(globalThis as any).__rlmTaskContextSnapshot;
			// Return a minimal mock session
			return {
				session: {
					promptAndWait: async () => {},
					messages: [{ role: "assistant", content: "done" }],
					agent: { state: { messages: [] } },
				},
			};
		};

		// Set up a context service mock that returns a snapshot
		const testSnapshot = { testVar: { value: 42, mutable: true, type: "number", description: "test", source: "test" } };
		(svc as any).ctx = {
			...createMockCtx(),
			get: (name: string) => {
				if (name === "rlmCode") return undefined;
				if (name === "rlmContext") {
					return {
						config: { enableSubagentTransfer: true },
						toSnapshot: () => testSnapshot,
						move: () => testSnapshot,
					};
				}
				return null;
			},
		};

		// Run with context copy
		await svc.run("test prompt", {
			depth: 0,
			name: "task-a",
			context: ["testVar"],
		});

		// The snapshot must be passed as a parameter
		expect(receivedSnapshot).toEqual(testSnapshot);
		// The global must NOT be set
		expect(globalWasSet).toBe(false);
	});

	it("two concurrent tasks each receive their own snapshot", async () => {
		const { RlmSdkService } = await import("../src/index.ts");
		const svc = new RlmSdkService(createMockCtx() as any, { maxDepth: 5 });

		const receivedSnapshots: Array<Record<string, any> | null> = [];

		(svc as any).createAgentSessionFn = async (opts: any) => {
			receivedSnapshots.push(opts.rlmTaskContextSnapshot);
			// Simulate async work — don't resolve immediately
			await new Promise((r) => setTimeout(r, 50));
			return {
				session: {
					promptAndWait: async () => {},
					messages: [{ role: "assistant", content: "done" }],
					agent: { state: { messages: [] } },
				},
			};
		};

		const snapshotA = { varA: { value: 1, mutable: true, type: "number", description: "a", source: "a" } };
		const snapshotB = { varB: { value: 2, mutable: true, type: "number", description: "b", source: "b" } };

		(svc as any).ctx = {
			...createMockCtx(),
			get: (name: string) => {
				if (name === "rlmCode") return undefined;
				if (name === "rlmContext") {
					return {
						config: { enableSubagentTransfer: true },
						toSnapshot: (patterns: string[]) => {
							if (patterns.includes("varA")) return snapshotA;
							if (patterns.includes("varB")) return snapshotB;
							return {};
						},
						move: (patterns: string[]) => {
							if (patterns.includes("varA")) return snapshotA;
							if (patterns.includes("varB")) return snapshotB;
							return {};
						},
					};
				}
				return null;
			},
		};

		// Launch two concurrent tasks with different context
		const [handleA, handleB] = await Promise.all([
			svc.run("task A", { depth: 0, name: "task-a", context: ["varA"] }),
			svc.run("task B", { depth: 0, name: "task-b", context: ["varB"] }),
		]);

		// Each task must have received its own snapshot
		expect(receivedSnapshots).toHaveLength(2);
		expect(receivedSnapshots).toContainEqual(snapshotA);
		expect(receivedSnapshots).toContainEqual(snapshotB);
		// They must be different objects
		expect(receivedSnapshots[0]).not.toBe(receivedSnapshots[1]);
	});

	it("global __rlmTaskContextSnapshot is never set by rlm-sdk", async () => {
		const { RlmSdkService } = await import("../src/index.ts");
		const svc = new RlmSdkService(createMockCtx() as any, { maxDepth: 5 });

		// Clear any pre-existing global
		delete (globalThis as any).__rlmTaskContextSnapshot;

		(svc as any).createAgentSessionFn = async () => ({
			session: {
				promptAndWait: async () => {},
				messages: [{ role: "assistant", content: "done" }],
				agent: { state: { messages: [] } },
			},
		});

		(svc as any).ctx = {
			...createMockCtx(),
			get: (name: string) => {
				if (name === "rlmCode") return undefined;
				if (name === "rlmContext") {
					return {
						config: { enableSubagentTransfer: true },
						toSnapshot: () => ({ x: { value: 1, mutable: true, type: "number", description: "", source: "" } }),
						move: () => ({ x: { value: 1, mutable: true, type: "number", description: "", source: "" } }),
					};
				}
				return null;
			},
		};

		await svc.run("test", { depth: 0, name: "task", context: ["x"] });

		// The global must never have been set
		expect((globalThis as any).__rlmTaskContextSnapshot).toBeUndefined();
	});
});
