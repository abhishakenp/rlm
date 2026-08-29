/**
 * code — persistent JS code execution tool.
 *
 * Replaces the old Python kernel tool entirely. No kernel process.
 * Uses Node's vm.Context for persistent variable state across calls.
 *
 * Same UX as prime-agent's code tool:
 * - `!command` → shell out (line magic)
 * - `%%bash` cell magic → multi-line shell block
 * - Persistent variables across calls (vm.Context = kernel namespace)
 * - console.log() output captured as stdout
 * - Last expression value captured as result
 * - rlm.run() for in-process subagent spawning
 * - fs, path, os, child_process, fetch, import() all available
 */
import { createRequire } from "node:module";
import vm from "node:vm";
import { exec, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const require = createRequire(import.meta.url);

// ─── Schema ──────────────────────────────────────────────────────────────────

const codeSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript scratchpad code or `%%bash` shell cells to execute in the agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type CodeToolInput = Static<typeof codeSchema>;

export interface CodeToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	stdout?: string;
	stderr?: string;
	result?: string;
	diffs?: { path: string; diff: string; oldStr?: string; newStr?: string; startLine?: number }[];
}

export interface CodeToolOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	maxOutputChars?: number;
	sessionId?: string;
	/** Host request handlers for rlm.run, goal.*, etc. */
	hostHandlers?: HostRequestHandlers;
	/** Python skills — kept for compatibility, ignored by JS code tool. */
	pythonSkills?: readonly any[];
	/** Per-session artifact dir where namespace snapshot would be stored. Ignored by JS code tool. */
	snapshotDir?: string;
	/** Resolves before this kernel starts — ignored by JS code tool (no async boot). */
	readyGate?: Promise<unknown>;
	/** Fires once per kernel start when a previous session's namespace was revived. */
	onRestore?: (result: any) => void;
	/** Fires when a late agent message is sent from the kernel. */
	onLateSentAgentMessage?: (toolCallId: string, message: any) => void;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	/** Optional explicit shell path for bare %%bash cells. */
	shellPath?: string;
	/** Shared provisioner owning the kernel lifecycle. */
	provisioner?: CodeKernelProvisioner;
	/** Context proxy from @rlm/context — injected into the VM sandbox. */
	contextProxy?: any;
}

// ─── Host request handlers (for rlm SDK integration) ─────────────────────────

export interface HostRequestHandlers {
	[key: string]: ((...args: any[]) => Promise<any>) | undefined;
}

// ─── Code kernel provisioner ─────────────────────────────────────────────────

/**
 * Owns the lazy create of one session's JS code kernel.
 * Much simpler than the old provisioner — no process spawn,
 * no ZMQ, no snapshots. Just a vm.Context created on first use.
 */
