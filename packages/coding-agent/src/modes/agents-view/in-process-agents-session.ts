/**
 * prime-agent's interactive flow, over in-process sessions.
 *
 * This is the daemon-interactive branch of prime-agent's `main.ts`, verbatim in
 * shape: open the chat with `returnToAgentsView`, and when it returns — left
 * arrow for the agents view, the subagent tray for the view scoped to this
 * session's children — hand the terminal to `runAgentsViewMode`, rooted at the
 * session the user came from. From there the view opens chats and they return
 * to it, until the user quits.
 *
 * What prime-agent's daemon provided, `InProcessAgentsHost` provides: the
 * session roster (the renderer's runtime, the agents started from the view, and
 * every subagent runtime under them), attach, and the commands the view sends.
 * Quitting disposes them all; going back to the view only detaches.
 */
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { armExitWatchdog, exitStep } from "../../utils/exit-watchdog.js";
import { InteractiveMode, type InteractiveModeRunResult } from "../interactive/interactive-mode.js";
import { ClientPromptStashStore } from "../interactive/prompt-stash-state.js";
import { type AgentsViewPersistentState, runAgentsViewMode } from "./agents-view-mode.js";
import type { AgentsViewScopeKey } from "./agents-view-state.js";
import { type CreateTopLevelRuntimeOptions, InProcessAgentsHost } from "./in-process-daemon.js";
import type { SessionSummary } from "./session-summary.js";

export interface InProcessAgentsSessionOptions {
	/** The first agent: the chat opens on it. */
	runtime: AgentSessionRuntime;
	/** Starts another top-level agent (ctrl+n in the view) or resumes a saved one. */
	createTopLevelRuntime?: (options: CreateTopLevelRuntimeOptions) => Promise<AgentSessionRuntime>;
	initialMessage?: string;
	initialMessages?: string[];
	verbose?: boolean;
	migratedProviders?: string[];
	modelFallbackMessage?: string;
	/** Told of every chat as it opens: the first one here, the rest from the agents view. */
	onInteractiveMode?: (mode: InteractiveMode) => void;
	/**
	 * Bare `--resume`/`-r`: start on the agents view, unscoped and with nothing
	 * selected, as prime-agent's `launchAgentsView()` does. The first runtime stays
	 * hosted as a message-less draft, which the view hides.
	 */
	openAgentsView?: boolean;
	/** Told of every agents-view instance as it starts (the host Surface tracks the view on screen). */
	onAgentsView?: (view: { persistentState: AgentsViewPersistentState }) => void;
	/** Seed the first agents view's state (selection, expansion, scope, filter) — restored after an execve. */
	initialAgentsViewState?: Partial<AgentsViewPersistentState>;
	/**
	 * The background daemon takes these sessions over on its own once it is up —
	 * there is no command for it. `isAvailable` answers synchronously (the caller
	 * keeps a probe result warm); when it says yes and every hosted session is
	 * idle, the chat on screen hands itself over at a quiet moment and this loop
	 * returns `promote_to_daemon` for the host to reopen that session in a worker.
	 */
	daemonHandover?: { isAvailable: () => boolean; intervalMs?: number };
}

