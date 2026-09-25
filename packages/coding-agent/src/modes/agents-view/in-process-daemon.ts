/**
 * The agents view's daemon, in-process.
 *
 * prime-agent's agents view is written against a daemon: it lists sessions,
 * attaches chats, renames, kills and replies through `DaemonClient.request`,
 * and every session — top-level agents and their recursive RLM subagents — is
 * a runtime the daemon hosts. rlm has no daemon. Its sessions are
 * `AgentSessionRuntime`s in this process: the one the renderer row created,
 * and under it every subagent runtime, each hosting its own children.
 *
 * So this module gives the view the daemon client's exact surface, backed by
 * that runtime tree, and the view itself stays prime-agent's code. Names keep
 * the daemon spelling on purpose: the view imports them unchanged.
 *
 * A view finds its host through `socketPath`, which for an in-process host is
 * the `inprocess:` key the host registered under.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { compactRlmText, type ExtensionBindings } from "../../core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { type DeleteSessionFileResult, deleteSessionFile } from "../../core/session-file-actions.js";
import { getSessionsDir } from "../../config.js";
import { listSessionCatalog } from "../../core/session-catalog.js";
import { SessionManager } from "../../core/session-manager.js";
import {
	addAssistantUsage,
	emptyUsage,
	type SessionUsageSummary,
	sessionUsageSummaryFrom,
	subtractAssistantUsage,
} from "../../core/usage.js";
import { InProcessAgentConnection } from "../agent-connection/in-process-agent-connection.js";
import type {
	AgentConnection,
	AgentConnectionHeartbeat,
	AgentConnectionSavedSessionInfo,
	AgentConnectionSavedSessionScope,
	AgentConnectionSessionListCallbacks,
} from "../agent-connection/types.js";
import {
	createInteractiveModeLocalSessionHost,
	type InteractiveModeLocalSessionHost,
} from "../interactive/interactive-mode-services.js";
import { type AgentRosterEntry, AgentRoster, workerRosterEntryFromSummary } from "./agent-roster.js";
import type { SessionSummary } from "./session-summary.js";

// ─── protocol shapes the view uses ──────────────────────────────────────────

export type DaemonClosingReason = "shutdown" | "update";

export type DaemonCommand =
	| { id?: string; type: "list"; all?: boolean; cwd?: string; sessionDir?: string; includeClientOwned?: boolean }
	| {
			id?: string;
			type: "create";
			sessionPath?: string;
			name?: string;
			config?: AgentSessionRuntimeConfig;
			env?: Record<string, string>;
	  }
	| { id?: string; type: "kill"; activeSessionId: string }
	| { id?: string; type: "rename"; activeSessionId: string; name: string }
	| {
			id?: string;
			type: "prompt";
			activeSessionId: string;
			message: string;
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "cancel_rlm_child"; activeSessionId: string; childId: string }
	| { id?: string; type: "delete_rlm_subagent"; activeSessionId: string; childId: string }
	| { id?: string; type: "get_last_assistant_text"; activeSessionId: string }
	| { id?: string; type: "heartbeats_list"; activeSessionId?: string }
	| ({ id?: string; type: "list_saved_sessions"; scope: AgentConnectionSavedSessionScope } & (
			| { activeSessionId: string }
			| { cwd: string; sessionDir?: string }
	  ))
	| { id?: string; type: "rename_saved_session"; activeSessionId?: string; sessionPath: string; name: string }
	| { id?: string; type: "delete_saved_session"; activeSessionId?: string; sessionPath: string }
	| { id?: string; type: "roster_subscribe" }
	| { id?: string; type: "roster_unsubscribe" };

/** Progress the daemon streams while a saved-session list loads. */
export type DaemonRequestProgress =
	| { type: "session_list_progress"; command: "list_saved_sessions"; loaded: number; total: number }
	| { type: "session_list_session"; command: "list_saved_sessions"; session: AgentConnectionSavedSessionInfo };

export interface DaemonRequestOptions {
	onProgress?: (update: DaemonRequestProgress) => void;
	recoverable?: boolean;
}

export type DaemonResponse = { success: true; data?: unknown } | { success: false; error: string };

export type DaemonServerCapability = "delete_rlm_subagent" | "heartbeat_catalog" | "agent_roster";

/** What the host pushes to a subscribed client. */
export type DaemonOutbound =
	| { type: "daemon_hello"; capabilities: DaemonServerCapability[] }
	| { type: "roster_update"; changed: AgentRosterEntry[]; removed?: string[]; resync?: true }
	| { type: "heartbeats_changed" };

export type DaemonHello = Extract<DaemonOutbound, { type: "daemon_hello" }>;

export type DaemonClientMessage = DaemonOutbound;

