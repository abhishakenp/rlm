import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * A session that finished its turn and is waiting for the user looks, from
 * disk, exactly like a session whose operator walked away and is never coming
 * back. 36 of the 6,215 real session files in ~/.rlm end on that state and
 * nothing else, and the agents view still lists every one of them as needing
 * input, because "needs input" is the fallback label for any session that never
 * said otherwise. A bounded timeout resolves those instead of leaving them live
 * forever; it stays off unless a caller asks for it, so an interactive operator
 * is never timed out mid-thought.
 */

function terminalStates(sessionFile: string): Array<{ status: string; reason?: string }> {
	return readFileSync(sessionFile, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SessionEntry)
		.filter((entry): entry is Extract<SessionEntry, { type: "session_state" }> => entry.type === "session_state")
		.map((entry) => entry.state);
}

describe("E7 (b) an unanswered session resolves instead of hanging", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resolves the session with a terminal record and a reason once the idle timeout elapses", async () => {
		const harness = await createHarness({ persistSession: true, needsInputTimeoutMs: 40 });
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("anything else?")]);
		await harness.session.prompt("start");

		const sessionFile = harness.sessionManager.getSessionFile() as string;
		expect(terminalStates(sessionFile)).toEqual([]);

		await vi.waitFor(() => {
			expect(terminalStates(sessionFile)).toEqual([
				{ status: "archived", reason: "no user input for 40ms while the session was awaiting input" },
			]);
		}, 5000);

		expect(harness.eventsOfType("session_resolved")).toEqual([
			{ type: "session_resolved", reason: "needs_input_timeout", timeoutMs: 40 },
		]);
	});

	it("does not resolve a session the user answered in time", async () => {
		const harness = await createHarness({ persistSession: true, needsInputTimeoutMs: 2_000 });
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("anything else?"), fauxAssistantMessage("done")]);
		await harness.session.prompt("start");
		await harness.session.prompt("yes, carry on");

		const sessionFile = harness.sessionManager.getSessionFile() as string;
		expect(terminalStates(sessionFile)).toEqual([]);
		expect(harness.eventsOfType("session_resolved")).toEqual([]);
	});

	it("waits forever when no timeout is configured, which is the interactive default", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("anything else?")]);
		await harness.session.prompt("start");

		// Comfortably longer than the 40ms the bounded case needs above.
		await new Promise((resolve) => setTimeout(resolve, 250));

		const sessionFile = harness.sessionManager.getSessionFile() as string;
		expect(terminalStates(sessionFile)).toEqual([]);
		expect(harness.eventsOfType("session_resolved")).toEqual([]);
	});
});
