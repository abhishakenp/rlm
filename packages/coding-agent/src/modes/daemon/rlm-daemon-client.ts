/**
 * prime-agent's daemon entry points, as rlm reaches them.
 *
 * Upstream runs all of this from `main()`: `--mode daemon` starts the
 * supervisor (or, with the worker role in the environment, a resident worker),
 * and an interactive launch attaches to that supervisor instead of hosting its
 * own sessions. rlm has no `main()` on its launch path — `cordis-shell.mjs`
 * boots the composition and the `modes` row decides what the invocation is —
 * so the same steps live here, called from that row. The helpers below are
 * upstream's (main.ts v0.9.6), unchanged except where noted.
 *
 * Every process in the fleet is `cordis-shell.mjs`: the supervisor and each
 * worker relaunch the running entrypoint with `--mode daemon`, so workers boot
 * the whole composition — skills, tools, hot reload — and create sessions with
 * the `agent` row's factory.
 */
import { dirname, resolve } from "node:path";
import { ensureInteractiveDaemonRunning, isDaemonSessionSummary, listActiveDaemonSessionSummaries } from "../../cli/daemon-launch.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.js";
import { canonicalSessionPath } from "../../core/session-lease.js";
import { loadEntriesFromFile, SessionManager } from "../../core/session-manager.js";
import { DaemonAgentConnection } from "../agent-connection/daemon-agent-connection.js";
import { runAgentsViewMode } from "../agents-view/agents-view-mode.js";
import { useDaemonTransport } from "../agents-view/view-transport.js";
import type { AgentsViewScopeKey } from "../agents-view/agents-view-state.js";
import { InteractiveMode } from "../interactive/interactive-mode.js";
import type { InteractiveModeUiServices } from "../interactive/interactive-mode-services.js";
import { ClientPromptStashStore } from "../interactive/prompt-stash-state.js";
import { DaemonCapabilityUnavailableError, DaemonClient } from "./daemon-client.js";
import { deserializeDaemonCreateError } from "./daemon-errors.js";
import { runDaemonMode } from "./daemon-mode.js";
import { collectDaemonClientEnv, collectDaemonLaunchEnv } from "./daemon-protocol.js";
import { resolveAttachModelFallbackMessage, type SessionSummary } from "./daemon-session-list.js";
import { defaultDaemonSocketPath } from "./daemon-socket.js";
import { runDaemonSupervisorMode } from "./daemon-supervisor.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	daemonWorkerInstanceId,
	isDaemonWorkerProcess,
	requireDaemonWorkerAuthenticationToken,
	waitForDaemonWorkerStartupGate,
} from "./daemon-worker-protocol.js";

/** True for the command line upstream's supervisor and workers are launched with. */
export function isDaemonInvocation(argv: readonly string[]): boolean {
	const index = argv.indexOf("--mode");
	return (index >= 0 && argv[index + 1] === "daemon") || argv.includes("--mode=daemon");
}

function daemonSocketFromArgv(argv: readonly string[]): string | undefined {
	const index = argv.indexOf("--daemon-socket");
	if (index >= 0) return argv[index + 1];
	return argv.find((arg) => arg.startsWith("--daemon-socket="))?.slice("--daemon-socket=".length);
}

// upstream main.ts
export function daemonServerDefaultSessionConfig(config: AgentSessionRuntimeConfig): AgentSessionRuntimeConfig {
	return { ...config, initialGoal: undefined };
}

/**
 * `--mode daemon`: the supervisor, or a resident worker when the supervisor
 * launched this process with the worker role (upstream main.ts, daemon branch).
 */
export async function runRlmDaemonProcess(options: {
	argv: readonly string[];
	createRuntime: CreateAgentSessionRuntimeFactory;
	defaultSessionConfig: AgentSessionRuntimeConfig;
}): Promise<void> {
	const socketPath = daemonSocketFromArgv(options.argv);
	const daemonDefaultSessionConfig = daemonServerDefaultSessionConfig(options.defaultSessionConfig);
	if (isDaemonWorkerProcess()) {
		waitForDaemonWorkerStartupGate();
		await runDaemonMode({
			socketPath,
			defaultSessionConfig: daemonDefaultSessionConfig,
			createRuntime: options.createRuntime,
			worker: {
				authenticationToken: requireDaemonWorkerAuthenticationToken(),
				workerInstanceId: daemonWorkerInstanceId(),
				restoreActiveSessionId: process.env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV],
			},
		});
		return;
	}
	await runDaemonSupervisorMode({ socketPath, defaultSessionConfig: daemonDefaultSessionConfig });
}

