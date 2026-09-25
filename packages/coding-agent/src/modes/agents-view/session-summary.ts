import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.js";
import type { SessionActionSnapshot } from "../../core/session-action-store.js";
import type { AgentTaskState } from "../../core/session-manager.js";
import type { SessionUsageSummary } from "../../core/usage.js";
import type { AgentRosterStatus } from "./agent-roster.js";

// prime-agent's `daemon/daemon-session-list.ts` session shape (v0.9.6). rlm has
// no daemon, so the shape lives with the agents view that consumes it.

export { classifySessionRosterStatus, isSessionSummaryBusy } from "./agent-roster.js";
export type { AgentRosterStatus as SessionRosterStatus } from "./agent-roster.js";

// Durable lifecycle; decides agents-view visibility. Only "live" is shown.
// "draft" = no message sent yet (discarded on close); "archived" = ctrl+x'd,
// reachable only via --resume <selector>.
export type SessionLifecycle = "draft" | "live" | "archived";

// Heuristic activity of a live session. Classification-in-flight counts as
// "working" so the view never sees an unlabeled idle session.
export type SessionActivity = "working" | "idle";

// Lightweight session shape used by the agents view and session listing.
export interface SessionSummary {
	id: string;
	lifecycle: SessionLifecycle;
	activity: SessionActivity;
	isSessionActive: boolean;
	hasActiveHeartbeat?: boolean;
	/** Any active heartbeat registered for this session. Paused heartbeats do not pin residency. */
	hasRegisteredHeartbeat?: boolean;
	/** Any active or paused non-heartbeat scheduled job registered for this session. */
	hasRegisteredCronJob?: boolean;
	/** Latest message activity, used by the residency policy. */
	lastActivityAt?: string;
	runtimeKind?: "top-level" | "subagent";
	/** RLM spawn depth (0 for roots); fork edges preserve the source depth. */
	rlmDepth?: number;
	activeSessionId?: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning?: boolean;
	hasRunningRlmChildren?: boolean;
	usage?: SessionUsageSummary;
	/** True while the agent is streaming with tool calls pending; drives the "running tools" label. */
	isRunningTools?: boolean;
	attachedClients: number;
	/** Clients attached over the direct worker transport; the supervisor adds these to its own count. */
	directAttachedClients?: number;
	messageCount: number;
	unfinishedActionCount?: number;
	sessionActions: SessionActionSnapshot;
	streamingMessage?: AgentMessage;
	created?: string;
	modified?: string;
	firstMessage?: string;
	parentActiveSessionId?: string;
	parentSessionId?: string;
	parentSessionPath?: string;
	rlmChildId?: string;
	repliedSinceTask?: boolean;
	rlmParentNodeId?: string;
	/** Source of the Code cell that spawned this subagent, for display. */
	spawnCode?: string;
	modelFallbackMessage?: string;
	diagnostics?: AgentSessionRuntimeDiagnostic[];
	/** One-line background summary of what the agent is doing or just did. */
	summary?: string;
	/** Completion verdict for an idle session; absent while working or unjudged. */
	taskState?: AgentTaskState;
	rosterStatus?: AgentRosterStatus;
	statusLabel?: "queued" | "recovering" | "failed";
	/** Set while the owning worker has been silent past the staleness threshold. */
	lastHeardFromAt?: string;
	/** Resident session-host process state. */
	workerState?: "starting" | "ready" | "recovering" | "stopping" | "failed";
	/** Diagnostic process identity; clients must not use this as a stable session identifier. */
	workerPid?: number;
}

/**
 * Pick the model fallback message to show when attaching to a session.
 */
export function resolveAttachModelFallbackMessage(
	summary: SessionSummary,
	startupModelFallbackMessage: string | undefined,
): string | undefined {
	if (summary.modelFallbackMessage) {
		return summary.modelFallbackMessage;
	}
	return summary.model ? undefined : startupModelFallbackMessage;
}
