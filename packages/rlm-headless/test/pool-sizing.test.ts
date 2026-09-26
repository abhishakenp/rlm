/**
 * Pool sizing and worker heartbeats, as the delegate reads them
 * (rlm-delegate/src/index.ts asks `childPoolSlots`, `childHeartbeatMs` and
 * `childHeartbeatTimeoutMs` of this row).
 *
 * The methods only read `this.config`, so they are exercised on the prototype
 * with a plain config object rather than a booted Context.
 */
import { describe, expect, test } from "bun:test";
import { freemem, totalmem } from "node:os";
import { RlmHeadlessService } from "../src/index.ts";

const call = <K extends "childPoolSlots" | "childHeartbeatMs" | "childHeartbeatTimeoutMs">(
	method: K,
	config: Record<string, unknown>,
): number => {
	const self: any = { config };
	self.childHeartbeatMs = RlmHeadlessService.prototype.childHeartbeatMs.bind(self);
	return (RlmHeadlessService.prototype[method] as () => number).call(self);
};

describe("childPoolSlots", () => {
	test("a configured number overrules the measurement", () => {
		expect(call("childPoolSlots", { childPoolSlots: 4 })).toBe(4);
		expect(call("childPoolSlots", { childPoolSlots: 4.9 })).toBe(4);
	});

	test("0 and 1 still turn the pool off", () => {
		expect(call("childPoolSlots", { childPoolSlots: 0 })).toBe(0);
		expect(call("childPoolSlots", { childPoolSlots: 1 })).toBe(0);
	});

	test("unset: measured from free memory against the floor", () => {
		const freeFraction = freemem() / totalmem();
		// A floor above what is free → one task at a time.
		expect(call("childPoolSlots", { workerMemoryFloor: 1.01 })).toBe(1);
		// A floor of zero → never below it → not capped in advance.
		expect(call("childPoolSlots", { workerMemoryFloor: 0 })).toBe(Number.MAX_SAFE_INTEGER);
		// The default floor agrees with the machine right now.
		const expected = freeFraction < 0.2 ? 1 : Number.MAX_SAFE_INTEGER;
		expect(call("childPoolSlots", {})).toBe(expected);
	});
});

describe("worker heartbeats", () => {
	test("defaults: beat every 5s, dead after 15s", () => {
		expect(call("childHeartbeatMs", {})).toBe(5_000);
		expect(call("childHeartbeatTimeoutMs", {})).toBe(15_000);
	});

	test("0 switches the heartbeat off; negatives fall back to the default", () => {
		expect(call("childHeartbeatMs", { workerHeartbeatMs: 0 })).toBe(0);
		expect(call("childHeartbeatMs", { workerHeartbeatMs: -5 })).toBe(5_000);
	});

	test("the timeout is never tighter than twice the interval", () => {
		expect(call("childHeartbeatTimeoutMs", { workerHeartbeatMs: 10_000, workerHeartbeatTimeoutMs: 5_000 })).toBe(
			20_000,
		);
		expect(call("childHeartbeatTimeoutMs", { workerHeartbeatMs: 1_000, workerHeartbeatTimeoutMs: 9_000 })).toBe(9_000);
	});
});
