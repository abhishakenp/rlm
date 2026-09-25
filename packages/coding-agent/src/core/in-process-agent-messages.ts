/**
 * `agent_message` between sessions that live in the same process.
 *
 * Upstream prime-agent builds its message controller only in daemon mode
 * (daemon-mode.ts `createAgentMessageController`), where the supervisor knows
 * every session. rlm runs sessions in-process — a root and the subagents it
 * spawned, recursively — so without this controller `agent_message.send` from a
 * subagent cell had nothing to talk to. The in-process tree already knows its
 * family: a session's parent, its parent's other children (siblings) and its own
 * children. Delivery is upstream's: the message becomes an agent-message custom
 * prompt on the target, steered into a running turn or starting one if idle
 * (`acceptAgentMessagePrompt` with `streamingBehavior: "steer"`, `queueIfBusy`).
 *
 * A daemon passes its own controller in the session config and this one is not
 * used; within a daemon worker a subagent tree still talks in-process through it.
 */
import {
	AGENT_FAMILY_REACH_ERROR,
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRelationship,
	type AgentFamilyRosterResult,
	type AgentFamilyStatus,
	type AgentSessionMessageAgentSummary,
	type AgentSessionMessageController,
	type AgentSessionMessageDeliveryStatus,
	type AgentSessionMessageEndpoint,
	type AgentSessionMessageListResult,
	type AgentSessionMessagePayload,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSendInput,
	createAgentSessionMessage,
	createAgentSessionMessageId,
	createAgentSessionMessageReceipt,
	normalizeAgentSessionMessage,
} from "./agent-messages.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentObserveAgentSummary,
	type AgentObserveController,
	createAgentObserveMessagePreview,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
} from "./agent-observe.js";

/** The slice of AgentSession this controller uses (structural, to avoid an import cycle). */
export interface InProcessMessageSession {
	readonly sessionId: string;
	readonly sessionName: string | undefined;
	readonly rlmDepth: number;
	readonly isStreaming: boolean;
	readonly isSessionActive: boolean;
	readonly isCompacting?: boolean;
	readonly messages?: AgentMessage[];
	readonly cwd?: string;
	rlmDirectChildSessions(): InProcessMessageSession[];
	acceptAgentMessagePrompt(text: string, options?: Record<string, unknown>): Promise<void>;
}

interface Member {
	session: InProcessMessageSession;
	relationship: AgentFamilyRelationship;
}

const endpoint = (session: InProcessMessageSession): AgentSessionMessageEndpoint => ({
	activeSessionId: session.sessionId,
	sessionId: session.sessionId,
	...(session.sessionName ? { sessionName: session.sessionName } : {}),
	runtimeKind: session.rlmDepth > 0 ? "subagent" : "top-level",
});

const statusOf = (session: InProcessMessageSession): AgentFamilyStatus =>
	session.isStreaming || session.isSessionActive ? "running" : "idle";

/** How the receiver sees the sender. */
const reverse = (relationship: AgentFamilyRelationship): AgentFamilyRelationship =>
	relationship === "parent" ? "child" : relationship === "child" ? "parent" : "sibling";