export class CodeKernelProvisioner {
	private context: vm.Context | null = null;
	private outputCapture = { stdout: [] as string[], stderr: [] as string[] };
	private _disposed = false;

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<CodeToolOptions, "provisioner">,
	) {}

	/** The kernel is always "running" — it's just a VM context. */
	get hasRunningKernel(): boolean {
		return this.context !== null && !this._disposed;
	}

	/** Start the kernel in the background. For VM context, this is a no-op. */
	prewarm(): void {
		if (!this.context) this.ensure().catch(() => {});
	}

	/** Ensure the VM context exists. */
	async ensure(): Promise<vm.Context> {
		if (this._disposed) throw new Error("Code kernel provisioner disposed");
		if (!this.context) this.resetContext();
		return this.context!;
	}

	/** Dispose the kernel. */
	async dispose(): Promise<void> {
		this._disposed = true;
		this.context = null;
	}

	async kill(): Promise<void> {
		await this.dispose();
	}

	/** Prune oversized variables — no-op for VM context (no size limits). */
	async pruneOversizedVariables(): Promise<string[] | null> {
		return null;
	}

	/** List user-defined variables in the context. */
	async listNamespaceNames(_signal?: AbortSignal): Promise<string[] | null> {
		if (!this.context) return null;
		return Object.getOwnPropertyNames(this.context).filter(
			(k) => !k.startsWith("__") && !BUILTINS.has(k),
		);
	}

	/** Create a fresh vm context with all builtins exposed. */
	resetContext() {
		const cwd = this.options?.cwd ?? this.cwd;

		const sandbox: Record<string, any> = {
			// Node builtins
			exec,
			execSync,
			fs,
			path,
			os,
			process,
			Buffer,
			TextEncoder,
			TextDecoder,
			URL,
			URLSearchParams,
			setTimeout,
			setInterval,
			clearTimeout,
			clearInterval,
			fetch: globalThis.fetch,

			// console.log → captured as stdout
			console: {
				log: (...args: any[]) => this.outputCapture.stdout.push(args.map(formatValue).join(" ") + "\n"),
				error: (...args: any[]) => this.outputCapture.stderr.push(args.map(formatValue).join(" ") + "\n"),
				warn: (...args: any[]) => this.outputCapture.stderr.push(args.map(formatValue).join(" ") + "\n"),
				info: (...args: any[]) => this.outputCapture.stdout.push(args.map(formatValue).join(" ") + "\n"),
				debug: (...args: any[]) => this.outputCapture.stdout.push(args.map(formatValue).join(" ") + "\n"),
			},

			// Dynamic import for ESM modules
			import: (name: string) => import(name),

			// require for CJS modules
			require,

			// rlm SDK — resolved lazily via host handlers
			rlm: this.createRlmProxy(),

			// Context registry — persistent typed variables (agent working memory)
			context: this.options?.contextProxy,

		// TUI service — for inspecting registered extensions (read-only)
		tui: new Proxy({}, { get: (_, prop) => (globalThis as any).__rlmTui?.[prop] }),

			// Helpers
			cwd,
		};

		this.context = vm.createContext(sandbox, {
			name: "rlm-code",
			codeGeneration: { strings: false, wasm: false },
		});
	}

	/** Create rlm proxy from host handlers. */
	private createRlmProxy(): any {
		const handlers = this.options?.hostHandlers;
		if (!handlers) return undefined;

		// Adapt the host handler call format. Host handlers expect payload objects
		// (e.g. { prompt, kwargs }), but the agent calls rlm.run("prompt", opts)
		// directly. These wrappers adapt the call signature.
		const runHandler = handlers["rlm.run"];
		const listHandler = handlers["rlm.list_subagents"];
		const deleteHandler = handlers["rlm.delete_subagent"];
		const findModelsHandler = handlers["rlm.find_models"];

		const rlmObj: any = {
			run: runHandler
				? async (prompt: string, opts?: any) => {
						if (typeof prompt !== "string") throw new Error("rlm.run prompt must be a string");
						return runHandler({ prompt, kwargs: opts ?? {}, cellSourceCode: undefined });
					}
				: undefined,
			spawn: runHandler
				? async (prompt: string, opts?: any) => {
						if (typeof prompt !== "string") throw new Error("rlm.run prompt must be a string");
						const result = await runHandler({ prompt, kwargs: opts ?? {}, cellSourceCode: undefined });
						// Extract the result text from the host handler response.
						if (result && typeof result === "object") {
							return result.result ?? result.text ?? JSON.stringify(result);
						}
						return String(result);
					}
				: undefined,
			listSubagents: listHandler
				? async () => {
						const result = await listHandler();
						return result?.subagents ?? result ?? [];
					}
				: undefined,
			deleteSubagent: deleteHandler
				? async (target: string) => {
						return deleteHandler({ target });
					}
				: undefined,
			find_models: findModelsHandler
				? async (query: string, limit?: number) => {
						return findModelsHandler({ query, limit });
					}
				: undefined,
		};

		// Goal management — map to goal.* handlers if present.
		const goalGet = handlers["goal.get"];
		const goalCreate = handlers["goal.create"];
		const goalComplete = handlers["goal.complete"];
		if (goalGet || goalCreate || goalComplete) {
			rlmObj.goal = {
				get: goalGet ? async () => goalGet({}) : undefined,
				create: goalCreate ? async (objective: string, opts?: any) => goalCreate({ objective, ...opts }) : undefined,
				complete: goalComplete ? async () => goalComplete({}) : undefined,
			};
		}

		return rlmObj;
	}

	/**
	 * Execute JS code in the persistent context.
	 * Variables persist across calls — same as kernel cells.
	 */
	async execute(code: string, _opts?: { signal?: AbortSignal; onStream?: (chunk: string, name: "stdout" | "stderr") => void }): Promise<CodeExecuteResult> {
		if (!this.context) this.resetContext();
		const timeout = this.options?.timeout ?? 30000;
		const maxChars = this.options?.maxOutputChars ?? 65536;
		const started = Date.now();

		// Reset output capture for this cell.
		this.outputCapture.stdout.length = 0;
		this.outputCapture.stderr.length = 0;

		// Transform !shell and %%bash syntax.
		const transformed = this.transformCode(code);

		try {
			const finalCode = transformVarToGlobal(transformed);
			const withReturn = captureLastExpression(finalCode);
			const wrapped = `(async () => {\n${withReturn}\n})()`;

			const result = vm.runInContext(wrapped, this.context!, {
				timeout,
				displayErrors: true,
			});

			// Await promise with real ms timeout.
			let value: any = result;
			if (value && typeof value.then === "function") {
				value = await Promise.race([
					value,
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error(`Code timeout after ${timeout}ms`)), timeout),
					),
				]);
			}

			let stdout = this.outputCapture.stdout.join("");
			let stderr = this.outputCapture.stderr.join("");
			let resultStr: string | undefined;

			if (value !== undefined) {
				resultStr = formatValue(value);
			}

			// Stream output if handler provided.
			if (_opts?.onStream) {
				if (stdout) _opts.onStream(stdout, "stdout");
				if (stderr) _opts.onStream(stderr, "stderr");
			}

			// Truncate to max chars.
			if (stdout.length > maxChars) {
				stdout = stdout.slice(0, maxChars) + "\n... (truncated)";
			}
			if (stderr.length > maxChars) {
				stderr = stderr.slice(0, maxChars) + "\n... (truncated)";
			}

			return {
				stdout,
				stderr,
				result: resultStr,
				status: "ok",
				durationMs: Date.now() - started,
			};
		} catch (error) {
			let stdout = this.outputCapture.stdout.join("");
			let stderr = this.outputCapture.stderr.join("");

			return {
				stdout,
				stderr,
				status: "error",
				error: {
					ename: error instanceof Error ? error.name : "Error",
					evalue: error instanceof Error ? error.message : String(error),
					traceback: error instanceof Error ? (error.stack ?? "").split("\n") : [String(error)],
				},
				durationMs: Date.now() - started,
			};
		}
	}

	/**
	 * Pre-process code — transform shell syntax to JS:
	 *   !command        →  execSync("command").toString()
	 *   %%bash\n...     →  execSync("...").toString()
	 *
	 * Applies commandPrefix and shellPath from options to all shell cells.
	 */
	private transformCode(code: string): string {
		const prefix = this.options?.commandPrefix;
		const shellPath = this.options?.shellPath;
		// Build the exec options string fragment.
		const execOptsParts = ["encoding: 'utf8'", "stdio: ['pipe', 'pipe', 'pipe']"];
		if (shellPath) {
			execOptsParts.push(`shell: ${JSON.stringify(shellPath)}`);
		}
		const execOpts = `{ ${execOptsParts.join(", ")} }`;

		// %%bash cell magic — entire block is shell.
		const bashMatch = code.match(/^([ \t]*)%%bash\b[^\n]*\n([\s\S]*)/);
		if (bashMatch) {
			const indent = bashMatch[1] ?? "";
			let body = (bashMatch[2] ?? "").trim();
			if (prefix) body = `${prefix}\n${body}`;
			return `${indent}execSync(${JSON.stringify(body)}, ${execOpts})`;
		}

		// ! line magic — each line starting with ! becomes execSync.
		const lines = code.split("\n");
		const transformed: string[] = [];

		for (const line of lines) {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("!")) {
				let cmd = trimmed.slice(1).trim();
				if (prefix) cmd = `${prefix} ${cmd}`;
				const indent = line.slice(0, line.length - trimmed.length);
				transformed.push(`${indent}execSync(${JSON.stringify(cmd)}, ${execOpts})`);
			} else {
				transformed.push(line);
			}
		}

		return transformed.join("\n");
	}
}

