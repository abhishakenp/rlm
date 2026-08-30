/**
 * @rlm/tui-renderer — InteractiveMode TUI as a Cordis Service.
 *
 * Wraps the coding-agent InteractiveMode behind a service. Creates the full
 * agent runtime (AgentSessionRuntime → InProcessAgentConnection →
 * InteractiveMode) via the rlmAgent service. No fallbacks. No direct
 * coding-agent imports beyond the mode constructors.
 *
 * Depends on:
 * - @rlm/agent (rlmAgent) for createRuntime()
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import {
	InteractiveMode,
	type InteractiveModeOptions,
	type InteractiveModeRunResult,
} from "../../coding-agent/src/modes/interactive/interactive-mode.js";
import {
	createInteractiveModeLocalSessionHost,
	createInteractiveModeUiServices,
} from "../../coding-agent/src/modes/interactive/interactive-mode-services.js";
import {
	InProcessAgentConnection,
	ClientPromptStashStore,
} from "../../coding-agent/src/modes/index.js";
import type { AgentSessionRuntime } from "../../coding-agent/src/core/agent-session-runtime.js";

export interface RlmRendererConfig {
	cwd?: string;
}

export interface RlmRendererStartOptions {
	/** Initial message to send on startup (e.g. from --print or -p flag). */
	initialMessage?: string;
	/** Additional text-only messages to send after the initial message. */
	initialMessages?: string[];
	/** Force verbose startup. */
	verbose?: boolean;
}

export class RlmRendererService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmRenderer" as const;

	declare config: RlmRendererConfig;

	private instance: InteractiveMode | undefined;
	private runtime: AgentSessionRuntime | undefined;

	constructor(ctx: any, config: RlmRendererConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		const cwd = this.config.cwd ?? process.cwd();
		this.ctx.logger?.info(`rlm-tui-renderer: ready (cwd=${cwd})`);
	}

	/**
	 * Create the full agent runtime and launch InteractiveMode.
	 * No fallbacks — if the runtime or UI fails, the error propagates.
	 */
	async start(opts: RlmRendererStartOptions = {}): Promise<InteractiveModeRunResult> {
		if (this.instance) {
			throw new Error("rlm-tui-renderer: InteractiveMode already running");
		}

		const rlmAgent = this.ctx.get("rlmAgent") as {
			createRuntime: (options: {
				sessionConfig?: Record<string, unknown>;
				sessionOptions?: Record<string, unknown>;
			}) => Promise<AgentSessionRuntime>;
		};

		if (!rlmAgent?.createRuntime) {
			throw new Error("rlm-tui-renderer: rlmAgent.createRuntime not available");
		}

		// Create the full agent runtime via the rlmAgent service.
		this.runtime = await rlmAgent.createRuntime({});

		// Wire up the in-process agent connection + local session host.
		const connection = new InProcessAgentConnection(this.runtime);
		const localSessionHost = createInteractiveModeLocalSessionHost(this.runtime);
		const promptStashStore = new ClientPromptStashStore();

		const interactiveOptions: InteractiveModeOptions = {
			agentConnection: connection,
			localSessionHost,
			promptStashStore,
			promptStashSessionId: this.runtime.session.sessionId,
			bindLocalSessionExtensions: true,
			initialMessage: opts.initialMessage,
			initialMessages: opts.initialMessages,
			verbose: opts.verbose,
		};

		this.instance = new InteractiveMode(interactiveOptions);
		return this.instance.run();
	}

	/**
	 * Stop the InteractiveMode and dispose the runtime.
	 */
	async stop(): Promise<void> {
		if (this.instance) {
			this.instance.stop();
			this.instance = undefined;
		}
		if (this.runtime) {
			await this.runtime.dispose?.();
			this.runtime = undefined;
		}
	}
}

export default RlmRendererService;
export const name = "rlm-tui-renderer";
export const inject = ["rlmAgent"] as const;
export { RlmRendererService as RlmRenderer };
export type { InteractiveModeOptions, InteractiveModeRunResult };