// upstream main.ts
function readSessionManager(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
	const entries = loadEntriesFromFile(path);
	const header = entries.find((entry) => entry.type === "session") as { cwd?: string } | undefined;
	const manager = SessionManager.inMemory(cwdOverride ?? header?.cwd ?? process.cwd(), sessionDir ?? dirname(resolve(path)));
	manager.setSessionFile(path, entries);
	return manager;
}

// upstream main.ts
function getDaemonSummaryActiveSessionId(summary: SessionSummary): string {
	return summary.activeSessionId ?? summary.id;
}

// upstream main.ts
function createSessionManagerForActiveDaemonSummary(summary: SessionSummary, fallbackCwd: string): SessionManager {
	const cwd = summary.cwd || fallbackCwd;
	if (summary.sessionFile) {
		try {
			return readSessionManager(summary.sessionFile, undefined, cwd);
		} catch {
			return SessionManager.inMemory(cwd);
		}
	}
	return SessionManager.inMemory(cwd);
}

// upstream main.ts
export function findActiveDaemonSessionSummaryForSessionFile(
	summaries: readonly SessionSummary[],
	sessionPath: string,
): SessionSummary | undefined {
	const resolvedSessionPath = canonicalSessionPath(sessionPath);
	return summaries.find(
		(summary) =>
			summary.activeSessionId !== undefined &&
			summary.sessionFile !== undefined &&
			canonicalSessionPath(summary.sessionFile) === resolvedSessionPath,
	);
}

// upstream main.ts
async function findAttachedDaemonSessionSummary(client: DaemonClient, activeSessionId: string): Promise<SessionSummary> {
	const response = await client.request({ type: "get_state", activeSessionId });
	if (!response.success) {
		throw new Error(response.error);
	}
	if (!isDaemonSessionSummary(response.data)) {
		throw new Error("Daemon returned an invalid active session summary");
	}
	return response.data;
}

// upstream main.ts
export async function createDaemonClientConnection(options: {
	socketPath: string;
	config: AgentSessionRuntimeConfig;
	sessionPath?: string;
	continueRecent?: boolean;
	activeSessionId?: string;
	clientOwned?: boolean;
	noSession?: boolean;
	supportsExtensionUi?: boolean;
	tracksHeartbeats?: boolean;
}): Promise<{ connection: DaemonAgentConnection; summary: SessionSummary }> {
	// Caller must have awaited ensureInteractiveDaemonRunning for this socket.
	const client = new DaemonClient(options.socketPath);
	await client.connect();

	try {
		const attach = async (summary: SessionSummary) => {
			const connection = await DaemonAgentConnection.attach(client, getDaemonSummaryActiveSessionId(summary), {
				closeClientOnDispose: true,
				deferSessionEvents: options.config.executionMode === "interactive",
				sendClientEnv: true,
				ownedSession: options.clientOwned,
				ownedSessionRecoveryConfig: options.clientOwned ? options.config : undefined,
				supportsExtensionUi: options.supportsExtensionUi,
				tracksHeartbeats: options.tracksHeartbeats,
				recoverDaemon: () => ensureInteractiveDaemonRunning(options.socketPath),
				telemetryDisabled: options.config.telemetryDisabled,
			});
			return { connection, summary };
		};

		if (options.activeSessionId) {
			const summary = await findAttachedDaemonSessionSummary(client, options.activeSessionId);
			return await attach(summary);
		}

		if (options.sessionPath && !options.clientOwned) {
			const activeSummary = findActiveDaemonSessionSummaryForSessionFile(
				await listActiveDaemonSessionSummaries(client),
				options.sessionPath,
			);
			if (activeSummary && activeSummary.workerState !== "failed") {
				return await attach(activeSummary);
			}
		}
		if (options.clientOwned) {
			await client.waitForHello();
			if (!client.supportsServerCapability("client_owned_sessions")) {
				throw new DaemonCapabilityUnavailableError("create", "client_owned_sessions");
			}
		}

		const response = await client.request({
			type: "create",
			config: options.config,
			sessionPath: options.sessionPath,
			continueRecent: options.continueRecent,
			noSession: options.noSession,
			env: collectDaemonClientEnv(),
			lifecycle: options.clientOwned ? "client_owned" : "resident",
			launchEnv: collectDaemonLaunchEnv(),
		});
		phase("create:returned");
		if (!response.success) {
			throw deserializeDaemonCreateError(response);
		}
		if (!isDaemonSessionSummary(response.data)) {
			throw new Error("Daemon returned an invalid create response");
		}
		const summary = response.data;
		return await attach(summary);
	} catch (error) {
		client.close();
		throw error;
	}
}

