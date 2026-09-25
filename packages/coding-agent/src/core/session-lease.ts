import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";

export const SESSION_LEASES_ENABLED_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASES";
export const SESSION_LEASE_OWNER_ID_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID";

interface SessionLeaseOwner {
	version: 1;
	token: string;
	pid: number;
	processStartId?: string;
	activeSessionId?: string;
	sessionPath: string;
	createdAt: string;
}

/** Why a lease directory no longer belongs to anybody. */
export type DeadLeaseReason = "owner-unreadable" | "process-gone" | "process-replaced";

/** One lease the reaper removed, or would remove under `dryRun`. */
export interface ReapedSessionLease {
	directory: string;
	reason: DeadLeaseReason;
	pid?: number;
	sessionPath?: string;
	activeSessionId?: string;
	createdAt?: string;
}

export interface ReapSessionLeasesOptions {
	/** Report what would go without removing anything. */
	dryRun?: boolean;
	/** A lease directory the caller is itself about to take, and must not sweep. */
	except?: string;
}

export class SessionAlreadyActiveError extends Error {
	readonly code = "session_already_active" as const;

	constructor(
		readonly sessionPath: string,
		readonly activeSessionId?: string,
	) {
		super(
			activeSessionId
				? `Session is already active in ${activeSessionId}: ${sessionPath}`
				: `Session is already active in another process: ${sessionPath}`,
		);
		this.name = "SessionAlreadyActiveError";
	}
}

export class SessionLease {
	private released = false;

	constructor(
		readonly sessionPath: string,
		private readonly directory: string,
		private readonly token: string,
	) {}

	release(): void {
		if (this.released) {
			return;
		}
		this.released = true;
		try {
			withLeaseGuard(this.directory, () => {
				const owner = readLeaseOwner(this.directory);
				if (owner?.token === this.token) {
					rmSync(this.directory, { recursive: true, force: true });
				}
			});
		} catch {
			// Lease cleanup is best-effort. A stale owner is reclaimed by the next process.
		}
	}
}