export function createInProcessAgentMessageController(
	self: () => InProcessMessageSession,
	parent: InProcessMessageSession | undefined,
): AgentSessionMessageController {
	const family = (): Member[] => {
		const me = self();
		const members: Member[] = [];
		if (parent) {
			members.push({ session: parent, relationship: "parent" });
			for (const sibling of parent.rlmDirectChildSessions()) {
				if (sibling.sessionId !== me.sessionId) members.push({ session: sibling, relationship: "sibling" });
			}
		}
		for (const child of me.rlmDirectChildSessions()) members.push({ session: child, relationship: "child" });
		return members;
	};

	const roster = (): AgentFamilyRosterResult => {
		const me = self();
		return {
			current: { name: me.sessionName ?? me.sessionId, id: me.sessionId, depth: me.rlmDepth },
			entries: family().map(({ session, relationship }) => ({
				relationship,
				name: session.sessionName ?? session.sessionId,
				id: session.sessionId,
				depth: session.rlmDepth,
				status: statusOf(session),
			})),
		};
	};

	const listAgents = (): AgentSessionMessageListResult => {
		const me = self();
		return {
			current: endpoint(me),
			agents: family().map(({ session }): AgentSessionMessageAgentSummary => ({
				...endpoint(session),
				cwd: session.cwd ?? me.cwd ?? process.cwd(),
				isStreaming: session.isStreaming,
				unfinishedActionCount: 0,
				rlmDepth: session.rlmDepth,
				status: statusOf(session),
			})),
		};
	};

	const sendAgentMessage = async (input: AgentSessionMessageSendInput): Promise<AgentSessionMessageReceipt> => {
		const me = self();
		const selector = input.target.trim();
		if (selector === me.sessionId || selector === me.sessionName) {
			throw new Error("Agent messaging cannot target the sending session");
		}
		const matches = family().filter(
			({ session, relationship }) =>
				(session.sessionId === selector || session.sessionName === selector) &&
				(input.receiverRole === undefined || input.receiverRole === relationship),
		);
		if (matches.length === 0) throw new Error(`${AGENT_FAMILY_REACH_ERROR}; no family member matches ${JSON.stringify(selector)}`);
		if (matches.length > 1) throw new Error(`Agent selector ${JSON.stringify(selector)} is ambiguous`);
		const { session: target, relationship } = matches[0]!;
		const payload: AgentSessionMessagePayload = {
			id: createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message: normalizeAgentSessionMessage(input.message),
			from: endpoint(me),
			fromRelationship: reverse(relationship),
			target: endpoint(target),
		};
		const message = createAgentSessionMessage(payload);
		let accepted = true;
		let queued = false;
		await target.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
			preflightResult: (didSucceed: boolean, didQueue?: boolean) => {
				accepted = didSucceed;
				queued = didSucceed && didQueue === true;
			},
		});
		if (!accepted) throw new Error("Agent message was not accepted");
		const status: AgentSessionMessageDeliveryStatus = queued ? "queued" : "delivered";
		return createAgentSessionMessageReceipt(payload, status);
	};

	return { listAgents, roster, sendAgentMessage };
}

/**
 * `agent_observe` over the same in-process family: read-only summaries and the
 * recent messages of a parent, sibling or child. Upstream builds this only in
 * daemon mode (daemon-mode.ts `createAgentObserveController`).
 */
export function createInProcessAgentObserveController(
	self: () => InProcessMessageSession,
	parent: InProcessMessageSession | undefined,
): AgentObserveController {
	const family = (): { session: InProcessMessageSession; relationship: AgentFamilyRelationship }[] => {
		const me = self();
		const members: { session: InProcessMessageSession; relationship: AgentFamilyRelationship }[] = [];
		if (parent) {
			members.push({ session: parent, relationship: "parent" });
			for (const sibling of parent.rlmDirectChildSessions()) {
				if (sibling.sessionId !== me.sessionId) members.push({ session: sibling, relationship: "sibling" });
			}
		}
		for (const child of me.rlmDirectChildSessions()) members.push({ session: child, relationship: "child" });
		return members;
	};
	const summary = (session: InProcessMessageSession): AgentObserveAgentSummary => {
		const me = self();
		const messages = session.messages ?? [];
		const latest = messages.at(-1);
		return {
			...endpoint(session),
			cwd: session.cwd ?? me.cwd ?? process.cwd(),
			status: statusOf(session),
			isCurrent: session.sessionId === me.sessionId,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting ?? false,
			attachedClients: 0,
			messageCount: messages.length,
			queuedCount: 0,
			isSessionActive: session.isSessionActive,
			...(session === me && parent ? { parentActiveSessionId: parent.sessionId, parentSessionId: parent.sessionId } : {}),
			...(latest ? { latestMessage: createAgentObserveMessagePreview(latest, messages.length - 1, 800) } : {}),
		};
	};
	const find = (target: string): InProcessMessageSession => {
		const selector = target.trim();
		const matches = family().filter(
			({ session }) => session.sessionId === selector || session.sessionName === selector,
		);
		if (matches.length === 0) throw new Error(`${AGENT_FAMILY_REACH_ERROR}; no family member matches ${JSON.stringify(selector)}`);
		if (matches.length > 1) throw new Error(`Agent selector ${JSON.stringify(selector)} is ambiguous`);
		return matches[0]!.session;
	};
	return {
		listAgents: async () => ({ current: summary(self()), agents: family().map(({ session }) => summary(session)) }),
		getAgent: async (target) => ({ agent: summary(find(target)) }),
		recentMessages: async (input) => {
			const session = find(input.target);
			const limit = normalizeObserveLimit(input.limit);
			const maxChars = normalizeObserveMaxChars(input.maxChars);
			const messages = session.messages ?? [];
			const startIndex = Math.max(0, messages.length - limit);
			return {
				agent: summary(session),
				messages: messages
					.slice(startIndex)
					.map((message, offset) => createAgentObserveMessagePreview(message, startIndex + offset, maxChars)),
				limit,
				maxChars,
				truncated: startIndex > 0,
			};
		},
	};
}
