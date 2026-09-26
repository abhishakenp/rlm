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
import { execFileSyncHidden, isProcessAlive } from "../utils/child-process.js";

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
				if (typeof owner === "object" && owner.token === this.token) {
					reclaimStaleLease(this.directory);
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

// An unreadable owner may hold a live lease. Only a missing owner is safely absent.
function readLeaseOwner(directory: string): SessionLeaseOwner | "absent" | "unreadable" {
	const ownerPath = join(directory, "owner.json");
	let raw: string;
	try {
		raw = readFileSync(ownerPath, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
	}
	try {
		const parsed = JSON.parse(raw) as Partial<SessionLeaseOwner>;
		if (
			parsed.version !== 1 ||
			typeof parsed.token !== "string" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.sessionPath !== "string" ||
			typeof parsed.createdAt !== "string"
		) {
			throw new TypeError(`Corrupt session lease owner file: ${ownerPath} (missing or invalid required fields)`);
		}
		return parsed as SessionLeaseOwner;
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof TypeError) {
			throw new Error(`Corrupt session lease owner file: ${ownerPath} - ${error.message}`);
		}
		throw error;
	}
}

interface ProcessQueryOptions {
	env?: NodeJS.ProcessEnv;
}

type ProcessQuery = (command: string, args: string[], options?: ProcessQueryOptions) => string;

function runProcessQuery(command: string, args: string[], options?: ProcessQueryOptions): string {
	return execFileSyncHidden(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: options?.env,
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

export function getPsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		// `lstart` is rendered in the subprocess timezone and locale, so pin both for a durable identity.
		const startTime = query("ps", ["-p", String(pid), "-o", "lstart="], {
			env: { ...process.env, LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" },
		}).trim();
		return startTime ? `ps:${startTime}` : undefined;
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
	return getPsProcessStartId(pid);
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
	let guardCompromised = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			release = lockSync(directory, {
				realpath: false,
				lockfilePath: `${directory}.guard`,
				stale: 5000,
				onCompromised: () => {
					guardCompromised = true;
				},
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
	const assertGuardHeld = () => {
		if (guardCompromised) throw new Error(`Session lease guard was compromised: ${directory}`);
	};
	try {
		assertGuardHeld();
		const result = action();
		assertGuardHeld();
		return result;
	} finally {
		if (guardCompromised) {
			try {
				release();
			} catch {
				// The compromised guard no longer owns a lock that can be safely released.
			}
		} else {
			release();
		}
	}
}

export function isRenameTargetContention(
	directory: string,
	code: string | undefined,
	platform: string = process.platform,
): boolean {
	// POSIX: renameSync into an existing directory raises EEXIST or ENOTEMPTY.
	if (code === "EEXIST" || code === "ENOTEMPTY") {
		return true;
	}
	// Windows: renameSync into an existing directory raises EPERM or EACCES
	// instead of EEXIST.  Only treat them as contention when the target
	// actually exists so real permission errors still propagate.
	if ((code === "EPERM" || code === "EACCES") && platform === "win32") {
		try {
			return existsSync(directory);
		} catch {
			return false;
		}
	}
	return false;
}

function reclaimStaleLease(directory: string): boolean {
	const stalePath = `${directory}.stale-${process.pid}-${randomUUID()}`;
	const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(directory, stalePath);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return true;
			const transient = process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
			if (!transient || attempt >= 8) return false;
			Atomics.wait(sleepBuffer, 0, 0, 10 * attempt);
		}
	}
	try {
		rmSync(stalePath, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
	} catch {
		// The quarantined directory no longer owns the lease path.
	}
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
				// rlm: upstream's reader also reports absent/unreadable owners; the reaper treats both as no owner.
				const read = readLeaseOwner(directory);
				const owner = typeof read === "string" ? undefined : read;
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
				const err = error as NodeJS.ErrnoException;
				rmSync(candidateDirectory, { recursive: true, force: true });
				if (err.code === "ENOENT") {
					// Candidate vanished - treat as retryable race.
					continue;
				}
				if (isRenameTargetContention(directory, err.code)) {
					const existingOwner = readLeaseOwner(directory);
					if (existingOwner === "unreadable") {
						continue;
					}
					if (existingOwner !== "absent" && isLeaseOwnerAlive(existingOwner)) {
						throw new SessionAlreadyActiveError(canonicalPath, existingOwner.activeSessionId);
					}
					reclaimStaleLease(directory);
					continue;
				}
				throw error;
			}
		}

		const owner = existsSync(directory) ? readLeaseOwner(directory) : undefined;
		if (typeof owner === "object" && isLeaseOwnerAlive(owner)) {
			throw new SessionAlreadyActiveError(canonicalPath, owner.activeSessionId);
		}
		throw new Error(`Could not acquire session lease: ${canonicalPath}`);
	});
}