export async function runInProcessAgentsSession(
	options: InProcessAgentsSessionOptions,
): Promise<InteractiveModeRunResult | undefined> {
	const { runtime } = options;
	const host = new InProcessAgentsHost(runtime, { createTopLevelRuntime: options.createTopLevelRuntime });
	const onShutdown = async (reason: "exit" | "agents_view") => {
		if (reason === "exit") await host.disposeAll();
	};
	const promptStashStore = new ClientPromptStashStore();
	const rootActiveSessionId = host.activeSessionIdFor(runtime);
	const { connection, localSessionHost } = host.attach(rootActiveSessionId);

	const sessionManager = runtime.session.sessionManager;
	const config: AgentSessionRuntimeConfig = {
		cwd: sessionManager.getCwd(),
		sessionDir: sessionManager.getSessionDir() || undefined,
	};
	// Which chat is on screen, for the daemon handover watcher below.
	let onScreen: InteractiveMode | undefined;
	const trackChat = (mode: InteractiveMode) => {
		onScreen = mode;
		options.onInteractiveMode?.(mode);
	};
	const stopHandoverWatch = watchForDaemonHandover(host, () => onScreen, options.daemonHandover);
	let handedOver: SessionSummary | undefined;
	const runView = async (initialSession?: SessionSummary, initialScopeKey?: AgentsViewScopeKey) => {
		try {
			await runAgentsViewMode({
				socketPath: host.socketPath,
				config,
				uiServices: localSessionHost.createUiServices(),
				migratedProviders: options.migratedProviders,
				modelFallbackMessage: options.modelFallbackMessage,
				verbose: options.verbose,
				promptStashStore,
				initialSession,
				initialScopeKey,
				onShutdown,
				onInteractiveMode: trackChat,
				onAgentsView: (view) => {
					onScreen = undefined;
					options.onAgentsView?.(view);
				},
				onHandOverToDaemon: options.daemonHandover
					? (session) => {
							handedOver = session;
						}
					: undefined,
				initialPersistentState: options.initialAgentsViewState,
			});
		} catch (error) {
			// The chat handed the terminal over still in the alternate screen with
			// input raw; a view that fails must not leave it that way.
			restoreTerminal();
			throw error;
		} finally {
			stopHandoverWatch();
			if (handedOver) {
				await releaseForDaemon(host);
			} else {
				// The view exits only when the user quits from it. Disposing every
				// hosted session can wait on a promise nobody resolves; the watchdog
				// exits anyway rather than leave a live process behind the prompt.
				armExitWatchdog("quit from agents view", 0);
				exitStep("agents host disposeAll");
				await host.disposeAll();
			}
		}
	};
	const handoverResult = (): InteractiveModeRunResult | undefined =>
		handedOver
			? {
					type: "promote_to_daemon",
					source: {
						activeSessionId: handedOver.activeSessionId,
						sessionFile: handedOver.sessionFile,
						sessionId: handedOver.sessionId,
						sessionName: handedOver.sessionName,
						cwd: handedOver.cwd,
					},
				}
			: undefined;

	if (options.openAgentsView) {
		await runView();
		return handoverResult();
	}

	const interactiveMode = new InteractiveMode({
		agentConnection: connection,
		localSessionHost,
		promptStashStore,
		promptStashSessionId: runtime.session.sessionId,
		bindLocalSessionExtensions: true,
		migratedProviders: options.migratedProviders,
		modelFallbackMessage: options.modelFallbackMessage,
		initialMessage: options.initialMessage,
		initialMessages: options.initialMessages,
		verbose: options.verbose,
		// Left arrow takes the chat to the agents view like any other session.
		// The agents view was not rendered here, so agentsViewOwnsStartupNotices
		// stays unset and the in-session fallback runs.
		returnToAgentsView: true,
		sessionDepth: runtime.session.rlmDepth,
		sessionHasChildren: runtime.session.hasRunningRlmChildren(),
		onShutdown,
	});
	trackChat(interactiveMode);

	let interactiveResult: InteractiveModeRunResult;
	try {
		interactiveResult = await interactiveMode.run();
	} catch (error) {
		stopHandoverWatch();
		restoreTerminal();
		await host.disposeAll();
		throw error;
	}

	if (interactiveResult.type === "promote_to_daemon") {
		// The daemon took the first chat over: release every hosted session (idle,
		// kernel variables handed over on disk) so its worker can open the file.
		stopHandoverWatch();
		await releaseForDaemon(host);
		return interactiveResult;
	}

	const summary = host.summaryFor(host.findHosted(rootActiveSessionId));
	const returnedSummary: SessionSummary = {
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

	await runView(returnedSummary, initialScopeKey);
	return handoverResult() ?? interactiveResult;
}

const HANDOVER_CHECK_MS = 2000;

/**
 * Every `intervalMs`, while the daemon is available: if nothing hosted here is
 * running and the chat on screen is quiet, that chat hands itself over. The
 * agents view itself never is handed over mid-browse; the next chat opened from
 * it is. Returns the stop function.
 */
function watchForDaemonHandover(
	host: InProcessAgentsHost,
	chatOnScreen: () => InteractiveMode | undefined,
	handover: InProcessAgentsSessionOptions["daemonHandover"],
): () => void {
	if (!handover) return () => {};
	let done = false;
	const timer = setInterval(() => {
		if (done) return;
		try {
			if (!handover.isAvailable()) return;
			const chat = chatOnScreen();
			if (!chat?.canHandOverToDaemon()) return;
			if (!hostIsIdle(host)) return;
			if (chat.handOverToDaemon()) done = true;
		} catch {
			// A failed check just waits for the next tick.
		}
	}, handover.intervalMs ?? HANDOVER_CHECK_MS);
	timer.unref?.();
	return () => {
		done = true;
		clearInterval(timer);
	};
}

function hostIsIdle(host: InProcessAgentsHost): boolean {
	for (const { runtime } of host.listHosted()) {
		const session = runtime.session as { isStreaming?: boolean; hasRunningRlmChildren?: () => boolean };
		if (session.isStreaming || session.hasRunningRlmChildren?.()) return false;
	}
	return true;
}

/**
 * Release every hosted session for the daemon: wait (bounded) until nothing is
 * mid-turn, hand each kernel's variables over through its session's artifact
 * dir, then dispose the runtimes so a worker can take the session files.
 */
async function releaseForDaemon(host: InProcessAgentsHost): Promise<void> {
	const deadline = Date.now() + PROMOTE_IDLE_WAIT_MS;
	while (!hostIsIdle(host) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	}
	for (const { runtime } of host.listHosted()) await handOverKernelVariables(runtime);
	await host.disposeAll();
}

const PROMOTE_IDLE_WAIT_MS = 120_000;

/**
 * The code kernel's variables for this session, serialized (bun:jsc) into the
 * session's artifact dir as kernel-handover.json. The daemon worker's kernel
 * reads and deletes it the first time it creates its context (tools/code.ts).
 */
async function handOverKernelVariables(runtime: AgentSessionRuntime): Promise<void> {
	try {
		const { snapshotKernels } = await import("../../../../rlm-host/src/shell.ts");
		const sessionId = runtime.session.sessionId;
		const vars = (await snapshotKernels())[sessionId];
		const dir = runtime.session.sessionManager.getSessionArtifactDir();
		if (!vars || !Object.keys(vars).length || !dir) return;
		const { mkdirSync, writeFileSync, renameSync } = await import("node:fs");
		const { join } = await import("node:path");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "kernel-handover.json");
		writeFileSync(`${path}.tmp`, JSON.stringify({ v: 1, sessionId, vars }));
		renameSync(`${path}.tmp`, path);
	} catch {
		// Losing kernel variables is recoverable (the session history is intact).
	}
}

/** Leave the alternate screen, show the cursor, and hand input back cooked. */
export function restoreTerminal(): void {
	try {
		if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
	} catch {
		// Best effort: the tty may already be gone.
	}
	try {
		if (process.stdout.isTTY) process.stdout.write("\x1b[?1049l\x1b[?25h");
	} catch {
		// Best effort.
	}
}