// ─── Execute result (same shape as kernel ExecuteResult) ─────────────────────

export interface CodeExecuteResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
	durationMs: number;
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export function createCodeToolDefinition(
	cwd: string,
	options?: CodeToolOptions,
): ToolDefinition<typeof codeSchema, CodeToolDetails> {
	const provisioner = options?.provisioner ?? new CodeKernelProvisioner(cwd, options);

	return {
		name: "code",
		label: "code",
		description:
			"Execute JavaScript scratchpad code and `%%bash` shell cells in a persistent JS kernel. Variables, imports, and loaded data persist across calls. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks.",
		promptSnippet: "code - persistent agent notebook for JS scratchpad code and %%bash orchestration",
		executionMode: "sequential",
		parameters: codeSchema,
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				try {
					ctx?.ui.setWorkingMessage(message);
				} catch {
					// Stale UI context; cosmetic only.
				}
				hasWorkingMessage = message !== undefined;
			};

			try {
				const { result: r } = await executeWithBusyKernelChoice(
					provisioner,
					params.code,
					signal,
					(chunk) => {
						onUpdate?.({
							content: [{ type: "text", text: chunk }],
							details: { status: "ok" },
						});
					},
					setToolWorkingMessage,
					ctx,
				);

				let text = r.stdout;
				if (r.stderr) text += (text ? "\n" : "") + r.stderr;
				if (r.result) text += (text ? "\n" : "") + r.result;
				if (r.status === "error" && r.error) {
					text += (text ? "\n" : "") + r.error.traceback.join("\n");
				}

				const content: TextContent[] = [{ type: "text", text: text || "" }];

				return {
					content,
					details: {
						durationMs: r.durationMs,
						status: r.status,
						stdout: r.stdout,
						stderr: r.stderr,
						result: r.result,
					},
					isError: r.status === "error" || r.status === "aborted",
				};
			} finally {
				if (hasWorkingMessage) {
					setToolWorkingMessage();
				}
			}
		},
	};
}