/** The transport surface prime-agent's roster store holds. */
export interface DaemonTransportClient {
	readonly hello: DaemonHello | undefined;
	readonly isConnected: boolean;
	supportsServerCapability(capability: DaemonServerCapability): boolean;
	waitForHello(timeoutMs?: number): Promise<DaemonHello>;
	onMessage(listener: (message: DaemonOutbound) => void): () => void;
	request(command: DaemonCommand, timeoutMs?: number, options?: DaemonRequestOptions): Promise<DaemonResponse>;
}

/** A daemon worker recovering a session. In-process sessions never recover, so this is never thrown. */
export class DaemonSessionRecoveringError extends Error {
	readonly code = "session_recovering" as const;

	constructor(readonly activeSessionId: string) {
		super(`Active session ${activeSessionId} is recovering; retry shortly`);
		this.name = "DaemonSessionRecoveringError";
	}
}

/** The supervisor/worker control plane dropping a request. Never thrown in-process. */
export class DaemonControlPlaneTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonControlPlaneTransportError";
	}
}

/** A daemon preparing an update restart. Never thrown in-process. */
export class DaemonUpdateRestartingError extends Error {
	readonly code = "update_restarting" as const;

	constructor(message = "Daemon is preparing an update restart") {
		super(message);
		this.name = "DaemonUpdateRestartingError";
	}
}

/** An in-process host is never restarting for an update. */
export function isDaemonUpdateRestartingError(error: unknown): boolean {
	return error instanceof Error && error.message === "Daemon is preparing an update restart";
}

export function isSessionSummary(value: unknown): value is SessionSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { id?: unknown }).id === "string" &&
		typeof (value as { sessionId?: unknown }).sessionId === "string"
	);
}

export function isUnknownDaemonCommandError(error: unknown, command: string): boolean {
	return error instanceof Error && error.message.includes(`Unknown daemon command: ${command}`);
}

/** There is no daemon process to hand terminal identity to. */
export function collectDaemonClientEnv(): Record<string, string> | undefined {
	return undefined;
}

/** prime-agent's closed-socket error. An in-process host never closes underneath its client. */
export class DaemonSocketClosedError extends Error {
	constructor(
		socketPath: string,
		readonly daemonClosingReason?: DaemonClosingReason,
		cause?: string,
	) {
		const reasonDetails = daemonClosingReason ? ` Reason: ${daemonClosingReason}.` : "";
		const causeDetails = cause ? ` Cause: ${cause}.` : "";
		super(`Connection to the agents host closed.${reasonDetails}${causeDetails} (${socketPath})`);
		this.name = "DaemonSocketClosedError";
	}
}

export function getDaemonSocketCloseReason(error: Error): DaemonClosingReason | undefined {
	return error instanceof DaemonSocketClosedError ? error.daemonClosingReason : undefined;
}

// ─── the host ───────────────────────────────────────────────────────────────

export interface CreateTopLevelRuntimeOptions {
	/** Resume this saved session file; absent for a fresh session. */
	sessionPath?: string;
	config?: AgentSessionRuntimeConfig;
}

export interface InProcessAgentsHostOptions {
	/** How the view creates a new agent (ctrl+n) or resumes an inactive one. */
	createTopLevelRuntime?: (options: CreateTopLevelRuntimeOptions) => Promise<AgentSessionRuntime>;
}

interface HostedRuntime {
	activeSessionId: string;
	runtime: AgentSessionRuntime;
	parent?: HostedRuntime;
}

// On globalThis, not in module scope: hot reload re-evaluates this module, and
// a fresh map would lose the host a running view registered with the old one.
const HOSTS_KEY = Symbol.for("rlm.agents-view.in-process-hosts");
const hosts: Map<string, InProcessAgentsHost> = ((globalThis as Record<symbol, unknown>)[HOSTS_KEY] ??= new Map()) as Map<
	string,
	InProcessAgentsHost
>;

export function getInProcessAgentsHost(socketPath: string): InProcessAgentsHost | undefined {
	return hosts.get(socketPath);
}

export class InProcessAgentsHost {
	readonly socketPath = `inprocess:${randomUUID()}`;
	private readonly topLevel: AgentSessionRuntime[] = [];
	private readonly ids = new WeakMap<AgentSessionRuntime, string>();
	private readonly usedIds = new Set<string>();
	/** Sessions whose `session_start` has been announced to extensions. */
	private readonly startedSessions = new WeakSet<object>();
	private readonly attachedClients = new Map<string, number>();
	private readonly rosterListeners = new Set<(message: DaemonOutbound) => void>();
	private rosterTimer: ReturnType<typeof setInterval> | undefined;
	private lastRoster = new Map<string, string>();
	private disposed = false;

