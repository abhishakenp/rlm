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
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, isBuiltin } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { exec as nodeExec, execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Type } from "@earendil-works/pi-ai/typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { asyncifyExecSync, EXEC_SYNC_ASYNC_NAME, execSyncAsync } from "./code-async-shell.js";
import { wrapCellSource } from "./cell-transform.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const require = createRequire(import.meta.url);

/** `require` for a cell: rlm's own node_modules, falling back to the cell's cwd. */
const cellRequire = (cwd: string): NodeJS.Require => {
	// Absolute, always: a subagent can carry a relative cwd ("."), and createRequire
	// rejects a relative filename — which killed every cell in that subagent.
	const fromCwd = createRequire(path.join(path.resolve(cwd || "."), "__rlm_cell__.js"));
	const cell = ((id: string) => {
		try {
			return require(id);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "MODULE_NOT_FOUND" && !/Cannot find (package|module)/.test(String((error as Error)?.message))) throw error;
			return fromCwd(id);
		}
	}) as NodeJS.Require;
	cell.resolve = ((id: string, options?: { paths?: string[] }) => {
		try {
			return require.resolve(id, options);
		} catch {
			return fromCwd.resolve(id, options);
		}
	}) as NodeJS.RequireResolve;
	cell.cache = require.cache;
	cell.main = require.main;
	cell.extensions = require.extensions;
	return cell;
};

/**
 * `import()` for a cell, under Bun only.
 *
 * With the main context's default loader a bare `import("js-yaml")` resolves
 * against `/evalmachine.<anonymous>` and fails even though `require("js-yaml")`
 * works. Bun accepts a callback here without Node's --experimental-vm-modules,
 * so resolve the way `cellRequire` does: rlm's install first, then the cell's
 * cwd. Node keeps the default loader (a callback needs the flag there).
 */
