/**
 * @rlm/log — the flight recorder.
 *
 * When something goes wrong the question is always the same: what happened,
 * in what order, and what did the process think it was doing. That question
 * has to be answerable after the fact, from a file, without having known in
 * advance to set a verbose flag.
 *
 * Two things were missing.
 *
 *   The agent's own structured logging was not in this file. pi-ai emits
 *   through a process-wide sink, and under the Cordis shell nobody was folding
 *   that stream in here — so a tool failing inside the agent and a plugin
 *   reloading around it were recorded in two different places, or in the
 *   agent's case in no place anybody read. `adoptAgentLogging()` below claims
 *   that sink, so the agent's entries are ordinary lines of this recorder.
 *
 *   Nothing recorded the events that only exist now: a plugin reloading, a
 *   session re-deriving its resources, a tool failing, a turn beginning and
 *   ending. Those are exactly the events you want when a live reload leaves
 *   the agent in a state nobody can explain.
 *
 * Everything lands in one NDJSON file, one object per line, with a monotonic
 * sequence number so interleaved writes stay orderable. Failures here are
 * swallowed: a logger that breaks the process it is recording is worse than
 * no logger.
 */
import { Service } from "@deepseek-ai/cordis";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendLine, appendedSize, closeAppend, HOT_APPEND_BYTES } from "../../rlm-persist/src/durable.ts";
import { homedir } from "node:os";

const PLUGIN_ID = "rlm-log";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The agent dir, resolved the way coding-agent's config.ts getAgentDir() does
 * (RLM_CODING_AGENT_DIR, `~` expanded), falling back to `$RLM_HOME/agent` like
 * rlm-boot and rlm-delegate, then `~/.rlm/agent`. Inlined rather than imported:
 * this row loads first and must not pull config.ts's graph in with it. Without
 * it every scratch or test run wrote into the user's real log.
 */
const logAgentDir = (): string => {
	const env = process.env.RLM_CODING_AGENT_DIR;
	if (env) return env === "~" ? homedir() : env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
	return join(process.env.RLM_HOME ?? join(homedir(), ".rlm"), "agent");
};

export interface RlmLogConfig {
	/** Log file. Defaults to ~/.rlm/agent/logs/rlm.jsonl. */
	file?: string;
	/** Lowest level written. Default "info" ("debug" with RLM_LOG_DEBUG=1). */
	level?: LogLevel;
	/** Rotate once the file passes this size. Default 20 MB. */
	maxBytes?: number;
	/** Also mirror to stderr. Default false — it would fight the TUI. */
	console?: boolean;
	/** Fold the agent's own (pi-ai) structured logging into this file. Default true. */
	installAgentSink?: boolean;
}

export interface RlmLogEntry {
	ts: string;
	seq: number;
	level: LogLevel;
	scope: string;
	event: string;
	[field: string]: unknown;
}

/** Anything a log line should never carry, however it was nested. */
const REDACT = /^(authorization|api[-_]?key|token|password|secret|cookie)$/i;

/**
 * Shrink a value to something a log line can hold: no secrets, no unbounded
 * strings, no cycles, no megabyte tool outputs.
 */
