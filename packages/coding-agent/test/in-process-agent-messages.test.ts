import { describe, expect, it } from "vitest";
import { createAgentMessageHostHandlers } from "../src/core/agent-messages.js";
import {
	createInProcessAgentMessageController,
	createInProcessAgentObserveController,
	type InProcessMessageSession,
} from "../src/core/in-process-agent-messages.js";

interface FakeSession extends InProcessMessageSession {
	children: FakeSession[];
	received: { text: string; options?: Record<string, any> }[];
	messages: any[];
}

const fake = (sessionId: string, sessionName: string, rlmDepth: number): FakeSession => {
	const session: FakeSession = {
		sessionId,
		sessionName,
		rlmDepth,
		isStreaming: false,
		isSessionActive: false,
		children: [],
		received: [],
		messages: [{ role: "user", content: `hello from ${sessionName}`, timestamp: 1 }],
		rlmDirectChildSessions: () => session.children,
		acceptAgentMessagePrompt: async (text, options) => {
			session.received.push({ text, options });
			(options as any)?.preflightResult?.(true, false);
		},
	};
	return session;
};

// A root with two subagents, as rlm.spawn builds them in-process.
const tree = () => {
	const root = fake("root-id", "root", 0);
	const s1 = fake("s1-id", "s1", 1);
	const s2 = fake("s2-id", "s2", 1);
	root.children.push(s1, s2);
	return {
		root,
		s1,
		s2,
		rootCtl: createInProcessAgentMessageController(() => root, undefined),
		s1Ctl: createInProcessAgentMessageController(() => s1, root),
	};
};

describe("in-process agent_message", () => {
	it("a subagent's roster is its parent and siblings; the root's is its children", async () => {
		const { rootCtl, s1Ctl } = tree();
		expect((await s1Ctl.roster!()).entries.map((e) => [e.relationship, e.name])).toEqual([
			["parent", "root"],
			["sibling", "s2"],
		]);
		expect((await rootCtl.roster!()).entries.map((e) => [e.relationship, e.name])).toEqual([
			["child", "s1"],
			["child", "s2"],
		]);
	});

	it("receiver_role parent reaches the parent, which sees the sender as its child", async () => {
		const { root, s1Ctl } = tree();
		const handlers = createAgentMessageHostHandlers(s1Ctl);
		const receipt = (await handlers["agent_message.send"]!({ message: "done: 42", receiver_role: "parent" })) as any;
		expect(receipt.deliveryStatus).toBe("delivered");
		expect(root.received).toHaveLength(1);
		const custom = root.received[0]!.options!.customMessage;
		expect(custom.details.message).toBe("done: 42");
		expect(custom.details.fromRelationship).toBe("child");
		expect(custom.details.from.sessionName).toBe("s1");
		expect(root.received[0]!.options!.streamingBehavior).toBe("steer");
	});

	it("sibling and child messages are addressed by name", async () => {
		const { s2, rootCtl, s1Ctl } = tree();
		await createAgentMessageHostHandlers(s1Ctl)["agent_message.send"]!({
			message: "hi sibling",
			receiver_role: "sibling",
			receiver_name: "s2",
		});
		expect(s2.received.at(-1)!.options!.customMessage.details.fromRelationship).toBe("sibling");
		await createAgentMessageHostHandlers(rootCtl)["agent_message.send"]!({
			message: "keep going",
			receiver_role: "child",
			receiver_name: "s2",
		});
		expect(s2.received.at(-1)!.options!.customMessage.details.fromRelationship).toBe("parent");
	});

	it("broadcast reaches every family member", async () => {
		const { root, s2, s1Ctl } = tree();
		const result = (await createAgentMessageHostHandlers(s1Ctl)["agent_message.send"]!({
			message: "all hands",
			target: "all",
		})) as any;
		expect(result.receipts).toHaveLength(2);
		expect(root.received).toHaveLength(1);
		expect(s2.received).toHaveLength(1);
	});

	it("refuses itself and sessions outside the family", async () => {
		const { s1Ctl } = tree();
		await expect(s1Ctl.sendAgentMessage({ target: "s1", message: "me" })).rejects.toThrow(/sending session/);
		await expect(s1Ctl.sendAgentMessage({ target: "stranger", message: "x" })).rejects.toThrow(/reach is limited/);
	});

	it("reports queued when the target is busy", async () => {
		const { root, s1Ctl } = tree();
		root.acceptAgentMessagePrompt = async (_text, options) => (options as any)?.preflightResult?.(true, true);
		const receipt = await s1Ctl.sendAgentMessage({ target: "root", message: "later", receiverRole: "parent" });
		expect(receipt.deliveryStatus).toBe("queued");
	});
});

describe("in-process agent_observe", () => {
	it("lists the family and reads a member's recent messages", async () => {
		const { root, s1 } = tree();
		const observe = createInProcessAgentObserveController(() => s1, root);
		const list = await observe.listAgents();
		expect(list.current.sessionName).toBe("s1");
		expect(list.agents.map((a) => a.sessionName)).toEqual(["root", "s2"]);
		const recent = await observe.recentMessages({ target: "root" });
		expect(recent.messages[0]!.text).toContain("hello from root");
		await expect(observe.getAgent("stranger")).rejects.toThrow(/reach is limited/);
	});
});
