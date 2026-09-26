import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * A session that records a toolResult and then never writes anything else has
 * ended without saying how. Across 6,215 real session files in ~/.rlm, 402 of
 * them end exactly that way, and every single one ends on the `code` tool —
 * which evaluates model-authored JavaScript in an in-process vm context, so a
 * cell that leaves a rejecting promise behind takes the whole agent down with
 * it. Node's default for an unhandled rejection is to throw, and no listener
 * existed anywhere in the package, so the process died between the toolResult
 * write and the next provider request.
 *
 * Provider failures are deliberately not covered here: the stream layer turns
 * those into an assistant message with stopReason "error", which is already
 * persisted on its own and accounts for a different 304 sessions.
 */

function readEntries(sessionFile: string): SessionEntry[] {
	return readFileSync(sessionFile, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as SessionEntry);
}

function terminalStates(sessionFile: string): Array<{ status: string; reason?: string }> {
	return readEntries(sessionFile)
		.filter((entry): entry is Extract<SessionEntry, { type: "session_state" }> => entry.type === "session_state")
		.map((entry) => entry.state);
}

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_toolCallId, params) => {
		const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
		return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
	},
};

/**
 * Emit the event Node itself emits for an unhandled rejection, with the process
 * shaped the way production is: something other than the session is also
 * listening, so the session records the death and leaves the outcome alone
 * rather than restoring the default fatal path and taking the test worker down.
 */
function emitUnhandledRejection(error: Error, preexisting: readonly Function[]): void {
	const sentinel = () => undefined;
	for (const listener of preexisting) {
		process.off("unhandledRejection", listener as never);
	}
	process.on("unhandledRejection", sentinel);
	try {
		process.emit("unhandledRejection", error, Promise.resolve() as never);
	} finally {
		process.off("unhandledRejection", sentinel);
		for (const listener of preexisting) {
			process.on("unhandledRejection", listener as never);
		}
	}
}

describe("E7 (a) a session always records how it ended", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("writes a terminal crash record when the process dies after a toolResult", async () => {
		// Snapshot before the session exists so the session's own hook can be told
		// apart from the runner's, and only the runner's are lifted for the emit.
		const preexisting = process.listeners("unhandledRejection").slice();
		const harness = await createHarness({ tools: [echoTool], persistSession: true });
		harnesses.push(harness);

		const fatal = new Error("Cannot read properties of undefined (reading 'get')");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			// The provider request that follows the toolResult. In production this
			// is exactly where the process went away, so it never answers.
			async () => {
				emitUnhandledRejection(fatal, preexisting);
				return new Promise<never>(() => {});
			},
		]);

		void harness.session.prompt("start").catch(() => undefined);

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();

		await vi.waitFor(() => {
			const entries = readEntries(sessionFile as string);
			expect(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(true);
			expect(terminalStates(sessionFile as string)).toEqual([
				{ status: "crash", reason: `unhandledRejection: ${fatal.message}` },
			]);
		}, 5000);

		// The record is the LAST thing in the branch: a reader tailing the file
		// sees the ending without having to infer it from what is missing.
		const entries = readEntries(sessionFile as string);
		expect(entries[entries.length - 1]?.type).toBe("session_state");
	});

	it("leaves no crash record on a session that was disposed cleanly", async () => {
		const preexisting = process.listeners("unhandledRejection").slice();
		const harness = await createHarness({ tools: [echoTool], persistSession: true });

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("start");

		const sessionFile = harness.sessionManager.getSessionFile() as string;
		harness.session.dispose();

		emitUnhandledRejection(new Error("something later and unrelated blew up"), preexisting);

		expect(terminalStates(sessionFile)).toEqual([]);
		harness.cleanup();
	});
});