function safe(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}… (${value.length})` : value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 6) };
	if (depth >= 4) return "[deep]";
	if (Array.isArray(value)) return value.slice(0, 40).map((v) => safe(v, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		let n = 0;
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (n++ >= 40) { out["…"] = "truncated"; break; }
			out[k] = REDACT.test(k) ? "[redacted]" : safe(v, depth + 1);
		}
		return out;
	}
	return String(value);
}

/**
 * A tool can fail without the harness calling it an error.
 *
 * The code tool reports a thrown cell as a normal result carrying
 * `details.status === "error"`, so a check on `isError` alone records a
 * failing turn as a success — which is exactly the turn someone will later go
 * looking for in the log.
 */
export function isFailure(event: any): boolean {
	if (event?.isError) return true;
	const status = event?.details?.status;
	return status === "error" || status === "aborted";
}

/** The result text, wherever the tool put it. */
export function resultText(event: any): string | undefined {
	const parts: string[] = [];
	if (Array.isArray(event?.content)) {
		for (const c of event.content) if (typeof c?.text === "string") parts.push(c.text);
	}
	const d = event?.details;
	if (d?.error?.evalue) parts.push(String(d.error.evalue));
	else if (d?.stderr) parts.push(String(d.stderr));
	const text = parts.join(" ").trim();
	return text || undefined;
}

/**
 * Cells are long — and longer still once a plugin has injected a kernel
 * bootstrap into the first one. A log line wants the shape of what ran.
 */
function shortCode(code: unknown): string | undefined {
	if (typeof code !== "string") return undefined;
	const stripped = code.replace(/^[\s\S]*?\n\/\/ ─── Filesystem interception[\s\S]*?\n\}\)\(\);\n/, "«seeded» ");
	const flat = stripped.replace(/\s+/g, " ").trim();
	return flat.length > 400 ? `${flat.slice(0, 400)}… (${flat.length})` : flat;
}

export class RlmLogService extends Service {
	static inject = [] as const;
	static provide = "rlmLog" as const;

	declare config: RlmLogConfig;

	private file = "";
	private minLevel = LEVELS.info;
	private maxBytes = 20 * 1024 * 1024;
	private seq = 0;
	private counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };

	constructor(ctx: any, config: RlmLogConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	async [Service.init]() {
		this.file = this.config.file ?? join(logAgentDir(), "logs", "rlm.jsonl");
		const level = this.config.level ?? (process.env.RLM_LOG_DEBUG ? "debug" : "info");
		this.minLevel = LEVELS[level] ?? LEVELS.info;
		this.maxBytes = this.config.maxBytes ?? 20 * 1024 * 1024;

		// Any plugin can log without depending on this one.
		(globalThis as any).__rlmLog = (
			level: LogLevel,
			scope: string,
			event: string,
			data?: Record<string, unknown>,
		) => this.write(level, scope, event, data);

		this.write("info", PLUGIN_ID, "logging.started", {
			file: this.file,
			level,
			pid: process.pid,
			node: process.version,
			cwd: process.cwd(),
			argv: process.argv.slice(1),
		});

		if (this.config.installAgentSink !== false) await this.adoptAgentLogging();
		this.watchProcess();
		this.watchBus();
		this.watchSessions();

		this.ctx.logger?.info?.(`rlm-log: recording to ${this.file}`);
	}

	/** Where the log is, and what has been written to it. */
	stats() {
		return { file: this.file, seq: this.seq, counts: { ...this.counts } };
	}

	write(level: LogLevel, scope: string, event: string, data?: Record<string, unknown>): void {
		try {
			if ((LEVELS[level] ?? 0) < this.minLevel) return;
			this.counts[level]++;
			const entry: RlmLogEntry = {
				ts: new Date().toISOString(),
				seq: ++this.seq,
				level,
				scope,
				event,
				...(data ? (safe(data) as Record<string, unknown>) : {}),
			};
			const line = JSON.stringify(entry);
			this.rotateIfNeeded();
			// One held descriptor, one `writeSync`. What this replaces was an
			// open/write/close plus an `existsSync`, a `statSync` and a
			// `mkdirSync` on **every log line** — six syscalls of ceremony
			// around one line of flight recorder.
			// 64 KB of scratch: this is the flight recorder, it writes on every
			// event, and it is the hottest append in the process.
			appendLine(this.file, line, HOT_APPEND_BYTES);
			if (this.config.console) console.error(`[rlm] ${level} ${scope} ${event}`);
		} catch {
			// A logger that throws is worse than a logger that misses a line.
		}
	}

	/**
	 * Rotate, and let go of the descriptor before doing it.
	 *
	 * Both halves matter. The size comes from the seam's own byte count rather
	 * than a `statSync`, so the common case — not rotating — costs nothing at
	 * all. And the `closeAppend` is not tidiness: a held fd follows the inode
	 * through a rename, so without it every line written after a rotation would
	 * land in `rlm.jsonl.old` while `rlm.jsonl` sat empty, and the next rotation
	 * would delete them.
	 */
	private rotateIfNeeded() {
		try {
			if (appendedSize(this.file) <= this.maxBytes) return;
			if (!existsSync(this.file) || statSync(this.file).size <= this.maxBytes) return;
			closeAppend(this.file);
			rmSync(`${this.file}.old`, { force: true });
			renameSync(this.file, `${this.file}.old`);
		} catch {
			// Keep appending rather than dropping the log on a rotation failure.
		}
	}

	/**
	 * Take over the agent's structured logging — into this file, not beside it.
	 *
	 * What stood here called `installFileLogSink()` from
	 * packages/coding-agent/src/core/logging.ts, which points pi-ai's
	 * process-wide sink at ~/.rlm/agent/logs/agent.jsonl. Under this host that
	 * produced the one outcome worse than no log at all: two structured logs,
	 * one live and one lying. `agent.jsonl` was last written on 2026-08-30, and
	 * 96% of everything it ever held came from `coding-agent.daemon` and
	 * `coding-agent.daemon-supervisor` — an architecture the Cordis shell does
	 * not run. Meanwhile this plugin announced `agent.sink.installed` on every
	 * boot, so a file nothing reads and almost nothing writes looked maintained.
	 * Nothing in the repo reads agent.jsonl; `scripts/rlm-logs.mjs` reads this
	 * file. So there is one log now, and it is this one.
	 *
	 * The sink is installed on **every** pi-ai module instance the repo can
	 * reach, and that is not belt-and-braces. `packages/ai` is loaded twice: as
	 * `src/index.ts` under tsx, which is how this host runs, and as
	 * `dist/index.js` through the `@earendil-works/pi-ai` specifier. The two
	 * hold separate module-level sinks — `src.setLogSink !== dist.setLogSink` —
	 * so installing on one and emitting through the other is precisely how a log
	 * ends up silently empty while its installer reports success.
	 *
	 * Relative paths rather than the package specifier because this package has
	 * no `node_modules` of its own to resolve `@earendil-works/pi-ai` through;
	 * the old code borrowed coding-agent's resolution for exactly that reason.
	 */
	private async adoptAgentLogging() {
		const state = ((globalThis as any).__rlmAgentSink ??= { installed: "", error: "" }) as {
			installed: string;
			error: string;
		};
		const sink = (entry: any) => {
			const { ts: _ts, level, component, msg, ...fields } = entry ?? {};
			this.write(
				typeof level === "string" && level in LEVELS ? (level as LogLevel) : "info",
				typeof component === "string" && component ? component : "agent",
				typeof msg === "string" ? msg : String(msg ?? ""),
				fields,
			);
		};

		const installed: string[] = [];
		const failures: string[] = [];
		for (const target of ["../../ai/src/index.ts", "../../ai/dist/index.js"]) {
			try {
				const mod: any = await import(target);
				if (typeof mod.setLogSink !== "function") throw new Error("no setLogSink export");
				mod.setLogSink(sink);
				installed.push(target);
			} catch (error: any) {
				failures.push(`${target}: ${error?.message ?? String(error)}`);
			}
		}

		// Say it once. A reload that lands on the same answer as last time is not
		// news, and this plugin used to spend 71% of the system's warn+error
		// budget re-announcing an unchanged verdict on every boot and reload.
		const summary = installed.join(",");
		if (installed.length && summary !== state.installed) {
			this.write("info", PLUGIN_ID, "agent.sink.installed", { targets: installed });
			state.installed = summary;
		} else if (installed.length) {
			this.write("debug", PLUGIN_ID, "agent.sink.reused", { targets: installed });
		}

		const error = failures.join(" | ");
		if (error && error !== state.error) {
			// Only a total failure is a warning: one instance is enough to record
			// through, and the other may simply not have been built.
			this.write(installed.length ? "debug" : "warn", PLUGIN_ID, "agent.sink.failed", { error });
			state.error = error;
		}
	}

	/** A crash must reach the file before the process goes. */
	private watchProcess() {
		this.ctx.effect(() => {
			const onUncaught = (error: any) =>
				this.write("error", "process", "uncaughtException", { error });
			const onRejection = (reason: any) =>
				this.write("error", "process", "unhandledRejection", { reason });
			const onExit = (code: number) => this.write("info", "process", "exit", { code, seq: this.seq });
			process.on("uncaughtException", onUncaught);
			process.on("unhandledRejection", onRejection);
			process.on("exit", onExit);
			return () => {
				process.off("uncaughtException", onUncaught);
				process.off("unhandledRejection", onRejection);
				process.off("exit", onExit);
			};
		});
	}

	/** The reload and resource events the rest of the harness emits. */
	private watchBus() {
		this.ctx.effect(() => {
			const ctx: any = this.ctx;
			const subs: Array<[string, (...a: any[]) => void]> = [
				["rlm/hmr-reload", (d: any) => this.write("info", "hmr", "plugin.reloaded", { reloaded: d?.reloaded })],
				["hmr/reload", (d: any) => this.write("info", "hmr", "official.reloaded", { count: d?.size ?? d?.length })],
				["hmr/change", (url: any) => this.write("debug", "hmr", "file.changed", { url })],
				["rlm/resources-changed", (d: any) => this.write("info", "resources", "changed", { reason: d?.reason, paths: d?.paths })],
				["rlm/prompt-changed", (d: any) => this.write("debug", "prompt", "invalidated", { path: d?.path })],
			];
			for (const [event, handler] of subs) {
				try { ctx.on(event, handler); } catch {}
			}
			return () => {
				for (const [event, handler] of subs) {
					try { ctx.off?.(event, handler); } catch {}
				}
			};
		});
	}

	/**
	 * Session events, through the shared extension-factory registry: what the
	 * agent ran, what failed, and how long a turn took.
	 */
	private watchSessions() {
		this.ctx.effect(() => {
			const g = globalThis as any;
			if (!Array.isArray(g.__rlmExtensionFactories)) g.__rlmExtensionFactories = [];
			const reg = g.__rlmExtensionFactories as Array<{ id: string; factory: (pi: any) => void }>;
			const stale = reg.findIndex((e) => e.id === PLUGIN_ID);
			if (stale >= 0) reg.splice(stale, 1);

			const entry = {
				id: PLUGIN_ID,
				factory: (pi: any) => {
					let turnStarted = 0;
					pi.on("session_start", (e: any) => this.write("info", "session", "start", { reason: e?.reason }));
					pi.on("session_shutdown", (e: any) => this.write("info", "session", "shutdown", { reason: e?.reason }));
					pi.on("agent_start", () => this.write("info", "agent", "run.start"));
					pi.on("agent_end", () => this.write("info", "agent", "run.end"));
					pi.on("turn_start", (e: any) => {
						turnStarted = Date.now();
						this.write("debug", "agent", "turn.start", { turn: e?.turnIndex });
					});
					pi.on("turn_end", (e: any) =>
						this.write("debug", "agent", "turn.end", {
							turn: e?.turnIndex,
							ms: turnStarted ? Date.now() - turnStarted : undefined,
						}),
					);
					pi.on("tool_call", (e: any) =>
						this.write("info", "tool", "call", {
							tool: e?.toolName,
							id: e?.toolCallId,
							code: shortCode(e?.input?.code),
						}),
					);
					pi.on("tool_result", (e: any) => {
						const failed = isFailure(e);
						this.write(failed ? "error" : "debug", "tool", failed ? "failed" : "ok", {
							tool: e?.toolName,
							id: e?.toolCallId,
							status: e?.details?.status,
							content: resultText(e),
						});
					});
				},
			};
			reg.push(entry);
			return () => {
				const i = reg.indexOf(entry);
				if (i >= 0) reg.splice(i, 1);
			};
		});
	}
}

/** Log from anywhere, whether or not this plugin is loaded. */
export function rlmLog(level: LogLevel, scope: string, event: string, data?: Record<string, unknown>): void {
	try {
		(globalThis as any).__rlmLog?.(level, scope, event, data);
	} catch {}
}

export default RlmLogService;
export const name = "rlm-log";
export const inject = [] as const;
export { RlmLogService as RlmLog };
