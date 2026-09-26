/**
 * The agents view's transport: prime-agent's daemon client, or rlm's
 * in-process stand-in, chosen by the socket path the view was opened with.
 *
 * The view is upstream's and names one set of symbols — `DaemonClient`,
 * `DaemonAgentConnection.attach`, the saved-session catalog calls. rlm runs it
 * against two hosts: the daemon supervisor (`RLM_DAEMON=1`) and the sessions
 * this process hosts itself (the default), which register under an
 * `inprocess:` key. The in-process host is the default; a socket goes to the
 * daemon only once the daemon client registered it (`useDaemonTransport`), so
 * a daemon-mode view never reaches an `inprocess:` socket and an in-process
 * view never dials a real one.
 */
import type {
	AgentConnectionHeartbeat,
	AgentConnectionSavedSessionInfo,
	AgentConnectionSavedSessionScope,
	AgentConnectionSessionListCallbacks,
} from "../agent-connection/types.js";
import { DaemonAgentConnection as RealDaemonAgentConnection } from "../agent-connection/daemon-agent-connection.js";
import { DaemonClient as RealDaemonClient } from "../daemon/daemon-client.js";
import { listDaemonHeartbeats as realListHeartbeats } from "../daemon/heartbeat-catalog.js";
import * as realCatalog from "../daemon/saved-session-catalog.js";
import * as local from "./in-process-daemon.js";
import type { SessionSummary } from "./session-summary.js";

import { getDaemonSocketCloseReason as realCloseReason } from "../daemon/daemon-client.js";
import {
	DaemonSessionRecoveringError as RealRecoveringError,
	isDaemonUpdateRestartingError as realIsUpdateRestarting,
} from "../daemon/daemon-errors.js";
import {
	type DaemonClosingReason,
	isSessionSummary as realIsSessionSummary,
	isUnknownDaemonCommandError as realIsUnknownCommand,
} from "../daemon/daemon-protocol.js";
import { DaemonControlPlaneTransportError as RealTransportError } from "../daemon/daemon-routed-client.js";

export { collectDaemonClientEnv, type DaemonClosingReason, type DaemonCommand, type DaemonResponse } from "../daemon/daemon-protocol.js";

// Errors and checks from either host: the view's catch paths must recognise what
// the in-process stand-in throws exactly as they recognise the daemon's.
export const isDaemonUpdateRestartingError = (error: unknown): boolean =>
	realIsUpdateRestarting(error) || local.isDaemonUpdateRestartingError(error);
export const getDaemonSocketCloseReason = (error: Error): DaemonClosingReason | undefined =>
	realCloseReason(error) ?? local.getDaemonSocketCloseReason(error);
export const isUnknownDaemonCommandError = (error: unknown, command: string): boolean =>
	realIsUnknownCommand(error, command as never) || local.isUnknownDaemonCommandError(error, command);
export const isSessionSummary = (value: unknown): value is SessionSummary =>
	realIsSessionSummary(value) || local.isSessionSummary(value);
export class DaemonSessionRecoveringError extends RealRecoveringError {
	static [Symbol.hasInstance](value: unknown): boolean {
		return Function.prototype[Symbol.hasInstance].call(RealRecoveringError, value) ||
			value instanceof local.DaemonSessionRecoveringError;
	}
}
export class DaemonControlPlaneTransportError extends RealTransportError {
	static [Symbol.hasInstance](value: unknown): boolean {
		return Function.prototype[Symbol.hasInstance].call(RealTransportError, value) ||
			value instanceof local.DaemonControlPlaneTransportError;
	}
}
export type { DaemonSavedSessionCatalogContext } from "../daemon/saved-session-catalog.js";

const daemonSockets = new Set<string>();

/** Route this socket's agents view to prime-agent's daemon (called by the daemon client). */
export const useDaemonTransport = (socketPath: string): void => {
	daemonSockets.add(socketPath);
};

export const isInProcessSocketPath = (socketPath: string | undefined): boolean =>
	socketPath === undefined || !daemonSockets.has(socketPath);

type AnyClient = RealDaemonClient | local.DaemonClient;
const isLocalClient = (client: AnyClient): client is local.DaemonClient => !(client instanceof RealDaemonClient);

/** `new DaemonClient(socketPath)`, as upstream writes it, for either host. */
export const DaemonClient = function DaemonClient(socketPath: string) {
	return isInProcessSocketPath(socketPath) ? new local.DaemonClient(socketPath) : new RealDaemonClient(socketPath);
} as unknown as typeof RealDaemonClient;
export type DaemonClient = RealDaemonClient;

export type DaemonAgentConnection = RealDaemonAgentConnection;
export const DaemonAgentConnection = {
	attach(
		client: AnyClient,
		activeSessionId: string,
		options?: Parameters<typeof RealDaemonAgentConnection.attach>[2],
	): Promise<RealDaemonAgentConnection> {
		return isLocalClient(client)
			? (local.DaemonAgentConnection.attach(client, activeSessionId, options) as unknown as Promise<RealDaemonAgentConnection>)
			: RealDaemonAgentConnection.attach(client, activeSessionId, options);
	},
};

export function listDaemonHeartbeats(client: AnyClient, activeSessionId?: string): Promise<AgentConnectionHeartbeat[]> {
	return isLocalClient(client)
		? local.listDaemonHeartbeats(client, activeSessionId)
		: realListHeartbeats(client, activeSessionId);
}

export function listDaemonSavedSessions(
	client: AnyClient,
	context: realCatalog.DaemonSavedSessionCatalogContext,
	scope: AgentConnectionSavedSessionScope,
	callbacks?: AgentConnectionSessionListCallbacks,
): Promise<AgentConnectionSavedSessionInfo[]> {
	return isLocalClient(client)
		? local.listDaemonSavedSessions(client, context, scope, callbacks)
		: realCatalog.listDaemonSavedSessions(client, context, scope, callbacks);
}

export function renameDaemonSavedSession(
	client: AnyClient,
	context: realCatalog.DaemonSavedSessionCatalogContext,
	sessionPath: string,
	name: string,
) {
	return isLocalClient(client)
		? local.renameDaemonSavedSession(client, context, sessionPath, name)
		: realCatalog.renameDaemonSavedSession(client, context, sessionPath, name);
}

export function deleteDaemonSavedSession(
	client: AnyClient,
	context: realCatalog.DaemonSavedSessionCatalogContext,
	sessionPath: string,
) {
	return isLocalClient(client)
		? local.deleteDaemonSavedSession(client, context, sessionPath)
		: realCatalog.deleteDaemonSavedSession(client, context, sessionPath);
}
