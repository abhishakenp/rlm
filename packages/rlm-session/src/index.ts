/**
 * @rlm/session — session management service.
 *
 * Wraps prime-agent's SessionManager as a Cordis Service.
 * Manages on-disk session files under ~/.prime/agent/sessions.
 */
import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RlmSessionConfig {
	/** Working directory. */
	cwd?: string;
	/** Session directory (default: ~/.prime/agent/sessions). */
	sessionDir?: string;
}

export class RlmSessionService extends Service {
	static inject = [];

	declare config: RlmSessionConfig;
	private manager: any = null;

	constructor(ctx: any, config: RlmSessionConfig = {}) {
		super(ctx, config);
		this.config = config;
	}

	get [Symbol.name]() {
		return "rlmSession";
	}

	async [Service.init]() {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const cwd = this.config.cwd ?? process.cwd();
		const sessionDir = this.config.sessionDir ?? join(homedir(), ".prime", "agent", "sessions");
		this.manager = SessionManager.create(cwd, sessionDir);
		this.ctx.logger?.info("rlm-session: SessionManager ready");
	}

	/** Get the underlying SessionManager. */
	get manager_() {
		return this.manager;
	}

	/** Create a new session. */
	newSession(opts?: any) {
		return this.manager?.newSession(opts);
	}

	/** Continue the previous session. */
	continueSession() {
		return this.manager?.continueSession();
	}

	/** Resume a session by path or id. */
	resumeSession(pathOrId: string) {
		return this.manager?.resumeSession(pathOrId);
	}

	async [Symbol.dispose]() {
		// SessionManager is stateless beyond file paths — nothing to dispose.
		this.manager = null;
	}
}

export default RlmSessionService;
export const name = "rlm-session";
export const inject = [] as const;
export { RlmSessionService as RlmSession };
