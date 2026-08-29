import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { appendRotatingLog, getClientErrorLogPath } from "../../config.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import {
	BUILTIN_SLASH_COMMANDS,
	isBuiltinSlashCommandName,
	isSessionSlashCommandName,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
} from "../../core/slash-commands.js";
import { canonicalizePath } from "../../utils/paths.js";
import type { AgentConnectionHeartbeat, AgentConnectionSavedSessionInfo } from "../agent-connection/types.js";
import type { InteractiveModeUiServices } from "../interactive/interactive-mode-services.js";
import { ClientPromptStashStore } from "../interactive/prompt-stash-state.js";
import { theme } from "../interactive/theme/theme.js";
import type { StartupNotices } from "../shared/startup-notices.js";
import {
	type AgentsViewRow,
	type AgentsViewScopeFrame,
	type AgentsViewScopeKey,
	type AgentsViewSection,
	type AgentsViewSelectionKey,
	getAgentsViewSelectionKey,
	getAgentsViewSummaryIdentity as getSummaryIdentity,
	summaryForUnifiedRecord,
	type UnifiedSessionRecord,
} from "./agents-view-state.js";
import { type SessionSummary } from "./session-summary.js";

export interface AgentsViewModeOptions {
	config: AgentSessionRuntimeConfig;
	uiServices: InteractiveModeUiServices;
	createUiServicesForSession?: (summary: SessionSummary) => Promise<InteractiveModeUiServices>;
	migratedProviders?: string[];
	modelFallbackMessage?: string;
	startupModelId?: string;
	verbose?: boolean;
	promptStashStore?: ClientPromptStashStore;
	initialSession?: SessionSummary;
	/** When set, the first view is rooted at this session's direct children. */
	initialScopeKey?: AgentsViewScopeKey;
}

export type AgentsViewRunResult =
	| { type: "exit" }
	| {
			type: "scope_back";
			selection: SessionSummary;
			expandedAncestorSessionIds: string[];
			returnChat?: SessionSummary;
			hasChildren: boolean;
	  }
	| {
			type: "open";
			summary: SessionSummary;
			/** Row restored after chat closes; differs from summary only for an unattachable-child fallback. */
			selection?: SessionSummary;
			expandedAncestorSessionIds?: string[];
			hasChildren?: boolean;
			statusMessage?: string;
	  };
export type AgentsViewPersistentState = {
	selectedRowIdentity?: string;
	backSession?: SessionSummary;
	scopeFrames?: AgentsViewScopeFrame[];
	scopeRootSummary?: SessionSummary;
	selectedSessionKey?: AgentsViewSelectionKey;
	pendingExpandedAncestorSessionIds?: string[];
	expandedSubagentParents?: Set<string>;
	programShownParents?: Set<string>;
	statusMessage?: string;
	startupNotices?: StartupNotices;
	startupNoticesPromise?: Promise<StartupNotices>;
	query?: string;
	savedSessions?: AgentConnectionSavedSessionInfo[];
	lastSuccessfulSavedSessions?: AgentConnectionSavedSessionInfo[];
	lastSuccessfulLiveSummaries?: SessionSummary[];
	savedCatalogGeneration?: number;
	heartbeats?: AgentConnectionHeartbeat[];
};

export async function resolveAgentsViewSessionUiServices(
	options: Pick<AgentsViewModeOptions, "createUiServicesForSession" | "uiServices">,
	summary: SessionSummary,
): Promise<InteractiveModeUiServices> {
	return options.createUiServicesForSession ? await options.createUiServicesForSession(summary) : options.uiServices;
}

export function createAgentsViewResumeConfig(
	config: AgentSessionRuntimeConfig,
	overrideCwd?: string,
): AgentSessionRuntimeConfig {
	const resumeConfig: AgentSessionRuntimeConfig = { ...config };
	if (overrideCwd) {
		resumeConfig.cwd = overrideCwd;
	} else {
		delete resumeConfig.cwd;
	}
	return resumeConfig;
}

export function resolveAgentsViewActiveSummaryForPath(
	sessionPath: string,
	summaries: readonly SessionSummary[],
): SessionSummary | undefined {
	const selectedPath = resolvePath(canonicalizePath(sessionPath));
	return summaries.find(
		(summary) =>
			summary.activeSessionId !== undefined &&
			summary.sessionFile !== undefined &&
			resolvePath(canonicalizePath(summary.sessionFile)) === selectedPath,
	);
}

export function formatAgentsViewStatusLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function combineAgentsViewStartupNotices(...notices: readonly (string | undefined)[]): string | undefined {
	const formatted = notices
		.map((notice) => (notice ? formatAgentsViewStatusLine(notice) : ""))
		.filter((notice) => notice.length > 0);
	return formatted.length > 0 ? formatted.join(" · ") : undefined;
}

