/**
 * @rlm/print — Print mode (single-shot) as a Cordis Service.
 *
 * Wraps runPrintMode behind a service. Creates the full agent runtime
 * via rlmAgent, then runs print mode with an InProcessAgentConnection.
 * No fallbacks.
 *
 * Depends on:
 * - @rlm/agent (rlmAgent) for createRuntime()
 *
 * Hot-swappable: editing this file triggers fiber.restart() → fresh import.
 */
import { Service } from "@deepseek-ai/cordis";
import { rowState } from "../../rlm-host/src/surface.ts";
import { runPrintMode, type PrintModeOptions } from "../../coding-agent/src/modes/print-mode.js";
import type { AgentSessionRuntime } from "../../coding-agent/src/core/agent-session-runtime.js";
import type { SessionManager } from "../../coding-agent/src/core/session-manager.js";

export interface RlmPrintConfig {
	cwd?: string;
}

export class RlmPrintService extends Service {
	static inject = ["rlmAgent"] as const;
	static provide = "rlmPrint" as const;

	declare config: RlmPrintConfig;

	/**
	 * The run's runtime, on the host Surface rather than this instance: a hot
	 * swap of this row mid-run plugs a new instance, and `stop()` on it must
	 * still reach the runtime the old one started.
	 */
	private get runtime(): AgentSessionRuntime | undefined {
		return rowState("print", () => ({ runtime: undefined as AgentSessionRuntime | undefined })).runtime;
	}
	private set runtime(runtime: AgentSessionRuntime | undefined) {
		rowState("print", () => ({ runtime: undefined as AgentSessionRuntime | undefined })).runtime = runtime;
	}

	constructor(ctx: any, config: RlmPrintConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		this.ctx.logger?.info(`rlm-print: ready`);
	}

	/**
	 * Run print mode: create runtime, send prompt, output result, exit.
	 * Returns the exit code.
	 */
	async run(
		options: PrintModeOptions & { sessionManager?: SessionManager; sessionConfig?: Record<string, unknown> },
	): Promise<number> {
		const rlmAgent = this.ctx.get("rlmAgent") as {
			createRuntime: (options: {
				sessionConfig?: Record<string, unknown>;
				sessionOptions?: Record<string, unknown>;
				sessionManager?: SessionManager;
				sessionConfig?: Record<string, unknown>;
			}) => Promise<AgentSessionRuntime>;
		};

		if (!rlmAgent?.createRuntime) {
			throw new Error("rlm-print: rlmAgent.createRuntime not available");
		}

		// `--resume <id>` / `--continue` / `--fork` arrive as a session manager from
		// the modes row; without one the session row's fresh session is used.
		// `sessionConfig` is the rest of the command line (--model, --thinking, …).
		const { sessionManager, sessionConfig, ...printOptions } = options;
		// Daemon mode (opt-in, RLM_DAEMON=1): upstream runs print in a
		// client-owned worker; the worker is removed when the run completes.
		if (process.env.RLM_DAEMON === "1") {
			const { runRlmDaemonPrint } = await import("../../coding-agent/src/modes/daemon/rlm-daemon-client.js");
			return runRlmDaemonPrint({
				config: (sessionConfig ?? {}) as never,
				cwd: (sessionConfig?.cwd as string | undefined) ?? this.config.cwd ?? process.cwd(),
				mode: printOptions.mode === "json" ? "json" : "text",
				initialMessage: printOptions.initialMessage,
				messages: printOptions.messages,
				sessionManager,
				socketPath: process.env.RLM_DAEMON_SOCKET || undefined,
			});
		}
		this.runtime = await rlmAgent.createRuntime({
			...(sessionManager ? { sessionManager } : {}),
			...(sessionConfig ? { sessionConfig } : {}),
		});
		return runPrintMode(this.runtime, printOptions);
	}

	/** Before a swap: an instance from before the Surface kept `runtime` as an own field; move it over. */
	[Symbol.for("rlm.hmr.handover")]() {
		if (!Object.hasOwn(this, "runtime")) return;
		const runtime = (this as any).runtime;
		delete (this as any).runtime;
		if (runtime && !this.runtime) this.runtime = runtime;
	}

	async stop(): Promise<void> {
		if (this.runtime) {
			await this.runtime.dispose?.();
			this.runtime = undefined;
		}
	}
}

export default RlmPrintService;
export const name = "rlm-print";
export const inject = ["rlmAgent"] as const;
export { RlmPrintService as RlmPrint };
export type { PrintModeOptions };