	constructor(
		root: AgentSessionRuntime,
		private readonly options: InProcessAgentsHostOptions = {},
	) {
		this.topLevel.push(root);
		hosts.set(this.socketPath, this);
	}

	/** Stable per runtime, like a daemon's active-session id; survives /new inside the chat. */
	activeSessionIdFor(runtime: AgentSessionRuntime): string {
		let id = this.ids.get(runtime);
		if (id) return id;
		id = runtime.session.sessionId;
		while (this.usedIds.has(id)) id = `${runtime.session.sessionId}-${randomUUID().slice(0, 4)}`;
		this.usedIds.add(id);
		this.ids.set(runtime, id);
		return id;
	}

	/** Every hosted runtime, parents before children. */
	listHosted(): HostedRuntime[] {
		const out: HostedRuntime[] = [];
		const visit = (runtime: AgentSessionRuntime, parent: HostedRuntime | undefined) => {
			const hosted: HostedRuntime = { activeSessionId: this.activeSessionIdFor(runtime), runtime, parent };
			out.push(hosted);
			for (const child of runtime.listSubagentRuntimes()) visit(child, hosted);
		};
		for (const runtime of this.topLevel) visit(runtime, undefined);
		return out;
	}

	private childSessionIds = new Map<string, string>();
	private childIndexBuiltAt = 0;

	/**
	 * The active-session id of the runtime hosting RLM child `childId`.
	 *
	 * Asked for every `rlm_child_update` a chat receives. It used to walk the
	 * whole hosted tree each time — O(subagents) per update, O(N²) overall, and
	 * at 200 subagents the walk (listHosted → visit) was 17.8% of all CPU while
	 * they were created. Now an index, rebuilt only on a miss and at most every
	 * 100 ms: a child whose runtime is still being built gets stamped by its
	 * next update instead of costing a full walk per event.
	 */
	activeSessionIdForChild(childId: string): string | undefined {
		const known = this.childSessionIds.get(childId);
		if (known) return known;
		const now = Date.now();
		if (now - this.childIndexBuiltAt < 100) return undefined;
		this.childIndexBuiltAt = now;
		for (const hosted of this.listHosted()) {
			const id = hosted.runtime.metadata.rlmChildId;
			if (id) this.childSessionIds.set(id, hosted.activeSessionId);
		}
		return this.childSessionIds.get(childId);
	}

	findHosted(activeSessionId: string): HostedRuntime {
		const hosted = this.listHosted().find((candidate) => candidate.activeSessionId === activeSessionId);
		if (!hosted) throw new Error(`Unknown active session: ${activeSessionId}`);
		return hosted;
	}

	/** Mark a session whose `session_start` already fired (the renderer's root, every subagent). */
	markStarted(runtime: AgentSessionRuntime): void {
		this.startedSessions.add(runtime.session);
	}

	/** Attach a chat. Detach-only: closing the chat leaves the session running. */
	attach(activeSessionId: string): { connection: AgentConnection; localSessionHost: InteractiveModeLocalSessionHost } {
		const hosted = this.findHosted(activeSessionId);
		const { runtime } = hosted;
		const connection = new InProcessAgentConnection(runtime, { activeSessionId, disposeRuntime: false });
		this.attachedClients.set(activeSessionId, (this.attachedClients.get(activeSessionId) ?? 0) + 1);
		const release = () => {
			const remaining = (this.attachedClients.get(activeSessionId) ?? 1) - 1;
			if (remaining > 0) this.attachedClients.set(activeSessionId, remaining);
			else this.attachedClients.delete(activeSessionId);
		};
		// A daemon stamps each child snapshot with the child's active-session id
		// (prime-agent's buildRlmChildSnapshots). The tray reads residency off it,
		// so stamp the in-process snapshots the same way.
		const stamp = <T extends { id: string; activeSessionId?: string }>(child: T): T => {
			if (child.activeSessionId) return child;
			const activeSessionId = this.activeSessionIdForChild(child.id);
			return activeSessionId ? { ...child, activeSessionId } : child;
		};
		const subscribe = connection.subscribe.bind(connection);
		connection.subscribe = (listener) =>
			subscribe((event) => {
				if (event.type === "session_event" && event.event.type === "rlm_child_update") {
					return listener({ ...event, event: { ...event.event, child: stamp(event.event.child) } } as typeof event);
				}
				return listener(event);
			});
		const getInitialSnapshot = connection.getInitialSnapshot.bind(connection);
		connection.getInitialSnapshot = async () => {
			const snapshot = await getInitialSnapshot();
			return snapshot.children ? { ...snapshot, children: snapshot.children.map(stamp) } : snapshot;
		};
		const getRlmChildSnapshots = connection.getRlmChildSnapshots.bind(connection);
		connection.getRlmChildSnapshots = async () => (await getRlmChildSnapshots()).map(stamp);
		const dispose = connection.dispose.bind(connection);
		let released = false;
		connection.dispose = async () => {
			if (!released) {
				released = true;
				release();
			}
			await dispose();
		};
		const base = createInteractiveModeLocalSessionHost(runtime);
		// Subagents announced session_start when their runtime was created.
		if (hosted.parent) this.startedSessions.add(runtime.session);
		const localSessionHost: InteractiveModeLocalSessionHost = {
			...base,
			bindExtensions: async (bindings: ExtensionBindings) => {
				const session = runtime.session;
				if (this.startedSessions.has(session)) {
					session.rebindExtensionUi(bindings);
					return;
				}
				this.startedSessions.add(session);
				await base.bindExtensions(bindings);
			},
		};
		return { connection, localSessionHost };
	}