export function createAgentsViewReplyHeadline(text: string | undefined): string | undefined {
	return text
		?.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.find((line) => line.length > 0);
}

export function getAgentsViewDepth(scopeRoot: SessionSummary | undefined): number {
	return scopeRoot ? (scopeRoot.rlmDepth ?? 0) + 1 : 0;
}

export function createInitialAgentsViewScopeFrames(
	initialScopeKey: AgentsViewScopeKey | undefined,
	returnChat: SessionSummary | undefined,
): AgentsViewScopeFrame[] {
	if (!initialScopeKey) return [];
	return [
		{
			scope: initialScopeKey,
			...(returnChat?.sessionId === initialScopeKey.sessionId ? { returnChat } : {}),
		},
	];
}

export function createInitialAgentsViewPersistentState(
	options: Pick<AgentsViewModeOptions, "initialScopeKey" | "initialSession">,
): AgentsViewPersistentState {
	const initialSession = options.initialSession;
	return {
		...(initialSession
			? {
					selectedRowIdentity: getSummaryIdentity(initialSession),
					selectedSessionKey: getAgentsViewSelectionKey(initialSession),
					backSession: initialSession,
				}
			: {}),
		...(options.initialScopeKey
			? {
					scopeFrames: createInitialAgentsViewScopeFrames(options.initialScopeKey, initialSession),
					...(initialSession ? { lastSuccessfulLiveSummaries: [initialSession] } : {}),
				}
			: {}),
	};
}

export function createScopeBackReturnChatOpenResult(
	result: Extract<AgentsViewRunResult, { type: "scope_back" }>,
): Extract<AgentsViewRunResult, { type: "open" }> | undefined {
	if (!result.returnChat) return undefined;
	return {
		type: "open",
		summary: result.returnChat,
		expandedAncestorSessionIds: result.expandedAncestorSessionIds,
		hasChildren: result.hasChildren,
	};
}

export function resolveAgentsViewOpenCwd(
	summary: SessionSummary,
	fallbackCwd: string | undefined,
): { overrideCwd?: string; notice?: string } {
	if (!summary.cwd || existsSync(summary.cwd) || !fallbackCwd) {
		return {};
	}
	return {
		overrideCwd: fallbackCwd,
		notice: `Original directory is missing (${summary.cwd}); opened in ${fallbackCwd} instead.`,
	};
}

/**
 * The agents view requires a background service to list live sessions.
 * In in-process mode, this is not available.
 */
export async function runAgentsViewMode(_options: AgentsViewModeOptions): Promise<void> {
	throw new Error("The agents view is not available in in-process mode");
}

const AGENTS_VIEW_COMMAND_NAMES = ["name", "kill"] as const;
export type AgentsViewCommandName = (typeof AGENTS_VIEW_COMMAND_NAMES)[number];
const AGENTS_VIEW_COMMAND_NAME_SET: ReadonlySet<string> = new Set(AGENTS_VIEW_COMMAND_NAMES);

export interface AgentsViewCommand {
	name: AgentsViewCommandName;
	args: string;
}

export function parseAgentsViewCommand(text: string): AgentsViewCommand | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	const name = resolveBuiltinSlashCommandName(parsed.name);
	if (!AGENTS_VIEW_COMMAND_NAME_SET.has(name)) return undefined;
	return { name: name as AgentsViewCommandName, args: parsed.args };
}

export function getReplyComposerCommandRejection(text: string): string | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	const name = resolveBuiltinSlashCommandName(parsed.name);
	if (isSessionSlashCommandName(name)) return undefined;
	if (AGENTS_VIEW_COMMAND_NAME_SET.has(name)) return undefined;
	if (!isBuiltinSlashCommandName(parsed.name)) return undefined;
	return `/${parsed.name} is not available here; open the session to run it`;
}

const AGENTS_VIEW_COMMAND_DESCRIPTIONS: Record<AgentsViewCommandName, { description: string; argumentHint?: string }> =
	{
		name: { description: "Set session display name", argumentHint: "<name>" },
		kill: { description: "Stop this agent's runtime (session stays resumable)" },
	};

function agentsViewSlashCommands(): {
	name: string;
	aliases?: readonly string[];
	description: string;
	argumentHint?: string;
	takesArgument?: boolean;
}[] {
	return AGENTS_VIEW_COMMAND_NAMES.map((name) => {
		const builtin = BUILTIN_SLASH_COMMANDS.find((command) => command.name === name);
		const display = AGENTS_VIEW_COMMAND_DESCRIPTIONS[name];
		return {
			name,
			aliases: builtin?.aliases,
			description: display.description,
			argumentHint: display.argumentHint ?? builtin?.argumentHint,
			takesArgument: name === "name" ? true : builtin?.takesArgument,
		};
	});
}