const cellImport = (cwd: string) => async (specifier: string) => {
	if (isBuiltin(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return import(specifier);
	if (/^\.{0,2}\//.test(specifier)) return import(pathToFileURL(path.resolve(cwd, specifier)).href);
	const bun = (globalThis as { Bun?: { resolveSync: (id: string, from: string) => string } }).Bun;
	for (const from of [import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname), cwd]) {
		try {
			return import(pathToFileURL(bun!.resolveSync(specifier, from)).href);
		} catch {
			/* try the next root */
		}
	}
	return import(specifier);
};

/**
 * The output buffer belonging to the cell an async continuation came from.
 *
 * A cell that outlives its timeout is abandoned, not stopped: `Promise.race`
 * stops waiting for it, but the work keeps running inside the kernel. Its
 * `console.log` calls therefore arrive after `execute` has returned, and with a
 * single shared buffer they landed in whichever cell happened to be running by
 * then — so a later cell reported output it never produced, which is worse than
 * losing it, because it is indistinguishable from its own. Pinning each console
 * call to the capture of the cell that started it sends a straggler's output to
 * its own discarded buffer instead.
 */
//
// Kept on globalThis, like the kernels themselves, so it outlives a hot reload
// of this module: a cell that was running when the module was evaluated again
// is still inside the old store's `run`, and a console bound by the new module
// has to find that cell's capture, not a fresh, empty store.
const cellOutput: AsyncLocalStorage<{ stdout: string[]; stderr: string[] }> = ((globalThis as any).__rlmCodeCellOutput ??=
	new AsyncLocalStorage<{ stdout: string[]; stderr: string[] }>());

/**
 * Which evaluation of this module is running. A hot reload evaluates the file
 * again and so counts one more; a kernel bound by an earlier one is rebound
 * before its next cell (see `rebindKernel`) — same context, same variables,
 * the new helpers.
 */
const CODE_MODULE_GENERATION: number = ((globalThis as any).__rlmCodeModuleGeneration =
	((globalThis as any).__rlmCodeModuleGeneration ?? 0) + 1);

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
		private options?: Omit<CodeToolOptions, "provisioner">,
	) {}

	/** The kernel is always "running" — it's just a VM context. */
	get hasRunningKernel(): boolean {
		return this.context !== null && !this._disposed;
	}

	/** Start the kernel in the background. For VM context, this is a no-op. */
	prewarm(): void {
		if (!this.context) this.ensure().catch(() => {});
	}

	/** Ensure the VM context exists, bound to the current helpers. */
	async ensure(): Promise<vm.Context> {
		if (this._disposed) {
			if (endedKernels().has(this)) throw new Error("Code kernel provisioner disposed");
			// Disposed by a rebuild before rebuilds stopped doing that, while its
			// session lives on: every cell of that session failed with "disposed"
			// until a restart. Its variables went with the old context; the kernel
			// itself comes back so the session can work again.
			this._disposed = false;
		}
		if (!this.context) this.resetContext();
		else rebindIfStale(this);
		return this.context!;
	}

	/**
	 * Take new host inputs — handlers, env, shell settings, context proxy, cwd —
	 * into the RUNNING kernel.
	 *
	 * This is what a session rebuild (`/reload`, a resource or plugin reload)
	 * does instead of disposing the kernel and starting another. That used to
	 * fail every cell in flight with "Code kernel provisioner disposed" and drop
	 * every variable. Same context, same variables; only the helpers the
	 * sandbox was handed are rebound.
	 */
	update(options: Omit<CodeToolOptions, "provisioner">): void {
		if (this._disposed) return;
		this.options = { ...this.options, ...options };
		if (this.context) rebindKernel(this);
	}

	/**
	 * rlm-hmr calls this on live instances after it patched this class in
	 * place: rebind the running kernel to the helpers of the module evaluated
	 * just now — same context, same variables, a cell already running is not
	 * touched. Without it the rebind still happens, lazily, before the next
	 * cell (see `rebindIfStale` in `ensure`/`execute`).
	 */
	[Symbol.for("rlm.hmr.patched")](_info?: unknown): void {
		if (!this._disposed) rebindKernel(this);
	}

	/** Dispose the kernel. Only the session's own dispose calls this. */
	async dispose(): Promise<void> {
		endedKernels().add(this);
		this._disposed = true;
		this.context = null;
	}

	/**
	 * Idle shutdown. The kernel is a VM context in this process, with no
	 * process or socket to reclaim, and its variables are the agent's working
	 * state — an idle subagent woken again must find them where it left them.
	 * So there is nothing to kill; this used to dispose, which made the next
	 * cell of a revived subagent fail with "Code kernel provisioner disposed".
	 */
	async kill(): Promise<void> {}

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
		const sandbox = hostBindings(this);
		this.context = vm.createContext(sandbox, {
			name: "rlm-code",
			codeGeneration: { strings: false, wasm: false },
		});
		recordBindings(this.context, sandbox);
		// Variables handed over by an execve-in-place (rlm-host shell.ts reexec):
		// the old image serialized them per session, the new one takes them back
		// the first time that session's kernel creates its context.
		const handover = (globalThis as any).__rlmKernelHandover as Record<string, Record<string, unknown>> | undefined;
		const mine = this.options?.sessionId ? handover?.[this.options.sessionId] : undefined;
		if (mine) {
			for (const [name, value] of Object.entries(mine)) (this.context as any)[name] = value;
			delete handover![this.options!.sessionId!];
		}
		liveKernels().add(new WeakRef(this));
		// rlm-hmr's after-patch dispatch (bun-reload.ts registerLive) reaches only
		// services and objects in this set; without it the hook above never runs.
		((globalThis as any).__rlmHmrLive ??= new Set()).add(new WeakRef(this));
	}


	/**
	 * The output buffer a console call belongs to.
	 *
	 * The async-local store names the cell that call came from, which is not
	 * always the cell running now — an abandoned cell keeps printing. The field
	 * is the fallback for anything that reaches console outside a cell run.
	 */
	private captureFor(stream: "stdout" | "stderr"): string[] {
		return (cellOutput.getStore() ?? this.outputCapture)[stream];
	}

	/**
	 * Execute JS code in the persistent context.
	 * Variables persist across calls — same as kernel cells.
	 */
	async execute(code: string, _opts?: { signal?: AbortSignal; onStream?: (chunk: string, name: "stdout" | "stderr") => void }): Promise<CodeExecuteResult> {
		if (!this.context) this.resetContext();
		else rebindIfStale(this);
		const timeout = this.options?.timeout ?? 30000;
		const maxChars = this.options?.maxOutputChars ?? 65536;
		const started = Date.now();

		// A fresh buffer for this cell rather than truncating the shared one.
		// Together with the async-local store the console helpers read, this is
		// what keeps an abandoned cell's late output out of the next cell: the
		// straggler still holds a reference to its own capture, and everything
		// below reads a different object.
		const capture = { stdout: [] as string[], stderr: [] as string[] };
		this.outputCapture = capture;

		// Transform !shell and %%bash syntax.
		const transformed = this.transformCode(code);

		try {
			// Top-level let/const/class/function persist to later cells (REPL
			// rules, cell-transform.ts); host bindings stay cell-local. The
			// line-based wrapper remains the fallback for a cell that does not parse.
			const reserved = new Set(Object.keys(installedBindings().get(this.context!)?.values ?? {}));
			const wrapped =
				compiles(wrapCellSource(asyncifyExecSync(transformed), reserved)) ??
				compiles(wrapCellSource(transformed, reserved)) ??
				wrapCell(asyncifyExecSync(transformed)) ??
				wrapCell(transformed) ??
				wrapCellUnchecked(transformed);

			const result = cellOutput.run(capture, () =>
				vm.runInContext(wrapped, this.context!, {
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
					importModuleDynamically: process.versions.bun
						? (cellImport(this.options?.cwd ?? this.cwd) as never)
						: DYNAMIC_IMPORT_LOADER,
				}),
			);

			// Await the cell against one wall-clock deadline.
			//
			// `vm.runInContext`'s own `timeout` bounds only the SYNCHRONOUS part
			// of the cell, and whatever it spent is already gone by the time we
			// get here. Arming a second full-length timer handed a cell that
			// blocked for 29s another 30s, so a "30s" limit could run to nearly
			// a minute — the async phase gets what is left of the one budget,
			// not a fresh copy of it.
			//
			// The timer is cleared on every path. Promise.race settles on the
			// first outcome but never cancels the loser, so an uncleared timer
			// held the event loop open, and its closure reachable, for the full
			// timeout after even a millisecond-long cell.
			let value: any = result;
			if (value && typeof value.then === "function") {
				const remaining = Math.max(0, timeout - (Date.now() - started));
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					value = await Promise.race([
						value,
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error(codeTimeoutMessage(timeout))), remaining);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
			}

			let stdout = capture.stdout.join("");
			let stderr = capture.stderr.join("");
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
			let stdout = capture.stdout.join("");
			let stderr = capture.stderr.join("");

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
			const taught = teachReferenceError(evalue) ?? teachJsonParseOfNonString(evalue);
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

// ─── Host bindings ───────────────────────────────────────────────────────────

/**
 * Everything the host puts in a kernel's global scope, built by THIS evaluation
 * of the module.
 *
 * A module-level function rather than part of `resetContext`, so a hot reload
 * of this file can hand a running kernel its new helpers (`rebindKernel`)
 * without a new context: the variables the agent made live in the same object
 * as these bindings, and building a fresh context is what used to lose them.
 */
function hostBindings(kernel: CodeKernelProvisioner): Record<string, any> {
	const k = kernel as any;
	const cwd = k.options?.cwd ?? k.cwd;

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
		// Node's execSync leaves the child's stderr wired to the parent's
		// unless `stdio` says otherwise, so a cell that shells out writes
		// straight onto rlm's own stderr. That output never reaches the
		// model, and when rlm's stderr is a pipe whose reader has gone —
		// the ordinary end of `pi -p … | head` — the write raises EPIPE
		// from inside execSync and escapes as a process-level
		// uncaughtException. Piping all three streams by default keeps a
		// cell's shell output inside the cell, and matches what the `!` and
		// `%%bash` forms already do (see transformCode). An explicit
		// `stdio` from the caller still wins.
		execSync: (command: string, opts?: any) =>
			execSync(command, { stdio: ["pipe", "pipe", "pipe"], ...(opts ?? {}) }),
		// What `execSync(...)` calls in a cell are rewritten to (see
		// code-async-shell.ts): the same contract without blocking the
		// thread the TUI and every in-process subagent share.
		[EXEC_SYNC_ASYNC_NAME]: (command: string, opts?: any) => execSyncAsync(command, opts ?? {}, { cwd }),
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
			log: (...args: any[]) => k.captureFor("stdout").push(args.map(formatValue).join(" ") + "\n"),
			error: (...args: any[]) => k.captureFor("stderr").push(args.map(formatValue).join(" ") + "\n"),
			warn: (...args: any[]) => k.captureFor("stderr").push(args.map(formatValue).join(" ") + "\n"),
			info: (...args: any[]) => k.captureFor("stdout").push(args.map(formatValue).join(" ") + "\n"),
			debug: (...args: any[]) => k.captureFor("stdout").push(args.map(formatValue).join(" ") + "\n"),
		},

		// Dynamic import for ESM modules
		import: (name: string) => import(name),

		// require for CJS modules: rlm's own install first, then the cell's
		// cwd, so a project's own dependencies resolve too. A cell that
		// needed `js-yaml` for a project file used to fail with
		// "Cannot find package" because only rlm's tree was searched.
		require: cellRequire(cwd),

		// rlm SDK — resolved lazily via host handlers
		rlm: rlmProxyFor(k),

		// Continual-harness refinement — what the refine skill and the prompt
		// tell the model to call. Absent until now: the session built the
		// `refine.run`/`refine.status` handlers but no cell could reach them,
		// so every `await refine.run(...)` was a ReferenceError.
		refine: refineProxyFor(k),

		// The bundled skills' kernel APIs (agent-message, agent-observe, goal,
		// compact, rlm-heartbeat). The session always built their host
		// handlers, but the JS kernel never bound them, so every
		// `await agent_message.send(…)` the skills teach was a ReferenceError —
		// and that error was then learned as "harness APIs are not available in
		// the sandbox". Unavailable ones are still bound, to objects whose calls
		// say why, never to nothing.
		...skillApisFor(k),

		// Context registry — persistent typed variables (agent working
		// memory). Resolved per property access, for the same reason as
		// `self` below: `rlm-context` is a hot-swappable row, so a value
		// captured when the sandbox was built goes stale the moment that
		// row reloads, and a kernel built before the row mounted would
		// never see it at all.
		//
		// When nothing is mounted there is no store behind `context`, and
		// binding the global to `undefined` made every `context.set` call
		// the prompt teaches fail with "undefined is not an object" — a
		// message that names neither the cause nor a way forward, and the
		// single largest host-caused failure class in the agent log.
		// Answer with one that does.
		context: createContextSandboxProxy(
			() => k.options?.contextProxy ?? (globalThis as any).__rlmContextProxy,
		),

	// TUI service — for inspecting registered extensions (read-only)
	tui: new Proxy({}, { get: (_, prop) => (globalThis as any).__rlmTui?.[prop] }),

		// rlm's hands on its own wiring — see packages/rlm-self. Read through
		// a proxy, and per property access, so a cell picks up the CURRENT
		// binding: `rlm-self` is a hot-swappable row like any other, and a
		// value captured when the sandbox was built would go stale the first
		// time that row reloaded. Absent when the row is not mounted, which
		// is what `self` being undefined in a cell means.
		self: new Proxy({}, { get: (_, prop) => (globalThis as any).__rlmSelf?.[prop] }),

		// Helpers
		cwd,
	};
	return sandbox;
}

