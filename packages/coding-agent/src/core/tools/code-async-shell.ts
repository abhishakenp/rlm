/**
 * Keep a cell's `execSync` off the event loop.
 *
 * Code cells run in a vm context on rlm's main thread, and in-process
 * subagents share that thread with the TUI. A real `execSync("sleep 90")` in
 * any subagent's cell therefore froze the whole terminal — no keys, no
 * spinner, no redraw — for the full 90 seconds. Cells already run inside an
 * async wrapper, so each `execSync(...)` call is rewritten to
 * `(await __execSyncAsync(...))`: same arguments, same return value (a Buffer,
 * or a string when an encoding is given), same throw on a non-zero exit — but
 * the command runs while the event loop keeps turning.
 *
 * The rewrite is textual. When it would not parse (an `execSync` inside a
 * non-async callback, where `await` is illegal), the caller keeps the
 * original code, which still works, just blocking as before.
 */
import { spawn } from "node:child_process";

export const EXEC_SYNC_ASYNC_NAME = "__execSyncAsync";

const isIdentChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);

/**
 * Index just past the `)` that closes the `(` at `open`, skipping strings,
 * template literals and comments. -1 when unbalanced.
 */
const findClosingParen = (code: string, open: number): number => {
	let depth = 0;
	let i = open;
	while (i < code.length) {
		const c = code[i];
		const next = code[i + 1];
		if (c === "/" && next === "/") {
			const nl = code.indexOf("\n", i);
			i = nl === -1 ? code.length : nl;
			continue;
		}
		if (c === "/" && next === "*") {
			const end = code.indexOf("*/", i + 2);
			i = end === -1 ? code.length : end + 2;
			continue;
		}
		if (c === '"' || c === "'") {
			i++;
			while (i < code.length && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
			i++;
			continue;
		}
		if (c === "`") {
			i++;
			while (i < code.length && code[i] !== "`") {
				if (code[i] === "\\") {
					i += 2;
					continue;
				}
				if (code[i] === "$" && code[i + 1] === "{") {
					// Interpolation: find its closing brace with the same scanner.
					let braces = 1;
					i += 2;
					while (i < code.length && braces > 0) {
						if (code[i] === "{") braces++;
						else if (code[i] === "}") braces--;
						else if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
							const q = code[i];
							i++;
							while (i < code.length && code[i] !== q) i += code[i] === "\\" ? 2 : 1;
						}
						i++;
					}
					continue;
				}
				i++;
			}
			i++;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
		i++;
	}
	return -1;
};

/** Rewrite every bare `execSync(...)` call into `(await __execSyncAsync(...))`. */
export const asyncifyExecSync = (code: string): string => {
	const name = "execSync";
	let out = "";
	let i = 0;
	while (i < code.length) {
		const c = code[i];
		const next = code[i + 1];
		// Copy comments and strings verbatim so text inside them is never rewritten.
		if (c === "/" && next === "/") {
			const nl = code.indexOf("\n", i);
			const end = nl === -1 ? code.length : nl;
			out += code.slice(i, end);
			i = end;
			continue;
		}
		if (c === "/" && next === "*") {
			const close = code.indexOf("*/", i + 2);
			const end = close === -1 ? code.length : close + 2;
			out += code.slice(i, end);
			i = end;
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < code.length && code[j] !== c) j += code[j] === "\\" ? 2 : 1;
			out += code.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (c === "`") {
			// Template literals may contain execSync in `${}`; recurse into those.
			let j = i + 1;
			out += "`";
			while (j < code.length && code[j] !== "`") {
				if (code[j] === "\\") {
					out += code.slice(j, j + 2);
					j += 2;
					continue;
				}
				if (code[j] === "$" && code[j + 1] === "{") {
					let braces = 1;
					let k = j + 2;
					while (k < code.length && braces > 0) {
						if (code[k] === "{") braces++;
						else if (code[k] === "}") braces--;
						if (braces > 0) k++;
					}
					out += `\${${asyncifyExecSync(code.slice(j + 2, k))}}`;
					j = k + 1;
					continue;
				}
				out += code[j];
				j++;
			}
			out += "`";
			i = j + 1;
			continue;
		}
		if (code.startsWith(name, i) && !isIdentChar(code[i - 1]) && !isIdentChar(code[i + name.length])) {
			const before = code.slice(0, i).trimEnd();
			const prevChar = before[before.length - 1];
			const isMember = prevChar === "." || before.endsWith("?.");
			const isFunctionName = /\bfunction\s*\*?\s*$/.test(before);
			let j = i + name.length;
			while (j < code.length && /\s/.test(code[j]!)) j++;
			if (!isMember && !isFunctionName && code[j] === "(") {
				const end = findClosingParen(code, j);
				// `{ execSync(cmd) { … } }` is a method definition, not a call.
				const isMethod = end !== -1 && /[{,]$/.test(before) && /^\s*\{/.test(code.slice(end));
				if (end !== -1 && !isMethod) {
					const args = asyncifyExecSync(code.slice(j + 1, end - 1));
					out += `(await ${EXEC_SYNC_ASYNC_NAME}(${args}))`;
					i = end;
					continue;
				}
			}
		}
		out += c;
		i++;
	}
	return out;
};

interface ExecSyncLikeOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	encoding?: BufferEncoding | "buffer";
	input?: string | Buffer;
	timeout?: number;
	shell?: string | boolean;
	maxBuffer?: number;
}

/**
 * `execSync` semantics, asynchronously: resolves to stdout (Buffer unless an
 * encoding is given), rejects with an Error carrying `status`, `signal`,
 * `stdout` and `stderr` when the command fails — the same fields execSync's
 * error has, so cells that catch and inspect it keep working. stdio is always
 * piped: inheriting rlm's terminal from inside a TUI is never what a cell wants.
 */
export const execSyncAsync = (
	command: string,
	opts: ExecSyncLikeOptions = {},
	defaults: { cwd?: string } = {},
): Promise<Buffer | string> =>
	new Promise((resolve, reject) => {
		const child = spawn(command, {
			shell: typeof opts.shell === "string" ? opts.shell : true,
			cwd: opts.cwd ?? defaults.cwd,
			env: opts.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: opts.timeout,
		});
		const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let size = 0;
		let overflow = false;
		const collect = (into: Buffer[]) => (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBuffer) {
				overflow = true;
				child.kill();
				return;
			}
			into.push(chunk);
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.on("error", reject);
		if (opts.input !== undefined) child.stdin.end(opts.input);
		else child.stdin.end();
		child.on("close", (status, signal) => {
			const encoding = opts.encoding && opts.encoding !== "buffer" ? opts.encoding : undefined;
			const outBuf = Buffer.concat(stdout);
			const errBuf = Buffer.concat(stderr);
			const out = encoding ? outBuf.toString(encoding) : outBuf;
			const err = encoding ? errBuf.toString(encoding) : errBuf;
			if (status === 0 && !overflow) {
				resolve(out);
				return;
			}
			const reason = overflow ? "maxBuffer exceeded" : errBuf.toString("utf8").trim();
			const error = new Error(`Command failed: ${command}${reason ? `\n${reason}` : ""}`) as Error & {
				status: number | null;
				signal: NodeJS.Signals | null;
				stdout: Buffer | string;
				stderr: Buffer | string;
			};
			error.status = status;
			error.signal = signal;
			error.stdout = out;
			error.stderr = err;
			reject(error);
		});
	});