export function createReplyComposerAutocompleteProvider(cwd: string, fdPath?: string): AutocompleteProvider {
	const sessionCommands = BUILTIN_SLASH_COMMANDS.filter((command) => isSessionSlashCommandName(command.name)).map(
		(command) => ({
			name: command.name,
			aliases: command.aliases,
			description: command.description,
			argumentHint: command.argumentHint,
			takesArgument: command.takesArgument,
		}),
	);
	return new CombinedAutocompleteProvider([...sessionCommands, ...agentsViewSlashCommands()], cwd, fdPath ?? null);
}

export function resolveCurrentReplyTargetSummary(
	records: readonly UnifiedSessionRecord[],
	target: { key: string; summary: SessionSummary },
	findLive: (activeSessionId: string) => SessionSummary | undefined,
): SessionSummary {
	const identity = getSummaryIdentity(target.summary);
	const current = records.find((record) => record.identity === identity || record.identityAliases.includes(identity));
	if (current) return summaryForUnifiedRecord(current);
	const live = target.summary.activeSessionId ? findLive(target.summary.activeSessionId) : undefined;
	if (live) return live;
	if (target.summary.sessionFile && target.summary.activeSessionId) {
		return { ...target.summary, activeSessionId: undefined, lifecycle: "archived", activity: "idle" };
	}
	return target.summary;
}

// --- Rendering helpers (kept for tests and external consumers) ---

type DisplayItem =
	| { type: "spacer" }
	| { type: "heading"; section: AgentsViewSection }
	| { type: "empty"; section: AgentsViewSection }
	| { type: "row"; row: AgentsViewRow };

function buildDisplayItems(rows: readonly AgentsViewRow[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	const sections: AgentsViewSection[] = ["running", "idle", "inactive"];
	for (const [index, section] of sections.entries()) {
		if (index > 0) {
			items.push({ type: "spacer" });
		}
		items.push({ type: "heading", section });
		const sectionRows = getDisplayRowsForSection(rows, section);
		if (sectionRows.length === 0) {
			items.push({ type: "empty", section });
			continue;
		}
		for (const row of sectionRows) {
			items.push({ type: "row", row });
		}
	}
	return items;
}

function getDisplayRowsForSection(rows: readonly AgentsViewRow[], section: AgentsViewSection): AgentsViewRow[] {
	const result: AgentsViewRow[] = [];
	let include = false;
	for (const row of rows) {
		if (row.depth === 0) {
			include = row.section === section;
		}
		if (include) {
			result.push(row);
		}
	}
	return result;
}

function countRowsBySection(rows: readonly AgentsViewRow[]): Record<AgentsViewSection, number> {
	const agents = rows.filter((row) => row.kind === "agent");
	return {
		running: agents.filter((row) => row.section === "running").length,
		idle: agents.filter((row) => row.section === "idle").length,
		inactive: agents.filter((row) => row.section === "inactive").length,
	};
}

function getSelectedRowIdentity(row: AgentsViewRow | undefined): string | undefined {
	return row?.identity;
}

function rowHasSpawnCode(row: AgentsViewRow): boolean {
	const code = row.summary.spawnCode;
	return typeof code === "string" && code.trim().length > 0;
}

function isRunningSessionSummary(summary: SessionSummary): boolean {
	return summary.activity === "working";
}

function styleRowTitle(row: AgentsViewRow): string {
	if (row.summary.sessionName?.replace(/\s+/g, " ").trim()) {
		return theme.bold(row.title);
	}
	if (row.title === "(no messages)") {
		return theme.italic(row.title);
	}
	return row.title;
}

function formatTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function formatRightTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
}

function formatSessionDuration(summary: SessionSummary): string {
	return formatAgentsViewRelativeTime(
		summary.activeSessionId ? (summary.created ?? summary.modified) : (summary.modified ?? summary.created),
	);
}

export function formatAgentsViewRelativeTime(value: string | undefined, now: number = Date.now()): string {
	const timestamp = parseSessionTimestamp(value);
	if (!timestamp) {
		return "";
	}
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function parseSessionTimestamp(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionSummary(value: unknown): value is SessionSummary {
	return isRecord(value) && typeof value.id === "string" && typeof value.sessionId === "string";
}

export { isSessionSummary };

function formatError(prefix: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return formatAgentsViewStatusLine(`${prefix}: ${message}`);
}

function logClientError(prefix: string, error: unknown): void {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	appendRotatingLog(getClientErrorLogPath(), `[${new Date().toISOString()}] ${prefix}: ${detail}`);
}

function padLine(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