/** The `rlm` SDK object a kernel's cells see, from its current host handlers. */
function rlmProxyFor(kernel: CodeKernelProvisioner): any {
	const handlers = (kernel as any).options?.hostHandlers;
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

	return ownRejections(rlmObj);
}

/**
 * The `refine` object a kernel's cells see: `run(instructions?, opts?)` and
 * `status()`, mapped to the session's `refine.run` / `refine.status` handlers.
 *
 * `opts` takes `{ global: true }`, `{ global_: true }` (the spelling the skill
 * used when the kernel was Python, and still what models write), or a bare
 * `true`. Undefined when the session does not allow refinement (subagents).
 */
function refineProxyFor(kernel: CodeKernelProvisioner): any {
	const handlers = (kernel as any).options?.hostHandlers;
	const runHandler = handlers?.["refine.run"];
	const statusHandler = handlers?.["refine.status"];
	if (!runHandler && !statusHandler) return undefined;
	const wantsGlobal = (opts: unknown): boolean | undefined => {
		if (typeof opts === "boolean") return opts;
		if (opts && typeof opts === "object") {
			const o = opts as { global?: unknown; global_?: unknown };
			const flag = o.global ?? o.global_;
			return typeof flag === "boolean" ? flag : undefined;
		}
		return undefined;
	};
	return ownRejections({
		run: runHandler
			? async (instructions?: string | null, opts?: unknown) =>
					runHandler({
						...(typeof instructions === "string" ? { instructions } : {}),
						...(wantsGlobal(opts) !== undefined ? { global: wantsGlobal(opts) } : {}),
					})
			: undefined,
		status: statusHandler ? async () => statusHandler({}) : undefined,
	});
}