	summaries(): SessionSummary[] {
		return this.listHosted().map((hosted) => this.summaryFor(hosted));
	}

	summaryFor(hosted: HostedRuntime): SessionSummary {
		return summaryForHostedRuntime(hosted, this.attachedClients.get(hosted.activeSessionId) ?? 0);
	}

	async request(command: DaemonCommand, requestOptions?: DaemonRequestOptions): Promise<DaemonResponse> {
		try {
			return { success: true, data: await this.handle(command, requestOptions) };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async handle(command: DaemonCommand, requestOptions?: DaemonRequestOptions): Promise<unknown> {
		switch (command.type) {
			case "list_saved_sessions": {
				const onProgress = requestOptions?.onProgress;
				const sessions = await this.listSavedSessions(command, command.scope, {
					onProgress: (loaded, total) =>
						onProgress?.({ type: "session_list_progress", command: "list_saved_sessions", loaded, total }),
					onSession: (session) =>
						onProgress?.({ type: "session_list_session", command: "list_saved_sessions", session }),
				});
				return { sessions };
			}
			case "rename_saved_session":
				await this.renameSavedSession(command.sessionPath, command.name);
				return undefined;
			case "delete_saved_session":
				return this.deleteSavedSession(command.sessionPath);
			case "list":
				return { sessions: this.summaries() };
			case "create":
				return this.create(command);
			case "kill":
				await this.kill(command.activeSessionId);
				return undefined;
			case "rename": {
				const hosted = this.findHosted(command.activeSessionId);
				const name = command.name.trim();
				if (!name) throw new Error("Session name cannot be empty");
				hosted.runtime.session.setSessionName(name);
				return this.summaryFor(hosted);
			}
			case "prompt":
				await this.prompt(command.activeSessionId, command.message, command.streamingBehavior);
				return undefined;
			case "cancel_rlm_child": {
				const owner = this.findChildOwner(command.activeSessionId, command.childId);
				return { cancelled: owner?.runtime.session.cancelRlmChildRun(command.childId) ?? false };
			}
			case "delete_rlm_subagent": {
				const owner = this.findChildOwner(command.activeSessionId, command.childId);
				if (!owner) return { deleted: false };
				const child = this.listHosted().find(
					(candidate) => candidate.runtime.metadata.rlmChildId === command.childId,
				);
				const isRunning = () =>
					child !== undefined &&
					(child.runtime.session.isStreaming || child.runtime.session.unfinishedActionCount > 0);
				const result = isRunning()
					? "running"
					: await owner.runtime.session.deleteInactiveRlmSubagent(command.childId, isRunning);
				return { deleted: result === "deleted", ...(result === "running" ? { reason: "running" } : {}) };
			}
			case "get_last_assistant_text":
				return { text: this.findHosted(command.activeSessionId).runtime.session.getLastAssistantText() };
			case "heartbeats_list":
				return { heartbeats: [] };
			case "roster_subscribe":
				return { roster: this.snapshotRoster() };
			case "roster_unsubscribe":
				return undefined;
			default: {
				const unknown = command as { type: string };
				throw new Error(`Unknown daemon command: ${unknown.type}`);
			}
		}
	}

	/** The session whose run tracker owns `childId`: the named one, else whichever in the tree does. */
	private findChildOwner(activeSessionId: string, childId: string): HostedRuntime | undefined {
		const all = this.listHosted();
		const named = all.find((candidate) => candidate.activeSessionId === activeSessionId);
		if (named?.runtime.session.getRlmChildRunStatus(childId) !== undefined) return named;
		const child = all.find((candidate) => candidate.runtime.metadata.rlmChildId === childId);
		if (child?.parent) return child.parent;
		return all.find((candidate) => candidate.runtime.session.getRlmChildRunStatus(childId) !== undefined) ?? named;
	}

	private async create(command: Extract<DaemonCommand, { type: "create" }>): Promise<SessionSummary> {
		if (command.sessionPath) {
			const wanted = resolve(command.sessionPath);
			const resident = this.listHosted().find(
				(hosted) => hosted.runtime.session.sessionFile && resolve(hosted.runtime.session.sessionFile) === wanted,
			);
			if (resident) return this.summaryFor(resident);
		}
		if (!this.options.createTopLevelRuntime) {
			throw new Error("This rlm host cannot start another agent");
		}
		const runtime = await this.options.createTopLevelRuntime({
			sessionPath: command.sessionPath,
			config: command.config,
		});
		if (command.name) runtime.session.setSessionName(command.name);
		this.topLevel.push(runtime);
		return this.summaryFor(this.findHosted(this.activeSessionIdFor(runtime)));
	}

	private async kill(activeSessionId: string): Promise<void> {
		const hosted = this.findHosted(activeSessionId);
		const index = this.topLevel.indexOf(hosted.runtime);
		if (index !== -1) {
			// A top-level agent the view stops is closed, as the daemon closes it.
			this.topLevel.splice(index, 1);
			await hosted.runtime.dispose();
			return;
		}
		// A subagent belongs to its parent's run: stop the run and the child's turn.
		const childId = hosted.runtime.metadata.rlmChildId;
		if (childId && hosted.parent) hosted.parent.runtime.session.cancelRlmChildRun(childId);
		await hosted.runtime.session.abort();
	}

	private async prompt(
		activeSessionId: string,
		message: string,
		streamingBehavior: "steer" | "followUp" | undefined,
	): Promise<void> {
		const session = this.findHosted(activeSessionId).runtime.session;
		// Resolve on admission, not completion, exactly like the daemon's `prompt`.
		await new Promise<void>((resolveAdmission, rejectAdmission) => {
			let settled = false;
			const settle = (error?: unknown) => {
				if (settled) return;
				settled = true;
				if (error) rejectAdmission(error);
				else resolveAdmission();
			};
			session
				.prompt(message, {
					streamingBehavior,
					queueIfBusy: streamingBehavior !== undefined,
					resumeIfIdle: streamingBehavior !== undefined,
					preflightResult: (didSucceed) =>
						settle(didSucceed ? undefined : new Error("Prompt was not accepted by the session.")),
				})
				.then(
					() => settle(),
					(error: unknown) => settle(error),
				);
		});
	}

	async listSavedSessions(
		context: DaemonSavedSessionCatalogContext | { activeSessionId: string } | { cwd: string; sessionDir?: string },
		scope: AgentConnectionSavedSessionScope,
		callbacks?: AgentConnectionSessionListCallbacks,
	): Promise<AgentConnectionSavedSessionInfo[]> {
		const { cwd, sessionDir } = this.resolveCatalogContext(context);
		// Subagents included (they live under session-artifacts, not sessions/),
		// served from the persisted index first — see core/session-catalog.ts.
		// A subagent's own sessionDir is its sub-* folder; the catalog is the agent's.
		const sessionsDir = sessionDir && !sessionDir.includes("/session-artifacts/") ? sessionDir : getSessionsDir();
		return listSessionCatalog({
			sessionsDir,
			...(scope === "current" ? { cwd } : {}),
			// The view hides them by default and counts them (alt+h shows them).
			includeDelegated: true,
			onSession: callbacks?.onSession,
			onProgress: callbacks?.onProgress,
		});
	}

	async renameSavedSession(sessionPath: string, name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Session name cannot be empty");
		const wanted = resolve(sessionPath);
		const resident = this.listHosted().find(
			(hosted) => hosted.runtime.session.sessionFile && resolve(hosted.runtime.session.sessionFile) === wanted,
		);
		if (resident) {
			resident.runtime.session.setSessionName(trimmed);
			return;
		}
		SessionManager.open(sessionPath).appendSessionInfo(trimmed);
	}

	async deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult> {
		return deleteSessionFile(sessionPath);
	}

	private resolveCatalogContext(context: DaemonSavedSessionCatalogContext): { cwd: string; sessionDir?: string } {
		if ("activeSessionId" in context) {
			const session = this.findHosted(context.activeSessionId).runtime.session;
			return { cwd: session.sessionManager.getCwd(), sessionDir: session.sessionManager.getSessionDir() || undefined };
		}
		return { cwd: context.cwd, sessionDir: context.sessionDir || undefined };
	}

	/**
	 * The roster, classified the way prime-agent's supervisor classifies it.
	 * Entries are keyed by `rosterAgentIdForSummary`, so a subagent is
	 * addressed by its parent's session path and child id.
	 */
	rosterEntries(): AgentRosterEntry[] {
		const roster = new AgentRoster((path) => resolve(path));
		for (const summary of this.summaries()) roster.write(workerRosterEntryFromSummary(summary));
		return [...roster.values()];
	}

	private snapshotRoster(): AgentRosterEntry[] {
		const entries = this.rosterEntries();
		this.lastRoster = new Map(entries.map((entry) => [entry.agentId, JSON.stringify(entry)]));
		return entries;
	}

	/**
	 * prime-agent's supervisor pushes roster writes as they happen. In-process
	 * the sessions are right here, so a short poll diffs the roster and pushes
	 * exactly what changed.
	 */
	subscribe(listener: (message: DaemonOutbound) => void): () => void {
		this.rosterListeners.add(listener);
		if (!this.rosterTimer) {
			this.rosterTimer = setInterval(() => this.pushRosterChanges(), ROSTER_PUSH_INTERVAL_MS);
			this.rosterTimer.unref?.();
		}
		return () => {
			this.rosterListeners.delete(listener);
			if (this.rosterListeners.size === 0 && this.rosterTimer) {
				clearInterval(this.rosterTimer);
				this.rosterTimer = undefined;
			}
		};
	}

	private pushRosterChanges(): void {
		if (this.rosterListeners.size === 0) return;
		let entries: AgentRosterEntry[];
		try {
			entries = this.rosterEntries();
		} catch {
			return;
		}
		const next = new Map(entries.map((entry) => [entry.agentId, JSON.stringify(entry)]));
		const changed = entries.filter((entry) => this.lastRoster.get(entry.agentId) !== next.get(entry.agentId));
		const removed = [...this.lastRoster.keys()].filter((agentId) => !next.has(agentId));
		this.lastRoster = next;
		if (changed.length === 0 && removed.length === 0) return;
		const message: DaemonOutbound = { type: "roster_update", changed, ...(removed.length > 0 ? { removed } : {}) };
		for (const listener of [...this.rosterListeners]) {
			try {
				listener(message);
			} catch {
				// A listener's failure is its own; the roster keeps flowing to the rest.
			}
		}
	}

	/** Quit: every runtime this host owns goes, children with their parents. */
	async disposeAll(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.rosterTimer) clearInterval(this.rosterTimer);
		this.rosterTimer = undefined;
		this.rosterListeners.clear();
		hosts.delete(this.socketPath);
		const runtimes = this.topLevel.splice(0);
		await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()));
	}
}

