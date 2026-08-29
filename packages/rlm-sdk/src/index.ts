/**
 * @rlm/sdk — TypeScript SDK for rlm.
 *
 * Cordis Service. Wraps the coding-agent runtime's createAgentSession()
 * for in-process subagent spawning.
 *
 * API surface:
 *   - rlm.run(prompt, opts) → spawn a child agent, get a handle
 *   - rlm.spawn(prompt, opts) → spawn and await result string
 *   - rlm.listSubagents() → list active children
 *   - rlm.deleteSubagent(name) → dispose a child
 *   - rlm.goal.* → goal management
 *
 * Workflows use this SDK to compose recursive agent trees.
 *
 * Child sessions get the JS code tool via baseToolsOverride, connected
 * to the shared Cordis rlmCode service.
 */
import { Service } from "@deepseek-ai/cordis";
import { createJsCodeTool } from "./js-code-tool.js";

export interface RlmSdkConfig {
	maxDepth?: number;
	defaultModel?: string;
}

export interface SpawnOptions {
	name?: string;
	model?: string;
	thinking?: string;
	cwd?: string;
	depth?: number;
	/** Context variable patterns to pass to the child (e.g. ["auth.*", "db.*"]). */
	context?: string[];
}

export interface SubagentHandle {
	id: string;
	name: string;
	prompt: string;
	status: "running" | "completed" | "error";
	result?: string;
	error?: string;
	sessionDir?: string;
}

export interface SubagentInfo {
	id: string;
	name: string;
	status: "running" | "completed" | "error";
	sessionName: string;
}

export interface GoalInfo {
	id?: string;
	objective: string;
	status: "idle" | "active" | "paused" | "complete" | "error";
	tokenBudget?: number;
	tokensUsed: number;
}

/**
 * RlmSdkService — the TS SDK as a Cordis service.
 *
 * Other plugins (workflow, learn) inject this service and use it to
 * spawn subagents, manage goals, and compose recursive agent trees.
 *
 * The SDK creates child AgentSessions via createAgentSession() from the
 * prime-agent runtime. Each child gets its own agent loop, tools, model,
 * and session persistence — same as rlm.run() but in-process TS.
 */
export class RlmSdkService extends Service {
	static inject = [] as const;
	static provide = "rlmSdk" as const;

	declare config: RlmSdkConfig;
	private children: Map<string, SubagentHandle> = new Map();
	private childSessions: Map<string, any> = new Map();
	private createAgentSessionFn: any = null;
	private goalState: GoalInfo = { objective: "", status: "idle", tokensUsed: 0 };

	constructor(ctx: any, config: RlmSdkConfig = {}) {
		super(ctx, undefined as any);
		this.config = typeof config === "object" && !Array.isArray(config) ? config : {};
	}

	async [Service.init]() {
		// Load createAgentSession from the coding-agent package.
		// In dev mode (tsx): imports from TS source.
		// In installed mode: imports from compiled dist.
		try {
			const mod = await import("@earendil-works/pi-coding-agent");
			this.createAgentSessionFn = mod.createAgentSession;
		} catch {
			try {
				// Fallback: direct path to dist
				const mod = await import(
					/* @vite-ignore */ new URL(
						"../../coding-agent/dist/index.js",
						import.meta.url,
					).href
				);
				this.createAgentSessionFn = mod.createAgentSession;
			} catch (error) {
				this.ctx.logger?.warn(
					`rlm-sdk: createAgentSession unavailable: ${error?.message ?? error}`,
				);
			}
		}
		this.ctx.logger?.info(
			`rlm-sdk: TS SDK ready (maxDepth=${this.config.maxDepth ?? 10})`,
		);
	}