/**
 * The skills document these APIs in Python form — positional arguments, then
 * keyword arguments (`send(message, receiver_role="parent")`). In JS the
 * keywords arrive as a trailing options object, so each method takes its
 * positional names in order and merges a trailing plain object as the rest of
 * the payload. A single object argument is taken as the whole payload.
 */
// Cells run in their own vm context, whose `Object.prototype` is not this
// realm's, so compare by shape rather than by identity.
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || Object.prototype.toString.call(value) === "[object Object]" && proto?.constructor?.name === "Object";
};

const payloadFrom = (names: string[], args: unknown[]): Record<string, unknown> => {
	if (args.length === 1 && isPlainObject(args[0])) {
		const only = args[0];
		if (names.length === 0 || names.some((n) => n in only)) return { ...only };
	}
	const payload: Record<string, unknown> = {};
	let i = 0;
	for (; i < names.length && i < args.length; i++) {
		if (isPlainObject(args[i]) && i === args.length - 1) break;
		if (args[i] !== undefined) payload[names[i]] = args[i];
	}
	const rest = args[args.length - 1];
	if (i < args.length && isPlainObject(rest)) Object.assign(payload, rest);
	return payload;
};

/** What each skill global exposes: method → [host request type, positional names]. */
const SKILL_APIS: Record<string, { skill: string; methods: Record<string, [string, string[]]> }> = {
	agent_message: {
		skill: "agent-message",
		methods: {
			list_agents: ["agent_message.list_agents", []],
			send: ["agent_message.send", ["message", "receiver_role", "receiver_name"]],
			wait_for_parent: ["agent_message.wait_for_parent", ["timeout_ms"]],
		},
	},
	agent_observe: {
		skill: "agent-observe",
		methods: {
			list_agents: ["agent_observe.list", []],
			get_agent: ["agent_observe.get", ["target"]],
			recent_messages: ["agent_observe.recent", ["target", "limit", "max_chars"]],
		},
	},
	goal: {
		skill: "goal",
		methods: {
			get: ["goal.get", []],
			create: ["goal.create", ["objective", "token_budget"]],
			complete: ["goal.complete", []],
		},
	},
	compact: {
		skill: "compact",
		methods: {
			status: ["compact.status", []],
			run: ["compact.run", ["instructions"]],
		},
	},
	rlm_heartbeat: {
		skill: "rlm-heartbeat",
		methods: {
			list: ["rlm_heartbeat.list", ["include_inactive"]],
			create: ["rlm_heartbeat.create", ["instruction", "interval", "label", "delivery_mode"]],
			update: ["rlm_heartbeat.update", ["id", "instruction", "interval", "label", "status", "delivery_mode"]],
			delete: ["rlm_heartbeat.delete", ["id"]],
		},
	},
};

