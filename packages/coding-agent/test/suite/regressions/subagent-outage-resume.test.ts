import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomMessage } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

const customOfType = (messages: readonly unknown[], customType: string): CustomMessage[] =>
	messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === customType,
	);

const connectionError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });

describe("subagents across an endpoint outage", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	const boot = async (childRetry: Record<string, number | boolean>) => {
		child = await createHarness({ settings: { retry: { enabled: true, ...childRetry } } });
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
	};

	it("a child waits out the outage and finishes its task", async () => {
		await boot({ maxRetries: 1, baseDelayMs: 1, outageMaxBackoffMs: 2, outagePatienceMs: 60_000 });
		child!.setResponses([connectionError(), connectionError(), connectionError(), fauxAssistantMessage("child done")]);

		const spawned = await parent!.session.runRlmChild("do the work", { name: "outage-worker" });

		await expect
			.poll(() => customOfType(parent!.session.messages, "rlm_child_terminal_notice"))
			.toHaveLength(1);
		expect(customOfType(parent!.session.messages, "rlm_child_failure")).toHaveLength(0);
		expect(customOfType(parent!.session.messages, "rlm_child_terminal_notice")[0]).toMatchObject({
			details: { kind: "completed_without_reply", childId: spawned.rlm_child_id },
		});
		expect(child!.faux.state.callCount).toBe(4);
	});

	it("a child whose retries run out is reported as failed, not completed", async () => {
		await boot({ maxRetries: 1, baseDelayMs: 1 });
		child!.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 internal error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 internal error" }),
		]);

		const spawned = await parent!.session.runRlmChild("do the work", { name: "doomed-worker" });

		await expect.poll(() => customOfType(parent!.session.messages, "rlm_child_failure")).toHaveLength(1);
		expect(customOfType(parent!.session.messages, "rlm_child_terminal_notice")).toHaveLength(0);
		expect(customOfType(parent!.session.messages, "rlm_child_failure")[0]).toMatchObject({
			details: { childId: spawned.rlm_child_id, error: "500 internal error" },
		});
	});
});
