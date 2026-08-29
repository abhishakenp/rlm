/**
 * Run modes for the coding agent.
 */

export type {
	AgentConnection,
	AgentConnectionArtifactReference,
	AgentConnectionArtifactType,
	AgentConnectionEvent,
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
	AgentConnectionModel,
	AgentConnectionModelCycleResult,
	AgentConnectionQueueState,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionEvent,
	AgentConnectionSlashCommand,
	AgentConnectionState,
} from "./agent-connection/index.js";
export { InProcessAgentConnection } from "./agent-connection/index.js";
export {
	type AgentsViewRow,
	type AgentsViewScopeFrame,
	type AgentsViewScopeKey,
	type AgentsViewSection,
	type AgentsViewSelectionKey,
	aggregateSessionHeartbeats,
	buildAgentsViewRows,
	buildUnifiedSessionIndex,
	classifyAgentsViewSession,
	createUnattachableChildOpenResult,
	filterUnifiedSessions,
	formatHeartbeatBadge,
	getAgentsViewSelectionKey,
	getAgentsViewSessionTitle,
	getUnifiedSessionAncestorSessionIds,
	hasUnifiedSessionChildren,
	reconcileUnifiedSessions,
	resolveAgentsViewLeftResult,
	resolveAgentsViewScopeFrames,
	resolveAgentsViewSelectionIndex,
	resolveAgentsViewSelectionState,
	scopeToSessionSubtree,
	sectionTitle,
	shouldApplyScopeResolution,
	shouldShowAgentsViewSession,
	transitionAgentsViewScope,
	type UnifiedSessionHeartbeat,
	type UnifiedSessionIndex,
	type UnifiedSessionRecord,
} from "./agents-view/agents-view-state.js";
export type { SessionActivity, SessionLifecycle, SessionSummary } from "./agents-view/session-summary.js";
export { resolveAttachModelFallbackMessage } from "./agents-view/session-summary.js";
export {
	type InteractiveInitialPrompt,
	InteractiveMode,
	type InteractiveModeOptions,
	type InteractiveModeRunResult,
} from "./interactive/interactive-mode.js";
export {
	createInteractiveModeLocalSessionHost,
	createInteractiveModeUiServices,
	createInteractiveModeUiServicesFromServices,
	type InteractiveModeLocalSessionHost,
	type InteractiveModeUiServices,
} from "./interactive/interactive-mode-services.js";
export {
	ClientPromptStashStore,
	type PromptStash,
	type PromptStashState,
} from "./interactive/prompt-stash-state.js";
export { type PrintModeOptions, runPrintMode, runPrintModeWithConnection } from "./print-mode.js";