/** Names every skill global this kernel binds — for capability checks. */
export const KERNEL_SKILL_GLOBALS = Object.keys(SKILL_APIS);

/**
 * Every global a cell can reach, read from the real binding table rather than
 * a list kept by hand — refinement uses it to refuse lessons that claim one of
 * them is missing.
 */
/** The host APIs among them — the ones a wrong lesson could steer models away from. */
export const KERNEL_HOST_APIS = ["rlm", "refine", "context", "sh", "exec", "execSync", "fetch", "require", ...KERNEL_SKILL_GLOBALS];

export const kernelGlobalNames = (): string[] => {
	const probe = { options: {}, cwd: process.cwd(), captureFor: () => [] } as unknown as CodeKernelProvisioner;
	return Object.keys(hostBindings(probe)).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
};

/**
 * Bind each skill global to the session's current host handlers. Handlers are
 * looked up per call, so an `update()` that hands the kernel new handlers (or a
 * session that gains a controller later) is seen without a rebind. A method
 * whose handler this session does not provide throws a message naming the
 * session, not the sandbox, as the reason.
 */
function skillApisFor(kernel: CodeKernelProvisioner): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [global, { skill, methods }] of Object.entries(SKILL_APIS)) {
		const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
		for (const [method, [type, names]] of Object.entries(methods)) {
			api[method] = async (...args: unknown[]) => {
				const handler = (kernel as any).options?.hostHandlers?.[type];
				if (typeof handler !== "function") {
					// Say which side is missing, so an agent never concludes the API
					// does not exist. agent_message / agent_observe are routed by the
					// daemon (upstream builds their controller in daemon-mode); an
					// in-process session has none yet.
					const why =
						global === "agent_message" || global === "agent_observe"
							? "agent messaging/observation is routed by the rlm daemon, which this in-process session is not attached to — return results through the subagent's reply (rlm.run / rlm.spawn resolve with it) instead"
							: `the ${skill} skill is switched off for this session`;
					throw new Error(`${global}.${method} exists in the code tool, but this session does not provide it: ${why}.`);
				}
				return handler(payloadFrom(names, args));
			};
		}
		out[global] = ownRejections(api);
	}
	return out;
}