/**
 * One-shot print through the daemon (upstream main.ts print branch): a
 * client-owned worker runs the prompt; normal completion removes the worker.
 * The default with the rest of the daemon (RLM_DAEMON=0 opts out).
 */
export async function runRlmDaemonPrint(options: {
	config: AgentSessionRuntimeConfig;
	cwd: string;
	mode: "text" | "json";
	initialMessage?: string;
	messages?: string[];
	sessionManager?: SessionManager;
	continueRecent?: boolean;
	noSession?: boolean;
	socketPath?: string;
}): Promise<number> {
	const socketPath = options.socketPath ?? defaultDaemonSocketPath();
	phase("print:start");
	await ensureInteractiveDaemonRunning(socketPath);
	phase("daemon:ready");
	const { connection, summary } = await createDaemonClientConnection({
		socketPath,
		config: {
			cwd: options.cwd,
			...options.config,
			executionMode: options.mode === "json" ? "json" : "print",
		} as AgentSessionRuntimeConfig,
		sessionPath: options.noSession ? undefined : options.sessionManager?.getSessionFile(),
		continueRecent: options.continueRecent,
		clientOwned: true,
		noSession: options.noSession,
	});
	const errors = (summary.diagnostics ?? []).filter((diagnostic) => diagnostic.type === "error");
	for (const diagnostic of summary.diagnostics ?? []) process.stderr.write(`${diagnostic.message}\n`);
	if (errors.length > 0) {
		await connection.dispose();
		return 1;
	}
	if (!summary.model) {
		process.stderr.write(`${summary.modelFallbackMessage ?? "No models are available."}\n`);
		await connection.dispose();
		return 1;
	}
	const { runPrintModeWithConnection } = await import("../print-mode.js");
	return runPrintModeWithConnection(connection, {
		mode: options.mode,
		messages: options.messages,
		initialMessage: options.initialMessage,
	});
}

/** RLM_DAEMON_TIMING=1: wall-clock phases of a daemon attach, ms since process start, on stderr. */
function phase(label: string): void {
	if (process.env.RLM_DAEMON_TIMING === "1") process.stderr.write(`[rlm-daemon] ${label} ${Math.round(performance.now())}ms\n`);
}

export interface RlmDaemonInteractiveOptions {
	/** The session the command line selected (`--resume`, `-c`, `--fork`), if any. */
	sessionManager?: SessionManager;
	/** Bare `-r`: open the agents view instead of a chat. */
	openAgentsView?: boolean;
	config: AgentSessionRuntimeConfig;
	cwd: string;
	/** UI services built on the client side from the client's own runtime services. */
	uiServices: InteractiveModeUiServices;
	createUiServicesForSession?: (summary: SessionSummary) => Promise<InteractiveModeUiServices>;
	modelFallbackMessage?: string;
	initialMessage?: string;
	initialMessages?: string[];
	verbose?: boolean;
	socketPath?: string;
	/** Told of every chat as it opens, so the renderer row can repaint it. */
	onInteractiveMode?: (mode: InteractiveMode) => void;
	/** Told of every agents view as it opens (the host Surface tracks what is on screen). */
	onAgentsView?: (view: { persistentState: Record<string, unknown> }) => void;
	/** Agents-view state to restore, e.g. after an execve in place. */
	initialAgentsViewState?: Record<string, unknown>;
	/** Attach straight to this daemon session (an execve in place reattaches to what was on screen). */
	activeSessionId?: string;
	/** Told which daemon session the chat is attached to, whenever that changes. */
	onAttached?: (activeSessionId: string) => void;
}