	/**
	 * Spawn a subagent. Returns a handle that can be awaited for the result.
	 *
	 * Same semantics as rlm.run(prompt, opts):
	 *   - Creates a child AgentSession with incremented depth
	 *   - Child gets its own agent loop, tools, model, session
	 *   - Result is the child's final assistant message
	 */
	async run(prompt: string, opts: SpawnOptions = {}): Promise<SubagentHandle> {
		const maxDepth = this.config.maxDepth ?? 10;
		const depth = opts.depth ?? 1;
		if (depth >= maxDepth) {
			return {
				id: `depth-exceeded-${Date.now()}`,
				name: opts.name ?? "unnamed",
				prompt,
				status: "error",
				error: `max depth ${maxDepth} exceeded (current: ${depth})`,
			};
		}

		if (!this.createAgentSessionFn) {
			throw new Error("rlm-sdk: createAgentSession not available");
		}

		const id = `${opts.name ?? "child"}-${depth}-${Date.now()}`;
		const handle: SubagentHandle = {
			id,
			name: opts.name ?? "unnamed",
			prompt,
			status: "running",
		};
		this.children.set(id, handle);

		this.ctx.logger?.info(`rlm-sdk: spawning ${id} at depth ${depth}`);
		this.ctx.emit("rlm/sdk-spawn", { id, depth, prompt, name: opts.name });

		try {
			// Connect the child's code tool to the shared Cordis rlmCode service.
			const codeService = this.ctx.get("rlmCode");
			const baseToolsOverride: Record<string, any> = {};
			if (codeService) {
				baseToolsOverride.code = createJsCodeTool(codeService);
			}

			// Pass context variables to the child's task scope.
			const contextService = this.ctx.get("rlmContext");
			if (contextService && opts.context && opts.context.length > 0) {
				const snapshot = contextService.toSnapshot(opts.context);
				// Load the snapshot into the child's task scope via globalThis.
				(globalThis as any).__rlmTaskContextSnapshot = snapshot;
			}

			const { session } = await this.createAgentSessionFn({
				cwd: opts.cwd ?? process.cwd(),
				rlmDepth: depth,
				rlmMaxDepth: maxDepth,
				...(Object.keys(baseToolsOverride).length > 0 ? { baseToolsOverride } : {}),
			});
			this.childSessions.set(id, session);

			// Run the agent loop — promptAndWait sends the prompt and
			// resolves after the agent finishes processing.
			await session.promptAndWait(prompt, {
				expandPromptTemplates: false,
				source: "extension",
			});

			// Extract the last assistant message as the result.
			const messages = session.messages ?? session.agent?.state?.messages ?? [];
			const lastAssistant = [...messages]
				.reverse()
				.find((m: any) => m.role === "assistant");
			handle.status = "completed";
			handle.result = extractAssistantText(lastAssistant);
			handle.sessionDir = session.sessionManager?.getSessionDir?.();

			this.ctx.emit("rlm/sdk-complete", { id, depth, result: handle.result });
		} catch (error) {
			handle.status = "error";
			handle.error = error instanceof Error ? error.message : String(error);
			this.ctx.emit("rlm/sdk-error", { id, depth, error: handle.error });
		} finally {
			this.childSessions.delete(id);
		}

		return handle;
	}

	/**
	 * Spawn a subagent and await its result — convenience for `await rlm.run(prompt).result`.
	 */
	async spawn(prompt: string, opts?: SpawnOptions): Promise<string> {
		const handle = await this.run(prompt, opts);
		if (handle.status === "error") throw new Error(handle.error);
		return handle.result ?? "";
	}

	/** List active and completed subagents. */
	listSubagents(): SubagentInfo[] {
		return [...this.children.values()].map((h) => ({
			id: h.id,
			name: h.name,
			status: h.status,
			sessionName: h.name,
		}));
	}

	/** Delete a subagent by name or id. */
	async deleteSubagent(target: string): Promise<SubagentHandle | null> {
		const handle =
			this.children.get(target) ??
			[...this.children.values()].find((h) => h.name === target);
		if (!handle) return null;

		const session = this.childSessions.get(handle.id);
		if (session) {
			try {
				await session.disposeAsync?.();
			} catch {
				// Best effort.
			}
			this.childSessions.delete(handle.id);
		}
		this.children.delete(handle.id);
		return handle;
	}

	/** Goal management — simplified in-process goal state. */
	goal = {
		create: (objective: string, opts?: { tokenBudget?: number }) => {
			this.goalState = {
				objective,
				status: "active",
				tokenBudget: opts?.tokenBudget,
				tokensUsed: 0,
				id: `goal-${Date.now()}`,
				createdAt: Date.now(),
			} as any;
			this.ctx.emit("rlm/goal-create", this.goalState);
			return this.goalState;
		},
		get: (): GoalInfo => ({ ...this.goalState }),
		complete: () => {
			this.goalState.status = "complete";
			this.ctx.emit("rlm/goal-complete", this.goalState);
		},
		pause: () => {
			this.goalState.status = "paused";
		},
	};

	/** Cancel all active children. */
	cancelAll() {
		for (const [, session] of this.childSessions) {
			try {
				session.disposeAsync?.();
			} catch {}
		}
		this.childSessions.clear();
		this.children.clear();
	}

	async [Symbol.dispose]() {
		this.cancelAll();
	}
}

export default RlmSdkService;
export const name = "rlm-sdk";
export const inject = [] as const;
export { RlmSdkService as RlmSdk };

/** Extract text from an assistant message (handles string + content parts array). */
function extractAssistantText(msg: any): string {
	if (!msg) return "(no response)";
	const content = msg.content ?? msg.text;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");
	}
	return JSON.stringify(content);
}