// ─── Live kernels and rebinding ──────────────────────────────────────────────

/**
 * Kernels ended by their session (the only caller of `dispose` now). Kept apart
 * from the `_disposed` flag because a kernel a rebuild disposed in an earlier
 * version of this file was flagged the same way while its session lived on,
 * and that one must come back rather than fail every cell.
 */
const endedKernels = (): WeakSet<CodeKernelProvisioner> =>
	((globalThis as any).__rlmCodeKernelsEnded ??= new WeakSet<CodeKernelProvisioner>());

/** Every kernel this process has built, across evaluations of this module. */
const liveKernels = (): Set<WeakRef<CodeKernelProvisioner>> =>
	((globalThis as any).__rlmCodeKernels ??= new Set<WeakRef<CodeKernelProvisioner>>());

/**
 * What the host last installed in each context, and which evaluation of this
 * module installed it. A binding whose value no longer matches is the user's:
 * a cell reassigned it (`var sh = …`), and a rebind leaves it alone.
 */
const installedBindings = (): WeakMap<object, { generation: number; values: Record<string, any> }> =>
	((globalThis as any).__rlmCodeKernelBindings ??= new WeakMap());

const recordBindings = (context: object, values: Record<string, any>): void => {
	installedBindings().set(context, { generation: CODE_MODULE_GENERATION, values: { ...values } });
};

/**
 * Hand a running kernel the helpers built by this evaluation of the module:
 * same context, same variables, nothing restored from anywhere. A cell already
 * running keeps whatever helper it is inside; the next call it makes, and the
 * next cell, get the new one. Returns whether the kernel had a context to bind.
 */
const rebindKernel = (kernel: CodeKernelProvisioner): boolean => {
	const context = (kernel as any).context as Record<string, any> | null;
	if (!context) return false;
	const previous = installedBindings().get(context)?.values;
	const next = hostBindings(kernel);
	const installed: Record<string, any> = {};
	for (const key of Object.keys(next)) {
		const ours = previous ? key in previous : false;
		if (ours && context[key] !== previous![key]) {
			// The user replaced it; keep treating the replaced value as ours so a
			// later rebind makes the same call.
			installed[key] = previous![key];
			continue;
		}
		if (!ours && key in context) continue;
		context[key] = next[key];
		installed[key] = next[key];
	}
	installedBindings().set(context, { generation: CODE_MODULE_GENERATION, values: installed });
	return true;
};

