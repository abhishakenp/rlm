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

// ─── Prompt Doctrine (MANDATORY) ────────────────────────────────────────────
//
// Plugin-owned, hot-reloadable system-prompt fragment registered via the
// rlmPrompt service. Mirrors buildSubagentGuidance but with MANDATORY
// language so the LLM MUST use rlm.* at every decomposable step without a
// second AGENTS.md source. Registered at priority 80 (context=100,
// refine=70) and removed on dispose so fiber.restart() updates the prompt
// live via rlm/prompt-changed.

export const SDK_DOCTRINE = [
	"# SDK — Use at every step (MANDATORY)",
	"",
	"You MUST use `rlm.*` SDK at EVERY step when the task decomposes into independent sub-tasks. This is MANDATORY, not optional — you think in parallel subagents by default without being asked.",
	"",
	"## API",
	"",
	"- `handle = rlm.run(prompt, { name })` — spawn a child agent, returns handle IMMEDIATELY at admission (`{ id, name, status }`), NOT at completion. You MUST use this for every decomposable sub-task. Keep the handle to stop or inspect the child later.",
	"- `result = await rlm.spawn(prompt, opts)` — spawn and await the result string. Use when you MUST have the result before continuing; otherwise prefer `rlm.run`.",
	"- `rlm.listSubagents()` — list active children (`{ id, name, status, sessionName }[]`). You MUST call this after kernel restart or compaction to recover handles.",
	"- `rlm.deleteSubagent(target)` — dispose a child by id or name when no longer needed. You MUST clean up children explicitly.",
	"- `rlm.goal.create(objective, { tokenBudget })` / `rlm.goal.get()` / `rlm.goal.complete()` / `rlm.goal.pause()` — goal management for long-running objectives.",
	"",
	"## Context transfer — copy/move/mutate/clone ANYTHING to variable/s (1 or many) and transfer to subagents",
	"",
	"You can powerfully operate on context via `context.*` (see Context doctrine) — copy / move / mutate / clone 1 or MANY variables — then transfer atomically when spinning subagents. The harness facilitates you operating on your own context (every mutation invalidates the next prompt live). Plugins micro-control each capability via config (enableClone, enableMutate, enableBulkOps, enableSubagentTransfer — all true by default, no AI needed to toggle).",
	"",
	"- COPY many: `rlm.run(\"task\", { context: [\"auth.*\", \"db.*\"] })` — copies all matching vars atomically to child's task scope (parent KEEPS them). Any number of patterns/variables.",
	"- MOVE many: `rlm.run(\"task\", { contextMove: [\"auth.*\"] })` or `{ context: [\"auth.*\"], contextStrategy: \"move\" }` — destructive transfer (parent LOSES them, child owns them).",
	"- Prep before transfer: `context.cloneMany([\"auth.*\"], \"backup.\")` → backup many, `context.mutate('auth.files', v=>v.filter(...))` → transform one, `context.mutateMany('auth.*', v=>...)` → transform many, `context.batch([...])` → atomic batch.",
	"- You MAY omit context to spawn with empty task scope; you MAY pass many patterns — the harness snapshots atomically via `rlmContext.toSnapshot` / `move` and rehydrates in child's `task` scope via `loadTaskSnapshot`.",
	"",
	"## MANDATORY Rules — You MUST obey at every step",
	"",
	"- You MUST spawn independent tasks in PARALLEL: call `rlm.run` multiple times WITHOUT awaiting between them, then end your turn. NEVER await sequentially in a loop. Spawn all, then wait via messages or file fan-in.",
	"- You MUST keep handles — do NOT discard the return value of `rlm.run`. Use them to track, message, or delete children.",
	"- You MUST have children write files and read those files for fan-in; do NOT try to collect large results only via return values.",
	"- You MUST delegate parallel context-heavy research or independent implementation to subagents; do a single known lookup, edit, or shell command inline ONLY when it is a single atomic operation.",
	"- When messaging, you MUST use `await agent_message.send(message, receiver_role='parent')` in children and `receiver_role='child'` plus child's name/id in parents when an explicit reply is needed. Not every message needs a reply.",
	"- You MUST use `agent_observe` for bounded transcript inspection when available; otherwise inspect files a child wrote.",
	"- You MUST NOT keep the turn open polling with `time.sleep()` or shell `sleep`, and you MUST NOT replace polling with a long blocking `await`. Await only the short operation needed to start work or inspect a result that is already available; otherwise end your turn and read replies on a later turn.",
	"- You MUST delete a direct child explicitly with `rlm.deleteSubagent(handle)` when it is no longer needed.",
	"",
	"## When to delegate vs inline",
	"",
	"- Delegate: parallel research, independent implementation, context-heavy exploration, or any task that can be self-contained.",
	"- Inline: a single known lookup, a single edit, or a single shell command that does not benefit from parallelism.",
].join("\n");

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
	/** Context variable patterns to COPY to the child (non-destructive, parent keeps). Supports 1 or MANY vars, any pattern. */
	context?: string[];
	/** Context variable patterns to MOVE to the child (destructive, parent loses). Atomic transfer. */
	contextMove?: string[];
	/** When set to "move", opts.context is treated as a move (destructive). Default "copy". */
	contextStrategy?: "copy" | "move";
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

	// ─── Prompt fragment (hot-reloadable) ─────────────────────────────────
	private promptHandle: any = null;
	private promptRetryTimer: ReturnType<typeof setTimeout> | null = null;

	private getPromptService(): any | null {
		try {
			const fromGlobal = (globalThis as any).__rlmPrompt;
			if (fromGlobal?.registerFragment) return fromGlobal;
		} catch {}
		try {
			const fromCtx = (this.ctx as any)?.get?.("rlmPrompt");
			if (fromCtx?.registerFragment) return fromCtx;
		} catch {}
		return null;
	}

	private registerPromptFragment(): void {
		const svc = this.getPromptService();
		if (!svc) {
			if (this.promptRetryTimer) clearTimeout(this.promptRetryTimer);
			this.promptRetryTimer = setTimeout(() => {
				this.promptRetryTimer = null;
				if (this.promptHandle) return;
				this.registerPromptFragment();
			}, 300);
			try {
				(this.ctx as any)?.once?.("internal/service", () => {
					if (!this.promptHandle) this.registerPromptFragment();
				});
			} catch {}
			return;
		}
		if (this.promptHandle) return;
		try {
			this.promptHandle = svc.registerFragment("rlm-sdk", {
				id: "sdk-doctrine",
				priority: 80,
				content: () => SDK_DOCTRINE,
			});
			this.ctx.logger?.info("rlm-sdk: registered prompt fragment (sdk-doctrine, priority 80)");
		} catch (error) {
			this.ctx.logger?.warn(
				`rlm-sdk: failed to register prompt fragment: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private disposePromptFragment(): void {
		if (this.promptRetryTimer) {
			clearTimeout(this.promptRetryTimer);
			this.promptRetryTimer = null;
		}
		if (this.promptHandle) {
			try {
				this.promptHandle.dispose();
			} catch {}
			this.promptHandle = null;
		} else {
			try {
				const svc = this.getPromptService();
				svc?.disposePlugin?.("rlm-sdk");
			} catch {}
		}
	}

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
					`rlm-sdk: createAgentSession unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		this.ctx.logger?.info(
			`rlm-sdk: TS SDK ready (maxDepth=${this.config.maxDepth ?? 10})`,
		);
		this.registerPromptFragment();
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
		(this.ctx as any).emit("rlm/sdk-spawn", { id, depth, prompt, name: opts.name });

		try {
			// Connect the child's code tool to the shared Cordis rlmCode service.
			const codeService = this.ctx.get("rlmCode");
			const baseToolsOverride: Record<string, any> = {};
			if (codeService) {
				baseToolsOverride.code = createJsCodeTool(codeService);
			}

			// Pass context variables to the child's task scope — 1 or MANY, copy or move, atomically.
			const contextService = this.ctx.get("rlmContext");
			if (contextService) {
				const wantsCopy = !!(opts.context && opts.context.length > 0);
				const wantsMove = !!(opts.contextMove && opts.contextMove.length > 0);
				const strategy = opts.contextStrategy ?? (wantsMove ? "move" : "copy");
				// Micro-control gates (harness facilitates AI operating on its own context live)
				if ((wantsCopy || wantsMove) && contextService.config && contextService.config.enableSubagentTransfer === false) {
					throw new Error("rlm-sdk: subagent transfer disabled by rlm-context config (enableSubagentTransfer=false)");
				}
				let snapshot: any = null;
				if (wantsMove) {
					// Explicit move — destructive transfer (parent loses vars)
					snapshot = contextService.move(opts.contextMove!);
					(this.ctx as any).emit("rlm/sdk-context-move", { id, patterns: opts.contextMove, count: Object.keys(snapshot).length });
				} else if (wantsCopy) {
					if (strategy === "move") {
						snapshot = contextService.move(opts.context!);
						(this.ctx as any).emit("rlm/sdk-context-move", { id, patterns: opts.context, count: Object.keys(snapshot).length, via: "contextStrategy" });
					} else {
						snapshot = contextService.toSnapshot(opts.context!);
						(this.ctx as any).emit("rlm/sdk-context-copy", { id, patterns: opts.context, count: Object.keys(snapshot).length });
					}
				}
				if (snapshot !== null) {
					// Even empty snapshot clears previous leak; non-empty carries 1..N vars.
					(globalThis as any).__rlmTaskContextSnapshot = snapshot;
				}
			}

			const resolvedModel = opts.model ?? this.config.defaultModel;
			const { session } = await this.createAgentSessionFn({
				cwd: opts.cwd ?? process.cwd(),
				rlmDepth: depth,
				rlmMaxDepth: maxDepth,
				...(Object.keys(baseToolsOverride).length > 0 ? { baseToolsOverride } : {}),
				...(resolvedModel ? { model: resolvedModel } : {}),
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

			(this.ctx as any).emit("rlm/sdk-complete", { id, depth, result: handle.result });
		} catch (error) {
			handle.status = "error";
			handle.error = error instanceof Error ? error.message : String(error);
			(this.ctx as any).emit("rlm/sdk-error", { id, depth, error: handle.error });
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
			(this.ctx as any).emit("rlm/goal-create", this.goalState);
			return this.goalState;
		},
		get: (): GoalInfo => ({ ...this.goalState }),
		complete: () => {
			this.goalState.status = "complete";
			(this.ctx as any).emit("rlm/goal-complete", this.goalState);
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
		this.disposePromptFragment();
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
