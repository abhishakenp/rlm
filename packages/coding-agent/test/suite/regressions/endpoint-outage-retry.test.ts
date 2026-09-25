import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

// The gateway restarting is an outage, not a failed request: a run must wait
// it out instead of ending after maxRetries attempts (2026-09-25: 265 of 273
// errors were "Connection error." while OmniRoute restarted).
describe("endpoint outage retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const connectionError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });

	it("keeps retrying an unreachable endpoint past maxRetries and resumes when it returns", async () => {
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, outageMaxBackoffMs: 2, outagePatienceMs: 60_000 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([...Array.from({ length: 8 }, connectionError), fauxAssistantMessage("back online")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(9);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(8);
		expect(harness.eventsOfType("auto_retry_start").every((event) => event.outage !== undefined)).toBe(true);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(getAssistantTexts(harness)).toContain("back online");
		// The failed attempts are not left in the transcript the model sees.
		const assistants = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistants.filter((message) => (message as { stopReason?: string }).stopReason === "error")).toHaveLength(0);
	});

	it("gives up once the patience window is spent", async () => {
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 20, outageMaxBackoffMs: 20, outagePatienceMs: 50 },
			},
		});
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 20 }, connectionError));

		await harness.session.prompt("test");

		const ends = harness.eventsOfType("auto_retry_end");
		expect(ends.at(-1)?.success).toBe(false);
		expect(harness.faux.state.callCount).toBeLessThan(20);
	});

	it("still gives an ordinary error its full budget after an outage", async () => {
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, outageMaxBackoffMs: 1, outagePatienceMs: 60_000 },
			},
		});
		harnesses.push(harness);
		const serverError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 internal error" });
		harness.setResponses([
			connectionError(),
			connectionError(),
			connectionError(),
			serverError(),
			serverError(),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(6);
		expect(getAssistantTexts(harness)).toContain("recovered");
	});
});