export function createCodeTool(cwd: string, options?: CodeToolOptions): AgentTool<typeof codeSchema> {
	return wrapToolDefinition(createCodeToolDefinition(cwd, options));
}

// ─── Busy kernel choice (simplified — VM context can't get "busy") ───────────

async function executeWithBusyKernelChoice(
	provisioner: CodeKernelProvisioner,
	code: string,
	signal: AbortSignal | undefined,
	onStream: (chunk: string, name: "stdout" | "stderr") => void,
	onWorkingMessage: (message?: string) => void,
	_ctx: ExtensionContext | undefined,
): Promise<{ result: CodeExecuteResult }> {
	if (signal?.aborted) {
		return {
			result: {
				stdout: "",
				stderr: "",
				status: "aborted",
				durationMs: 0,
			},
		};
	}

	await provisioner.ensure();
	const result = await provisioner.execute(code, { signal, onStream });
	return { result };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BUILTINS = new Set([
	"exec", "execSync", "fs", "path", "os", "process", "console",
	"Buffer", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
	"setTimeout", "setInterval", "clearTimeout", "clearInterval",
	"fetch", "import", "require", "rlm", "cwd",
	"globalThis", "global",
]);

/**
 * Transform `var x = val` → `globalThis.x = val` so variables persist
 * across calls even inside the async IIFE wrapper.
 */
function transformVarToGlobal(code: string): string {
	return code.replace(
		/^([ \t]*)var ([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/gm,
		"$1globalThis.$2 =",
	);
}

/**
 * Capture the last expression's value by prepending `return`.
 * Same as the kernel execute_result — the last expression value is displayed.
 */
function captureLastExpression(code: string): string {
	const lines = code.split("\n");

	let lastIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
		lastIdx = i;
		break;
	}

	if (lastIdx === -1) return code;

	const lastLine = lines[lastIdx];
	const trimmed = lastLine.trim();

	if (trimmed.endsWith("{") || trimmed.endsWith("}")) return code;

	const segments = trimmed.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
	if (segments.length === 0) return code;

	const lastSegment = segments[segments.length - 1];

	const statementKeywords = [
		"if", "for", "while", "const", "let", "var", "function", "class",
		"return", "throw", "try", "switch", "do", "import", "export",
		"type", "interface", "enum", "break", "continue", "debugger",
	];

	const firstWord = lastSegment.split(/[^a-zA-Z_$]/)[0];
	if (statementKeywords.includes(firstWord)) return code;

	const indent = lastLine.slice(0, lastLine.length - lastLine.trimStart().length);
	const allButLast = segments.slice(0, -1).join("; ");
	lines[lastIdx] = `${indent}${allButLast ? allButLast + "; " : ""}return ${lastSegment}`;

	return lines.join("\n");
}

/** Format a value for display — like repr. */
function formatValue(value: any): string {
	if (value === null) return "null";
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value instanceof Error) return value.stack ?? value.message;
	if (typeof value === "object") {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}
	return String(value);
}
