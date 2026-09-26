import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import { createAgentSessionMessagePrompt } from "../src/core/agent-messages.js";
import { waitForParentResponse } from "../../agent/src/communication/parent-wait.js";
import { createHarness, type Harness } from "./suite/harness.js";

describe("agent-msg-wait-parent", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		delete (globalThis as any).host;
	});

	it("routes agent_message.send (parent) to sendAgentMessage", async () => {
		const sendAgentMessage = vi.fn(async () => ({ delivered: true }));
		const mockController: AgentSessionMessageController = {
			listAgents: () => ({ current: undefined as never, agents: [] }),
			roster: () => ({
				current: { name: "child", id: "child-session", depth: 1 },
				entries: [{ relationship: "parent", name: "root", id: "parent-session", depth: 0, status: "running" }],
			}),
			sendAgentMessage,
		};
		harness = await createHarness({ agentMessageController: mockController });

		// The session-level request takes the resolved id; `receiver_role: "parent"`
		// is resolved to it one layer up (createAgentMessageHostHandlers).
		await harness.session.handleAgentMessageHostRequest("agent_message.send", {
			target: "parent-session",
			message: "Which option should I use?",
		});

		expect(sendAgentMessage).toHaveBeenCalledTimes(1);
		const call = sendAgentMessage.mock.calls[0][0] as { target: string; message: string; receiverRole?: string };
		expect(call.target).toBe("parent-session");
		expect(call.message).toBe("Which option should I use?");
	});

	it("blocks until a parent message arrives", async () => {
		// The parent answers only after 300ms; until then every poll is empty.
		let answered = false;
		setTimeout(() => {
			answered = true;
		}, 300);
		(globalThis as any).host = {
			request: async () => {
				if (!answered) return { messages: [] };
				const messageText = createAgentSessionMessagePrompt({
					id: "agentmsg_test_123",
					message: "Use option B",
					source: "agent_message",
					fromRelationship: "parent",
					from: { activeSessionId: "parent-session", sessionId: "parent-session" },
					target: { activeSessionId: "child-session", sessionId: "child-session" },
				});
				return {
					messages: [
						{ index: 1, role: "custom", customType: "agent_message", text: messageText, timestamp: Date.now(), truncated: false },
					],
				};
			},
		};

		let resolved = false;
		const resultPromise = waitForParentResponse({ timeoutMs: 5_000, pollIntervalMs: 50 }).then((result) => {
			resolved = true;
			return result;
		});

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(resolved).toBe(false);

		const result = await resultPromise;
		expect(result.timedOut).toBe(false);
		expect(result.message).toBe("Use option B");
		expect(result.elapsedMs).toBeGreaterThanOrEqual(300);
	});

	it("uses an injected request function instead of a global host", async () => {
		const request = vi.fn(async () => ({
			messages: [
				{
					index: 3,
					role: "custom",
					customType: "agent_message",
					text: createAgentSessionMessagePrompt({
						id: "agentmsg_injected",
						message: "injected",
						source: "agent_message",
						fromRelationship: "parent",
						from: { activeSessionId: "p", sessionId: "p" },
						target: { activeSessionId: "c", sessionId: "c" },
					}),
				},
			],
		}));
		const result = await waitForParentResponse({ timeoutMs: 1_000, pollIntervalMs: 10, request });
		expect(request).toHaveBeenCalledWith("agent_observe.recent", expect.objectContaining({ target: "current" }));
		expect(result.message).toBe("injected");
		expect(result.messageId).toBe("agentmsg_injected");
	});

	it("session hands a parent message straight to a waiting cell", async () => {
		harness = await createHarness();
		const session = harness.session;
		const waiting = session.waitForParentAgentMessage(2_000);
		const parentMessage = {
			role: "custom",
			customType: "agent_message",
			content: "ignored",
			display: true,
			timestamp: Date.now(),
			details: {
				id: "agentmsg_direct",
				message: "Use option C",
				source: "agent_message",
				fromRelationship: "parent",
				from: { activeSessionId: "parent-session", sessionId: "parent-session" },
				target: { activeSessionId: "child-session", sessionId: "child-session" },
			},
		};
		const promptSpy = vi.spyOn(session as any, "_prompt");
		await session.acceptAgentMessagePrompt("ignored", { customMessage: parentMessage as any });
		const result = await waiting;
		expect(result).toMatchObject({ timedOut: false, message: "Use option C", messageId: "agentmsg_direct" });
		// Handed over, not also queued as a turn behind the waiting tool call.
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("session wait times out and later messages go back to the normal path", async () => {
		harness = await createHarness();
		const result = await harness.session.waitForParentAgentMessage(50);
		expect(result.timedOut).toBe(true);
		expect((harness.session as any)._parentMessageWaiters).toHaveLength(0);
	});

	it("unblocks and returns correct message content and id", async () => {
		let callCount = 0;
		(globalThis as any).host = {
			request: async (type: string, payload: any) => {
				// First call: empty, second+ call: message
				if (callCount++ === 0) {
					return { messages: [] };
				}
				const messageText = createAgentSessionMessagePrompt({
					id: "agentmsg_test_456",
					message: "Use option B",
					source: "agent_message",
					fromRelationship: "parent",
					from: { activeSessionId: "parent-session", sessionId: "parent-session" },
					target: { activeSessionId: "child-session", sessionId: "child-session" },
				});
				return {
					messages: [
						{
							index: 1,
							role: "custom",
							customType: "agent_message",
							text: messageText,
							timestamp: Date.now(),
							truncated: false,
						},
					],
				};
			},
		};

		// With 10ms poll: first poll (~10ms) empty, second poll (~20ms) message found
		const result = await waitForParentResponse({ timeoutMs: 3_000, pollIntervalMs: 10 });

		expect(result.timedOut).toBe(false);
		expect(result.message).toBe("Use option B");
		expect(result.messageId).toBe("agentmsg_test_456");
	});

	it("returns timedOut:true when no message arrives", async () => {
		(globalThis as any).host = {
			request: async (type: string, payload: any) => {
				return { messages: [] };
			},
		};

		const start = Date.now();
		const result = await waitForParentResponse({ timeoutMs: 300, pollIntervalMs: 50 });
		const elapsedMs = Date.now() - start;

		expect(result.timedOut).toBe(true);
		expect(elapsedMs).toBeGreaterThanOrEqual(300);
	});

	it("returns timedOut:true for zero timeout", async () => {
		(globalThis as any).host = {
			request: async (type: string, payload: any) => {
				const messageText = createAgentSessionMessagePrompt({
					id: "agentmsg_test_789",
					message: "Should not be seen",
					source: "agent_message",
					fromRelationship: "parent",
					from: { activeSessionId: "parent-session", sessionId: "parent-session" },
					target: { activeSessionId: "child-session", sessionId: "child-session" },
				});
				return {
					messages: [
						{
							index: 1,
							role: "custom",
							customType: "agent_message",
							text: messageText,
							timestamp: Date.now(),
							truncated: false,
						},
					],
				};
			},
		};

		const result = await waitForParentResponse(0);

		expect(result.timedOut).toBe(true);
	});

	it("rejects agent_message.send without message body", async () => {
		const mockController: AgentSessionMessageController = {
			roster: () => ({ agents: [] }),
			sendAgentMessage: vi.fn(),
		};
		harness = await createHarness({ agentMessageController: mockController });

		expect(() => {
			harness!.session.handleAgentMessageHostRequest("agent_message.send", {
				target: "parent",
			});
		}).toThrow("agent_message.send message must be a string");
	});
});
