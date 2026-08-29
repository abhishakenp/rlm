/**
 * @rlm/session — JSONL session persistence.
 *
 * Clean Cordis Service. No prime-agent code.
 * Stores conversation sessions as JSONL files on disk.
 *
 * Reference: DSH's dsh-session-persistence-jsonl stores sessions as JSONL.
 * rlm-session does the same — one JSONL file per session.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "node:fs";

export interface RlmSessionConfig {
	sessionDir?: string;
}

export interface SessionEntry {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	timestamp: number;
	toolCalls?: any[];
	toolCallId?: string;
}

export class RlmSessionService extends Service {
	static inject = [] as const;
	static provide = "rlmSession" as const;

	declare config: RlmSessionConfig;
	private sessionDir: string;
	private currentSession: string | null = null;

	constructor(ctx: any, config: RlmSessionConfig = {}) {
		super(ctx, "rlmSession");
		this.config = config;
		this.sessionDir = config.sessionDir ?? join(homedir(), ".rlm", "sessions");
	}

	async [Service.init]() {
		if (!existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}
		this.ctx.logger?.info("rlm-session: session persistence ready");
	}

	/** Start a new session. Returns the session ID. */
	newSession(): string {
		const id = `session-${Date.now()}`;
		const path = join(this.sessionDir, `${id}.jsonl`);
		appendFileSync(path, ""); // Create empty file.
		this.currentSession = id;
		return id;
	}

	/** Append an entry to the current session. */
	append(entry: SessionEntry): void {
		if (!this.currentSession) {
			this.newSession();
		}
		const path = join(this.sessionDir, `${this.currentSession}.jsonl`);
		appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
	}

	/** Load a session by ID. */
	load(sessionId: string): SessionEntry[] {
		const path = join(this.sessionDir, `${sessionId}.jsonl`);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	/** List all sessions. */
	list(): string[] {
		if (!existsSync(this.sessionDir)) return [];
		return readdirSync(this.sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => f.replace(/\.jsonl$/, ""));
	}

	/** Get the current session ID. */
	get current() {
		return this.currentSession;
	}

	async [Symbol.dispose]() {
		// All writes are immediate.
	}
}

export default RlmSessionService;
export const name = "rlm-session";
export const inject = [] as const;
export { RlmSessionService as RlmSession };
