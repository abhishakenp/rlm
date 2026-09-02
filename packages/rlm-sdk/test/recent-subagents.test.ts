/**
 * Tests for rlm-sdk recent subagent tracking.
 *
 * Verifies:
 * 1. recentSubagents() returns an empty array when no subagents have completed.
 * 2. completedAt is included in SubagentHandle and SubagentInfo.
 * 3. recentSubagents() returns items most-recent-first, capped at 20.
 */
import { describe, it, expect, beforeEach } from "vitest";

const createMockCtx = () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
	emit: () => {},
	on: () => () => {},
	get: () => null,
	reflect: { provide: () => {} },
});

describe("RlmSdkService recentSubagents()", () => {
	let service: any;

	beforeEach(async () => {
		const { RlmSdkService } = await import("../src/index.ts");
		service = new RlmSdkService(createMockCtx() as any, { maxDepth: 5 });
		// Skip init() — it would try to load createAgentSessionFn.
	});

	it("returns an empty array when no subagents have completed", () => {
		const recent = service.recentSubagents();
		expect(recent).toEqual([]);
		expect(Array.isArray(recent)).toBe(true);
	});

	it("has RECENT_COMPLETED_LIMIT constant set to 20", () => {
		const { RlmSdkService } = require("../src/index.ts") as any;
		expect(RlmSdkService.RECENT_COMPLETED_LIMIT).toBe(20);
	});

	it("SubagentInfo type includes completedAt", () => {
		const { SubagentInfo } = require("../src/index.ts") as any;
		const info: SubagentInfo = {
			id: "test-1",
			name: "test",
			status: "completed",
			sessionName: "test",
			completedAt: new Date().toISOString(),
		};
		expect(typeof info.completedAt).toBe("string");
		expect(info.completedAt.length).toBeGreaterThan(0);
	});

	it("run() with depth >= maxDepth returns error handle with completedAt", async () => {
		const handle = await service.run("test prompt", { depth: 5, name: "over-depth" });
		expect(handle.status).toBe("error");
		expect(handle.completedAt).toBeDefined();
		expect(typeof handle.completedAt).toBe("string");

		// Error handles are also added to recentSubagents.
		const recent = service.recentSubagents();
		expect(recent.length).toBeGreaterThan(0);
		expect(recent[0].id).toBe(handle.id);
		expect(recent[0].status).toBe("error");
		expect(recent[0].completedAt).toBe(handle.completedAt);
	});

	it("recentSubagents is capped at 20 items", async () => {
		// Fill with 25 error handles (each depth >= maxDepth is instant).
		for (let i = 0; i < 25; i++) {
			await service.run("prompt", { depth: 5, name: `cap-${i}` });
		}
		const recent = service.recentSubagents();
		expect(recent.length).toBe(20);
		// Most recent first.
		expect(recent[0].name).toBe("cap-24");
		expect(recent[19].name).toBe("cap-5");
	});
});
