/**
 * @rlm/code — persistent JS code execution tool.
 *
 * Cordis Service. Replaces IPython + bash + edit with a single tool.
 * Mirrors prime-agent's IPython tool UX exactly, but JS instead of Python.
 *
 * What it does (same as prime-agent's IPython):
 * - `!command` → shell out (IPython-style ! prefix)
 * - `%%bash` cell magic → multi-line shell block (IPython-style %%bash)
 * - Persistent variables across calls (vm.Context = kernel namespace)
 * - console.log() output captured as stdout
 * - Last expression value captured as result
 * - rlm.run() for in-process subagent spawning
 * - fs, path, os, child_process, fetch, import() all available
 *
 * Returns { stdout, stderr, result, status } — same shape as prime-agent's
 * kernel ExecuteResult.
 *
 * Reference: packages/coding-agent/src/core/kernel/index.ts ExecuteResult
 */
import { Service } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import vm from "node:vm";
import { exec, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const require = createRequire(import.meta.url);

export interface RlmCodeConfig {
	timeout?: number;
	cwd?: string;
	maxOutputChars?: number;
}

/** Same shape as prime-agent's kernel ExecuteResult. */
export interface CodeResult {
	stdout: string;
	stderr: string;
	/** Last expression value (like IPython's execute_result). */
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: { name: string; message: string; stack: string[] };
	durationMs: number;
}

export class RlmCodeService extends Service {
	static inject = ["rlmSdk"] as const;
	static provide = "rlmCode" as const;

	declare config: RlmCodeConfig;
	private context: vm.Context | null = null;

	constructor(ctx: any, config: RlmCodeConfig = {}) {
		super(ctx, "rlmCode");
		this.config = config;
	}

	async [Service.init]() {
		this.resetContext();
		this.ctx.logger?.info(
			`rlm-code: persistent JS code tool ready (timeout=${this.config.timeout ?? 30000}ms)`,
		);
	}

	/** Create a fresh vm context with all builtins exposed. */
	resetContext() {
		const sdk = this.ctx.get("rlmSdk");
		const cwd = this.config.cwd ?? process.cwd();

		// stdout/stderr capture — same as IPython kernel capturing print output.
		const outputCapture = {
			stdout: [] as string[],
			stderr: [] as string[],
		};

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

			// console.log → captured as stdout (like IPython's print capture)
			console: {
				log: (...args: any[]) => outputCapture.stdout.push(args.map(formatValue).join(" ") + "\n"),
				error: (...args: any[]) => outputCapture.stderr.push(args.map(formatValue).join(" ") + "\n"),
				warn: (...args: any[]) => outputCapture.stderr.push(args.map(formatValue).join(" ") + "\n"),
				info: (...args: any[]) => outputCapture.stdout.push(args.map(formatValue).join(" ") + "\n"),
				debug: (...args: any[]) => outputCapture.stdout.push(args.map(formatValue).join(" ") + "\n"),
			},

			// Dynamic import for ESM modules
			import: (name: string) => import(name),

			// require for CJS modules
			require,

			// rlm SDK — spawn subagents in-process
			rlm: sdk
				? {
						run: (prompt: string, opts?: any) => sdk.run(prompt, opts),
						spawn: (prompt: string, opts?: any) => sdk.spawn(prompt, opts),
						listSubagents: () => sdk.listSubagents(),
						deleteSubagent: (target: string) => sdk.deleteSubagent(target),
						goal: sdk.goal,
					}
				: null,

			// Helpers
			cwd,

			// Internal — output capture access
			__outputCapture: outputCapture,
		};

		this.context = vm.createContext(sandbox, {
			name: "rlm-code",
			codeGeneration: { strings: false, wasm: false },
		});
	}

	/**
	 * Pre-process code — transform IPython-style syntax to JS:
	 *
	 *   !command        →  execSync("command").toString()   (line magic)
	 *   %%bash\n...     →  execSync("...").toString()        (cell magic)
	 *
	 * Same UX as IPython. Only transforms lines/cells starting with ! or %%bash.
	 */
	private transformCode(code: string): string {
		// %%bash cell magic — entire block is shell.
		const bashMatch = code.match(/^([ \t]*)%%bash\b[^\n]*\n([\s\S]*)/);
		if (bashMatch) {
			const indent = bashMatch[1] ?? "";
			const body = bashMatch[2] ?? "";
			return `${indent}execSync(${JSON.stringify(body.trim())}).toString()`;
		}

		// ! line magic — each line starting with ! becomes execSync.
		const lines = code.split("\n");
		const transformed: string[] = [];

		for (const line of lines) {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("!")) {
				const cmd = trimmed.slice(1);
				const indent = line.slice(0, line.length - trimmed.length);
				transformed.push(`${indent}execSync(${JSON.stringify(cmd.trim())}).toString()`);
			} else {
				transformed.push(line);
			}
		}

		return transformed.join("\n");
	}

	/**
	 * Execute JS code in the persistent context.
	 * Variables persist across calls — same as IPython cells.
	 *
	 * Returns { stdout, stderr, result, status } — same as prime-agent's
	 * kernel ExecuteResult.
	 *
	 * - `!cmd` for shell (IPython-style)
	 * - `%%bash` for multi-line shell blocks (IPython-style)
	 * - `await` at top level
	 * - `var`/`globalThis.x` persist across calls
	 * - `console.log()` captured as stdout
	 * - Last expression value captured as result
	 */
	async execute(code: string): Promise<CodeResult> {
		if (!this.context) this.resetContext();
		const timeout = this.config.timeout ?? 30000;
		const maxChars = this.config.maxOutputChars ?? 65536;
		const started = Date.now();

		// Reset output capture for this cell.
		const capture = (this.context as any).__outputCapture;
		capture.stdout.length = 0;
		capture.stderr.length = 0;

		// Transform !shell and %%bash syntax.
		const transformed = this.transformCode(code);

		try {
			// Wrap in async IIFE for top-level await support.
			// Use globalThis for variable persistence (var in function scope
			// doesn't leak, so we transform var → globalThis assignment).
			// Capture the last expression's value as the return (like IPython's
			// execute_result — the last expression value is displayed).
			const finalCode = transformVarToGlobal(transformed);
			const withReturn = captureLastExpression(finalCode);
			const wrapped = `(async () => {\n${withReturn}\n})()`;

			const result = vm.runInContext(wrapped, this.context!, {
				timeout: timeout / 1000, // vm timeout is in seconds
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

			let stdout = capture.stdout.join("");
			let stderr = capture.stderr.join("");
			let resultStr: string | undefined;

			// Capture last expression value (like IPython's execute_result).
			if (value !== undefined) {
				resultStr = formatValue(value);
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
			let stdout = capture.stdout.join("");
			let stderr = capture.stderr.join("");

			return {
				stdout,
				stderr,
				status: "error",
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? (error.stack ?? "").split("\n") : [],
				},
				durationMs: Date.now() - started,
			};
		}
	}

	/** Get a variable from the persistent context. */
	get(name: string): any {
		if (!this.context) return undefined;
		return (this.context as any)[name];
	}

	/** Set a variable in the persistent context. */
	set(name: string, value: any): void {
		if (!this.context) this.resetContext();
		(this.context as any)[name] = value;
	}

	/** List all user-defined variables in the context. */
	vars(): string[] {
		if (!this.context) return [];
		return Object.getOwnPropertyNames(this.context).filter(
			(k) => !k.startsWith("__") && !BUILTINS.has(k),
		);
	}

	async [Symbol.dispose]() {
		this.context = null;
	}
}

const BUILTINS = new Set([
	"exec", "execSync", "fs", "path", "os", "process", "console",
	"Buffer", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
	"setTimeout", "setInterval", "clearTimeout", "clearInterval",
	"fetch", "import", "require", "rlm", "cwd", "__outputCapture",
	"globalThis", "global",
]);

/**
 * Transform `var x = val` → `globalThis.x = val` so variables persist
 * across calls even inside the async IIFE wrapper.
 *
 * `let` and `const` are left alone (block-scoped, won't persist — same
 * as Python's local variables in a function). For persistence, use `var`
 * or `globalThis.x = ...`.
 */
function transformVarToGlobal(code: string): string {
	// Match `var name = ...` at the start of a line (with optional indent).
	// This is a simple regex transform — not a full parser, but handles
	// the common cases the agent will use.
	return code.replace(
		/^([ \t]*)var ([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/gm,
		"$1globalThis.$2 =",
	);
}

/**
 * Capture the last expression's value by prepending `return`.
 *
 * IPython captures the last expression value as `execute_result`.
 * We do the same: find the last expression in the code and prepend
 * `return` so the async IIFE returns it.
 *
 * Handles multi-statement lines separated by `;`:
 *   const x = 1; const y = 2; x + y   →  return x + y
 *   console.log("hi"); 42             →  return 42
 *
 * Skips statement-only lines (if/for/while/function/class/etc).
 */
function captureLastExpression(code: string): string {
	const lines = code.split("\n");

	// Find the last non-empty, non-comment line.
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

	// Ends with { or } → block, not an expression.
	if (trimmed.endsWith("{") || trimmed.endsWith("}")) return code;

	// Split the last line by `;` to find the last segment.
	const segments = trimmed.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
	if (segments.length === 0) return code;

	const lastSegment = segments[segments.length - 1];

	// Statement keywords — don't return these.
	const statementKeywords = [
		"if", "for", "while", "const", "let", "var", "function", "class",
		"return", "throw", "try", "switch", "do", "import", "export",
		"type", "interface", "enum", "break", "continue", "debugger",
	];

	const firstWord = lastSegment.split(/[^a-zA-Z_$]/)[0];
	if (statementKeywords.includes(firstWord)) return code;

	// It's an expression — replace the last segment with `return <expr>`.
	// Reconstruct the line with the return prepended on the last segment.
	const indent = lastLine.slice(0, lastLine.length - lastLine.trimStart().length);
	const allButLast = segments.slice(0, -1).join("; ");
	lines[lastIdx] = `${indent}${allButLast ? allButLast + "; " : ""}return ${lastSegment}`;

	return lines.join("\n");
}

/** Format a value for display — like IPython's repr. */
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

export default RlmCodeService;
export const name = "rlm-code";
export const inject = ["rlmSdk"] as const;
export { RlmCodeService as RlmCode };
