/**
 * One owner per machine for the Always integration.
 *
 * Every rlm process mounts the composition, so every one of them — interactive
 * chats, the daemon supervisor, pool workers, delegate children, `--print`
 * runs — would otherwise open its own daemon connection and its own focus
 * helper and fight over the daemon's consume mode. Measured when this row was
 * first enabled: 7 UDS clients, each flipping `SetConsumeMode` on its own focus
 * tick. Consume mode is one bit on the daemon; only one process may drive it.
 *
 * The lease is a directory (`mkdir` is atomic) holding `owner.json`
 * `{pid, start, token}`. A holder whose pid is gone — or whose pid now belongs
 * to a different process (start time differs) — is stale and may be replaced.
 * Two processes can both see the same stale holder and both replace it; each
 * re-reads the file after a short settle and the one whose token is not there
 * stands down, so at most one keeps driving the daemon.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OwnerRecord {
	pid: number;
	start: string;
	token: string;
}

/** Who may drive Always: long-lived, user-facing processes only. */
export const eligibleToOwn = (env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean => {
	if (env.RLM_ALWAYS_OWNER === "0") return false;
	if (env.RLM_HEADLESS) return false; // --print, pool workers, drive, piped stdin
	if (env.RLM_DELEGATE_CHILD) return false;
	if (env.PRIME_AGENT_INTERNAL_DAEMON_WORKER) return false; // a resident worker, not the supervisor
	if (argv.includes("--pool-worker")) return false;
	return true;
};

export const defaultLeaseDir = (): string =>
	join(process.env.RLM_HOME ?? join(homedir(), ".rlm"), "agent", "always-owner");

/** The process's start time as `ps` reports it; distinguishes a recycled pid. */
export const processStart = (pid: number): string | null => {
	try {
		const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
		const out = r.status === 0 ? r.stdout.trim() : "";
		return out || null;
	} catch {
		return null;
	}
};

const alive = (rec: OwnerRecord): boolean => {
	try {
		process.kill(rec.pid, 0);
	} catch (e: any) {
		if (e?.code !== "EPERM") return false;
	}
	const start = processStart(rec.pid);
	return start !== null && start === rec.start;
};

export class OwnerLease {
	readonly dir: string;
	readonly me: OwnerRecord;
	constructor(dir = defaultLeaseDir(), pid = process.pid) {
		this.dir = dir;
		this.me = { pid, start: processStart(pid) ?? "", token: `${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}` };
	}

	private get file(): string {
		return join(this.dir, "owner.json");
	}

	read(): OwnerRecord | null {
		try {
			return JSON.parse(readFileSync(this.file, "utf8")) as OwnerRecord;
		} catch {
			return null;
		}
	}

	private write(): void {
		const tmp = `${this.file}.${this.me.token}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.me));
		renameSync(tmp, this.file);
	}

	/** True when the lease file names this process right now. */
	holds(): boolean {
		return this.read()?.token === this.me.token;
	}

	/**
	 * Try to become the owner. Returns true only if, after a settle, the lease
	 * still names this process. Safe to call repeatedly.
	 */
	async tryAcquire(settleMs = 150): Promise<boolean> {
		if (this.holds()) return true;
		try {
			mkdirSync(dirname(this.dir), { recursive: true });
			mkdirSync(this.dir);
		} catch (e: any) {
			if (e?.code !== "EEXIST") return false;
			const cur = this.read();
			if (cur && alive(cur)) return false;
			// Stale (or half-written): replace the whole directory and retry the atomic mkdir.
			rmSync(this.dir, { recursive: true, force: true });
			try {
				mkdirSync(this.dir);
			} catch {
				return false;
			}
		}
		this.write();
		await new Promise((r) => setTimeout(r, settleMs));
		return this.holds();
	}

	/** Give the lease up if it is ours. */
	release(): void {
		if (!this.holds()) return;
		rmSync(this.dir, { recursive: true, force: true });
	}
}
