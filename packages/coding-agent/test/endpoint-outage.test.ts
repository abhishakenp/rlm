import { describe, expect, it } from "vitest";
import {
	isEndpointOutageError,
	outageDelayMs,
	shouldKeepWaitingForEndpoint,
} from "../src/core/endpoint-outage.js";

describe("isEndpointOutageError", () => {
	it("recognises the errors seen while the gateway restarted", () => {
		expect(isEndpointOutageError("Connection error.")).toBe(true);
		expect(
			isEndpointOutageError(
				"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
			),
		).toBe(true);
		expect(isEndpointOutageError("connect ECONNREFUSED 127.0.0.1:20128")).toBe(true);
		expect(isEndpointOutageError("fetch failed")).toBe(true);
		expect(isEndpointOutageError("502 Bad Gateway")).toBe(true);
	});

	it("leaves request-level failures to the ordinary budget", () => {
		expect(isEndpointOutageError(undefined)).toBe(false);
		expect(isEndpointOutageError("Provider finish_reason: error")).toBe(false);
		expect(isEndpointOutageError("429 usage_limit_reached")).toBe(false);
		expect(isEndpointOutageError("401 OAuth access token is invalid")).toBe(false);
		expect(
			isEndpointOutageError("Upstream dropped a tool call: the stream ended with 107 empty deltas and no tool_calls"),
		).toBe(false);
	});
});

describe("outage backoff", () => {
	const policy = { baseDelayMs: 2000, maxBackoffMs: 30_000, patienceMs: 600_000 };

	it("doubles and caps", () => {
		expect([1, 2, 3, 4, 5, 6, 7].map((n) => outageDelayMs(n, policy))).toEqual([
			2000, 4000, 8000, 16000, 30000, 30000, 30000,
		]);
	});

	it("waits through a restart far longer than the old 14s budget, and stops at the window", () => {
		const start = 0;
		expect(shouldKeepWaitingForEndpoint(start, 180_000, 30_000, policy)).toBe(true);
		expect(shouldKeepWaitingForEndpoint(start, 570_000, 30_000, policy)).toBe(true);
		expect(shouldKeepWaitingForEndpoint(start, 575_000, 30_000, policy)).toBe(false);
	});
});