// ─── the client the view holds ──────────────────────────────────────────────

export class DaemonClient implements DaemonTransportClient {
	private closed = false;
	private readonly unsubscribes = new Set<() => void>();

	constructor(private readonly socketPath: string) {}

	private get host(): InProcessAgentsHost {
		const host = getInProcessAgentsHost(this.socketPath);
		if (!host) throw new Error(`No in-process agents host at ${this.socketPath}`);
		return host;
	}

	get hello(): DaemonHello | undefined {
		return this.closed
			? undefined
			: { type: "daemon_hello", capabilities: ["delete_rlm_subagent", "heartbeat_catalog", "agent_roster"] };
	}

	get isConnected(): boolean {
		return !this.closed && getInProcessAgentsHost(this.socketPath) !== undefined;
	}

	supportsServerCapability(capability: DaemonServerCapability): boolean {
		return this.hello?.capabilities.includes(capability) ?? false;
	}

	async waitForHello(_timeoutMs = 3000): Promise<DaemonHello> {
		const hello = this.hello;
		if (!hello) throw new Error("In-process agents host is closed");
		return hello;
	}

	async connect(_timeoutMs = 3000): Promise<void> {
		this.closed = false;
		void this.host;
	}

	async reconnect(timeoutMs = 3000): Promise<void> {
		await this.connect(timeoutMs);
	}

