/**
 * code — persistent JS code execution tool.
 *
 * Persistent JS execution via vm.Context.
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
import { exec as nodeExec, execSync, spawnSync } from "node:child_process";
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

/**
 * The dynamic-import loader handed to every cell.
 *
 * `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` is Node >= 20.12 / 21.7. On
 * anything older the constant is undefined, which `vm.runInContext` treats as
 * "no callback" — exactly the behaviour we had before, so an old runtime
 * degrades to the old error instead of failing to start.
 */
const DYNAMIC_IMPORT_LOADER = vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;

// ─── Schema ──────────────────────────────────────────────────────────────────

const codeSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript scratchpad code or `%%bash` shell cells to execute in the agent kernel. " +
			"This kernel is a plain Node vm — the only globals are exec, execSync, sh, fs, path, os, process, fetch, require, console, cwd. " +
			"Nothing else exists as a variable, so any capability outside this list must be reached by running a command: " +
			"`const out = await sh(\"some-cli --flag\")` returns that command's stdout as a string, or use a `%%bash` cell. " +
			"Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
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
			// Shelling out is the only way out of this sandbox, so the shell
			// helpers hand back the command's OUTPUT as a string. `exec` keeps
			// its familiar name but no longer resolves to a ChildProcess — a
			// handle nobody in a cell can read. `sh` is the same function under
			// the name the prompt teaches.
			exec: (cmd: string, opts?: any) =>
				runShell(cmd, { cwd: opts?.cwd ?? cwd, ...(opts ?? {}) }),
			sh: (cmd: string, opts?: any) =>
				runShell(cmd, { cwd: opts?.cwd ?? cwd, ...(opts ?? {}) }),
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
				// Without this, any `import()` inside a cell throws
				// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING: a vm context has no
				// module loader of its own. The sandbox's `import` property
				// (see resetContext) never helped — `import(x)` is syntax, not
				// a property lookup, so the parser never reaches it.
				//
				// The main context's default loader is used rather than a
				// custom callback because a custom one additionally requires
				// --experimental-vm-modules, which rlm is not started with.
				// Bare specifiers therefore resolve against rlm's own
				// node_modules, and relative ones against the host entry
				// rather than the cell's cwd — absolute paths are the reliable
				// form for project files.
				importModuleDynamically: DYNAMIC_IMPORT_LOADER,
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

			// A cell that ran clean but printed nothing looks identical to a cell
			// that silently failed. Say which it was, so the next step is not a
			// blind retry of something that already worked.
			if (!stdout && !stderr && resultStr === undefined) {
				resultStr = "(ran without error; nothing printed and no value returned)";
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

			const ename = error instanceof Error ? error.name : "Error";
			let evalue = error instanceof Error ? error.message : String(error);
			const traceback = error instanceof Error ? (error.stack ?? "").split("\n") : [String(error)];

			// A bare "x is not defined" is a dead end: it says what failed but
			// not what would have worked, so the next attempt is another guess.
			// Replace it with the one instruction that actually resolves it.
			// Not gated on `ename`: errors thrown inside the vm come from that
			// realm's own Error constructor, so `instanceof Error` is false here
			// and every one of them arrives named plain "Error". The message
			// itself is the reliable signal.
			const taught = teachReferenceError(evalue);
			if (taught) evalue = taught;

			return {
				stdout,
				stderr,
				status: "error",
				error: {
					ename,
					evalue,
					traceback,
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
	"exec", "execSync", "sh", "fs", "path", "os", "process", "console",
	"Buffer", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
	"setTimeout", "setInterval", "clearTimeout", "clearInterval",
	"fetch", "import", "require", "rlm", "cwd",
	"globalThis", "global",
]);

/** Sandbox globals worth naming when an unknown identifier is reached for. */
const SANDBOX_GLOBALS =
	"exec, execSync, sh, fs, path, os, process, fetch, require, console, cwd";

/**
 * A shell run whose value is the command's *output*, not a handle to it.
 *
 * Node's own `exec` resolves to a ChildProcess, which serialises into pages of
 * `_readableState` noise and tells the caller nothing about what the command
 * printed. An agent that cannot read a result cannot tell success from failure,
 * so it retries — which is how one "open this URL" becomes three browser
 * windows. This returns a string, always.
 */
function runShell(
	cmd: string,
	opts?: { cwd?: string; timeout?: number; env?: Record<string, string> },
): Promise<string> {
	return new Promise((resolve, reject) => {
		nodeExec(
			cmd,
			{
				encoding: "utf8",
				cwd: opts?.cwd,
				timeout: opts?.timeout ?? 120000,
				env: opts?.env ? { ...process.env, ...opts.env } : process.env,
				maxBuffer: 16 * 1024 * 1024,
			},
			(error: any, stdout: string, stderr: string) => {
				const out = String(stdout ?? "");
				const err = String(stderr ?? "");
				if (error) {
					const code = error.code ?? error.signal ?? "?";
					const detail = [err.trim(), out.trim()].filter(Boolean).join("\n");
					reject(
						new Error(
							`Command failed (exit ${code}): ${cmd}\n${detail || "(no output on stdout or stderr)"}`,
						),
					);
					return;
				}
				const combined = err.trim() ? `${out}${out && !out.endsWith("\n") ? "\n" : ""}${err}` : out;
				// A command that succeeds silently is the common case for things
				// like `open`, `mkdir`, `pkill`. Empty string reads as failure to
				// an agent, so say plainly that it worked.
				resolve(combined.trim() === "" ? `(exit 0 — command succeeded, no output)` : combined);
			},
		);
	});
}

/** True when `name` resolves to an executable on PATH. */
function isOnPath(name: string): boolean {
	if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
	try {
		const r = spawnSync("command", ["-v", name], {
			shell: "/bin/sh",
			encoding: "utf8",
			timeout: 2000,
		});
		return r.status === 0 && Boolean(r.stdout?.trim());
	} catch {
		return false;
	}
}

/**
 * Turn a bare `ReferenceError: x is not defined` into a message that says what
 * to do instead.
 *
 * The sandbox has exactly one way to reach the outside world: shelling out. An
 * agent that has been told about a capability by name will reach for it as a
 * JS global, get a dead-end ReferenceError, and guess again. If the name is a
 * real program on PATH, the fix is one line — say so.
 */
function teachReferenceError(message: string): string | null {
	// V8 hands this back sometimes bare ("x is not defined") and sometimes
	// already prefixed with the error name; accept either.
	const m = /^(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined$/.exec(message.trim());
	if (!m) return null;
	const name = m[1];
	if (isOnPath(name)) {
		return (
			`${message}\n\n` +
			`\`${name}\` is not a JavaScript global — it is a command-line program. ` +
			`Run it as a shell command and read what it prints:\n` +
			`    const out = await sh(\`${name} --help\`); console.log(out);\n` +
			`or use a shell cell:\n` +
			`    %%bash\n    ${name} --help`
		);
	}
	const base = name.replace(/[^A-Za-z0-9].*$/, "");
	const hint =
		base !== name && isOnPath(base)
			? `\n\`${base}\` IS a program on PATH, so try: await sh(\`${base} ...\`)`
			: "";
	return (
		`${message}\n\n` +
		`There is no \`${name}\` in this sandbox, and no program by that name on PATH. ` +
		`The only globals are: ${SANDBOX_GLOBALS}.\n` +
		`Anything outside the sandbox must be reached by shelling out — ` +
		`\`await sh("<command>")\` returns the command's output as a string.${hint}`
	);
}

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