/** Rebind a kernel an earlier evaluation of this module set up. */
const rebindIfStale = (kernel: CodeKernelProvisioner): void => {
	const context = (kernel as any).context as object | null;
	if (context && installedBindings().get(context)?.generation !== CODE_MODULE_GENERATION) rebindKernel(kernel);
};

/**
 * Rebind every live kernel to this evaluation's helpers. Runs when the module
 * is evaluated again by a hot reload; returns how many kernels were rebound.
 */
export function rebindCodeKernels(): number {
	let rebound = 0;
	for (const ref of liveKernels()) {
		const kernel = ref.deref();
		if (!kernel || (kernel as any)._disposed) {
			liveKernels().delete(ref);
			continue;
		}
		if (rebindKernel(kernel)) rebound++;
	}
	return rebound;
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
					// `evalue` is the message the kernel wants read — teachReferenceError
					// rewrites it to name the route that would have worked. The traceback's
					// first line is only the bare message, so sending the traceback alone
					// threw that guidance away and left the agent with the dead end again.
					// Send the message, then the frames. A traceback opens with the
					// message, which can run to several lines, so the frames start at the
					// first "at ..." rather than at index 1 — otherwise the tail of a
					// multi-line message gets printed twice.
					const firstFrame = r.error.traceback.findIndex((line) =>
						/^\s+at\s/.test(line),
					);
					const frames =
						firstFrame === -1
							? ""
							: r.error.traceback.slice(firstFrame).join("\n");
					text +=
						(text ? "\n" : "") + r.error.evalue + (frames ? "\n" + frames : "");
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
	"context", "tui", "self",
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
const wrapCellUnchecked = (code: string): string =>
	`(async () => {\n${captureLastExpression(transformVarToGlobal(code))}\n})()`;

/** `wrapped` if the engine accepts it, else undefined (acorn and the engine can disagree at the edges). */
const compiles = (wrapped: string | undefined): string | undefined => {
	if (wrapped === undefined) return undefined;
	try {
		new vm.Script(wrapped);
		return wrapped;
	} catch {
		return undefined;
	}
};

/** The cell as it will run, or undefined when it does not parse. */
const wrapCell = (code: string): string | undefined => {
	const wrapped = wrapCellUnchecked(code);
	try {
		new vm.Script(wrapped);
		return wrapped;
	} catch {
		return undefined;
	}
};

function runShell(
	cmd: string,
	opts?: { cwd?: string; timeout?: number; env?: Record<string, string> },
): Promise<string> {
	const pending = new Promise<string>((resolve, reject) => {
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

	// A cell that starts a command and never awaits it leaves a rejected
	// promise nobody owns, and the runtime reports that at process scope: 81 of
	// the 83 unhandledRejection records in the agent log are exactly this — a
	// `Command failed (exit N)` raised here, escaping the tool call that caused
	// it and landing on the host as though the host had faulted.
	//
	// The sink marks the rejection handled without changing what any caller
	// sees: `await sh(...)` still throws, and execute() still reports it as
	// that cell's error. Dropping the promise is the cell saying it does not
	// care about the outcome — the same thing `cmd &` says in a shell — and
	// the one thing it must not also do is take the host down.
	pending.catch(() => {});
	return pending;
}

/**
 * Give every promise the `rlm` proxy hands a cell the same sink `sh()` has.
 *
 * A cell that fires `rlm.spawn(...)` without awaiting it and hits a taken
 * agent name left the rejection with no owner, and it surfaced at process
 * scope: six `Agent name "…" is unavailable` unhandledRejection records on
 * Sep 25, any one of which ends the process when the last-rites hook is the
 * only listener. Awaiting callers still see the rejection unchanged.
 */
function ownRejections<T extends Record<string, unknown>>(api: T): T {
	for (const [key, value] of Object.entries(api)) {
		if (typeof value === "function") {
			(api as Record<string, unknown>)[key] = (...args: unknown[]) => {
				const result = (value as (...a: unknown[]) => unknown)(...args);
				if (result instanceof Promise) result.catch(() => {});
				return result;
			};
		} else if (value && typeof value === "object") {
			ownRejections(value as Record<string, unknown>);
		}
	}
	return api;
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
 * What to say when a cell outlives its budget.
 *
 * A vm cell cannot be killed: the host stops waiting for it, but the work
 * carries on inside the kernel. Saying only "timeout" invites the one response
 * that makes things worse — running the same cell again, now alongside the copy
 * still going. Name what is still true instead.
 */
function codeTimeoutMessage(timeoutMs: number): string {
	return (
		`Code timeout after ${timeoutMs}ms.\n\n` +
		`The cell was abandoned, not stopped — it is still running in this kernel, and any ` +
		`variable it assigns will simply appear in a later cell. Running it again as written ` +
		`starts a second copy alongside the first.\n` +
		`Do the work in smaller steps, or hand the slow part to a command with its own limit: ` +
		`\`await sh("<command>", { timeout: 600000 })\`.`
	);
}

/**
 * Turn a JSON parse failure on an `[object …]` string into its cause.
 *
 * `JSON.parse` coerces its argument with String(), so parsing anything that is
 * not a string parses the words "[object Object]" or "[object Promise]"
 * instead. The runtimes report only the token they choked on — JSC says
 * `Unexpected identifier "object"`, V8 says `Unexpected token 'o'` — which
 * names the symptom and buries the cause. The cause seen in this kernel's logs
 * is a missing `await`: `sh` and `exec` are asynchronous, so
 * `JSON.parse(sh(cmd))` parses a Promise and reads as a malformed-JSON problem
 * that no amount of fixing the command will resolve.
 */
function teachJsonParseOfNonString(message: string): string | null {
	if (!/JSON Parse error|JSON\.parse|is not valid JSON|in JSON at position/i.test(message)) return null;
	if (!/identifier "object"|token 'o'|\[object /i.test(message)) return null;
	return (
		`${message}\n\n` +
		`That is the text of \`[object Object]\` / \`[object Promise]\`: JSON.parse was handed a ` +
		`value that is not a string, so it parsed the value's description instead of any JSON. ` +
		`The usual cause here is a missing \`await\` — \`sh\` and \`exec\` are asynchronous, so ` +
		`\`JSON.parse(sh(cmd))\` parses a Promise. Write \`JSON.parse(await sh(cmd))\`, and pass ` +
		`JSON.parse nothing but strings.`
	);
}

/**
 * The sandbox's `context` global.
 *
 * `rlm-context` is a hot-swappable row, so the store is resolved per property
 * access rather than captured when the sandbox was built. When no row is
 * mounted there is nothing behind `context` at all, and the honest thing to
 * hand back is a message naming that — the alternative, a bare `undefined`,
 * turned every documented `context.set` call into "undefined is not an object",
 * which says nothing about why or what to do instead. The store is NOT faked:
 * a value written to a registry that does not exist would be lost silently,
 * which is worse than a call that fails loudly.
 */
function createContextSandboxProxy(resolve: () => any): any {
	const unavailable = (member: string) =>
		new Error(
			`context.${member} is unavailable in this session: the rlm-context row is not mounted, ` +
				`so there is no registry behind context.*. Kernel variables already persist across ` +
				`cells here — assign \`globalThis.<name> = value\` and read \`<name>\` back in a later ` +
				`cell — or write the value to a file if it has to outlive the session.`,
		);
	const describe = () => "<context unavailable: the rlm-context row is not mounted>";

	return new Proxy(
		{},
		{
			get: (_target, prop) => {
				const service = resolve();
				if (service !== undefined && service !== null) return service[prop as keyof typeof service];
				// Never look like a thenable: `await context` must not hang or
				// resolve to something that hides the real problem.
				if (prop === "then") return undefined;
				if (prop === "toJSON" || prop === "toString" || prop === Symbol.toPrimitive) return describe;
				if (prop === Symbol.toStringTag) return "RlmContextUnavailable";
				const member = String(prop);
				return () => {
					throw unavailable(member);
				};
			},
		},
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