	onMessage(listener: (message: DaemonClientMessage) => void): () => void {
		const unsubscribe = this.host.subscribe((message) => {
			if (!this.closed) listener(message);
		});
		this.unsubscribes.add(unsubscribe);
		return () => {
			this.unsubscribes.delete(unsubscribe);
			unsubscribe();
		};
	}

	onClose(_listener: (error: Error) => void): () => void {
		return () => {};
	}

	async request(command: DaemonCommand, _timeoutMs?: number, options?: DaemonRequestOptions): Promise<DaemonResponse> {
		if (this.closed) return { success: false, error: "In-process agents client is closed" };
		return this.host.request(command, options);
	}

	attach(activeSessionId: string): { connection: AgentConnection; localSessionHost: InteractiveModeLocalSessionHost } {
		return this.host.attach(activeSessionId);
	}

	getHost(): InProcessAgentsHost {
		return this.host;
	}

	close(): void {
		this.closed = true;
		for (const unsubscribe of [...this.unsubscribes]) unsubscribe();
		this.unsubscribes.clear();
	}
}

// The view types its opened connection as `DaemonAgentConnection` and attaches
// through `DaemonAgentConnection.attach`; in-process that is an AgentConnection.
export type DaemonAgentConnection = AgentConnection & {
	/** In-process: the local host the chat binds extensions through. */
	localSessionHost?: InteractiveModeLocalSessionHost;
};