function leasesEnabled(environment: NodeJS.ProcessEnv): boolean {
	const value = environment[SESSION_LEASES_ENABLED_ENV]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function leaseDirectory(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(sessionPath).digest("hex");
	return join(agentDir, "session-leases", `${key}.lock`);
}

export function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	try {
		return realpathSync(resolvedPath);
	} catch {
		try {
			return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

function readLeaseOwner(directory: string): SessionLeaseOwner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as Partial<SessionLeaseOwner>;
		if (
			parsed.version !== 1 ||
			typeof parsed.token !== "string" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.sessionPath !== "string" ||
			typeof parsed.createdAt !== "string"
		) {
			return undefined;
		}
		return parsed as SessionLeaseOwner;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

type ProcessQuery = (command: string, args: string[]) => string;

function runProcessQuery(command: string, args: string[]): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

export function getWindowsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		const startTicks = query("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
		]).trim();
		return /^\d+$/.test(startTicks) ? `win:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}

export function getProcessStartId(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	if (process.platform === "win32") {
		return getWindowsProcessStartId(pid);
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields = stat.slice(commandEnd + 2).split(" ");
		const startTime = fields[19];
		if (startTime) {
			return `proc:${startTime}`;
		}
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	try {
		const startTime = runProcessQuery("ps", ["-p", String(pid), "-o", "lstart="]).trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

let currentProcessStartId: string | undefined;
let currentProcessStartIdRead = false;

function getCurrentProcessStartId(): string | undefined {
	if (!currentProcessStartIdRead) {
		currentProcessStartId = getProcessStartId(process.pid);
		currentProcessStartIdRead = true;
	}
	return currentProcessStartId;
}

/**
 * Why a lease is dead, or `undefined` while it still belongs to someone.
 *
 * One classifier, two callers with different questions. `acquireSessionLease`
 * only ever needs yes-or-no; the reaper has to be able to say *why* it removed
 * a directory, because a sweep that cannot explain itself is a sweep nobody
 * will trust with a forensic record. Sharing the decision is also what
 * guarantees the reaper can never be more aggressive than the acquire path: a
 * lease the sweep deletes is precisely a lease the next acquire would have
 * reclaimed anyway.
 *
 * The two dead cases are the two ways an owner disappears. A pid that no
 * longer answers `kill(pid, 0)` is gone. A pid that answers but whose start
 * identity no longer matches the one recorded in `owner.json` is a *different*
 * process wearing a recycled pid — the case that would otherwise hold a
 * session hostage for ever behind a pid check that looks perfectly healthy.
 * An owner whose start identity cannot be read at all is left alone: not
 * knowing is not the same as knowing it is dead.
 */
function classifyDeadLease(owner: SessionLeaseOwner | undefined): DeadLeaseReason | undefined {
	if (!owner) {
		return "owner-unreadable";
	}
	if (!isProcessAlive(owner.pid)) {
		return "process-gone";
	}
	if (!owner.processStartId) {
		return undefined;
	}
	const currentStartId = getProcessStartId(owner.pid);
	if (currentStartId === undefined) {
		return undefined;
	}
	return currentStartId === owner.processStartId ? undefined : "process-replaced";
}

function isLeaseOwnerAlive(owner: SessionLeaseOwner): boolean {
	return classifyDeadLease(owner) === undefined;
}

function withLeaseGuard<T>(directory: string, action: () => T): T {
	let release: (() => void) | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			release = lockSync(directory, {
				realpath: false,
				lockfilePath: `${directory}.guard`,
				stale: 5000,
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
				throw error;
			}
			if (attempt === 99) {
				throw new Error(`Could not coordinate session lease: ${directory}`);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!release) {
		throw new Error(`Could not coordinate session lease: ${directory}`);
	}
	try {
		return action();
	} finally {
		release();
	}
}

function reclaimStaleLease(directory: string): boolean {
	const stalePath = `${directory}.stale-${process.pid}-${randomUUID()}`;
	try {
		renameSync(directory, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return true;
		}
		return false;
	}
	rmSync(stalePath, { recursive: true, force: true });
	return true;
}

/**
 * Remove every lease in `agentDir` whose owner is gone.
 *
 * Until this existed nothing ever swept the directory. `acquireSessionLease`
 * reclaims a stale lease, but only the one lease it is trying to take — so a
 * lease for a session that is never opened again is immortal, and a rename of
 * the agent directory orphans the whole set at once. That is how one machine
 * arrived at 172 `.lock` directories, every pid long dead, every recorded
 * `sessionPath` still pointing at a directory that had been renamed away.
 *
 * Each candidate is examined under its own guard, which is what makes the
 * sweep safe to run while sessions are starting: the guard is the same lock
 * `acquireSessionLease` holds across its candidate/rename dance, so a lease
 * being created right now is either not yet visible or is read complete. A
 * guard we cannot take belongs to somebody actively working on that lease, and
 * the lease is left for them.
 */
export function reapStaleSessionLeases(
	agentDir: string,
	options: ReapSessionLeasesOptions = {},
): ReapedSessionLease[] {
	const root = join(agentDir, "session-leases");
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}

	const reaped: ReapedSessionLease[] = [];
	for (const entry of entries) {
		// `.lock` is the settled name. The transient `.candidate-*`, `.stale-*`
		// and `.guard` siblings belong to a live acquire and are not ours to judge.
		if (!entry.endsWith(".lock")) {
			continue;
		}
		const directory = join(root, entry);
		if (options.except && directory === options.except) {
			continue;
		}
		try {
			withLeaseGuard(directory, () => {
				if (!existsSync(directory)) {
					return;
				}
				const owner = readLeaseOwner(directory);
				const reason = classifyDeadLease(owner);
				if (!reason) {
					return;
				}
				if (!options.dryRun && !reclaimStaleLease(directory)) {
					return;
				}
				reaped.push({
					directory,
					reason,
					pid: owner?.pid,
					sessionPath: owner?.sessionPath,
					activeSessionId: owner?.activeSessionId,
					createdAt: owner?.createdAt,
				});
			});
		} catch {
			// Contended or unreadable: whoever holds the guard owns the decision.
		}
	}
	return reaped;
}

const sweptLeaseRoots = new Set<string>();

/**
 * Sweep a lease root once per process, on the way in.
 *
 * Reaping belongs on the acquire path rather than in a cron job because the
 * acquire path is the only code that is guaranteed to run whenever leases are
 * in use at all, and it already knows the directory layout. Once per process
 * per root keeps it off the hot path — a resident host pays for it at its
 * first session and never again — and every failure is swallowed, because a
 * process must still be able to take its own lease on a day the sweep cannot.
 */
function sweepLeaseRootOnce(agentDir: string, except: string): void {
	const root = join(agentDir, "session-leases");
	if (sweptLeaseRoots.has(root)) {
		return;
	}
	sweptLeaseRoots.add(root);
	try {
		reapStaleSessionLeases(agentDir, { except });
	} catch {
		// Housekeeping must never stand between a process and its own session.
	}
}

export function acquireSessionLease(
	sessionPath: string | undefined,
	agentDir: string,
	environment: NodeJS.ProcessEnv = process.env,
): SessionLease | undefined {
	if (!sessionPath || !leasesEnabled(environment)) {
		return undefined;
	}
	const canonicalPath = canonicalSessionPath(sessionPath);
	const root = join(agentDir, "session-leases");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const directory = leaseDirectory(agentDir, canonicalPath);
	sweepLeaseRootOnce(agentDir, directory);

	return withLeaseGuard(directory, () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const token = randomUUID();
			const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
			const owner: SessionLeaseOwner = {
				version: 1,
				token,
				pid: process.pid,
				processStartId: getCurrentProcessStartId(),
				activeSessionId: environment[SESSION_LEASE_OWNER_ID_ENV],
				sessionPath: canonicalPath,
				createdAt: new Date().toISOString(),
			};
			mkdirSync(candidateDirectory, { mode: 0o700 });
			writeFileSync(join(candidateDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
				mode: 0o600,
			});
			try {
				renameSync(candidateDirectory, directory);
				return new SessionLease(canonicalPath, directory, token);
			} catch (error) {
				rmSync(candidateDirectory, { recursive: true, force: true });
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "ENOTEMPTY") {
					throw error;
				}
				const existingOwner = readLeaseOwner(directory);
				if (existingOwner && isLeaseOwnerAlive(existingOwner)) {
					throw new SessionAlreadyActiveError(canonicalPath, existingOwner.activeSessionId);
				}
				reclaimStaleLease(directory);
			}
		}

		const owner = existsSync(directory) ? readLeaseOwner(directory) : undefined;
		if (owner && isLeaseOwnerAlive(owner)) {
			throw new SessionAlreadyActiveError(canonicalPath, owner.activeSessionId);
		}
		throw new Error(`Could not acquire session lease: ${canonicalPath}`);
	});
}