/**
 * The interactive client (upstream main.ts, `useDaemonInteractive` branch):
 * make sure a supervisor is running, open or attach the selected session in
 * it, run the chat, and hand the terminal to the agents view when the chat
 * leaves for it. Closing the chat detaches; the worker keeps the session.
 */
export async function runRlmDaemonInteractive(options: RlmDaemonInteractiveOptions): Promise<void> {
	const socketPath = options.socketPath ?? defaultDaemonSocketPath();
	useDaemonTransport(socketPath);
	phase("client:start");
	await ensureInteractiveDaemonRunning(socketPath);
	phase("daemon:ready");
	const promptStashStore = new ClientPromptStashStore();
	const launchAgentsView = async (initialSession?: SessionSummary, initialScopeKey?: AgentsViewScopeKey) => {
		await runAgentsViewMode({
			socketPath,
			config: options.config,
			uiServices: options.uiServices,
			recoverDaemon: () => ensureInteractiveDaemonRunning(socketPath),
			createUiServicesForSession: options.createUiServicesForSession,
			modelFallbackMessage: options.modelFallbackMessage,
			promptStashStore,
			initialSession,
			initialScopeKey,
			verbose: options.verbose,
			onInteractiveMode: options.onInteractiveMode,
			onAgentsView: options.onAgentsView as never,
			initialPersistentState: options.initialAgentsViewState as never,
		});
	};
	if (options.openAgentsView) {
		await launchAgentsView();
		return;
	}

	// A command line that named a session attaches to it (or opens it in a worker);
	// a bare launch creates a fresh draft session in the daemon.
	const sessionPath = options.sessionManager?.getSessionFile();
	let activeSessionId: string | undefined = options.activeSessionId;
	if (!activeSessionId && sessionPath) {
		const client = new DaemonClient(socketPath);
		await client.connect();
		try {
			const active = findActiveDaemonSessionSummaryForSessionFile(
				await listActiveDaemonSessionSummaries(client),
				sessionPath,
			);
			// A crashed worker parks "failed" until a client reopens the session with
			// fresh runtime context; attaching to it only fails. Leave activeSessionId
			// unset so createDaemonClientConnection issues `create` for the path,
			// which relaunches the worker (same rule it applies itself).
			activeSessionId = active?.workerState === "failed" ? undefined : active?.activeSessionId;
		} finally {
			client.close();
		}
	}
	phase("lookup:done");
	const { connection, summary } = await createDaemonClientConnection({
		socketPath,
		config: options.config,
		activeSessionId,
		sessionPath,
		supportsExtensionUi: true,
	});
	const interactiveMode = new InteractiveMode({
		agentConnection: connection,
		// upstream also passes daemonSocketPath, used only by its /update restart flow.
		uiServices: options.uiServices,
		promptStashStore,
		promptStashSessionId: summary.sessionId,
		bindLocalSessionExtensions: false,
		modelFallbackMessage: sessionPath
			? resolveAttachModelFallbackMessage(summary, options.modelFallbackMessage)
			: options.modelFallbackMessage,
		initialMessage: options.initialMessage,
		initialMessages: options.initialMessages,
		verbose: options.verbose,
		returnToAgentsView: true,
		sessionDepth: summary.rlmDepth,
		sessionHasChildren: summary.hasRunningRlmChildren === true,
	});
	phase("session:attached");
	options.onAttached?.(summary.activeSessionId ?? summary.id);
	options.onInteractiveMode?.(interactiveMode);
	const interactiveResult = await interactiveMode.run();
	const returnedSummary = {
		...summary,
		...interactiveResult.source,
		id: interactiveResult.source.activeSessionId ?? summary.id,
	};
	const initialScopeKey =
		interactiveResult.type === "scoped_agents_view"
			? {
					sessionId: interactiveResult.source.sessionId,
					activeSessionId: interactiveResult.source.activeSessionId,
				}
			: undefined;
	await launchAgentsView(returnedSummary, initialScopeKey);
}

export { createSessionManagerForActiveDaemonSummary };