export const DaemonAgentConnection = {
	async attach(client: DaemonClient, activeSessionId: string, _options?: unknown): Promise<DaemonAgentConnection> {
		const { connection, localSessionHost } = client.attach(activeSessionId);
		return Object.assign(connection, { localSessionHost });
	},
};

// ─── catalogs ───────────────────────────────────────────────────────────────

export type DaemonSavedSessionCatalogContext = { activeSessionId: string } | { cwd: string; sessionDir?: string };

export async function listDaemonHeartbeats(
	client: DaemonClient,
	activeSessionId?: string,
): Promise<AgentConnectionHeartbeat[]> {
	const response = await client.request({ type: "heartbeats_list", ...(activeSessionId ? { activeSessionId } : {}) });
	if (!response.success) throw new Error(response.error);
	return (response.data as { heartbeats: AgentConnectionHeartbeat[] }).heartbeats;
}

export async function listDaemonSavedSessions(
	client: DaemonClient,
	context: DaemonSavedSessionCatalogContext,
	scope: AgentConnectionSavedSessionScope,
	callbacks?: AgentConnectionSessionListCallbacks,
): Promise<AgentConnectionSavedSessionInfo[]> {
	const command: DaemonCommand =
		"activeSessionId" in context
			? { type: "list_saved_sessions", activeSessionId: context.activeSessionId, scope }
			: { type: "list_saved_sessions", cwd: context.cwd, sessionDir: context.sessionDir, scope };
	const response = await client.request(command, 30000, {
		onProgress: (update) => {
			if (update.type === "session_list_progress") {
				callbacks?.onProgress?.(update.loaded, update.total);
			} else {
				callbacks?.onSession?.(deserializeSavedSessionInfo(update.session));
			}
		},
	});
	if (!response.success) throw new Error(response.error);
	return (response.data as { sessions: AgentConnectionSavedSessionInfo[] }).sessions.map(deserializeSavedSessionInfo);
}

/** prime-agent's wire form carries dates as ISO strings; in-process they are already Dates. */
export function deserializeSavedSessionInfo(session: AgentConnectionSavedSessionInfo): AgentConnectionSavedSessionInfo {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		state: session.state,
		parentSessionPath: session.parentSessionPath,
		rlmDepth: session.rlmDepth,
		created: new Date(session.created),
		modified: new Date(session.modified),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
		agentStatus: session.agentStatus,
		// Without these a saved row shows no Model, Tokens or Cost.
		...(session.usage ? { usage: session.usage } : {}),
		...(session.model ? { model: session.model } : {}),
	};
}

export async function renameDaemonSavedSession(
	client: DaemonClient,
	context: DaemonSavedSessionCatalogContext,
	sessionPath: string,
	name: string,
): Promise<void> {
	const response = await client.request(
		"activeSessionId" in context
			? { type: "rename_saved_session", activeSessionId: context.activeSessionId, sessionPath, name }
			: { type: "rename_saved_session", sessionPath, name },
	);
	if (!response.success) throw new Error(response.error);
}

export async function deleteDaemonSavedSession(
	client: DaemonClient,
	context: DaemonSavedSessionCatalogContext,
	sessionPath: string,
): Promise<DeleteSessionFileResult> {
	const response = await client.request(
		"activeSessionId" in context
			? { type: "delete_saved_session", activeSessionId: context.activeSessionId, sessionPath }
			: { type: "delete_saved_session", sessionPath },
	);
	if (!response.success) throw new Error(response.error);
	return response.data as DeleteSessionFileResult;
}

// ─── summaries (prime-agent's daemon-session-list, over hosted runtimes) ────

// How often the in-process roster is diffed and pushed to subscribed views.
const ROSTER_PUSH_INTERVAL_MS = 250;

// Upper bound on the spawn-code source carried in a session summary.
const SPAWN_CODE_MAX_CHARS = 4000;
const MAX_DATE_TIMESTAMP_MS = 8.64e15;

function summaryForHostedRuntime(hosted: HostedRuntime, attachedClients: number): SessionSummary {
	const session = hosted.runtime.session;
	const metadata = hosted.runtime.metadata ?? { kind: "top-level" as const };
	let modified: string | undefined;
	if (session.sessionFile) {
		try {
			modified = statSync(session.sessionFile).mtime.toISOString();
		} catch {
			// Leave age blank when the active session has not flushed a jsonl yet.
		}
	}
	const busy = session.isSessionActive || session.hasRunningRlmChildren();
	const agentStatus = session.sessionManager.getLatestAgentStatus?.();
	const statusCurrent = agentStatus !== undefined && agentStatus.basedOnMessageCount === session.messages.length;
	return {
		id: hosted.activeSessionId,
		// Message-based, as in prime-agent: a message-less session is a hidden draft.
		lifecycle: session.messages.length === 0 ? "draft" : "live",
		// prime-agent holds an idle top-level session at "working" until its
		// background summarizer judges it; rlm runs no summarizer, so not busy is idle.
		activity: busy ? "working" : "idle",
		isSessionActive: session.isSessionActive,
		lastActivityAt:
			latestMessageActivityAt(session.messages) ?? modified ?? session.sessionManager.getHeader?.()?.timestamp,
		runtimeKind: metadata.kind,
		rlmDepth: session.rlmDepth,
		activeSessionId: hosted.activeSessionId,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		cwd: session.sessionManager.getCwd(),
		model: session.model as Model<Api> | undefined,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		isBashRunning: session.isBashRunning,
		hasRunningRlmChildren: session.hasRunningRlmChildren(),
		usage: ownUsageSummary(session),
		isRunningTools: session.isStreaming && session.state.pendingToolCalls.size > 0,
		attachedClients,
		messageCount: session.messages.length,
		unfinishedActionCount: session.unfinishedActionCount,
		sessionActions: session.getSessionActionSnapshot(),
		streamingMessage: session.state.streamingMessage,
		created: session.sessionManager.getHeader?.()?.timestamp,
		modified,
		firstMessage: (metadata.prompt ? compactRlmText(metadata.prompt, 120) : undefined) ?? firstUserMessageText(session),
		// In-process children know their parent by the runtime that hosts them.
		parentActiveSessionId: hosted.parent?.activeSessionId,
		parentSessionId: metadata.parentSessionId,
		parentSessionPath: metadata.parentSessionFile,
		rlmChildId: metadata.rlmChildId,
		...(metadata.kind === "subagent" && session.repliedToParentSinceTask !== undefined
			? { repliedSinceTask: session.repliedToParentSinceTask }
			: {}),
		rlmParentNodeId: metadata.rlmParentNodeId,
		spawnCode: metadata.spawnCode ? metadata.spawnCode.slice(0, SPAWN_CODE_MAX_CHARS) : undefined,
		modelFallbackMessage: hosted.runtime.modelFallbackMessage,
		diagnostics: [...hosted.runtime.diagnostics],
		summary: agentStatus?.summary,
		...(statusCurrent ? { taskState: agentStatus?.taskState } : {}),
	};
}

const ownUsageMemo = new WeakMap<object, { count: number; usage: SessionUsageSummary | undefined }>();

/**
 * This session's own spend, as prime-agent's `getOwnUsageSummary` reports it:
 * every assistant turn, less the child usage folded into those turns when
 * subagent runs were attributed to them.
 */
function ownUsageSummary(session: AgentSessionRuntime["session"]): SessionUsageSummary | undefined {
	const entries = session.sessionManager.getEntries();
	const memo = ownUsageMemo.get(session);
	if (memo && memo.count === entries.length) return memo.usage;
	const total = emptyUsage();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.usage) {
			addAssistantUsage(total, entry.message.usage);
		} else if (entry.type === "child_usage_attributed") {
			subtractAssistantUsage(total, entry.childUsage);
		}
	}
	const usage = sessionUsageSummaryFrom(total);
	ownUsageMemo.set(session, { count: entries.length, usage });
	return usage;
}

function latestMessageActivityAt(messages: readonly AgentMessage[]): string | undefined {
	let latest: number | undefined;
	for (const message of messages) {
		if (
			typeof message.timestamp === "number" &&
			Number.isFinite(message.timestamp) &&
			Math.abs(message.timestamp) <= MAX_DATE_TIMESTAMP_MS
		) {
			latest = latest === undefined ? message.timestamp : Math.max(latest, message.timestamp);
		}
	}
	return latest === undefined ? undefined : new Date(latest).toISOString();
}

function firstUserMessageText(session: AgentSessionRuntime["session"]): string | undefined {
	for (const message of session.messages) {
		if (message.role !== "user") continue;
		const text = compactRlmText(readMessageText(message.content), 120).trim();
		if (text) return text;
	}
	return undefined;
}

function readMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}
